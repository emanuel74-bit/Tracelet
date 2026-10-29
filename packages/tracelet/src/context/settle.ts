// The one settle routine used by roots and joined spans (plan 3.5, R1). Pattern from nestjs/observe@7500fba
// `create-instance-decorator.instrument.ts:182-213` (MIT, Copyright (c) 2017-present Kamil Mysliwiec), with `.then(ok, err)`.

/** Runs telemetry bookkeeping whose failure must not reach the caller. */
export function ignoreFailure(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // The telemetry is a side effect of the call, not part of its outcome.
  }
}

/** Like ignoreFailure but returns the value (undefined on failure). */
export function tryValue<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Whether a promise is a bare native one: no subclass, no members of its own. Symbol keys do not count: before Node 24,
 * AsyncLocalStorage stamps its own symbols on every promise created in a context.
 */
export function isPlainPromise(promise: Promise<unknown>): boolean {
  return Object.getPrototypeOf(promise) === Promise.prototype && Object.getOwnPropertyNames(promise).length === 0;
}

/**
 * Invokes `fn` exactly once (single call site) and settles through `onOk`/`onErr`:
 * - sync value: returned as is; sync throw: same reference rethrown;
 * - plain native Promise: replaced by a chained promise (same value / same rejection reason);
 * - Promise subclass or promise with own properties: returned as is, watched on a side branch;
 * - thenable that is not a native Promise: a plain value (settled at return time).
 * `onOk`/`onErr` failures are swallowed.
 */
export function runAndSettle<T>(fn: () => T, onOk: (value: unknown) => void, onErr: (error: unknown) => void): T {
  let result: T;
  try {
    result = fn();
  } catch (err) {
    ignoreFailure(() => onErr(err));
    throw err;
  }
  // Detection and the side branch run after fn with no other guard: a hostile result (a Proxy whose getPrototypeOf throws, a
  // promise-like with a throwing getter) must never reach the business code. If anything here throws, the result is
  // treated as a plain value (R-1).
  try {
    if (result instanceof Promise) {
      const settled = (value: unknown) => {
        ignoreFailure(() => onOk(value));
        return value;
      };
      const failed = (err: unknown) => {
        ignoreFailure(() => onErr(err));
        throw err;
      };
      if (isPlainPromise(result)) {
        return result.then(settled, failed) as T;
      }
      // Watching marks it handled; the telemetry still records the outcome.
      result.then(settled, (err) => ignoreFailure(() => onErr(err)));
      return result;
    }
  } catch {
    // fall through: plain value
  }
  ignoreFailure(() => onOk(result));
  return result;
}
