import { types } from 'node:util';
import { Inject, Injectable, Module } from '@nestjs/common';
import { ApplicationConfig, DiscoveryModule, DiscoveryService, HttpAdapterHost, MetadataScanner, ModuleRef, ModulesContainer, Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { toTraceItem } from '../../../src/buffer/index.js';
import { createRuntimeForTesting, getRuntime, LogRedactor, resetRuntimeForTesting, trace } from '../../../src/context/index.js';
import type { TraceItem } from '../../../src/contracts/index.js';
import { createSkipPredicate } from '../../../src/instrumentation/exclusions.js';
import { markInternal, TRACELET_INTERNAL, traceletAls } from '../../../src/shared/index.js';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { createAppFor, Repo, sleep } from '../../support/instrumentation/orders-app.js';
import { startHarness } from '../../support/instrumentation/harness.js';

/* T14-adjacent: Tracelet's own providers and Nest internals are never instrumented, and a branded provider cannot cause recursion. */

@Injectable()
class BusinessService {
  constructor(@Inject(Repo) private readonly repo: Repo) {}
  async work(id: string): Promise<string> {
    return this.repo.find(1, id);
  }
}

/** Stands in for TraceletLifecycle / the writer: a Nest provider that carries the Tracelet brand and uses business providers. */
@Injectable()
class BrandedWriter {
  static [TRACELET_INTERNAL] = true;
  static calls = 0;
  constructor(@Inject(Repo) private readonly repo: Repo) {}
  async flush(): Promise<string> {
    BrandedWriter.calls += 1;
    return this.repo.find(1, 'from-writer');
  }
  syncNote(): string {
    return 'note';
  }
}
class BrandedChild extends BrandedWriter {}

@Injectable()
class InstanceBranded {
  readonly [TRACELET_INTERNAL] = true;
  ping(): string {
    return 'pong';
  }
}

@Module({
  imports: [DiscoveryModule],
  providers: [Repo, BusinessService, BrandedWriter, InstanceBranded, { provide: 'BRANDED_CHILD', useClass: BrandedChild }],
})
class ExclusionsModule {}

describe('exclusions: Tracelet-branded providers and Nest internals are never proxied', () => {
  afterEach(() => resetRuntimeForTesting());

  it('branded classes (own, inherited, instance-level) and Nest internals are returned untouched; ordinary providers are proxied', async () => {
    startHarness();
    const app = await createAppFor(ExclusionsModule);
    expect(types.isProxy(app.get(BusinessService))).toBe(true);
    expect(types.isProxy(app.get(Repo))).toBe(true);

    expect(types.isProxy(app.get(BrandedWriter))).toBe(false);
    expect(types.isProxy(app.get('BRANDED_CHILD'))).toBe(false);
    expect(types.isProxy(app.get(InstanceBranded))).toBe(false);

    for (const internal of [ModuleRef, ModulesContainer, DiscoveryService, MetadataScanner, ApplicationConfig, Reflector, HttpAdapterHost]) {
      let instance: unknown;
      try {
        instance = app.get(internal as never, { strict: false });
      } catch {
        continue; // not registered in a plain application context (HttpAdapterHost is)
      }
      expect(types.isProxy(instance), (internal as { name: string }).name).toBe(false);
    }
    await app.close();
  });

  it('a branded provider calling business providers inside a trace gets no span of its own; the business spans hang under the caller', async () => {
    const h = startHarness({ completionTimeoutMs: 100 });
    const app = await createAppFor(ExclusionsModule);
    const writer = app.get(BrandedWriter);
    const business = app.get(BusinessService);
    BrandedWriter.calls = 0;

    await trace('with.branded', async () => {
      await writer.flush();
      writer.syncNote();
      await business.work('x');
    });
    await h.settle();
    const ops = h.items[0].spans.map((s) => s.operation);
    expect(ops).toEqual(expect.arrayContaining(['with.branded', 'Repo.find', 'BusinessService.work']));
    expect(ops.some((o) => o.startsWith('BrandedWriter'))).toBe(false);
    expect(BrandedWriter.calls).toBe(1);
    await app.close();
  });

  it('no recursion: a completion hook that calls a branded provider (which calls business providers) creates no further traces', async () => {
    const queue = new BoundedTelemetryQueue();
    const redactor = new LogRedactor();
    const app = await createAppFor(ExclusionsModule);
    const writer = app.get(BrandedWriter);
    BrandedWriter.calls = 0;
    const items: TraceItem[] = [];
    let hookCalls = 0;
    createRuntimeForTesting({
      sink: queue,
      completionTimeoutMs: 50,
      config: {
        enabled: true,
        maxRootsPerSecond: 100_000,
        onTraceComplete: (snapshot) => {
          hookCalls += 1;
          items.push(toTraceItem(snapshot, { serviceName: 's', instanceId: 'i', errorMessages: 'redacted', redactor }));
          // The hook runs outside any trace (deferred completion); the branded provider uses a proxied business provider.
          expect(traceletAls.getStore()).toBeUndefined();
          void writer.flush();
        },
      },
    });
    const N = 10;
    for (let i = 0; i < N; i++) await trace(`root.${i}`, async () => app.get(BusinessService).work(String(i)));
    await sleep(250);
    expect(hookCalls).toBe(N); // not N + extra traces produced by the hook's own provider calls
    expect(items).toHaveLength(N);
    expect(BrandedWriter.calls).toBe(N);
    expect(getRuntime().registry.openTraceCount()).toBe(0);
    expect(items.every((i) => i.spans.every((s) => s.operation !== 'Repo.find' || s.parentSpanId !== null))).toBe(true);
    expect(items.flatMap((i) => i.spans).filter((s) => s.operation === 'Repo.find')).toHaveLength(N);
    await app.close();
  });
});

describe('createSkipPredicate', () => {
  afterEach(() => resetRuntimeForTesting());

  it('skips branded instances (class, subclass, instance), the registry and the ALS; never throws', () => {
    createRuntimeForTesting();
    const skip = createSkipPredicate();
    class Plain {}
    const Marked = markInternal(class Marked {});
    class SubMarked extends Marked {}
    expect(skip(new Plain())).toBe(false);
    expect(skip(new Marked())).toBe(true);
    expect(skip(new SubMarked())).toBe(true);
    expect(skip({ [TRACELET_INTERNAL]: true })).toBe(true);
    expect(skip(traceletAls)).toBe(true);
    expect(skip(getRuntime().registry)).toBe(true);
    expect(skip(new Map())).toBe(false);
    expect(skip(null)).toBe(false);
    expect(skip(undefined)).toBe(false);
    expect(skip(42)).toBe(false);
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap'); }, get: () => { throw new Error('trap'); } });
    expect(() => skip(hostile)).not.toThrow();
    expect(skip(hostile)).toBe(true); // cannot be inspected, so it is left alone
  });

  it('a user predicate is honoured; a throwing user predicate means skip', () => {
    createRuntimeForTesting();
    class A {}
    class B {}
    const skip = createSkipPredicate((i) => i instanceof A);
    expect(skip(new A())).toBe(true);
    expect(skip(new B())).toBe(false);
    const throwing = createSkipPredicate(() => {
      throw new Error('user predicate');
    });
    expect(throwing(new B())).toBe(true);
  });
});
