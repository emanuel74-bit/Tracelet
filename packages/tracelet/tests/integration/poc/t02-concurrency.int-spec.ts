import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentTraceId, trace } from '../../../src/context/index.js';
import type { ObserveSpan } from '../../../src/contracts/index.js';
import { FakeAmqpChannel } from '../../support/instrumentation/fake-amqp-channel.js';
import { createOrdersApp, type OrdersApp } from '../../support/instrumentation/orders-app.js';
import { operationPaths, spanTree, startHarness, type Harness } from '../../support/instrumentation/harness.js';

const EXPECTED_PATHS = [
  'rabbitmq.consume',
  'rabbitmq.consume > OrdersConsumer.process',
  'rabbitmq.consume > OrdersConsumer.process > Validator.validate',
  'rabbitmq.consume > OrdersConsumer.process > Validator.validate > Transformer.execute',
  'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle',
  'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle > Repo.find',
  'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle > Repo.find',
].sort();

describe('T02 concurrent deliveries keep their own trace', () => {
  let h: Harness;
  let app: OrdersApp;
  beforeEach(async () => {
    h = startHarness({ queue: { maxQueuedTraces: 10_000 } });
    app = await createOrdersApp({ enabled: true });
  });
  afterEach(async () => {
    await app.close();
    h.stop();
  });

  for (const n of [25, 100]) {
    it(`n=${n}: distinct traceIds, own ancestors, no cross-message spans, no store leak`, async () => {
      const channel = new FakeAmqpChannel();
      const seen: Array<{ msgId: string; first: string | undefined; last: string | undefined }> = [];
      const done: Promise<void>[] = [];

      channel.consume('orders', (msg) => {
        const p = trace(
          'rabbitmq.consume',
          async () => {
            const first = currentTraceId();
            await app.consumer.process({ id: msg.id, delayMs: 1 + (Number(msg.id.slice(1)) % 7) });
            seen.push({ msgId: msg.id, first, last: currentTraceId() });
          },
          { kind: 'rabbitmq', attributes: { queue: 'orders', msgId: msg.id } },
        );
        done.push(p);
        return p;
      });
      for (let i = 0; i < n; i++) {
        channel.publish('orders', { id: `m${i}`, content: null }, i % 5);
      }
      // wait for all deliveries to have started, then for all handlers
      while (done.length < n) await new Promise((r) => setTimeout(r, 5));
      await Promise.all(done);

      expect(currentTraceId()).toBeUndefined(); // no store leaks into the caller
      const items = await h.settle();
      expect(items).toHaveLength(n);

      // distinct traceIds, one per message
      expect(new Set(items.map((i) => i.trace.traceId)).size).toBe(n);
      expect(new Set(items.map((i) => i.trace.attributes?.msgId)).size).toBe(n);
      // currentTraceId() inside the handler was stable across awaits and matched the stored trace
      expect(seen).toHaveLength(n);
      for (const s of seen) {
        expect(s.first).toBeDefined();
        expect(s.last).toBe(s.first);
        const item = items.find((i) => i.trace.attributes?.msgId === s.msgId)!;
        expect(item.trace.traceId).toBe(s.first);
      }

      for (const item of items) {
        const byId = new Map<string, ObserveSpan>(item.spans.map((s) => [s.spanId, s]));
        const roots = item.spans.filter((s) => s.parentSpanId === null);
        expect(roots).toHaveLength(1);
        expect(roots[0].spanId).toBe(item.trace.rootSpanId);
        for (const span of item.spans) {
          expect(span.traceId).toBe(item.trace.traceId);
          // ancestor chain ends at THIS trace's root and never leaves the trace
          let cursor: ObserveSpan | undefined = span;
          let hops = 0;
          while (cursor && cursor.parentSpanId !== null) {
            cursor = byId.get(cursor.parentSpanId);
            hops += 1;
            expect(hops).toBeLessThan(20);
          }
          expect(cursor?.spanId).toBe(item.trace.rootSpanId);
        }
        // exactly the span set of one message: nothing of another message is attached here
        expect(operationPaths(spanTree(item)).sort()).toEqual(EXPECTED_PATHS);
      }
      // every span id is globally unique
      const allIds = items.flatMap((i) => i.spans.map((s) => s.spanId));
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  }
});
