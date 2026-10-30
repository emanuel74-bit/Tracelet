import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { MetricItem, TelemetryCounters, TelemetryItem, TelemetryQueue } from '../../../src/contracts/index.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import { MetricsCollector } from '../../../src/profiling/index.js';
import type { RuntimeSample, RuntimeSampling } from '../../../src/profiling/vendor/runtime-metrics.js';
import { traceletAls } from '../../../src/shared/als.js';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';
import { sleep } from '../../support/profiling/load.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const validate = ajv.getSchema((schema as { $id: string }).$id + '#/$defs/MetricRollup')!;

class FakeSampler implements RuntimeSampling {
  started = 0;
  stopped = 0;
  collects = 0;
  storeSeen: unknown[] = [];
  next: Partial<RuntimeSample> = {};
  throwOnCollect = false;
  private t = 1_700_000_000_000;
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  collect(): RuntimeSample {
    this.collects++;
    this.storeSeen.push(traceletAls.getStore());
    if (this.throwOnCollect) throw new Error('sampler exploded');
    const start = this.t;
    this.t += 30_000;
    return {
      intervalStartMs: start,
      intervalEndMs: this.t,
      metrics: undefined as never,
      cpuFraction: 0.25,
      heapUsedBytes: 10_000_000.4,
      heapTotalBytes: 20_000_000,
      rssBytes: 90_000_000,
      externalBytes: 1_000_000,
      eventLoopDelayP50Ms: 0.4,
      eventLoopDelayP99Ms: 3.14159,
      eventLoopDelayMaxMs: 12,
      rawEventLoopDelayP50Ms: 10.4,
      rawEventLoopDelayP99Ms: 13.1,
      rawEventLoopDelayMaxMs: 22,
      eventLoopDelaySamples: 3000,
      resolutionMs: 10,
      eventLoopUtilization: 0.07,
      gcCount: 3,
      gcDurationMs: 4.5,
      unavailable: [],
      ...this.next,
    };
  }
}

const collectors: MetricsCollector[] = [];
afterEach(() => {
  for (const c of collectors.splice(0)) c.stop();
});

function make(opts: { interval?: number; queue?: TelemetryQueue; enabled?: boolean } = {}) {
  const queue = (opts.queue ?? new BoundedTelemetryQueue()) as BoundedTelemetryQueue;
  const sampler = new FakeSampler();
  const c = new MetricsCollector(
    { ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}), intervalMs: opts.interval ?? 20 },
    { queue, serviceName: 'svc', instanceId: 'host-abcdef123456', sampler },
  );
  collectors.push(c);
  return { c, queue, sampler };
}

const metrics = (items: TelemetryItem[]): MetricItem[] => items.filter((i): i is MetricItem => i.type === 'metric');
const sum = (items: MetricItem[], k: keyof TelemetryCounters): number => items.reduce((a, i) => a + i.metric.telemetry[k], 0);

