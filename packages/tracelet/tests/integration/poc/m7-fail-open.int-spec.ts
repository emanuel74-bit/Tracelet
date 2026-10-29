import { types } from 'node:util';
import { Injectable, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentTraceId, resetRuntimeForTesting, trace } from '../../../src/context/index.js';
import { createDiagnostics } from '../../../src/shared/index.js';
import { FakeAmqpChannel, type FakeMessage } from '../../support/instrumentation/fake-amqp-channel.js';
import { createAppFor, createOrdersApp, type OrderMsg } from '../../support/instrumentation/orders-app.js';
import { startHarness } from '../../support/instrumentation/harness.js';

const transformError = new Error('m7 transform');
const syncError = new Error('m7 sync');
const silent = createDiagnostics('m7', () => {});

const MESSAGES: OrderMsg[] = [
  { id: 'a-ok' },
  { id: 'b-async-fail', fail: 'transform', error: transformError },
  { id: 'c-sync-fail', fail: 'sync', error: syncError },
  { id: 'd-ok' },
];

interface Outcome {
  ackLog: string[];
  outcomes: Record<string, string>;
  caught: Record<string, unknown>;
}

async function scenario(
  setup: (h: ReturnType<typeof startHarness>) => (() => number) | void,
  enabled: boolean,
): Promise<Outcome & { injectedCalls: number }> {
  const h = startHarness({ tracing: { enabled }, runtime: { diagnostics: silent }, completionTimeoutMs: 50 });
  const injectedCalls = setup(h);
  const app = await createOrdersApp({ enabled });
  const channel = new FakeAmqpChannel();
  const outcomes: Record<string, string> = {};
  const caught: Record<string, unknown> = {};
  const finished = new Map<string, () => void>();
  channel.consume('orders', async (msg: FakeMessage) => {
    try {
      // a joined nested trace() inside the consume root exercises startManualSpan/endManualSpan
      const result = await trace(
        'rabbitmq.consume',
        () =>
          trace(
            'inner',
            () => {
              app.validator.validateSync({ id: (msg.content as OrderMsg).id }); // sync provider on the ok path
              return app.consumer.process(msg.content as OrderMsg);
            },
            { kind: 'custom' },
          ),
        { kind: 'rabbitmq' },
      );
      outcomes[msg.id] = `ok:${JSON.stringify(result)}`;
      channel.ack(msg);
    } catch (error) {
      outcomes[msg.id] = `err:${(error as Error).message}`;
      caught[msg.id] = error;
      channel.nack(msg, false, false);
    }
    finished.get(msg.id)?.();
  });
  for (const content of MESSAGES) {
    await new Promise<void>((resolve) => {
      finished.set(content.id, resolve);
      channel.publish('orders', { id: content.id, content });
    });
  }
  await new Promise((r) => setTimeout(r, 120)); // let deferred completions (and their failures) happen
  await app.close();
  h.stop();
  return { ackLog: channel.logLines(), outcomes, caught, injectedCalls: injectedCalls ? injectedCalls() : -1 };
}

const FAILING_REGISTRY_METHODS = [
  'startRoot',
  'endRoot',
  'internalStartTraceStep',
  'internalEndTraceStep',
  'startManualSpan',
  'endManualSpan',
  'pluckSnapshot',
] as const;

