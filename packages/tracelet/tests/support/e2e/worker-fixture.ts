import 'reflect-metadata';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { configFromEnv, startWorker } from '../../../examples/nest-worker/src/worker';

/*
 * Child-process fixture for the e2e suites: the examples/nest-worker worker (raw amqplib-style consumer on the in-process fake
 * channel, TraceletModule, standalone dashboard listener) plus an IPC control channel. It runs against the BUILT package: the
 * test compiles it with tsc into a temp dir and starts it with NODE_PATH so that `tracelet` resolves to packages/tracelet/dist.
 * Messages to the parent: ready | drained | stopped (with ack log, telemetry counters and the shutdown duration).
 */

interface Debuggable {
  debug(): { state: string; instanceId?: string; queueDepth?: number; traceQueueDepth?: number; counters?: Record<string, number> };
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const worker = await startWorker(config);
  // The lifecycle class is internal (not exported by the package); load it from the same dist directory `tracelet` resolves to.
  const modulePath = join(dirname(require.resolve('tracelet')), 'tracelet.module.js');
  const { TraceletLifecycle } = createRequire(__filename)(modulePath) as { TraceletLifecycle: new (...a: never[]) => Debuggable };
  const lifecycle = worker.app.get(TraceletLifecycle as never, { strict: false }) as Debuggable;
  const send = (m: Record<string, unknown>): void => void process.send?.(m);
  send({ event: 'ready', port: worker.observe?.port, instanceId: lifecycle.debug().instanceId, state: lifecycle.debug().state, pid: process.pid });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    await worker.stop();
    const d = lifecycle.debug();
    send({ event: 'stopped', acks: worker.acks, counters: d.counters, queueDepth: d.queueDepth, traceQueueDepth: d.traceQueueDepth, shutdownMs: Date.now() - t0 });
    process.exit(0);
  };
  process.on('message', m => {
    if (m === 'shutdown') void stop();
  });
  await worker.drained;
  const d = lifecycle.debug();
  send({ event: 'drained', acks: worker.acks, counters: d.counters, traceQueueDepth: d.traceQueueDepth });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
