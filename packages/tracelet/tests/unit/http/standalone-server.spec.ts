import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createAuthGate } from '../../../src/http/auth.js';
import { createDispatcher } from '../../../src/http/dispatcher.js';
import { assertSafeListenHost, startStandaloneServer } from '../../../src/http/standalone-server.js';
import type { StandaloneServer } from '../../../src/http/standalone-server.js';
import { createStaticAssets } from '../../../src/http/static-assets.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';
import { httpRequest, nonLoopbackAddress, stubApi } from '../../support/http/http.js';

const quiet = createDiagnostics('t', () => {});
const running: StandaloneServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(s => s.close()));
});

async function start(over: { allowLoopbackWithoutAuth?: boolean; authorize?: () => boolean; host?: string; maxConnections?: number } = {}) {
  const api = stubApi();
  const dispatch = createDispatcher({
    basePath: '/observe',
    auth: createAuthGate({ allowLoopbackWithoutAuth: over.allowLoopbackWithoutAuth ?? true, ...(over.authorize ? { authorize: over.authorize } : {}), diagnostics: quiet }),
    api: api.handler,
    assets: createStaticAssets('/observe'),
    diagnostics: quiet,
  });
  const server = await startStandaloneServer({ dispatch, port: 0, hasAuthorize: over.authorize !== undefined, ...(over.host ? { host: over.host } : {}), ...(over.maxConnections ? { maxConnections: over.maxConnections } : {}) });
  running.push(server);
  return { server, api };
}

describe('standalone server', () => {
  it('binds 127.0.0.1 by default and serves dashboard and API to loopback peers', async () => {
    const { server } = await start();
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect((await httpRequest({ port: server.port, path: '/observe/' })).status).toBe(200);
    const api = await httpRequest({ port: server.port, path: '/observe/api/v1/health' });
    expect(api.status).toBe(200);
    expect(JSON.parse(api.text).ok).toBe(true);
    expect((await httpRequest({ port: server.port, method: 'POST', path: '/observe/api/v1/health' })).status).toBe(405);
    expect((await httpRequest({ port: server.port, path: '/observe' })).headers.location).toBe('/observe/');
  });

  it('default deny (production defaults): a loopback client without authorize gets 403', async () => {
    const { server } = await start({ allowLoopbackWithoutAuth: false });
    for (const p of ['/observe/', '/observe/api/v1/health', '/observe/x/y']) expect((await httpRequest({ port: server.port, path: p })).status, p).toBe(403);
  });

  it('refuses a non-loopback bind without authorize and allows it with authorize', async () => {
    expect(() => assertSafeListenHost('0.0.0.0', false)).toThrow(/authorize/);
    expect(() => assertSafeListenHost('192.168.1.5', false)).toThrow();
    expect(() => assertSafeListenHost('::', false)).toThrow();
    for (const h of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST']) expect(() => assertSafeListenHost(h, false)).not.toThrow();
    expect(() => assertSafeListenHost('0.0.0.0', true)).not.toThrow();
    const api = stubApi();
    const dispatch = createDispatcher({ basePath: '/observe', auth: createAuthGate({}), api: api.handler, assets: createStaticAssets('/observe'), diagnostics: quiet });
    await expect(startStandaloneServer({ dispatch, port: 0, host: '0.0.0.0', hasAuthorize: false })).rejects.toThrow(/non-loopback/);
  });

  it('a non-loopback peer is denied by authorize even when the server listens on all interfaces', async () => {
    const lan = nonLoopbackAddress();
    if (!lan) return; // no external interface on this machine
    const seen: Array<string | undefined> = [];
    const api = stubApi();
    const dispatch = createDispatcher({
      basePath: '/observe',
      auth: createAuthGate({ authorize: r => { seen.push(r.remoteAddress); return false; } }),
      api: api.handler,
      assets: createStaticAssets('/observe'),
      diagnostics: quiet,
    });
    const server = await startStandaloneServer({ dispatch, port: 0, host: '0.0.0.0', hasAuthorize: true });
    running.push(server);
    const r = await httpRequest({ host: lan, port: server.port, path: '/observe/api/v1/health', headers: { 'X-Forwarded-For': '127.0.0.1' } });
    expect(r.status).toBe(403);
    expect(seen).toEqual([lan]);
    expect(api.calls).toHaveLength(0);
  });

  it('reports a bind failure (port in use) as a rejection', async () => {
    const blocker = createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const dispatch = createDispatcher({ basePath: '/observe', auth: createAuthGate({}), api: stubApi().handler, assets: createStaticAssets('/observe'), diagnostics: quiet });
      await expect(startStandaloneServer({ dispatch, port, hasAuthorize: false })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });

  it('close() is graceful, idempotent, and stops accepting connections', async () => {
    const { server } = await start();
    await httpRequest({ port: server.port, path: '/observe/' });
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await first;
    await expect(httpRequest({ port: server.port, path: '/observe/' })).rejects.toThrow();
  });

  it('close() does not hang on an idle keep-alive or half-open client (grace period, then sockets are destroyed)', async () => {
    const api = stubApi();
    const dispatch = createDispatcher({ basePath: '/observe', auth: createAuthGate({ allowLoopbackWithoutAuth: true }), api: api.handler, assets: createStaticAssets('/observe'), diagnostics: quiet });
    const server = await startStandaloneServer({ dispatch, port: 0, hasAuthorize: false, closeGraceMs: 200 });
    // a client that connects and sends half a request line
    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>(r => socket.once('connect', () => r()));
    socket.write('GET /observe/ HTT');
    await new Promise(r => setTimeout(r, 30));
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
    socket.destroy();
  });

  it('is bounded: maxConnections is applied to the server', async () => {
    const { server } = await start({ maxConnections: 7 });
    expect(server.server.maxConnections).toBe(7);
    expect(server.server.requestTimeout).toBe(10_000);
    expect(server.server.headersTimeout).toBe(5000);
  });
});
