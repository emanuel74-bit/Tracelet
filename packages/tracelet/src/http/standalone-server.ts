import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopbackAddress } from './auth';
import type { Dispatcher } from './dispatcher';
import { INTERNAL_ERROR_RESPONSE, writeNodeResponse } from './write-response';

export interface StandaloneServerOptions {
  dispatch: Dispatcher;
  /** Default '127.0.0.1'. Any non-loopback host requires `hasAuthorize`. */
  host?: string;
  port: number;
  /** true when the caller configured an authorize() hook. */
  hasAuthorize: boolean;
  /** Max concurrent sockets. Default 256. */
  maxConnections?: number;
  /** Graceful close waits this long for in-flight requests, then destroys sockets. Default 2000. */
  closeGraceMs?: number;
}

export interface StandaloneServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export function assertSafeListenHost(host: string, hasAuthorize: boolean): void {
  if (!hasAuthorize && host.toLowerCase() !== 'localhost' && !isLoopbackAddress(host)) {
    throw new Error('Tracelet.listen: binding a non-loopback host requires an authorize() hook');
  }
}

/** Worker-only processes (no Nest HTTP server): a bounded node:http listener. Every request goes through the dispatcher. */
export async function startStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServer> {
  const host = options.host ?? '127.0.0.1';
  assertSafeListenHost(host, options.hasAuthorize);
  const server = createServer({ keepAliveTimeout: 5000, headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    void options
      .dispatch({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, remoteAddress: req.socket.remoteAddress, raw: req, adapter: 'node-http' })
      .then(
        r => writeNodeResponse(res, r),
        () => writeNodeResponse(res, INTERNAL_ERROR_RESPONSE),
      );
    req.resume();
  });
  server.maxConnections = options.maxConnections ?? 256;
  server.maxRequestsPerSocket = 1000;
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(options.port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  const addr = server.address() as AddressInfo;
  return {
    server,
    host,
    port: addr.port,
    close: () =>
      (closing ??= new Promise<void>(resolve => {
        const timer = setTimeout(() => server.closeAllConnections(), options.closeGraceMs ?? 2000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      })),
  };
}
