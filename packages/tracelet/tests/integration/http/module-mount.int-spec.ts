import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTesting, trace, tracingHealth } from '../../../src/context/index.js';
import { Tracelet } from '../../../src/tracelet.js';
import { TraceletLifecycle } from '../../../src/tracelet.module.js';
import { HostController } from '../../support/http/apps.js';
import { httpRequest } from '../../support/http/http.js';
import { bootApp, TEST_OPTIONS, testTraceletModule } from '../../support/module/nest-app.js';
import type { BootedApp } from '../../support/module/nest-app.js';
import type { DiagLine, FakeStorageLog } from '../../support/module/fakes.js';

/*
 * TraceletModule + Tracelet.setup against real Nest applications on both platform adapters. The REAL QueryService and API
 * handler run over empty in-memory collections (no Mongo); the real-Mongo variants are in tests/e2e.
 */

@Injectable()
class AuthService {
  calls = 0;
  check(): boolean {
    this.calls++;
    return true;
  }
}

function hostModule(tracelet: DynamicModule): new () => unknown {
  @Module({ imports: [tracelet], controllers: [HostController], providers: [AuthService] })
  class AppModule {}
  return AppModule;
}

const newLog = (): FakeStorageLog => ({ events: [], created: 0, connected: true });

for (const adapter of ['express', 'fastify'] as const) {
  describe(`TraceletModule + Tracelet.setup [${adapter}]`, () => {
    let booted: BootedApp | undefined;
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'test');
      resetRuntimeForTesting();
    });
    afterEach(async () => {
      await booted?.close();
      booted = undefined;
      vi.unstubAllEnvs();
      resetRuntimeForTesting();
    });

    it('serves the dashboard and the REAL query API at /observe, host routes are untouched, shutdown flushes in order', async () => {
      const log = newLog();
      booted = await bootApp({ adapter, module: hostModule(testTraceletModule(TEST_OPTIONS, log)), log, setup: { authorize: () => true } });
      const { port } = booted;

      const html = await httpRequest({ port, path: '/observe/' });
      expect(html.status).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.text).toContain('id="tracelet-config"');
      expect((await httpRequest({ port, path: '/observe' })).status).toBe(307);

      const health = await httpRequest({ port, path: '/observe/api/v1/health' });
      expect(health.status).toBe(200);
      const body = JSON.parse(health.text);
      expect(body.servedBy).toMatchObject({ serviceName: 'mount-test', mongoConnected: true });
      expect(typeof body.servedBy.instanceId).toBe('string');
      expect(body.items).toEqual([]);

      expect(JSON.parse((await httpRequest({ port, path: '/observe/api/v1/services' })).text)).toEqual({ items: [] });
      expect((await httpRequest({ port, path: '/observe/api/v1/traces?limit=5' })).status).toBe(200);
      expect((await httpRequest({ port, path: '/observe/api/v1/traces?bogus=1' })).status).toBe(400);
      expect((await httpRequest({ port, method: 'POST', path: '/observe/api/v1/health' })).status).toBe(405);
      expect((await httpRequest({ port, path: '/hello' })).text).toBe('hello from the host app');

      await booted.close();
      booted = undefined;
      expect(log.events).toEqual(['storage.start', 'storage.stop', 'storage.stopped']);
      expect(tracingHealth().enabled).toBe(false);
    });

    it('default-deny without authorize in production-like config; allowed with authorize; loopback rule honoured', async () => {
      const log = newLog();
      booted = await bootApp({ adapter, module: hostModule(testTraceletModule(TEST_OPTIONS, log)), log, setup: { allowLoopbackWithoutAuth: false } });
      expect((await httpRequest({ port: booted.port, path: '/observe/' })).status).toBe(403);
      expect((await httpRequest({ port: booted.port, path: '/observe/api/v1/health' })).status).toBe(403);
      await booted.close();
      booted = undefined;

      resetRuntimeForTesting();
      const log2 = newLog();
      booted = await bootApp({ adapter, module: hostModule(testTraceletModule(TEST_OPTIONS, log2)), log: log2, setup: { authorize: req => req.headers['x-token'] === 'ok' } });
      expect((await httpRequest({ port: booted.port, path: '/observe/api/v1/health' })).status).toBe(403);
      expect((await httpRequest({ port: booted.port, path: '/observe/api/v1/health', headers: { 'x-token': 'ok' } })).status).toBe(200);
    });

    it('custom path + publicBasePath; the Nest global prefix is not applied to the mount', async () => {
      const log = newLog();
      booted = await bootApp({
        adapter,
        module: hostModule(testTraceletModule(TEST_OPTIONS, log)),
        log,
        globalPrefix: 'api',
        setup: { path: '/internal/observe', publicBasePath: '/gateway/observe', authorize: () => true },
      });
      const { port } = booted;
      expect((await httpRequest({ port, path: '/internal/observe/api/v1/health' })).status).toBe(200);
      const redirect = await httpRequest({ port, path: '/internal/observe' });
      expect(redirect.status).toBe(307);
      expect(redirect.headers.location).toBe('/gateway/observe/');
      expect((await httpRequest({ port, path: '/api/internal/observe/api/v1/health' })).status).toBe(404);
      expect((await httpRequest({ port, path: '/observe/' })).status).toBe(404);
      expect((await httpRequest({ port, path: '/api/hello' })).status).toBe(200);
      const html = await httpRequest({ port, path: '/internal/observe/' });
      expect(html.text).toContain('/gateway/observe');
    });

    it('T14 on the real mount: 1000 dashboard/API requests create zero traces; a traced provider call still does', async () => {
      const log = newLog();
      // the authorize hook calls an INSTRUMENTED provider, exactly what a host auth service does
      const ref: { auth?: AuthService } = {};
      booted = await bootApp({
        adapter,
        module: hostModule(testTraceletModule(TEST_OPTIONS, log)),
        log,
        instrument: true,
        setup: { authorize: () => ref.auth!.check() },
      });
      ref.auth = booted.app.get(AuthService);
      expect(tracingHealth()).toMatchObject({ enabled: true, instrumentInstalled: true });
      const paths = ['/observe/', '/observe/index.html', '/observe/api/v1/health', '/observe/api/v1/traces?limit=5', '/observe/api/v1/overview', '/observe/traces/abc', '/observe/assets/missing.js'];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          if (i >= 1000) return;
          await httpRequest({ port: booted!.port, method: i % 17 === 0 ? 'POST' : i % 13 === 0 ? 'HEAD' : 'GET', path: paths[i % paths.length] });
        }
      };
      await Promise.all(Array.from({ length: 24 }, worker));
      expect(ref.auth!.calls).toBeGreaterThan(900);
      await new Promise(r => setTimeout(r, 50));
      expect(log.queue!.depth('trace')).toBe(0);
      expect(log.queue!.counters()).toMatchObject({ rootsStarted: 0, spansDropped: 0, tracesDroppedAdmission: 0 });
      // positive control
      await trace('control.job', async () => ref.auth!.check(), { kind: 'custom' });
      await new Promise(r => setTimeout(r, 50));
      expect(log.queue!.depth('trace')).toBe(1);
    }, 120_000);

    it('TRACELET_DISABLED=1: nothing is mounted, nothing is wired, the host serves normally', async () => {
      vi.stubEnv('TRACELET_DISABLED', '1');
      const log = newLog();
      booted = await bootApp({ adapter, module: hostModule(testTraceletModule(TEST_OPTIONS, log)), log, setup: { authorize: () => true } });
      expect((await httpRequest({ port: booted.port, path: '/observe/' })).status).toBe(404);
      expect((await httpRequest({ port: booted.port, path: '/hello' })).status).toBe(200);
      expect(log.created).toBe(0);
      expect(tracingHealth().enabled).toBe(false);
    });

    it('invalid configuration: the host boots, one diagnostic, nothing mounted', async () => {
      const log = newLog();
      const diag: { lines: DiagLine[] } = { lines: [] };
      booted = await bootApp({ adapter, module: hostModule(testTraceletModule({ ...TEST_OPTIONS, tracing: { sampleRate: 9 } }, log, diag)), log, setup: { authorize: () => true } });
      expect((await httpRequest({ port: booted.port, path: '/observe/' })).status).toBe(404);
      expect((await httpRequest({ port: booted.port, path: '/hello' })).status).toBe(200);
      expect(diag.lines.filter(l => l.level === 'error')).toHaveLength(1);
      expect(tracingHealth().enabled).toBe(false);
    });

    it('setup misuse throws clear errors: after init, TraceletModule not imported', async () => {
      const log = newLog();
      const app = await NestFactory.create(hostModule(testTraceletModule(TEST_OPTIONS, log)), adapter === 'express' ? new (await import('@nestjs/platform-express')).ExpressAdapter() : new (await import('@nestjs/platform-fastify')).FastifyAdapter(), { logger: false });
      await app.init();
      expect(() => Tracelet.setup(app)).toThrow(/already initialised/);
      await app.close();

      @Module({ controllers: [HostController] })
      class Plain {}
      const plain = await NestFactory.create(Plain, adapter === 'express' ? new (await import('@nestjs/platform-express')).ExpressAdapter() : new (await import('@nestjs/platform-fastify')).FastifyAdapter(), { logger: false });
      expect(() => Tracelet.setup(plain)).toThrow(/TraceletModule is not imported/);
      await plain.close();
    });

    it('setup rejects a root or invalid mount path (developer error)', async () => {
      const log = newLog();
      const app = await NestFactory.create(hostModule(testTraceletModule(TEST_OPTIONS, log)), adapter === 'express' ? new (await import('@nestjs/platform-express')).ExpressAdapter() : new (await import('@nestjs/platform-fastify')).FastifyAdapter(), { logger: false });
      expect(() => Tracelet.setup(app, { path: '/' })).toThrow();
      expect(() => Tracelet.setup(app, { path: 'observe' })).toThrow();
      await app.close();
    });
  });
}

