// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import { runOutsideTrace } from '../../shared/als.js';
import type { Diagnostics } from '../../shared/diagnostics.js';

const reportedCallbacks = new WeakSet<Function>();
const reportedDeferredFailures = new WeakSet<object>();

export function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an unprintable error';
  }
}

export function warnSafely(diagnostics: Diagnostics, key: string, message: string): void {
  try {
    diagnostics.warn(key, message);
  } catch {
    // Diagnostics must not become another failure in the operation traced - or in its deferred telemetry.
  }
}

/**
 * Runs a callback from the module options, answering `fallback()` when it throws. The first failure of each callback is
 * reported with its error and `outcome`, what was given up for it; later ones are not.
 */
export function invokeUserCallbackSafely<TArgs extends unknown[], TResult, TFallback>(
  callback: (...args: TArgs) => TResult,
  args: TArgs,
  receiver: unknown,
  fallback: () => TFallback,
  diagnostics: Diagnostics,
  name: string,
  outcome: string,
): TResult | TFallback {
  try {
    return callback.apply(receiver, args);
  } catch (error) {
    if (!reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      warnSafely(diagnostics, name, `"${name}" threw; ${outcome}. Later failures are not reported: ${describeFailure(error)}`);
    }
    return fallback();
  }
}

/**
 * Run deferred completion without ever leaking a rejection from its timer. The timer is armed inside runOutsideTrace so the
 * completion (pluck, mapping, queue offer) never sees a trace store (plan 3.5).
 */
export function deferTraceCompletion(completion: () => Promise<void>, diagnostics: Diagnostics, transport: string): void {
  runOutsideTrace(() =>
    setTimeout(() => {
      void Promise.resolve()
        .then(completion)
        .catch((error: unknown) => {
          if (!reportedDeferredFailures.has(diagnostics)) {
            reportedDeferredFailures.add(diagnostics);
            warnSafely(
              diagnostics,
              `deferred-${transport}`,
              `Deferred ${transport} trace completion failed; later failures are not reported: ${describeFailure(error)}`,
            );
          }
        });
    }, 0),
  );
}
