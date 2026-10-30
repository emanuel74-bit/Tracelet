import { createHash, timingSafeEqual } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Tracelet, TraceletInstrument, TraceletModule, trace } from 'tracelet';
import type { StandaloneServer, TraceletAuthRequest, TraceletModuleOptions } from 'tracelet';
import { FakeChannel, connectAmqp } from './channel';
import type { ConsumerChannel, Delivery } from './channel';
import { OrdersService, PriceRepository } from './orders';
import type { OrderMessage } from './orders';

export interface WorkerConfig {
  serviceName: string;
  /** TRACELET_STORAGE_URI. Shared by every replica; a dedicated observability user is recommended. */
  mongoUri: string;
  database: string;
  /** Set to use a real RabbitMQ; otherwise an in-process fake channel produces demo messages. */
  amqpUrl?: string;
  queue: string;
  observeHost: string;
  /** 0 = ephemeral. */
  observePort: number;
  /** When set, /observe requires `Authorization: Bearer <token>`. Otherwise only loopback peers are allowed. */
  observeToken?: string;
  /** Fake channel only: number of demo messages (0 = none) and the gap between them. */
  demoMessages: number;
  demoIntervalMs: number;
  sampleRate: number;
  /** Optional tuning knobs (MAX_ROOTS_PER_SECOND, QUEUE_MAX_TRACES); unset = Tracelet defaults. */
  maxRootsPerSecond?: number;
  queueMaxTraces?: number;
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): WorkerConfig {
  const num = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    serviceName: env.SERVICE_NAME ?? 'nest-worker-example',
    mongoUri: env.TRACELET_STORAGE_URI ?? 'mongodb://127.0.0.1:27017',
    database: env.TRACELET_DB ?? 'observability',
    ...(env.AMQP_URL ? { amqpUrl: env.AMQP_URL } : {}),
    queue: env.AMQP_QUEUE ?? 'orders',
    observeHost: env.OBSERVE_HOST ?? '127.0.0.1',
    observePort: num(env.OBSERVE_PORT, 3100),
    ...(env.OBSERVE_TOKEN ? { observeToken: env.OBSERVE_TOKEN } : {}),
    demoMessages: num(env.DEMO_MESSAGES, 0),
    demoIntervalMs: num(env.DEMO_INTERVAL_MS, 200),
    sampleRate: num(env.SAMPLE_RATE, 1),
    ...(env.MAX_ROOTS_PER_SECOND ? { maxRootsPerSecond: num(env.MAX_ROOTS_PER_SECOND, 20) } : {}),
    ...(env.QUEUE_MAX_TRACES ? { queueMaxTraces: num(env.QUEUE_MAX_TRACES, 2000) } : {}),
  };
}

export function traceletOptions(config: WorkerConfig): TraceletModuleOptions {
  return {
    enabled: true, // explicit: the example does not depend on NODE_ENV
    serviceName: config.serviceName,
    storage: { uri: config.mongoUri, database: config.database },
    tracing: { sampleRate: config.sampleRate, ...(config.maxRootsPerSecond !== undefined ? { maxRootsPerSecond: config.maxRootsPerSecond } : {}) },
    ...(config.queueMaxTraces !== undefined ? { buffer: { maxQueuedTraces: config.queueMaxTraces } } : {}),
    profiling: { enabled: false }, // continuous CPU profiling is opt-in
  };
}

/** Constant-time bearer check; replace with your own SSO / session check in a real service. */
export function bearerAuthorize(token: string | undefined): (req: TraceletAuthRequest) => boolean {
  const expected = createHash('sha256').update(token ?? '').digest();
  return req => {
    if (typeof token !== 'string' || token.length === 0) return false; // not configured: deny
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
    return timingSafeEqual(createHash('sha256').update(value.slice(7)).digest(), expected);
  };
}

export function createAppModule(config: WorkerConfig): new () => unknown {
  @Module({ imports: [TraceletModule.forRoot(traceletOptions(config))], providers: [PriceRepository, OrdersService] })
  class WorkerModule {}
  return WorkerModule;
}

export interface WorkerHandle {
  app: INestApplicationContext;
  /** The ack/nack log of the in-process channel (empty with a real RabbitMQ). */
  acks: string[];
  observe: StandaloneServer | undefined;
  /** Resolves when every demo message was acked or nacked. */
  drained: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts the worker: a Nest application context (no HTTP server), TraceletModule, the Tracelet dashboard on its own
 * loopback listener, and a raw amqplib-style consumer whose callback is wrapped in trace().
 */
export async function startWorker(config: WorkerConfig, injected?: { channel?: ConsumerChannel }): Promise<WorkerHandle> {
  // TraceletInstrument traces every provider method; trace() below creates the ROOT for the direct library callback.
  const app = await NestFactory.createApplicationContext(createAppModule(config), { logger: ['error', 'warn'], instrument: TraceletInstrument });
  app.enableShutdownHooks();
  await app.init();

  const observe = await Tracelet.listen({
    host: config.observeHost,
    port: config.observePort,
    ...(config.observeToken !== undefined ? { authorize: bearerAuthorize(config.observeToken) } : { allowLoopbackWithoutAuth: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' }),
  });

  const orders = app.get(OrdersService);
  const fake = injected?.channel === undefined && config.amqpUrl === undefined ? new FakeChannel() : undefined;
  const amqp = fake === undefined && injected?.channel === undefined ? await connectAmqp(config.amqpUrl!, config.queue) : undefined;
  const channel: ConsumerChannel = injected?.channel ?? fake ?? amqp!.channel;

  let settled = 0;
  let onDrained!: () => void;
  const drained = new Promise<void>(resolve => (onDrained = resolve));
  channel.consume(config.queue, (msg: Delivery | null) => {
    if (msg === null) return;
    const body = JSON.parse(msg.content.toString()) as OrderMessage;
    // trace() returns the handler's own promise outcome, so ack/nack behave exactly as without Tracelet.
    void trace('rabbitmq.consume', () => orders.total(body), { kind: 'rabbitmq', attributes: { queue: config.queue } }).then(
      () => {
        channel.ack(msg);
        if (config.demoMessages > 0 && ++settled >= config.demoMessages) onDrained();
      },
      () => {
        channel.nack(msg, false, false);
        if (config.demoMessages > 0 && ++settled >= config.demoMessages) onDrained();
      },
    );
  });

  if (fake !== undefined) {
    for (let i = 0; i < config.demoMessages; i++) {
      fake.publish({ id: `m-${i + 1}`, skus: ['apple', 'pear', 'fig'].slice(0, 1 + (i % 3)), poison: i % 5 === 4 }, i * config.demoIntervalMs);
    }
    if (config.demoMessages === 0) onDrained();
  }

  let stopping: Promise<void> | undefined;
  return {
    app,
    acks: fake?.log ?? [],
    observe,
    drained,
    stop: () =>
      (stopping ??= (async () => {
        await app.close(); // beforeApplicationShutdown / onApplicationShutdown flush telemetry; also closes the dashboard listener
        await amqp?.close().catch(() => undefined);
      })()),
  };
}
