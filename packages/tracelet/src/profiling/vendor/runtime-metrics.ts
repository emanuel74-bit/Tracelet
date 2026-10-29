// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.profiling.md
import * as os from 'node:os';
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import type { NodeGCPerformanceDetail, PerformanceEntry } from 'node:perf_hooks';
import type { NodeRuntimeMetrics } from './node-runtime-metrics.interface.js';

type GcBreakdown = NonNullable<NodeRuntimeMetrics['gc']['breakdown']>;

/** V8's young-generation mark-sweep (`1 << 1`), named by Node only from 24.20 and not by @types/node. */
const GC_MINOR_MARK_SWEEP =
  (constants as typeof constants & { NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP?: number }).NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP ?? 2;

function gcBucketOf(kind: number | undefined): keyof GcBreakdown | undefined {
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MINOR:
    case GC_MINOR_MARK_SWEEP:
      return 'minor';
    case constants.NODE_PERFORMANCE_GC_MAJOR:
      return 'major';
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return 'incremental';
    default:
      return undefined;
  }
}

export const DEFAULT_ELD_RESOLUTION_MS = 10;

/**
 * One sampled interval. Every value is a reading taken by this process between `intervalStartMs` and `intervalEndMs`
 * (wall clock); nothing is estimated or filled in. A field that could not be sampled is 0 and listed in `unavailable`.
 */
export interface RuntimeSample {
  intervalStartMs: number;
  intervalEndMs: number;
  /** Upstream-shaped view (MB / ms, same units as nestjs/observe) of the same readings. */
  metrics: NodeRuntimeMetrics;
  /** (user + system process CPU time) / wall time over the interval; 1.0 = one core, may exceed 1. */
  cpuFraction: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  /**
   * Event-loop delay percentiles of this interval, in ms, as the DELAY ABOVE the histogram's sampling resolution
   * (recorded value minus `resolutionMs`, floored at 0). The raw recorded value is an interval between two ticks of an
   * unref'd uv timer, so it includes the resolution itself; the platform's timer granularity (about 15.6 ms on Windows) can
   * leave a small non-zero floor at idle. `raw*` are the unadjusted histogram values.
   */
  eventLoopDelayP50Ms: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
  rawEventLoopDelayP50Ms: number;
  rawEventLoopDelayP99Ms: number;
  rawEventLoopDelayMaxMs: number;
  eventLoopDelaySamples: number;
  resolutionMs: number;
  eventLoopUtilization: number;
  /** GC entries observed through PerformanceObserver('gc') since the previous sample (delivered asynchronously, so entries of a
   *  collection that finished in the last few ms may land in the next interval). */
  gcCount: number;
  gcDurationMs: number;
  /** Names of fields that could not be sampled in this process (for example 'gc' when the observer cannot be created). */
  unavailable: string[];
}

export interface RuntimeSampling {
  start(): void;
  stop(): void;
  collect(): RuntimeSample;
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const MB = 1024 * 1024;

/**
 * Plain-class port of NodeRuntimeMetricsService (no Nest decorators, no options token). `start()` enables the event-loop
 * delay histogram and the GC observer; `collect()` returns one interval and starts the next; `stop()` releases both. Holds no
 * timer of its own (the histogram's timer is internal and unref'd; the caller owns the cadence), all state is fixed size,
 * every method is exception safe.
 */
export class RuntimeMetricsSampler implements RuntimeSampling {
  private eld: ReturnType<typeof monitorEventLoopDelay> | undefined;
  private gcObserver: PerformanceObserver | undefined;
  private gcCount = 0;
  private gcDuration = 0;
  private gcBreakdown: GcBreakdown | null = null;
  private gcUnavailable = false;
  private started = false;
  private lastCpu: NodeJS.CpuUsage = process.cpuUsage();
  private lastWall = Date.now();
  private lastElu = performance.eventLoopUtilization();
  private readonly totalMem = os.totalmem();

  constructor(private readonly resolutionMs: number = DEFAULT_ELD_RESOLUTION_MS) {}

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastCpu = process.cpuUsage();
    this.lastWall = Date.now();
    this.lastElu = performance.eventLoopUtilization();
    this.resetGc();
    try {
      this.eld = monitorEventLoopDelay({ resolution: this.resolutionMs });
      this.eld.enable();
    } catch {
      this.eld = undefined;
    }
    try {
      this.gcUnavailable = false;
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.recordGc(entry);
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
      this.gcObserver = undefined;
      this.gcUnavailable = true;
    }
  }

