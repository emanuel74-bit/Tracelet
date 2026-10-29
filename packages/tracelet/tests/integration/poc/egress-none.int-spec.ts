import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { FakeAmqpChannel, type FakeMessage } from '../../support/instrumentation/fake-amqp-channel.js';
import { createOrdersApp, type OrderMsg } from '../../support/instrumentation/orders-app.js';
import { startHarness } from '../../support/instrumentation/harness.js';

describe('egress: Tracelet makes no network calls during the full T01-T05 scenario', () => {
  afterEach(() => vi.restoreAllMocks());

  it('net.Socket.connect, tls.connect, http(s).request, fetch and dns.lookup are never called', async () => {
    const spies = {
      'net.Socket.prototype.connect': vi.spyOn(net.Socket.prototype, 'connect'),
      'tls.connect': vi.spyOn(tls, 'connect'),
      'http.request': vi.spyOn(http, 'request'),
      'https.request': vi.spyOn(https, 'request'),
      'globalThis.fetch': vi.spyOn(globalThis, 'fetch'),
      'dns.lookup': vi.spyOn(dns, 'lookup'),
    };

    const h = startHarness();
    const app = await createOrdersApp({ enabled: true });
    const channel = new FakeAmqpChannel();
    const done: Array<Promise<unknown>> = [];
    const boom = new Error('egress-scenario');
    channel.consume('orders', (msg: FakeMessage) => {
      const p = trace('rabbitmq.consume', () => app.consumer.process(msg.content as OrderMsg), {
        kind: 'rabbitmq',
        attributes: { queue: 'orders' },
      }).then(
        () => channel.ack(msg),
        () => channel.nack(msg, false, false),
      );
      done.push(p);
      return p;
    });
    // T01 bare root, T02 concurrency, T03/T04 trees, T05 errors
    trace('bare', () => 1, { kind: 'rabbitmq' });
    const messages: OrderMsg[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `ok${i}`, delayMs: 1 + (i % 4) })),
      { id: 'fail-async', fail: 'transform', error: boom },
      { id: 'fail-sync', fail: 'sync', error: boom },
    ];
    for (const content of messages) channel.publish('orders', { id: content.id, content });
    while (done.length < messages.length) await new Promise((r) => setTimeout(r, 5));
    await Promise.all(done);
    const items = await h.settle();
    expect(items.length).toBe(messages.length + 1);

    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, name).not.toHaveBeenCalled();
    }
    await app.close();
    h.stop();
  });
});
