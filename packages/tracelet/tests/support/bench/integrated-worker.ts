import 'reflect-metadata';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Inject, Injectable, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FakeAmqpChannel } from './fake-channel';
import type { Delivery } from './fake-channel';

/*
 * T20 integrated-overhead worker (child process). Compiled with tsc into a temp dir by bench/integrated/overhead.int-spec.ts and
 * started with NODE_PATH=<repo>/node_modules. The Tracelet package under test is loaded from BENCH_TRACELET_ENTRY (a private build of
 * the current src, see the spec); in BENCH_MODE=off it is never required, so Tracelet is genuinely absent.
 *
 * Workload (the nest-worker shape): an amqplib-style consumer callback on an in-process fake channel -> trace('rabbitmq.consume')
 * -> Consumer.process -> Promise.all of Repo.find calls -> Validator.validate -> Transformer.execute (nested providers), a small
 * synchronous handler cost (BENCH_WORK_US busy-wait, identical in all modes) and an occasional error (BENCH_ERROR_EVERY, nack).
 * Provider "I/O" yields use setImmediate (not timers: Windows timer granularity is unreliable).
 *
 * Env: BENCH_MODE=off|on, BENCH_MESSAGES, BENCH_RATE (msgs/s offered; 0 = closed loop), BENCH_CONCURRENCY (closed-loop in-flight),
 * BENCH_WORK_US, BENCH_ERROR_EVERY, BENCH_WARMUP, BENCH_MONGO_URI, BENCH_DB, BENCH_SAMPLE_RATE (unset = Tracelet default),
 * BENCH_MAX_ROOTS_PER_SECOND (unset = default), BENCH_PROFILING=1, BENCH_PROFILE_WINDOW_MS (unset = product default).
 * IPC: child sends { event: 'ready' }, parent sends 'go' -> child sends { event: 'result' }, parent sends 'shutdown' -> { event: 'stopped' }.
 */

const env = process.env;
const MODE = env.BENCH_MODE === 'on' ? 'on' : 'off';
const MESSAGES = Number(env.BENCH_MESSAGES ?? 20000);
const RATE = Number(env.BENCH_RATE ?? 0);
const CONCURRENCY = Number(env.BENCH_CONCURRENCY ?? 32);
const WORK_US = Number(env.BENCH_WORK_US ?? 200);
const ERROR_EVERY = Number(env.BENCH_ERROR_EVERY ?? 50);
const WARMUP = Number(env.BENCH_WARMUP ?? 500);

const hr = (): number => Number(process.hrtime.bigint()) / 1000; // microseconds
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

function burnUs(us: number): void {
  const end = hr() + us;
  while (hr() < end) {
    // spin: identical synchronous handler cost in every mode
  }
}

interface Order {
  id: string;
  skus: string[];
  fail: boolean;
}

@Injectable()
class Transformer {
  async execute(o: Order): Promise<string> {
    await tick();
    if (o.fail) throw new Error('transform failed: mongodb://svc:s3cr3t@db.internal:27017');
    return `t:${o.id}`;
  }
}

@Injectable()
class Validator {
  constructor(@Inject(Transformer) private readonly transformer: Transformer) {}
  async validate(o: Order): Promise<string> {
    await tick();
    return this.transformer.execute(o);
  }
}

@Injectable()
class Repo {
  async find(sku: string): Promise<number> {
    await tick();
    return sku.length * 100;
  }
}

@Injectable()
class Consumer {
  constructor(
    @Inject(Validator) private readonly validator: Validator,
    @Inject(Repo) private readonly repo: Repo,
  ) {}
  async process(o: Order): Promise<number> {
    burnUs(WORK_US);
    const prices = await Promise.all(o.skus.map(s => this.repo.find(s)));
    await this.validator.validate(o);
    return prices.reduce((a, b) => a + b, 0);
  }
}

interface Debuggable {
  debug(): { state: string; queueDepth?: number; traceQueueDepth?: number; counters?: Record<string, number> };
}

const pct = (sorted: Float64Array, p: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);

