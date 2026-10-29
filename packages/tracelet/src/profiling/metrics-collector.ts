import type { MetricItem, MetricRollup, TelemetryCounterName, TelemetryCounters, TelemetryQueue } from '../contracts/index.js';
import { runOutsideTrace } from '../shared/als.js';
import { createDiagnostics } from '../shared/diagnostics.js';
import type { Diagnostics } from '../shared/diagnostics.js';
import { RuntimeMetricsSampler } from './vendor/runtime-metrics.js';
import type { RuntimeSample, RuntimeSampling } from './vendor/runtime-metrics.js';

export const DEFAULT_METRICS_INTERVAL_MS = 30_000;
/** Config validation (LEAD) enforces the documented 10 s minimum; this floor only protects against a runaway timer. */
export const MIN_METRICS_INTERVAL_MS = 10;
/** Shutdown flush is skipped for an interval shorter than this unless a counter changed. */
const MIN_FINAL_INTERVAL_MS = 1000;

export const COUNTER_KEYS: readonly TelemetryCounterName[] = [
  'rootsStarted',
  'rootsSampledOut',
  'tracesDroppedAdmission',
  'tracesDroppedQueueFull',
  'tracesDroppedStorage',
  'spansDropped',
  'profilesDropped',
  'rollupsDropped',
];

export interface MetricsCollectorConfig {
  enabled?: boolean;
  /** Default 30000. */
  intervalMs?: number;
}

export interface MetricsCollectorDeps {
  /** Receives MetricItems (control pool) and is read for its cumulative counters. */
  queue: TelemetryQueue;
  serviceName: string;
  instanceId: string;
  /** Injection point for tests; defaults to a RuntimeMetricsSampler. */
  sampler?: RuntimeSampling;
  diagnostics?: Diagnostics;
}

export interface MetricsCollectorDebug {
  running: boolean;
  intervals: number;
  /** Counter readings that went backwards and were rebased (should be 0: a collector must live exactly as long as its queue). */
  rebased: number;
  offered: number;
  rejected: number;
  failures: number;
  lastError?: string;
  /** Field names that could not be sampled (last sample), for example ['gc']. */
  unavailable: string[];
}

function msg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? m.slice(0, 200) : m;
}

const nonNeg = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

function zeroCounters(): TelemetryCounters {
  return {
    rootsStarted: 0,
    rootsSampledOut: 0,
    tracesDroppedAdmission: 0,
    tracesDroppedQueueFull: 0,
    tracesDroppedStorage: 0,
    spansDropped: 0,
    profilesDropped: 0,
    rollupsDropped: 0,
  };
}

/**
 * Every `intervalMs`: one MetricItem from the runtime gauges (RuntimeMetricsSampler) and the deltas of the queue's cumulative
 * counters since the last ACCEPTED item (plan 3.8, 9). The baseline only advances when the queue accepted the item, so the sum of
 * all delivered `telemetry` deltas plus the not-yet-collected remainder always equals the queue's cumulative counters (T11 rev
 * 5). The timer is unref'd and armed outside any trace; a tick never throws and never awaits; shutdown (`stop()`) emits one last
 * partial interval so counts up to shutdown are not lost. No health data is collected here: ProfilerHealthSource is the
 * ContinuousProfiler and TracingHealthSource is provided by the integration layer.
 */
export class MetricsCollector {
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly sampler: RuntimeSampling;
  private readonly diag: Diagnostics;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Cumulative counters already reported in an accepted item. */
  private baseline: TelemetryCounters = zeroCounters();
  private readonly dbg: MetricsCollectorDebug = { running: false, intervals: 0, rebased: 0, offered: 0, rejected: 0, failures: 0, unavailable: [] };

  constructor(
    config: MetricsCollectorConfig,
    private readonly deps: MetricsCollectorDeps,
  ) {
    this.enabled = config.enabled !== false;
    this.intervalMs = Math.max(MIN_METRICS_INTERVAL_MS, Math.floor(config.intervalMs ?? DEFAULT_METRICS_INTERVAL_MS));
    this.sampler = deps.sampler ?? new RuntimeMetricsSampler();
    this.diag = deps.diagnostics ?? createDiagnostics('Tracelet.Metrics');
  }

  debug(): MetricsCollectorDebug {
    return { ...this.dbg, running: this.running, unavailable: this.dbg.unavailable.slice() };
  }

