import type { TraceletAuthRequest } from '../contracts/observe-contracts';
import type { ApiHandler, TraceletHttpResponse } from '../contracts/tracelet-internal-contracts';
import { runOutsideTrace } from '../shared/als';
import { createDiagnostics } from '../shared/diagnostics';
import type { Diagnostics } from '../shared/diagnostics';
import { uuidv7 } from '../shared/uuid-v7';
import type { AuthGate } from './auth';
import { normalizeBasePath } from './base-path';
import { apiHeaders } from './security-headers';
import type { StaticAssets } from './static-assets';

/*
 * ============================================================================================================
 * HTTP LAYER CONTRACT FOR SLICE B (TraceletModule / Tracelet.setup / Tracelet.listen)
 * ============================================================================================================
 * Build, once per mount (all synchronous, none of it throws except normalizeBasePath on a bad path):
 *
 *   const basePath = normalizeBasePath(opts.path ?? '/observe');                    // mount path ('/observe')
 *   const publicBasePath = normalizeBasePath(opts.publicBasePath ?? basePath);      // what browsers see
 *   const auth = createAuthGate({ authorize: opts.authorize, allowLoopbackWithoutAuth: opts.allowLoopbackWithoutAuth });
 *   const assets = createStaticAssets(publicBasePath);                              // validates bytes; never throws on bad assets
 *   const api = createQueryApiHandler(queryService, { authorize: () => true });     // the dispatcher gate has ALREADY decided
 *   const dispatch = createDispatcher({ basePath, publicBasePath, auth, api, assets });
 *   mountExpress(expressApp, basePath, dispatch)  |  mountFastify(fastifyInstance, basePath, dispatch)
 *   |  startStandaloneServer({ basePath, publicBasePath, dispatch, host, port })
 *
 * Rules the caller must follow:
 *  - The API handler is built with `authorize: () => true` ONLY because every request has passed `auth` first; never
 *    expose the ApiHandler on any other route. If the storage is not configured/connected the module may pass a
 *    stub ApiHandler that answers 503 STORAGE_UNAVAILABLE; assets and auth still work.
 *  - `Tracelet.setup` must reject apps that are already initialised and adapters other than express/fastify.
 *  - The dispatcher never throws and always runs inside runOutsideTrace(); do not wrap it in a trace.
 *  - `remoteAddress` handed to the dispatcher is the SOCKET peer (the mounts do this); do not build DispatchRequests
 *    from req.ip / request.ip.
 *  - Order of work per request: in-flight cap -> method (405) -> auth (403) -> routing. Nothing touches storage before auth.
 * ============================================================================================================
 */

export interface DispatchRequest {
  method: string;
  /** Raw request target (path plus optional '?query') from the ORIGINAL url, i.e. including the mount path. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Socket peer address only. */
  remoteAddress: string | undefined;
  /** Underlying Express/Fastify request (handed to authorize()). */
  raw: unknown;
  adapter: TraceletAuthRequest['adapter'];
}

export type Dispatcher = (req: DispatchRequest) => Promise<TraceletHttpResponse>;

export interface DispatcherOptions {
  /** Internal mount path, e.g. '/observe' (normalised by the caller with normalizeBasePath). */
  basePath: string;
  /** Externally visible path used in redirects. Default basePath. */
  publicBasePath?: string;
  auth: AuthGate;
  api: ApiHandler;
  assets: StaticAssets;
  /** Concurrent requests handled by the dispatcher; more are answered 429. Default 128. */
  maxInFlight?: number;
  /** Longest accepted query string. Default 8192. */
  maxQueryLength?: number;
  diagnostics?: Diagnostics;
}

const envelope = (status: number, code: string, message: string, extra: Record<string, string> = {}): TraceletHttpResponse => ({
  status,
  headers: { ...apiHeaders(), 'Content-Type': 'application/json; charset=utf-8', ...extra },
  body: JSON.stringify({ error: { code, message } }),
});

