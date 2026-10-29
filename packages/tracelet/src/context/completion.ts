import { ignoreFailure } from './settle.js';
import { getRuntime, type TraceletRuntime } from './runtime.js';
import { deferTraceCompletion } from './vendor/deferred-completion.js';
import type { TraceletSnapshot } from './vendor/trace-registry.js';

function completionStarted(rt: TraceletRuntime): void {
  rt.pendingCompletions += 1;
}

/** One completion finished (delivered to onTraceComplete, failed or abandoned): wakes whenCompletionsIdle waiters at zero. */
function completionFinished(rt: TraceletRuntime): void {
  rt.pendingCompletions -= 1;
  if (rt.pendingCompletions <= 0 && rt.idleWaiters.length > 0) {
    const waiters = rt.idleWaiters;
    rt.idleWaiters = [];
    for (const wake of waiters) ignoreFailure(wake);
  }
}

/**
 * Deferred completion of a closed root (outside any trace): pluck (waits <= 1000 ms for open spans, resolving early when the
 * last one ends), then hand the snapshot to the injected buffer hook. Never throws; a failure is a rate-limited diagnostic and
 * the registry entry is abandoned.
 */
export function scheduleCompletion(rt: TraceletRuntime, key: string): void {
  completionStarted(rt);
  try {
    deferTraceCompletion(
      async () => {
        try {
          const snapshot = await rt.registry.pluckSnapshot(key);
          if (snapshot) {
            rt.config.onTraceComplete?.(snapshot);
          }
        } catch (error) {
          ignoreFailure(() => rt.registry.abandonTrace(key));
          throw error;
        } finally {
          completionFinished(rt);
        }
      },
      rt.diagnostics,
      'trace',
    );
  } catch {
    completionFinished(rt);
    ignoreFailure(() => rt.registry.abandonTrace(key));
  }
}

/** Deferred hand-off of a ready snapshot (rootOnly failure records). */
export function scheduleSnapshot(rt: TraceletRuntime, snapshot: TraceletSnapshot): void {
  completionStarted(rt);
  try {
    deferTraceCompletion(
      async () => {
        try {
          rt.config.onTraceComplete?.(snapshot);
        } finally {
          completionFinished(rt);
        }
      },
      rt.diagnostics,
      'trace',
    );
  } catch {
    completionFinished(rt);
  }
}

/** Largest wait honoured (2^31-1 ms, about 24.8 days: the largest delay a Node timer accepts). `Infinity` means this. */
export const MAX_IDLE_WAIT_MS = 2 ** 31 - 1;

/**
 * Graceful-shutdown aid: resolves `true` when every scheduled completion has been delivered to `onTraceComplete` (or failed),
 * `false` when `timeoutMs` elapsed first (`Infinity` and anything above 2^31-1 ms are clamped to `MAX_IDLE_WAIT_MS`; NaN or negative = immediate timeout). Never rejects. Completions scheduled while waiting are awaited too. The timer is
 * ref'd on purpose (it is bounded and cleared on completion) so a shutdown that has nothing else alive still waits.
 */
export function whenCompletionsIdle(timeoutMs: number): Promise<boolean> {
  try {
    const rt = getRuntime();
    if (rt.pendingCompletions <= 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => {
          rt.idleWaiters = rt.idleWaiters.filter((w) => w !== wake);
          resolve(false);
        },
        typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) ? 0 : Math.min(Math.max(0, timeoutMs), MAX_IDLE_WAIT_MS),
      );
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      rt.idleWaiters.push(wake);
    });
  } catch {
    return Promise.resolve(false);
  }
}
