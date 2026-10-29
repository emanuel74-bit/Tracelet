import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import schema from '../../../src/contracts/telemetry.schema.json';
import { capRawAttributes } from '../../../src/context/raw-attributes.js';
import { trace } from '../../../src/context/index.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';
import { createOrdersApp, sleep, type OrdersApp } from '../../support/instrumentation/orders-app.js';

/* T22 / R6: span budgets. Business results must be identical to an uninstrumented run. */

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const sid = (schema as { $id: string }).$id;
const validTrace = ajv.getSchema(sid + '#/$defs/Trace')!;
const validSpan = ajv.getSchema(sid + '#/$defs/Span')!;

describe('T22: 5000-span trace (maxSpansPerTrace default hard max)', () => {
  let h: Harness | undefined;
  let orders: OrdersApp | undefined;
  afterEach(async () => {
    await orders?.close();
    orders = undefined;
    h?.stop();
    h = undefined;
  });

  const CALLS = 5300;

  function runCalls(app: OrdersApp): string[] {
    const out: string[] = [];
    for (let i = 0; i < CALLS; i++) out.push(app.validator.validateSync({ id: String(i) }));
    return out;
  }

  it('records 5000 spans, counts the rest in droppedSpanCount, results unchanged, mapper output is schema-valid', async () => {
    h = startHarness({ tracing: { maxSpansPerTrace: 5000 }, mapper: { maxSpansPerTrace: 5000, spanCollapse: false } });
    orders = await createOrdersApp();
    const expected = Array.from({ length: CALLS }, (_, i) => `v:${i}`);
    const results = trace('big.trace', () => runCalls(orders!), { kind: 'custom' });
    expect(results).toEqual(expected);

    await h.settle();
    expect(h.items).toHaveLength(1);
    const item = h.items[0];
    expect(item.trace.spanCount).toBe(5000); // root + 4999
    expect(item.spans).toHaveLength(5000);
    expect(item.trace.droppedSpanCount).toBe(CALLS - 4999);
    expect(h.queue.counters().spansDropped).toBe(CALLS - 4999);
    expect(item.trace.status).toBe('ok');
    expect(validTrace(item.trace), JSON.stringify(validTrace.errors)).toBe(true);
    for (const s of item.spans) expect(validSpan(s), JSON.stringify([s, validSpan.errors])).toBe(true);
    expect(item.estimatedBytes).toBeGreaterThan(5000 * 280);
    expect(h.rt.registry.openSpanCount()).toBe(0);
  });

  it('with collapse on, the same trace is small, keeps the drop marker and still validates', async () => {
    h = startHarness({ tracing: { maxSpansPerTrace: 5000 }, mapper: { maxSpansPerTrace: 5000 } });
    orders = await createOrdersApp();
    trace('big.collapsed', () => runCalls(orders!), { kind: 'custom' });
    await h.settle();
    const item = h.items[0];
    expect(item.trace.droppedSpanCount).toBe(CALLS - 4999);
    expect(item.trace.spanCount).toBeLessThan(10);
    expect(item.spans.some((s) => (s.collapsedCount ?? 0) > 4000)).toBe(true);
    expect(validTrace(item.trace), JSON.stringify(validTrace.errors)).toBe(true);
    for (const s of item.spans) expect(validSpan(s), JSON.stringify([s, validSpan.errors])).toBe(true);
  });

  it('mapper hard cap truncates a pre-order prefix and adds to droppedSpanCount (ancestors always kept)', async () => {
    h = startHarness({ tracing: { maxSpansPerTrace: 5000 }, mapper: { maxSpansPerTrace: 100, spanCollapse: false } });
    orders = await createOrdersApp();
    trace('capped', () => runCalls(orders!).length);
    await h.settle();
    const item = h.items[0];
    expect(item.spans).toHaveLength(100);
    expect(item.trace.spanCount).toBe(100);
    expect(item.trace.droppedSpanCount).toBe(CALLS - 4999 + (5000 - 100));
    const ids = new Set(item.spans.map((s) => s.spanId));
    for (const s of item.spans) if (s.parentSpanId !== null) expect(ids.has(s.parentSpanId)).toBe(true);
  });
});

