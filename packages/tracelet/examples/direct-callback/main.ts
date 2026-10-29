/*
 * Direct-callback example: a plain Nest application context (no HTTP, no Mongo, no network) and a fake amqp channel whose consume
 * callback is wrapped in trace(). Providers are traced automatically by createTraceletInstrument(); the captured spans are read
 * back from the in-memory queue and printed. Nothing here is simulated telemetry: every line printed is a record that went
 * through the real registry, mapper and queue.
 *
 * Wiring shown here (configureTracing, setTelemetryQueue, createBufferHooks, whenCompletionsIdle at shutdown) is what the
 * TraceletModule lifecycle does; the example calls it by hand because the module is wired in a later mission.
 */
import { EventEmitter } from 'node:events';
import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BoundedTelemetryQueue,
  createBufferHooks,
  RollupAccumulator,
} from '../../src/buffer/index.js';
import {
  closeAllOpenRoots,
  configureTracing,
  LogRedactor,
  setTelemetryQueue,
  trace,
  whenCompletionsIdle,
} from '../../src/context/index.js';
import type { RollupItem, TraceItem } from '../../src/contracts/index.js';
import { createTraceletInstrument } from '../../src/instrumentation/index.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- application providers (plain Nest, no Tracelet imports) ---------------- */

@Injectable()
export class PriceRepository {
  async lookup(sku: string): Promise<number> {
    await sleep(8);
    if (sku === 'broken') throw new Error('price service unavailable (mongodb://svc:s3cr3t@db.internal:27017)');
    return sku.length * 100;
  }
}

@Injectable()
export class OrderService {
  constructor(@Inject(PriceRepository) private readonly prices: PriceRepository) {}

  async total(skus: string[]): Promise<number> {
    const prices = await Promise.all(skus.map((sku) => this.prices.lookup(sku)));
    return prices.reduce((sum, p) => sum + p, 0);
  }
}

@Injectable()
export class OrderConsumer {
  constructor(@Inject(OrderService) private readonly orders: OrderService) {}

  async handle(message: { id: string; skus: string[] }): Promise<number> {
    return this.orders.total(message.skus);
  }
}

@Module({ providers: [PriceRepository, OrderService, OrderConsumer] })
export class AppModule {}

/* ---------------- a tiny amqplib-style channel ---------------- */

interface Message {
  id: string;
  skus: string[];
}

class FakeChannel extends EventEmitter {
  readonly acks: string[] = [];
  private callback: ((msg: Message) => unknown) | undefined;
  consume(_queue: string, callback: (msg: Message) => unknown): void {
    this.callback = callback;
  }
  /** Like a socket callback: delivered from a timer, outside any trace. */
  deliver(msg: Message): void {
    setTimeout(() => void this.callback?.(msg), 0);
  }
  ack(msg: Message): void {
    this.acks.push(`ack:${msg.id}`);
  }
  nack(msg: Message): void {
    this.acks.push(`nack:${msg.id}`);
  }
}

/* ---------------- the example ---------------- */

export interface ExampleResult {
  items: TraceItem[];
  rollups: RollupItem[];
  acks: string[];
  lines: string[];
}

export async function runExample(print: (line: string) => void = () => {}): Promise<ExampleResult> {
  const lines: string[] = [];
  const out = (line: string): void => {
    lines.push(line);
    print(line);
  };

  // 1. Telemetry plumbing: a bounded queue, the rollup accumulator and the mapper hooks.
  const queue = new BoundedTelemetryQueue();
  const rollups = new RollupAccumulator({ serviceName: 'direct-callback', instanceId: 'example-1', offer: (item) => queue.offer(item) });
  const hooks = createBufferHooks({
    queue,
    rollups,
    mapper: { serviceName: 'direct-callback', instanceId: 'example-1', errorMessages: 'redacted', redactor: new LogRedactor() },
  });
  setTelemetryQueue(queue);
  configureTracing({ enabled: true, sampleRate: 1, ...hooks });

  // 2. The Nest application context with the Tracelet instrument (explicit enable: it does not depend on NODE_ENV).
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    instrument: createTraceletInstrument({ enabled: true }),
  });
  const consumer = app.get(OrderConsumer);

  // 3. The direct library callback, wrapped in trace(): business behaviour (return value, ack/nack) is unchanged.
  const channel = new FakeChannel();
  const pending: Array<Promise<void>> = [];
  channel.consume('orders', (msg) => {
    const done = (async () => {
      try {
        await trace('rabbitmq.consume', () => consumer.handle(msg), { kind: 'rabbitmq', attributes: { queue: 'orders' } });
        channel.ack(msg);
      } catch {
        channel.nack(msg);
      }
    })();
    pending.push(done);
  });
  channel.deliver({ id: 'm-1', skus: ['apple', 'pear'] });
  channel.deliver({ id: 'm-2', skus: ['broken'] });
  channel.deliver({ id: 'm-3', skus: ['fig'] });
  await sleep(20);
  await Promise.all(pending);

  // 4. Graceful shutdown order (the module does this in onApplicationShutdown): stop starting new roots, close open roots, wait
  //    for the deferred completions, flush the rollups, then the writer would flush the queue. Here "the writer" is a drain.
  configureTracing({ enabled: false });
  closeAllOpenRoots('shutdown');
  await whenCompletionsIdle(2000);
  rollups.shutdown();
  const drained = queue.drain(1000, Number.MAX_SAFE_INTEGER);
  const items = drained.filter((i): i is TraceItem => i.type === 'trace');
  const rollupItems = drained.filter((i): i is RollupItem => i.type === 'rollup');

  // 5. Print what was really captured.
  out(`ack log: ${channel.acks.join(', ')}`);
  for (const item of items) {
    const t = item.trace;
    out(`trace ${t.traceId.slice(-8)}  ${t.operation}  kind=${t.kind}  status=${t.status}  spans=${t.spanCount}  ${t.durationMs.toFixed(1)} ms`);
    const names = new Map(item.spans.map((s) => [s.spanId, s.operation]));
    for (const span of item.spans) {
      const parent = span.parentSpanId === null ? '-' : names.get(span.parentSpanId);
      out(`  ${span.operation.padEnd(28)} parent=${String(parent).padEnd(26)} +${span.startOffsetMs.toFixed(1).padStart(6)} ms  dur=${span.durationMs.toFixed(1).padStart(6)} ms  ${span.status}`);
      if (span.sanitizedError) out(`    error ${span.sanitizedError.name}: ${span.sanitizedError.message ?? '(omitted)'}`);
    }
  }
  for (const rollup of rollupItems) {
    for (const op of rollup.operations) out(`rollup ${op.operation}: count=${op.count} errors=${op.errorCount} max=${op.durationMaxMs.toFixed(1)} ms`);
  }

  await app.close();
  return { items, rollups: rollupItems, acks: channel.acks, lines };
}

if (require.main === module) {
  runExample((line) => console.log(line)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