async function main(): Promise<void> {
  const send = (m: Record<string, unknown>): void => void process.send?.(m);
  let traceFn: (<T>(name: string, fn: () => Promise<T>, o?: unknown) => Promise<T>) | undefined;
  const imports: unknown[] = [];
  let instrumentRef: unknown;
  let lifecycleCtor: (new (...a: never[]) => Debuggable) | undefined;

  if (MODE === 'on') {
    const entry = env.BENCH_TRACELET_ENTRY!;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const t = require(entry) as { TraceletModule: { forRoot(o: unknown): unknown }; createTraceletInstrument(o?: { enabled?: boolean }): unknown; trace: typeof traceFn };
    traceFn = t.trace;
    // NODE_ENV=production disables the DEFAULT instrument (instrument.ts isEnabled); provider tracing must be switched on explicitly,
    // otherwise only the custom root is measured (Stage 09 review H1).
    instrumentRef = t.createTraceletInstrument({ enabled: true });
    const tracing: Record<string, unknown> = {};
    if (env.BENCH_SAMPLE_RATE !== undefined && env.BENCH_SAMPLE_RATE !== '') tracing.sampleRate = Number(env.BENCH_SAMPLE_RATE);
    if (env.BENCH_MAX_ROOTS_PER_SECOND) tracing.maxRootsPerSecond = Number(env.BENCH_MAX_ROOTS_PER_SECOND);
    const profiling: Record<string, unknown> = { enabled: env.BENCH_PROFILING === '1' };
    if (env.BENCH_PROFILING === '1' && env.BENCH_PROFILE_WINDOW_MS) profiling.windowMs = Number(env.BENCH_PROFILE_WINDOW_MS);
    imports.push(
      t.TraceletModule.forRoot({
        enabled: true,
        serviceName: 'bench-integrated',
        storage: { uri: env.BENCH_MONGO_URI!, database: env.BENCH_DB ?? 'tracelet_bench' },
        tracing,
        profiling,
      }),
    );
    // The lifecycle class is internal (not exported); load it from the same build directory as the entry point.
    const dir = entry.replace(/[\\/][^\\/]*$/, '');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lifecycleCtor = (require(`${dir}/tracelet.module.js`) as { TraceletLifecycle: new (...a: never[]) => Debuggable }).TraceletLifecycle;
  }

  @Module({ imports: imports as never[], providers: [Transformer, Validator, Repo, Consumer] })
  class BenchModule {}

  const app: INestApplicationContext = await NestFactory.createApplicationContext(BenchModule, {
    logger: ['error'],
    ...(MODE === 'on' ? { instrument: instrumentRef as never } : {}),
  });
  app.enableShutdownHooks();
  await app.init();
  const consumer = app.get(Consumer);
  const lifecycle = lifecycleCtor ? (app.get(lifecycleCtor as never, { strict: false }) as Debuggable) : undefined;

  const channel = new FakeAmqpChannel();
  let acked = 0;
  let nacked = 0;
  const lat = new Float64Array(MESSAGES);
  let latN = 0;
  let record = false;
  // The amqplib-style consumer callback. Its returned promise settles when the message is acked/nacked; the callback duration is
  // the caller-visible latency.
  channel.consume('orders', (msg: Delivery): Promise<void> => {
    const t0 = hr();
    const body = JSON.parse(msg.content.toString()) as Order;
    const work = (): Promise<number> => consumer.process(body);
    const run = traceFn ? traceFn('rabbitmq.consume', work, { kind: 'rabbitmq', attributes: { queue: 'orders' } }) : work();
    return run.then(
      () => {
        channel.ack(msg);
        acked++;
        if (record) lat[latN++] = hr() - t0;
      },
      () => {
        channel.nack(msg);
        nacked++;
        if (record) lat[latN++] = hr() - t0;
      },
    );
  });

  const mkMsg = (i: number): Delivery => {
    const order: Order = { id: `m-${i}`, skus: ['apple', 'pear', 'fig'].slice(0, 1 + (i % 3)), fail: ERROR_EVERY > 0 && i % ERROR_EVERY === ERROR_EVERY - 1 };
    return { id: `m-${i}`, content: Buffer.from(JSON.stringify(order)) };
  };

  // Warm-up (JIT, Nest, first connections) outside the measured window, same in every mode.
  await Promise.all(Array.from({ length: WARMUP }, (_, i) => channel.deliver('orders', mkMsg(i)) as Promise<void>));
  channel.reset();
  acked = 0;
  nacked = 0;
  await tick();
  send({ event: 'ready', pid: process.pid, state: lifecycle?.debug().state ?? 'absent', countersAfterWarmup: lifecycle?.debug().counters });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    await app.close();
    const cpu = process.cpuUsage(cpu0);
    const d = lifecycle?.debug();
    const mem = process.memoryUsage();
    send({
      event: 'stopped',
      shutdownMs: performance.now() - t0,
      shutdownCpuMs: (cpu.user + cpu.system) / 1000,
      counters: d?.counters,
      queueDepth: d?.queueDepth,
      traceQueueDepth: d?.traceQueueDepth,
      heapUsedEndMb: mem.heapUsed / 1048576,
      rssEndMb: mem.rss / 1048576,
    });
    process.exit(0);
  };

  const runLoad = async (): Promise<void> => {
    const loop = monitorEventLoopDelay({ resolution: 10 });
    let peakRss = 0;
    let peakHeap = 0;
    const sample = (): void => {
      const m = process.memoryUsage();
      if (m.rss > peakRss) peakRss = m.rss;
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    };
    sample();
    const sampler = setInterval(sample, 100);
    sampler.unref();
    record = true;
    const elu0 = performance.eventLoopUtilization();
    const cpu0 = process.cpuUsage();
    const wall0 = performance.now();
    loop.enable();

    if (RATE > 0) {
      // Offered rate: arrival i is due at start + i/RATE on a monotonic clock; a coarse 1 ms timer tick delivers everything that is
      // due, so Windows timer granularity changes burst size, not the average rate. Deliveries are not awaited (open loop).
      const inflight: Promise<void>[] = [];
      const start = hr();
      let i = 0;
      while (i < MESSAGES) {
        const due = Math.min(MESSAGES, Math.floor(((hr() - start) / 1e6) * RATE) + 1);
        while (i < due) inflight.push(channel.deliver('orders', mkMsg(i++)) as Promise<void>);
        if (i < MESSAGES) await new Promise<void>(r => setTimeout(r, 1));
      }
      await Promise.all(inflight);
    } else {
      // Closed loop: CONCURRENCY messages in flight, a new one starts as soon as one settles.
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < MESSAGES) await (channel.deliver('orders', mkMsg(next++)) as Promise<void>);
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, lane));
    }

    const wallMs = performance.now() - wall0;
    const cpu = process.cpuUsage(cpu0);
    const elu = performance.eventLoopUtilization(elu0);
    loop.disable();
    record = false;
    clearInterval(sampler);
    sample();
    const mem = process.memoryUsage();
    const sorted = lat.subarray(0, latN).slice().sort();
    const d = lifecycle?.debug();
    send({
      event: 'result',
      messages: MESSAGES,
      settled: acked + nacked,
      acked,
      nacked,
      ackLogLength: channel.log.length,
      wallMs,
      throughputPerSec: (MESSAGES / wallMs) * 1000,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      cpuUsPerMessage: (cpu.user + cpu.system) / MESSAGES,
      latencyUs: { n: latN, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: sorted.length ? sorted[sorted.length - 1] : 0 },
      eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6, mean: loop.mean / 1e6 },
      eventLoopUtilization: elu.utilization,
      rssPeakMb: peakRss / 1048576,
      rssEndMb: mem.rss / 1048576,
      heapUsedPeakMb: peakHeap / 1048576,
      heapUsedEndMb: mem.heapUsed / 1048576,
      lifecycleState: d?.state ?? 'absent',
      countersAtEnd: d?.counters,
      queueDepthAtEnd: d?.queueDepth,
      traceQueueDepthAtEnd: d?.traceQueueDepth,
    });
  };

  process.on('message', m => {
    if (m === 'go') {
      void runLoad().catch((e: unknown) => {
        send({ event: 'error', message: String((e as Error)?.stack ?? e) });
        process.exit(1);
      });
    }
    if (m === 'shutdown') void stop();
  });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
