import type { ProfilerHealthSource, ProfilerState, TelemetryQueue } from '../contracts/index.js';
import { runOutsideTrace } from '../shared/als.js';
import { createDiagnostics } from '../shared/diagnostics.js';
import type { Diagnostics } from '../shared/diagnostics.js';
import { probeInspector } from './inspector-probe.js';
import type { InspectorProbeResult } from './inspector-probe.js';
import { toProfileItem } from './profile-mapper.js';
import { ContinuousCpuSampler, samplerBusyWaitReason } from './vendor/cpu-sampler.js';
import type { InspectorSessionLike, KeepAliveState, RotationKeepAlive, SamplerWindow } from './vendor/cpu-sampler.js';

export const DEFAULT_SAMPLE_RATE_HZ = 99;
export const DEFAULT_WINDOW_MS = 30_000;
export const DEFAULT_MAX_STALL_MS = 250;
/** Consecutive over-budget windows that trip backoff. */
export const BACKOFF_TRIGGER_WINDOWS = 3;
/** Windows skipped by backoff level 1, 2, 3, 4 (then it stays at the maximum). */
export const BACKOFF_SKIP_WINDOWS = [1, 2, 4, 8] as const;
export const DEFAULT_ERROR_RETRY_MS = 60_000;
/** Healthy (non-final, no error) windows after which the single error retry is available again. */
export const HEALTHY_WINDOWS_TO_RESET_RETRY = 10;
const DEBUG_RING = 512;

export interface ContinuousProfilerConfig {
  enabled: boolean;
  sampleRateHz?: number;
  windowMs?: number;
  maxStacksPerProfile?: number;
  maxProfileBytes?: number;
  maxFramesPerStack?: number;
  /** startStallMs + stopStallMs + foldMs budget per window. Default 250. */
  maxStallMs?: number;
}

export interface ContinuousProfilerDeps {
  /** Receives ProfileItems; also the counter sink (profilesDropped is counted by the queue on a rejected offer). */
  queue: TelemetryQueue;
  serviceName: string;
  serviceVersion?: string;
  instanceId: string;
  // injection points for tests
  probe?: () => InspectorProbeResult;
  createSession?: () => InspectorSessionLike;
  /**
   * Rotation keep-alive (see RotationKeepAlive); internal/debug-only option, NOT part of the frozen config contract. Defaults to
   * the inspector console only with the default session and only when NODE_V8_COVERAGE / --cpu-prof are absent; null = off.
   */
  createKeepAlive?: (() => RotationKeepAlive | undefined) | null;
  /**
   * Test seam for the CR-002 gate. Default: samplerBusyWaitReason, but only when the REAL inspector session is used (an injected
   * createSession cannot spin a V8 sampler thread, so fake-session tests are not gated).
   */
  busyWaitReason?: (sampleRateHz: number) => string | undefined;
  now?: () => number;
  wallClock?: () => number;
  retryDelayMs?: number;
  diagnostics?: Diagnostics;
  cwd?: string;
}

/** Per-window debug record (plan 7: stall series, sample-based continuity evidence). Bounded ring, not persisted. */
export interface WindowRecord {
  seq: number;
  periodStartMs: number;
  periodEndMs: number;
  durationMs: number;
  sampleCount: number;
  idleSampleCount: number;
  totalSampleCount: number;
  firstSampleMs?: number;
  lastSampleMs?: number;
  sampledSpanMs: number;
  gapBeforeMs?: number;
  achievedSampleRateHz?: number;
  startStallMs: number;
  stopStallMs: number;
  foldMs: number;
  /** begin()+end() cost of the keep-alive in this rotation; already inside stopStallMs / startStallMs. */
  keepAliveMs: number;
  mapMs: number;
  final: boolean;
  offered: boolean;
  accepted: boolean;
}