describe('M7 fail-open: a Tracelet failure never changes business results, throws or acks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeForTesting();
  });

  for (const method of FAILING_REGISTRY_METHODS) {
    it(`registry.${method} throws on every call`, async () => {
      const baseline = await scenario(() => {}, false);
      const failing = await scenario((h) => {
        const spy = vi.spyOn(h.rt.registry, method).mockImplementation(() => {
          throw new Error(`injected ${method} failure`);
        });
        return () => spy.mock.calls.length;
      }, true);
      expect(failing.injectedCalls, 'the injected failure was actually exercised').toBeGreaterThan(0);
      expect(failing.ackLog).toEqual(baseline.ackLog);
      expect(failing.outcomes).toEqual(baseline.outcomes);
      expect(failing.caught['b-async-fail']).toBe(transformError);
      expect(failing.caught['c-sync-fail']).toBe(syncError);
    });
  }

  it('the counter sink throws on every count()', async () => {
    const baseline = await scenario(() => {}, false);
    const failing = await scenario((h) => {
      let calls = 0;
      h.rt.sink = {
        count() {
          calls += 1;
          throw new Error('injected sink failure');
        },
      };
      return () => calls;
    }, true);
    expect(failing.injectedCalls).toBeGreaterThan(0);
    expect(failing.ackLog).toEqual(baseline.ackLog);
    expect(failing.outcomes).toEqual(baseline.outcomes);
    expect(failing.caught['b-async-fail']).toBe(transformError);
  });

  it('the onTraceComplete hook (mapper/offer) throws', async () => {
    const baseline = await scenario(() => {}, false);
    const failing = await scenario((h) => {
      let calls = 0;
      h.rt.config.onTraceComplete = () => {
        calls += 1;
        throw new Error('injected mapper failure');
      };
      return () => calls;
    }, true);
    expect(failing.injectedCalls).toBeGreaterThan(0);
    expect(failing.ackLog).toEqual(baseline.ackLog);
    expect(failing.outcomes).toEqual(baseline.outcomes);
  });

  for (const method of ['internalStartTraceStep', 'internalEndTraceStep', 'startRoot', 'startManualSpan'] as const) {
    it(`the active flag is not left stuck: once registry.${method} recovers, calls are traced again`, async () => {
      const h = startHarness({ runtime: { diagnostics: silent }, completionTimeoutMs: 50 });
      const app = await createOrdersApp({ enabled: true });
      const spy = vi.spyOn(h.rt.registry, method).mockImplementation(() => {
        throw new Error('injected');
      });
      const failedRun = await trace('during-failure', () => app.consumer.process({ id: 'x' }), { kind: 'custom' });
      expect(failedRun.id).toBe('x'); // business result intact while failing
      spy.mockRestore();
      await trace('after-recovery', () => app.consumer.process({ id: 'y' }), { kind: 'custom' });
      const items = await h.settle();
      const recovered = items.find((i) => i.trace.operation === 'after-recovery')!;
      expect(recovered).toBeDefined();
      expect(recovered.trace.spanCount).toBe(7); // every provider call traced again (re-entrancy flag was released)
      await app.close();
      h.stop();
    });
  }

  it('(i) a throwing skipInstrumentation boots and every instance comes back untouched', async () => {
    startHarness();
    @Injectable()
    class Plain {
      value(): number {
        return 7;
      }
    }
    @Module({ providers: [Plain] })
    class SkipThrowsModule {}
    const app = await createAppFor(SkipThrowsModule, {
      enabled: true,
      skipInstrumentation: () => {
        throw new Error('skip predicate failure');
      },
    });
    expect(types.isProxy(app.get(Plain))).toBe(false); // a throwing predicate means skip
    expect(app.get(Plain).value()).toBe(7);
    await app.close();
  });

  it('(ii) a provider whose prototype getter throws boots (skipped by the guard) and a normal provider is still proxied', async () => {
    startHarness();
    @Injectable()
    class Plain {
      value(): number {
        return 7;
      }
    }
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype getter');
        },
      },
    );
    @Module({ providers: [Plain, { provide: 'HOSTILE', useFactory: () => hostile }] })
    class HostileModule {}
    const app = await createAppFor(HostileModule, { enabled: true, skipInstrumentation: () => false });
    expect(types.isProxy(app.get(Plain))).toBe(true); // proxied, so the boot really went through the decorator
    expect(app.get(Plain).value()).toBe(7);
    expect(app.get('HOSTILE')).toBeDefined();
    await app.close();
  });
});

