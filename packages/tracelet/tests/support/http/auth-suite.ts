import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceletAuthRequest } from '../../../src/contracts/observe-contracts.js';
import { startHostApp } from './apps.js';
import type { AdapterName, HostApp, HostAppOptions } from './apps.js';
import { httpRequest, nonLoopbackAddress } from './http.js';

/**
 * T15 (plan 17) for one platform adapter: the same assertions run against a real Nest application on Express 5 and on
 * Fastify 5, so both adapters are held to identical behaviour (auth on every resource, loopback rule, socket-only peer
 * address with trust proxy on, the 405 envelope).
 */

const ASSET_DIR = resolve(__dirname, '..', '..', '..', 'assets', 'dashboard');
const JS_FILE = 'assets/index-DZSRTth0.js';
const ENVELOPE_403 = { error: { code: 'FORBIDDEN', message: 'Observe access is not authorized' } };
const ENVELOPE_405 = { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and HEAD are supported' } };

async function ipv6Available(): Promise<boolean> {
  return new Promise(res => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(0, '::1', () => s.close(() => res(true)));
  });
}

function resources(base: string): Array<[string, string]> {
  return [
    ['index (/)', `${base}/`],
    ['index.html', `${base}/index.html`],
    ['hashed js asset', `${base}/${JS_FILE}`],
    ['hashed css asset', `${base}/assets/index-8H8qAzKJ.css`],
    ['SPA route', `${base}/traces/0190-abc`],
    ['SPA route with query', `${base}/errors?range=1h`],
    ['canonical redirect', `${base}`],
    ['API health', `${base}/api/v1/health`],
    ['API traces', `${base}/api/v1/traces?limit=5`],
    ['unknown asset', `${base}/assets/missing.js`],
    ['source map', `${base}/${JS_FILE}.map`],
    ['manifest', `${base}/asset-manifest.json`],
  ];
}

