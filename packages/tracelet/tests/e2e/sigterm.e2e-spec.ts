import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PKG, REPO, buildDist, run, until } from '../support/e2e/harness.js';
import { acquireMongo, NOT_RUN } from '../support/e2e/mongo.js';
import type { DisposableMongo } from '../support/e2e/mongo.js';

/*
 * Real-SIGTERM e2e (OpenShift stops pods with SIGTERM). POSIX only: on Windows SIGTERM is a hard kill, so the suite is skipped there.
 *
 * Documented Nest 11 behaviour (@nestjs/core listenToShutdownSignals): on SIGTERM the handler awaits app.close() (beforeApplicationShutdown +
 * onApplicationShutdown hooks), removes its listeners and then calls process.kill(process.pid, 'SIGTERM'). The child therefore ends
 * "terminated by SIGTERM" (exit code null, signal 'SIGTERM') AFTER the hooks ran; it does not exit with code 0.
 * What Tracelet promises on shutdown (src/tracelet.module.ts onApplicationShutdown): stop new roots, force-close open roots with
 * reason 'shutdown' (so an in-flight trace is persisted, truncated), wait for completions, final bounded flush (shutdownFlushTimeoutMs).
 * It does NOT wait for in-flight business callbacks to finish.
 * Determinism: the fixture paces the storage writer (buffer.maxWriteDocsPerSecond) so traces are still unwritten at SIGTERM, and the in-flight
 * callback sleeps 60 s so it can never finish; the force-close and the shutdown flush are therefore the only ways the data can be persisted.
 */

const EXIT_BOUND_MS = 15_000;
const TRACES = 20;
const dbName = `tracelet_e2e_sigterm_${process.pid}_${Date.now()}`;
let mongo: DisposableMongo | undefined;
let outDir: string | undefined;
let script = '';

beforeAll(async () => {
  if (process.platform === 'win32') return;
  buildDist();
  outDir = mkdtempSync(join(tmpdir(), 'tracelet-e2e-sigterm-'));
  const r = run(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'tests', 'support', 'e2e', 'tsconfig.sigterm.json'), '--outDir', outDir], PKG);
  if (r.status !== 0) throw new Error(`sigterm fixture compile failed:\n${r.out}`);
  script = join(outDir, 'tests', 'support', 'e2e', 'sigterm-fixture.js');
  mongo = await acquireMongo();
}, 240_000);

afterAll(async () => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (mongo) {
    if (mongo.source === 'TRACELET_E2E_MONGO_URI') {
      const { MongoClient } = await import('mongodb');
      const c = new MongoClient(mongo.uri);
      await c.db(dbName).dropDatabase().catch(() => undefined);
      await c.close().catch(() => undefined);
    }
    await mongo.stop().catch(() => undefined);
  }
});

interface Child {
  stderr(): string;
  waitFor(event: string, ms?: number): Promise<Record<string, any>>;
  /** Sends SIGTERM and resolves with how the process ended; SIGKILLs and rejects if it does not end within the bound. */
  terminate(): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
  kill(): void;
}