export interface ProfilerDebug {
  windows: WindowRecord[];
  /** Full (unclamped) current reason; profilerHealth().reason is clamped to the schema's 256 characters. */
  reason?: string;
  /** Debug only. 'active' = rotations are bracketed by the keep-alive; 'off' = not used (see keepAliveOffReason); 'failed' = begin/end threw. */
  keepAlive: KeepAliveState;
  keepAliveOffReason?: string;
  counters: {
    /** Raw sample gaps that were negative (clamped to 0 in gapBeforeMs). */
    negativeGaps: number;
    /** Cost of the last initial start and the last resume after backoff: a fresh CpuProfiler, heap-proportional, NOT budgeted. */
    lastInitialStartMs?: number;
    lastResumeMs?: number;
    windows: number;
    profilesOffered: number;
    profilesRejected: number;
    emptyWindows: number;
    /** Windows whose V8 profile was structurally unusable (each also counted as profilesDropped). */
    malformedWindows: number;
    lastMalformedReason?: string;
    /** Samples referencing an unknown node id, timeDeltas entries that were invalid, stacks cut by a parent-chain cycle. */
    invalidSamples: number;
    invalidDeltas: number;
    cyclicStacks: number;
    backoffs: number;
    lastBackoffReason?: string;
    errors: number;
  };
}

/** Which of the three per-window blocks dominates the budget, for the backoff reason. */
function dominant(start: number, stop: number, fold: number): string {
  const max = Math.max(start, stop, fold);
  return max === start ? 'startStallMs' : max === stop ? 'stopStallMs' : 'foldMs';
}

