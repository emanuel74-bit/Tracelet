import { describe, expect, it, vi } from 'vitest';
import type { TraceletAuthRequest } from '../../../src/contracts/observe-contracts.js';
import { createAuthGate } from '../../../src/http/auth.js';
import { createDispatcher, methodNotAllowedResponse } from '../../../src/http/dispatcher.js';
import type { DispatchRequest } from '../../../src/http/dispatcher.js';
import { createStaticAssets } from '../../../src/http/static-assets.js';
import type { StaticAssets } from '../../../src/http/static-assets.js';
import { traceletAls } from '../../../src/shared/als.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';
import { normalizeBasePath } from '../../../src/http/base-path.js';
import { stubApi } from '../../support/http/http.js';

const JS = '/assets/index-DZSRTth0.js';
const quiet = createDiagnostics('t', () => {});
const allow = async (): Promise<boolean> => true;
const deny = async (): Promise<boolean> => false;

function setup(over: { auth?: (r: TraceletAuthRequest) => Promise<boolean>; assets?: StaticAssets; publicBasePath?: string; basePath?: string; maxInFlight?: number; api?: ReturnType<typeof stubApi>['handler'] } = {}) {
  const api = stubApi();
  const auth = vi.fn(over.auth ?? allow);
  const assets = over.assets ?? createStaticAssets(over.publicBasePath ?? over.basePath ?? '/observe');
  const dispatch = createDispatcher({
    basePath: over.basePath ?? '/observe',
    ...(over.publicBasePath ? { publicBasePath: over.publicBasePath } : {}),
    auth,
    api: over.api ?? api.handler,
    assets,
    ...(over.maxInFlight ? { maxInFlight: over.maxInFlight } : {}),
    diagnostics: quiet,
  });
  const get = (url: string, extra: Partial<DispatchRequest> = {}) =>
    dispatch({ method: 'GET', url, headers: {}, remoteAddress: '203.0.113.9', raw: {}, adapter: 'express', ...extra });
  return { dispatch, get, auth, api, assets };
}

describe('dispatcher: method gate (405, identical envelope)', () => {
  it('every method except GET and HEAD gets the 405 envelope and never reaches auth, assets or the API', async () => {
    const s = setup({ auth: deny });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'post', 'PROPFIND']) {
      for (const url of ['/observe/', '/observe/api/v1/traces', '/observe/anything']) {
        const r = await s.get(url, { method });
        expect(r.status, method).toBe(405);
        expect(JSON.parse(r.body as string)).toEqual({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and HEAD are supported' } });
        expect(r.headers.Allow).toBe('GET, HEAD');
        expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8');
      }
    }
    expect(s.auth).not.toHaveBeenCalled();
    expect(s.api.calls).toHaveLength(0);
  });

  it('methodNotAllowedResponse (used by the Fastify onRequest hook) is the very same envelope', async () => {
    const s = setup();
    const viaDispatcher = await s.get('/observe/', { method: 'POST' });
    const direct = methodNotAllowedResponse();
    expect(direct.status).toBe(viaDispatcher.status);
    expect(direct.body).toBe(viaDispatcher.body);
    const { 'X-Tracelet-Request-Id': _id, 'Content-Length': _len, ...rest } = viaDispatcher.headers;
    expect(rest).toEqual(direct.headers);
  });
});

