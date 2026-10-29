import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { MetricItem, TelemetryCounters, TelemetryQueue } from '../../../src/contracts/index.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import { ContinuousProfiler, MetricsCollector, foldProfile, toProfileItem } from '../../../src/profiling/index.js';
import { sanitizeFramePath } from '../../../src/profiling/vendor/fold-profile.js';
import type { V8Profile } from '../../../src/profiling/vendor/fold-profile.js';
import type { RuntimeSample, RuntimeSampling } from '../../../src/profiling/vendor/runtime-metrics.js';
import { FakeClock, FakeSession } from '../../support/profiling/fake-session.js';
import { sleep } from '../../support/profiling/load.js';

/* Stage 06 review fixes: bounded deep walk, exact cycle stack, schema-valid health reason and mapper output for ANY configuration,
 * frame path fallbacks, huge deltas, collector rebase / flush. */

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const sid = (schema as { $id: string }).$id;
const validProfile = ajv.getSchema(sid + '#/$defs/CpuProfile')!;
const frame = (functionName: string, url = '', lineNumber = -1) => ({ functionName, url, lineNumber, columnNumber: 0 });

describe('item 2: the parent walk stops at the frame cap', () => {
  it('3000 distinct leaves under a 10 000-deep chain fold quickly with exact truncation accounting', () => {
    const depth = 10_000;
    const leaves = 3000;
    const nodes: V8Profile['nodes'] = [{ id: 1, callFrame: frame('(root)'), children: [2] }];
    for (let i = 2; i <= depth; i++) {
      nodes.push({ id: i, callFrame: frame(`f${i}`, 'file:///app/deep.js', i), children: i < depth ? [i + 1] : Array.from({ length: leaves }, (_, k) => depth + 1 + k) });
    }
    const samples: number[] = [];
    for (let k = 0; k < leaves; k++) {
      nodes.push({ id: depth + 1 + k, callFrame: frame(`leaf${k}`, 'file:///app/leaf.js', k) });
      samples.push(depth + 1 + k);
    }
    const t0 = Date.now();
    const f = foldProfile({ nodes, startTime: 0, endTime: 1, samples, timeDeltas: samples.map(() => 10) }, { cwd: '/app', maxFramesPerStack: 128 });
    const ms = Date.now() - t0;
    expect(ms, `fold took ${ms} ms (was 7 247 ms before the fix)`).toBeLessThan(1500);
    expect(f.sampleCount).toBe(leaves);
    expect(f.stacks).toHaveLength(leaves);
    expect(f.stacks.reduce((a, s) => a + s.samples, 0)).toBe(leaves);
    for (const s of f.stacks.slice(0, 50)) {
      const frames = s.stack.split(';');
      expect(frames).toHaveLength(128);
      expect(frames[0]).toBe('(truncated)');
      expect(frames[frames.length - 2]).toBe(`f${depth} deep.js:${depth + 1}`);
    }
  });

  it('a chain of exactly maxFrames frames is NOT marked truncated; one more frame is', () => {
    const chain = (n: number): V8Profile['nodes'] => [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      ...Array.from({ length: n }, (_, i) => ({ id: i + 2, callFrame: frame(`g${i}`, 'file:///app/g.js', i), ...(i < n - 1 ? { children: [i + 3] } : {}) })),
    ];
    const at = (n: number) => foldProfile({ nodes: chain(n), startTime: 0, endTime: 1, samples: [n + 1], timeDeltas: [1] }, { cwd: '/app', maxFramesPerStack: 8 }).stacks[0].stack.split(';');
    expect(at(8)).toHaveLength(8);
    expect(at(8)[0]).toBe('g0 g.js:1');
    expect(at(9)).toHaveLength(8);
    expect(at(9)[0]).toBe('(truncated)');
  });
});

describe('item 3: exact cycle stack', () => {
  it('a 2-cycle below the root folds to exactly (truncated);a;b and counts the cycle', () => {
    const nodes = [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('a', 'file:///app/a.js', 1), children: [3] },
      { id: 3, callFrame: frame('b', 'file:///app/b.js', 2), children: [2] },
    ];
    const f = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [3, 3], timeDeltas: [1, 1] }, { cwd: '/app' });
    expect(f.stacks).toEqual([{ stack: '(truncated);a a.js:2;b b.js:3', samples: 2 }]);
    expect(f.cycleCount).toBe(1);
  });
});

