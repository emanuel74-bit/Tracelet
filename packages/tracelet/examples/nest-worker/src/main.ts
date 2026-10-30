import 'reflect-metadata';
import { configFromEnv, startWorker } from './worker';

async function main(): Promise<void> {
  const config = configFromEnv();
  const worker = await startWorker(config);
  const url = worker.observe ? `http://${worker.observe.host}:${worker.observe.port}/observe/` : 'disabled';
  console.log(JSON.stringify({ event: 'ready', service: config.serviceName, dashboard: url, channel: config.amqpUrl ? 'rabbitmq' : 'in-process-fake' }));

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(() => {
      console.log(JSON.stringify({ event: 'stopped', acks: worker.acks }));
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // `process.send` exists when started with child_process.fork (tests); 'shutdown' is the portable graceful stop on Windows.
  process.on('message', message => {
    if (message === 'shutdown') stop();
  });

  await worker.drained;
  console.log(JSON.stringify({ event: 'drained', acks: worker.acks }));
  if (config.amqpUrl === undefined && process.env.EXIT_WHEN_DRAINED === '1') stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'Error');
  process.exit(1);
});
