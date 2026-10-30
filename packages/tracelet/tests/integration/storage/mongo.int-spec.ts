import { describe, expect, it } from 'vitest';
import type { TraceItem } from '../../../src/contracts/tracelet-internal-contracts';
import { telemetryCollections } from '../../../src/storage/collections';
import { MongoTelemetryStore } from '../../../src/storage/documents';
import { ensureTelemetryIndexes } from '../../../src/storage/indexes';

/** Explicit opt-in: creates/drops only a uniquely named tracelet_storage_test_* database. */
describe.skipIf(!process.env.TRACELET_TEST_MONGO_URI)('real Mongo shared storage', () => {
  it('uses two independent pools, idempotent writes, all TTL indexes and indexed filtered reads', async () => {
    const { MongoClient } = await import('mongodb');
    const uri = process.env.TRACELET_TEST_MONGO_URI!;
    const a = new MongoClient(uri, { appName: 'tracelet-storage-test', maxPoolSize: 1, serverSelectionTimeoutMS: 5000 });
    const b = new MongoClient(uri, { appName: 'tracelet-storage-test', maxPoolSize: 1, serverSelectionTimeoutMS: 5000 });
    const name = `tracelet_storage_test_${process.pid}_${Date.now()}`;
    try {
      await Promise.all([a.connect(), b.connect()]);
      const db = a.db(name); const ac = telemetryCollections(db); const bc = telemetryCollections(b.db(name));
      await ensureTelemetryIndexes(ac);
      const makeTrace = (n: number): TraceItem => ({ type: 'trace', estimatedBytes: 1000,
        trace: { schemaVersion: 1, traceId: `trace-000${n}`, serviceName: 'worker', instanceId: `pod-${n}`, operation: 'job', kind: 'custom', startedAt: '2026-10-29T12:00:00.000Z', durationMs: 20, status: 'ok', spanCount: 1, errorCount: 0, isComplete: true, rootSpanId: `root-000${n}` },
        spans: [{ traceId: `trace-000${n}`, spanId: `root-000${n}`, parentSpanId: null, operation: 'job', startOffsetMs: 0, durationMs: 20, status: 'ok' }],
      });
      const sa = new MongoTelemetryStore(ac, { retentionMs: 365 * 86400000, maxSpansPerTrace: 5000 });
      const sb = new MongoTelemetryStore(bc, { retentionMs: 365 * 86400000, maxSpansPerTrace: 5000 });
      await Promise.all([sa.write(makeTrace(1)), sb.write(makeTrace(2))]); await sa.write(makeTrace(1));
      const rows = await db.collection('tracelet_traces').find({ serviceName: 'worker' }).sort({ startedAt: -1, _id: -1 }).toArray();
      expect(rows.map(r => r.instanceId).sort()).toEqual(['pod-1', 'pod-2']);
      expect(await db.collection('tracelet_spans').countDocuments()).toBe(2);
      expect(rows[0]!.startedAt).toBeInstanceOf(Date); expect(rows[0]!.expireAt).toBeInstanceOf(Date);
      let indexes = 0;
      for (const suffix of ['traces', 'spans', 'profiles', 'operation_rollups', 'method_rollups', 'metric_rollups', 'instances']) {
        const list = await db.collection(`tracelet_${suffix}`).listIndexes().toArray();
        indexes += list.length - 1;
        expect(list.some(i => JSON.stringify(i.key) === '{"expireAt":1}' && i.expireAfterSeconds === 0)).toBe(true);
      }
      expect(indexes).toBe(22);
      const plan = await db.collection('tracelet_traces').find({ serviceName: 'worker', startedAt: { $gte: new Date('2026-10-29T00:00:00Z'), $lt: new Date('2026-10-30T00:00:00Z') } }).sort({ startedAt: -1, _id: -1 }).limit(10).explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
    } finally { await a.db(name).dropDatabase().catch(() => undefined); await Promise.all([a.close(), b.close()]); }
  });
});