describe('R6: global maxOpenSpans budget under concurrent traces', () => {
  let h: Harness | undefined;
  let orders: OrdersApp | undefined;
  afterEach(async () => {
    await orders?.close();
    orders = undefined;
    h?.stop();
    h = undefined;
  });

  it('refuses starts beyond the budget, counts them per trace and globally, releases on end, results unchanged', async () => {
    const BUDGET = 500;
    const TRACES = 20;
    const PER_TRACE_CALLS = 40; // 20 * (1 root + 40) = 820 > 500
    h = startHarness({ tracing: { maxOpenSpans: BUDGET, maxSpansPerTrace: 2000 }, mapper: { spanCollapse: false } });
    orders = await createOrdersApp();
    const repo = orders.repo;

    let maxObserved = 0;
    // Phase 1: all roots start (and hold their root span) before any provider call; phase 2: calls race for the remaining budget.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const results = Promise.all(
      Array.from({ length: TRACES }, (_, t) =>
        trace(
          `concurrent.${t}`,
          async () => {
            await gate;
            // every call holds an open span for ~60 ms; all traces overlap
            const calls = Array.from({ length: PER_TRACE_CALLS }, (_, c) => repo.find(60, `${t}-${c}`));
            maxObserved = Math.max(maxObserved, h!.rt.registry.openSpanCount());
            return Promise.all(calls);
          },
          { kind: 'custom' },
        ),
      ),
    );
    expect(h.rt.registry.openSpanCount()).toBe(TRACES);
    openGate();
    const resolved = await results;
    // business results identical to what the providers return
    for (let t = 0; t < TRACES; t++) {
      expect(resolved[t]).toEqual(Array.from({ length: PER_TRACE_CALLS }, (_, c) => `r:${t}-${c}`));
    }
    expect(maxObserved).toBeLessThanOrEqual(BUDGET);
    expect(maxObserved).toBe(BUDGET);

    await h.settle();
    expect(h.items).toHaveLength(TRACES);
    const totalDropped = h.items.reduce((n, i) => n + (i.trace.droppedSpanCount ?? 0), 0);
    const totalStored = h.items.reduce((n, i) => n + i.trace.spanCount, 0);
    expect(totalDropped).toBeGreaterThan(0);
    expect(h.queue.counters().spansDropped).toBe(totalDropped);
    // every attempted span is either stored or counted
    expect(totalStored + totalDropped).toBe(TRACES * (1 + PER_TRACE_CALLS));
    expect(totalStored).toBe(BUDGET); // exactly the budget was open at the peak; later starts were refused
    // the traces whose calls came after the budget filled lost all of theirs: 12 full traces (20 + 12 * 40 = 500), 8 affected
    const affected = h.items.filter((i) => (i.trace.droppedSpanCount ?? 0) > 0);
    expect(affected).toHaveLength(8);
    for (const i of affected) {
      expect(i.trace.droppedSpanCount).toBe(PER_TRACE_CALLS);
      expect(i.trace.spanCount).toBe(1);
    }
    expect(h.queue.counters().tracesDroppedAdmission).toBe(0);
    for (const i of h.items) {
      expect(validTrace(i.trace), JSON.stringify(validTrace.errors)).toBe(true);
      expect(i.trace.spanCount).toBe(i.spans.length);
    }
    // the budget is released when spans end
    expect(h.rt.registry.openSpanCount()).toBe(0);

    // after release, new traces get all their spans again
    h.items.length = 0;
    await trace('after', async () => Promise.all([repo.find(1, 'a'), repo.find(1, 'b')]), { kind: 'custom' });
    await h.settle();
    expect(h.items[0].trace.spanCount).toBe(3);
    expect(h.items[0].trace.droppedSpanCount).toBe(0);
  });

  it('a root refused by the budget runs as an unsampled root (counted), business result unchanged', async () => {
    h = startHarness({ tracing: { maxOpenSpans: 2 } });
    orders = await createOrdersApp();
    const gates: Array<() => void> = [];
    const hold = () => new Promise<void>((r) => gates.push(r));
    const a = trace('a', () => hold(), { kind: 'custom' });
    const b = trace('b', () => hold(), { kind: 'custom' });
    const c = trace('c', async () => 'c-result', { kind: 'custom' }); // budget exhausted
    await expect(c).resolves.toBe('c-result');
    expect(h.queue.counters().tracesDroppedAdmission).toBe(1);
    expect(h.queue.counters().spansDropped).toBe(1);
    gates.forEach((g) => g());
    await Promise.all([a, b]);
    await sleep(5);
    await h.settle();
    expect(h.items.map((i) => i.trace.operation).sort()).toEqual(['a', 'b']);
    expect(h.rt.registry.openSpanCount()).toBe(0);
  });
});