  /** Idempotent, never throws. A disabled collector does nothing (no histogram, no observer, no timer). */
  start(): void {
    try {
      if (!this.enabled || this.running) return;
      this.running = true;
      this.sampler.start();
      this.timer = runOutsideTrace(() => setInterval(() => this.tick(false), this.intervalMs));
      this.timer.unref?.();
    } catch (err) {
      this.running = false;
      this.clearTimer();
      this.fail(err);
    }
  }

  /** Stops the timer, emits the final partial interval and releases the sampler. Idempotent, never throws. */
  stop(): void {
    try {
      if (!this.running) return;
      this.running = false;
      this.clearTimer();
      this.tick(true);
      this.sampler.stop();
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Emits one last item with the counter deltas that accumulated since the previous item, also AFTER stop(). Call it once more
   * right before the writer's final flush: counters incremented after stop() (closeAllOpenRoots, shutdown drops) would otherwise
   * never reach a MetricItem. Skipped (returns false) when nothing changed and the interval is under 1 s. After stop() the
   * event-loop-delay and GC fields of that item are 0 and listed as unavailable by the sampler. Never throws.
   */
  flush(): boolean {
    return this.tick(true);
  }

  /** One collection; exposed for tests and for a manual final flush. Never throws. Returns whether an item was accepted. */
  collectNow(): boolean {
    return this.tick(false);
  }

  private tick(final: boolean): boolean {
    try {
      const sample = this.sampler.collect();
      const counters = this.deps.queue.counters();
      const delta = zeroCounters();
      let changed = false;
      for (const k of COUNTER_KEYS) {
        const cur = nonNeg(counters[k]);
        // a counter that went BACKWARDS (queue replaced or reset) is rebased instead of waiting to catch up, which would under-report
        if (cur < this.baseline[k]) {
          this.dbg.rebased++;
          this.baseline[k] = cur;
        }
        const d = cur - this.baseline[k];
        delta[k] = d > 0 ? d : 0;
        if (d > 0) changed = true;
      }
      this.dbg.intervals++;
      this.dbg.unavailable = sample.unavailable.slice();
      if (final && !changed && sample.intervalEndMs - sample.intervalStartMs < MIN_FINAL_INTERVAL_MS) return false;
      const item = this.toItem(sample, delta);
      this.dbg.offered++;
      const accepted = this.deps.queue.offer(item);
      if (accepted) {
        for (const k of COUNTER_KEYS) this.baseline[k] += delta[k];
      } else {
        // the deltas stay unreported and ride on the next item (counters stay tied to the queue's totals)
        this.dbg.rejected++;
      }
      return accepted;
    } catch (err) {
      this.fail(err);
      return false;
    }
  }

  private toItem(s: RuntimeSample, telemetry: TelemetryCounters): MetricItem {
    const end = Math.max(s.intervalStartMs, s.intervalEndMs);
    const metric: MetricRollup = {
      schemaVersion: 1,
      serviceName: this.deps.serviceName,
      instanceId: this.deps.instanceId,
      intervalStart: new Date(s.intervalStartMs).toISOString(),
      intervalEnd: new Date(end).toISOString(),
      cpuFraction: round(nonNeg(s.cpuFraction), 4),
      heapUsedBytes: Math.round(nonNeg(s.heapUsedBytes)),
      heapTotalBytes: Math.round(nonNeg(s.heapTotalBytes)),
      rssBytes: Math.round(nonNeg(s.rssBytes)),
      externalBytes: Math.round(nonNeg(s.externalBytes)),
      eventLoopDelayP50Ms: round(nonNeg(s.eventLoopDelayP50Ms), 3),
      eventLoopDelayP99Ms: round(nonNeg(s.eventLoopDelayP99Ms), 3),
      eventLoopDelayMaxMs: round(nonNeg(s.eventLoopDelayMaxMs), 3),
      eventLoopUtilization: Math.min(1, round(nonNeg(s.eventLoopUtilization), 4)),
      gcCount: Math.round(nonNeg(s.gcCount)),
      gcDurationMs: round(nonNeg(s.gcDurationMs), 3),
      telemetry,
    };
    return { type: 'metric', metric, estimatedBytes: JSON.stringify(metric).length + 64 };
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(err: unknown): void {
    this.dbg.failures++;
    this.dbg.lastError = msg(err);
    this.diag.warn('collect', `[tracelet] runtime metrics collection failed: ${msg(err)}`);
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
