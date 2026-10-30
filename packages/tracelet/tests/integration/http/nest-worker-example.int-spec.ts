import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { bearerAuthorize, configFromEnv, startWorker } from '../../../examples/nest-worker/src/worker.js';
import type { WorkerConfig } from '../../../examples/nest-worker/src/worker.js';
import { httpRequest } from '../../support/http/http.js';

/*
 * examples/nest-worker: compiled with its own tsconfig (type-check), then run in-process with the fake channel. TraceletModule talks to
 * a Mongo that is not there (127.0.0.1:1): the worker must behave exactly the same (this is the "Mongo down never affects the host"
 * guarantee at example level).
 */

const PKG = resolve(__dirname, '..', '..', '..');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('examples/nest-worker', () => {
  it('compiles with tsc -p examples/nest-worker/tsconfig.json', () => {
    const out = mkdtempSync(join(tmpdir(), 'tracelet-example-tsc-'));
    try {
      const r = spawnSync(process.execPath, [join(PKG, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'examples', 'nest-worker', 'tsconfig.json'), '--outDir', out], { encoding: 'utf8' });
      expect(r.stdout + r.stderr).toBe('');
      expect(r.status).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  describe('runs against the in-process fake channel', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'test');
      resetRuntimeForTesting();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      resetRuntimeForTesting();
    });

    const config = (over: Partial<WorkerConfig> = {}): WorkerConfig => ({
      ...configFromEnv({}),
      mongoUri: 'mongodb://127.0.0.1:1/obs',
      observePort: 0,
      demoMessages: 10,
      demoIntervalMs: 5,
      ...over,
    });

    it('ack/nack are exactly the business outcome (every 5th message is poisoned) with Mongo unreachable; clean bounded shutdown', async () => {
      const worker = await startWorker(config());
      await worker.drained;
      const expected = Array.from({ length: 10 }, (_, i) => `${i % 5 === 4 ? 'nack' : 'ack'}:m-${i + 1}`);
      expect([...worker.acks].sort()).toEqual([...expected].sort());
      // dashboard is up on loopback (default host 127.0.0.1) and API answers 503 (no Mongo), not a crash
      expect(worker.observe!.host).toBe('127.0.0.1');
      const health = await httpRequest({ port: worker.observe!.port, path: '/observe/api/v1/health' });
      expect([200, 503]).toContain(health.status);
      const t0 = Date.now();
      await worker.stop();
      expect(Date.now() - t0).toBeLessThan(15_000);
    }, 60_000);

    it('bearer authorize: 403 without the token, 200 with it', async () => {
      const worker = await startWorker(config({ demoMessages: 0, observeToken: 'dev-token' }));
      const port = worker.observe!.port;
      expect((await httpRequest({ port, path: '/observe/' })).status).toBe(403);
      expect((await httpRequest({ port, path: '/observe/', headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
      expect((await httpRequest({ port, path: '/observe/', headers: { authorization: 'Bearer dev-token' } })).status).toBe(200);
      expect(bearerAuthorize('x')({ method: 'GET', path: '/', headers: {}, remoteAddress: undefined, raw: {}, adapter: 'node-http' })).toBe(false);
      await worker.stop();
    }, 60_000);

    it('TRACELET_DISABLED=1: the same worker, same acks, nothing mounted', async () => {
      vi.stubEnv('TRACELET_DISABLED', '1');
      const worker = await startWorker(config({ demoMessages: 5 }));
      await worker.drained;
      await sleep(10);
      expect(worker.observe).toBeUndefined();
      expect([...worker.acks].sort()).toEqual(['ack:m-1', 'ack:m-2', 'ack:m-3', 'ack:m-4', 'nack:m-5']);
      await worker.stop();
    }, 60_000);
  });
});