describe('MetricsCollector', () => {
  it('builds a schema-valid MetricRollup from the sampled gauges, into the control pool', () => {
    const { c, queue } = make();
    expect(c.collectNow()).toBe(true);
    expect(queue.depth('control')).toBe(1);
    expect(queue.depth('trace')).toBe(0);
    const [item] = metrics(queue.drain(10, 1e9));
    expect(validate(item.metric), JSON.stringify(validate.errors)).toBe(true);
    expect(item.metric).toMatchObject({
      schemaVersion: 1,
      serviceName: 'svc',
      instanceId: 'host-abcdef123456',
      cpuFraction: 0.25,
      heapUsedBytes: 10_000_000,
      eventLoopDelayP99Ms: 3.142,
      eventLoopUtilization: 0.07,
      gcCount: 3,
      gcDurationMs: 4.5,
    });
    expect(item.estimatedBytes).toBeGreaterThanOrEqual(JSON.stringify(item.metric).length);
  });

  it('hostile sampler values (NaN, negative, Infinity, ELU > 1) are clamped to a valid item, never fabricated upward', () => {
    const { c, queue, sampler } = make();
    sampler.next = { cpuFraction: Number.NaN, heapUsedBytes: -5, rssBytes: Number.POSITIVE_INFINITY, eventLoopUtilization: 7, gcCount: -1, eventLoopDelayP99Ms: Number.NaN };
    expect(c.collectNow()).toBe(true);
    const [item] = metrics(queue.drain(10, 1e9));
    expect(validate(item.metric), JSON.stringify(validate.errors)).toBe(true);
    expect(item.metric.cpuFraction).toBe(0);
    expect(item.metric.heapUsedBytes).toBe(0);
    expect(item.metric.rssBytes).toBe(0);
    expect(item.metric.eventLoopUtilization).toBe(1);
  });

  it('telemetry deltas tie to the queue cumulative counters: sum of delivered deltas + uncollected remainder === cumulative', () => {
    const { c, queue } = make();
    const delivered: MetricItem[] = [];
    const pull = (): void => void delivered.push(...metrics(queue.drain(100, 1e9)));
    queue.count('rootsStarted', 5);
    queue.count('spansDropped', 2);
    c.collectNow();
    pull();
    queue.count('rootsStarted', 3);
    queue.count('profilesDropped', 4);
    c.collectNow();
    pull();
    c.collectNow(); // nothing new
    pull();
    queue.count('rollupsDropped', 1);
    queue.count('rootsStarted', 10); // not yet collected
    const cum = queue.counters();
    expect(sum(delivered, 'rootsStarted') + 10).toBe(cum.rootsStarted);
    expect(sum(delivered, 'spansDropped')).toBe(cum.spansDropped);
    expect(sum(delivered, 'profilesDropped')).toBe(cum.profilesDropped);
    expect(delivered.map((d) => d.metric.telemetry.rootsStarted)).toEqual([5, 3, 0]);
    expect(delivered[2].metric.telemetry).toEqual({
      rootsStarted: 0, rootsSampledOut: 0, tracesDroppedAdmission: 0, tracesDroppedQueueFull: 0, tracesDroppedStorage: 0, spansDropped: 0, profilesDropped: 0, rollupsDropped: 0,
    });
  });

  it('control-pool eviction keeps counter totals (queue folds an evicted MetricItem into the newest) and the collector adds no loss', () => {
    const queue = new BoundedTelemetryQueue({ maxQueuedControlItems: 3 });
    const { c } = make({ queue });
    let cumulativeInput = 0;
    for (let i = 0; i < 12; i++) {
      queue.count('rootsStarted', i + 1);
      cumulativeInput += i + 1;
      c.collectNow();
    }
    const items = metrics(queue.drain(100, 1e9));
    expect(items.length).toBeLessThanOrEqual(3);
    // evictions bump rollupsDropped, which rides on a later interval; rootsStarted must be fully preserved
    expect(sum(items, 'rootsStarted')).toBe(cumulativeInput);
    expect(queue.counters().rollupsDropped).toBeGreaterThan(0);
  });

  it('a rejected offer does not advance the baseline: the delta is reported by the next accepted item', () => {
    let accept = false;
    const inner = new BoundedTelemetryQueue();
    const queue: TelemetryQueue = {
      offer: (i) => (accept ? inner.offer(i) : false),
      drain: (a, b) => inner.drain(a, b),
      reportDropped: (i, r) => inner.reportDropped(i, r),
      depth: (p) => inner.depth(p),
      estimatedBytes: (p) => inner.estimatedBytes(p),
      counters: () => inner.counters(),
      waitForItems: (t) => inner.waitForItems(t),
      count: (n, v) => inner.count(n, v),
    };
    const { c } = make({ queue });
    inner.count('spansDropped', 7);
    expect(c.collectNow()).toBe(false);
    expect(c.debug().rejected).toBe(1);
    inner.count('spansDropped', 1);
    accept = true;
    expect(c.collectNow()).toBe(true);
    const items = metrics(inner.drain(10, 1e9));
    expect(items).toHaveLength(1);
    expect(items[0].metric.telemetry.spansDropped).toBe(8);
  });

  it('never throws: a throwing sampler, a throwing queue.offer or counters() are absorbed and counted', () => {
    const { c, sampler } = make();
    sampler.throwOnCollect = true;
    expect(c.collectNow()).toBe(false);
    expect(c.debug().failures).toBe(1);
    expect(c.debug().lastError).toMatch(/exploded/);
    sampler.throwOnCollect = false;
    const bad = make({ queue: { ...new BoundedTelemetryQueue(), offer: () => { throw new Error('queue down'); }, counters: () => ({}) as TelemetryCounters } as unknown as TelemetryQueue });
    expect(() => bad.c.collectNow()).not.toThrow();
    expect(() => bad.c.start()).not.toThrow();
    expect(() => bad.c.stop()).not.toThrow();
  });

  it('ticks on a timer outside any trace and stop() emits the final partial interval, then the timer is gone', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const { c, queue, sampler } = make({ interval: 20 });
      queue.count('rootsStarted', 2);
      // started inside an active trace store: the collector's timer must not inherit it
      traceletAls.run(new Map([['traceId', 'T1']]), () => c.start());
      c.start(); // idempotent
      expect(sampler.started).toBe(1);
      const end = Date.now() + 3000;
      while (sampler.collects < 3 && Date.now() < end) await sleep(5);
      expect(sampler.collects).toBeGreaterThanOrEqual(3);
      expect(sampler.storeSeen.every((s) => s === undefined)).toBe(true);
      queue.count('rootsStarted', 5);
      c.stop();
      c.stop(); // idempotent
      const n = sampler.collects;
      expect(sampler.stopped).toBe(1);
      const items = metrics(queue.drain(1000, 1e9));
      // the final item carries the counts since the last tick: sum over all items equals the cumulative counter
      expect(sum(items, 'rootsStarted')).toBe(7);
      await sleep(80);
      expect(sampler.collects).toBe(n);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('start/stop 25 times: no leaked timers, sampler start/stop balanced', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const { c, sampler } = make({ interval: 10 });
      for (let i = 0; i < 25; i++) {
        c.start();
        await sleep(3);
        c.stop();
      }
      expect(sampler.started).toBe(25);
      expect(sampler.stopped).toBe(25);
      await sleep(30);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('a disabled collector starts nothing: no sampler start, no timer, no item', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const { c, queue, sampler } = make({ enabled: false, interval: 10 });
      c.start();
      await sleep(50);
      c.stop();
      expect(sampler.started).toBe(0);
      expect(sampler.collects).toBe(0);
      expect(queue.depth()).toBe(0);
      expect(c.debug().running).toBe(false);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('the control pool stays bounded however long the collector runs against a queue nobody drains', async () => {
    const queue = new BoundedTelemetryQueue({ maxQueuedControlItems: 4 });
    const { c } = make({ queue, interval: 10 });
    c.start();
    await sleep(300);
    c.stop();
    expect(queue.depth('control')).toBeLessThanOrEqual(4);
  });
});
