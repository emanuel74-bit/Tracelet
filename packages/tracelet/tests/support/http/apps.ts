import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { TraceletAuthRequest } from '../../../src/contracts/observe-contracts.js';
import type { ApiHandler } from '../../../src/contracts/tracelet-internal-contracts.js';
import { createTraceletInstrument } from '../../../src/instrumentation/index.js';
import { createAuthGate } from '../../../src/http/auth.js';
import { createDispatcher } from '../../../src/http/dispatcher.js';
import { mountExpress } from '../../../src/http/mount-express.js';
import { mountFastify } from '../../../src/http/mount-fastify.js';
import { createStaticAssets } from '../../../src/http/static-assets.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';
import { stubApi } from './http.js';
import type { StubApi } from './http.js';

export type AdapterName = 'express' | 'fastify';

@Controller()
export class HostController {
  @Get('hello')
  hello(): string {
    return 'hello from the host app';
  }
}

@Module({ controllers: [HostController] })
export class HostModule {}

export interface HostAppOptions {
  adapter: AdapterName;
  /** Mount path. Default '/observe'. */
  basePath?: string;
  /** Nest global prefix (Tracelet is NOT affected by it). */
  globalPrefix?: string;
  /** Express `trust proxy` / Fastify `trustProxy`. */
  trustProxy?: boolean;
  authorize?: (req: TraceletAuthRequest) => boolean | Promise<boolean>;
  allowLoopbackWithoutAuth?: boolean;
  api?: ApiHandler;
  /** Host module (default: HostModule). */
  module?: new () => unknown;
  instrument?: boolean;
  listenHost?: string;
}

export interface HostApp {
  app: INestApplication;
  port: number;
  stub: StubApi;
  basePath: string;
  close(): Promise<void>;
}

/** A real Nest application on the given platform adapter with Tracelet's HTTP layer mounted before init. */
export async function startHostApp(o: HostAppOptions): Promise<HostApp> {
  const basePath = o.basePath ?? '/observe';
  const stub = stubApi();
  const quiet = createDiagnostics('t', () => {});
  const dispatch = createDispatcher({
    basePath,
    auth: createAuthGate({
      ...(o.authorize ? { authorize: o.authorize } : {}),
      ...(o.allowLoopbackWithoutAuth !== undefined ? { allowLoopbackWithoutAuth: o.allowLoopbackWithoutAuth } : {}),
      diagnostics: quiet,
    }),
    api: o.api ?? stub.handler,
    assets: createStaticAssets(basePath),
    diagnostics: quiet,
  });
  const options = { logger: false as const, abortOnError: false, ...(o.instrument ? { instrument: createTraceletInstrument({ enabled: true }) } : {}) };
  const module = (o.module ?? HostModule) as new () => unknown;
  let app: INestApplication;
  if (o.adapter === 'express') {
    app = await NestFactory.create(module, new ExpressAdapter(), options);
    const express = app.getHttpAdapter().getInstance();
    if (o.trustProxy) express.set('trust proxy', true);
    if (o.globalPrefix) app.setGlobalPrefix(o.globalPrefix);
    mountExpress(express, basePath, dispatch);
  } else {
    app = await NestFactory.create(module, new FastifyAdapter({ trustProxy: o.trustProxy === true }), options);
    if (o.globalPrefix) app.setGlobalPrefix(o.globalPrefix);
    mountFastify(app.getHttpAdapter().getInstance(), basePath, dispatch);
  }
  await app.listen(0, o.listenHost ?? '0.0.0.0');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, port, stub, basePath, close: () => app.close() };
}
