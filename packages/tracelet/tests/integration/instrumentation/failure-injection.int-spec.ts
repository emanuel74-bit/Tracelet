import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue, createBufferHooks, RollupAccumulator } from '../../../src/buffer/index.js';
import {
  closeAllOpenRoots,
  createRuntimeForTesting,
  LogRedactor,
  resetRuntimeForTesting,
  trace,
  tracingHealth,
  whenCompletionsIdle,
  type TraceletRuntime,
} from '../../../src/context/index.js';
import type { TelemetryCounters } from '../../../src/contracts/index.js';
import { createDiagnostics, traceletAls } from '../../../src/shared/index.js';
import { createTraceletInstrument } from '../../../src/instrumentation/index.js';
import { FakeAmqpChannel, type FakeMessage } from '../../support/instrumentation/fake-amqp-channel.js';
import { createOrdersApp, sleep, type OrderMsg, type OrdersApp } from '../../support/instrumentation/orders-app.js';

/*
 * T23 (INS half): queue/mapper failure injection. A throwing onTraceComplete, queue.offer or mapper must not recurse into
 * tracing, produce extra traces, change business results or acks, or leave state behind.
 */

interface Outcome {
  ackLog: string[];
  results: string[];
  traced: number;
  diagnostics: Array<{ level: string; message: string; insideTrace: boolean }>;
  rt: TraceletRuntime;
}

async function scenario(wire: (rt: { queue: BoundedTelemetryQueue }) => { onTraceComplete: (s: never) => void } | undefined, enabled: boolean): Promise<Outcome> {
  const diagnostics: Outcome['diagnostics'] = [];
  const queue = new BoundedTelemetryQueue();
  const hooks = enabled ? wire({ queue }) : undefined;
  const rt = createRuntimeForTesting({
    sink: queue,
    completionTimeoutMs: 40,
    diagnostics: createDiagnostics('t', (level, _scope, message) => diagnostics.push({ level, message, insideTrace: traceletAls.getStore() !== undefined })),
    config: { enabled, maxRootsPerSecond: 100_000, ...(hooks ? { onTraceComplete: hooks.onTraceComplete as never } : {}) },
  });
  const app: OrdersApp = await createOrdersApp({ enabled });
  const channel = new FakeAmqpChannel();
  const results: string[] = [];
  const done = new Map<string, () => void>();
  channel.consume('orders', async (msg: FakeMessage) => {
    try {
      const r = await trace('rabbitmq.consume', () => app.consumer.process(msg.content as OrderMsg), { kind: 'rabbitmq' });
      results.push(`ok:${JSON.stringify(r)}`);
      channel.ack(msg);
    } catch (error) {
      results.push(`err:${(error as Error).message}`);
      channel.nack(msg, false, false);
    }
    done.get(msg.id)?.();
  });
  const msgs: OrderMsg[] = [{ id: 'a' }, { id: 'b', fail: 'transform' }, { id: 'c' }];
  for (const content of msgs) {
    await new Promise<void>((resolve) => {
      done.set(content.id, resolve);
      channel.publish('orders', { id: content.id, content });
    });
  }
  await whenCompletionsIdle(2000);
  await sleep(20);
  const traced = queue.counters().rootsStarted;
  await app.close();
  return { ackLog: channel.logLines(), results, traced, diagnostics, rt };
}

describe('T23: failures in the hand-off never reach business code and never recurse into tracing', () => {
  afterEach(() => resetRuntimeForTesting());

  const baseline = () => scenario(() => undefined, false);

  const failures: Array<[string, (ctx: { queue: BoundedTelemetryQueue }) => { onTraceComplete: (s: never) => void }]> = [
    ['onTraceComplete throws', () => ({ onTraceComplete: () => { throw new Error('hook exploded'); } })],
    [
      'queue.offer throws',
      ({ queue }) => {
        const throwing: BoundedTelemetryQueue = Object.assign(Object.create(queue), { offer: (): boolean => { throw new Error('offer exploded'); } });
        return createBufferHooks({
          queue: throwing,
          rollups: new RollupAccumulator({ serviceName: 's', instanceId: 'i', offer: () => true, defer: () => {} }),
          mapper: { serviceName: 's', instanceId: 'i', errorMessages: 'redacted', redactor: new LogRedactor() },
        }) as never;
      },
    ],
    [
      'the mapper throws (redactor explodes)',
      ({ queue }) =>
        createBufferHooks({
          queue,
          rollups: new RollupAccumulator({ serviceName: 's', instanceId: 'i', offer: () => true, defer: () => {} }),
          mapper: {
            serviceName: 's',
            instanceId: 'i',
            errorMessages: 'redacted',
            redactor: { redactMessage: () => { throw new Error('redactor exploded'); }, isSensitiveKey: () => { throw new Error('redactor exploded'); } } as never,
          },
        }) as never,
    ],
    [
      'the rollup accumulator throws',
      ({ queue }) =>
        createBufferHooks({
          queue,
          rollups: { recordSpans: () => { throw new Error('rollups exploded'); }, recordRoot: () => { throw new Error('rollups exploded'); } } as never,
          mapper: { serviceName: 's', instanceId: 'i', errorMessages: 'redacted', redactor: new LogRedactor() },
        }) as never,
    ],
  ];

  it.each(failures)('%s: business results and ack log identical to the disabled run, no extra traces, no state left, diagnostics outside traces', async (_name, wire) => {
    const off = await baseline();
    resetRuntimeForTesting();
    const on = await scenario(wire, true);

    expect(on.results).toEqual(off.results);
    expect(on.ackLog).toEqual(off.ackLog);
    expect(on.ackLog).toEqual(['ack:a', 'nack:b', 'ack:c']);
    // exactly the three roots started: the failing hand-off did not create more traces (no recursion)
    expect(on.traced).toBe(3);
    expect(on.rt.registry.openTraceCount()).toBe(0);
    expect(on.rt.registry.openSpanCount()).toBe(0);
    expect(on.rt.pendingCompletions).toBe(0);
    // diagnostics are rate limited (<= 1 per key) and never emitted inside a trace store
    expect(on.diagnostics.length).toBeLessThanOrEqual(1);
    for (const d of on.diagnostics) expect(d.insideTrace).toBe(false);
  });

  it('a diagnostics sink that itself calls a proxied provider is not traced (diagnostics run outside traces)', async () => {
    const app = await createOrdersApp();
    const queue = new BoundedTelemetryQueue();
    const seen: string[] = [];
    const rt = createRuntimeForTesting({
      sink: queue,
      completionTimeoutMs: 20,
      diagnostics: createDiagnostics('t', () => {
        void app.service.handle({ id: 'diag' }); // a logger backed by an instrumented provider
        seen.push(String(traceletAls.getStore()));
      }),
      config: { enabled: true, onTraceComplete: () => { throw new Error('boom'); } },
    });
    await trace('x', () => app.service.handle({ id: '1' }));
    await whenCompletionsIdle(1000);
    await sleep(30);
    expect(seen).toEqual(['undefined']);
    expect(queue.counters().rootsStarted).toBe(1);
    expect(rt.registry.openTraceCount()).toBe(0);
    await app.close();
  });

  it('shutdown with a failing hand-off still terminates: whenCompletionsIdle resolves true, the registry is empty', async () => {
    const queue = new BoundedTelemetryQueue();
    const rt = createRuntimeForTesting({
      sink: queue,
      completionTimeoutMs: 30,
      diagnostics: createDiagnostics('t', () => {}),
      config: { enabled: true, onTraceComplete: () => { throw new Error('boom'); } },
    });
    void trace('open', () => new Promise<void>(() => {}));
    expect(closeAllOpenRoots('shutdown')).toBe(1);
    await expect(whenCompletionsIdle(2000)).resolves.toBe(true);
    expect(rt.registry.openTraceCount()).toBe(0);
  });
});