describe('Tracelet.setup unsupported adapter / Tracelet.listen', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    resetRuntimeForTesting();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeForTesting();
  });

  it('a non express/fastify adapter is rejected with a pointer to Tracelet.listen()', () => {
    const fake = { isInitialized: false, getHttpAdapter: () => ({ getType: () => 'custom', getInstance: () => ({}) }) };
    expect(() => Tracelet.setup(fake as never)).toThrow(/Tracelet\.listen/);
  });

  it('worker-only: listen() works on an application context WITHOUT an HTTP adapter, 127.0.0.1 by default, closed with the app', async () => {
    const log = newLog();
    @Module({ imports: [testTraceletModule(TEST_OPTIONS, log)] })
    class Worker {}
    const ctx = await NestFactory.createApplicationContext(Worker, { logger: false });
    ctx.enableShutdownHooks();
    await ctx.init();
    const server = (await Tracelet.listen({ port: 0, authorize: () => true }))!;
    expect(server.host).toBe('127.0.0.1');
    const health = await httpRequest({ port: server.port, path: '/observe/api/v1/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text).servedBy.serviceName).toBe('mount-test');
    expect((await httpRequest({ port: server.port, path: '/observe/' })).status).toBe(200);
    await ctx.close();
    await expect(httpRequest({ port: server.port, path: '/observe/' })).rejects.toThrow();
    expect(log.events).toContain('storage.stop');
  });

  it('listen() without authorize on production-like defaults denies; a non-loopback host without authorize is refused', async () => {
    const log = newLog();
    @Module({ imports: [testTraceletModule(TEST_OPTIONS, log)] })
    class Worker {}
    const ctx = await NestFactory.createApplicationContext(Worker, { logger: false });
    await ctx.init();
    await expect(Tracelet.listen({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/authorize/);
    const server = (await Tracelet.listen({ port: 0, allowLoopbackWithoutAuth: false }))!;
    expect((await httpRequest({ port: server.port, path: '/observe/api/v1/health' })).status).toBe(403);
    await ctx.close();
  });

  it("listen() resolves undefined when Tracelet is disabled", async () => {
    vi.stubEnv('TRACELET_DISABLED', '1');
    const log = newLog();
    @Module({ imports: [testTraceletModule(TEST_OPTIONS, log)] })
    class Worker {}
    const ctx = await NestFactory.createApplicationContext(Worker, { logger: false });
    await ctx.init();
    expect(await Tracelet.listen({ port: 0 })).toBeUndefined();
    expect(ctx.get(TraceletLifecycle, { strict: false }).state).toBe('disabled');
    await ctx.close();
  });
});