function start(env: Record<string, string>): Child {
  const child = fork(script, [], {
    env: { ...process.env, NODE_PATH: join(REPO, 'node_modules'), NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: Array<Record<string, any>> = [];
  let err = '';
  child.stderr?.on('data', d => (err += String(d)));
  child.stdout?.on('data', () => undefined);
  child.on('message', m => messages.push(m as Record<string, any>));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => child.once('exit', (code, signal) => res({ code, signal })));
  return {
    stderr: () => err,
    waitFor: (event, ms = 60_000) => until(async () => messages.find(m => m.event === event), ms, `child event "${event}"; stderr: ${err.slice(-800)}`),
    terminate: async () => {
      const t0 = Date.now();
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(res => (timer = setTimeout(() => res('timeout'), EXIT_BOUND_MS)));
      const r = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      if (r === 'timeout') {
        child.kill('SIGKILL');
        throw new Error(`child still alive ${EXIT_BOUND_MS} ms after SIGTERM (SIGKILLed); stderr: ${err.slice(-800)}`);
      }
      return { ...r, ms: Date.now() - t0 };
    },
    kill: () => void child.kill('SIGKILL'),
  };
}

async function countTraces(serviceName: string): Promise<number> {
  const { MongoClient } = await import('mongodb');
  const c = new MongoClient(mongo!.uri);
  try {
    return await c.db(dbName).collection('tracelet_traces').countDocuments({ serviceName });
  } finally {
    await c.close().catch(() => undefined);
  }
}

async function tracesOf(serviceName: string): Promise<any[]> {
  const { MongoClient } = await import('mongodb');
  const c = new MongoClient(mongo!.uri);
  try {
    return await c.db(dbName).collection('tracelet_traces').find({ serviceName }).toArray();
  } finally {
    await c.close().catch(() => undefined);
  }
}

const baseEnv = (serviceName: string): Record<string, string> => ({ SERVICE_NAME: serviceName, TRACELET_STORAGE_URI: mongo!.uri, TRACELET_DB: dbName });
// no noise during shutdown (the Nest logger is limited to error/warn, so any of these means something failed)
const BAD_STDERR = /unhandled|rejection|error|exception|\bat .*\(.*:\d+:\d+\)/i;

describe.skipIf(process.platform === 'win32')('real SIGTERM with enableShutdownHooks [REAL MONGO]', () => {
  it('flushes ALL queued traces at shutdown (not yet written at SIGTERM), exits within the bound, return values unchanged, clean stderr', async ctx => {
    if (!mongo) return ctx.skip(NOT_RUN);
    const service = 'sigterm-flush';
    const child = start({ ...baseEnv(service), SIGTERM_MODE: 'flush', SIGTERM_TRACES: String(TRACES) });
    try {
      await child.waitFor('ready');
      const { values } = await child.waitFor('results');
      expect(values).toEqual(Array.from({ length: TRACES }, (_, i) => ((i + 1) % 5 === 0 ? `nack:m-${i + 1}` : `ack:m-${i + 1}`)));

      // non-vacuous: the writer is paced (>= 125 ms per document, 2 documents per trace), so the 20 traces cannot all be persisted yet
      const before = await countTraces(service);
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(TRACES);

      const ended = await child.terminate();
      // Nest 11: hooks run, then process.kill(pid, 'SIGTERM') -> terminated by the signal, no exit code
      expect(ended.signal).toBe('SIGTERM');
      expect(ended.code).toBeNull();
      expect(ended.ms).toBeLessThan(EXIT_BOUND_MS);

      const docs = await tracesOf(service);
      expect(docs).toHaveLength(TRACES);
      expect(new Set(docs.map(d => d.traceId)).size).toBe(TRACES);
      expect(docs.every(d => d.operation === 'sigterm.flush')).toBe(true);
      expect(child.stderr()).not.toMatch(BAD_STDERR);
    } finally {
      child.kill();
    }
  }, 120_000);

  it('SIGTERM during an in-flight trace (callback sleeps 60 s): exits in bound and the open root is persisted as incomplete by the shutdown force-close', async ctx => {
    if (!mongo) return ctx.skip(NOT_RUN);
    const service = 'sigterm-inflight';
    const child = start({ ...baseEnv(service), SIGTERM_MODE: 'inflight' });
    try {
      await child.waitFor('ready');
      await child.waitFor('inflight-started');
      const ended = await child.terminate(); // the callback is still in its 60 s sleep and can never finish
      expect(ended.signal).toBe('SIGTERM');
      expect(ended.code).toBeNull();
      expect(ended.ms).toBeLessThan(EXIT_BOUND_MS);

      // Guaranteed by the code (onApplicationShutdown -> closeAllOpenRoots('shutdown'), then the final flush; trace-registry forceClose sets
      // status 'incomplete' and isComplete false): exactly one persisted trace for the in-flight root. The callback cannot have finished.
      const docs = await tracesOf(service);
      expect(docs).toHaveLength(1);
      expect(docs[0].operation).toBe('sigterm.inflight');
      expect(docs[0].status).toBe('incomplete');
      expect(docs[0].isComplete).toBe(false);
      expect(child.stderr()).not.toMatch(BAD_STDERR);
    } finally {
      child.kill();
    }
  }, 120_000);
});
