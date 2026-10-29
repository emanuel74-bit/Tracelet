// Ported from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec): src/protocols/deferred-trace-completion.spec.ts
// Changes: vitest imports; the Nest Logger is replaced by Tracelet's Diagnostics (warn(key, message)); only the subset that is
// vendored is kept (invokeUserCallbackSafely, deferTraceCompletion). The generateTraceIdSafely / setAttributesSafely /
// shouldIgnoreSafely / getUserIdSafely cases are dropped (those helpers belong to HTTP/job options and are not vendored).
// Two cases are added (runs outside the trace store; synchronous throw). See third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferTraceCompletion, invokeUserCallbackSafely } from '../../../src/context/vendor/deferred-completion.js';
import type { Diagnostics } from '../../../src/shared/diagnostics.js';
import { traceletAls } from '../../../src/shared/als.js';

/**
 * A new callback on every call: failures are reported once per callback, so a
 * callback shared between tests would leave the later ones nothing to report.
 */
const throwing =
  (error: unknown = new Error('callback failed')) =>
  (): never => {
    throw error;
  };

describe('invokeUserCallbackSafely', () => {
  let warn: ReturnType<typeof vi.fn>;
  let diagnostics: Diagnostics;

  beforeEach(() => {
    warn = vi.fn();
    diagnostics = { warn, error: vi.fn() } as unknown as Diagnostics;
  });

  const invoke = <TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
    args: TArgs,
    receiver: unknown = null,
  ) => invokeUserCallbackSafely(callback, args, receiver, () => 'fallback', diagnostics, 'http.ignore', 'not tracing the operation');

  it('passes the arguments and the configured receiver through', () => {
    const receiver = { prefix: 'order' };
    const callback = function (this: typeof receiver, id: number) {
      return `${this.prefix}-${id}`;
    };

    expect(invoke(callback, [42], receiver)).toBe('order-42');
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the fallback, and reports only the first failure', () => {
    const callback = throwing(new Error('no such header'));

    expect(invoke(callback, [])).toBe('fallback');
    expect(invoke(callback, [])).toBe('fallback');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'http.ignore',
      '"http.ignore" threw; not tracing the operation. Later failures are not reported: no such header',
    );
  });

  it('contains errors that cannot be formatted safely', () => {
    const callback = throwing({
      toString: () => {
        throw new Error('format failed');
      },
    });

    expect(invoke(callback, [])).toBe('fallback');
    expect(warn).toHaveBeenCalledWith('http.ignore', expect.stringContaining('an unprintable error'));
  });

  it('answers the fallback when the diagnostics sink throws as well', () => {
    diagnostics = {
      warn: () => {
        throw new Error('logger failed');
      },
      error: () => {},
    };

    expect(invoke(throwing(), [])).toBe('fallback');
  });
});

describe('deferTraceCompletion', () => {
  it('consumes rejected deferred completion and warns once', async () => {
    const warn = vi.fn();
    const diagnostics = { warn, error: vi.fn() } as unknown as Diagnostics;
    deferTraceCompletion(() => Promise.reject(new Error('completion failed')), diagnostics, 'http');
    deferTraceCompletion(() => Promise.reject(new Error('completion failed')), diagnostics, 'http');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith('deferred-http', expect.stringContaining('completion failed'));
  });

  it('added for Tracelet: the completion runs outside any trace store, even when scheduled inside one', async () => {
    const seen = await new Promise<unknown>((resolve) => {
      traceletAls.run(new Map([['#tracelet.traceId', 'inside']]), () => {
        deferTraceCompletion(
          async () => {
            resolve(traceletAls.getStore());
          },
          { warn: () => {}, error: () => {} },
          'trace',
        );
      });
    });
    expect(seen).toBeUndefined();
  });

  it('added for Tracelet: a completion that throws synchronously is contained and reported', async () => {
    const warn = vi.fn();
    deferTraceCompletion(
      () => {
        throw new Error('sync throw');
      },
      { warn, error: vi.fn() },
      'trace',
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});
