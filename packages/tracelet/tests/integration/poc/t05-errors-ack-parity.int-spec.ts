import { afterEach, describe, expect, it } from 'vitest';
import { configureTracing, resetRuntimeForTesting, trace } from '../../../src/context/index.js';
import { FakeAmqpChannel, type FakeMessage } from '../../support/instrumentation/fake-amqp-channel.js';
import { createOrdersApp, type OrderMsg } from '../../support/instrumentation/orders-app.js';
import { startHarness } from '../../support/instrumentation/harness.js';

interface ScenarioResult {
  ackLog: string[];
  outcomes: Record<string, string>;
  caught: Map<string, unknown>;
}

const transformError = new Error('boom in transform');
const syncError = new Error('boom in validateSync');

function scenarioMessages(): OrderMsg[] {
  return [
    { id: 'a-ok' },
    { id: 'b-async-fail', fail: 'transform', error: transformError },
    { id: 'c-sync-fail', fail: 'sync', error: syncError },
    { id: 'd-ok' },
  ];
}

/** Sequential deliveries through the fake channel; each is acked or nacked after the traced handler settles. */
async function runScenario(tracingEnabled: boolean): Promise<ScenarioResult & { items: Awaited<ReturnType<ReturnType<typeof startHarness>['settle']>> }> {
  const h = startHarness({ tracing: { enabled: tracingEnabled } });
  const app = await createOrdersApp({ enabled: tracingEnabled });
  const channel = new FakeAmqpChannel();
  const outcomes: Record<string, string> = {};
  const caught = new Map<string, unknown>();
  const finished = new Map<string, () => void>();

  channel.consume('orders', async (msg: FakeMessage) => {
    try {
      const result = await trace('rabbitmq.consume', () => app.consumer.process(msg.content as OrderMsg), {
        kind: 'rabbitmq',
        attributes: { queue: 'orders' },
      });
      outcomes[msg.id] = `ok:${JSON.stringify(result)}`;
      channel.ack(msg);
    } catch (error) {
      outcomes[msg.id] = `err:${(error as Error).message}`;
      caught.set(msg.id, error);
      channel.nack(msg, false, false);
    }
    finished.get(msg.id)?.();
  });

  for (const content of scenarioMessages()) {
    await new Promise<void>((resolve) => {
      finished.set(content.id, resolve);
      channel.publish('orders', { id: content.id, content });
    });
  }
  const items = await h.settle();
  await app.close();
  h.stop();
  return { ackLog: channel.logLines(), outcomes, caught, items: [...items] };
}

describe('T05 errors, rejection identity and ack parity', () => {
  afterEach(() => resetRuntimeForTesting());

  it('same ordered ack/nack log and per-message outcomes with Tracelet disabled vs enabled', async () => {
    const disabled = await runScenario(false);
    const enabled = await runScenario(true);
    expect(disabled.items).toHaveLength(0); // nothing recorded when disabled
    expect(enabled.items).toHaveLength(4);
    expect(enabled.ackLog).toEqual(disabled.ackLog);
    expect(enabled.ackLog).toEqual(['ack:a-ok', 'nack:b-async-fail', 'nack:c-sync-fail', 'ack:d-ok']);
    expect(enabled.outcomes).toEqual(disabled.outcomes);
  });

  it('rejected === thrown (async) and caught === thrown (sync), by reference', async () => {
    const enabled = await runScenario(true);
    expect(enabled.caught.get('b-async-fail')).toBe(transformError);
    expect(enabled.caught.get('c-sync-fail')).toBe(syncError);
    const disabled = await runScenario(false);
    expect(disabled.caught.get('b-async-fail')).toBe(transformError);
    expect(disabled.caught.get('c-sync-fail')).toBe(syncError);
  });

  it('origin span has sanitizedError, ancestors have status error without payload, errorCount is 1, trace is error', async () => {
    const { items } = await runScenario(true);
    // map traces to messages by their order of completion: failures are the traces with status error
    const failed = items.filter((i) => i.trace.status === 'error');
    expect(failed).toHaveLength(2);
    for (const item of failed) {
      expect(item.trace.errorCount).toBe(1);
      expect(item.trace.error).toBeDefined();
      expect(item.trace.errorFingerprint).toMatch(/^[0-9a-f]{16}$/);
      const origins = item.spans.filter((s) => s.sanitizedError !== undefined);
      expect(origins).toHaveLength(1);
      const origin = origins[0];
      expect(origin.status).toBe('error');
      const byId = new Map(item.spans.map((s) => [s.spanId, s]));
      let cursor = byId.get(origin.parentSpanId!);
      while (cursor) {
        expect(cursor.status).toBe('error');
        expect(cursor.sanitizedError).toBeUndefined();
        cursor = cursor.parentSpanId ? byId.get(cursor.parentSpanId) : undefined;
      }
    }
    const asyncFail = failed.find((i) => i.spans.some((s) => s.operation === 'Transformer.execute' && s.sanitizedError))!;
    expect(asyncFail.spans.find((s) => s.sanitizedError)!.sanitizedError!.name).toBe('Error');
    expect(asyncFail.spans.find((s) => s.sanitizedError)!.sanitizedError!.message).toBe('boom in transform');
    const syncFail = failed.find((i) => i.spans.some((s) => s.operation === 'Validator.validateSync' && s.sanitizedError))!;
    expect(syncFail).toBeDefined();
    // successful traces carry no error data
    for (const ok of items.filter((i) => i.trace.status === 'ok')) {
      expect(ok.trace.errorCount).toBe(0);
      expect(ok.trace.error).toBeUndefined();
    }
  });

  it('configureTracing(enabled:false) after use is a pass-through', async () => {
    const h = startHarness();
    configureTracing({ enabled: false });
    expect(trace('x', () => 7)).toBe(7);
    await h.settle();
    expect(h.items).toHaveLength(0);
    h.stop();
  });
});