/* R-1: a hostile return value must not break detection/side-branch code that runs after fn. */
describe('M7 fail-open: hostile return values (R-1)', () => {
  afterEach(() => resetRuntimeForTesting());

  const hostile = () =>
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('no ctx');
        },
      },
    );

  @Injectable()
  class Returns {
    give(value: unknown): unknown {
      return value;
    }
  }
  @Module({ providers: [Returns] })
  class ReturnsModule {}

  it('roots, joined spans and provider calls return the hostile value untouched and still settle', async () => {
    const h = startHarness({ completionTimeoutMs: 20 });
    const app = await createAppFor(ReturnsModule, { enabled: true });
    const svc = app.get(Returns);
    const value = hostile();

    const fromRoot = trace('hostile-root', () => value, { kind: 'custom' });
    expect(fromRoot).toBe(value);

    let fromJoined: unknown;
    let fromProvider: unknown;
    trace(
      'outer',
      () => {
        fromJoined = trace('hostile-joined', () => value);
        fromProvider = svc.give(value);
      },
      { kind: 'custom' },
    );
    expect(fromJoined).toBe(value);
    expect(fromProvider).toBe(value);

    const items = await h.settle();
    expect(items.map((i) => i.trace.operation).sort()).toEqual(['hostile-root', 'outer']);
    const outer = items.find((i) => i.trace.operation === 'outer')!;
    expect(outer.spans.map((s) => s.operation).sort()).toEqual(['Returns.give', 'hostile-joined', 'outer']);
    expect(h.rt.registry.openTraceCount()).toBe(0); // the root settled; nothing leaked
    await app.close();
  });
});

/* R-2: the proxy get trap reads the property exactly once. */
describe('instance proxy getters run exactly once (R-2)', () => {
  afterEach(() => resetRuntimeForTesting());

  it('plain getter: one call; throwing getter: one call and the original error', async () => {
    startHarness();
    const counts = { plain: 0, throwing: 0 };
    const boom = new Error('getter boom');
    @Injectable()
    class WithGetters {
      get plain(): number {
        counts.plain += 1;
        return 5;
      }
      get throwing(): number {
        counts.throwing += 1;
        throw boom;
      }
    }
    @Module({ providers: [WithGetters] })
    class GettersModule {}
    const app = await createAppFor(GettersModule, { enabled: true });
    const svc = app.get(WithGetters);
    expect(types.isProxy(svc)).toBe(true);
    counts.plain = 0;
    counts.throwing = 0;
    expect(svc.plain).toBe(5);
    expect(counts.plain).toBe(1);
    let caught: unknown;
    try {
      void svc.throwing;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(counts.throwing).toBe(1);
    await app.close();
  });
});

/* R-5: a root refused by the span budget is an admission refusal, not a pass-through in the caller's store. */
describe('root refused by maxOpenSpans (R-5)', () => {
  afterEach(() => resetRuntimeForTesting());

  it('gets a fresh unsampled store, is counted and reaches onRootSettled', async () => {
    const settled: string[] = [];
    const h = startHarness({ tracing: { maxOpenSpans: 1, onRootSettled: (e) => settled.push(`${e.name}:${e.sampled}`) } });
    // startHarness overrides onTraceComplete only; keep the rollup hook set above
    let outerId: string | undefined;
    let innerId: string | undefined = 'unset';
    trace(
      'setup',
      () => {
        outerId = currentTraceId();
        trace(
          'rabbitmq.consume',
          () => {
            innerId = currentTraceId();
          },
          { kind: 'rabbitmq' },
        );
      },
      { kind: 'custom' },
    );
    expect(outerId).toBeDefined();
    expect(innerId).toBeUndefined(); // never setup's id (R3/L6)
    expect(settled).toContain('rabbitmq.consume:false');
    expect(h.queue.counters().tracesDroppedAdmission).toBe(1);
    await h.settle();
  });
});
