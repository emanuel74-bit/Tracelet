import { Module } from '@nestjs/common';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { HostController } from '../../support/http/apps.js';
import { httpRequest } from '../../support/http/http.js';
import { bootApp, TEST_OPTIONS, testTraceletModule } from '../../support/module/nest-app.js';
import type { BootedApp } from '../../support/module/nest-app.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

/* Host CORS (registered BEFORE Tracelet.setup) must not make the dashboard / API cross-origin readable. */

function hostModule(tracelet: DynamicModule): new () => unknown {
  @Module({ imports: [tracelet], controllers: [HostController] })
  class AppModule {}
  return AppModule;
}

for (const adapter of ['express', 'fastify'] as const) {
  describe(`CORS headers do not leak onto /observe [${adapter}]`, () => {
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

    it('strips Access-Control-* from 200, 307, 403, 404 and 405 responses while the host route keeps its CORS headers', async () => {
      const log: FakeStorageLog = { events: [], created: 0, connected: true };
      booted = await bootApp({
        adapter,
        module: hostModule(testTraceletModule(TEST_OPTIONS, log)),
        log,
        setup: { authorize: req => req.headers['x-ok'] === '1' },
        beforeSetup: (app: INestApplication) => void app.enableCors({ origin: '*', credentials: false, exposedHeaders: ['X-Leak'] }),
      });
      const origin = { origin: 'https://evil.example' };
      // positive control: CORS really is active on the host route
      const host = await httpRequest({ port: booted.port, path: '/hello', headers: origin });
      expect(host.headers['access-control-allow-origin']).toBeDefined();

      const ok = { ...origin, 'x-ok': '1' };
      const cases: Array<[string, string, Record<string, string>, number]> = [
        ['GET', '/observe/', ok, 200],
        ['GET', '/observe/api/v1/health', ok, 200],
        ['GET', '/observe', ok, 307],
        ['GET', '/observe/missing.js', ok, 404],
        ['GET', '/observe/', origin, 403],
        ['GET', '/observe/api/v1/health', origin, 403],
        ['POST', '/observe/api/v1/health', ok, 405],
      ];
      for (const [method, path, headers, status] of cases) {
        const r = await httpRequest({ port: booted.port, method, path, headers });
        expect(r.status, `${method} ${path}`).toBe(status);
        const leaked = Object.keys(r.headers).filter(h => h.startsWith('access-control-'));
        expect(leaked, `${method} ${path}`).toEqual([]);
      }
    });
  });
}