describe('raw attribute cap at root start (M02 follow-up)', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.stop();
    h = undefined;
  });

  it('capRawAttributes bounds keys, string length and types, and never throws', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) many[`k${i}`] = 'x'.repeat(100_000);
    many['bad key!'] = 'x';
    many.obj = { deep: 1 };
    many.fn = () => 1;
    many.inf = Number.POSITIVE_INFINITY;
    const out = capRawAttributes(many)!;
    expect(Object.keys(out)).toHaveLength(16);
    for (const v of Object.values(out)) expect((v as string).length).toBe(1025); // one over the buffer's 1024 cap on purpose (M-1)
    expect(capRawAttributes({ n: 1, b: true, s: 's', inf: Number.NaN })).toEqual({ n: 1, b: true, s: 's' });
    expect(capRawAttributes({ obj: {}, arr: [] })).toBeUndefined();
    expect(capRawAttributes('nope')).toBeUndefined();
    expect(capRawAttributes(null)).toBeUndefined();
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys'); }, has: () => { throw new Error('has'); } });
    expect(capRawAttributes(hostile)).toBeUndefined();
    const getter = Object.defineProperty({}, 'g', { enumerable: true, get: () => { throw new Error('getter'); } });
    expect(capRawAttributes(getter)).toBeUndefined();
  });


  it('M-1 regression: a secret split at the 1024 cut never survives (capRawAttributes -> registry -> mapper -> stored TraceItem)', async () => {
    h = startHarness();
    // one real-shaped JWT (3 base64url segments, ~920 chars): the redactor shrinks it, so the stored text stays under 256 chars
    const seg = (n: number) => 'eyJ' + 'abcDEF123_-'.repeat(Math.ceil(n / 11)).slice(0, n - 3);
    const head = `${seg(300)}.${seg(300)}.${seg(318)}`; // 920 chars
    expect(head).toHaveLength(920);
    const URI = 'mongodb://admin:hunter2secretpassword@db.internal:27017/orders';
    const cutInsidePassword = 'mongodb://admin:hunte'.length;
    const text = head + ' '.repeat(1024 - cutInsidePassword - head.length) + URI;
    expect(text.slice(0, 1024).endsWith('mongodb://admin:hunte')).toBe(true); // the old exact-1024 cut ends mid-password
    const raw = capRawAttributes({ note: text })!;
    expect((raw.note as string).length).toBe(1025);
    trace('m1.regression', () => 1, { kind: 'custom', attributes: { note: text } });
    await h.settle();
    const stored = String(h.items[0].trace.attributes!.note);
    for (const leak of ['hunte', 'admin', 'hunter2', 'mongodb']) expect(stored).not.toContain(leak);
    expect(JSON.stringify(h.items[0])).not.toContain('hunte');
  });

  it('L5: capRawAttributes visits at most 64 keys', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 64; i++) wide[`bad key ${i}`] = 'x'; // 64 rejected keys first
    wide.late = 'never reached';
    expect(capRawAttributes(wide)).toBeUndefined();
    let reads = 0;
    const counting = new Proxy({} as Record<string, unknown>, {
      ownKeys: () => Array.from({ length: 100_000 }, (_, i) => `k${i}`),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 1 }),
      get: () => (reads += 1, 'v'),
      has: () => true,
    });
    capRawAttributes(counting);
    expect(reads).toBeLessThanOrEqual(64);
  });

  it('trace() with a huge or hostile attributes object: bounded in the registry snapshot, stored trace bounded, fn runs once', async () => {
    h = startHarness();
    const seenAttributes = new Map<string, Record<string, unknown>>();
    const original = h.rt.config.onTraceComplete!;
    h.rt.config.onTraceComplete = (snapshot) => {
      if (snapshot.attributes) seenAttributes.set(snapshot.name, snapshot.attributes as Record<string, unknown>);
      original(snapshot);
    };
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) huge[`k${i}`] = 'y'.repeat(5000);
    let calls = 0;
    const r1 = trace('huge', () => (calls++, 'ok'), { kind: 'custom', attributes: huge as never });
    expect(r1).toBe('ok');
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys'); } });
    const r2 = trace('hostile', () => (calls++, 'ok2'), { kind: 'custom', attributes: hostile as never });
    expect(r2).toBe('ok2');
    expect(calls).toBe(2);
    await h.settle();
    // bounded already in the REGISTRY snapshot (before the mapper): removing capRawAttributes fails here
    const raw = seenAttributes.get('huge')!;
    expect(Object.keys(raw).length).toBeLessThanOrEqual(16);
    for (const v of Object.values(raw)) expect((v as string).length).toBeLessThanOrEqual(1025);
    expect(seenAttributes.has('hostile')).toBe(false);
    const item = h.items.find((i) => i.trace.operation === 'huge')!;
    expect(Object.keys(item.trace.attributes ?? {}).length).toBeLessThanOrEqual(16);
    for (const v of Object.values(item.trace.attributes ?? {})) expect((v as string).length).toBeLessThanOrEqual(256);
    expect(h.items.some((i) => i.trace.operation === 'hostile')).toBe(true);
  });
});
