// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.profiling.md
import { performance } from 'node:perf_hooks';
import { runOutsideTrace } from '../../shared/als.js';
import { achievedSampleRateHz, foldProfile } from './fold-profile.js';
import type { FoldOptions, FoldResult, V8Profile } from './fold-profile.js';

/** The part of node:inspector's Session the sampler uses. Injectable for tests (T18). */
export interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object | undefined, callback: (err: Error | null, result?: any) => void): void;
}

export function createInspectorSession(): InspectorSessionLike {
  const mod = process.getBuiltinModule?.('node:inspector') as { Session: new () => InspectorSessionLike } | undefined;
  if (!mod || typeof mod.Session !== 'function') throw new Error("require('node:inspector') is not available");
  return new mod.Session();
}

/**
 * Holds one extra profile open across a rotation so the inspector never disposes its CpuProfiler between `Profiler.stop` and
 * `Profiler.start`. Without it, V8ProfilerAgentImpl::stopProfiling disposes the CpuProfiler when its started-profile count
 * reaches 0 and the next start builds a new one whose ProfilingScope re-logs every code object with full heap walks
 * (LogCodeObjects, LogCompiledFunctions, LogAccessorCallbacks): a main-thread stall proportional to heap size and code size.
 */
export interface RotationKeepAlive {
  begin(): void;
  end(): void;
}

export const KEEPALIVE_PROFILE_TITLE = 'tracelet:rotation-keepalive';

export type KeepAliveState = 'active' | 'off' | 'failed';

function hasCpuProfFlag(args: readonly string[]): boolean {
  return args.some((a) => a === '--cpu-prof' || a.startsWith('--cpu-prof-'));
}

/**
 * Why the default keep-alive must stay off, or undefined when it may be used. V8's console profile is broadcast to EVERY
 * inspector session whose Profiler domain is enabled: under NODE_V8_COVERAGE (c8, node --test coverage) or --cpu-prof the
 * runtime's own session would receive the keep-alive profile (stderr noise with absolute paths, and its own CpuProfiler
 * dispose/re-create brings the stall back).
 */
export function keepAliveDisabledReason(
  env: Record<string, string | undefined> = process.env,
  execArgv: readonly string[] = process.execArgv,
): string | undefined {
  if (env.NODE_V8_COVERAGE) return 'NODE_V8_COVERAGE is set';
  if (hasCpuProfFlag(execArgv)) return '--cpu-prof is in process.execArgv';
  const nodeOptions = env.NODE_OPTIONS;
  if (nodeOptions && hasCpuProfFlag(nodeOptions.split(/\s+/))) return '--cpu-prof is in NODE_OPTIONS';
  return undefined;
}

/** The sampling interval (µs) the sampler passes to Profiler.setSamplingInterval for a given rate. */
export function samplingIntervalUs(sampleRateHz: number): number {
  return Math.max(100, Math.round(1e6 / sampleRateHz));
}

/**
 * V8's SamplingEventsProcessor::Run on Windows spins (`while (TimeTicks::Now() < next) {}`) instead of sleeping whenever the
 * time to the next sample is under 100 ms and precise sampling is on (always, via the inspector). V8 11.8+ (Node 21+) sleeps on
 * a CREATE_WAITABLE_TIMER_HIGH_RESOLUTION timer instead, which needs Windows 10 1803 (build 17134); older V8, or that V8 on an
 * older Windows build, keeps the busy-wait. Intervals of at least 110 ms (sampleRateHz <= 9) take the condition-variable path.
 * Measured on Node 20.19.5 / Windows 10: one sampler thread at a full core while the application is idle (CR-002).
 */
const BUSY_WAIT_SAFE_INTERVAL_US = 110_000;
const WIN_HIGH_RES_TIMER_BUILD = 17134;