/** The one 405 envelope; used by the dispatcher and by the Fastify route-level onRequest hook so both adapters answer identically. */
export function methodNotAllowedResponse(): TraceletHttpResponse {
  return envelope(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', { Allow: 'GET, HEAD' });
}

const forbidden = (): TraceletHttpResponse => envelope(403, 'FORBIDDEN', 'Observe access is not authorized');

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const basePath = normalizeBasePath(options.basePath);
  const publicBase = normalizeBasePath(options.publicBasePath ?? basePath);
  const { auth, api, assets } = options;
  const maxInFlight = options.maxInFlight ?? 128;
  const maxQueryLength = options.maxQueryLength ?? 8192;
  const diagnostics = options.diagnostics ?? createDiagnostics('TraceletHttp');
  let inFlight = 0;

  const redirectToBase = (search: string): TraceletHttpResponse => ({
    status: 307,
    headers: { ...apiHeaders(), Location: `${publicBase}/${search}`, 'Content-Length': '0' },
    body: '',
  });

  const route = async (req: DispatchRequest, method: string, pathname: string, search: string, rel: string): Promise<TraceletHttpResponse> => {
    // 3. API
    if (rel === '/api/v1' || rel.startsWith('/api/v1/')) {
      if (search.length > maxQueryLength + 1) return envelope(400, 'INVALID_QUERY', 'Query string is too long');
      const query: Record<string, string | undefined> = {};
      let count = 0;
      for (const [k, v] of new URLSearchParams(search)) {
        if (++count > 100) return envelope(400, 'INVALID_QUERY', 'Too many query parameters');
        if (!(k in query) && k !== '__proto__') query[k] = v;
      }
      return api({ method, path: rel, query, headers: req.headers });
    }
    if (!assets.available) return envelope(503, 'INTERNAL', 'Dashboard assets are unavailable');
    // 4. Entry, canonical mount, files
    if (pathname === basePath) return redirectToBase(search);
    if (/%2f|%5c/i.test(rel)) return envelope(404, 'NOT_FOUND', 'Not found');
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return envelope(400, 'INVALID_QUERY', 'Invalid path');
    }
    if (decoded.includes('\\') || decoded.includes('\0')) return envelope(404, 'NOT_FOUND', 'Not found');
    const served = assets.serve(decoded, method, req.headers['if-none-match']);
    if (served) return served;
    // Unknown file-like path: 404 (never index.html). Navigation path: the SPA lives at the base only, because the
    // bundle uses relative asset URLs, so serving the HTML under /a/b would break them. Redirect to the base instead.
    const last = decoded.slice(decoded.lastIndexOf('/') + 1);
    if (decoded.startsWith('/assets/') || last.includes('.')) return envelope(404, 'NOT_FOUND', 'Not found');
    return redirectToBase(search);
  };

  const handle = async (req: DispatchRequest): Promise<TraceletHttpResponse> => {
    const method = String(req.method).toUpperCase();
    const target = typeof req.url === 'string' ? req.url : '';
    const q = target.indexOf('?');
    const pathname = q < 0 ? target : target.slice(0, q);
    const search = q < 0 ? '' : target.slice(q);
    const under = pathname === basePath || pathname.startsWith(basePath + '/');
    const rel = under ? pathname.slice(basePath.length) || '/' : '/';

    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowedResponse();
    const allowed = await auth({ method, path: rel, headers: req.headers, remoteAddress: req.remoteAddress, raw: req.raw, adapter: req.adapter });
    if (!allowed) return forbidden();
    if (!under || !target.startsWith('/')) return envelope(404, 'NOT_FOUND', 'Not found');
    return route(req, method, pathname, search, rel);
  };

  const finish = (method: string, res: TraceletHttpResponse, requestId: string): TraceletHttpResponse => {
    const headers: Record<string, string> = { ...apiHeaders(), ...res.headers, 'X-Tracelet-Request-Id': requestId };
    const isHead = method === 'HEAD';
    if (headers['Content-Length'] === undefined && res.status !== 304 && !isHead) headers['Content-Length'] = String(Buffer.byteLength(res.body));
    return { status: res.status, headers, body: isHead || res.status === 304 || res.status === 204 ? '' : res.body };
  };

  return req =>
    runOutsideTrace(async () => {
      const method = String(req?.method ?? 'GET').toUpperCase();
      const requestId = uuidv7();
      if (inFlight >= maxInFlight) return finish(method, envelope(429, 'RATE_LIMITED', 'Too many requests', { 'Retry-After': '1' }), requestId);
      inFlight++;
      try {
        return finish(method, await handle(req), requestId);
      } catch {
        // Constant text: never the exception (it may contain request data).
        diagnostics.error('dispatch', 'Unexpected failure while handling an observe request.');
        return finish(method, envelope(500, 'INTERNAL', 'Internal error'), requestId);
      } finally {
        inFlight--;
      }
    });
}
