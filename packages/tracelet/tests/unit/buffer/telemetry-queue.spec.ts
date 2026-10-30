import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { MetricItem, ProfileItem, RollupItem, TelemetryCounters, TraceItem } from '../../../src/contracts/index.js';

const trace = (estimatedBytes: number): TraceItem => ({ type: 'trace', trace: {} as never, spans: [], estimatedBytes });
const profile = (estimatedBytes = 100): ProfileItem => ({ type: 'profile', profile: {} as never, estimatedBytes });
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
const metric = (estimatedBytes: number, telemetry: Partial<TelemetryCounters> = {}, tag = 'm'): MetricItem => ({
  type: 'metric',
  metric: { telemetry: { ...zero(), ...telemetry }, instanceId: tag } as never,
  estimatedBytes,
});
const rollup = (bucket: string, estimatedBytes: number, tag = 'r'): RollupItem => ({
  type: 'rollup',
  operations: [{ bucketStart: bucket, operation: tag } as never],
  methods: [],
  estimatedBytes,
});

describe('BoundedTelemetryQueue: caps are bounded', () => {
  it('trace pool: drop-newest at the item cap, counted, never throws', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedTraces: 3 });
    const accepted = [1, 2, 3, 4, 5].map((i) => q.offer(trace(10 * i)));
    expect(accepted).toEqual([true, true, true, false, false]);
    expect(q.depth('trace')).toBe(3);
    expect(q.counters().tracesDroppedQueueFull).toBe(2);
  });

  it('trace pool: drop-newest at the byte cap', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedBytes: 1000 });
    expect(q.offer(trace(400))).toBe(true);
    expect(q.offer(trace(400))).toBe(true);
    expect(q.offer(trace(400))).toBe(false); // 1200 > 1000
    expect(q.offer(trace(200))).toBe(true); // exactly 1000
    expect(q.estimatedBytes('trace')).toBe(1000);
    expect(q.counters().tracesDroppedQueueFull).toBe(1);
  });

  it('profile pool: drop-newest at maxQueuedProfiles, counted as profilesDropped', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedProfiles: 2 });
    expect([q.offer(profile()), q.offer(profile()), q.offer(profile())]).toEqual([true, true, false]);
    expect(q.counters().profilesDropped).toBe(1);
  });

  it('a flood of 100000 traces never grows the queue beyond its caps', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedTraces: 2000, maxQueuedBytes: 16 * 1024 * 1024 });
    for (let i = 0; i < 100_000; i++) q.offer(trace(5000));
    expect(q.depth('trace')).toBeLessThanOrEqual(2000);
    expect(q.estimatedBytes('trace')).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(q.counters().tracesDroppedQueueFull).toBe(100_000 - q.depth('trace'));
  });

  it('control pool is reserved: a full trace pool does not block rollup and metric items (R9)', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedTraces: 2 });
    q.offer(trace(1));
    q.offer(trace(1));
    expect(q.offer(trace(1))).toBe(false);
    expect(q.offer(metric(100))).toBe(true);
    expect(q.offer(rollup('2026-01-01T00:00:00.000Z', 100))).toBe(true);
    expect(q.depth('control')).toBe(2);
    expect(q.counters().rollupsDropped).toBe(0);
  });

  it('control pool never exceeds its item and byte caps (evict-oldest)', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlItems: 5, maxQueuedControlBytes: 1000 });
    for (let i = 0; i < 500; i++) {
      q.offer(i % 3 === 0 ? rollup(`b${i}`, 150 + (i % 7) * 20) : metric(100 + (i % 11) * 15));
      expect(q.depth('control')).toBeLessThanOrEqual(5);
      expect(q.estimatedBytes('control')).toBeLessThanOrEqual(1000);
    }
  });

  it('control pool evicts metrics before rollups', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlItems: 3 });
    q.offer(rollup('b1', 10));
    q.offer(metric(10, {}, 'm1'));
    q.offer(rollup('b2', 10));
    q.offer(rollup('b3', 10)); // full: evicts the metric, not the oldest rollup
    const items = q.drain(10, 1e9);
    expect(items.map((i) => i.type)).toEqual(['rollup', 'rollup', 'rollup']);
    expect((items[0] as RollupItem).operations[0].bucketStart).toBe('b1');
    expect(q.counters().rollupsDropped).toBe(1);
  });

  it('rollups coalesce per bucket: a bucket occupies at most one slot and keeps its FIFO position', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlItems: 4 });
    q.offer(rollup('b1', 100, 'v1'));
    q.offer(metric(10, {}, 'm1'));
    for (let i = 2; i <= 50; i++) q.offer(rollup('b1', 100 + i, `v${i}`));
    expect(q.depth('control')).toBe(2);
    expect(q.estimatedBytes('control')).toBe(150 + 10);
    const items = q.drain(10, 1e9);
    expect(items.map((i) => i.type)).toEqual(['rollup', 'metric']); // rollup kept its place ahead of the metric
    expect((items[0] as RollupItem).operations[0].operation).toBe('v50'); // newest full aggregate won
    expect(q.counters().rollupsDropped).toBe(0); // replacement is not a drop
  });

  it('an evicted MetricItem folds its counter deltas into the newest queued MetricItem', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlItems: 3 });
    for (let i = 1; i <= 7; i++) q.offer(metric(10, { spansDropped: i, rootsStarted: 10 }, `m${i}`));
    expect(q.depth('control')).toBe(3);
    const metrics = q.drain(10, 1e9) as MetricItem[];
    const sum = (k: keyof TelemetryCounters) => metrics.reduce((n, m) => n + m.metric.telemetry[k], 0);
    expect(sum('spansDropped')).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7); // nothing lost
    expect(sum('rootsStarted')).toBe(70);
    // evictions themselves are recorded in the queue counter
    expect(q.counters().rollupsDropped).toBe(4);
  });

  it('with no MetricItem left to fold into, deltas go to a carry-over added to the next MetricItem', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlItems: 2 });
    q.offer(metric(10, { spansDropped: 3 }, 'm1'));
    q.offer(rollup('b1', 10));
    q.offer(rollup('b2', 10)); // evicts m1 (the only metric); no other metric queued -> carry-over
    expect(q.depth('control')).toBe(2);
    q.offer(metric(10, { spansDropped: 1 }, 'm2')); // evicts the oldest rollup; carry-over lands here
    const metrics = q.drain(10, 1e9).filter((i): i is MetricItem => i.type === 'metric');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].metric.telemetry.spansDropped).toBe(4);
  });

  it('an oversize control item is logged once (and counted every time)', () => {
    const warnings: string[] = [];
    const q = new BoundedTelemetryQueue({ maxQueuedControlBytes: 1000 }, (m) => warnings.push(m));
    q.offer(rollup('a', 5000));
    q.offer(rollup('b', 6000));
    q.offer(metric(7000));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('maxQueuedControlBytes');
    expect(q.counters().rollupsDropped).toBe(3);
    const throwing = new BoundedTelemetryQueue({ maxQueuedControlBytes: 10 }, () => {
      throw new Error('x');
    });
    expect(throwing.offer(rollup('a', 50))).toBe(false); // a throwing warn hook never reaches the producer
  });

  it('a single item larger than the whole control pool is rejected and counted', () => {
    const q = new BoundedTelemetryQueue({ maxQueuedControlBytes: 1000 });
    expect(q.offer(rollup('b', 5000))).toBe(false);
    expect(q.depth('control')).toBe(0);
    expect(q.counters().rollupsDropped).toBe(1);
  });
});

