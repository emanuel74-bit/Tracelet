import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createConnection, createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { Tracelet } from '../../../src/tracelet.js';
import { TraceletLifecycle } from '../../../src/tracelet.module.js';
import { TEST_OPTIONS, testTraceletModule } from '../../support/module/nest-app.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

const newLog = (): FakeStorageLog => ({ events: [], created: 0, connected: true });

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  resetRuntimeForTesting();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetRuntimeForTesting();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Resolves true when something accepts a connection on the port, false on ECONNREFUSED. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection({ port, host: '127.0.0.1' });
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

describe('Tracelet.listen racing application shutdown (M2)', () => {
  it('deterministic: both shutdown hooks run while listen is pending -> listen rejects, the port is closed, no server is tracked', async () => {
    const lifecycle = new TraceletLifecycle({ enabled: true, serviceName: 'race', storage: { uri: 'mongodb://127.0.0.1:1' } }, { env: { NODE_ENV: 'test' } });
    // isolated active-state seam (no storage / instrumentation), as in the Stage 08 reproduction
    (lifecycle as unknown as { _state: string })._state = 'active';
    const port = await freePort();
    const listening = Tracelet.listen({ port, authorize: () => true }, { get: () => lifecycle } as never);
    const settled = listening.then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e }),
    );
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.e.message).toMatch(/shut down while the listener was starting/);
    expect(await accepts(port)).toBe(false);
    expect((lifecycle as unknown as { servers: Set<unknown> }).servers.size).toBe(0);
  });

  it('trackServer() after shutdown closes the late server immediately and reports it was not tracked', async () => {
    const lifecycle = new TraceletLifecycle({ enabled: true, serviceName: 'race', storage: { uri: 'mongodb://127.0.0.1:1' } }, { env: { NODE_ENV: 'test' } });
    (lifecycle as unknown as { _state: string })._state = 'active';
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    const close = vi.fn(async () => undefined);
    expect(lifecycle.trackServer({ close } as never)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect((lifecycle as unknown as { servers: Set<unknown> }).servers.size).toBe(0);
  });

  it('full Nest app: listen() not awaited while app.close() runs concurrently -> the port is not listening afterwards', async () => {
    @Module({ imports: [testTraceletModule(TEST_OPTIONS, newLog())] })
    class Worker {}
    const app = await NestFactory.createApplicationContext(Worker, { logger: false });
    await app.init();
    const port = await freePort();
    const listening = Tracelet.listen({ port, authorize: () => true }, app).then(
      (s) => s,
      (e: Error) => e,
    );
    const closing = app.close();
    const [outcome] = await Promise.all([listening, closing]);
    // either the listener finished first and was closed by the hooks, or it was rejected: never left listening
    if (outcome instanceof Error) expect(outcome.message).toMatch(/shut down while the listener was starting|shutting down/);
    else expect(outcome?.server.listening).toBe(false);
    expect(await accepts(port)).toBe(false);
  });

  it('normal listen then close still serves, then closes the port', async () => {
    @Module({ imports: [testTraceletModule(TEST_OPTIONS, newLog())] })
    class Worker {}
    const app = await NestFactory.createApplicationContext(Worker, { logger: false });
    await app.init();
    const port = await freePort();
    const server = (await Tracelet.listen({ port, authorize: () => true }, app))!;
    expect(server.server.listening).toBe(true);
    expect(await accepts(port)).toBe(true);
    await app.close();
    expect(server.server.listening).toBe(false);
    expect(await accepts(port)).toBe(false);
  });
});
