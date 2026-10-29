import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';

class MyPromise<T> extends Promise<T> {}

describe('R1 joined span settles exactly like a root (shared runAndSettle)', () => {
  let h: Harness;
  beforeEach(() => {
    h = startHarness();
  });
  afterEach(() => h.stop());

  it('sync value, sync throw, plain-promise reject, Promise subclass, own-property promise, non-native thenable', async () => {
    const results: Record<string, unknown> = {};
    await trace(
      'outer',
      async () => {
        // sync value: same value, no promise introduced
        const value = { v: 1 };
        const sync = trace('j-sync', () => value, { kind: 'custom' });
        expect(sync).toBe(value);
        expect(sync).not.toBeInstanceOf(Promise);

        // sync throw: same reference
        const thrown = new Error('sync-thrown');
        let caught: unknown;
        try {
          trace('j-throw', () => {
            throw thrown;
          });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBe(thrown);

        // plain promise rejecting: chained promise, same reason
        const rejection = new Error('rejected');
        const plain = trace('j-reject', () => Promise.reject(rejection));
        expect(plain).toBeInstanceOf(Promise);
        let rejected: unknown;
        try {
          await plain;
        } catch (e) {
          rejected = e;
        }
        expect(rejected).toBe(rejection);

        // plain promise resolving: same value
        expect(await trace('j-resolve', () => Promise.resolve('ok'))).toBe('ok');

        // Promise subclass: the SAME object is returned
        const sub = MyPromise.resolve(5);
        expect(trace('j-subclass', () => sub)).toBe(sub);
        expect(await sub).toBe(5);

        // promise with own properties: the SAME object is returned
        const decorated = Object.assign(Promise.resolve(1), { extra: true });
        expect(trace('j-own-props', () => decorated)).toBe(decorated);

        // non-native thenable: a plain value, returned untouched
        const thenable = { then: (resolve: (v: number) => void) => resolve(9) };
        expect(trace('j-thenable', () => thenable)).toBe(thenable);

        results.done = true;
      },
      { kind: 'custom' },
    );
    expect(results.done).toBe(true);
    const [item] = await h.settle();
    const ops = Object.fromEntries(item.spans.map((s) => [s.operation, s]));
    for (const name of ['j-sync', 'j-throw', 'j-reject', 'j-resolve', 'j-subclass', 'j-own-props', 'j-thenable']) {
      expect(ops[name], name).toBeDefined();
      expect(ops[name].origin).toBe('manual');
      expect(ops[name].parentSpanId).toBe(item.trace.rootSpanId);
    }
    expect(ops['j-throw'].status).toBe('error');
    expect(ops['j-throw'].sanitizedError?.message).toBe('sync-thrown');
    expect(ops['j-reject'].status).toBe('error');
    expect(ops['j-reject'].sanitizedError?.message).toBe('rejected');
    expect(ops['j-sync'].status).toBe('ok');
    expect(ops['j-resolve'].status).toBe('ok');
    expect(item.trace.status).toBe('ok'); // the outer root swallowed both errors
    expect(item.trace.errorCount).toBe(2);
  });

  for (const method of ['startManualSpan', 'endManualSpan'] as const) {
    it(`${method} throwing: fn is called exactly once and results are identical`, async () => {
      await trace(
        'outer',
        async () => {
          vi.spyOn(h.rt.registry, method).mockImplementation(() => {
            throw new Error(`${method} boom`);
          });

          let calls = 0;
          const value = { same: true };
          expect(
            trace('x-sync', () => {
              calls += 1;
              return value;
            }),
          ).toBe(value);
          expect(calls).toBe(1);

          calls = 0;
          const thrown = new Error('business');
          let caught: unknown;
          try {
            trace('x-throw', () => {
              calls += 1;
              throw thrown;
            });
          } catch (e) {
            caught = e;
          }
          expect(caught).toBe(thrown);
          expect(calls).toBe(1);

          calls = 0;
          const rejection = new Error('business-async');
          let rejected: unknown;
          try {
            await trace('x-reject', () => {
              calls += 1;
              return Promise.reject(rejection);
            });
          } catch (e) {
            rejected = e;
          }
          expect(rejected).toBe(rejection);
          expect(calls).toBe(1);

          calls = 0;
          expect(
            await trace('x-resolve', () => {
              calls += 1;
              return Promise.resolve(3);
            }),
          ).toBe(3);
          expect(calls).toBe(1);
          vi.restoreAllMocks();
        },
        { kind: 'custom' },
      );
      await h.settle();
    });
  }
});
