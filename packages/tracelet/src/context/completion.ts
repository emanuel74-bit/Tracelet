import { ignoreFailure } from './settle.js';
import type { TraceletRuntime } from './runtime.js';
import { deferTraceCompletion } from './vendor/deferred-completion.js';
import type { TraceletSnapshot } from './vendor/trace-registry.js';

/**
 * Deferred completion of a closed root (outside any trace): pluck (waits <= 1000 ms for open spans), then hand the snapshot to
 * the injected buffer hook. Never throws; a failure is a rate-limited diagnostic and the registry entry is abandoned.
 */
export function scheduleCompletion(rt: TraceletRuntime, key: string): void {
  rt.pendingCompletions += 1;
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
          rt.pendingCompletions -= 1;
        }
      },
      rt.diagnostics,
      'trace',
    );
  } catch {
    rt.pendingCompletions -= 1;
    ignoreFailure(() => rt.registry.abandonTrace(key));
  }
}

/** Deferred hand-off of a ready snapshot (rootOnly failure records). */
export function scheduleSnapshot(rt: TraceletRuntime, snapshot: TraceletSnapshot): void {
  rt.pendingCompletions += 1;
  try {
    deferTraceCompletion(
      async () => {
        try {
          rt.config.onTraceComplete?.(snapshot);
        } finally {
          rt.pendingCompletions -= 1;
        }
      },
      rt.diagnostics,
      'trace',
    );
  } catch {
    rt.pendingCompletions -= 1;
  }
}
