import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TraceletModule, trace } from 'tracelet';

/*
 * Child-process fixture for sigterm.e2e-spec.ts. A Nest application context with TraceletModule.forRoot and
 * app.enableShutdownHooks() and NO other signal handling: the parent sends a real SIGTERM and Nest's own handler must run the
 * shutdown hooks (flushing telemetry) and then re-raise the signal.
 * Env: SERVICE_NAME, TRACELET_STORAGE_URI, TRACELET_DB, SIGTERM_MODE = 'flush' | 'inflight', SIGTERM_TRACES (flush mode count).
 * The storage writer is deliberately slow (buffer.maxWriteDocsPerSecond = WRITE_DOCS_PER_SECOND, one paced insert per document, traces and
 * spans alike) so that, by construction, traces are still queued when the parent sends SIGTERM and only the shutdown flush
 * (buffer.shutdownFlushTimeoutMs) can persist them.
 * In 'inflight' mode the traced callback sleeps 60 s: it can never finish before the process ends, so the shutdown force-close is the only
 * way the root gets persisted.
 * IPC to parent: ready | results {values} (flush) | inflight-started | inflight-done {value} (never expected in 'inflight' mode).
 */

const send = (m: Record<string, unknown>): void => void process.send?.(m);
const WRITE_DOCS_PER_SECOND = 8; // 125 ms per document: 20 traces need at least 2.5 s, far more than the parent's pre-SIGTERM gap
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

@Module({
  imports: [
    TraceletModule.forRoot({
      enabled: true,
      serviceName: process.env.SERVICE_NAME ?? 'sigterm-e2e',
      storage: { uri: process.env.TRACELET_STORAGE_URI!, database: process.env.TRACELET_DB! },
      tracing: { sampleRate: 1 },
      buffer: { maxWriteDocsPerSecond: WRITE_DOCS_PER_SECOND, shutdownFlushTimeoutMs: 10_000 },
      profiling: { enabled: false },
    }),
  ],
})
class FixtureModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(FixtureModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  await app.init();
  // keep the loop alive independently of Mongo sockets; Nest re-raises SIGTERM after the hooks, which ends the process
  setInterval(() => undefined, 1_000);
  send({ event: 'ready', pid: process.pid });

  if (process.env.SIGTERM_MODE === 'inflight') {
    const value = await trace(
      'sigterm.inflight',
      async () => {
        send({ event: 'inflight-started' });
        await sleep(60_000); // never completes: Nest re-raises SIGTERM after the shutdown hooks
        return 'ack:inflight';
      },
      { kind: 'rabbitmq' },
    );
    send({ event: 'inflight-done', value });
    return;
  }

  const n = Number(process.env.SIGTERM_TRACES ?? 20);
  const values: string[] = [];
  for (let i = 1; i <= n; i++) {
    // the ack-like return value of the traced callback must be passed through unchanged
    values.push(await trace('sigterm.flush', async () => (i % 5 === 0 ? `nack:m-${i}` : `ack:m-${i}`), { kind: 'rabbitmq' }));
  }
  send({ event: 'results', values });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