describe('item 4: profilerHealth().reason is always <= 256 characters (schema maxLength)', () => {
  const active: ContinuousProfiler[] = [];
  afterEach(async () => {
    await Promise.all(active.splice(0).map((p) => p.stop()));
  });
  const make = (cfg: Record<string, unknown>, deps: Record<string, unknown>) => {
    const p = new ContinuousProfiler(
      { enabled: true, windowMs: 20, ...cfg },
      { queue: new BoundedTelemetryQueue({ maxQueuedProfiles: 100 }), serviceName: 's', instanceId: 'i', retryDelayMs: 20, busyWaitReason: () => undefined, ...deps } as never,
    );
    active.push(p);
    return p;
  };
  async function until(cond: () => boolean): Promise<void> {
    const end = Date.now() + 5000;
    while (!cond() && Date.now() < end) await sleep(5);
    expect(cond()).toBe(true);
  }
  const LONG = 'L'.repeat(600);

  it('every reason producer stays within 256 characters; the full text stays in debug()', async () => {
    const seen: string[] = [];
    const check = (name: string, p: ContinuousProfiler) => {
      const r = p.profilerHealth().reason;
      expect(r, name).toBeDefined();
      expect(r!.length, `${name}: ${r!.length}`).toBeLessThanOrEqual(256);
      seen.push(name);
    };
    check('disabled', make({ enabled: false }, {}));
    {
      const p = make({}, { probe: () => ({ available: false, reason: LONG }) });
      await p.start();
      check('probe unavailable', p);
      expect(p.debug().reason).toBe(LONG);
    }
    {
      const p = make({ sampleRateHz: 99 }, { busyWaitReason: () => LONG });
      await p.start();
      check('busy-wait', p);
    }
    {
      const p = make({}, { createSession: () => { throw new Error(LONG); } });
      await p.start();
      check('session throws', p);
    }
    {
      const clock = new FakeClock();
      const p = make({ maxStallMs: 1 }, { now: clock.now, createSession: () => new FakeSession({ clock, startMs: 60, stopMs: 60 }) });
      await p.start();
      await until(() => p.profilerHealth().state === 'backoff');
      check('backoff', p);
    }
    {
      const clock = new FakeClock();
      const p = make({}, { now: clock.now, createSession: () => new FakeSession({ clock, failMethod: { method: 'Profiler.stop', atCall: 0, error: LONG } }) });
      await p.start();
      await until(() => p.profilerHealth().state === 'error');
      check('error', p);
      await until(() => p.debug().reason?.includes('retry failed') === true);
      check('error + retry failed', p);
      expect(p.debug().reason!.length).toBeGreaterThan(256);
    }
    expect(seen.length).toBe(7);
  });
});

