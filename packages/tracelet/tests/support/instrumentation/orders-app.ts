import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { TraceletInstrumentOptions } from '../../../src/contracts/index.js';
import { createTraceletInstrument } from '../../../src/instrumentation/index.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Busy-waits `ms` milliseconds of synchronous work. */
export function burn(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

export interface OrderMsg {
  id: string;
  /** Latency of each async provider step. */
  delayMs?: number;
  /** 'transform' = Transformer.execute rejects (origin deep in the tree); 'sync' = Validator.validateSync throws synchronously. */
  fail?: 'transform' | 'sync';
  /** The exact error instance a failing provider throws (reference identity assertions). */
  error?: Error;
}

@Injectable()
export class Transformer {
  async execute(msg: OrderMsg): Promise<string> {
    await sleep(msg.delayMs ?? 1);
    if (msg.fail === 'transform') {
      throw msg.error ?? new Error('transform failed');
    }
    return `t:${msg.id}`;
  }
}

@Injectable()
export class Validator {
  constructor(@Inject(Transformer) private readonly transformer: Transformer) {}

  async validate(msg: OrderMsg): Promise<string> {
    await sleep(msg.delayMs ?? 1);
    return this.transformer.execute(msg);
  }

  validateSync(msg: OrderMsg): string {
    if (msg.fail === 'sync') {
      throw msg.error ?? new Error('sync validation failed');
    }
    return `v:${msg.id}`;
  }
}

@Injectable()
export class Repo {
  async find(ms: number, id: string): Promise<string> {
    await sleep(ms);
    return `r:${id}`;
  }
}

@Injectable()
export class OrdersService {
  constructor(@Inject(Repo) private readonly repo: Repo) {}

  async handle(msg: OrderMsg): Promise<string[]> {
    return Promise.all([this.repo.find(msg.delayMs ?? 2, msg.id), this.repo.find(msg.delayMs ?? 2, msg.id)]);
  }
}

@Injectable()
export class OrdersConsumer {
  constructor(
    @Inject(Validator) private readonly validator: Validator,
    @Inject(OrdersService) private readonly service: OrdersService,
  ) {}

  async process(msg: OrderMsg): Promise<{ id: string; v: string; r: string[] }> {
    if (msg.fail === 'sync') {
      this.validator.validateSync(msg);
    }
    const v = await this.validator.validate(msg);
    const r = await this.service.handle(msg);
    return { id: msg.id, v, r };
  }
}

@Module({
  providers: [Transformer, Validator, Repo, OrdersService, OrdersConsumer],
})
export class OrdersModule {}

export interface OrdersApp {
  app: INestApplicationContext;
  consumer: OrdersConsumer;
  service: OrdersService;
  validator: Validator;
  repo: Repo;
  close(): Promise<void>;
}

/** `createApplicationContext` for any module (no HTTP, no transport) with the Tracelet instrument. */
export async function createAppFor(
  module: new () => unknown,
  instrument: TraceletInstrumentOptions = { enabled: true },
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, {
    logger: false,
    abortOnError: false,
    instrument: createTraceletInstrument(instrument),
  });
}

/** Plain `createApplicationContext` (no HTTP, no transport). `enabled` is explicit so results do not depend on NODE_ENV. */
export async function createOrdersApp(instrument: TraceletInstrumentOptions = { enabled: true }): Promise<OrdersApp> {
  const app = await NestFactory.createApplicationContext(OrdersModule, {
    logger: false,
    abortOnError: false,
    instrument: createTraceletInstrument(instrument),
  });
  return {
    app,
    consumer: app.get(OrdersConsumer),
    service: app.get(OrdersService),
    validator: app.get(Validator),
    repo: app.get(Repo),
    close: () => app.close(),
  };
}
