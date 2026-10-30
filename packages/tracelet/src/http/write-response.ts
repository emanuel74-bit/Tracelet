import type { ServerResponse } from 'node:http';
import type { TraceletHttpResponse } from '../contracts/tracelet-internal-contracts';

/** Writes a TraceletHttpResponse to a node ServerResponse (Express response or node:http). Never throws. */
export function writeNodeResponse(res: ServerResponse, r: TraceletHttpResponse): void {
  try {
    if (res.headersSent || res.writableEnded) return;
    res.statusCode = r.status;
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.end(r.body);
  } catch {
    try {
      res.destroy();
    } catch {
      // nothing left to do
    }
  }
}

export const INTERNAL_ERROR_RESPONSE: TraceletHttpResponse = {
  status: 500,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  body: '{"error":{"code":"INTERNAL","message":"Internal error"}}',
};
