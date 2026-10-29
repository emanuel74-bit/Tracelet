import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue, RollupAccumulator, ROLLUP_FLUSH_INTERVAL_MS } from '../../../src/buffer/index.js';
import type { MetricItem, RollupItem, TelemetryCounters, TelemetryItem, TraceItem } from '../../../src/contracts/index.js';

/* Plan 17 T11 (queue part), R9: long outage with an injected clock and flush seam. */

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // minute aligned
const zero = (): TelemetryCounters => ({
  rootsStarted: 0,
  rootsSampledOut: 0,
  tracesDroppedAdmission: 0,
  tracesDroppedQueueFull: 0,
  tracesDroppedStorage: 0,
  spansDropped: 0,
  profilesDropped: 0,
  rollupsDropped: 0,
});
const metric = (telemetry: Partial<TelemetryCounters>, bytes = 1500): MetricItem => ({
  type: 'metric',
  metric: { telemetry: { ...zero(), ...telemetry }, instanceId: 'i' } as never,
  estimatedBytes: bytes,
});
const trace = (bytes: number): TraceItem => ({ type: 'trace', trace: {} as never, spans: [], estimatedBytes: bytes });

describe('control pool during a long storage outage (R9, T11)', () => {
  it('64+ flush intervals, 3+ bucket minutes, metrics throughout: bounded, one rollup per bucket, counters preserved', () => {
    let clock = T0;
    const queue = new BoundedTelemetryQueue();
    const acc = new RollupAccumulator({
      serviceName: 'svc',
      instanceId: 'inst',
      now: () => clock,
      offer: (item) => queue.offer(item),
      defer: () => {}, // the explicit flush() below is the seam; no timers in this test
    });
    const INTERVALS = 100; // > 64, 100 * 10 s = 1000 s = 16.7 minutes (> 3 bucket minutes)
    const expected = new Map<number, Map<string, number>>(); // bucket -> operation -> count
    let offeredMetrics = 0;
    let maxDepth = 0;
    let maxBytes = 0;
    let spansDroppedOffered = 0;

    for (let i = 0; i < INTERVALS; i++) {
      clock = T0 + i * ROLLUP_FLUSH_INTERVAL_MS;
      const bucket = Math.floor(clock / MINUTE) * MINUTE;
      const perBucket = expected.get(bucket) ?? new Map<string, number>();
      expected.set(bucket, perBucket);
      for (const op of i % 2 === 0 ? ['op-a', 'op-b'] : ['op-a']) {
        acc.recordRoot({ name: op, kind: 'rabbitmq', sampled: true, status: 'ok', durationMs: 5 + i });
        perBucket.set(op, (perBucket.get(op) ?? 0) + 1);
      }
      // a metrics item arrives every interval, carrying counter deltas
      expect(queue.offer(metric({ spansDropped: 1, rootsStarted: 3 }))).toBe(true);
      offeredMetrics += 1;
      spansDroppedOffered += 1;
      acc.flush();
      maxDepth = Math.max(maxDepth, queue.depth('control'));
      maxBytes = Math.max(maxBytes, queue.estimatedBytes('control'));
      expect(queue.depth('control')).toBeLessThanOrEqual(64);
      expect(queue.estimatedBytes('control')).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    // close the final bucket: advance to the next minute and flush
    clock = T0 + INTERVALS * ROLLUP_FLUSH_INTERVAL_MS + MINUTE;
    acc.flush();

    expect(maxDepth).toBeLessThanOrEqual(64);
    expect(maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

    const drained = queue.drain(10_000, Number.MAX_SAFE_INTEGER);
    const rollups = drained.filter((i): i is RollupItem => i.type === 'rollup');
    const metrics = drained.filter((i): i is MetricItem => i.type === 'metric');

    // at most one RollupItem per bucket (coalesced), and the stored aggregates equal the accumulator's final ones
    const byBucket = new Map<string, RollupItem[]>();
    for (const r of rollups) {
      const key = r.operations[0].bucketStart;
      byBucket.set(key, [...(byBucket.get(key) ?? []), r]);
    }
    for (const list of byBucket.values()) expect(list).toHaveLength(1);
    expect(byBucket.size).toBe(expected.size);
    for (const [bucket, ops] of expected) {
      const item = byBucket.get(new Date(bucket).toISOString())![0];
      for (const [op, count] of ops) {
        expect(item.operations.find((o) => o.operation === op)?.count).toBe(count);
      }
      // each item is one bucket minute only
      expect(new Set(item.operations.map((o) => o.bucketStart)).size).toBe(1);
    }

    // evictions were oldest-metrics-first: every rollup survived, metrics fill the rest of the 64 slots
    expect(metrics.length).toBe(64 - rollups.length);
    const evictions = offeredMetrics - metrics.length;
    expect(evictions).toBeGreaterThan(0);
    expect(queue.counters().rollupsDropped).toBe(evictions);

    // counter preservation: evicted deltas were folded into the newest queued metric
    const sum = (name: keyof TelemetryCounters): number => metrics.reduce((n, m) => n + m.metric.telemetry[name], 0);
    expect(sum('spansDropped')).toBe(spansDroppedOffered);
    expect(sum('rootsStarted')).toBe(3 * offeredMetrics);
  });

  it('under byte pressure rollups are evicted oldest first; the newest closing bucket always survives', () => {
    let clock = T0;
    const queue = new BoundedTelemetryQueue({ maxQueuedControlBytes: 400_000 });
    const acc = new RollupAccumulator({
      serviceName: 'svc',
      instanceId: 'inst',
      now: () => clock,
      offer: (item) => queue.offer(item),
      defer: () => {},
    });
    for (let minute = 0; minute < 8; minute++) {
      clock = T0 + minute * MINUTE;
      for (let n = 0; n < 400; n++) acc.recordRoot({ name: `op-${n}`, kind: 'custom', sampled: true, status: 'ok', durationMs: 1 });
      acc.flush();
      expect(queue.estimatedBytes('control')).toBeLessThanOrEqual(400_000);
    }
    clock = T0 + 8 * MINUTE;
    acc.flush();
    const rollups = queue.drain(100, Number.MAX_SAFE_INTEGER).filter((i): i is RollupItem => i.type === 'rollup');
    expect(rollups.length).toBeGreaterThan(0);
    expect(rollups.length).toBeLessThan(8);
    const starts = rollups.map((r) => r.operations[0].bucketStart);
    expect(starts).toEqual([...starts].sort()); // FIFO
    expect(starts[starts.length - 1]).toBe(new Date(T0 + 7 * MINUTE).toISOString()); // newest bucket survived
    expect(rollups[rollups.length - 1].operations).toHaveLength(400);
    expect(queue.counters().rollupsDropped).toBeGreaterThan(0);
  });
});

describe('a trace flood does not crowd out control items; batches obey maxBatchBytes', () => {
  it('zero control-pool drops while the trace pool is full and dropping', () => {
    const queue = new BoundedTelemetryQueue({ maxQueuedTraces: 100 });
    const acc = new RollupAccumulator({ serviceName: 's', instanceId: 'i', offer: (i) => queue.offer(i) });
    for (let i = 0; i < 20_000; i++) queue.offer(trace(2000));
    expect(queue.depth('trace')).toBe(100);
    expect(queue.counters().tracesDroppedQueueFull).toBe(19_900);

    acc.recordRoot({ name: 'x', kind: 'custom', sampled: true, status: 'ok', durationMs: 2 });
    expect(acc.flush()).toBe(1);
    for (let i = 0; i < 10; i++) expect(queue.offer(metric({ rootsStarted: 1 }))).toBe(true);
    for (let i = 0; i < 5_000; i++) queue.offer(trace(2000)); // more flood afterwards
    expect(queue.depth('control')).toBe(11);
    expect(queue.counters().rollupsDropped).toBe(0);
  });

  it('every drained batch is within maxItems and maxBatchBytes; an oversize head is dropped and counted', () => {
    const queue = new BoundedTelemetryQueue();
    const maxBatchBytes = 4 * 1024 * 1024;
    for (let i = 0; i < 1500; i++) queue.offer(trace(3000 + (i % 7) * 100_000));
    queue.offer({ type: 'rollup', operations: [], methods: [], estimatedBytes: 10 } as RollupItem);
    let total = 0;
    let batches = 0;
    for (;;) {
      const batch: TelemetryItem[] = queue.drain(200, maxBatchBytes);
      if (batch.length === 0) break;
      batches += 1;
      total += batch.length;
      expect(batch.length).toBeLessThanOrEqual(200);
      expect(batch.reduce((n, i) => n + i.estimatedBytes, 0)).toBeLessThanOrEqual(maxBatchBytes);
    }
    expect(batches).toBeGreaterThan(1);
    expect(total).toBeGreaterThan(0);
    expect(queue.depth()).toBe(0);
    // an item larger than a whole batch is dropped (counted), never wedging the queue
    const before = queue.counters().tracesDroppedStorage;
    queue.offer(trace(maxBatchBytes + 1));
    queue.offer(trace(10));
    const batch = queue.drain(200, maxBatchBytes);
    expect(batch).toHaveLength(1);
    expect(queue.counters().tracesDroppedStorage).toBe(before + 1);
  });
});
