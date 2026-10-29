import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RollupItem, TraceItem } from '../../../src/contracts/index.js';
import { closeAllOpenRoots, configureTracing, startSweeper, stopSweeper, trace, whenCompletionsIdle, MAX_IDLE_WAIT_MS } from '../../../src/context/index.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';
import { createOrdersApp, sleep, type OrdersApp } from '../../support/instrumentation/orders-app.js';

/*
 * T17 (graceful shutdown) and O-2.
 *
 * Hard kill (SIGKILL, OOM-kill, `process.exit()` without the shutdown hooks) is UNSUPPORTED: the in-memory queue, open roots
 * and rollup accumulators are lost and nothing counts them (plan compromise 5). Nothing here can test a process that is no
 * longer running; the contract is documented in artifacts/03_INSTRUMENTATION_REPORT.md.
 */

describe('T17 graceful shutdown: open roots are closed incomplete and reach the queue before the final flush', () => {
  let h: Harness | undefined;
  let orders: OrdersApp | undefined;
  afterEach(async () => {
    stopSweeper();
    await orders?.close();
    orders = undefined;
    h?.stop();
    h = undefined;
  });

  it('closeAllOpenRoots + whenCompletionsIdle: an open root with open spans is queued as incomplete, early (not after the 1000 ms ceiling)', async () => {
    h = startHarness({ rollups: true }); // default 1000 ms pluck ceiling
    orders = await createOrdersApp();
    const business = trace('rabbitmq.consume', () => orders!.consumer.process({ id: 'm1', delayMs: 150 }), { kind: 'rabbitmq' });
    await sleep(30); // spans Validator.validate / Transformer.execute are open now
    expect(h.rt.registry.openTraceCount()).toBe(1);

    const closed = closeAllOpenRoots('shutdown');
    expect(closed).toBe(1);
    const started = performance.now();
    const idle = await whenCompletionsIdle(5000);
    const waited = performance.now() - started;
    expect(idle).toBe(true);
    // The open spans ended ~120 ms after the close; the pluck resolved at that moment, well before the 1000 ms ceiling.
    expect(waited).toBeLessThan(700);

    // Delivered to the queue the moment whenCompletionsIdle resolved: drain the queue DIRECTLY (no settle/poll in between), so an
    // implementation that resolves early leaves the queue empty and this test fails.
    h.rollups!.shutdown();
    const drained = h.queue.drain(1000, Number.MAX_SAFE_INTEGER);
    const traces = drained.filter((i): i is TraceItem => i.type === 'trace');
    const rollupItems = drained.filter((i): i is RollupItem => i.type === 'rollup');
    expect(traces).toHaveLength(1);
    const item = traces[0];
    expect(item.trace).toMatchObject({ status: 'incomplete', isComplete: false, operation: 'rabbitmq.consume' });
    expect(item.spans[0]).toMatchObject({ parentSpanId: null, status: 'incomplete', origin: 'root' });
    expect(item.trace.durationMs).toBeLessThan(150); // measured to the close, not to the business end
    expect(item.spans.length).toBeGreaterThan(1); // spans that finished during the wait are kept
    // rollup: counted once, as a (non-error) root, in the shutdown flush
    const op = rollupItems.flatMap((r) => r.operations).find((o) => o.operation === 'rabbitmq.consume')!;
    expect(op.count).toBe(1);
    expect(op.errorCount).toBe(0);

    // The business call is unaffected by the shutdown close and does not produce a second trace
    await expect(business).resolves.toMatchObject({ id: 'm1' });
    await sleep(80);
    await h.settle();
    expect(h.items).toHaveLength(0); // nothing new reached the queue after the drain
    expect(h.rt.registry.openTraceCount()).toBe(0);
  });

  it('a span that never ends is bounded by the pluck ceiling and is reported as unfinished', async () => {
    h = startHarness({ completionTimeoutMs: 150 });
    orders = await createOrdersApp();
    // a provider call that never settles
    void trace('stuck.consume', () => orders!.consumer.process({ id: 'stuck', delayMs: 10_000_000 }), { kind: 'custom' });
    await sleep(20);
    expect(closeAllOpenRoots('shutdown')).toBe(1);
    const started = performance.now();
    expect(await whenCompletionsIdle(5000)).toBe(true);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThan(900);
    await h.settle();
    expect(h.items).toHaveLength(1);
    expect(h.items[0].trace).toMatchObject({ status: 'incomplete', isComplete: false });
    expect(h.items[0].trace.unfinishedSpanCount).toBeGreaterThan(0);
  });

  it('L1 shutdown order: configureTracing({ enabled: false }) first, so roots starting after closeAllOpenRoots are never opened (otherwise they are lost)', async () => {
    h = startHarness({ completionTimeoutMs: 50 });
    // without the disable: a root that starts after closeAllOpenRoots stays in the registry, never closed or flushed
    expect(closeAllOpenRoots('shutdown')).toBe(0);
    let lateGate!: () => void;
    const late = trace('late.unflushed', () => new Promise<void>((r) => (lateGate = r)));
    expect(h.rt.registry.openTraceCount()).toBe(1);
    expect(closeAllOpenRoots('shutdown')).toBe(1); // (a second pass would catch it; the documented order avoids the window)
    lateGate();
    await late;
    await h.settle();
    h.items.length = 0;

    // the documented order
    configureTracing({ enabled: false });
    let calls = 0;
    expect(trace('after.disable', () => ((calls += 1), 'v'))).toBe('v');
    expect(calls).toBe(1);
    expect(h.rt.registry.openTraceCount()).toBe(0);
    expect(closeAllOpenRoots('shutdown')).toBe(0);
    // a partial hooks-only call does NOT re-enable tracing
    configureTracing({ onTraceComplete: () => {} });
    expect(h.rt.config.enabled).toBe(false);
    trace('still.disabled', () => 1);
    expect(h.rt.registry.openTraceCount()).toBe(0);
    // an explicit enable still works
    configureTracing({ enabled: true });
    expect(h.rt.config.enabled).toBe(true);
  });

  it('with only finished spans, shutdown completes immediately (no pluck wait)', async () => {
    h = startHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = trace('waiting.root', () => gate, { kind: 'custom' });
    expect(closeAllOpenRoots('shutdown')).toBe(1);
    const started = performance.now();
    expect(await whenCompletionsIdle(2000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
    release();
    await p;
    await h.settle();
    expect(h.items).toHaveLength(1);
    expect(h.items[0].trace.status).toBe('incomplete');
  });
});

describe('whenCompletionsIdle semantics', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.stop();
    h = undefined;
  });

  it('resolves true immediately when nothing is pending', async () => {
    h = startHarness();
    expect(h.rt.pendingCompletions).toBe(0);
    await expect(whenCompletionsIdle(10)).resolves.toBe(true);
  });

  it('resolves false when the timeout elapses first; the completion still finishes later; never rejects', async () => {
    h = startHarness({ completionTimeoutMs: 400 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // an un-awaited child span keeps the snapshot open until `release`
    const p = trace('slow', () => {
      void trace('child', () => gate, { kind: 'custom', join: true });
      return 'done';
    });
    expect(p).toBe('done');
    const started = performance.now();
    const result = await whenCompletionsIdle(60);
    expect(result).toBe(false);
    expect(performance.now() - started).toBeLessThan(300);
    expect(h.rt.pendingCompletions).toBe(1);
    expect(h.rt.idleWaiters).toHaveLength(0); // the timed-out waiter was removed
    release();
    await expect(whenCompletionsIdle(2000)).resolves.toBe(true);
    await h.settle();
    expect(h.items).toHaveLength(1);
    expect(h.items[0].trace.unfinishedSpanCount).toBe(0); // the early resolve picked up the child
  });

  it('waits for completions scheduled while it is already waiting (does not wake at the first one)', async () => {
    h = startHarness({ completionTimeoutMs: 1000 });
    trace('first', () => {
      void trace('child-a', () => sleep(100), { join: true });
    });
    expect(h.rt.pendingCompletions).toBe(1);
    const started = performance.now();
    const waiting = whenCompletionsIdle(5000);
    await sleep(30);
    trace('second', () => {
      void trace('child-b', () => sleep(150), { join: true });
    }); // scheduled while the first wait is pending
    expect(h.rt.pendingCompletions).toBe(2);
    await expect(waiting).resolves.toBe(true);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(170); // not at the first completion (~100 ms)
    const traces = h.queue.drain(100, Number.MAX_SAFE_INTEGER).filter((i) => i.type === 'trace');
    expect(traces).toHaveLength(2);
  });

  it('a throwing onTraceComplete still lets whenCompletionsIdle resolve true', async () => {
    h = startHarness({ tracing: { onTraceComplete: () => { throw new Error('mapper exploded'); } } });
    void trace('late.a', () => 1);
    void trace('late.b', async () => 2);
    await expect(whenCompletionsIdle(3000)).resolves.toBe(true);
    expect(h.rt.pendingCompletions).toBe(0);
  });

  it('L4: Infinity and values above 2^31-1 are clamped (no immediate false, no TimeoutOverflowWarning)', async () => {
    h = startHarness({ completionTimeoutMs: 300 });
    const warn = vi.spyOn(process, 'emitWarning');
    trace('inf', () => {
      void trace('child', () => sleep(120), { join: true });
    });
    await expect(whenCompletionsIdle(Number.POSITIVE_INFINITY)).resolves.toBe(true);
    trace('huge', () => {
      void trace('child', () => sleep(60), { join: true });
    });
    await expect(whenCompletionsIdle(1e15)).resolves.toBe(true);
    expect(MAX_IDLE_WAIT_MS).toBe(2 ** 31 - 1);
    expect(warn.mock.calls.filter((c) => /TimeoutOverflow/.test(String((c[1] as { type?: string } | string | undefined) ?? c[0])))).toHaveLength(0);
    warn.mockRestore();
  });

  it('a NaN or negative timeout resolves false without throwing when work is pending', async () => {
    h = startHarness({ completionTimeoutMs: 300 });
    trace('pending', () => {
      void trace('child', () => sleep(150), { join: true });
    });
    await expect(whenCompletionsIdle(Number.NaN)).resolves.toBe(false);
    await expect(whenCompletionsIdle(-5)).resolves.toBe(false);
    await expect(whenCompletionsIdle(2000)).resolves.toBe(true);
  });
});

describe('O-2: early pluck resolve', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.stop();
    h = undefined;
  });

  it('resolves when the LAST open span ends, still bounded by the ceiling', async () => {
    h = startHarness(); // default 1000 ms ceiling
    const t0 = performance.now();
    trace('root', () => {
      void trace('c1', () => sleep(40), { join: true });
      void trace('c2', () => sleep(90), { join: true });
    });
    await h.settle();
    const elapsed = performance.now() - t0;
    expect(h.items).toHaveLength(1);
    expect(h.items[0].trace.unfinishedSpanCount).toBe(0);
    expect(h.items[0].spans.map((s) => s.operation).sort()).toEqual(['c1', 'c2', 'root']);
    expect(elapsed).toBeLessThan(600); // before: always 1000 ms
  });

  it('the ceiling still applies when a span never ends', async () => {
    h = startHarness({ completionTimeoutMs: 200 });
    const t0 = performance.now();
    trace('root', () => {
      void trace('ends', () => sleep(20), { join: true });
      void trace('never', () => new Promise<void>(() => {}), { join: true });
    });
    await h.settle();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(900);
    expect(h.items[0].trace.unfinishedSpanCount).toBe(1);
    expect(h.items[0].trace.isComplete).toBe(false);
  });

  it('the pluck timer is unref\'d (a waiting pluck never keeps the process alive)', async () => {
    const MARK = 4321;
    h = startHarness({ completionTimeoutMs: MARK });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    trace('root', () => {
      void trace('child', () => sleep(30), { join: true });
    });
    await h.settle();
    const pluckTimers = spy.mock.calls
      .map((args, i) => ({ delay: args[1], timer: spy.mock.results[i].value as NodeJS.Timeout }))
      .filter((c) => c.delay === MARK);
    spy.mockRestore();
    expect(pluckTimers).toHaveLength(1);
    expect(pluckTimers[0].timer.hasRef()).toBe(false);
  });

  it('the sweeper timer is unref\'d and closes expired roots as incomplete', async () => {
    h = startHarness({ tracing: { maxTraceDurationMs: 40 }, completionTimeoutMs: 30 });
    startSweeper(15);
    let release!: () => void;
    const p = trace('long', () => new Promise<void>((r) => (release = r)));
    await sleep(120);
    release();
    await p;
    await h.settle();
    expect(h.items).toHaveLength(1);
    expect(h.items[0].trace.status).toBe('incomplete');
    expect(h.rt.sweeperTimer?.hasRef()).toBe(false);
  });
});
