/**
 * The tiny slice of an amqplib channel the worker uses. A real `amqplib` channel satisfies it structurally, and so does the
 * in-process FakeChannel below (used when AMQP_URL is not set, so the example runs without RabbitMQ).
 */
export interface Delivery {
  content: Buffer;
  fields?: { deliveryTag?: number };
}

export interface ConsumerChannel {
  consume(queue: string, onMessage: (msg: Delivery | null) => void): unknown;
  ack(msg: Delivery): void;
  nack(msg: Delivery, allUpTo?: boolean, requeue?: boolean): void;
}

/** In-process stand-in for a channel; deliveries come from timers, like a socket callback (outside any trace). */
export class FakeChannel implements ConsumerChannel {
  readonly log: string[] = [];
  private callback: ((msg: Delivery | null) => void) | undefined;

  consume(_queue: string, onMessage: (msg: Delivery | null) => void): void {
    this.callback = onMessage;
  }

  publish(body: unknown, delayMs = 0): void {
    const msg: Delivery = { content: Buffer.from(JSON.stringify(body)) };
    setTimeout(() => this.callback?.(msg), delayMs);
  }

  ack(msg: Delivery): void {
    this.log.push(`ack:${JSON.parse(msg.content.toString()).id}`);
  }

  nack(msg: Delivery, _allUpTo?: boolean, _requeue?: boolean): void {
    this.log.push(`nack:${JSON.parse(msg.content.toString()).id}`);
  }
}

/** Connects a real RabbitMQ channel. `amqplib` is a devDependency of THIS example only (see package.json). */
export async function connectAmqp(url: string, queue: string): Promise<{ channel: ConsumerChannel; close(): Promise<void> }> {
  const name = 'amqplib';
  const amqp = (await import(name)) as { connect(url: string): Promise<any> };
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  await channel.assertQueue(queue, { durable: true });
  await channel.prefetch(10);
  return { channel, close: () => connection.close() };
}
