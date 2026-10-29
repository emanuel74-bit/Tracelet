import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import schema from '../../../src/contracts/telemetry.schema.json';
import { toTraceItem, type MapperContext } from '../../../src/buffer/index.js';
import { createRootOnlySnapshot, LogRedactor, TraceRegistry } from '../../../src/context/index.js';
import type { RootToken } from '../../../src/context/index.js';
import type { ObserveSpan } from '../../../src/contracts/index.js';

const ctx = (over: Partial<MapperContext> = {}): MapperContext => ({
  serviceName: 'svc',
  serviceVersion: '1.2.3',
  instanceId: 'host-abc',
  errorMessages: 'redacted',
  redactor: new LogRedactor(),
  ...over,
});

const newRegistry = () =>
  new TraceRegistry({ limits: () => ({ maxSpansPerTrace: 5000, maxOpenSpans: 100_000 }), count: () => {}, completionTimeoutMs: 10 });
const token = (): RootToken => ({ open: true, sampled: true, deadline: Infinity, recorded: false });

async function build(
  fn: (r: TraceRegistry, key: string, rootId: string) => void,
  opts: { failed?: boolean; error?: unknown; attributes?: Record<string, string | number | boolean> } = {},
) {
  const r = newRegistry();
  const key = 'trace-0001';
  const rootId = r.startRoot(
    key,
    { name: 'rabbitmq.consume', kind: 'rabbitmq', startedAt: Date.UTC(2026, 0, 2, 3, 4, 5), sampleRate: 0.5, ...(opts.attributes ? { attributes: opts.attributes } : {}) },
    token(),
  )!;
  fn(r, key, rootId);
  r.endRoot(key, opts.error, opts.failed ?? false);
  return (await r.pluckSnapshot(key))!;
}

