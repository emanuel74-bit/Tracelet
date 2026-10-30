import { normalizeBasePath } from './base-path';
import { stripCorsHeaders } from './write-response';
import { methodNotAllowedResponse } from './dispatcher';
import type { Dispatcher } from './dispatcher';

/** The part of a Fastify 5 instance used here (Nest: `app.getHttpAdapter().getInstance()`). */
export interface FastifyLike {
  route(opts: { method: string[]; url: string; onRequest: (request: any, reply: any) => any; handler: (request: any, reply: any) => any }): unknown;
}

const ALL_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS'];

function send(reply: any, r: { status: number; headers: Record<string, string>; body: string | Buffer }): any {
  stripCorsHeaders(reply);
  if (reply.raw) stripCorsHeaders(reply.raw); // headers set on the raw response are not visible to reply.removeHeader
  // CORS headers added by host hooks (@fastify/cors) must not leak onto dashboard/API responses
  reply.code(r.status);
  reply.headers(r.headers);
  return reply.send(r.body);
}

/**
 * Registers `basePath` and `basePath/*` for ALL methods. A route-level `onRequest` hook answers Tracelet's 405 envelope
 * for anything but GET/HEAD BEFORE Fastify parses the body (L10), so Fastify and Express return the same response.
 * Caveat: if the host enables CORS (Nest `enableCors` / @fastify/cors), a preflight OPTIONS may be answered by the CORS
 * layer before this route on either adapter. The peer address is `request.raw.socket.remoteAddress`, never `request.ip`
 * (which follows `trustProxy`).
 */
export function mountFastify(instance: FastifyLike, basePath: string, dispatch: Dispatcher): void {
  const base = normalizeBasePath(basePath);
  // async on purpose: a synchronous Fastify hook that returns nothing would wait for a `done` callback forever.
  const onRequest = async (request: any, reply: any): Promise<any> => {
    const m = String(request.raw?.method ?? request.method).toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') {
      send(reply, methodNotAllowedResponse());
      return reply;
    }
    return undefined;
  };
  const handler = async (request: any, reply: any): Promise<any> => {
    const r = await dispatch({
      method: request.raw?.method ?? request.method,
      url: request.raw?.url ?? request.url,
      headers: request.headers,
      remoteAddress: request.raw?.socket?.remoteAddress,
      raw: request,
      adapter: 'fastify',
    });
    return send(reply, r);
  };
  instance.route({ method: ALL_METHODS, url: base, onRequest, handler });
  instance.route({ method: ALL_METHODS, url: `${base}/*`, onRequest, handler });
}
