import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { MongoClient } from 'mongodb';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { InstanceHeartbeat } from '../../../src/contracts/observe-contracts';
import type { TraceItem } from '../../../src/contracts/tracelet-internal-contracts';
import { createInstanceIdentity } from '../../../src/shared/index.js';
import { createStorage } from '../../../src/storage/index.js';

/*
 * Restricted-user behaviour of the storage facade (fail-open when the Mongo user cannot createIndex).
 *
 * RUN CONDITION: this file runs ONLY with TRACELET_E2E_MONGO=memory (it needs an authenticated mongod it can create roles on).
 * `npm run test:mongo` (tests/support/e2e/with-mongo.mjs) does NOT set that variable (it only exports TRACELET_E2E_MONGO_URI /
 * TRACELET_TEST_MONGO_URI, and an externally supplied URI cannot be used here), so this file is reported as skipped there.
 * Run it explicitly:
 *   TRACELET_E2E_MONGO=memory npx vitest run --config vitest.int.config.mts tests/integration/storage/mongo-permissions.int-spec.ts
 *
 * Findings are printed as "[perm] ..." lines. Guaranteed behaviour asserted: no throw, start() does not block, bounded stop(), no
 * credential in any diagnostic / Logger / console / stdout / stderr output or in the health object, no unhandled rejection. The
 * desired behaviour that the current code does NOT meet (heartbeat + TTL indexes for a user without createIndex) is an `it.fails`
 * KNOWN DEFECT test: when the defect is fixed that test starts failing and must be turned into a normal `it`.
 */
const enabled = process.env.TRACELET_E2E_MONGO === 'memory';
const ROOT = { user: 'rootuser', pwd: 'RootPassw0rd-root' };
const LIMITED = { user: 'noindexuser', pwd: 'NoIndexPassw0rd-limited' };
const FULL = { user: 'fulluser', pwd: 'FullPassw0rd-full' };
const README_ROLE = { user: 'readmeuser', pwd: 'ReadmePassw0rd-readme' };
const SECRETS = [ROOT.pwd, LIMITED.pwd, FULL.pwd, README_ROLE.pwd];
const runId = `${process.pid}_${Date.now()}`;
const createdDbs: string[] = [];
const STOP_BOUND_MS = 2000;

let server: MongoMemoryServer | undefined;
let hostPort = '';
let root: MongoClient | undefined;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

const uriFor = (u: { user: string; pwd: string }) => `mongodb://${u.user}:${u.pwd}@${hostPort}/?authSource=admin`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await probe(); if (v !== undefined) return v; await sleep(100); }
  return undefined;
}

beforeAll(async () => {
  if (!enabled) return;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const { MongoClient } = await import('mongodb');
  server = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1' },
    auth: { enable: true, customRootName: ROOT.user, customRootPwd: ROOT.pwd },
  });
  hostPort = new URL(server.getUri()).host;
  root = new MongoClient(uriFor(ROOT), { serverSelectionTimeoutMS: 5000 });
  await root.connect();
  process.on('unhandledRejection', onUnhandled);
}, 120_000);

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  for (const d of createdDbs) await root?.db(d).dropDatabase().catch(() => undefined);
  await root?.close().catch(() => undefined);
  await server?.stop().catch(() => undefined);
}, 60_000);

function traceItem(id: string, serviceName: string, instanceId: string): TraceItem {
  const now = new Date().toISOString();
  return { type: 'trace', estimatedBytes: 1000,
    trace: { schemaVersion: 1, traceId: `trace-${id}`, serviceName, instanceId, operation: 'job', kind: 'custom', startedAt: now, durationMs: 20, status: 'ok', spanCount: 1, errorCount: 0, isComplete: true, rootSpanId: `root-${id}` },
    spans: [{ traceId: `trace-${id}`, spanId: `root-${id}`, parentSpanId: null, operation: 'job', startOffsetMs: 0, durationMs: 20, status: 'ok' }] };
}