export function defineAuthSuite(adapter: AdapterName): void {
  const lan = nonLoopbackAddress();
  const started: HostApp[] = [];
  const start = async (o: Partial<HostAppOptions> = {}): Promise<HostApp> => {
    const h = await startHostApp({ adapter, ...o });
    started.push(h);
    return h;
  };
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(started.splice(0).map(h => h.close()));
  });

  describe(`T15 [${adapter}] default policy in production (NODE_ENV unset)`, () => {
    it('loopback without authorize gets 403 on html, assets, SPA routes and API (R10)', async () => {
      vi.stubEnv('NODE_ENV', undefined as unknown as string);
      expect(process.env.NODE_ENV).toBeUndefined();
      const h = await start({ trustProxy: true });
      for (const [name, path] of resources('/observe')) {
        const r = await httpRequest({ port: h.port, path });
        expect(r.status, name).toBe(403);
        expect(JSON.parse(r.text), name).toEqual(ENVELOPE_403);
        expect(r.headers.location, name).toBeUndefined();
      }
      expect(h.stub.calls).toHaveLength(0);
    });

    it('the 403 body is identical for resources that exist and that do not (no information about resources)', async () => {
      vi.stubEnv('NODE_ENV', undefined as unknown as string);
      const h = await start();
      const bodies = new Set<string>();
      for (const [, path] of [...resources('/observe'), ['x', '/observe/definitely/not/here.json'] as [string, string]]) bodies.add((await httpRequest({ port: h.port, path })).text);
      expect(bodies.size).toBe(1);
    });

    it('an explicit allowLoopbackWithoutAuth: true is honoured for loopback only', async () => {
      vi.stubEnv('NODE_ENV', undefined as unknown as string);
      const h = await start({ allowLoopbackWithoutAuth: true });
      expect((await httpRequest({ port: h.port, path: '/observe/' })).status).toBe(200);
      if (lan) expect((await httpRequest({ host: lan, port: h.port, path: '/observe/' })).status).toBe(403);
    });
  });

  describe(`T15 [${adapter}] dev/test default: loopback allowed, everything else denied`, () => {
    it('loopback serves index, assets, SPA redirect and API; the dashboard works end to end', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start();
      const html = await httpRequest({ port: h.port, path: '/observe/' });
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(html.headers['content-security-policy']).toContain("default-src 'none'");
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.headers['x-content-type-options']).toBe('nosniff');
      expect(html.headers['content-length']).toBe(String(html.body.length));
      expect(html.text).toContain('<script id="tracelet-config" type="application/json">');
      expect(html.text).not.toContain('<!--tracelet:config-->');

      const js = await httpRequest({ port: h.port, path: `/observe/${JS_FILE}` });
      expect(js.status).toBe(200);
      expect(js.body.equals(readFileSync(resolve(ASSET_DIR, JS_FILE)))).toBe(true);
      expect(js.headers['cache-control']).toBe('private, max-age=86400, immutable');
      expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');

      const cond = await httpRequest({ port: h.port, path: `/observe/${JS_FILE}`, headers: { 'If-None-Match': String(js.headers.etag) } });
      expect(cond.status).toBe(304);
      expect(cond.body.length).toBe(0);

      const api = await httpRequest({ port: h.port, path: '/observe/api/v1/traces?limit=5&limit=9' });
      expect(api.status).toBe(200);
      expect(JSON.parse(api.text)).toMatchObject({ ok: true, path: '/api/v1/traces', query: { limit: '5' } });
      expect(api.headers['x-tracelet-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('canonical mount: /observe redirects to /observe/ keeping the query; nested navigation redirects to the base (relative assets)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start();
      const a = await httpRequest({ port: h.port, path: '/observe?range=1h&tab=traces' });
      expect(a.status).toBe(307);
      expect(a.headers.location).toBe('/observe/?range=1h&tab=traces');
      const b = await httpRequest({ port: h.port, path: '/observe/traces/abc?x=1' });
      expect(b.status).toBe(307);
      expect(b.headers.location).toBe('/observe/?x=1');
      const missing = await httpRequest({ port: h.port, path: '/observe/assets/missing.js' });
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.text).error.code).toBe('NOT_FOUND');
      expect((await httpRequest({ port: h.port, path: `/observe/${JS_FILE}.map` })).status).toBe(404);
      expect((await httpRequest({ port: h.port, path: '/observe/asset-manifest.json' })).status).toBe(404);
    });

    it('HEAD: same status and headers as GET, no body, on html, asset, api and redirect', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start();
      for (const path of ['/observe/', `/observe/${JS_FILE}`, '/observe/api/v1/health', '/observe', '/observe/x/y']) {
        const get = await httpRequest({ port: h.port, path });
        const head = await httpRequest({ port: h.port, method: 'HEAD', path });
        expect(head.status, path).toBe(get.status);
        expect(head.body.length, path).toBe(0);
        expect(head.headers['cache-control'], path).toBe(get.headers['cache-control']);
        expect(head.headers['content-type'], path).toBe(get.headers['content-type']);
        expect(head.headers.location, path).toBe(get.headers.location);
        expect(head.headers.etag, path).toBe(get.headers.etag);
      }
      const head = await httpRequest({ port: h.port, method: 'HEAD', path: '/observe/' });
      const get = await httpRequest({ port: h.port, path: '/observe/' });
      expect(head.headers['content-length']).toBe(String(get.body.length));
    });

    it.skipIf(lan === undefined)('a non-loopback peer is denied on every resource, with trust proxy on and a spoofed X-Forwarded-For (L9)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start({ trustProxy: true });
      const spoof = { 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1', 'X-Real-IP': '127.0.0.1' };
      for (const [name, path] of resources('/observe')) {
        for (const headers of [{}, spoof]) {
          const r = await httpRequest({ host: lan, port: h.port, path, headers });
          expect(r.status, name).toBe(403);
          expect(JSON.parse(r.text), name).toEqual(ENVELOPE_403);
        }
      }
      expect(h.stub.calls).toHaveLength(0);
      // control: the same spoofed header from the loopback peer does not matter either, loopback is allowed on its own
      expect((await httpRequest({ port: h.port, path: '/observe/', headers: spoof })).status).toBe(200);
    });

    it.skipIf(lan === undefined)('the host application behind the same server is unaffected (/hello served, unknown route 404 from Nest, non-loopback reaches /hello)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start({ trustProxy: true });
      const hello = await httpRequest({ host: lan, port: h.port, path: '/hello' });
      expect(hello.status).toBe(200);
      expect(hello.text).toBe('hello from the host app');
      const nope = await httpRequest({ host: lan, port: h.port, path: '/nope' });
      expect(nope.status).toBe(404);
      expect(nope.text).not.toContain('FORBIDDEN');
    });

    it('IPv6 dual stack: the peer ::ffff:127.0.0.1 (IPv4-mapped) and ::1 are loopback; a LAN peer is not', async () => {
      if (!(await ipv6Available())) return; // no IPv6 loopback on this machine
      vi.stubEnv('NODE_ENV', 'test');
      const seen: Array<string | undefined> = [];
      const h = await start({ listenHost: '::', trustProxy: true });
      // observe the peer text the gate sees by also running an authorize-less control through a second app with a hook
      const probe = await start({ listenHost: '::', authorize: (r: TraceletAuthRequest) => { seen.push(r.remoteAddress); return true; } });
      expect((await httpRequest({ host: '127.0.0.1', port: h.port, path: '/observe/' })).status).toBe(200);
      expect((await httpRequest({ host: '::1', port: h.port, path: '/observe/api/v1/health' })).status).toBe(200);
      await httpRequest({ host: '127.0.0.1', port: probe.port, path: '/observe/' });
      await httpRequest({ host: '::1', port: probe.port, path: '/observe/' });
      expect(seen).toEqual(['::ffff:127.0.0.1', '::1']);
      if (lan) {
        const r = await httpRequest({ host: lan, port: h.port, path: '/observe/', headers: { 'X-Forwarded-For': '::1' } });
        expect(r.status).toBe(403);
      }
    });
  });

  describe(`T15 [${adapter}] authorize hook`, () => {
    it('the hook decides alone: it may allow a non-loopback peer and deny a loopback one; request details are neutral', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const seen: TraceletAuthRequest[] = [];
      const h = await start({
        trustProxy: true,
        authorize: r => {
          seen.push(r);
          return r.headers['x-token'] === 'letmein';
        },
      });
      const denied = await httpRequest({ port: h.port, path: '/observe/' }); // loopback, no token
      expect(denied.status).toBe(403);
      const ok = await httpRequest({ port: h.port, path: '/observe/api/v1/health', headers: { 'X-Token': 'letmein' } });
      expect(ok.status).toBe(200);
      expect(seen[1]).toMatchObject({ method: 'GET', path: '/api/v1/health', adapter });
      expect(seen[1].remoteAddress).toMatch(/^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
      expect(seen[1].raw).toBeTruthy();
      if (lan) {
        const remote = await httpRequest({ host: lan, port: h.port, path: '/observe/', headers: { 'X-Token': 'letmein', 'X-Forwarded-For': '127.0.0.1' } });
        expect(remote.status).toBe(200);
        expect(seen[seen.length - 1].remoteAddress).toBe(lan); // the socket peer, not X-Forwarded-For
      }
    });

    it('a throwing or rejecting hook denies with the plain 403 envelope and never leaks the error', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      for (const authorize of [
        () => { throw new Error('secret-db-password'); },
        () => Promise.reject(new Error('secret-db-password')),
      ]) {
        const h = await start({ authorize });
        for (const path of ['/observe/', '/observe/api/v1/health', `/observe/${JS_FILE}`]) {
          const r = await httpRequest({ port: h.port, path });
          expect(r.status).toBe(403);
          expect(r.text).not.toContain('secret');
          expect(JSON.parse(r.text)).toEqual(ENVELOPE_403);
        }
      }
    });
    it('a hook that never answers is denied after the 2 s timeout (the request does not hang)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start({ authorize: () => new Promise<boolean>(() => {}) });
      const t = Date.now();
      const r = await httpRequest({ port: h.port, path: '/observe/api/v1/health' });
      const elapsed = Date.now() - t;
      expect(r.status).toBe(403);
      expect(JSON.parse(r.text)).toEqual(ENVELOPE_403);
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThan(6000);
      expect(h.stub.calls).toHaveLength(0);
    });
  });

  describe(`T15 [${adapter}] 405 envelope for non-GET/HEAD (L10)`, () => {
    it('POST/PUT/PATCH/DELETE/OPTIONS on every kind of path give the same 405 envelope, before body parsing, even unauthorised', async () => {
      vi.stubEnv('NODE_ENV', undefined as unknown as string);
      const h = await start({ trustProxy: true }); // production defaults: nobody is authorised
      const bodies = new Set<string>();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        for (const path of ['/observe', '/observe/', '/observe/api/v1/traces', '/observe/some/spa/route', `/observe/${JS_FILE}`]) {
          const r = await httpRequest({ port: h.port, method, path });
          expect(r.status, `${method} ${path}`).toBe(405);
          expect(JSON.parse(r.text), `${method} ${path}`).toEqual(ENVELOPE_405);
          expect(r.headers.allow, `${method} ${path}`).toBe('GET, HEAD');
          expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
          expect(r.headers['x-content-type-options']).toBe('nosniff');
          bodies.add(r.text);
        }
      }
      expect(bodies.size).toBe(1);
    });

    it('a body with a malformed JSON or an unknown content type is answered with 405, not a parser error (415/400)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start();
      for (const [contentType, body] of [['application/json', '{not json'], ['application/x-weird', 'abc'], ['text/plain', 'hello'], ['application/json', '{"a":1}']] as const) {
        const r = await httpRequest({ port: h.port, method: 'POST', path: '/observe/api/v1/traces', headers: { 'Content-Type': contentType, 'Content-Length': String(Buffer.byteLength(body)) }, body });
        expect(r.status, contentType + body).toBe(405);
        expect(JSON.parse(r.text)).toEqual(ENVELOPE_405);
      }
      expect(h.stub.calls).toHaveLength(0);
    });
  });

  describe(`T15 [${adapter}] custom base path and global prefix`, () => {
    it('a global prefix does not move or break the dashboard; the base path is the configured absolute path', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const h = await start({ globalPrefix: 'api/v2', basePath: '/internal/tools/observe', trustProxy: true });
      const html = await httpRequest({ port: h.port, path: '/internal/tools/observe/' });
      expect(html.status).toBe(200);
      const cfg = JSON.parse(/<script id="tracelet-config" type="application\/json">([^<]*)<\/script>/.exec(html.text)![1]);
      expect(cfg).toMatchObject({ basePath: '/internal/tools/observe', apiBase: '/internal/tools/observe/api/v1' });
      expect((await httpRequest({ port: h.port, path: '/internal/tools/observe' })).headers.location).toBe('/internal/tools/observe/');
      expect((await httpRequest({ port: h.port, path: '/internal/tools/observe/api/v1/health' })).status).toBe(200);
      expect((await httpRequest({ port: h.port, path: '/internal/tools/observe/a/b?x=1' })).headers.location).toBe('/internal/tools/observe/?x=1');
      // the prefixed host route still works and is NOT shadowed
      expect((await httpRequest({ port: h.port, path: '/api/v2/hello' })).text).toBe('hello from the host app');
      // the default mount is not present
      expect((await httpRequest({ port: h.port, path: '/observe/' })).status).not.toBe(200);
      // unauthorised stays 403 under the custom base path too
      if (lan) {
        for (const p of ['/', '/index.html', `/${JS_FILE}`, '/x/y', '/api/v1/health']) {
          expect((await httpRequest({ host: lan, port: h.port, path: '/internal/tools/observe' + p, headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, p).toBe(403);
        }
      }
    });

    it('Tracelet paths with markup or traversal are refused at mount time', async () => {
      for (const basePath of ['/', '', 'observe', '/a/../b', '/<script>']) {
        await expect(startHostApp({ adapter, basePath }), basePath).rejects.toThrow();
      }
    });
  });
}