/** InstanceHeartbeat.profiler.reason is limited to 256 characters by the schema; the full text stays in debug(). */
export const MAX_REASON_CHARS = 256;
function clampReason(reason: string): string {
  return reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 3)}...`;
}

function msg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? m.slice(0, 200) : m;
}

/**
 * Lifecycle, truthful state machine and backoff of the continuous CPU profiler (plan 3.8, 7). Never throws from its public
 * methods, never blocks business logic, creates no spans (every timer is armed outside any trace) and never synthesizes a
 * profile from anything but a real V8 profile. There is no permanent self-disable: a window budget breach backs off 1, 2, 4,
 * 8 windows and then resumes; an inspector error retries once after retryDelayMs.
 */
export class ContinuousProfiler implements ProfilerHealthSource {
  private state: ProfilerState = 'stopped';
  private reason: string | undefined;
  private sampler: ContinuousCpuSampler | undefined;
  private backoffTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retried = false;
  private healthyWindows = 0;
  private stopping = false;
  private keepAliveState: KeepAliveState = 'off';
  private keepAliveOffReason: string | undefined;
  private consecutiveOver = 0;
  private backoffLevel = 0;
  private seq = 0;
  private lastWindowAt: string | undefined;
  private achieved: number | undefined;
  private readonly windows: WindowRecord[] = [];
  private readonly counters: ProfilerDebug['counters'] = {
    windows: 0,
    profilesOffered: 0,
    profilesRejected: 0,
    emptyWindows: 0,
    malformedWindows: 0,
    invalidSamples: 0,
    invalidDeltas: 0,
    cyclicStacks: 0,
    backoffs: 0,
    errors: 0,
    negativeGaps: 0,
  };
  private readonly sampleRateHz: number;
  private readonly windowMs: number;
  private readonly maxStallMs: number;
  private readonly diag: Diagnostics;

  constructor(
    private readonly config: ContinuousProfilerConfig,
    private readonly deps: ContinuousProfilerDeps,
  ) {
    // Defensive only (LEAD validates the documented ranges): a non-finite value falls back to the default and the sample rate is
    // kept inside the schema's (0, 1000], so no configuration can produce a schema-invalid profile or a NaN timer.
    const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    this.sampleRateHz = Math.min(1000, fin(config.sampleRateHz, DEFAULT_SAMPLE_RATE_HZ));
    this.windowMs = fin(config.windowMs, DEFAULT_WINDOW_MS);
    this.maxStallMs = typeof config.maxStallMs === 'number' && Number.isFinite(config.maxStallMs) && config.maxStallMs >= 0 ? config.maxStallMs : DEFAULT_MAX_STALL_MS;
    this.diag = deps.diagnostics ?? createDiagnostics('Tracelet.Profiler');
    if (!config.enabled) {
      this.state = 'disabled';
      this.reason = 'profiling.enabled is false';
    }
  }

  profilerHealth(): ReturnType<ProfilerHealthSource['profilerHealth']> {
    return {
      state: this.state,
      ...(this.reason !== undefined ? { reason: clampReason(this.reason) } : {}),
      sampleRateHz: this.sampleRateHz,
      ...(this.achieved !== undefined ? { achievedSampleRateHz: Math.round(this.achieved * 100) / 100 } : {}),
      windowMs: this.windowMs,
      ...(this.lastWindowAt !== undefined ? { lastWindowAt: this.lastWindowAt } : {}),
    };
  }

  debug(): ProfilerDebug {
    return {
      windows: this.windows.slice(),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
      keepAlive: this.keepAliveState,
      ...(this.keepAliveOffReason !== undefined ? { keepAliveOffReason: this.keepAliveOffReason } : {}),
      counters: { ...this.counters },
    };
  }

  /** Never throws. Resolves once window 0 is sampling (or the state is final: disabled/unavailable). */
  async start(): Promise<void> {
    try {
      if (!this.config.enabled) {
        this.state = 'disabled';
        return;
      }
      if (this.state === 'starting' || this.state === 'running' || this.state === 'backoff') return;
      this.stopping = false;
      this.state = 'starting';
      this.reason = undefined;
      // CR-002 option A: V8 11.3 on Windows busy-waits the sampler thread (about one core, always) when the sampling interval is under 100 ms.
      // Refuse truthfully instead of burning a core: no probe session, no sampler session, no timer. sampleRateHz <= 9 is the explicit working opt-in.
      const busyWait = (this.deps.busyWaitReason ?? (this.deps.createSession ? () => undefined : samplerBusyWaitReason))(this.sampleRateHz);
      if (busyWait) {
        this.state = 'unavailable';
        this.reason = busyWait;
        this.diag.warn('sampler-busy-wait', `[tracelet] profiler not started: ${busyWait}`);
        return;
      }
      const probe = (this.deps.probe ?? probeInspector)();
      if (!probe.available) {
        this.state = 'unavailable';
        this.reason = probe.reason ?? 'inspector unavailable';
        return;
      }
      await this.startSampler();
    } catch (err) {
      this.state = 'unavailable';
      this.reason = `profiler failed to start: ${msg(err)}`;
    }
  }

  /** Final Profiler.stop + offer of the partial window, disconnect. Never throws. */
  async stop(): Promise<void> {
    try {
      this.stopping = true;
      this.clearTimers();
      const sampler = this.sampler;
      this.sampler = undefined;
      if (sampler) await sampler.stop();
      if (this.state === 'starting' || this.state === 'running' || this.state === 'backoff' || this.state === 'error') {
        this.state = 'stopped';
        this.reason = undefined;
      }
    } catch {
      // stop must not fail shutdown
    }
  }

  private async startSampler(): Promise<void> {
    // eslint-disable-next-line prefer-const
    let sampler: ContinuousCpuSampler;
    const sync = (): void => {
      this.keepAliveState = sampler.keepAliveState;
      this.keepAliveOffReason = sampler.keepAliveOffReason;
    };
    sampler = new ContinuousCpuSampler({
      sampleRateHz: this.sampleRateHz,
      windowMs: this.windowMs,
      ...(this.deps.createSession ? { createSession: this.deps.createSession } : {}),
      ...(this.deps.createKeepAlive !== undefined ? { createKeepAlive: this.deps.createKeepAlive } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.wallClock ? { wallClock: this.deps.wallClock } : {}),
      fold: {
        ...(this.config.maxFramesPerStack !== undefined ? { maxFramesPerStack: this.config.maxFramesPerStack } : {}),
        ...(this.deps.cwd !== undefined ? { cwd: this.deps.cwd } : {}),
      },
      onWindow: (w) => {
        sync();
        return this.onWindow(w);
      },
      onError: (err) => this.onSamplerError(err),
    });
    this.consecutiveOver = 0;
    try {
      await sampler.start();
      sync();
      this.counters.lastInitialStartMs = sampler.lifecycle.startMs;
    } catch (err) {
      this.state = 'unavailable';
      this.reason = `could not start the inspector profiler: ${msg(err)}`;
      return;
    }
    this.sampler = sampler;
    this.state = 'running';
    this.reason = undefined;
  }

  private onWindow(w: SamplerWindow): void | 'pause' {
    const nowMono = this.deps.now ?? (() => performance.now());
    const t0 = nowMono();
    this.counters.windows++;
    let offered = false;
    let accepted = false;
    try {
      if (w.fold.invalidSampleCount) this.counters.invalidSamples += w.fold.invalidSampleCount;
      if (w.fold.invalidDeltaCount) this.counters.invalidDeltas += w.fold.invalidDeltaCount;
      if (w.fold.cycleCount) this.counters.cyclicStacks += w.fold.cycleCount;
      if (w.fold.malformed !== undefined) {
        // structurally unusable profile: nothing was folded; the whole window is a dropped profile
        this.counters.malformedWindows++;
        this.counters.lastMalformedReason = w.fold.malformed;
        this.safeCount('profilesDropped');
        this.diag.warn('malformed', `[tracelet] malformed V8 profile dropped: ${w.fold.malformed}`);
      } else if (w.fold.totalSampleCount > 0) {
        const item = toProfileItem(w.fold, {
          serviceName: this.deps.serviceName,
          ...(this.deps.serviceVersion !== undefined ? { serviceVersion: this.deps.serviceVersion } : {}),
          instanceId: this.deps.instanceId,
          periodStartMs: w.periodStartMs,
          periodEndMs: w.periodEndMs,
          sampleRateHz: this.sampleRateHz,
          durationMs: w.durationMs,
          ...(w.gapBeforeMs !== undefined ? { gapBeforeMs: w.gapBeforeMs } : {}),
          ...(this.config.maxStacksPerProfile !== undefined ? { maxStacksPerProfile: this.config.maxStacksPerProfile } : {}),
          ...(this.config.maxProfileBytes !== undefined ? { maxProfileBytes: this.config.maxProfileBytes } : {}),
        });
        offered = true;
        this.counters.profilesOffered++;
        // a rejected offer is counted as profilesDropped by the queue itself (queue contract); not counted twice here
        accepted = this.deps.queue.offer(item);
        if (!accepted) this.counters.profilesRejected++;
      } else {
        this.counters.emptyWindows++;
      }
    } catch (err) {
      // mapping failed: the profile is lost, count it ourselves because the queue never saw it
      this.safeCount('profilesDropped');
      this.diag.warn('map', `[tracelet] profile window dropped: ${msg(err)}`);
    }
    const mapMs = nowMono() - t0;

    const first = w.fold.firstSampleUs;
    const last = w.fold.lastSampleUs;
    this.record({
      seq: this.seq++,
      periodStartMs: w.periodStartMs,
      periodEndMs: w.periodEndMs,
      durationMs: w.durationMs,
      sampleCount: w.fold.sampleCount,
      idleSampleCount: w.fold.idleSampleCount,
      totalSampleCount: w.fold.totalSampleCount,
      ...(first !== undefined ? { firstSampleMs: first / 1000 } : {}),
      ...(last !== undefined ? { lastSampleMs: last / 1000 } : {}),
      sampledSpanMs: w.sampledSpanMs,
      ...(w.gapBeforeMs !== undefined ? { gapBeforeMs: w.gapBeforeMs } : {}),
      ...(w.achievedSampleRateHz !== undefined ? { achievedSampleRateHz: w.achievedSampleRateHz } : {}),
      startStallMs: w.startStallMs,
      stopStallMs: w.stopStallMs,
      foldMs: w.foldMs,
      keepAliveMs: w.keepAliveMs,
      mapMs,
      final: w.final,
      offered,
      accepted,
    });
    this.lastWindowAt = new Date(w.periodEndMs).toISOString();
    if (w.achievedSampleRateHz !== undefined) this.achieved = w.achievedSampleRateHz;

    if (w.negativeGap) this.counters.negativeGaps++;
    if (w.final) return;
    if (this.retried && ++this.healthyWindows >= HEALTHY_WINDOWS_TO_RESET_RETRY) {
      this.retried = false;
      this.healthyWindows = 0;
    }
    const total = w.startStallMs + w.stopStallMs + w.foldMs;
    if (total <= this.maxStallMs) {
      this.consecutiveOver = 0;
      this.backoffLevel = 0;
      return;
    }
    if (++this.consecutiveOver < BACKOFF_TRIGGER_WINDOWS) return;
    return this.enterBackoff(w, total);
  }

  private enterBackoff(w: SamplerWindow, total: number): 'pause' {
    this.backoffLevel = Math.min(this.backoffLevel + 1, BACKOFF_SKIP_WINDOWS.length);
    const skip = BACKOFF_SKIP_WINDOWS[this.backoffLevel - 1];
    const reason =
      `window block ${total.toFixed(0)} ms (startStallMs ${w.startStallMs.toFixed(0)}, stopStallMs ${w.stopStallMs.toFixed(0)}, ` +
      `foldMs ${w.foldMs.toFixed(0)}) exceeded maxStallMs ${this.maxStallMs} for ${BACKOFF_TRIGGER_WINDOWS} consecutive windows; ` +
      `dominated by ${dominant(w.startStallMs, w.stopStallMs, w.foldMs)}` +
      (w.keepAliveMs >= (w.startStallMs + w.stopStallMs) / 2 && w.keepAliveMs > 0
        ? `; the rotation keep-alive itself cost ${w.keepAliveMs.toFixed(0)} ms (another inspector session has the Profiler enabled: DevTools, coverage, a second profiler)`
        : '') +
      `; sampling paused for ${skip} window(s)`;
    this.state = 'backoff';
    this.reason = reason;
    this.counters.backoffs++;
    this.counters.lastBackoffReason = reason;
    this.consecutiveOver = 0;
    this.diag.warn('backoff', `[tracelet] profiler backing off: ${reason}`);
    this.backoffTimer = runOutsideTrace(() => setTimeout(() => void this.resumeAfterBackoff(), skip * this.windowMs));
    this.backoffTimer.unref?.();
    return 'pause';
  }

  private async resumeAfterBackoff(): Promise<void> {
    this.backoffTimer = undefined;
    const sampler = this.sampler;
    if (!sampler || this.state !== 'backoff') return;
    try {
      await sampler.resume();
      this.counters.lastResumeMs = sampler.lifecycle.resumeMs;
      if (this.state === 'backoff') {
        this.state = 'running';
        this.reason = undefined;
      }
    } catch (err) {
      this.onSamplerError(err);
    }
  }

  private onSamplerError(err: unknown): void {
    if (this.stopping) return;
    this.counters.errors++;
    this.healthyWindows = 0;
    this.sampler = undefined;
    this.clearTimers();
    this.state = 'error';
    this.reason = `inspector error: ${msg(err)}${this.retried ? '; retry failed, profiling stays off until restart' : ''}`;
    this.diag.error('sampler', `[tracelet] CPU profiler error: ${msg(err)}`);
    if (this.retried) return;
    this.retried = true;
    const delay = this.deps.retryDelayMs ?? DEFAULT_ERROR_RETRY_MS;
    this.retryTimer = runOutsideTrace(() => setTimeout(() => void this.retry(), delay));
    this.retryTimer.unref?.();
  }

  private async retry(): Promise<void> {
    this.retryTimer = undefined;
    if (this.state !== 'error') return;
    const before = this.reason;
    await this.startSampler();
    if (this.stopping) {
      // stop() ran while the retry was starting: do not leave a live sampler behind
      const late = this.sampler;
      this.sampler = undefined;
      await late?.stop();
      this.state = 'stopped';
      this.reason = undefined;
      return;
    }
    if ((this.state as ProfilerState) === 'unavailable') {
      this.state = 'error';
      this.reason = `${before ?? 'inspector error'}; retry failed (${this.reason}), profiling stays off until restart`;
    }
  }

  private clearTimers(): void {
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.backoffTimer = undefined;
    this.retryTimer = undefined;
  }

  private record(r: WindowRecord): void {
    this.windows.push(r);
    if (this.windows.length > DEBUG_RING) this.windows.shift();
  }

  private safeCount(name: 'profilesDropped'): void {
    try {
      this.deps.queue.count(name, 1);
    } catch {
      // counters never throw into the profiler
    }
  }
}
