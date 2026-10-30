import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { Tracelet } from '../../../src/tracelet.js';
import { HostController } from '../../support/http/apps.js';
import { httpRequest } from '../../support/http/http.js';
import { bootApp, TEST_OPTIONS, testTraceletModule } from '../../support/module/nest-app.js';
import type { BootedApp } from '../../support/module/nest-app.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

/*
 * The production default on the REAL Tracelet.setup / Tracelet.listen path: NODE_ENV unset (= production), 'production' and
 * 'staging', NO authorize and NO allowLoopbackWithoutAuth. A loopback request must get 403 on html, asset, SPA route and API.
 * (Tracelet is enabled explicitly via the module option; the HTTP gate is what is under test.)
 */

const manifest = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'assets', 'dashboard', 'asset-manifest.json'), 'utf8')) as { files: Record<string, unknown> };
const asset = Object.keys(manifest.files).find(n => n.startsWith('assets/') && n.endsWith('.js'))!;
const PATHS = ['/observe/', '/observe/index.html', `/observe/${asset}`, '/observe/traces/abc', '/observe/api/v1/health', '/observe/api/v1/traces?limit=1', '/observe'];

function hostModule(tracelet: DynamicModule): new () => unknown {
  @Module({ imports: [tracelet], controllers: [HostController] })
  class AppModule {}
  return AppModule;
}
const newLog = (): FakeStorageLog => ({ events: [], created: 0, connected: true });

const original = process.env.NODE_ENV;
function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
}

for (const nodeEnv of [undefined, 'production', 'staging']) {
  describe(`production default with NODE_ENV=${nodeEnv ?? '(unset)'}`, () => {
    let booted: BootedApp | undefined;
    beforeEach(() => {
      setEnv(nodeEnv);
      resetRuntimeForTesting();
    });
    afterEach(async () => {
      await booted?.close();
      booted = undefined;
      setEnv(original);
      resetRuntimeForTesting();
    });

    for (const adapter of ['express', 'fastify'] as const) {
      it(`${adapter}: Tracelet.setup() without auth options denies loopback on html, asset, SPA route and API; host routes unaffected`, async () => {
        const log = newLog();
        booted = await bootApp({ adapter, module: hostModule(testTraceletModule({ ...TEST_OPTIONS, enabled: true }, log)), log, setup: {} });
        for (const path of PATHS) {
          for (const method of ['GET', 'HEAD']) {
            const r = await httpRequest({ port: booted.port, method, path });
            expect(r.status, `${method} ${path}`).toBe(403);
          }
        }
        expect((await httpRequest({ port: booted.port, path: '/hello' })).status).toBe(200);
      });
    }

    it('Tracelet.listen() without auth options denies loopback on html, asset, SPA route and API', async () => {
      const log = newLog();
      @Module({ imports: [testTraceletModule({ ...TEST_OPTIONS, enabled: true }, log)] })
      class Worker {}
      const ctx = await NestFactory.createApplicationContext(Worker, { logger: false });
      await ctx.init();
      const server = (await Tracelet.listen({ port: 0 }))!;
      for (const path of PATHS) expect((await httpRequest({ port: server.port, path })).status, path).toBe(403);
      await ctx.close();
    });
  });
}