describe('dispatcher: the auth gate runs first for every resource', () => {
  const resources = ['/observe/', '/observe/index.html', '/observe/assets/index-DZSRTth0.js', '/observe/assets/missing.js', '/observe/some/spa/route', '/observe/api/v1/traces', '/observe/api/v1/health', '/observe/api', '/observe', '/observe?x=1', '/observe/%zz', '/elsewhere', '/observe/x.map'];

  it('denied: 403 with one identical body for ALL resources (nothing about existence is revealed); no asset or API access', async () => {
    const s = setup({ auth: deny });
    const bodies = new Set<string>();
    for (const url of resources) {
      const r = await s.get(url);
      expect(r.status, url).toBe(403);
      expect(JSON.parse(r.body as string)).toEqual({ error: { code: 'FORBIDDEN', message: 'Observe access is not authorized' } });
      expect(r.headers.Location).toBeUndefined();
      expect(r.headers.ETag).toBeUndefined();
      bodies.add(r.body as string);
    }
    expect(bodies.size).toBe(1);
    expect(s.api.calls).toHaveLength(0);
    expect(s.auth).toHaveBeenCalledTimes(resources.length);
  });

  it('denied with If-None-Match of the real ETag still gives 403, not 304 (no existence oracle)', async () => {
    const s = setup({ auth: deny });
    const etag = s.assets.serve(JS, 'GET', undefined)!.headers.ETag;
    const r = await s.get('/observe' + JS, { headers: { 'if-none-match': etag } });
    expect(r.status).toBe(403);
  });

  it('denied HEAD has an empty body', async () => {
    const r = await setup({ auth: deny }).get('/observe/', { method: 'HEAD' });
    expect(r.status).toBe(403);
    expect(r.body).toBe('');
  });

  it('allowed: html, asset, SPA redirect and API are all reachable', async () => {
    const s = setup();
    expect((await s.get('/observe/')).status).toBe(200);
    expect((await s.get('/observe' + JS)).status).toBe(200);
    expect((await s.get('/observe/some/route')).status).toBe(307);
    expect((await s.get('/observe/api/v1/health')).status).toBe(200);
  });

  it('auth receives the neutral request: path relative to the base, socket peer, headers untouched, adapter and raw', async () => {
    const s = setup();
    const raw = { r: 1 };
    const headers = { 'x-forwarded-for': '127.0.0.1' };
    await s.get('/observe/api/v1/traces?limit=2', { remoteAddress: '10.9.8.7', headers, raw, adapter: 'fastify' });
    expect(s.auth).toHaveBeenCalledWith({ method: 'GET', path: '/api/v1/traces', headers, remoteAddress: '10.9.8.7', raw, adapter: 'fastify' });
  });

  it('a real gate with a spoofed X-Forwarded-For from a non-loopback peer denies everything (L9)', async () => {
    const gate = createAuthGate({ allowLoopbackWithoutAuth: true });
    const s = setup({ auth: gate });
    for (const url of ['/observe/', '/observe' + JS, '/observe/x/y', '/observe/api/v1/health']) {
      const r = await s.get(url, { headers: { 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '198.51.100.4' });
      expect(r.status, url).toBe(403);
    }
    expect((await s.get('/observe/', { remoteAddress: '::ffff:127.0.0.1' })).status).toBe(200);
  });
});

describe('dispatcher: routing', () => {
  it('canonicalises the mount to a trailing slash and keeps the query (307, no-store)', async () => {
    const s = setup();
    for (const [url, loc] of [['/observe', '/observe/'], ['/observe?range=1h&tab=traces', '/observe/?range=1h&tab=traces'], ['/observe?', '/observe/?']] as const) {
      const r = await s.get(url);
      expect(r.status, url).toBe(307);
      expect(r.headers.Location).toBe(loc);
      expect(r.headers['Cache-Control']).toBe('no-store');
      expect(r.body).toBe('');
    }
  });

  it('redirects use the public base path behind a rewriting proxy', async () => {
    const s = setup({ basePath: '/observe', publicBasePath: '/team/observe' });
    expect((await s.get('/observe?x=1')).headers.Location).toBe('/team/observe/?x=1');
    expect((await s.get('/observe/deep/er')).headers.Location).toBe('/team/observe/');
    const cfg = JSON.parse(/application\/json">([^<]*)</.exec(((await s.get('/observe/')).body as Buffer).toString())![1]);
    expect(cfg.basePath).toBe('/team/observe');
  });

  it('nested navigation paths are NOT served unchanged (relative assets would break): they redirect to the base and keep the query', async () => {
    const s = setup();
    const r = await s.get('/observe/a/b?tab=errors');
    expect(r.status).toBe(307);
    expect(r.headers.Location).toBe('/observe/?tab=errors');
    expect((await s.get('/observe/a/b/')).headers.Location).toBe('/observe/');
  });

  it('unknown file-like paths and /assets/* are 404 JSON, never index.html', async () => {
    const s = setup();
    for (const url of ['/observe/assets/missing.js', '/observe/assets/', '/observe/favicon.ico', '/observe/app.js.map', '/observe/assets/index-DZSRTth0.js.map', '/observe/asset-manifest.json', '/observe/%2e%2e/x.js']) {
      const r = await s.get(url);
      expect(r.status, url).toBe(404);
      expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(r.body as string).error.code).toBe('NOT_FOUND');
    }
  });

  it('encoded slashes/backslashes and NUL are not decoded into asset paths; invalid percent-encoding is a 400', async () => {
    const s = setup();
    expect((await s.get('/observe/assets%2Findex-DZSRTth0.js')).status).toBe(404);
    expect((await s.get('/observe/assets%5Cindex-DZSRTth0.js')).status).toBe(404);
    expect((await s.get('/observe/%00')).status).toBe(404);
    expect((await s.get('/observe/%zz')).status).toBe(400);
  });

  it('paths outside the base are 404 (after auth)', async () => {
    const s = setup();
    expect((await s.get('/other')).status).toBe(404);
    expect((await s.get('/observer')).status).toBe(404);
    expect((await s.get('/observe-x/')).status).toBe(404);
  });

  it('serves html, assets, 304 and HEAD with the headers of the static layer', async () => {
    const s = setup();
    const html = await s.get('/observe/');
    expect(html.status).toBe(200);
    expect(html.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(html.headers['Content-Length']).toBe(String((html.body as Buffer).length));
    const asset = await s.get('/observe' + JS);
    expect(asset.headers['Cache-Control']).toBe('private, max-age=86400, immutable');
    const cond = await s.get('/observe' + JS, { headers: { 'if-none-match': asset.headers.ETag } });
    expect(cond.status).toBe(304);
    expect(cond.body).toBe('');
    expect(cond.headers['Content-Length']).toBeUndefined();
    const head = await s.get('/observe' + JS, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['Content-Length']).toBe(String((asset.body as Buffer).length));
    const headRedirect = await s.get('/observe', { method: 'HEAD' });
    expect(headRedirect.status).toBe(307);
  });

  it('API: path is relative with the /api/v1 prefix, query keeps the first value of repeated keys, __proto__ is dropped', async () => {
    const s = setup();
    const r = await s.get('/observe/api/v1/traces?limit=5&limit=6&service=a%20b&__proto__=x&empty=');
    expect(r.status).toBe(200);
    expect(s.api.calls).toHaveLength(1);
    expect(s.api.calls[0].method).toBe('GET');
    expect(s.api.calls[0].path).toBe('/api/v1/traces');
    expect({ ...s.api.calls[0].query }).toEqual({ limit: '5', service: 'a b', empty: '' });
    expect(Object.getPrototypeOf(s.api.calls[0].query)).toBe(Object.prototype);
    // raw (undecoded) path so the API handler can decode identifiers itself
    await s.get('/observe/api/v1/traces/abc%2Fdef');
    expect(s.api.calls[1].path).toBe('/api/v1/traces/abc%2Fdef');
  });

  it('API: oversized or excessive query strings are rejected with 400 before the handler', async () => {
    const s = setup();
    expect((await s.get('/observe/api/v1/traces?x=' + 'a'.repeat(9000))).status).toBe(400);
    expect((await s.get('/observe/api/v1/traces?' + Array.from({ length: 101 }, (_, i) => `k${i}=1`).join('&'))).status).toBe(400);
    expect(s.api.calls).toHaveLength(0);
  });

  it('API: /api/v1 itself and unknown api paths go to the handler (which decides); responses get security headers', async () => {
    const s = setup();
    const r = await s.get('/observe/api/v1');
    expect(s.api.calls[0].path).toBe('/api/v1');
    expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.headers['Cache-Control']).toBe('no-store');
  });

  it('a custom, nested base path works', async () => {
    const s = setup({ basePath: '/internal/obs-1/dash' });
    expect((await s.get('/internal/obs-1/dash/')).status).toBe(200);
    expect((await s.get('/internal/obs-1/dash/api/v1/health')).status).toBe(200);
    expect((await s.get('/internal/obs-1/dash')).headers.Location).toBe('/internal/obs-1/dash/');
    expect((await s.get('/observe/')).status).toBe(404);
  });
});

describe('dispatcher: dashboard unavailable, API still works', () => {
  it('invalid assets: html/asset/redirect paths are 503 JSON without detail, the API is served', async () => {
    const broken = createStaticAssets('/observe', { assetDir: 'Z:/definitely/not/here', diagnostics: quiet });
    const s = setup({ assets: broken });
    for (const url of ['/observe/', '/observe', '/observe' + JS, '/observe/spa/route']) {
      const r = await s.get(url);
      expect(r.status, url).toBe(503);
      expect(r.body as string).not.toMatch(/manifest|Z:|sha256/);
    }
    expect((await s.get('/observe/api/v1/health')).status).toBe(200);
  });
});

describe('dispatcher: robustness', () => {
  it('never throws or rejects: a throwing API handler, auth and assets become a detail-free 500', async () => {
    const boomApi = setup({ api: async () => { throw new Error('mongodb://user:pw@host leaked'); } });
    const r1 = await boomApi.get('/observe/api/v1/traces');
    expect(r1.status).toBe(500);
    expect(r1.body).not.toMatch(/mongodb|pw|leaked/);
    expect(JSON.parse(r1.body as string).error.code).toBe('INTERNAL');

    const boomAuth = setup({ auth: async () => { throw new Error('auth blew up secret'); } });
    const r2 = await boomAuth.get('/observe/');
    expect(r2.status).toBe(500);
    expect(r2.body).not.toContain('secret');

    const base = createStaticAssets('/observe');
    const brokenAssets: StaticAssets = { ...base, serve: () => { throw new Error('assets exploded'); } };
    const r3 = await setup({ assets: brokenAssets }).get('/observe/');
    expect(r3.status).toBe(500);
    expect(r3.body).not.toContain('exploded');
  });

  it('garbage input (missing url/method/headers) does not throw', async () => {
    const s = setup();
    for (const bad of [{ method: undefined, url: undefined, headers: undefined }, { method: 'GET', url: 'http://evil/observe/', headers: {} }, { method: 'GET', url: '', headers: {} }] as unknown as DispatchRequest[]) {
      const r = await s.dispatch(bad);
      expect([200, 307, 400, 403, 404, 405, 500]).toContain(r.status);
    }
  });

  it('every response has a fresh request id and the security baseline; an incoming X-Request-Id is not echoed', async () => {
    const s = setup();
    const ids = new Set<string>();
    for (const [url, extra] of [['/observe/', {}], ['/observe/api/v1/health', {}], ['/observe/x', {}], ['/observe/', { method: 'POST' }], ['/observe/', { headers: { 'x-request-id': 'attacker<>' } }]] as const) {
      const r = await s.get(url, extra as Partial<DispatchRequest>);
      ids.add(r.headers['X-Tracelet-Request-Id']);
      expect(r.headers['X-Tracelet-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(r.headers['Referrer-Policy']).toBe('no-referrer');
    }
    expect(ids.size).toBe(5);
  });

  it('concurrency is bounded: requests beyond maxInFlight get 429, slots are released, the counter survives failures', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>(r => (release = r));
    const calls = { n: 0 };
    const s = setup({ maxInFlight: 2, api: async () => { calls.n++; await gateOpen; return { status: 200, headers: {}, body: '{}' }; } });
    const a = s.get('/observe/api/v1/a');
    const b = s.get('/observe/api/v1/b');
    await new Promise(r => setTimeout(r, 10));
    const c = await s.get('/observe/api/v1/c');
    expect(c.status).toBe(429);
    expect(JSON.parse(c.body as string).error.code).toBe('RATE_LIMITED');
    expect(c.headers['Retry-After']).toBe('1');
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await s.get('/observe/api/v1/d')).status).toBe(200);
    expect(calls.n).toBe(3);
  });

  it('runs outside any trace store (auth, API and static serving see no ALS store) even when dispatched from inside a trace', async () => {
    const seen: Array<unknown> = [];
    const base = createStaticAssets('/observe');
    const spyAssets: StaticAssets = { ...base, serve: (...a) => { seen.push(traceletAls.getStore()); return base.serve(...a); } };
    const s = setup({
      auth: async () => { seen.push(traceletAls.getStore()); await new Promise(r => setImmediate(r)); seen.push(traceletAls.getStore()); return true; },
      assets: spyAssets,
      api: async () => { seen.push(traceletAls.getStore()); await new Promise(r => setTimeout(r, 1)); seen.push(traceletAls.getStore()); return { status: 200, headers: {}, body: '{}' }; },
    });
    await traceletAls.run(new Map([['marker', 1]]), async () => {
      expect(traceletAls.getStore()).toBeDefined();
      await s.get('/observe/');
      await s.get('/observe/api/v1/health');
    });
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.every(x => x === undefined)).toBe(true);
  });
});

describe('normalizeBasePath', () => {
  it('accepts and canonicalises', () => {
    expect(normalizeBasePath('/observe')).toBe('/observe');
    expect(normalizeBasePath('/observe/')).toBe('/observe');
    expect(normalizeBasePath('/a/b_c-d.e/~f')).toBe('/a/b_c-d.e/~f');
  });
  it('rejects the root, relative, empty, dot, double-slash and unsafe characters', () => {
    for (const bad of ['/', '//', '', 'observe', '/a//b', '/a/./b', '/a/../b', '/a b', '/a%2Fb', '/a?x', '/a#x', '/<x>', '/a\\b', '/observe//']) expect(() => normalizeBasePath(bad), bad).toThrow();
    expect(() => normalizeBasePath(undefined as never)).toThrow();
  });
});
