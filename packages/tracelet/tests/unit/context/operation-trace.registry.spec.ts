// Ported from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec): src/services/operation-trace.registry.spec.ts
// Changes: vitest; the registry is Tracelet's TraceRegistry (startRoot/endRoot instead of startTrace/endTrace, a synthetic root
// span, synchronous startManualSpan/endManualSpan, `snapshot.root` instead of `snapshot.traces`, raw error payloads that the buffer
// sanitizes). Dropped upstream describes/cases (reasons in third_party/nestjs-observe/FORK_DELTA.instrumentation.md): route
// metadata, setOperationId, request outcome, errors on transports without a status code, skipped spans, repeated siblings
// (collapse moved to the buffer and has its own ported spec), slice-recorder case, captureError/tags, configureRedaction and the
// redaction cases (redaction moved to buffer/error-sanitizer; tests/unit/buffer/error-sanitizer.spec.ts), the "warns once" logger
// case (the registry no longer logs). Changed expectations: a trace with no spans is KEPT (empty roots, T01), startRoot with a used
// key does not replace the first trace.
import { beforeEach, describe, expect, it } from 'vitest';
import { TraceRegistry, type TraceletSnapshot } from '../../../src/context/vendor/trace-registry.js';
import type { RootToken } from '../../../src/context/root-token.js';

interface Counts {
  [name: string]: number;
}