describe('toTraceItem', () => {
  it('maps a snapshot to the v1 trace and span records (freeze doc section 3)', async () => {
    const snapshot = await build(
      (r, key, rootId) => {
        const a = r.internalStartTraceStep(key, 'OrdersService', 'handle', rootId)!;
        const b = r.internalStartTraceStep(key, 'Repo', 'find', a)!;
        r.internalEndTraceStep(key, undefined, 'Repo', 'find', b);
        r.internalEndTraceStep(key, undefined, 'OrdersService', 'handle', a);
        const manual = r.startManualSpan(key, rootId, 'inner.step')!;
        r.endManualSpan(key, manual);
      },
      { attributes: { queue: 'orders' } },
    );
    const item = toTraceItem(snapshot, ctx());
    expect(item.type).toBe('trace');
    const t = item.trace;
    expect(t).toMatchObject({
      schemaVersion: 1,
      traceId: 'trace-0001',
      serviceName: 'svc',
      serviceVersion: '1.2.3',
      instanceId: 'host-abc',
      operation: 'rabbitmq.consume',
      kind: 'rabbitmq',
      startedAt: '2026-01-02T03:04:05.000Z',
      status: 'ok',
      spanCount: 4,
      errorCount: 0,
      isComplete: true,
      sampleRate: 0.5,
      detail: 'full',
      droppedSpanCount: 0,
      unfinishedSpanCount: 0,
      attributes: { queue: 'orders' },
    });
    expect(t.error).toBeUndefined();
    expect(t.errorFingerprint).toBeUndefined();

    const [root, handle, find, inner] = item.spans;
    expect(root).toMatchObject({ parentSpanId: null, origin: 'root', operation: 'rabbitmq.consume', startOffsetMs: 0, status: 'ok' });
    expect(root.spanId).toBe(t.rootSpanId);
    expect(root.durationMs).toBe(t.durationMs);
    expect(handle).toMatchObject({ parentSpanId: root.spanId, origin: 'auto', operation: 'OrdersService.handle', className: 'OrdersService', method: 'handle' });
    expect(find).toMatchObject({ parentSpanId: handle.spanId, origin: 'auto', operation: 'Repo.find', className: 'Repo', method: 'find' });
    expect(inner).toMatchObject({ parentSpanId: root.spanId, origin: 'manual', operation: 'inner.step' });
    expect(inner.className).toBeUndefined();
    for (const s of item.spans) {
      expect(s.traceId).toBe('trace-0001');
      expect(s.selfDurationMs).toBeGreaterThanOrEqual(0);
    }
    // contract invariant 6: self = duration - union(children), within rounding tolerance
    expect(handle.selfDurationMs!).toBeCloseTo(Math.max(0, handle.durationMs - find.durationMs), 1);
    expect(item.estimatedBytes).toBe(600 + 280 * 4);
  });

  it('errors: payload on the origin span only, ancestors error without payload, errorCount counts origins, fingerprint present', async () => {
    const err = new TypeError('kaboom');
    const snapshot = await build(
      (r, key, rootId) => {
        const a = r.internalStartTraceStep(key, 'A', 'run', rootId)!;
        const b = r.internalStartTraceStep(key, 'B', 'run', a)!;
        r.internalEndTraceStep(key, undefined, 'B', 'run', b, err, true);
        r.internalEndTraceStep(key, undefined, 'A', 'run', a, err, true);
      },
      { failed: true, error: err },
    );
    const item = toTraceItem(snapshot, ctx());
    expect(item.trace.status).toBe('error');
    expect(item.trace.errorCount).toBe(1);
    expect(item.trace.error?.name).toBe('TypeError');
    expect(item.trace.error?.message).toBe('kaboom');
    expect(item.trace.errorFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const [root, a, b] = item.spans;
    expect([root.status, a.status, b.status]).toEqual(['error', 'error', 'error']);
    expect(root.sanitizedError).toBeUndefined();
    expect(a.sanitizedError).toBeUndefined();
    expect(b.sanitizedError?.name).toBe('TypeError');
  });

  it('a falsy thrown value is still an error (failed flag)', async () => {
    const snapshot = await build(
      (r, key, rootId) => {
        const a = r.internalStartTraceStep(key, 'A', 'run', rootId)!;
        r.internalEndTraceStep(key, undefined, 'A', 'run', a, undefined, true);
      },
      { failed: true, error: undefined },
    );
    const item = toTraceItem(snapshot, ctx());
    expect(item.trace.status).toBe('error');
    expect(item.spans[1].status).toBe('error');
    expect(item.spans[1].sanitizedError).toBeDefined();
  });

  it("errorMessages 'omit' stores no message text but keeps the error", async () => {
    const err = new Error('secret-message');
    const snapshot = await build(() => {}, { failed: true, error: err });
    const item = toTraceItem(snapshot, ctx({ errorMessages: 'omit' }));
    expect(item.trace.error?.message).toBeUndefined();
    expect(item.spans[0].sanitizedError?.message).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('secret-message');
  });

  it('collapses repeated siblings after self time; collapsed self = sum of members', async () => {
    const snapshot = await build((r, key, rootId) => {
      for (let i = 0; i < 30; i++) {
        const id = r.internalStartTraceStep(key, 'Repo', 'find', rootId)!;
        r.internalEndTraceStep(key, undefined, 'Repo', 'find', id);
      }
    });
    const item = toTraceItem(snapshot, ctx());
    // threshold 20, keep slowest 3 -> 3 whole + 1 collapsed standing for 27
    const finds = item.spans.filter((s) => s.operation === 'Repo.find');
    expect(finds).toHaveLength(4);
    const collapsed = finds.filter((s) => s.collapsedCount !== undefined);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].collapsedCount).toBe(27);
    expect(collapsed[0].selfDurationMs).toBeGreaterThanOrEqual(0);
    expect(item.trace.spanCount).toBe(5);
    expect(ctx({ spanCollapse: false }).spanCollapse).toBe(false);
    const snapshot2 = await build((r, key, rootId) => {
      for (let i = 0; i < 30; i++) {
        const id = r.internalStartTraceStep(key, 'Repo', 'find', rootId)!;
        r.internalEndTraceStep(key, undefined, 'Repo', 'find', id);
      }
    });
    expect(toTraceItem(snapshot2, ctx({ spanCollapse: false })).trace.spanCount).toBe(31);
  });

  it('spans still open at pluck are left out with their subtree and counted as unfinished', async () => {
    const snapshot = await build((r, key, rootId) => {
      let parent = rootId;
      for (let i = 0; i < 10; i++) {
        parent = r.internalStartTraceStep(key, `C${i}`, 'm', parent)!; // never ended
      }
    });
    const item = toTraceItem(snapshot, ctx());
    expect(item.trace.unfinishedSpanCount).toBe(10);
    expect(item.trace.isComplete).toBe(false);
    expect(item.trace.spanCount).toBe(1);
    expect(item.spans[0].selfDurationMs).toBeUndefined(); // a child was left out: self time not computable
  });

  it('caps spans at maxSpansPerTrace keeping ancestors and counts the rest as dropped', async () => {
    const wide = await build((r, key, rootId) => {
      for (let i = 0; i < 15; i++) {
        const id = r.internalStartTraceStep(key, `W${i}`, 'm', rootId)!;
        r.internalEndTraceStep(key, undefined, `W${i}`, 'm', id);
      }
    });
    const capped = toTraceItem(wide, ctx({ maxSpansPerTrace: 6 }));
    expect(capped.spans).toHaveLength(6);
    expect(capped.trace.spanCount).toBe(6);
    expect(capped.trace.droppedSpanCount).toBe(16 - 6);
    const ids = new Set(capped.spans.map((s: ObserveSpan) => s.spanId));
    for (const s of capped.spans) expect(s.parentSpanId === null || ids.has(s.parentSpanId)).toBe(true);
  });

  it('attributes are bounded and redacted: <=16 keys, key pattern, sensitive keys masked, strings <=256', async () => {
    const attrs: Record<string, string | number | boolean> = { password: 'hunter2', note: 'x'.repeat(500), ok: true, n: 3, 'bad key!': 'dropped', nan: Number.NaN };
    for (let i = 0; i < 30; i++) attrs[`k${i}`] = i;
    const snapshot = await build(() => {}, { attributes: attrs });
    const a = toTraceItem(snapshot, ctx()).trace.attributes!;
    expect(Object.keys(a).length).toBeLessThanOrEqual(16);
    expect(a.password).toBe('[REDACTED]');
    expect((a.note as string).length).toBe(256);
    expect(a['bad key!']).toBeUndefined();
    expect(a.nan).toBeUndefined();
  });

  it('rootOnly failure record: one span, error status, sanitized error, detail rootOnly', () => {
    const snapshot = createRootOnlySnapshot({
      traceId: 'ro-1',
      rootSpanId: 'ro-span',
      name: 'rabbitmq.consume',
      kind: 'rabbitmq',
      startedAt: Date.now(),
      durationMs: 12.5,
      sampleRate: 0.05,
      error: new RangeError('bad'),
    });
    const item = toTraceItem(snapshot, ctx());
    expect(item.trace.detail).toBe('rootOnly');
    expect(item.trace.spanCount).toBe(1);
    expect(item.trace.status).toBe('error');
    expect(item.trace.durationMs).toBe(12.5);
    expect(item.trace.errorCount).toBe(1);
    expect(item.trace.errorFingerprint).toBeDefined();
    expect(item.spans[0]).toMatchObject({ spanId: 'ro-span', parentSpanId: null, origin: 'root', status: 'error' });
  });

  it('a force-closed root is incomplete with an incomplete root span', async () => {
    const r = newRegistry();
    r.startRoot('k', { name: 'op', kind: 'custom', startedAt: Date.now(), sampleRate: 1 }, token());
    r.forceClose('k', 'timeout');
    const snapshot = (await r.pluckSnapshot('k'))!;
    const item = toTraceItem(snapshot, ctx());
    expect(item.trace.status).toBe('incomplete');
    expect(item.trace.isComplete).toBe(false);
    expect(item.spans[0].status).toBe('incomplete');
  });
});

