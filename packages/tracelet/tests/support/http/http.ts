import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { ApiHandler, TraceletHttpRequest } from '../../../src/contracts/tracelet-internal-contracts.js';

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

export interface RequestOptions {
  port: number;
  /** Where to connect. The peer address the server sees is the source address of the connection (loopback for 127.0.0.1/::1, the interface address for a LAN IP). */
  host?: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Plain node:http request with no keep-alive agent. */
export function httpRequest(o: RequestOptions): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: o.host ?? '127.0.0.1', port: o.port, method: o.method ?? 'GET', path: o.path, headers: o.headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** First non-internal IPv4 address of this machine, or undefined. Connecting to it yields a NON-loopback socket peer. */
export function nonLoopbackAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

export interface StubApi {
  handler: ApiHandler;
  calls: TraceletHttpRequest[];
}

/** An ApiHandler without storage: answers 200 {"ok":true,"path":...}. */
export function stubApi(): StubApi {
  const calls: TraceletHttpRequest[] = [];
  return {
    calls,
    handler: async req => {
      calls.push(req);
      return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: true, path: req.path, query: req.query }) };
    },
  };
}

export const CP = String.fromCharCode;
export const LS = CP(0x2028);
export const PS = CP(0x2029);