/** Why this runtime's V8 sampler thread busy-waits a core at this rate, or undefined when it does not. Pure; never throws. */
export function samplerBusyWaitReason(
  sampleRateHz: number,
  platform: string = process.platform,
  v8Version: string | undefined = process.versions.v8,
  osRelease: string | undefined = osReleaseSafe(),
): string | undefined {
  if (platform !== 'win32') return undefined;
  if (!(sampleRateHz > 0) || samplingIntervalUs(sampleRateHz) >= BUSY_WAIT_SAFE_INTERVAL_US) return undefined;
  const [major = 0, minor = 0] = String(v8Version ?? '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0);
  const preciseTimer = major > 11 || (major === 11 && minor >= 8);
  const build = Number.parseInt(String(osRelease ?? '').split('.')[2] ?? '', 10);
  if (preciseTimer && !(Number.isFinite(build) && build < WIN_HIGH_RES_TIMER_BUILD)) return undefined;
  const why = preciseTimer ? `Windows build ${build} has no high-resolution waitable timer` : `V8 ${v8Version} predates its precise sleep timer`;
  return (
    `on Windows the V8 CPU sampler thread busy-waits about one core between samples at sampleRateHz ${sampleRateHz} (${why}); ` +
    'use Node >= 22 on Windows 10 1803+, or sampleRateHz <= 9'
  );
}

function osReleaseSafe(): string | undefined {
  try {
    const os = process.getBuiltinModule?.('node:os') as { release?: () => string } | undefined;
    return os?.release?.();
  } catch {
    return undefined;
  }
}

/**
 * Default keep-alive: a console profile on the in-process inspector (`node:inspector`'s `console.profile` / `profileEnd`, the
 * V8 console, not the global one), which counts as a started profile on every session whose Profiler domain is enabled. Returns
 * undefined when the inspector console is not available; the sampler then rotates without it (slower, still correct).
 */
export function createInspectorKeepAlive(): RotationKeepAlive | undefined {
  const mod = process.getBuiltinModule?.('node:inspector') as
    | { console?: { profile?: (title: string) => void; profileEnd?: (title: string) => void } }
    | undefined;
  const c = mod?.console;
  if (!c || typeof c.profile !== 'function' || typeof c.profileEnd !== 'function') return undefined;
  const profile = c.profile.bind(c);
  const profileEnd = c.profileEnd.bind(c);
  return { begin: () => profile(KEEPALIVE_PROFILE_TITLE), end: () => profileEnd(KEEPALIVE_PROFILE_TITLE) };
}

export interface SamplerWindow {
  /** 0-based index since this sampler instance was constructed. */
  index: number;
  /** Wall clock (Date.now) when this window's Profiler.start returned / when its Profiler.stop returned. */
  periodStartMs: number;
  periodEndMs: number;
  /** V8 endTime - startTime, ms. Not a coverage measure. */
  durationMs: number;
  fold: FoldResult;
  /** (firstSample(i) - lastSample(i-1)) / 1000 from sample timestamps; undefined for the first window after (re)start/resume. */
  gapBeforeMs?: number;
  /** (lastSample - firstSample) / 1000; 0 when fewer than 2 samples. Basis of coverage and achievedSampleRateHz. */
  sampledSpanMs: number;
  achievedSampleRateHz?: number;
  /** Event-loop blocks of the rotation that ENDED this window, measured separately (plan 7, M8). */
  stopStallMs: number;
  startStallMs: number;
  foldMs: number;
  /** Keep-alive begin() + end() cost of that rotation (already included in stopStallMs / startStallMs respectively). */
  keepAliveMs: number;
  /** The raw sample gap was negative (clamped to 0 in gapBeforeMs). Should never happen; counted, not hidden. */
  negativeGap?: boolean;
  /** true for the window closed by stop() (no restart, so startStallMs is 0). */
  final: boolean;
}

export interface SamplerOptions {
  sampleRateHz: number;
  windowMs: number;
  createSession?: () => InspectorSessionLike;
  /**
   * Rotation keep-alive factory. Defaults to createInspectorKeepAlive only when createSession is not injected (the keep-alive
   * acts on the real in-process inspector, so it only pairs with the real session); `null` disables it.
   */
  createKeepAlive?: (() => RotationKeepAlive | undefined) | null;
  /** Test hook: replaces keepAliveDisabledReason() for the default keep-alive decision. */
  keepAliveEnv?: () => string | undefined;
  fold?: FoldOptions;
  /** Called for every finished window, outside any trace. May return 'pause' to suspend sampling (backoff). Must not throw. */
  onWindow: (window: SamplerWindow) => void | 'pause';
  /** A rotation or restart failed; the sampler has already torn the session down. */
  onError: (err: unknown) => void;
  /** Monotonic ms clock; injectable for tests. */
  now?: () => number;
  wallClock?: () => number;
}

/**
 * One persistent inspector session for the process (plan 7, H1): Profiler.enable + setSamplingInterval once, then every
 * windowMs `Profiler.stop` immediately followed by `Profiler.start` on the same session, with folding moved off that critical
 * path. All timers are armed outside any trace and are unref'd. Never creates spans.
 */
export class ContinuousCpuSampler {
  private session: InspectorSessionLike | undefined;
  private keepAlive: RotationKeepAlive | undefined;
  private keepAliveCostMs = 0;
  /** Debug only: whether the rotation keep-alive is in use. */
  keepAliveState: KeepAliveState = 'off';
  keepAliveOffReason: string | undefined;
  /** Cost of the last initial start() and the last resume() (a fresh CpuProfiler: heap-proportional, not budgeted). */
  lifecycle: { startMs?: number; resumeMs?: number } = {};
  private closing = false;
  private timer: NodeJS.Timeout | undefined;
  private profiling = false;
  private rotating = false;
  private stopped = true;
  private index = 0;
  private lastSampleUs: number | undefined;
  private windowStartWall = 0;
  private readonly now: () => number;
  private readonly wall: () => number;

  constructor(private readonly opts: SamplerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.wall = opts.wallClock ?? Date.now;
  }

  get isProfiling(): boolean {
    return this.profiling;
  }

  /** Connects, enables and starts window 0. Rejects (after tearing the session down) if any step fails. */
  start(): Promise<void> {
    return runOutsideTrace(async () => {
      if (!this.stopped) return;
      this.stopped = false;
      this.lastSampleUs = undefined;
      this.closing = false;
      const t0 = this.now();
      try {
        const session = (this.opts.createSession ?? createInspectorSession)();
        this.session = session;
        session.connect();
        await this.post('Profiler.enable');
        await this.post('Profiler.setSamplingInterval', { interval: samplingIntervalUs(this.opts.sampleRateHz) });
        this.keepAlive = this.resolveKeepAlive();
        await this.beginProfile();
        this.lifecycle.startMs = this.now() - t0;
        this.arm();
      } catch (err) {
        this.teardown();
        throw err;
      }
    });
  }

  /** Suspends sampling: stops the running profile and discards it (backoff). The session stays connected. */
  pause(): Promise<void> {
    return runOutsideTrace(async () => {
      this.clearTimer();
      if (this.stopped || !this.profiling) return;
      try {
        await this.post('Profiler.stop');
      } finally {
        this.profiling = false;
      }
    });
  }

  /** Starts a new profile after pause(); the first window after it has no gapBeforeMs. */
  resume(): Promise<void> {
    return runOutsideTrace(async () => {
      if (this.stopped || this.profiling) return;
      this.lastSampleUs = undefined;
      const t0 = this.now();
      try {
        await this.beginProfile();
        this.lifecycle.resumeMs = this.now() - t0;
        this.arm();
      } catch (err) {
        this.teardown();
        throw err;
      }
    });
  }

  /** Final Profiler.stop, fold, onWindow, then disconnect. Never throws. */
  stop(): Promise<void> {
    return runOutsideTrace(async () => {
      if (this.stopped) return;
      this.stopped = true;
      this.closing = true;
      this.clearTimer();
      // let an in-flight rotation finish
      for (let i = 0; i < 1000 && this.rotating; i++) await new Promise<void>((r) => setImmediate(r));
      try {
        if (this.profiling && this.session) {
          const t0 = this.now();
          const profile = (await this.post('Profiler.stop')).profile as V8Profile;
          const stopStall = this.now() - t0;
          this.profiling = false;
          this.finishWindow(profile, stopStall, 0, true);
        }
      } catch {
        // a failing final flush during an orderly stop is not an inspector fault: no onError, no retry, no error log
      } finally {
        this.teardown();
      }
    });
  }

  private arm(): void {
    this.clearTimer();
    if (this.stopped) return;
    // armed outside any trace, unref'd: profiling never holds the process open
    this.timer = runOutsideTrace(() =>
      setTimeout(() => {
        // a rotation must never become an unhandled rejection (that would terminate a host without a handler)
        this.tick().catch((err: unknown) => {
          this.rotating = false;
          this.teardown();
          this.safe(() => this.opts.onError(err));
        });
      }, this.opts.windowMs),
    );
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.rotating || !this.profiling) return;
    this.rotating = true;
    let profile: V8Profile;
    let stopStall: number;
    let startStall = 0;
    let startError: unknown;
    let failed = false;
    try {
      const a = this.now();
      // keep-alive brackets stop+start so the CpuProfiler survives the rotation (no code re-logging, see RotationKeepAlive);
      // its own cost is counted in stopStallMs (begin) and startStallMs (end)
      this.keepAliveCostMs = 0;
      const kept = this.openKeepAlive();
      let b = a;
      try {
        profile = (await this.post('Profiler.stop')).profile as V8Profile;
        b = this.now();
        stopStall = b - a;
        this.profiling = false;
        try {
          await this.beginProfile();
        } catch (err) {
          failed = true;
          startError = err;
        }
      } finally {
        if (kept) this.closeKeepAlive();
      }
      startStall = this.now() - b;
    } catch (err) {
      this.rotating = false;
      this.profiling = false;
      this.teardown();
      this.safe(() => this.opts.onError(err));
      return;
    }
    if (!failed && !this.stopped) this.arm();
    // fold off the stop/start critical path
    await new Promise<void>((r) => setImmediate(r));
    let decision: void | 'pause';
    try {
      decision = this.finishWindow(profile, stopStall, startStall, false);
    } finally {
      this.rotating = false;
    }
    if (failed) {
      this.teardown();
      this.safe(() => this.opts.onError(startError));
      return;
    }
    if (decision === 'pause' && !this.stopped) {
      try {
        await this.pause();
      } catch (err) {
        this.teardown();
        this.safe(() => this.opts.onError(err));
      }
    }
  }

  private finishWindow(profile: V8Profile, stopStallMs: number, startStallMs: number, final: boolean): void | 'pause' {
    const d = this.now();
    let fold: FoldResult;
    try {
      fold = foldProfile(profile, this.opts.fold);
    } catch (err) {
      // foldProfile validates its input and should not throw; if it does, the window is reported as malformed (a counted
      // drop in the profiler) and the rotation loop carries on
      const why = String(err instanceof Error ? err.message : err).slice(0, 120);
      fold = { stacks: [], sampleCount: 0, idleSampleCount: 0, totalSampleCount: 0, malformed: `fold failed: ${why}` };
    }
    const foldMs = this.now() - d;
    const pStart = typeof profile?.startTime === 'number' ? profile.startTime : 0;
    const pEnd = typeof profile?.endTime === 'number' ? profile.endTime : 0;
    let gapBeforeMs: number | undefined;
    let rawGap: number | undefined;
    if (fold.firstSampleUs !== undefined && this.lastSampleUs !== undefined) {
      rawGap = (fold.firstSampleUs - this.lastSampleUs) / 1000;
      gapBeforeMs = Math.max(0, rawGap);
    }
    if (fold.lastSampleUs !== undefined) this.lastSampleUs = fold.lastSampleUs;
    const sampledSpanMs =
      fold.firstSampleUs !== undefined && fold.lastSampleUs !== undefined ? (fold.lastSampleUs - fold.firstSampleUs) / 1000 : 0;
    const achieved = achievedSampleRateHz(fold.totalSampleCount, sampledSpanMs);
    const window: SamplerWindow = {
      index: this.index++,
      periodStartMs: this.windowStartWall,
      periodEndMs: this.wall(),
      durationMs: Math.max(0, (pEnd - pStart) / 1000) || 0,
      fold,
      ...(gapBeforeMs !== undefined ? { gapBeforeMs } : {}),
      sampledSpanMs,
      ...(achieved !== undefined ? { achievedSampleRateHz: achieved } : {}),
      stopStallMs,
      startStallMs,
      foldMs,
      keepAliveMs: this.keepAliveCostMs,
      ...(rawGap !== undefined && rawGap < 0 ? { negativeGap: true } : {}),
      final,
    };
    try {
      return this.opts.onWindow(window);
    } catch (err) {
      if (final || this.closing) return;
      // tear down first so a throwing consumer cannot leave a live timer/session behind the reported error
      this.teardown();
      this.safe(() => this.opts.onError(err));
    }
  }

  private async beginProfile(): Promise<void> {
    await this.post('Profiler.start');
    this.profiling = true;
    this.windowStartWall = this.wall();
  }

  private resolveKeepAlive(): RotationKeepAlive | undefined {
    this.keepAliveOffReason = undefined;
    let factory: (() => RotationKeepAlive | undefined) | null | undefined = this.opts.createKeepAlive;
    if (factory === undefined) {
      if (this.opts.createSession) {
        this.keepAliveOffReason = 'injected session';
        factory = null;
      } else {
        const why = (this.opts.keepAliveEnv ?? keepAliveDisabledReason)();
        if (why) {
          this.keepAliveOffReason = why;
          factory = null;
        } else {
          factory = createInspectorKeepAlive;
        }
      }
    } else if (factory === null) {
      this.keepAliveOffReason = 'disabled by option';
    }
    let ka: RotationKeepAlive | undefined;
    try {
      ka = factory?.() ?? undefined;
    } catch {
      ka = undefined;
    }
    if (!ka && !this.keepAliveOffReason) this.keepAliveOffReason = 'inspector console unavailable';
    this.keepAliveState = ka ? 'active' : 'off';
    return ka;
  }

  /** false when there is no keep-alive or begin() threw: the rotation then proceeds without it (slower, still correct). */
  private openKeepAlive(): boolean {
    if (!this.keepAlive) return false;
    const t0 = this.now();
    try {
      this.keepAlive.begin();
      this.keepAliveCostMs += this.now() - t0;
      return true;
    } catch {
      this.keepAliveCostMs += this.now() - t0;
      this.keepAliveState = 'failed';
      return false;
    }
  }

  private closeKeepAlive(): void {
    const t0 = this.now();
    try {
      this.keepAlive?.end();
      this.keepAliveCostMs += this.now() - t0;
      if (this.keepAliveState === 'failed') this.keepAliveState = 'active';
    } catch {
      this.keepAliveCostMs += this.now() - t0;
      this.keepAliveState = 'failed';
      // stop using it, so a broken end() leaves at most ONE extra open profile (Profiler.disable on disconnect stops it)
      this.keepAlive = undefined;
    }
  }

  private post(method: string, params?: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const session = this.session;
      if (!session) {
        reject(new Error('inspector session is not connected'));
        return;
      }
      try {
        session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
      } catch (err) {
        reject(err);
      }
    });
  }

  private teardown(): void {
    this.clearTimer();
    this.profiling = false;
    this.stopped = true;
    const s = this.session;
    this.session = undefined;
    this.keepAlive = undefined;
    try {
      s?.disconnect();
    } catch {
      // a dead session is not worth surfacing
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // callbacks must not break the sampler
    }
  }
}
