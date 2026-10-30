import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeMetricsSampler } from '../../../src/profiling/vendor/runtime-metrics.js';
import { sleep } from '../../support/profiling/load.js';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';

const samplers: RuntimeMetricsSampler[] = [];
afterEach(() => {
  for (const s of samplers.splice(0)) s.stop();
});
const make = (res?: number) => {
  const s = new RuntimeMetricsSampler(res);
  samplers.push(s);
  return s;
};

/** An independent event-loop-delay histogram, used to wait for observable facts instead of guessing sleep lengths. */
class Probe {
  private readonly h = monitorEventLoopDelay({ resolution: 10 });
  constructor() {
    this.h.enable();
  }
  async ticks(n: number, timeoutMs = 10_000): Promise<void> {
    const target = this.h.count + n;
    const end = Date.now() + timeoutMs;
    while (this.h.count < target && Date.now() < end) await sleep(5);
    expect(this.h.count, 'event-loop histogram did not tick').toBeGreaterThanOrEqual(target);
  }
  async sawStall(ms: number, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.h.max / 1e6 < ms && Date.now() < end) await sleep(5);
    expect(this.h.max / 1e6, 'stall was not recorded by the histogram').toBeGreaterThanOrEqual(ms);
  }
  stop(): void {
    this.h.disable();
  }
}

function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}

describe('RuntimeMetricsSampler', () => {
  it('reports real, finite, in-range readings and the upstream-shaped view of the same numbers', async () => {
    const s = make();
    s.start();
    // Flake fix: spin until the PROCESS has really been charged 60 ms of CPU (cpuUsage has coarse granularity on Windows and gets
    // less CPU under contention), instead of assuming 60 ms of wall time spins 60 ms of CPU.
    const c0 = process.cpuUsage();
    const giveUp = Date.now() + 15_000;
    while (process.cpuUsage(c0).user + process.cpuUsage(c0).system < 60_000 && Date.now() < giveUp) spin(5);
    await sleep(80);
    const x = s.collect();
    for (const v of [x.cpuFraction, x.heapUsedBytes, x.heapTotalBytes, x.rssBytes, x.externalBytes, x.eventLoopDelayP50Ms, x.eventLoopDelayP99Ms, x.eventLoopDelayMaxMs, x.eventLoopUtilization, x.gcCount, x.gcDurationMs]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(x.eventLoopUtilization).toBeLessThanOrEqual(1);
    expect(x.heapUsedBytes).toBeLessThanOrEqual(x.heapTotalBytes);
    expect(x.rssBytes).toBeGreaterThan(1_000_000);
    // at least the 60 ms of CPU we forced, over the interval (CPU time is what is measured, so this is load independent)
    expect(x.cpuFraction * (x.intervalEndMs - x.intervalStartMs)).toBeGreaterThanOrEqual(55);
    expect(x.intervalEndMs).toBeGreaterThanOrEqual(x.intervalStartMs + 75);
    expect(x.metrics.memory.heapUsed).toBeCloseTo(x.heapUsedBytes / 1048576, 6);
    expect(x.metrics.cpu.percentageUsed).toBeCloseTo(x.cpuFraction * 100, 6);
    expect(x.metrics.eventLoop.utilization).toBe(x.eventLoopUtilization);
    expect(x.unavailable).toEqual([]);
  });

  it('event-loop delay is the excess over the histogram resolution and sees a real main-thread block', async () => {
    const s = make(10);
    s.start();
    const probe = new Probe();
    try {
      await probe.ticks(3); // a tick has happened since start: the histogram has its reference point
      s.collect(); // discard the warm-up interval (reset() forgets the last tick, documented caveat)
      await probe.ticks(3); // ...and a tick after the reset re-establishes it
      spin(250);
      await probe.sawStall(200); // the stall is recorded on the next timer tick, observed by an independent histogram
      await sleep(30);
      const x = s.collect();
      expect(x.eventLoopDelaySamples).toBeGreaterThan(0);
      expect(x.rawEventLoopDelayMaxMs).toBeGreaterThanOrEqual(200);
      expect(x.eventLoopDelayMaxMs).toBeCloseTo(x.rawEventLoopDelayMaxMs - 10, 3);
      expect(x.eventLoopDelayP99Ms).toBeLessThanOrEqual(x.eventLoopDelayMaxMs);
      expect(x.eventLoopDelayP50Ms).toBeLessThanOrEqual(x.eventLoopDelayP99Ms);
    } finally {
      probe.stop();
    }
  });

  it('each collect() is its own interval: the histogram, GC and CPU deltas reset', async () => {
    const s = make();
    s.start();
    const probe = new Probe();
    try {
      await probe.ticks(3);
      spin(400);
      await probe.sawStall(300);
      await sleep(30);
      const a = s.collect();
      expect(a.rawEventLoopDelayMaxMs).toBeGreaterThanOrEqual(300);
      await probe.ticks(3);
      const b = s.collect();
      expect(b.intervalStartMs).toBe(a.intervalEndMs);
      // the 400 ms stall belongs to interval a only (b was a quiet 50-100 ms; allow anything clearly below the stall)
      expect(b.rawEventLoopDelayMaxMs).toBeLessThan(300);
      expect(b.eventLoopDelaySamples).toBeLessThan(a.eventLoopDelaySamples + 50);
      expect(b.cpuFraction).toBeLessThan(a.cpuFraction);
    } finally {
      probe.stop();
    }
  });

  it('observes GC through PerformanceObserver (allocation churn produces gc entries; counts reset per interval)', async () => {
    const s = make();
    s.start();
    let sink: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      for (let k = 0; k < 20_000; k++) sink.push({ i, k, s: 'x' + k });
      sink = [];
      await sleep(1);
    }
    await sleep(50); // observer callbacks are delivered asynchronously
    const x = s.collect();
    expect(x.gcCount).toBeGreaterThan(0);
    expect(x.gcDurationMs).toBeGreaterThan(0);
    const breakdown = x.metrics.gc.breakdown ?? {};
    const sum = (breakdown.minor?.count ?? 0) + (breakdown.major?.count ?? 0) + (breakdown.incremental?.count ?? 0);
    expect(sum).toBeLessThanOrEqual(x.gcCount);
    await sleep(40);
    expect(s.collect().gcCount).toBeLessThan(x.gcCount);
  });

  it('start/stop are idempotent, repeatable and leave no timer or observer behind; collect never throws, before start or after stop', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const s = make();
      expect(() => s.collect()).not.toThrow();
      expect(s.collect().unavailable).toContain('eventLoopDelay');
      for (let i = 0; i < 20; i++) {
        s.start();
        s.start();
        expect(s.isStarted).toBe(true);
        s.collect();
        s.stop();
        s.stop();
        expect(s.isStarted).toBe(false);
      }
      expect(() => s.collect()).not.toThrow();
      await sleep(30);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });
});
