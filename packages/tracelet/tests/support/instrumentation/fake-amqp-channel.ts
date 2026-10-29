import { EventEmitter } from 'node:events';

export interface FakeMessage<T = unknown> {
  id: string;
  content: T;
}

export interface AckLogEntry {
  op: 'ack' | 'nack';
  id: string;
}

/**
 * An EventEmitter-based stand-in for an amqplib channel: `consume(queue, cb)` registers a callback, `publish` delivers from a
 * timer (like a socket callback), `deliverSync` delivers inline. `ack`/`nack(msg, false, false)` calls are recorded in order.
 * No Nest transport decorators, no HTTP, no network.
 */
export class FakeAmqpChannel extends EventEmitter {
  readonly log: AckLogEntry[] = [];
  private readonly consumers = new Map<string, (msg: FakeMessage) => unknown>();

  consume(queue: string, callback: (msg: FakeMessage) => unknown): void {
    this.consumers.set(queue, callback);
  }

  /** Delivers asynchronously from a timer (the timer is created in the caller's async context, like a real channel). */
  publish(queue: string, msg: FakeMessage, delayMs = 0): void {
    setTimeout(() => this.deliverSync(queue, msg), delayMs);
  }

  /** Delivers inline, synchronously. */
  deliverSync(queue: string, msg: FakeMessage): unknown {
    this.emit('message', queue, msg);
    return this.consumers.get(queue)?.(msg);
  }

  ack(msg: FakeMessage): void {
    this.log.push({ op: 'ack', id: msg.id });
  }

  nack(msg: FakeMessage, _allUpTo = false, _requeue = false): void {
    this.log.push({ op: 'nack', id: msg.id });
  }

  /** The ack log as a canonical, order-preserving string list. */
  logLines(): string[] {
    return this.log.map((e) => `${e.op}:${e.id}`);
  }
}
