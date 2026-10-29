import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceletAls } from '../../../src/shared/als.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import {
  bucketIndex,
  emptyHistogram,
  MAX_ROLLUP_METHODS,
  MAX_ROLLUP_OPERATIONS,
  RollupAccumulator,
  ROLLUP_FLUSH_INTERVAL_MS,
  type RollupAccumulatorOptions,
} from '../../../src/buffer/index.js';
import { HISTOGRAM_BOUNDS_MS, type ObserveSpan, type RollupItem, type TelemetryItem, type TraceItem } from '../../../src/contracts/index.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function setup(over: Partial<RollupAccumulatorOptions> = {}) {
  const state = { clock: T0 };
  const offered: RollupItem[] = [];
  const acc = new RollupAccumulator({
    serviceName: 'svc',
    instanceId: 'inst-1',
    now: () => state.clock,
    offer: (item: TelemetryItem) => {
      offered.push(item as RollupItem);
      return true;
    },
    defer: () => {},
    ...over,
  });
  return { state, offered, acc };
}
const root = (name: string, durationMs: number, extra: { status?: 'ok' | 'error' | 'incomplete'; sampled?: boolean } = {}) => ({
  name,
  kind: 'rabbitmq' as const,
  sampled: extra.sampled ?? true,
  status: extra.status ?? ('ok' as const),
  durationMs,
});

describe('histogram', () => {
  it('bucket upper bounds are inclusive, 16 buckets', () => {
    expect(emptyHistogram()).toHaveLength(16);
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(1)).toBe(0);
    expect(bucketIndex(1.0001)).toBe(1);
    expect(bucketIndex(2)).toBe(1);
    expect(bucketIndex(5)).toBe(2);
    expect(bucketIndex(5.1)).toBe(3);
    expect(bucketIndex(60000)).toBe(14);
    expect(bucketIndex(60000.1)).toBe(15);
    expect(bucketIndex(Number.MAX_SAFE_INTEGER)).toBe(15);
    expect(bucketIndex(Number.NaN)).toBe(0);
    expect(bucketIndex(-5)).toBe(0);
    for (let i = 0; i < HISTOGRAM_BOUNDS_MS.length - 1; i++) expect(bucketIndex(HISTOGRAM_BOUNDS_MS[i])).toBe(i);
  });
});

