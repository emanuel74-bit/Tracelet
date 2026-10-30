import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeBasePath } from './base-path';
import type { Dispatcher } from './dispatcher';
import { INTERNAL_ERROR_RESPONSE, writeNodeResponse } from './write-response';

/** The part of an Express 5 application used here (Nest: `app.getHttpAdapter().getInstance()`). */
export interface ExpressLike {
  use(path: string, handler: (req: any, res: ServerResponse, next: (err?: unknown) => void) => void): unknown;
}

/**
 * Prefix mount: `app.use(basePath, handler)` (Express 5; no wildcard path syntax). Matches `basePath` and `basePath/...`
 * and is handled before Nest's router when registered before `app.init()`. The dispatcher receives `req.originalUrl`
 * (so '/observe' and '/observe/' stay distinguishable and a nested router cannot rewrite it) and the SOCKET peer
 * address, never `req.ip`, which follows `trust proxy`.
 */
export function mountExpress(app: ExpressLike, basePath: string, dispatch: Dispatcher): void {
  const base = normalizeBasePath(basePath);
  app.use(base, (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse) => {
    void dispatch({
      method: req.method ?? 'GET',
      url: req.originalUrl ?? req.url ?? '/',
      headers: req.headers,
      remoteAddress: req.socket?.remoteAddress,
      raw: req,
      adapter: 'express',
    }).then(
      r => writeNodeResponse(res, r),
      () => writeNodeResponse(res, INTERNAL_ERROR_RESPONSE),
    );
  });
}
