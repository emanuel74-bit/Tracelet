import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRuntime, trace, tracingHealth } from '../../../src/context/index.js';
import type { MetricItem, RollupItem, TraceItem } from '../../../src/contracts/index.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import { TraceletLifecycle } from '../../../src/tracelet.module.js';
import { fakeCreateStorage, recordingDiagnostics, resetTracing, TEST_ENV, VALID_OPTIONS } from '../../support/module/fakes.js';
import type { FakeStorageLog } from '../../support/module/fakes.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const validateHeartbeat = ajv.getSchema((schema as { $id: string }).$id + '#/$defs/InstanceHeartbeat')!;

function make(options: unknown, env: Record<string, string> = TEST_ENV, storage: Partial<Parameters<typeof fakeCreateStorage>[1]> = {}) {
  const log: FakeStorageLog = { events: [], created: 0, connected: true };
  const d = recordingDiagnostics();
  const lifecycle = new TraceletLifecycle(options, { createStorage: fakeCreateStorage(log, storage), diagnostics: d.diagnostics, env, completionWaitMs: 300, beforeShutdownBoundMs: 500 });
  return { lifecycle, log, lines: d.lines };
}

describe('TraceletLifecycle', () => {
  beforeEach(() => resetTracing());
  afterEach(() => resetTracing());

  it('wires queue, hooks and storage on init; bootstrap starts storage detached; tracing is on', async () => {
    const { lifecycle, log, lines } = make(VALID_OPTIONS);
    lifecycle.onModuleInit();
    expect(lifecycle.state).toBe('active');
    expect(log.created).toBe(1);
    expect(log.events).toEqual([]); // nothing started yet
    expect(tracingHealth().enabled).toBe(true);
    expect(getRuntime().sink).toBe(log.queue); // setTelemetryQueue
    lifecycle.onApplicationBootstrap();
    expect(log.events).toEqual(['storage.start']);
    expect(getRuntime().sweeperTimer).toBeDefined();
    expect(lines.filter(l => l.level === 'error')).toEqual([]);
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
  });

  it('a traced root produces a TraceItem on the queue (hooks wired in the same configureTracing call)', async () => {
    const { lifecycle, log } = make(VALID_OPTIONS);
    lifecycle.onModuleInit();
    lifecycle.onApplicationBootstrap();
    const result = await trace('unit.job', async () => 42, { kind: 'rabbitmq' });
    expect(result).toBe(42);
    await sleep(20);
    expect(log.queue!.depth()).toBeGreaterThan(0);
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    expect(log.atStop!.some(i => i.type === 'trace' && (i as TraceItem).trace.operation === 'unit.job')).toBe(true);
  });

  it('shutdown order: tracing off -> open roots closed incomplete -> completions -> rollups -> metrics -> storage.stop', async () => {
    const { lifecycle, log } = make(VALID_OPTIONS);
    lifecycle.onModuleInit();
    lifecycle.onApplicationBootstrap();
    let release!: () => void;
    const hold = new Promise<void>(r => (release = r));
    const open = trace('unit.open', () => hold, { kind: 'custom' });
    await sleep(5);
    await lifecycle.beforeApplicationShutdown();
    const shutdown = lifecycle.onApplicationShutdown();
    // the synchronous part of the shutdown has already switched tracing off
    expect(tracingHealth().enabled).toBe(false);
    await shutdown;
    release();
    await open;
    expect(log.events).toEqual(['storage.start', 'storage.stop', 'storage.stopped']);
    const closed = log.atStop!.find(i => i.type === 'trace') as TraceItem | undefined;
    expect(closed?.trace.operation).toBe('unit.open');
    expect(closed?.trace.status).toBe('incomplete');
    // rollups.shutdown() ran BEFORE storage.stop()
    const rollup = log.atStop!.find(i => i.type === 'rollup') as RollupItem;
    expect(rollup.operations.some(o => o.operation === 'unit.open')).toBe(true);
    // metrics.flush() ran before storage.stop() (counters changed: rootsStarted)
    const metric = log.atStop!.find(i => i.type === 'metric') as MetricItem | undefined;
    expect(metric).toBeDefined();
    // new roots after shutdown are plain pass-through
    expect(trace('after', () => 'x')).toBe('x');
    expect(tracingHealth().enabled).toBe(false);
  });

  it('shutdown is idempotent and never throws', async () => {
    const { lifecycle, log } = make(VALID_OPTIONS);
    lifecycle.onModuleInit();
    lifecycle.onApplicationBootstrap();
    await Promise.all([lifecycle.beforeApplicationShutdown(), lifecycle.beforeApplicationShutdown()]);
    await Promise.all([lifecycle.onApplicationShutdown(), lifecycle.onApplicationShutdown()]);
    await lifecycle.onApplicationShutdown();
    await lifecycle.beforeApplicationShutdown();
    expect(log.events.filter(e => e === 'storage.stop')).toHaveLength(1);
    lifecycle.onModuleInit(); // late init after stop: no re-wiring
    expect(log.created).toBe(1);
    expect(lifecycle.state).toBe('stopped');
  });

  it('a slow storage.stop is bounded and never blocks shutdown forever', async () => {
    const { lifecycle } = make({ ...VALID_OPTIONS, buffer: { shutdownFlushTimeoutMs: 0 } }, TEST_ENV, { stopDelayMs: 60_000 });
    lifecycle.onModuleInit();
    lifecycle.onApplicationBootstrap();
    const t0 = Date.now();
    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onApplicationShutdown();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('the heartbeat factory produces a schema-valid InstanceHeartbeat from real health data', async () => {
    const { lifecycle, log } = make(VALID_OPTIONS);
    lifecycle.onModuleInit();
    const hb = log.heartbeat!();
    expect(validateHeartbeat(hb), JSON.stringify(validateHeartbeat.errors)).toBe(true);
    expect(hb.serviceName).toBe('unit-worker');
    expect(hb.tracing.enabled).toBe(true);
    expect(hb.profiler.state).toBe('disabled');
    expect(hb.buffer.queueDepth).toBe(0);
    expect(hb.versions.tracelet).toBe('0.1.0');
    expect(hb.versions.nestCore).toMatch(/^11\./);
    await lifecycle.onApplicationShutdown();
  });

  it('a wiring failure leaves tracing disabled with ONE sanitized diagnostic and no credentials', () => {
    const { lifecycle, lines } = make(VALID_OPTIONS, TEST_ENV, { throwOnCreate: true });
    expect(() => lifecycle.onModuleInit()).not.toThrow();
    expect(lifecycle.state).toBe('failed');
    expect(tracingHealth().enabled).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(JSON.stringify(lines)).not.toMatch(/hunter2|admin|mongodb/);
    lifecycle.onApplicationBootstrap();
    expect(lifecycle.debug().queueDepth).toBeUndefined();
  });
});