describe('TraceRegistry (ported OperationTraceRegistry cases)', () => {
  let registry: TraceRegistry;
  let counts: Counts;

  beforeEach(() => {
    counts = {};
    registry = new TraceRegistry({
      limits: () => ({ maxSpansPerTrace: 2000, maxOpenSpans: 50_000 }),
      count: (name, n) => {
        counts[name] = (counts[name] ?? 0) + n;
      },
      completionTimeoutMs: 40,
    });
  });

  const token = (): RootToken => ({ open: true, sampled: true, deadline: Infinity, recorded: false });

  /** Starts a root and returns its span id. */
  const startRequest = (key: string): string =>
    registry.startRoot(key, { name: 'GET /orders', kind: 'custom', startedAt: Date.now(), sampleRate: 1 }, token())!;

  const step = (key: string, cls: string, method: string, caller: string | undefined): string =>
    registry.internalStartTraceStep(key, cls, method, caller)!;

  const finish = (key: string, id: string, cls: string, method: string, error?: unknown, failed?: boolean): void =>
    registry.internalEndTraceStep(key, id, cls, method, id, error, failed);

  type N = { methodKey?: string; name?: string; children?: N[]; error?: unknown; origin?: string; spanId?: string; startOffset?: number };
  const rootOf = (s: TraceletSnapshot | undefined): N => s!.root as unknown as N;

  describe('abandoning a trace', () => {
    it('frees an abandoned trace entirely - spans and snapshot both', async () => {
      const root = startRequest('t-abort');
      const spanId = step('t-abort', 'Svc', 'handle', root);

      registry.abandonTrace('t-abort');

      expect(registry.has('t-abort')).toBe(false);
      expect(registry.openSpanCount()).toBe(0);
      // the span map is gone too: an end for the abandoned span is a no-op
      expect(() => finish('t-abort', spanId, 'Svc', 'handle')).not.toThrow();
      await expect(registry.pluckSnapshot('t-abort')).resolves.toBeUndefined();
    });

    it('is a no-op for a trace that was never started', () => {
      expect(() => registry.abandonTrace('never-started')).not.toThrow();
    });
  });

  describe('trace lifecycle', () => {
    it('returns nothing for a trace that was never started', async () => {
      await expect(registry.pluckSnapshot('no-such-trace')).resolves.toBeUndefined();
    });

    it('does not pluck a trace whose root is still open', async () => {
      startRequest('open');
      await expect(registry.pluckSnapshot('open')).resolves.toBeUndefined();
      expect(registry.has('open')).toBe(true);
    });

    it('plucks a completed snapshot exactly once', async () => {
      const root = startRequest('t1');
      const spanId = step('t1', 'Svc', 'handle', root);
      finish('t1', spanId, 'Svc', 'handle');
      registry.endRoot('t1');

      const snapshot = await registry.pluckSnapshot('t1');
      expect(snapshot).toBeDefined();

      // Plucking removes it: a snapshot shipped twice is a duplicate row.
      await expect(registry.pluckSnapshot('t1')).resolves.toBeUndefined();
      expect(registry.has('t1')).toBe(false);
    });

    it('CHANGED: a trace that recorded no spans is kept as a bare root (T01, the upstream gap)', async () => {
      startRequest('t2');
      registry.endRoot('t2');

      const snapshot = await registry.pluckSnapshot('t2');
      expect(snapshot).toBeDefined();
      expect(rootOf(snapshot).children).toBeUndefined();
      expect(rootOf(snapshot).origin).toBe('root');
    });

    it('CHANGED: a second startRoot under the same key does not replace the first trace', async () => {
      const root = startRequest('t3');
      const first = step('t3', 'Svc', 'first', root);
      finish('t3', first, 'Svc', 'first');

      expect(registry.startRoot('t3', { name: 'again', kind: 'custom', startedAt: Date.now(), sampleRate: 1 }, token())).toBeUndefined();
      registry.endRoot('t3');

      const snapshot = await registry.pluckSnapshot('t3');
      expect(JSON.stringify(snapshot)).toContain('first');
      expect(JSON.stringify(snapshot)).not.toContain('again');
    });

    it('ignores an end for a trace that does not exist', () => {
      expect(() => registry.endRoot('never-started')).not.toThrow();
      expect(registry.endRoot('never-started')).toBeUndefined();
    });

    it('a second endRoot (late settle after a force-close) changes nothing', () => {
      startRequest('t3b');
      expect(registry.endRoot('t3b')).toBeDefined();
      expect(registry.endRoot('t3b')).toBeUndefined();
    });

    it('records the duration on the snapshot, without scratch state', async () => {
      const root = startRequest('t4');
      const spanId = step('t4', 'Svc', 'handle', root);
      finish('t4', spanId, 'Svc', 'handle');
      registry.endRoot('t4');

      const snapshot = await registry.pluckSnapshot('t4');
      expect(snapshot!.duration).toEqual(expect.any(Number));
      // scratch state must not travel on the wire
      expect(snapshot).not.toHaveProperty('startTimestamp');
      expect(snapshot).not.toHaveProperty('refsCounter');
      expect(snapshot).not.toHaveProperty('refsMarkedAsComplete');
      expect(snapshot).not.toHaveProperty('token');
      expect(snapshot).not.toHaveProperty('closed');
    });
  });

  describe('span tree', () => {
    it('puts a span with no caller under the root span (single-root invariant)', async () => {
      startRequest('t5');
      const spanId = step('t5', 'Svc', 'root', undefined);
      finish('t5', spanId, 'Svc', 'root');
      registry.endRoot('t5');

      const snapshot = await registry.pluckSnapshot('t5');
      expect(rootOf(snapshot).children).toHaveLength(1);
      expect(rootOf(snapshot).children![0]).toMatchObject({ methodKey: 'root' });
    });

    it('nests a span under its caller', async () => {
      const root = startRequest('t6');
      const parent = step('t6', 'Svc', 'parent', root);
      const child = step('t6', 'Repo', 'child', parent);
      finish('t6', child, 'Repo', 'child');
      finish('t6', parent, 'Svc', 'parent');
      registry.endRoot('t6');

      const snapshot = await registry.pluckSnapshot('t6');
      const parentNode = rootOf(snapshot).children![0];
      expect(parentNode.methodKey).toBe('parent');
      expect(parentNode.children?.map((node) => node.methodKey)).toEqual(['child']);
    });

    it('puts a span whose caller already completed under the root instead of throwing', async () => {
      const root = startRequest('t6b');
      const caller = step('t6b', 'Interceptor', 'intercept', root);
      // intercept() returns synchronously, so its span closes (and, with no children, loses its `children` array) before the
      // handler bound to its async context runs.
      finish('t6b', caller, 'Interceptor', 'intercept');

      let late: string | undefined;
      expect(() => {
        late = registry.internalStartTraceStep('t6b', 'Ctrl', 'handle', caller);
      }).not.toThrow();
      finish('t6b', late!, 'Ctrl', 'handle');
      registry.endRoot('t6b');

      const snapshot = await registry.pluckSnapshot('t6b');
      expect(rootOf(snapshot).children!.map((node) => node.methodKey)).toEqual(['intercept', 'handle']);
    });

    it('puts a manual span whose caller already completed under the root instead of throwing', async () => {
      const root = startRequest('t6c');
      const caller = step('t6c', 'Interceptor', 'intercept', root);
      finish('t6c', caller, 'Interceptor', 'intercept');

      let manual: string | undefined;
      expect(() => {
        manual = registry.startManualSpan('t6c', caller, 'manual-step');
      }).not.toThrow();
      registry.endManualSpan('t6c', manual!);
      registry.endRoot('t6c');

      const snapshot = await registry.pluckSnapshot('t6c');
      expect(rootOf(snapshot).children!.map((node) => node.name ?? node.methodKey)).toEqual(['intercept', 'manual-step']);
    });

    it('uses the span id as the caller id it registers under', async () => {
      const root = startRequest('t7');
      const spanId = step('t7', 'Svc', 'root', root);
      finish('t7', spanId, 'Svc', 'root');
      registry.endRoot('t7');

      const snapshot = await registry.pluckSnapshot('t7');
      // the returned id IS the node's spanId (a log line's caller id resolves back to its span), the root included
      expect(rootOf(snapshot).spanId).toBe(root);
      expect(snapshot!.rootSpanId).toBe(root);
      expect(rootOf(snapshot).children![0].spanId).toBe(spanId);
    });

    it('strips scratch fields from a completed span', async () => {
      const root = startRequest('t8');
      const spanId = step('t8', 'Svc', 'root', root);
      finish('t8', spanId, 'Svc', 'root');
      registry.endRoot('t8');

      const snapshot = await registry.pluckSnapshot('t8');
      for (const node of [rootOf(snapshot), rootOf(snapshot).children![0]] as unknown as Array<Record<string, unknown>>) {
        expect(node).not.toHaveProperty('type');
        expect(node).not.toHaveProperty('startTime');
        // A parent back-reference would make the tree cyclic and unserialisable.
        expect(node).not.toHaveProperty('parent');
        expect(node.duration).toEqual(expect.any(Number));
      }
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    it('records how far into the trace each span started', async () => {
      const root = startRequest('t9');
      const spanId = step('t9', 'Svc', 'root', root);
      finish('t9', spanId, 'Svc', 'root');
      registry.endRoot('t9');

      const snapshot = await registry.pluckSnapshot('t9');
      const node = rootOf(snapshot).children![0];
      expect(node.startOffset).toEqual(expect.any(Number));
      expect(node.startOffset).toBeGreaterThanOrEqual(0);
    });

    it('ignores a span started against an unknown trace', () => {
      expect(registry.internalStartTraceStep('unknown', 'Svc', 'm', undefined)).toBeUndefined();
    });

    it('ignores an end for a span that was never opened', () => {
      const root = startRequest('t10');
      step('t10', 'Svc', 'root', root);

      expect(() => registry.internalEndTraceStep('t10', 'ghost', 'Svc', 'ghost', 'ghost')).not.toThrow();
    });

    it('refuses new spans once the root closed (a stale store cannot attach to a closed trace)', () => {
      const root = startRequest('t10b');
      registry.endRoot('t10b');
      expect(registry.internalStartTraceStep('t10b', 'Svc', 'late', root)).toBeUndefined();
      expect(registry.startManualSpan('t10b', root, 'late')).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('attaches an error payload to the origin span', async () => {
      const root = startRequest('e1');
      const spanId = step('e1', 'Svc', 'root', root);
      finish('e1', spanId, 'Svc', 'root', new Error('boom'));
      registry.endRoot('e1');

      const snapshot = await registry.pluckSnapshot('e1');
      expect(rootOf(snapshot).children![0].error).toMatchObject({ message: 'boom', cls: 'Error' });
    });

    it('marks a nested span as failed without repeating the payload', async () => {
      const root = startRequest('e2');
      const parent = step('e2', 'Svc', 'parent', root);
      const child = step('e2', 'Repo', 'child', parent);
      const err = new Error('inner');
      finish('e2', child, 'Repo', 'child', err);
      finish('e2', parent, 'Svc', 'parent', err); // the parent rethrows the same error
      registry.endRoot('e2', err);

      const snapshot = await registry.pluckSnapshot('e2');
      const parentNode = rootOf(snapshot).children![0];
      // one stack per snapshot: the origin (the child) has the payload, ancestors carry a flag
      expect(parentNode.error).toBe(true);
      expect(parentNode.children![0].error).toMatchObject({ message: 'inner' });
      expect(rootOf(snapshot).error).toBe(true);
      expect(snapshot!.rootError).toEqual(parentNode.children![0].error); // equal content (the root is not the origin, so a separate payload object)
    });

    it('CHANGED: the error escaping the root is promoted onto the snapshot as rootError (raw payload, sanitized by the buffer)', async () => {
      startRequest('e3');
      registry.endRoot('e3', new Error('surfaced'));

      const snapshot = await registry.pluckSnapshot('e3');
      expect(snapshot!.status).toBe('error');
      expect(snapshot!.rootError).toMatchObject({ message: 'surfaced' });
    });

    it('records a thrown non-Error with its string form and no stack', async () => {
      const root = startRequest('e5');
      const spanId = step('e5', 'Svc', 'root', root);
      finish('e5', spanId, 'Svc', 'root', 'just a string');
      registry.endRoot('e5');

      const snapshot = await registry.pluckSnapshot('e5');
      const err = rootOf(snapshot).children![0].error as { message: string; stack?: string };
      expect(err.message).toBe('just a string');
      expect(err.stack).toBeUndefined();
    });

    it('a falsy thrown value is still a failure (explicit failed flag)', async () => {
      const root = startRequest('e6');
      const spanId = step('e6', 'Svc', 'root', root);
      registry.internalEndTraceStep('e6', spanId, 'Svc', 'root', spanId, undefined, true);
      registry.endRoot('e6', undefined, true);
      const snapshot = await registry.pluckSnapshot('e6');
      expect(snapshot!.status).toBe('error');
      expect(rootOf(snapshot).children![0].error).toBeTruthy();
    });
  });

  describe('manual spans (synchronous startManualSpan / endManualSpan, R1)', () => {
    it('nests the manual span under the given caller', async () => {
      const root = startRequest('m2');
      const parent = step('m2', 'Svc', 'root', root);
      const manual = registry.startManualSpan('m2', parent, 'inner-work');
      registry.endManualSpan('m2', manual!);
      finish('m2', parent, 'Svc', 'root');
      registry.endRoot('m2');

      const snapshot = await registry.pluckSnapshot('m2');
      expect(rootOf(snapshot).children![0].children![0]).toMatchObject({ name: 'inner-work', origin: 'manual' });
    });

    it('records the failure of a manual span as a flag/payload on the origin', async () => {
      const root = startRequest('m3');
      const parent = step('m3', 'Svc', 'root', root);
      const manual = registry.startManualSpan('m3', parent, 'failing')!;
      registry.endManualSpan('m3', manual, new Error('inner boom'));
      finish('m3', parent, 'Svc', 'root');
      registry.endRoot('m3');

      const snapshot = await registry.pluckSnapshot('m3');
      expect(rootOf(snapshot).children![0].children![0].error).toMatchObject({ message: 'inner boom' });
    });

    it('returns undefined (so the caller still runs fn untraced) for an unknown trace', () => {
      expect(registry.startManualSpan('unknown', 'nobody', 'orphan')).toBeUndefined();
      expect(() => registry.endManualSpan('unknown', 'x')).not.toThrow();
    });

    it('does not let a completed manual span mask a leaked auto span', async () => {
      const root = startRequest('m5');
      const parent = step('m5', 'Svc', 'root', root);
      // An un-awaited auto span that never completes.
      step('m5', 'Svc', 'leaked', parent);

      // A manual span completes through the same ledger; without a matching start count the two increments would cancel and the
      // half-built tree would ship.
      const quick = registry.startManualSpan('m5', parent, 'quick')!;
      registry.endManualSpan('m5', quick);
      finish('m5', parent, 'Svc', 'root');
      registry.endRoot('m5');

      // Waited out and shipped without the leaked span, never with it.
      const snapshot = await registry.pluckSnapshot('m5');
      const parentNode = rootOf(snapshot).children![0];
      expect(parentNode.methodKey).toBe('root');
      expect(parentNode.children).toEqual([expect.objectContaining({ name: 'quick' })]);
      expect(snapshot!.unfinishedSpanCount).toBe(1);
      expect(snapshot!.isComplete).toBe(false);
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });
  });

  describe('incomplete snapshots', () => {
    // Any node that is still ongoing anywhere in a shipped tree.
    const ongoingNodes = (nodes: unknown[] = []): unknown[] =>
      nodes.flatMap((node) => {
        const { type, children } = node as { type?: string; children?: unknown[] };
        return type === 'start' ? [node, ...ongoingNodes(children)] : ongoingNodes(children);
      });

    it('keeps the operation when every span it opened is still open', async () => {
      const root = startRequest('i1');
      step('i1', 'Svc', 'leaked', root);
      registry.endRoot('i1');

      // The snapshot waits and then ships without the open span: the operation keeps its row - status, duration - with a bare root.
      const snapshot = await registry.pluckSnapshot('i1');
      expect(rootOf(snapshot).children).toBeUndefined();
      expect(snapshot!.unfinishedSpanCount).toBe(1);
      expect(snapshot!.isComplete).toBe(false);
      expect(snapshot!.status).toBe('ok');
    });

    it('does not leak the trace after shipping it without its open spans', async () => {
      const root = startRequest('i2');
      step('i2', 'Svc', 'leaked', root);
      registry.endRoot('i2');
      await registry.pluckSnapshot('i2');

      // Cleanup runs on this path too, or a busy process accumulates a snapshot per un-awaited call.
      expect(registry.has('i2')).toBe(false);
      expect(registry.openTraceCount()).toBe(0);
      expect(registry.openSpanCount()).toBe(0);
    });

    it("a late end of a span that outlived its trace adds nothing and does not throw", async () => {
      const root = startRequest('i3');
      const handler = step('i3', 'OrdersController', 'create', root);
      const mail = step('i3', 'MailService', 'send', handler);
      finish('i3', handler, 'OrdersController', 'create');
      registry.endRoot('i3');
      await expect(registry.pluckSnapshot('i3')).resolves.toBeDefined();

      expect(() => finish('i3', mail, 'MailService', 'send')).not.toThrow();
      expect(registry.openSpanCount()).toBe(0);
    });

    it('ships what finished when a span outlives its trace, without the spans still open', async () => {
      const root = startRequest('p1');
      const handler = step('p1', 'OrdersController', 'create', root);
      const create = step('p1', 'OrdersService', 'create', handler);
      finish('p1', create, 'OrdersService', 'create');
      // Fired by the handler and not awaited: still running when it returns, with a call of its own that already finished.
      const mail = step('p1', 'MailService', 'send', handler);
      const render = step('p1', 'TemplateService', 'render', mail);
      finish('p1', render, 'TemplateService', 'render');
      finish('p1', handler, 'OrdersController', 'create');
      registry.endRoot('p1');

      const snapshot = await registry.pluckSnapshot('p1');

      expect(snapshot).toBeDefined();
      const handlerNode = rootOf(snapshot).children![0];
      expect(handlerNode).toMatchObject({ className: 'OrdersController', methodKey: 'create' });
      expect(handlerNode.children).toEqual([expect.objectContaining({ className: 'OrdersService', methodKey: 'create' })]);
      // Only complete nodes reach the wire, and none of them still points back at a parent.
      expect(ongoingNodes([snapshot!.root])).toEqual([]);
      expect(() => JSON.stringify(snapshot)).not.toThrow();
      // The open span and the finished call under it are both left out.
      expect(snapshot!.unfinishedSpanCount).toBe(2);

      // Its late end changes nothing in what was shipped.
      const shipped = JSON.stringify(snapshot);
      finish('p1', mail, 'MailService', 'send');
      expect(JSON.stringify(snapshot)).toBe(shipped);
    });

    it('reports the failure of an operation whose background work outlived it', async () => {
      const root = startRequest('p2');
      const handler = step('p2', 'OrdersController', 'create', root);
      // The email goes out in the background, then the handler throws.
      step('p2', 'MailService', 'send', handler);
      const err = new Error('payment provider down');
      finish('p2', handler, 'OrdersController', 'create', err);
      registry.endRoot('p2', err);

      const snapshot = await registry.pluckSnapshot('p2');
      expect(snapshot!.status).toBe('error');
      expect(snapshot!.rootError).toMatchObject({ message: 'payment provider down' });
      expect(rootOf(snapshot).children![0]).toMatchObject({ methodKey: 'create', error: expect.objectContaining({ message: 'payment provider down' }) });
      expect(ongoingNodes([snapshot!.root])).toEqual([]);
      expect(snapshot!.unfinishedSpanCount).toBe(1);
    });
  });

  describe('added for Tracelet (not in the upstream spec): budgets, force-close, early pluck', () => {
    it('maxSpansPerTrace refuses starts, counts spansDropped and the trace droppedSpanCount', async () => {
      const small = new TraceRegistry({ limits: () => ({ maxSpansPerTrace: 3, maxOpenSpans: 1000 }), count: (n, c) => (counts[n] = (counts[n] ?? 0) + c), completionTimeoutMs: 20 });
      const root = small.startRoot('b1', { name: 'x', kind: 'custom', startedAt: 0, sampleRate: 1 }, token())!;
      const a = small.internalStartTraceStep('b1', 'S', 'a', root);
      const b = small.internalStartTraceStep('b1', 'S', 'b', root);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(small.internalStartTraceStep('b1', 'S', 'c', root)).toBeUndefined();
      small.internalEndTraceStep('b1', a!, 'S', 'a', a!);
      small.internalEndTraceStep('b1', b!, 'S', 'b', b!);
      small.endRoot('b1');
      const snapshot = await small.pluckSnapshot('b1');
      expect(snapshot!.droppedSpanCount).toBe(1);
      expect(counts.spansDropped).toBe(1);
    });

    it('forceClose flips the stored token and closes the root as incomplete; the late endRoot is a no-op', async () => {
      const t = token();
      registry.startRoot('f1', { name: 'x', kind: 'custom', startedAt: 0, sampleRate: 1 }, t);
      const closed = registry.closeAllOpenRoots('shutdown');
      expect(closed).toHaveLength(1);
      expect(t.open).toBe(false);
      expect(closed[0].status).toBe('incomplete');
      expect(registry.endRoot('f1')).toBeUndefined();
      const snapshot = await registry.pluckSnapshot('f1');
      expect(snapshot).toMatchObject({ status: 'incomplete', isComplete: false });
    });

    it('closeExpired only closes roots past maxTraceDurationMs', () => {
      registry.startRoot('x1', { name: 'x', kind: 'custom', startedAt: 0, sampleRate: 1 }, token());
      expect(registry.closeExpired(1_000_000)).toHaveLength(0);
      expect(registry.closeExpired(0, performance.now() + 5)).toHaveLength(1);
    });

    it('pluck resolves as soon as the last open span ends (O-2), well before the ceiling', async () => {
      const slow = new TraceRegistry({ limits: () => ({ maxSpansPerTrace: 100, maxOpenSpans: 1000 }), count: () => {}, completionTimeoutMs: 5000 });
      const root = slow.startRoot('o2', { name: 'x', kind: 'custom', startedAt: 0, sampleRate: 1 }, token())!;
      const child = slow.internalStartTraceStep('o2', 'S', 'child', root)!;
      slow.endRoot('o2');
      const started = performance.now();
      setTimeout(() => slow.internalEndTraceStep('o2', child, 'S', 'child', child), 30);
      const snapshot = await slow.pluckSnapshot('o2');
      expect(performance.now() - started).toBeLessThan(2500); // ceiling is 5000: only the early resolve passes
      expect(snapshot!.unfinishedSpanCount).toBe(0);
      expect(snapshot!.isComplete).toBe(true);
      expect(slow.hasSnapshotsAwaitingCompletion()).toBe(false);
    });
  });
});