describe('BoundedTelemetryQueue: drain, drops, waiting', () => {
  it('drains FIFO across pools within maxItems and maxBytes', () => {
    const q = new BoundedTelemetryQueue();
    q.offer(trace(100));
    q.offer(metric(100, {}, 'm'));
    q.offer(profile(100));
    q.offer(trace(100));
    const first = q.drain(3, 1e9);
    expect(first.map((i) => i.type)).toEqual(['trace', 'metric', 'profile']);
    const second = q.drain(10, 50 + 0);
    expect(second).toEqual([]); // head (100) larger than maxBytes 50 on its own: dropped, not returned
    expect(q.depth()).toBe(0);
    expect(q.counters().tracesDroppedStorage).toBe(1);
  });

  it('stops at maxBytes without dropping when the head fits on its own', () => {
    const q = new BoundedTelemetryQueue();
    for (let i = 0; i < 5; i++) q.offer(trace(400));
    expect(q.drain(100, 1000)).toHaveLength(2);
    expect(q.depth('trace')).toBe(3);
    expect(q.counters().tracesDroppedStorage).toBe(0);
  });

  it('an oversized head never blocks the queue forever', () => {
    const q = new BoundedTelemetryQueue();
    q.offer(trace(10_000));
    q.offer(trace(10));
    const batch = q.drain(10, 100);
    expect(batch).toHaveLength(1);
    expect(batch[0].estimatedBytes).toBe(10);
  });

  it('reportDropped maps item types and reasons to counters', () => {
    const q = new BoundedTelemetryQueue();
    q.reportDropped([trace(1), trace(1)], 'storage');
    q.reportDropped([trace(1)], 'queueFull');
    q.reportDropped([trace(1)], 'admission');
    q.reportDropped([profile()], 'storage');
    q.reportDropped([rollup('b', 1), metric(1)], 'storage');
    expect(q.counters()).toMatchObject({
      tracesDroppedStorage: 2,
      tracesDroppedQueueFull: 1,
      tracesDroppedAdmission: 1,
      profilesDropped: 1,
      rollupsDropped: 2,
    });
  });

  it('count() ignores invalid input and never throws', () => {
    const q = new BoundedTelemetryQueue();
    q.count('spansDropped', 2);
    q.count('spansDropped', -5);
    q.count('spansDropped', Number.NaN);
    q.count('nonsense' as never, 1);
    expect(q.counters().spansDropped).toBe(2);
  });

  it('waitForItems resolves on offer, resolves on timeout, and immediately when non-empty', async () => {
    const q = new BoundedTelemetryQueue();
    const t0 = Date.now();
    await q.waitForItems(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);

    const waiting = q.waitForItems(5_000);
    setTimeout(() => q.offer(trace(1)), 10);
    const t1 = Date.now();
    await waiting;
    expect(Date.now() - t1).toBeLessThan(2500); // the wait ceiling is 5000: only the offer wake-up passes

    const t2 = Date.now();
    await q.waitForItems(5_000); // non-empty: immediate
    expect(Date.now() - t2).toBeLessThan(100);
  });
});
