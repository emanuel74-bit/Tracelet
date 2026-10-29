import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTraceletInstrument } from '../../../src/instrumentation/index.js';
import type { TraceletInstrumentOptions } from '../../../src/contracts/index.js';
import { createOrdersApp, OrdersConsumer } from '../../support/instrumentation/orders-app.js';
import { resetRuntimeForTesting } from '../../../src/context/index.js';

class Svc {
  m(): number {
    return 1;
  }
}

const KEYS = ['NODE_ENV', 'TRACELET_DISABLED', 'TRACELET_ENABLED'] as const;

describe('R10/R11 the enable decision is evaluated at each decoration', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetRuntimeForTesting();
  });

  const decorate = (opts?: TraceletInstrumentOptions, instance: object = new Svc()): { instance: object; out: unknown } => ({
    instance,
    out: createTraceletInstrument(opts)!.instanceDecorator(instance),
  });

  it('NODE_ENV unset (= production) and nothing explicit: instances are returned untouched', () => {
    const { instance, out } = decorate();
    expect(out).toBe(instance);
  });

  it('NODE_ENV=production, staging, empty: untouched', () => {
    for (const env of ['production', 'staging', 'prod', '']) {
      process.env.NODE_ENV = env;
      const { instance, out } = decorate();
      expect(out, `NODE_ENV=${env}`).toBe(instance);
    }
  });

  it('TRACELET_DISABLED=1 wins over everything', () => {
    process.env.NODE_ENV = 'test';
    process.env.TRACELET_DISABLED = '1';
    process.env.TRACELET_ENABLED = 'true';
    const { instance, out } = decorate({ enabled: true });
    expect(out).toBe(instance);
  });

  it('enabled:false is untouched even in NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    const { instance, out } = decorate({ enabled: false });
    expect(out).toBe(instance);
  });

  it('NODE_ENV=test or development proxies', () => {
    for (const env of ['test', 'development']) {
      process.env.NODE_ENV = env;
      const { instance, out } = decorate();
      expect(out, `NODE_ENV=${env}`).not.toBe(instance);
      expect((out as Svc).m()).toBe(1);
    }
  });

  it('enabled:true proxies with NODE_ENV unset; TRACELET_ENABLED=true proxies with NODE_ENV unset', () => {
    const a = decorate({ enabled: true });
    expect(a.out).not.toBe(a.instance);
    process.env.TRACELET_ENABLED = 'true';
    const b = decorate();
    expect(b.out).not.toBe(b.instance);
    process.env.TRACELET_ENABLED = 'false';
    process.env.NODE_ENV = 'test';
    const c = decorate();
    expect(c.out).toBe(c.instance); // TRACELET_ENABLED=false beats the dev/test default
    delete process.env.TRACELET_ENABLED;
    const d = decorate({ enabled: true });
    process.env.NODE_ENV = 'production';
    expect(d.out).not.toBe(d.instance); // explicit option beats NODE_ENV
  });

  it('the decision is re-evaluated on every decoration', () => {
    const instrument = createTraceletInstrument();
    const first = new Svc();
    expect(instrument!.instanceDecorator(first)).toBe(first);
    process.env.NODE_ENV = 'test';
    const second = new Svc();
    expect(instrument!.instanceDecorator(second)).not.toBe(second);
    delete process.env.NODE_ENV;
    const third = new Svc();
    expect(instrument!.instanceDecorator(third)).toBe(third);
  });

  it('skipInstrumentation from the instrument options is honoured; a throwing predicate counts as skip', () => {
    process.env.NODE_ENV = 'test';
    const skipped = decorate({ skipInstrumentation: (i) => i instanceof Svc });
    expect(skipped.out).toBe(skipped.instance);
    const other = decorate({ skipInstrumentation: (i) => i instanceof Date });
    expect(other.out).not.toBe(other.instance);
    const throwing = decorate({
      skipInstrumentation: () => {
        throw new Error('nope');
      },
    });
    expect(throwing.out).toBe(throwing.instance);
  });

  it('through NestFactory: enabled:false returns the real instance, enabled:true a proxy', async () => {
    const off = await createOrdersApp({ enabled: false });
    const on = await createOrdersApp({ enabled: true });
    // The proxy is a different object than the raw provider; both behave the same.
    expect(off.app.get(OrdersConsumer)).not.toBe(on.app.get(OrdersConsumer));
    expect(await off.consumer.process({ id: 'q' })).toEqual(await on.consumer.process({ id: 'q' }));
    await off.close();
    await on.close();
  });
});