  stop(): void {
    this.started = false;
    try {
      this.gcObserver?.disconnect();
    } catch {
      // best effort
    }
    try {
      this.eld?.disable();
    } catch {
      // best effort
    }
    this.gcObserver = undefined;
    this.eld = undefined;
  }

  private recordGc(entry: PerformanceEntry): void {
    if (entry.entryType !== 'gc') return;
    this.gcCount++;
    this.gcDuration += entry.duration;
    const detail = (entry as PerformanceEntry & { detail?: NodeGCPerformanceDetail | null }).detail;
    const kind = gcBucketOf(detail?.kind);
    if (!kind) return;
    this.gcBreakdown ??= { minor: { count: 0, duration: 0 }, major: { count: 0, duration: 0 }, incremental: { count: 0, duration: 0 } };
    const bucket = (this.gcBreakdown[kind] ??= { count: 0, duration: 0 });
    bucket.count++;
    bucket.duration += entry.duration;
  }

  private resetGc(): void {
    this.gcCount = 0;
    this.gcDuration = 0;
    this.gcBreakdown = null;
  }

  /** Returns the interval since start() or the previous collect(). Never throws. */
  collect(): RuntimeSample {
    const unavailable: string[] = [];
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastWall);
    const mem = process.memoryUsage();
    const cpuNow = process.cpuUsage();
    const cpuDiff = process.cpuUsage(this.lastCpu);
    const eluNow = performance.eventLoopUtilization();
    const eluDiff = performance.eventLoopUtilization(eluNow, this.lastElu);

    let p50 = 0;
    let p99 = 0;
    let max = 0;
    let n = 0;
    let lagMean = 0;
    if (this.eld) {
      try {
        n = this.eld.count;
        if (n > 0) {
          p50 = this.eld.percentile(50) / 1e6;
          p99 = this.eld.percentile(99) / 1e6;
          max = this.eld.max / 1e6;
          lagMean = this.eld.mean / 1e6;
        }
        this.eld.reset();
      } catch {
        unavailable.push('eventLoopDelay');
      }
    } else {
      unavailable.push('eventLoopDelay');
    }
    if (this.gcUnavailable || !this.gcObserver) unavailable.push('gc');

    const res = this.resolutionMs;
    const above = (v: number): number => finite(v - res);
    const cpuFraction = finite((cpuDiff.user + cpuDiff.system) / 1000 / elapsedMs);
    const gcCount = this.gcCount;
    const gcDurationMs = this.gcDuration;
    const metrics: NodeRuntimeMetrics = {
      memory: {
        rss: mem.rss / MB,
        heapTotal: mem.heapTotal / MB,
        heapUsed: mem.heapUsed / MB,
        external: mem.external / MB,
        arrayBuffers: mem.arrayBuffers / MB,
        percentageUsed: this.totalMem > 0 ? (mem.rss / this.totalMem) * 100 : 0,
      },
      cpu: { user: cpuDiff.user / 1000, system: cpuDiff.system / 1000, percentageUsed: cpuFraction * 100 },
      eventLoop: { lag: above(lagMean), utilization: finite(eluDiff.utilization) },
      gc: { count: gcCount, totalDuration: gcDurationMs, breakdown: { ...this.gcBreakdown } },
    };
    const sample: RuntimeSample = {
      intervalStartMs: this.lastWall,
      intervalEndMs: now,
      metrics,
      cpuFraction,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      rssBytes: mem.rss,
      externalBytes: mem.external,
      eventLoopDelayP50Ms: above(p50),
      eventLoopDelayP99Ms: above(p99),
      eventLoopDelayMaxMs: above(max),
      rawEventLoopDelayP50Ms: finite(p50),
      rawEventLoopDelayP99Ms: finite(p99),
      rawEventLoopDelayMaxMs: finite(max),
      eventLoopDelaySamples: n,
      resolutionMs: res,
      eventLoopUtilization: Math.min(1, finite(eluDiff.utilization)),
      gcCount,
      gcDurationMs,
      unavailable,
    };
    this.resetGc();
    this.lastCpu = cpuNow;
    this.lastWall = now;
    this.lastElu = eluNow;
    return sample;
  }
}