describe('item 5: no configuration produces a schema-invalid CpuProfile', () => {
  const fold = (nStacks: number) => {
    const stacks = Array.from({ length: nStacks }, (_, i) => ({ stack: `f${i};g${i}`, samples: 1 + (i % 7) }));
    const sampleCount = stacks.reduce((a, s) => a + s.samples, 0);
    return { stacks, sampleCount, idleSampleCount: 0, totalSampleCount: sampleCount };
  };
  const ctx = { serviceName: 'svc', instanceId: 'host-abcdef123456', periodStartMs: 1, periodEndMs: 2, sampleRateHz: 99, durationMs: 1 };

  it('maxStacksPerProfile: huge, Infinity, NaN, negative, fractional, 5000, 5001', () => {
    for (const v of [1e9, Infinity, Number.NaN, -5, 0.5, 5000, 5001, undefined]) {
      const { profile } = toProfileItem(fold(6000), { ...ctx, ...(v !== undefined ? { maxStacksPerProfile: v } : {}), maxProfileBytes: 50_000_000 });
      expect(validProfile(profile), `${String(v)}: ${JSON.stringify(validProfile.errors)}`).toBe(true);
      expect(profile.stacks.length).toBeLessThanOrEqual(5000);
      expect(profile.stacks.reduce((a, s) => a + s.samples, 0) + (profile.droppedSampleCount ?? 0)).toBe(profile.sampleCount);
      expect(profile.stacks.length + (profile.droppedStackCount ?? 0)).toBe(6000);
    }
  });

  it('maxProfileBytes: 0, negative, NaN, Infinity, below the empty-profile size, just above it', () => {
    for (const v of [0, -1, Number.NaN, Infinity, 1, 100, 639, 700, 5000]) {
      const { profile } = toProfileItem(fold(300), { ...ctx, maxProfileBytes: v });
      expect(validProfile(profile), `${String(v)}: ${JSON.stringify(validProfile.errors)}`).toBe(true);
      expect(profile.stacks.reduce((a, s) => a + s.samples, 0) + (profile.droppedSampleCount ?? 0)).toBe(profile.sampleCount);
      expect(Number.isFinite(profile.droppedStackCount)).toBe(true);
    }
    expect(toProfileItem(fold(10), { ...ctx, maxProfileBytes: 1 }).profile.stacks).toEqual([]);
  });

  it('sampleRateHz outside (0, 1000] or non-finite is clamped into the schema range', () => {
    for (const v of [0, -3, 5000, Number.NaN, Infinity, 0.0001]) {
      const { profile } = toProfileItem(fold(3), { ...ctx, sampleRateHz: v });
      expect(validProfile(profile), `${String(v)}: ${JSON.stringify(validProfile.errors)}`).toBe(true);
      expect(profile.sampleRateHz).toBeGreaterThan(0);
      expect(profile.sampleRateHz).toBeLessThanOrEqual(1000);
    }
  });

  it('maxFramesPerStack 0, 1, NaN, negative, Infinity, fractional folds with at least 2 frames and never throws', () => {
    const nodes: V8Profile['nodes'] = [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('a', 'file:///app/a.js', 0), children: [3] },
      { id: 3, callFrame: frame('b', 'file:///app/b.js', 0), children: [4] },
      { id: 4, callFrame: frame('c', 'file:///app/c.js', 0) },
    ];
    for (const v of [0, 1, Number.NaN, -4, Infinity, 2.7]) {
      const f = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [4], timeDeltas: [1] }, { cwd: '/app', maxFramesPerStack: v });
      expect(f.stacks).toHaveLength(1);
      expect(f.stacks[0].stack.split(';').length, String(v)).toBeGreaterThanOrEqual(2);
      expect(validProfile(toProfileItem(f, { ...ctx }).profile)).toBe(true);
    }
  });

  it('a profiler built with garbage config reports finite, in-range rates and windows', () => {
    const p = new ContinuousProfiler({ enabled: true, sampleRateHz: Number.NaN, windowMs: -1, maxStallMs: Number.NaN }, { queue: new BoundedTelemetryQueue(), serviceName: 's', instanceId: 'i' });
    const h = p.profilerHealth();
    expect(h.sampleRateHz).toBe(99);
    expect(h.windowMs).toBe(30_000);
    const big = new ContinuousProfiler({ enabled: true, sampleRateHz: 99_999 }, { queue: new BoundedTelemetryQueue(), serviceName: 's', instanceId: 'i' });
    expect(big.profilerHealth().sampleRateHz).toBe(1000);
  });
});

