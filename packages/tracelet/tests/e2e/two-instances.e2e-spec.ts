import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDist, compileFixture, expectedAcks, getJson, sleep, startWorkerProc, until } from '../support/e2e/harness.js';
import type { WorkerProc } from '../support/e2e/harness.js';
import { acquireMongo, NOT_RUN } from '../support/e2e/mongo.js';
import type { DisposableMongo } from '../support/e2e/mongo.js';

/*
 * T12 (two OS processes, ONE Mongo), T11/T17 at e2e level.
 *
 * Every worker is a separate OS process: examples/nest-worker (raw amqplib-style consumer on the in-process fake channel inside a
 * Nest application context with TraceletModule + Tracelet.listen) compiled with tsc and running against the BUILT package
 * (packages/tracelet/dist through the workspace link). Tests marked "REAL MONGO" need a disposable mongod and are reported NOT RUN
 * otherwise (they never connect to anything unless TRACELET_E2E_MONGO=memory or TRACELET_E2E_MONGO_URI is set).
 */

const MESSAGES = 15;
let fixture: ReturnType<typeof compileFixture>;
let mongo: DisposableMongo | undefined;
const procs: WorkerProc[] = [];
const dbName = `tracelet_e2e_${process.pid}_${Date.now()}`;

beforeAll(async () => {
  buildDist();
  fixture = compileFixture();
  mongo = await acquireMongo();
}, 240_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  fixture?.cleanup();
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

const start = async (env: Record<string, string>): Promise<WorkerProc> => {
  const p = await startWorkerProc(fixture.script, env);
  procs.push(p);
  return p;
};

describe('T12 [REAL MONGO] two OS processes share one Mongo', () => {
  it('both instanceIds appear in /instances and /traces, queryable from EITHER process; shutdown flushes', async ctx => {
    if (!mongo) return ctx.skip(NOT_RUN);
    const common = { SERVICE_NAME: 'e2e-orders', TRACELET_STORAGE_URI: mongo.uri, TRACELET_DB: dbName, DEMO_MESSAGES: String(MESSAGES), DEMO_INTERVAL_MS: '20' };
    const [a, b] = await Promise.all([start(common), start(common)]);
    expect(a.ready.state).toBe('active');
    expect(a.ready.instanceId).not.toBe(b.ready.instanceId);
    const ids = [a.ready.instanceId!, b.ready.instanceId!].sort();

    const [da, db] = await Promise.all([a.waitFor('drained'), b.waitFor('drained')]);
    // business result identical in both processes
    expect([...da.acks!].sort()).toEqual(expectedAcks(MESSAGES).sort());
    expect([...db.acks!].sort()).toEqual(expectedAcks(MESSAGES).sort());

    // queryable from EITHER process: /instances (heartbeats) and /traces (flushed batches)
    for (const viewer of [a, b]) {
      const instances = await until(async () => {
        const r = await getJson(viewer.ready.port!, '/observe/api/v1/instances?service=e2e-orders');
        const found = (r.body.items ?? []).map((i: any) => i.instanceId).sort();
        return JSON.stringify(found) === JSON.stringify(ids) ? r.body : undefined;
      }, 70_000, 'both instances in /instances');
      expect(instances.items.every((i: any) => i.isLive === true && i.serviceName === 'e2e-orders')).toBe(true);

      const traces = await until(async () => {
        const r = await getJson(viewer.ready.port!, '/observe/api/v1/traces?service=e2e-orders&limit=100');
        const seen = new Set((r.body.items ?? []).map((t: any) => t.instanceId));
        return r.status === 200 && seen.size === 2 && r.body.items.length >= 2 * MESSAGES ? r.body : undefined;
      }, 40_000, 'traces of both instances');
      const perInstance = new Map<string, number>();
      for (const t of traces.items) perInstance.set(t.instanceId, (perInstance.get(t.instanceId) ?? 0) + 1);
      expect([...perInstance.keys()].sort()).toEqual(ids);
      expect([...perInstance.values()]).toEqual([MESSAGES, MESSAGES]);
      expect(traces.items.every((t: any) => t.operation === 'rabbitmq.consume' && t.kind === 'rabbitmq')).toBe(true);
      // filter by instance works across processes, and one detail view has the provider span chain
      const only = await getJson(viewer.ready.port!, `/observe/api/v1/traces?service=e2e-orders&instanceId=${ids[0]}&limit=100`);
      expect(only.body.items).toHaveLength(MESSAGES);
      const failed = traces.items.find((t: any) => t.status === 'error');
      expect(failed).toBeDefined();
      const detail = await getJson(viewer.ready.port!, `/observe/api/v1/traces/${failed.traceId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.spans.map((s: any) => s.operation)).toEqual(expect.arrayContaining(['rabbitmq.consume', 'OrdersService.total', 'PriceRepository.lookup']));
      expect(JSON.stringify(detail.body)).not.toMatch(/s3cr3t/);
      const health = await getJson(viewer.ready.port!, '/observe/api/v1/health');
      expect(health.body.servedBy.instanceId).toBe(viewer.ready.instanceId);
      expect(health.body.servedBy.mongoConnected).toBe(true);
      expect((await getJson(viewer.ready.port!, '/observe/api/v1/services')).body.items[0]).toMatchObject({ serviceName: 'e2e-orders', instanceCount: 2 });
    }

    // graceful shutdown flushes and exits in bounded time (T17 at e2e level)
    const [sa, sb] = await Promise.all([a.shutdown(), b.shutdown()]);
    expect(sa.shutdownMs).toBeLessThan(10_000);
    expect(sb.shutdownMs).toBeLessThan(10_000);
    expect(sa.traceQueueDepth).toBe(0);
    // after both processes are gone the data is still queryable from a fresh process (storage is the source of truth)
    const c = await start({ ...common, DEMO_MESSAGES: '0', SERVICE_NAME: 'e2e-viewer' });
    const after = await until(async () => {
      const r = await getJson(c.ready.port!, '/observe/api/v1/traces?service=e2e-orders&limit=100');
      return r.body.items?.length === 2 * MESSAGES ? r.body : undefined;
    }, 20_000, 'data visible from a third process');
    expect(after.items).toHaveLength(2 * MESSAGES);
    const closed = after.items.filter((t: any) => t.status === 'incomplete');
    expect(closed).toHaveLength(0);
    await c.shutdown();
  });
});

describe('T11/T17 e2e: Mongo down never affects the host', () => {
  const N = 600;

  it('dead Mongo from the start (no mongod needed): acks identical to a Tracelet-disabled run, loss counted, queue bounded, bounded shutdown', async () => {
    const burst = { DEMO_MESSAGES: String(N), DEMO_INTERVAL_MS: '0', MAX_ROOTS_PER_SECOND: '100000', QUEUE_MAX_TRACES: '50', SERVICE_NAME: 'e2e-down' };
    const baseline = await start({ ...burst, TRACELET_DISABLED: '1', TRACELET_STORAGE_URI: 'mongodb://127.0.0.1:1/x' });
    const baseDrained = await baseline.waitFor('drained');
    await baseline.shutdown();

    const down = await start({ ...burst, TRACELET_STORAGE_URI: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=500' });
    expect(down.ready.state).toBe('active');
    const drained = await down.waitFor('drained');
    expect(drained.acks).toEqual(baseDrained.acks); // identical ack/nack log, identical order
    expect([...drained.acks!].sort()).toEqual(expectedAcks(N).sort());
    expect(drained.counters!.rootsStarted).toBe(N);
    expect(drained.traceQueueDepth).toBeLessThanOrEqual(50); // bounded by buffer.maxQueuedTraces
    const t0 = Date.now();
    const stopped = await down.shutdown();
    expect(stopped.shutdownMs).toBeLessThan(15_000);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const c = stopped.counters!;
    const lost = c.tracesDroppedQueueFull + c.tracesDroppedStorage + c.tracesDroppedAdmission;
    expect(c.tracesDroppedQueueFull).toBeGreaterThan(0); // the 50-trace pool overflowed while Mongo was down
    expect(lost).toBe(N); // nothing stored (no Mongo): every trace is accounted for as a counted drop
    expect(stopped.traceQueueDepth).toBe(0);
  });

  it('[REAL MONGO] mongod stopped mid-run: worker keeps processing, acks identical, loss counted, shutdown bounded', async ctx => {
    if (!mongo) return ctx.skip(NOT_RUN);
    if (!mongo.canStop) return ctx.skip('NOT RUN: needs the in-process mongodb-memory-server (TRACELET_E2E_MONGO=memory) so the server can be stopped mid-test');
    const total = 200;
    const w = await start({ SERVICE_NAME: 'e2e-outage', TRACELET_STORAGE_URI: `${mongo.uri}${mongo.uri.includes('?') ? '&' : '?'}serverSelectionTimeoutMS=500`, TRACELET_DB: dbName + '_outage', DEMO_MESSAGES: String(total), DEMO_INTERVAL_MS: '50' });
    const { MongoClient } = await import('mongodb');
    const probe = new MongoClient(mongo.uri);
    await probe.connect();
    const stored = () => probe.db(dbName + '_outage').collection('tracelet_traces').countDocuments();
    await until(async () => ((await stored()) > 3 ? true : undefined), 30_000, 'first traces stored while Mongo is up');
    await probe.close();
    await mongo.stop(); // outage
    const drained = await w.waitFor('drained', 60_000);
    expect(drained.acks).toEqual(expectedAcks(total)); // business outcome unaffected, in order
    const stopped = await w.shutdown();
    expect(stopped.shutdownMs).toBeLessThan(15_000);
    expect(stopped.counters!.rootsStarted).toBe(total);
    const c = stopped.counters!;
    expect(c.tracesDroppedStorage + c.tracesDroppedQueueFull, JSON.stringify(c)).toBeGreaterThan(0);
    mongo = undefined; // stopped; nothing else may use it
    await sleep(0);
  });
});
