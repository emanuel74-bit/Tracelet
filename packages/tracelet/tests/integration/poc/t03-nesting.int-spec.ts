import { Inject, Injectable, Module } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { createAppFor, createOrdersApp, sleep, type OrdersApp } from '../../support/instrumentation/orders-app.js';
import { operationPaths, spanTree, startHarness, type Harness } from '../../support/instrumentation/harness.js';

@Injectable()
class SyncInner {
  work(n: number): number {
    return n * 2;
  }
}

@Injectable()
class SyncOuter {
  constructor(@Inject(SyncInner) private readonly inner: SyncInner) {}
  run(): number {
    return this.inner.work(1) + this.inner.work(2);
  }
  async runAsync(): Promise<number> {
    await sleep(2);
    const a = this.inner.work(3);
    await sleep(1);
    return a + this.inner.work(4);
  }
}

@Module({ providers: [SyncInner, SyncOuter] })
class SyncModule {}

describe('T03 sync and async nesting produce the exact tree', () => {
  let h: Harness;
  beforeEach(() => {
    h = startHarness();
  });
  afterEach(() => h.stop());

  it('sync nesting under a sync root', async () => {
    const app = await createAppFor(SyncModule);
    const outer = app.get(SyncOuter);
    expect(trace('sync.root', () => outer.run(), { kind: 'custom' })).toBe(2 + 4);
    const items = await h.settle();
    expect(items).toHaveLength(1);
    expect(operationPaths(spanTree(items[0]))).toEqual([
      'sync.root',
      'sync.root > SyncOuter.run',
      'sync.root > SyncOuter.run > SyncInner.work',
      'sync.root > SyncOuter.run > SyncInner.work',
    ]);
    await app.close();
  });

  it('async nesting across awaits, and offsets are ordered', async () => {
    const app = await createAppFor(SyncModule);
    const outer = app.get(SyncOuter);
    expect(await trace('async.root', () => outer.runAsync(), { kind: 'custom' })).toBe(6 + 8);
    const items = await h.settle();
    expect(operationPaths(spanTree(items[0]))).toEqual([
      'async.root',
      'async.root > SyncOuter.runAsync',
      'async.root > SyncOuter.runAsync > SyncInner.work',
      'async.root > SyncOuter.runAsync > SyncInner.work',
    ]);
    for (const span of items[0].spans) {
      const parent = items[0].spans.find((s) => s.spanId === span.parentSpanId);
      if (parent) {
        expect(span.startOffsetMs).toBeGreaterThanOrEqual(parent.startOffsetMs);
        expect(span.startOffsetMs + span.durationMs).toBeLessThanOrEqual(parent.startOffsetMs + parent.durationMs + 0.5);
      }
    }
    const works = items[0].spans.filter((s) => s.method === 'work').sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    expect(works[1].startOffsetMs).toBeGreaterThanOrEqual(works[0].startOffsetMs);
    await app.close();
  });

  it('the orders tree is exactly process > validate > execute and handle > find x2', async () => {
    const app: OrdersApp = await createOrdersApp({ enabled: true });
    await trace('rabbitmq.consume', () => app.consumer.process({ id: 'x' }), { kind: 'rabbitmq' });
    const items = await h.settle();
    expect(spanTree(items[0])).toEqual({
      operation: 'rabbitmq.consume',
      origin: 'root',
      status: 'ok',
      children: [
        {
          operation: 'OrdersConsumer.process',
          origin: 'auto',
          status: 'ok',
          children: [
            {
              operation: 'Validator.validate',
              origin: 'auto',
              status: 'ok',
              children: [{ operation: 'Transformer.execute', origin: 'auto', status: 'ok', children: [] }],
            },
            {
              operation: 'OrdersService.handle',
              origin: 'auto',
              status: 'ok',
              children: [
                { operation: 'Repo.find', origin: 'auto', status: 'ok', children: [] },
                { operation: 'Repo.find', origin: 'auto', status: 'ok', children: [] },
              ],
            },
          ],
        },
      ],
    });
    await app.close();
  });
});