describe('lows: frame path fallbacks and huge deltas', () => {
  it('a file URL that fileURLToPath rejects never leaks credentials, hosts, query or fragment', () => {
    const cases = ['file://user:pass@host/srv/app/x.js', 'file:///home/alice/app/x.js?token=abc', 'file:///home/alice/app/x.js#secret', 'file://host:8080/srv/app/x.js?a=b#c'];
    for (const u of cases) {
      const out = sanitizeFramePath(u, '/app');
      expect(out, u).not.toMatch(/user|pass|token|secret|host|alice|a=b|8080|[?#]/);
    }
    expect(sanitizeFramePath('file:///home/alice/app/x.js?token=abc', '/home/alice/app')).toBe('x.js');
  });

  it('a single huge finite timeDelta (1e308) is neutralised: timestamps stay finite and the delta is counted', () => {
    const nodes = [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('a', 'file:///app/a.js', 0) },
    ];
    const f = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [2, 2, 2], timeDeltas: [10, 1e308, 10] }, { cwd: '/app' });
    expect(f.invalidDeltaCount).toBe(1);
    expect(Number.isFinite(f.firstSampleUs)).toBe(true);
    expect(Number.isFinite(f.lastSampleUs)).toBe(true);
    expect(f.lastSampleUs).toBe(20);
  });
});

describe('item 6: MetricsCollector counter rebase and post-stop flush', () => {
  class Sampler implements RuntimeSampling {
    t = 1_700_000_000_000;
    constructor(private readonly step = 30_000) {}
    start(): void {}
    stop(): void {}
    collect(): RuntimeSample {
      const s = this.t;
      this.t += this.step;
      return {
        intervalStartMs: s, intervalEndMs: this.t, metrics: undefined as never, cpuFraction: 0, heapUsedBytes: 1, heapTotalBytes: 2, rssBytes: 3, externalBytes: 0,
        eventLoopDelayP50Ms: 0, eventLoopDelayP99Ms: 0, eventLoopDelayMaxMs: 0, rawEventLoopDelayP50Ms: 0, rawEventLoopDelayP99Ms: 0, rawEventLoopDelayMaxMs: 0,
        eventLoopDelaySamples: 0, resolutionMs: 10, eventLoopUtilization: 0, gcCount: 0, gcDurationMs: 0, unavailable: [],
      };
    }
  }
  const items = (q: TelemetryQueue): MetricItem[] => q.drain(100, 1e9).filter((i): i is MetricItem => i.type === 'metric');

  it('a counter that goes backwards is rebased (counted in debug) and later increments are reported in full', () => {
    let cum: TelemetryCounters = { rootsStarted: 50, rootsSampledOut: 0, tracesDroppedAdmission: 0, tracesDroppedQueueFull: 0, tracesDroppedStorage: 0, spansDropped: 0, profilesDropped: 0, rollupsDropped: 0 };
    const inner = new BoundedTelemetryQueue();
    const queue: TelemetryQueue = {
      offer: (i) => inner.offer(i), drain: (a, b) => inner.drain(a, b), reportDropped: (i, r) => inner.reportDropped(i, r), depth: (p) => inner.depth(p),
      estimatedBytes: (p) => inner.estimatedBytes(p), counters: () => cum, waitForItems: (t) => inner.waitForItems(t), count: (n, v) => inner.count(n, v),
    };
    const c = new MetricsCollector({ intervalMs: 1000 }, { queue, serviceName: 's', instanceId: 'host-abcdef123456', sampler: new Sampler() });
    expect(c.collectNow()).toBe(true);
    cum = { ...cum, rootsStarted: 5 };
    c.collectNow();
    cum = { ...cum, rootsStarted: 9 };
    c.collectNow();
    expect(items(inner).map((i) => i.metric.telemetry.rootsStarted)).toEqual([50, 0, 4]);
    expect(c.debug().rebased).toBe(1);
  });

  it('flush() after stop() delivers counters incremented after the collector stopped', () => {
    const queue = new BoundedTelemetryQueue();
    const c = new MetricsCollector({ intervalMs: 1000 }, { queue, serviceName: 's', instanceId: 'host-abcdef123456', sampler: new Sampler(10) });
    c.start();
    queue.count('rootsStarted', 2);
    c.stop();
    queue.count('tracesDroppedStorage', 3);
    expect(c.flush()).toBe(true);
    const got = items(queue);
    expect(got.reduce((a, i) => a + i.metric.telemetry.rootsStarted, 0)).toBe(2);
    expect(got.reduce((a, i) => a + i.metric.telemetry.tracesDroppedStorage, 0)).toBe(3);
    expect(c.flush()).toBe(false);
    c.stop();
  });
});
