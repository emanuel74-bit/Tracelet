import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceletAuthRequest } from '../../../src/contracts/observe-contracts.js';
import { createAuthGate, isLoopbackAddress } from '../../../src/http/auth.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';

const req = (over: Partial<TraceletAuthRequest> = {}): TraceletAuthRequest => ({
  method: 'GET',
  path: '/',
  headers: {},
  remoteAddress: '203.0.113.9',
  raw: {},
  adapter: 'express',
  ...over,
});

const quiet = () => {
  const lines: string[] = [];
  return { lines, diagnostics: createDiagnostics('t', (_l, _s, m) => lines.push(m)) };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('isLoopbackAddress', () => {
  it('accepts exactly 127.0.0.1, ::1 and ::ffff:127.0.0.1 (case-insensitive)', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true);
  });
  it('rejects everything else, including look-alikes', () => {
    for (const a of [undefined, '', 'localhost', '127.0.0.2', '127.0.0.1 ', '::ffff:127.0.0.2', '::ffff:10.0.0.1', '10.0.0.1', '0.0.0.0', '::', '::2', '127.0.0.1.evil.com', '[::1]', '0:0:0:0:0:0:0:1x', '192.168.1.1']) {
      expect(isLoopbackAddress(a), String(a)).toBe(false);
    }
  });
});

describe('createAuthGate: default policy', () => {
  it('default deny without options in production (NODE_ENV unset), even from loopback', async () => {
    vi.stubEnv('NODE_ENV', '');
    delete process.env.NODE_ENV;
    const gate = createAuthGate();
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '203.0.113.9', undefined]) expect(await gate(req({ remoteAddress: a })), String(a)).toBe(false);
  });

  it('NODE_ENV=staging/production/prod are production too', async () => {
    for (const v of ['staging', 'production', 'prod']) {
      vi.stubEnv('NODE_ENV', v);
      expect(await createAuthGate()(req({ remoteAddress: '127.0.0.1' })), v).toBe(false);
    }
  });

  it('allowLoopbackWithoutAuth defaults to true in development and test only', async () => {
    for (const v of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', v);
      const gate = createAuthGate();
      expect(await gate(req({ remoteAddress: '127.0.0.1' })), v).toBe(true);
      expect(await gate(req({ remoteAddress: '::1' })), v).toBe(true);
      expect(await gate(req({ remoteAddress: '::ffff:127.0.0.1' })), v).toBe(true);
      expect(await gate(req({ remoteAddress: '203.0.113.9' })), v).toBe(false);
      expect(await gate(req({ remoteAddress: undefined })), v).toBe(false);
    }
  });

  it('the default is read when the gate is created; an explicit false wins even in dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await createAuthGate({ allowLoopbackWithoutAuth: false })(req({ remoteAddress: '127.0.0.1' }))).toBe(false);
  });

  it('an explicit true works in production for loopback only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const gate = createAuthGate({ allowLoopbackWithoutAuth: true });
    expect(await gate(req({ remoteAddress: '127.0.0.1' }))).toBe(true);
    expect(await gate(req({ remoteAddress: '10.1.2.3' }))).toBe(false);
  });
});

describe('createAuthGate: peer address only (X-Forwarded-For and friends are ignored)', () => {
  it('a spoofed X-Forwarded-For / Forwarded / X-Real-IP from a remote peer does not open the gate', async () => {
    const gate = createAuthGate({ allowLoopbackWithoutAuth: true });
    const headers = { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-forwarded-host': 'localhost', host: 'localhost' };
    expect(await gate(req({ remoteAddress: '198.51.100.7', headers }))).toBe(false);
  });

  it('a loopback peer is not denied by forwarded headers either (the header is not consulted in either direction)', async () => {
    const gate = createAuthGate({ allowLoopbackWithoutAuth: true });
    expect(await gate(req({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }))).toBe(true);
  });

  it('the authorize hook decides alone: loopback does not bypass it', async () => {
    const authorize = vi.fn(() => false);
    const gate = createAuthGate({ authorize, allowLoopbackWithoutAuth: true });
    expect(await gate(req({ remoteAddress: '127.0.0.1' }))).toBe(false);
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

describe('createAuthGate: authorize hook', () => {
  it('receives the adapter-neutral request unchanged (method, path, headers, remoteAddress, raw, adapter)', async () => {
    const seen: TraceletAuthRequest[] = [];
    const gate = createAuthGate({ authorize: r => { seen.push(r); return true; }, allowLoopbackWithoutAuth: false });
    const raw = { marker: 1 };
    const r = req({ method: 'HEAD', path: '/api/v1/traces', headers: { cookie: 'a=b' }, remoteAddress: '10.0.0.5', raw, adapter: 'fastify' });
    expect(await gate(r)).toBe(true);
    expect(seen[0]).toBe(r);
    expect(seen[0].raw).toBe(raw);
  });

  it('only the boolean true allows (true, Promise<true>); truthy non-booleans do not', async () => {
    const mk = (v: unknown) => createAuthGate({ authorize: (() => v) as never, allowLoopbackWithoutAuth: false });
    expect(await mk(true)(req())).toBe(true);
    expect(await mk(Promise.resolve(true))(req())).toBe(true);
    for (const v of [false, undefined, null, 1, 'true', {}, Promise.resolve(1), Promise.resolve(undefined)]) expect(await mk(v)(req()), String(v)).toBe(false);
  });

  it('a synchronous throw, a rejection and a non-Error throw deny; the exception text is never logged or returned', async () => {
    const { lines, diagnostics } = quiet();
    const secretError = new Error('db password hunter2');
    for (const authorize of [
      () => { throw secretError; },
      () => Promise.reject(secretError),
      () => { throw 'hunter2'; },
    ]) {
      const gate = createAuthGate({ authorize: authorize as never, allowLoopbackWithoutAuth: true, diagnostics });
      await expect(gate(req({ remoteAddress: '127.0.0.1' }))).resolves.toBe(false);
    }
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(lines.length).toBeGreaterThan(0); // one rate-limited constant diagnostic
  });

  it('a hook that never answers is denied after the timeout (no hanging request, no leaked timer)', async () => {
    vi.useFakeTimers();
    const { lines, diagnostics } = quiet();
    const gate = createAuthGate({ authorize: () => new Promise<boolean>(() => {}), allowLoopbackWithoutAuth: true, authorizeTimeoutMs: 2000, diagnostics });
    const p = gate(req({ remoteAddress: '127.0.0.1' }));
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBe(false);
    expect(lines.join()).toContain('did not answer in time');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fast hook clears its timeout timer', async () => {
    vi.useFakeTimers();
    const gate = createAuthGate({ authorize: () => true, allowLoopbackWithoutAuth: false });
    await expect(gate(req())).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the gate itself never rejects', async () => {
    const gate = createAuthGate({ authorize: () => { throw new Error('x'); }, diagnostics: quiet().diagnostics });
    await expect(gate(undefined as never)).resolves.toBe(false);
  });
});