type Privilege = 'dbOwner' | 'no-createIndex' | 'readme-role';

/** Fresh database + user per scenario (the instance identity is process-wide, so databases must not be shared between scenarios). */
async function scenario(base: { user: string; pwd: string }, serviceName: string, privilege: Privilege) {
  const dbName = `tracelet_perm_${serviceName}_${runId}`.replace(/[^A-Za-z0-9_]/g, '_');
  createdDbs.push(dbName);
  const admin = root!.db('admin');
  const user = `${base.user}_${serviceName}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (privilege === 'dbOwner') {
    await admin.command({ createUser: user, pwd: base.pwd, roles: [{ role: 'dbOwner', db: dbName }] });
  } else {
    // 'readme-role': the role from README ("MongoDB privileges") verbatim, only the database name differs.
    // 'no-createIndex': find/insert/update/remove on this database only: NO createIndex, NO createCollection, NO dropIndex.
    const actions = privilege === 'readme-role' ? ['find', 'insert', 'update', 'createIndex'] : ['find', 'insert', 'update', 'remove'];
    await admin.command({ createRole: `role_${user}`, roles: [], privileges: [{ resource: { db: dbName, collection: '' }, actions }] });
    await admin.command({ createUser: user, pwd: base.pwd, roles: [{ role: `role_${user}`, db: 'admin' }] });
  }
  const creds = { user, pwd: base.pwd };
  // capture EVERYTHING that could carry a leak: Nest Logger (all levels), console.*, process.stdout/stderr writes
  const captured: string[] = [];
  const grab = (...args: unknown[]) => { captured.push(args.map((a) => inspect(a, { depth: 5 })).join(' | ')); };
  const spies = [
    ...(['log', 'debug', 'warn', 'error', 'verbose', 'fatal'] as const).map((m) => vi.spyOn(Logger, m).mockImplementation(grab as never)),
    ...(['log', 'info', 'debug', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(grab as never)),
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { grab(chunk); return true; }) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { grab(chunk); return true; }) as never),
  ];
  const identity = createInstanceIdentity({ serviceName });
  const heartbeat = (): InstanceHeartbeat => ({
    schemaVersion: 1, instanceId: identity.instanceId, serviceName, hostName: identity.hostName, pid: identity.pid, bootId: identity.bootId,
    startedAt: identity.startedAt, lastSeenAt: new Date().toISOString(), versions: { node: process.versions.node, tracelet: '0.0.0' },
    tracing: { enabled: true, sampleRate: 1 }, profiler: { state: 'disabled' }, buffer: { queueDepth: 0, droppedTraces: 0, droppedProfiles: 0 }, storage: { connected: false },
  });
  const queue = new BoundedTelemetryQueue();
  let startMs = 0;
  let stopMs = 0;
  let trace: unknown;
  let hb: unknown;
  let indexes: Array<{ expireAfterSeconds?: number }> = [];
  let health: unknown;
  const col = (suffix: string) => root!.db(dbName).collection(`tracelet_${suffix}`);
  try {
    const storage = createStorage(
      { serviceName, storage: { uri: uriFor(creds), database: dbName, serverSelectionTimeoutMS: 5000 }, buffer: { flushIntervalMs: 100, shutdownFlushTimeoutMs: STOP_BOUND_MS, maxRetries: 1 } } as never,
      queue, identity, heartbeat);

    const t0 = Date.now();
    storage.start(); // returns void: a throw here would fail the test
    startMs = Date.now() - t0;
    queue.offer(traceItem(serviceName, serviceName, identity.instanceId));

    trace = await until(async () => (await col('traces').findOne({ serviceName })) ?? undefined, 8000);
    hb = await until(async () => (await col('instances').findOne({ _id: identity.instanceId as never })) ?? undefined, privilege === 'no-createIndex' ? 4000 : 15_000);
    indexes = await col('traces').listIndexes().toArray().catch(() => []);

    const s0 = Date.now();
    await storage.stop();
    stopMs = Date.now() - s0;
    health = storage.health();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const ttlIndexes = indexes.filter((i) => i.expireAfterSeconds !== undefined).length;
  const result = { startMs, traceStored: trace !== undefined, heartbeatStored: hb !== undefined, indexCount: indexes.length, ttlIndexes, stopMs, counters: queue.counters(), diagnostics: captured, healthJson: JSON.stringify(health) };
  console.log(`[perm] ${creds.user}: ${JSON.stringify({ ...result, diagnostics: undefined, healthJson: undefined })}\n[perm] ${creds.user} diagnostics: ${JSON.stringify(captured)}`);
  return result;
}

describe.skipIf(!enabled)('storage with restricted Mongo users (real mongod, auth enabled)', () => {
  it('control: fully privileged user creates indexes, stores traces and heartbeats', async () => {
    const r = await scenario(FULL, 'perm-full', 'dbOwner');
    expect(r.startMs).toBeLessThan(250);
    expect(r.traceStored).toBe(true);
    expect(r.heartbeatStored).toBe(true);
    expect(r.ttlIndexes).toBeGreaterThanOrEqual(1);
    expect(r.stopMs).toBeLessThanOrEqual(STOP_BOUND_MS + 1500);
    expect(r.diagnostics).toEqual([]);
  });

  // one scenario run shared by the two tests below (each run costs up to ~12 s of polling)
  let noIndexRun: ReturnType<typeof scenario> | undefined;
  const noIndex = () => (noIndexRun ??= scenario(LIMITED, 'perm-noindex', 'no-createIndex'));

  it('user without createIndex: fail-open, start() non-blocking, stop() bounded, no throw, sanitized diagnostic, no credential in any output', async () => {
    const r = await noIndex();
    // guaranteed: start() is synchronous and does not wait for the connection or the index step
    expect(r.startMs).toBeLessThan(250);
    // guaranteed: bounded shutdown
    expect(r.stopMs).toBeLessThanOrEqual(STOP_BOUND_MS + 1500);
    // a diagnostic is emitted ...
    expect(r.diagnostics.length).toBeGreaterThan(0);
    // ... and nothing captured (Logger, console, stdout, stderr; inspected with depth 5) nor the health object carries a credential, URI, host or user name
    const text = r.diagnostics.join('\n');
    for (const secret of [...SECRETS, LIMITED.user, hostPort, 'mongodb://']) {
      expect(text).not.toContain(secret);
      expect(r.healthJson).not.toContain(secret);
    }
    expect(r.healthJson).not.toMatch(/password|user|host/i);
    expect(unhandled).toEqual([]);
  });

  /*
   * KNOWN DEFECT (Codex-owned src/storage/index.ts:32): connect() runs ensureTelemetryIndexes and only then heartbeat.start(); for a user
   * without createIndex that step is rejected on every attempt (even for existing identical indexes), so the instance never appears in the
   * instances view and the TTL indexes are never created (stored data never expires). The DESIRED behaviour is asserted here; it.fails
   * passes while the defect exists and turns red when it is fixed (then convert it to a plain it).
   */
  it.fails('KNOWN DEFECT (Codex-owned src/storage/index.ts:32): a user without createIndex still gets a heartbeat and TTL indexes', async () => {
    const r = await noIndex();
    expect(r.traceStored).toBe(true);
    expect(r.heartbeatStored).toBe(true);
    expect(r.ttlIndexes).toBeGreaterThan(0);
  });

  it('README role verbatim (find, insert, update, createIndex on the database): full function - trace, heartbeat, TTL indexes, clean output', async () => {
    const r = await scenario(README_ROLE, 'perm-readme', 'readme-role');
    expect(r.startMs).toBeLessThan(250);
    expect(r.traceStored).toBe(true);
    expect(r.heartbeatStored).toBe(true);
    expect(r.ttlIndexes).toBeGreaterThanOrEqual(1);
    expect(r.stopMs).toBeLessThanOrEqual(STOP_BOUND_MS + 1500);
    expect(r.diagnostics).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