describe('RollupAccumulator', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema as object);
  const id = (schema as { $id: string }).$id;
  const validOp = ajv.getSchema(id + '#/$defs/OperationRollup')!;
  const validMethod = ajv.getSchema(id + '#/$defs/MethodRollup')!;

  afterEach(() => vi.useRealTimers());

  it('aggregates every settled root (sampled or not) per operation and kind; one full item per dirty bucket', () => {
    const { acc, offered } = setup();
    acc.recordRoot(root('rabbitmq.consume', 3));
    acc.recordRoot(root('rabbitmq.consume', 40, { status: 'error' }));
    acc.recordRoot(root('rabbitmq.consume', 700, { sampled: false }));
    acc.recordRoot({ ...root('other', 1), kind: 'custom' });
    expect(acc.flush()).toBe(1);
    expect(offered).toHaveLength(1);
    const item = offered[0];
    expect(item.type).toBe('rollup');
    expect(item.operations).toHaveLength(2);
    const op = item.operations.find((o) => o.operation === 'rabbitmq.consume')!;
    expect(op).toMatchObject({ count: 3, errorCount: 1, sampledCount: 2, durationMaxMs: 700, bucketStart: new Date(T0).toISOString(), bucketMs: 60000 });
    expect(op.durationSumMs).toBeCloseTo(743, 6);
    expect(op.histogram.reduce((a, b) => a + b, 0)).toBe(3);
    expect(op.histogram[2]).toBe(1); // 3 ms -> <= 5
    expect(op.histogram[5]).toBe(1); // 40 ms -> <= 50
    expect(op.histogram[9]).toBe(1); // 700 ms -> <= 1000
    for (const o of item.operations) expect(validOp(o), JSON.stringify(validOp.errors)).toBe(true);
    expect(item.estimatedBytes).toBeGreaterThan(0);
  });

  it('items hold FULL aggregates, never deltas; clean buckets are not re-offered; empty items are never offered', () => {
    const { acc, offered } = setup();
    expect(acc.flush()).toBe(0);
    expect(offered).toHaveLength(0);
    acc.recordRoot(root('a', 1));
    acc.flush();
    expect(acc.flush()).toBe(0); // not dirty
    acc.recordRoot(root('a', 1));
    acc.flush();
    expect(offered).toHaveLength(2);
    expect(offered[0].operations[0].count).toBe(1);
    expect(offered[1].operations[0].count).toBe(2); // full replacement, not a delta
  });

  it('one item per dirty bucket, each covering exactly one minute; keeps current + 2 previous, then evicts after offering', () => {
    const { acc, offered, state } = setup();
    for (let m = 0; m < 3; m++) {
      state.clock = T0 + m * MINUTE;
      acc.recordRoot(root(`op-${m}`, 1));
    }
    expect(acc.bucketCount()).toBe(3);
    // each of the three buckets was dirtied by its own root and is still kept
    state.clock = T0 + 2 * MINUTE + 1000;
    expect(acc.flush()).toBe(3);
    expect(new Set(offered.map((o) => o.operations[0].bucketStart)).size).toBe(3);
    offered.length = 0;
    state.clock = T0 + 3 * MINUTE; // minute 0 is now older than current - 2
    acc.recordRoot(root('op-3', 1));
    expect(acc.flush()).toBe(1); // only the new bucket is dirty
    expect(acc.bucketCount()).toBe(3); // minute 0 evicted
  });

  it('R9 cadence: unref timer flushes every flushIntervalMs; minute close flushes via the defer seam; shutdown flushes once', () => {
    vi.useFakeTimers();
    const deferred: Array<() => void> = [];
    const { acc, offered, state } = setup({ flushIntervalMs: 50, defer: (fn) => deferred.push(fn) });
    acc.start();
    acc.start(); // idempotent
    acc.recordRoot(root('a', 1));
    vi.advanceTimersByTime(49);
    expect(offered).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(offered).toHaveLength(1);
    // minute rolls over -> a close flush is scheduled (not run inline: recordRoot stays O(1))
    state.clock = T0 + MINUTE + 5;
    acc.recordRoot(root('b', 1));
    expect(offered).toHaveLength(1);
    expect(deferred).toHaveLength(1);
    acc.recordRoot(root('b', 1));
    expect(deferred).toHaveLength(1); // scheduled once
    deferred[0]();
    expect(offered).toHaveLength(2);
    acc.recordRoot(root('b', 1));
    expect(acc.shutdown()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(offered).toHaveLength(3); // the timer is gone after shutdown
  });

  it('the production timer is unref\'d, armed outside any trace, and the cadence constant is 10 s', () => {
    expect(ROLLUP_FLUSH_INTERVAL_MS).toBe(10_000);
    const { acc } = setup();
    const spy = vi.spyOn(globalThis, 'setInterval');
    acc.start();
    const timer = spy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
    acc.shutdown();
  });


  it('rows are unique by the storage _id (freeze 4): auto vs manual same operation, and long names sharing 256 chars', () => {
    const { acc, offered } = setup();
    const sha = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);
    const longA = 'x'.repeat(256) + 'A';
    const longB = 'x'.repeat(256) + 'B';
    acc.recordRoot(root(longA, 1));
    acc.recordRoot(root(longB, 2));
    acc.recordRoot({ ...root(longA, 3), kind: 'custom' }); // same cut name, other kind: a different _id
    acc.recordSpans(
      traceItem(T0, 10, [
        { spanId: 'a', traceId: 't', parentSpanId: 'r', operation: 'A.b', origin: 'auto', className: 'A', method: 'b', startOffsetMs: 1, durationMs: 4, selfDurationMs: 4, status: 'ok' },
        { spanId: 'm', traceId: 't', parentSpanId: 'r', operation: 'A.b', origin: 'manual', startOffsetMs: 2, durationMs: 6, status: 'error' },
        { spanId: 'l1', traceId: 't', parentSpanId: 'r', operation: longA, origin: 'manual', startOffsetMs: 3, durationMs: 1, status: 'ok' },
        { spanId: 'l2', traceId: 't', parentSpanId: 'r', operation: longB, origin: 'manual', startOffsetMs: 4, durationMs: 1, status: 'ok' },
      ]),
    );
    acc.flush();
    const item = offered[0];
    const opIds = item.operations.map((o) => `${o.instanceId}|${Date.parse(o.bucketStart)}|${sha(o.operation + ' ' + o.kind)}`);
    const methodIds = item.methods.map((m) => `${m.instanceId}|${Date.parse(m.bucketStart)}|${sha(m.operation)}`);
    expect(new Set(opIds).size).toBe(opIds.length);
    expect(new Set(methodIds).size).toBe(methodIds.length);
    // cut names merge into one row (count 2, rabbitmq kind) and the custom one stays separate
    expect(item.operations).toHaveLength(2);
    expect(item.operations.find((o) => o.kind === 'rabbitmq')).toMatchObject({ count: 2, operation: 'x'.repeat(256) });
    // auto + manual 'A.b' merged into ONE method row; long manual names merged too
    expect(item.methods).toHaveLength(2);
    expect(item.methods.find((m) => m.operation === 'A.b')).toMatchObject({ count: 2, errorCount: 1, durationSumMs: 10 });
    for (const o of item.operations) expect(o.operation.length).toBeLessThanOrEqual(256);
  });

  it('the flush timer is armed outside any trace (its callbacks see no store) even when start() is called inside one', async () => {
    const stores: unknown[] = [];
    const { acc } = setup({
      flushIntervalMs: 10,
      offer: () => {
        stores.push(traceletAls.getStore());
        return true;
      },
    });
    traceletAls.run(new Map([['#tracelet.traceId', 'inside']]), () => acc.start());
    acc.recordRoot(root('a', 1));
    await new Promise((r) => setTimeout(r, 60));
    acc.shutdown();
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((st) => st === undefined)).toBe(true);
  });

  it('an item the queue refuses stays dirty and is retried; a throwing offer never reaches the caller', () => {
    let accept = false;
    let calls = 0;
    const { acc } = setup({
      offer: () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return accept;
      },
    });
    acc.recordRoot(root('a', 1));
    expect(acc.flush()).toBe(0);
    expect(acc.flush()).toBe(0); // throwing offer
    accept = true;
    expect(acc.flush()).toBe(1);
    expect(acc.flush()).toBe(0);
  });

  it('caps: <= 500 operations and <= 2000 methods per bucket, overflow into (other)', () => {
    const warn = vi.fn();
    const { acc, offered } = setup({ warn });
    for (let i = 0; i < MAX_ROLLUP_OPERATIONS + 300; i++) acc.recordRoot(root(`op-${i}`, 1));
    const spans: ObserveSpan[] = [];
    for (let i = 0; i < MAX_ROLLUP_METHODS + 500; i++) {
      spans.push({ spanId: `s${i}`, traceId: 't', parentSpanId: 'r', operation: `C${i}.m`, origin: 'auto', className: `C${i}`, method: 'm', startOffsetMs: 0, durationMs: 2, status: 'ok' });
    }
    acc.recordSpans(traceItem(T0, 10, spans));
    acc.flush();
    const item = offered[0];
    expect(item.operations.length).toBeLessThanOrEqual(MAX_ROLLUP_OPERATIONS);
    expect(item.methods.length).toBeLessThanOrEqual(MAX_ROLLUP_METHODS);
    expect(item.operations.length).toBe(MAX_ROLLUP_OPERATIONS);
    expect(item.methods.length).toBe(MAX_ROLLUP_METHODS);
    const other = item.operations.find((o) => o.operation === '(other)')!;
    expect(other.count).toBe(MAX_ROLLUP_OPERATIONS + 300 - (MAX_ROLLUP_OPERATIONS - 1));
    expect(item.operations.reduce((n, o) => n + o.count, 0)).toBe(MAX_ROLLUP_OPERATIONS + 300); // nothing lost
    expect(item.methods.reduce((n, m) => n + m.count, 0)).toBe(MAX_ROLLUP_METHODS + 500);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(item.estimatedBytes).toBeLessThan(1_500_000);
  });

  it('method stats come from sampled traces: the root span is excluded, collapsed spans count their calls, schema-valid', () => {
    const { acc, offered } = setup();
    const spans: ObserveSpan[] = [
      { spanId: 'r', traceId: 't', parentSpanId: null, operation: 'rabbitmq.consume', origin: 'root', startOffsetMs: 0, durationMs: 50, status: 'error' },
      { spanId: 'a', traceId: 't', parentSpanId: 'r', operation: 'Repo.find', origin: 'auto', className: 'Repo', method: 'find', startOffsetMs: 1, durationMs: 30, selfDurationMs: 20, status: 'ok' },
      { spanId: 'b', traceId: 't', parentSpanId: 'r', operation: 'Repo.find', origin: 'auto', className: 'Repo', method: 'find', startOffsetMs: 2, durationMs: 10, status: 'error' },
      { spanId: 'c', traceId: 't', parentSpanId: 'r', operation: 'Repo.save', origin: 'auto', className: 'Repo', method: 'save', startOffsetMs: 3, durationMs: 40, selfDurationMs: 40, collapsedCount: 4, status: 'ok' },
      { spanId: 'd', traceId: 't', parentSpanId: 'r', operation: 'inner.step', origin: 'manual', startOffsetMs: 3, durationMs: 4, status: 'ok' },
    ];
    acc.recordSpans(traceItem(T0, 50, spans));
    acc.flush();
    const methods = offered[0].methods;
    expect(methods).toHaveLength(3);
    const find = methods.find((m) => m.operation === 'Repo.find')!;
    expect(find).toMatchObject({ className: 'Repo', method: 'find', count: 2, errorCount: 1, durationSumMs: 40, durationMaxMs: 30, selfSumMs: 20, selfCount: 1 });
    const save = methods.find((m) => m.operation === 'Repo.save')!;
    expect(save).toMatchObject({ count: 4, durationSumMs: 40, durationMaxMs: 10, selfCount: 4 });
    expect(save.histogram[3]).toBe(4); // mean 10 ms -> <= 10, once per call
    const manual = methods.find((m) => m.operation === 'inner.step')!;
    expect(manual.className).toBeUndefined();
    expect(offered[0].operations).toHaveLength(0);
    for (const m of methods) expect(validMethod(m), JSON.stringify(validMethod.errors)).toBe(true);
  });

  it('a trace that ended in a previous (still kept) minute lands in that minute\'s bucket', () => {
    const { acc, offered, state } = setup();
    state.clock = T0 + MINUTE + 500; // completion happens just after the minute rolled
    acc.recordSpans(traceItem(T0 + MINUTE - 100, 50, [childSpan('X.y')])); // ended at T0 + MINUTE - 50
    acc.flush();
    expect(offered).toHaveLength(1);
    expect(offered[0].methods[0].bucketStart).toBe(new Date(T0).toISOString());
  });

  it('recordRoot is O(1): 200000 records over 200 operations stay fast and bounded', () => {
    const { acc } = setup();
    const t = performance.now();
    for (let i = 0; i < 200_000; i++) acc.recordRoot(root(`op-${i % 200}`, i % 90));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(acc.bucketCount()).toBe(1);
  });

  it('never throws on hostile input', () => {
    const { acc } = setup();
    expect(() => acc.recordRoot(null as never)).not.toThrow();
    expect(() => acc.recordSpans(null as never)).not.toThrow();
    expect(() => acc.recordRoot({ ...root('x', Number.NaN) })).not.toThrow();
    expect(acc.flush()).toBe(1);
  });
});

function childSpan(operation: string): ObserveSpan {
  return { spanId: 'c1', traceId: 't', parentSpanId: 'r', operation, origin: 'auto', className: 'X', method: 'y', startOffsetMs: 1, durationMs: 5, status: 'ok' };
}

function traceItem(startedAtMs: number, durationMs: number, children: ObserveSpan[]): TraceItem {
  const rootSpan: ObserveSpan = { spanId: 'r', traceId: 't', parentSpanId: null, operation: 'root', origin: 'root', startOffsetMs: 0, durationMs, status: 'ok' };
  return {
    type: 'trace',
    trace: { startedAt: new Date(startedAtMs).toISOString(), durationMs } as never,
    spans: [rootSpan, ...children],
    estimatedBytes: 1,
  };
}
