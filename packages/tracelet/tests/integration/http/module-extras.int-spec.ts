import { Logger, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { Tracelet } from '../../../src/tracelet.js';
import { TraceletLifecycle, TraceletModule } from '../../../src/tracelet.module.js';
import { HostController } from '../../support/http/apps.js';
import { httpRequest } from '../../support/http/http.js';
import { bootApp, TEST_OPTIONS, testTraceletModule } from '../../support/module/nest-app.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

const newLog = (connected = true): FakeStorageLog => ({ events: [], created: 0, connected });
function hostModule(tracelet: DynamicModule): new () => unknown {
  @Module({ imports: [tracelet], controllers: [HostController] })
  class AppModule {}
  return AppModule;
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  resetRuntimeForTesting();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetRuntimeForTesting();
});

describe('T23 (LEAD half): storage failure on the integrated module', () => {
  it('Mongo reported disconnected: /health says so (200), still zero traces and zero root counters', async () => {
    const log = newLog(false);
    const booted = await bootApp({ adapter: 'express', module: hostModule(testTraceletModule(TEST_OPTIONS, log)), log, instrument: true, setup: { authorize: () => true } });
    try {
      const h = await httpRequest({ port: booted.port, path: '/observe/api/v1/health' });
      expect(h.status).toBe(200);
      expect(JSON.parse(h.text).servedBy.mongoConnected).toBe(false);
      expect(log.queue!.depth('trace')).toBe(0);
      expect(log.queue!.counters().rootsStarted).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it('queries failing in the driver: 503 STORAGE_UNAVAILABLE envelopes without driver text, zero traces, bounded storage calls (no recursion)', async () => {
    let calls = 0;
    const boom = () => {
      calls++;
      throw new Error('MongoServerSelectionError mongodb://admin:hunter2@db.internal:27017 down');
    };
    const bad = { find: boom, findOne: async () => boom(), aggregate: boom, createIndex: async () => 'x' };
    const collections = Object.fromEntries(['traces', 'spans', 'profiles', 'operations', 'methods', 'metrics', 'instances'].map(k => [k, bad]));
    const log = newLog(false);
    const booted = await bootApp({ adapter: 'fastify', module: hostModule(testTraceletModule(TEST_OPTIONS, log, undefined, collections)), log, instrument: true, setup: { authorize: () => true } });
    try {
      // /health degrades by design: 200 with mongoConnected=false and no items (the failure is VISIBLE there)
      const health = await httpRequest({ port: booted.port, path: '/observe/api/v1/health' });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.text)).toMatchObject({ servedBy: { mongoConnected: false }, items: [] });
      for (const path of ['/observe/api/v1/traces?limit=5', '/observe/api/v1/overview', '/observe/api/v1/services', '/observe/api/v1/instances']) {
        const r = await httpRequest({ port: booted.port, path });
        expect(r.status, path).toBe(503);
        expect(JSON.parse(r.text).error.code, path).toBe('STORAGE_UNAVAILABLE');
        expect(r.text).not.toMatch(/hunter2|admin|db\.internal|Mongo/);
      }
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThan(50); // a handful of reads for 5 requests, never a loop
      expect(log.queue!.depth('trace')).toBe(0);
      expect(log.queue!.counters()).toMatchObject({ rootsStarted: 0, spansDropped: 0 });
      expect((await httpRequest({ port: booted.port, path: '/hello' })).status).toBe(200);
    } finally {
      await booted.close();
    }
  });
});

describe('CSP: the real mounted dashboard HTML works under default-src none / script-src self', () => {
  it('has no inline script (other than the JSON data block), no inline style, no style attribute and no event handler', async () => {
    const log = newLog();
    const booted = await bootApp({ adapter: 'express', module: hostModule(testTraceletModule(TEST_OPTIONS, log)), log, setup: { authorize: () => true } });
    try {
      const r = await httpRequest({ port: booted.port, path: '/observe/' });
      expect(r.status).toBe(200);
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      const scripts = [...r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attrs, body] of scripts) {
        if (/\bsrc=/.test(attrs)) expect(body.trim()).toBe('');
        else {
          // the only inline script element is the non-executed JSON data block
          expect(attrs).toMatch(/type="application\/json"/);
          expect(() => JSON.parse(body)).not.toThrow();
        }
      }
      expect(r.text).not.toMatch(/<style\b/i);
      expect(r.text).not.toMatch(/\sstyle\s*=/i);
      expect(r.text).not.toMatch(/\son[a-z]+\s*=/i);
      expect(r.text).not.toMatch(/javascript:/i);
      // every referenced asset is same-origin and relative
      for (const m of r.text.matchAll(/\b(?:src|href)="([^"]+)"/g)) expect(m[1], m[1]).not.toMatch(/^(https?:)?\/\//);
    } finally {
      await booted.close();
    }
  });
});

