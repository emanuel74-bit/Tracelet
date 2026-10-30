import { describe, expect, it, vi } from 'vitest';
import type { TraceItem } from '../../../src/contracts/tracelet-internal-contracts';
import { MongoTelemetryStore } from '../../../src/storage/documents';
import { ensureTelemetryIndexes } from '../../../src/storage/indexes';
import type { MongoCollection, TelemetryCollections } from '../../../src/storage/collections';

function collections(): TelemetryCollections {
  const collection = (): MongoCollection => ({ insertMany: vi.fn().mockResolvedValue({}), replaceOne: vi.fn().mockResolvedValue({}), createIndex: vi.fn().mockResolvedValue('index') }) as unknown as MongoCollection;
  return { traces: collection(), spans: collection(), profiles: collection(), operations: collection(), methods: collection(), metrics: collection(), instances: collection() };
}
function trace(): TraceItem {
  return { type: 'trace', estimatedBytes: 1000, trace: { schemaVersion: 1, traceId: 'trace-0001', serviceName: 'worker', instanceId: 'pod-a', operation: 'job', kind: 'custom', startedAt: '2026-10-29T12:00:00.000Z', durationMs: 20, status: 'ok', spanCount: 1, errorCount: 0, isComplete: true, rootSpanId: 'root-0001' }, spans: [{ traceId: 'trace-0001', spanId: 'root-0001', parentSpanId: null, operation: 'job', startOffsetMs: 0, durationMs: 20, status: 'ok' }] };
}
describe('Mongo persistence contract', () => {
  it('rejects own prototype-named unknown fields at the root and inside errors before writes', async () => {
    const c = collections(); const store = new MongoTelemetryStore(c, { retentionMs: 1000, maxSpansPerTrace: 10 });
    for (const key of ['constructor', 'toString', '__proto__']) {
      const root = trace();
      Object.assign(root.trace, JSON.parse(`{"${key}":{"password":"secret"}}`));
      await expect(store.write(root)).rejects.toThrow('invalid telemetry');
      const nested = trace();
      nested.trace.error = JSON.parse(`{"name":"Error","${key}":{"password":"secret"}}`);
      nested.trace.errorFingerprint = '0123456789abcdef';
      await expect(store.write(nested)).rejects.toThrow('invalid telemetry');
    }
    expect(c.traces.insertMany).not.toHaveBeenCalled();
  });
  it('uses immutable natural keys, event-time TTL, BSON dates and denormalized span identity', async () => {
    const c = collections(); const store = new MongoTelemetryStore(c, { retentionMs: 3600000, maxSpansPerTrace: 5000 });
    const item = trace(); await store.write(item);
    expect(c.traces.insertMany).toHaveBeenCalledWith([expect.objectContaining({ _id: 'trace-0001', startedAt: new Date(item.trace.startedAt), expireAt: new Date('2026-10-29T13:00:00.000Z') })], { ordered: false });
    expect(c.spans.insertMany).toHaveBeenCalledWith([expect.objectContaining({ _id: 'root-0001', schemaVersion: 1, serviceName: 'worker', instanceId: 'pod-a', startedAt: new Date(item.trace.startedAt) })], { ordered: false });
    expect(item.trace.startedAt).toBe('2026-10-29T12:00:00.000Z');
  });
  it('continues partial trace retries past duplicate trace ids but propagates mixed write errors', async () => {
    const c = collections(); const store = new MongoTelemetryStore(c, { retentionMs: 1000, maxSpansPerTrace: 10 });
    vi.mocked(c.traces.insertMany).mockRejectedValueOnce({ code: 11000, writeErrors: [{ code: 11000 }] });
    await store.write(trace()); expect(c.spans.insertMany).toHaveBeenCalledTimes(1);
    vi.mocked(c.traces.insertMany).mockRejectedValueOnce({ code: 11000, writeErrors: [{ code: 11000 }, { code: 121 }] });
    await expect(store.write(trace())).rejects.toMatchObject({ code: 11000 });
    expect(store.storageHealth()).toMatchObject({ connected: false, lastFlushErrorCode: 'STORAGE_UNAVAILABLE' });
  });
  it('rejects extra sensitive fields, malformed hierarchy and new schema versions before writing', async () => {
    const c = collections(); const store = new MongoTelemetryStore(c, { retentionMs: 1000, maxSpansPerTrace: 10 });
    const payload = trace(); Object.assign(payload.trace, { payload: { password: 'secret' } });
    await expect(store.write(payload)).rejects.toThrow('invalid telemetry');
    const wrongVersion = trace(); Object.assign(wrongVersion.trace, { schemaVersion: 2 });
    await expect(store.write(wrongVersion)).rejects.toThrow('invalid telemetry');
    const wrongTrace = trace(); wrongTrace.spans[0]!.traceId = 'other-0001';
    await expect(store.write(wrongTrace)).rejects.toThrow();
    const impossibleDate = trace(); impossibleDate.trace.startedAt = '2026-02-30T12:00:00.000Z';
    await expect(store.write(impossibleDate)).rejects.toThrow();
    expect(c.traces.insertMany).not.toHaveBeenCalled();
  });
  it('creates exactly the frozen indexes and single-field TTLs', async () => {
    const c = collections(); await ensureTelemetryIndexes(c);
    expect(vi.mocked(c.traces.createIndex).mock.calls).toHaveLength(6);
    expect(c.traces.createIndex).toHaveBeenCalledWith({ serviceName: 1, operation: 1, startedAt: -1, _id: -1 });
    for (const value of Object.values(c)) expect(value.createIndex).toHaveBeenCalledWith({ expireAt: 1 }, { expireAfterSeconds: 0 });
    expect(Object.values(c).reduce((n, v) => n + vi.mocked(v.createIndex).mock.calls.length, 0)).toBe(22);
  });
});