describe('toTraceItem output is schema-valid and clamped (O-1)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema as object);
  const id = (schema as { $id: string }).$id;
  const validTrace = ajv.getSchema(id + '#/$defs/Trace')!;
  const validSpan = ajv.getSchema(id + '#/$defs/Span')!;
  const check = (item: ReturnType<typeof toTraceItem>) => {
    expect(validTrace(item.trace), JSON.stringify(validTrace.errors)).toBe(true);
    for (const s of item.spans) expect(validSpan(s), JSON.stringify([s, validSpan.errors])).toBe(true);
  };

  it('ordinary, error, collapsed, rootOnly and force-closed traces all validate', async () => {
    check(toTraceItem(await build((r, key, root) => { const a = r.internalStartTraceStep(key, 'A', 'm', root)!; r.internalEndTraceStep(key, undefined, 'A', 'm', a); }), ctx()));
    check(toTraceItem(await build(() => {}, { failed: true, error: new Error('x') }), ctx()));
    check(
      toTraceItem(
        await build((r, key, root) => {
          for (let i = 0; i < 30; i++) { const a = r.internalStartTraceStep(key, 'R', 'f', root)!; r.internalEndTraceStep(key, undefined, 'R', 'f', a); }
        }),
        ctx(),
      ),
    );
    check(toTraceItem(createRootOnlySnapshot({ traceId: 'ro-12345678', rootSpanId: 'ro-span-1', name: 'op', kind: 'custom', startedAt: Date.now(), durationMs: 1, sampleRate: 0.1, error: new Error('e') }), ctx()));
    const r = newRegistry();
    r.startRoot('closed-key-1', { name: 'op', kind: 'custom', startedAt: Date.now(), sampleRate: 1 }, token());
    r.forceClose('closed-key-1', 'timeout');
    check(toTraceItem((await r.pluckSnapshot('closed-key-1'))!, ctx()));
  });

  it('an anonymous class and an empty name never yield an empty string; long names are clamped', async () => {
    const snapshot = await build((r, key, root) => {
      const a = r.internalStartTraceStep(key, '', 'run', root)!;
      r.internalEndTraceStep(key, undefined, '', 'run', a);
      const b = r.internalStartTraceStep(key, 'C'.repeat(500), 'm'.repeat(500), root)!;
      r.internalEndTraceStep(key, undefined, 'C', 'm', b);
      const m = r.startManualSpan(key, root, '')!;
      r.endManualSpan(key, m);
    });
    snapshot.name = '';
    const item = toTraceItem(snapshot, ctx());
    check(item);
    expect(item.trace.operation).toBe('(unnamed)');
    const anon = item.spans.find((s) => s.method === 'run')!;
    expect(anon.className).toBe('Anonymous');
    expect(anon.operation).toBe('Anonymous.run');
    const long = item.spans.find((s) => s.className?.startsWith('CCC'))!;
    expect(long.className).toHaveLength(128);
    expect(long.method).toHaveLength(128);
    expect(long.operation.length).toBeLessThanOrEqual(256);
    expect(item.spans.every((s) => s.operation.length >= 1)).toBe(true);
  });

  it('errors are sanitized once when the root is the origin (shared payload)', async () => {
    const snapshot = await build(() => {}, { failed: true, error: new Error('once') });
    expect(snapshot.rootError).toBe((snapshot.root as { error?: unknown }).error);
  });

  it('error origin identity: objects by reference; primitives by value (documented: two unrelated throw "x" count as one origin)', async () => {
    const sameString = await build(
      (r, key, root) => {
        const a = r.internalStartTraceStep(key, 'A', 'm', root)!;
        const b = r.internalStartTraceStep(key, 'B', 'm', root)!;
        r.internalEndTraceStep(key, undefined, 'A', 'm', a, 'x', true);
        r.internalEndTraceStep(key, undefined, 'B', 'm', b, 'x', true);
      },
      { failed: false },
    );
    expect(toTraceItem(sameString, ctx()).trace.errorCount).toBe(1); // value equality for primitives: documented limitation
    const e1 = new Error('x');
    const e2 = new Error('x');
    const twoObjects = await build(
      (r, key, root) => {
        const a = r.internalStartTraceStep(key, 'A', 'm', root)!;
        const b = r.internalStartTraceStep(key, 'B', 'm', root)!;
        r.internalEndTraceStep(key, undefined, 'A', 'm', a, e1, true);
        r.internalEndTraceStep(key, undefined, 'B', 'm', b, e2, true);
      },
      { failed: false },
    );
    expect(toTraceItem(twoObjects, ctx()).trace.errorCount).toBe(2);
  });
});
