import type { DynamicModule, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { TraceletModuleOptions, TraceletSetupOptions } from '../../../src/index.js';
import { createTraceletInstrument } from '../../../src/instrumentation/index.js';
import { Tracelet } from '../../../src/tracelet.js';
import { TRACELET_DEPS, TraceletModule } from '../../../src/tracelet.module.js';
import type { LifecycleDeps } from '../../../src/tracelet.module.js';
import { fakeCreateStorage, recordingDiagnostics } from './fakes.js';
import type { DiagLine, FakeStorageLog } from './fakes.js';

/** Collections with no documents: the REAL QueryService runs over them (empty lists, no Mongo). */
export function emptyCollections(): Record<string, unknown> {
  const cursor = () => {
    const c = { sort: () => c, limit: () => c, toArray: async () => [] as unknown[] };
    return c;
  };
  const collection = { find: cursor, findOne: async () => null, aggregate: cursor, createIndex: async () => 'x', insertMany: async () => undefined, replaceOne: async () => undefined };
  return { traces: collection, spans: collection, profiles: collection, operations: collection, methods: collection, metrics: collection, instances: collection };
}

export const TEST_OPTIONS: TraceletModuleOptions = {
  serviceName: 'mount-test',
  storage: { uri: 'mongodb://127.0.0.1:1/mount' },
  tracing: { sampleRate: 1 },
  runtimeMetrics: { enabled: false },
};

/** TraceletModule.forRoot with the lifecycle seams (fake storage over empty collections) injected. */
export function testTraceletModule(options: TraceletModuleOptions, log: FakeStorageLog, diag?: { lines: DiagLine[] }): DynamicModule {
  const base = TraceletModule.forRoot(options);
  const d = recordingDiagnostics();
  if (diag) diag.lines = d.lines;
  const deps: LifecycleDeps = { createStorage: fakeCreateStorage(log, { collections: emptyCollections() }), diagnostics: d.diagnostics };
  return { ...base, providers: [...(base.providers ?? []), { provide: TRACELET_DEPS, useValue: deps }] };
}

export interface BootedApp {
  app: INestApplication;
  port: number;
  log: FakeStorageLog;
  close(): Promise<void>;
}

export interface BootOptions {
  adapter: 'express' | 'fastify';
  module: new () => unknown;
  setup?: TraceletSetupOptions | false;
  globalPrefix?: string;
  instrument?: boolean;
  trustProxy?: boolean;
  log?: FakeStorageLog;
  listenHost?: string;
}

/** NestFactory.create + Tracelet.setup (before init) + listen on an ephemeral port. */
export async function bootApp(o: BootOptions): Promise<BootedApp> {
  const log = o.log ?? { events: [], created: 0, connected: true };
  const options = { logger: false as const, abortOnError: false, ...(o.instrument ? { instrument: createTraceletInstrument({ enabled: true }) } : {}) };
  let app: INestApplication;
  if (o.adapter === 'express') {
    app = await NestFactory.create(o.module, new ExpressAdapter(), options);
    if (o.trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', true);
  } else {
    app = await NestFactory.create(o.module, new FastifyAdapter({ trustProxy: o.trustProxy === true }), options);
  }
  if (o.globalPrefix) app.setGlobalPrefix(o.globalPrefix);
  app.enableShutdownHooks();
  if (o.setup !== false) Tracelet.setup(app, o.setup ?? {});
  await app.listen(0, o.listenHost ?? '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, port, log, close: () => app.close() };
}
