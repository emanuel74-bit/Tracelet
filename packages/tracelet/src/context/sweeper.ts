import { runOutsideTrace } from '../shared/als.js';
import { scheduleCompletion } from './completion.js';
import { getRuntime, recordRootOnce, type TraceletRuntime } from './runtime.js';
import { ignoreFailure } from './settle.js';
import type { EndedRoot } from './vendor/trace-registry.js';

export const SWEEP_INTERVAL_MS = 10_000;

function finish(rt: TraceletRuntime, closed: EndedRoot[]): number {
  for (const ended of closed) {
    ignoreFailure(() =>
      recordRootOnce(rt, ended.token, {
        name: ended.name,
        kind: ended.kind,
        sampled: true,
        status: 'incomplete',
        durationMs: ended.durationMs,
      }),
    );
    scheduleCompletion(rt, ended.key);
  }
  return closed.length;
}

/** One sweep: force-closes roots older than maxTraceDurationMs as 'incomplete'. Returns how many were closed. Never throws. */
export function sweepOnce(rt: TraceletRuntime = getRuntime()): number {
  try {
    return finish(rt, rt.registry.closeExpired(rt.config.maxTraceDurationMs));
  } catch {
    return 0;
  }
}

/** Shutdown: force-closes every open root (status 'incomplete'). Returns how many were closed. Never throws. */
export function closeAllOpenRoots(reason: 'timeout' | 'shutdown' = 'shutdown'): number {
  try {
    const rt = getRuntime();
    return finish(rt, rt.registry.closeAllOpenRoots(reason));
  } catch {
    return 0;
  }
}

/** Every 10 s (unref'd, armed outside any trace). */
export function startSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  try {
    const rt = getRuntime();
    if (rt.sweeperTimer) return;
    rt.sweeperTimer = runOutsideTrace(() => {
      const timer = setInterval(() => {
        sweepOnce(rt);
      }, intervalMs);
      timer.unref();
      return timer;
    });
  } catch {
    // never throws
  }
}

export function stopSweeper(): void {
  try {
    const rt = getRuntime();
    if (rt.sweeperTimer) {
      clearInterval(rt.sweeperTimer);
      rt.sweeperTimer = undefined;
    }
  } catch {
    // never throws
  }
}
