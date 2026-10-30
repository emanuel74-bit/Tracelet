import 'reflect-metadata';
import { Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tracingHealth } from '../../../src/context/index.js';
import { isTraceletInternal } from '../../../src/shared/brand.js';
import { TraceletLifecycle, TraceletModule } from '../../../src/tracelet.module.js';
import { resetTracing } from '../../support/module/fakes.js';

@Injectable()
class ConfigStub {
  value = { serviceName: 'async-svc', storage: { uri: 'mongodb://127.0.0.1:1/x' } };
}
@Module({ providers: [ConfigStub], exports: [ConfigStub] })
class ConfigModule {}

async function withDisabledEnv(fn: () => Promise<void>): Promise<void> {
  const before = process.env.TRACELET_DISABLED;
  process.env.TRACELET_DISABLED = '1';
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.TRACELET_DISABLED;
    else process.env.TRACELET_DISABLED = before;
  }
}

describe('TraceletModule', () => {
  beforeEach(() => resetTracing());
  afterEach(() => resetTracing());

  it('the lifecycle and the module are branded internal (never instrumented)', () => {
    expect(isTraceletInternal(Object.create(TraceletLifecycle.prototype))).toBe(true);
    expect((TraceletModule as unknown as Record<symbol, unknown>)[Symbol.for('tracelet.internal')]).toBe(true);
  });

  it('forRoot with TRACELET_DISABLED=1 boots and closes with nothing wired', async () => {
    await withDisabledEnv(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [TraceletModule.forRoot({ serviceName: 's', storage: { uri: 'mongodb://127.0.0.1:1/x' } })] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      expect(app.get(TraceletLifecycle, { strict: false }).state).toBe('disabled');
      expect(tracingHealth().enabled).toBe(false);
      await app.close();
    });
  });

  it('forRootAsync resolves its injected options', async () => {
    await withDisabledEnv(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TraceletModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigStub], useFactory: (c: ConfigStub) => c.value })],
      }).compile();
      // TRACELET_DISABLED skips validation (the config carries only the service name), but proves the factory ran
      expect(moduleRef.get(TraceletLifecycle, { strict: false }).config?.serviceName).toBe('async-svc');
      await moduleRef.close();
    });
  });

  it('a throwing forRootAsync factory does not stop the host: tracing disabled, one error, no message leak', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        TraceletModule.forRootAsync({
          useFactory: () => {
            throw new Error('cannot read mongodb://admin:hunter2@vault.internal');
          },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(app.get(TraceletLifecycle, { strict: false }).state).toBe('failed');
    expect(tracingHealth().enabled).toBe(false);
    await app.close();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|admin|vault/);
    spy.mockRestore();
  });

  it('invalid forRoot options: the host app boots and closes, one diagnostic', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [TraceletModule.forRoot({ serviceName: '', storage: { uri: 'nope' } } as never)] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('nope');
    spy.mockRestore();
  });
});
