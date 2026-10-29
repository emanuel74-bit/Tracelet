import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentTraceId, trace } from '../../../src/context/index.js';
import { createOrdersApp, type OrdersApp } from '../../support/instrumentation/orders-app.js';
import { operationPaths, spanTree, startHarness, type Harness } from '../../support/instrumentation/harness.js';

describe('T01 direct root for a callback outside any HTTP request', () => {
  let h: Harness;
  let app: OrdersApp;
  beforeEach(async () => {
    h = startHarness();
    app = await createOrdersApp({ enabled: true });
  });
  afterEach(async () => {
    await app.close();
    h.stop();
  });

  it('records a bare root (no provider calls) - the upstream gap registry:294-309', async () => {
    const value = trace('rabbitmq.consume', () => 42, { kind: 'rabbitmq', attributes: { queue: 'orders' } });
    expect(value).toBe(42);
    const items = await h.settle();
    expect(items).toHaveLength(1);
    const { trace: t, spans } = items[0];
    expect(t.operation).toBe('rabbitmq.consume');
    expect(t.kind).toBe('rabbitmq');
    expect(t.attributes).toEqual({ queue: 'orders' });
    expect(t.status).toBe('ok');
    expect(t.spanCount).toBe(1);
    expect(spans).toHaveLength(1);
    expect(spans[0].parentSpanId).toBeNull();
    expect(spans[0].origin).toBe('root');
    expect(spans[0].spanId).toBe(t.rootSpanId);
    expect(spans[0].operation).toBe(t.operation);
    expect(spans[0].durationMs).toBe(t.durationMs);
    expect(t.detail).toBe('full');
  });

  it('records a root with provider calls; spanCount matches the stored spans', async () => {
    let inside: string | undefined;
    const result = await trace(
      'rabbitmq.consume',
      async () => {
        inside = currentTraceId();
        return app.consumer.process({ id: 'm1' });
      },
      { kind: 'rabbitmq', attributes: { queue: 'orders', msgId: 'm1' } },
    );
    expect(result.id).toBe('m1');
    const items = await h.settle();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.trace.traceId).toBe(inside);
    expect(item.trace.spanCount).toBe(7);
    expect(item.spans).toHaveLength(7);
    expect(operationPaths(spanTree(item))).toEqual([
      'rabbitmq.consume',
      'rabbitmq.consume > OrdersConsumer.process',
      'rabbitmq.consume > OrdersConsumer.process > Validator.validate',
      'rabbitmq.consume > OrdersConsumer.process > Validator.validate > Transformer.execute',
      'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle',
      'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle > Repo.find',
      'rabbitmq.consume > OrdersConsumer.process > OrdersService.handle > Repo.find',
    ]);
    expect(currentTraceId()).toBeUndefined();
  });
});
