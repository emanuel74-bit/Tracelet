import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = Symbol.for('tracelet.runtime');
const g = globalThis as unknown as Record<symbol, unknown>;

describe('global slot ABI gate (shared/als.ts, plan 3.4)', () => {
  const original = g[KEY];
  afterEach(() => {
    g[KEY] = original;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('a second copy with the SAME abi shares the existing ALS and slot', async () => {
    vi.resetModules();
    const first = await import('../../../src/shared/als.js');
    const slot = first.getGlobalSlot();
    vi.resetModules();
    const second = await import('../../../src/shared/als.js');
    expect(second.isRuntimeCompatible()).toBe(true);
    expect(second.getGlobalSlot()).toBe(slot);
    expect(second.traceletAls).toBe(first.traceletAls);
  });

  it('a different abi: not shared, warns once, trace() and the instrument are pass-throughs, the first copy is untouched', async () => {
    const foreign = { abi: 999, packageVersion: '9.9.9', als: new AsyncLocalStorage() };
    g[KEY] = foreign;
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    vi.resetModules();
    const als = await import('../../../src/shared/als.js');
    expect(als.isRuntimeCompatible()).toBe(false);
    expect(als.getGlobalSlot()).not.toBe(foreign);
    expect(als.traceletAls).not.toBe(foreign.als);
    expect(g[KEY]).toBe(foreign); // the first copy's slot is left alone
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/abi=1.*abi=999/);

    const ctx = await import('../../../src/context/index.js');
    ctx.configureTracing({}); // no-op for an incompatible copy
    let calls = 0;
    expect(ctx.trace('x', () => ((calls += 1), 5))).toBe(5);
    expect(calls).toBe(1);
    expect(ctx.currentTraceId()).toBeUndefined();

    const inst = await import('../../../src/instrumentation/index.js');
    const obj = { m: () => 1 };
    expect(inst.createTraceletInstrument({ enabled: true })!.instanceDecorator(obj)).toBe(obj);
  });
});
