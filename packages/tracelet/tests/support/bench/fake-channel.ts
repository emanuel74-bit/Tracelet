import { EventEmitter } from 'node:events';

export interface Delivery {
  id: string;
  content: Buffer;
}

/** Minimal amqplib-style channel for the integrated bench (same shape as tests/support/instrumentation/fake-amqp-channel.ts, no timers). */
export class FakeAmqpChannel extends EventEmitter {
  readonly log: string[] = [];
  private readonly consumers = new Map<string, (msg: Delivery) => unknown>();

  consume(queue: string, cb: (msg: Delivery) => unknown): void {
    this.consumers.set(queue, cb);
  }

  deliver(queue: string, msg: Delivery): unknown {
    return this.consumers.get(queue)?.(msg);
  }

  ack(msg: Delivery): void {
    this.log.push(`ack:${msg.id}`);
  }

  nack(msg: Delivery): void {
    this.log.push(`nack:${msg.id}`);
  }

  reset(): void {
    this.log.length = 0;
  }
}
