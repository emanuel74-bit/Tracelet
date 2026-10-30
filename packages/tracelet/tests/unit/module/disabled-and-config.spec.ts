import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntime, tracingHealth } from '../../../src/context/index.js';
import { TraceletLifecycle } from '../../../src/tracelet.module.js';
import { fakeCreateStorage, recordingDiagnostics, resetTracing, TEST_ENV, VALID_OPTIONS } from '../../support/module/fakes.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

function make(options: unknown, env: Record<string, string>) {
  const log: FakeStorageLog = { events: [], created: 0, connected: false };
  const d = recordingDiagnostics();
  const lifecycle = new TraceletLifecycle(options, { createStorage: fakeCreateStorage(log), diagnostics: d.diagnostics, env });
  return { lifecycle, log, lines: d.lines };
}

async function runFullLifecycle(l: TraceletLifecycle): Promise<void> {
  l.onModuleInit();
  l.onApplicationBootstrap();
  await l.beforeApplicationShutdown();
  await l.onApplicationShutdown();
}

describe('TraceletLifecycle: disabled is a complete no-op', () => {
  beforeEach(() => resetTracing());
  afterEach(() => resetTracing());

  const cases: Array<[string, unknown, Record<string, string>]> = [
    ['TRACELET_DISABLED=1', VALID_OPTIONS, { NODE_ENV: 'test', TRACELET_DISABLED: '1' }],
    ['enabled:false option', { ...VALID_OPTIONS, enabled: false }, { NODE_ENV: 'test' }],
    ['production default (NODE_ENV unset)', VALID_OPTIONS, {}],
    ['TRACELET_DISABLED=1 with garbage options', { nonsense: true }, { TRACELET_DISABLED: '1' }],
  ];
  for (const [name, options, env] of cases) {
    it(`${name}: no storage, no timers, no queue, tracing stays off, no diagnostics`, async () => {
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      const { lifecycle, log, lines } = make(options, env);
      const before = { i: intervals.mock.calls.length, t: timeouts.mock.calls.length };
      await runFullLifecycle(lifecycle);
      expect(lifecycle.state).toBe('disabled');
      expect(lifecycle.enabled).toBe(false);
      expect(log.created).toBe(0);
      expect(log.events).toEqual([]);
      expect(intervals.mock.calls.length).toBe(before.i);
      expect(timeouts.mock.calls.length).toBe(before.t);
      expect(getRuntime().sweeperTimer).toBeUndefined();
      expect(tracingHealth().enabled).toBe(false);
      expect(lines).toEqual([]);
      expect((await lifecycle.apiHandler({ method: 'GET', path: '/api/v1/health', query: {}, headers: {} })).status).toBe(503);
      intervals.mockRestore();
      timeouts.mockRestore();
    });
  }
});

describe('TraceletLifecycle: invalid configuration disables tracing, the host still boots', () => {
  beforeEach(() => resetTracing());
  afterEach(() => resetTracing());

  const SECRET_URI = 'mongodb://admin:hunter2secret@db.internal:27017/obs';

  it('range error: ONE diagnostic naming the option and range, nothing wired, nothing thrown', async () => {
    const { lifecycle, log, lines } = make({ ...VALID_OPTIONS, storage: { uri: SECRET_URI }, tracing: { sampleRate: 7 } }, TEST_ENV);
    await runFullLifecycle(lifecycle);
    expect(lifecycle.state).toBe('config-error');
    expect(log.created).toBe(0);
    expect(tracingHealth().enabled).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain('tracing.sampleRate');
    expect(JSON.stringify(lines)).not.toMatch(/hunter2|admin|db\.internal|mongodb/);
  });

  it('invalid uri: the value is never reflected', async () => {
    const { lifecycle, lines } = make({ ...VALID_OPTIONS, storage: { uri: 'http://root:topsecret@evil/x' } }, TEST_ENV);
    await runFullLifecycle(lifecycle);
    expect(lifecycle.state).toBe('config-error');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toMatch(/topsecret|root|evil/);
  });

  it('missing options / non-object options', async () => {
    for (const bad of [undefined, null, 'x', 5]) {
      const { lifecycle, lines } = make(bad, TEST_ENV);
      await runFullLifecycle(lifecycle);
      expect(lifecycle.state).toBe('config-error');
      expect(lines).toHaveLength(1);
    }
  });

  it('the diagnostic goes through the Nest Logger exactly once with the default sink', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const lifecycle = new TraceletLifecycle({ ...VALID_OPTIONS, storage: { uri: SECRET_URI }, tracing: { sampleRate: -1 } }, { env: TEST_ENV });
    await runFullLifecycle(lifecycle);
    await runFullLifecycle(lifecycle);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/hunter2|admin/);
    spy.mockRestore();
  });
});