describe('tracingHealth (TracingHealthSource) and the counters behind /health', () => {
  afterEach(() => resetRuntimeForTesting());

  it('reports exactly the contract fields and tracks instrumentInstalled / openTraces', async () => {
    createRuntimeForTesting({ config: { enabled: true, sampleRate: 0.25 } });
    let health = tracingHealth();
    expect(Object.keys(health).sort()).toEqual(['enabled', 'instrumentInstalled', 'openTraces', 'sampleRate']);
    expect(health).toEqual({ enabled: true, sampleRate: 0.25, instrumentInstalled: false, openTraces: 0 });

    const app = await createOrdersApp(); // proxies instances -> instrumentInstalled
    expect(tracingHealth().instrumentInstalled).toBe(true);
    let release!: () => void;
    // sampleRate 0.25 may sample a root out; use a sampled one for the open-trace assertion
    createRuntimeForTesting({ config: { enabled: true, sampleRate: 1 } });
    const q = trace('open', () => new Promise<void>((r) => (release = r)), { kind: 'custom' });
    expect(tracingHealth().openTraces).toBe(1);
    release();
    await q;
    health = tracingHealth();
    expect(health.enabled).toBe(true);
    await app.close();
  });

  it('a disabled instrument never sets instrumentInstalled', async () => {
    createRuntimeForTesting({ config: { enabled: true } });
    const app = await createOrdersApp({ enabled: false });
    expect(tracingHealth().instrumentInstalled).toBe(false);
    await app.close();
    expect(createTraceletInstrument({ enabled: false })).toBeDefined();
  });

  it('every TelemetryCounters field the context owns is counted through the sink: rootsStarted, rootsSampledOut, tracesDroppedAdmission, spansDropped', async () => {
    const queue = new BoundedTelemetryQueue();
    const rt = createRuntimeForTesting({
      sink: queue,
      config: { enabled: true, sampleRate: 1, maxRootsPerSecond: 1, maxOpenTraces: 5000, maxSpansPerTrace: 3, maxOpenSpans: 50_000 },
    });
    const counters = (): Readonly<TelemetryCounters> => queue.counters();
    // 1) sampled root, then the token bucket (1/s) is empty -> admission drop
    trace('a', () => 1);
    trace('b', () => 2);
    expect(counters().rootsStarted).toBe(2);
    expect(counters().tracesDroppedAdmission).toBe(1);
    // 2) sampled-out by the head sampler
    rt.config.sampleRate = 0;
    trace('c', () => 3);
    expect(counters().rootsStarted).toBe(3);
    expect(counters().rootsSampledOut).toBe(1);
    // 3) spans refused by maxSpansPerTrace
    rt.config.sampleRate = 1;
    rt.config.maxRootsPerSecond = 100_000;
    await sleep(10); // the token bucket refills per millisecond
    trace('d', () => {
      for (let i = 0; i < 6; i++) trace(`child-${i}`, () => i, { join: true });
    });
    expect(counters().spansDropped).toBe(4); // root + 2 children fit under 3
    // the other four names (tracesDroppedQueueFull/Storage, profilesDropped, rollupsDropped) belong to the queue/storage/profiler
    expect(Object.keys(counters()).sort()).toEqual([
      'profilesDropped',
      'rollupsDropped',
      'rootsSampledOut',
      'rootsStarted',
      'spansDropped',
      'tracesDroppedAdmission',
      'tracesDroppedQueueFull',
      'tracesDroppedStorage',
    ]);
    await whenCompletionsIdle(2000);
  });
});