describe('forRootAsync factory bound (L13)', () => {
  it('a factory that never resolves does not block host boot beyond factoryTimeoutMs: tracing disabled, one sanitized diagnostic', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    @Module({ imports: [TraceletModule.forRootAsync({ factoryTimeoutMs: 150, useFactory: () => new Promise<never>(() => undefined) })], controllers: [HostController] })
    class AppModule {}
    const t0 = Date.now();
    const booted = await bootApp({ adapter: 'express', module: AppModule, setup: { authorize: () => true } });
    try {
      expect(Date.now() - t0).toBeLessThan(5000);
      expect((await httpRequest({ port: booted.port, path: '/hello' })).status).toBe(200);
      expect((await httpRequest({ port: booted.port, path: '/observe/' })).status).toBe(404);
      expect(booted.app.get(TraceletLifecycle, { strict: false }).state).toBe('failed');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls)).toContain('did not resolve within 150 ms');
    } finally {
      await booted.close();
      spy.mockRestore();
    }
  });

  it('a throwing factory keeps only a sanitized message', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    @Module({ imports: [TraceletModule.forRootAsync({ useFactory: () => { throw new Error('vault unreachable at mongodb://svc:topsecret@vault.internal/x'); } })] })
    class AppModule {}
    const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await ctx.init();
    await ctx.close();
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('vault unreachable');
    expect(logged).not.toMatch(/topsecret|svc:|vault\.internal/);
    spy.mockRestore();
  });
});

describe('Tracelet.listen with several applications (L5)', () => {
  const worker = (log: FakeStorageLog, name: string) => {
    @Module({ imports: [testTraceletModule({ ...TEST_OPTIONS, serviceName: name }, log)] })
    class Worker {}
    return Worker;
  };

  it('the app argument selects the right lifecycle; without it the newest live one is used with a warning; closed apps are refused', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const logA = newLog();
    const logB = newLog();
    const a = await NestFactory.createApplicationContext(worker(logA, 'svc-a'), { logger: false });
    const b = await NestFactory.createApplicationContext(worker(logB, 'svc-b'), { logger: false });
    await a.init();
    await b.init();
    const serverA = (await Tracelet.listen({ port: 0, authorize: () => true }, a))!;
    expect(JSON.parse((await httpRequest({ port: serverA.port, path: '/observe/api/v1/health' })).text).servedBy.serviceName).toBe('svc-a');
    const implicit = (await Tracelet.listen({ port: 0, authorize: () => true }))!;
    expect(JSON.parse((await httpRequest({ port: implicit.port, path: '/observe/api/v1/health' })).text).servedBy.serviceName).toBe('svc-b');
    expect(warn.mock.calls.some(c => String(c[0]).includes('Pass the application as the second argument'))).toBe(true);
    await b.close();
    // b is closed: the implicit choice falls back to a (the only live one), and an explicit closed app is refused
    await expect(Tracelet.listen({ port: 0, authorize: () => true }, b)).rejects.toThrow(/shutting down/);
    const fallback = (await Tracelet.listen({ port: 0, authorize: () => true }))!;
    expect(JSON.parse((await httpRequest({ port: fallback.port, path: '/observe/api/v1/health' })).text).servedBy.serviceName).toBe('svc-a');
    await a.close();
    await expect(Tracelet.listen({ port: 0, authorize: () => true })).rejects.toThrow(/already shut down|not imported/);
    warn.mockRestore();
  });

  it('an application without TraceletModule is rejected clearly', async () => {
    @Module({})
    class Plain {}
    const ctx = await NestFactory.createApplicationContext(Plain, { logger: false });
    await expect(Tracelet.listen({ port: 0 }, ctx)).rejects.toThrow(/not imported/);
    await ctx.close();
  });
});

