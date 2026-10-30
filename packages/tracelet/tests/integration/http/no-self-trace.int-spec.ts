import { Injectable, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trace } from '../../../src/context/index.js';
import type { TraceItem } from '../../../src/contracts/index.js';
import { startHarness } from '../../support/instrumentation/harness.js';
import type { Harness } from '../../support/instrumentation/harness.js';
import { OrdersConsumer, OrdersModule, sleep } from '../../support/instrumentation/orders-app.js';
import { HostController, startHostApp } from '../../support/http/apps.js';
import type { AdapterName, HostApp } from '../../support/http/apps.js';
import { httpRequest } from '../../support/http/http.js';

/*
 * T14: dashboard and API requests are never traced.
 *
 * "Never traced" is only a meaningful claim if something inside the request path COULD be traced. Here the authorize()
 * hook and the API handler both call an INSTRUMENTED Nest provider (AuthService), exactly what a host does when its
 * authorize hook uses an injected auth service. Two situations are covered per adapter:
 *   A. the HTTP server was created outside any trace: 1000 requests produce zero traces, zero spans, zero rollups;
 *   B. the server was created INSIDE a still-open root trace (a stale/open ALS store is inherited by every request
 *      callback): the dispatcher must still run outside the store, so the open root receives no spans from requests.
 *      Without runOutsideTrace the provider calls of B attach to that root.
 * In both cases a traced provider call in the same app still produces a normal trace (the instrument is really on).
 */

@Injectable()
class AuthService {
  calls = 0;
  check(): boolean {
    this.calls++;
    return true;
  }
}

@Module({ imports: [OrdersModule], providers: [AuthService], controllers: [HostController] })
class AppModule {}

const REQUESTS = 1000;
const PATHS = ['/observe/', '/observe/index.html', '/observe/assets/index-DZSRTth0.js', '/observe/assets/index-8H8qAzKJ.css', '/observe/api/v1/health', '/observe/api/v1/traces?limit=5', '/observe/api/v1/overview', '/observe/traces/abc', '/observe', '/observe/assets/missing.js'];

async function hammer(port: number, total: number): Promise<Map<number, number>> {
  const statuses = new Map<number, number>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const method = i % 13 === 0 ? 'HEAD' : i % 17 === 0 ? 'POST' : 'GET';
      const r = await httpRequest({ port, method, path: PATHS[i % PATHS.length] });
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  return statuses;
}

for (const adapter of ['express', 'fastify'] as AdapterName[]) {
  describe(`T14 [${adapter}] dashboard and API requests are never traced`, () => {
    let h: Harness | undefined;
    let host: HostApp | undefined;
    afterEach(async () => {
      await host?.close();
      host = undefined;
      h?.stop();
      h = undefined;
      vi.unstubAllEnvs();
    });

    const boot = async (): Promise<{ auth: AuthService; consumer: OrdersConsumer }> => {
      vi.stubEnv('NODE_ENV', 'test');
      h = startHarness({ rollups: true });
      const ref: { auth?: AuthService } = {};
      host = await startHostApp({
        adapter,
        module: AppModule,
        instrument: true,
        authorize: () => ref.auth!.check(),
        api: async req => {
          ref.auth!.check();
          return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: req.path }) };
        },
      });
      const auth = host.app.get(AuthService);
      ref.auth = auth;
      return { auth, consumer: host.app.get(OrdersConsumer, { strict: false }) };
    };

    it(`A. ${REQUESTS} requests: zero traces, zero spans, zero rollups, zero root counters; a traced provider call still traces`, async () => {
      const { auth, consumer } = await boot();
      const statuses = await hammer(host!.port, REQUESTS);
      // the traffic was real (hooks and handlers ran, a mix of statuses) ...
      expect(auth.calls).toBeGreaterThan(REQUESTS * 0.9);
      expect(statuses.get(200)).toBeGreaterThan(500);
      expect(statuses.get(307)).toBeGreaterThan(0);
      expect(statuses.get(404)).toBeGreaterThan(0);
      expect(statuses.get(405)).toBeGreaterThan(0);
      // ... and none of it was traced
      await h!.settle();
      h!.rollups!.shutdown();
      const leftover = h!.queue.drain(1_000_000, Number.MAX_SAFE_INTEGER);
      expect(h!.items).toHaveLength(0);
      expect(leftover).toHaveLength(0);
      expect(h!.rt.registry.openTraceCount()).toBe(0);
      expect(h!.queue.counters()).toMatchObject({ rootsStarted: 0, spansDropped: 0, tracesDroppedAdmission: 0 });

      // positive control in the same app: a traced provider call produces a trace with spans
      const value = await trace('rabbitmq.consume', () => consumer.process({ id: 'control', delayMs: 1 }), { kind: 'rabbitmq' });
      expect(value.id).toBe('control');
      await h!.settle();
      expect(h!.items).toHaveLength(1);
      expect(h!.items[0].trace.operation).toBe('rabbitmq.consume');
      expect(h!.items[0].spans.length).toBeGreaterThan(3);
      // and requests after the control are still untraced
      await hammer(host!.port, 100);
      await h!.settle();
      expect(h!.items).toHaveLength(1);
    }, 120_000);

    it('B. a server created inside an OPEN root trace: requests inherit the store, the dispatcher exits it, the root gets no foreign spans', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      h = startHarness({ rollups: true });
      let auth!: AuthService;
      let releaseRoot!: () => void;
      const hold = new Promise<void>(resolve => (releaseRoot = resolve));
      let ready!: () => void;
      const readyP = new Promise<void>(resolve => (ready = resolve));
      // the listener is created while the root is open and the root stays open for the whole load
      const root = trace(
        'host.bootstrap',
        async () => {
          host = await startHostApp({
            adapter,
            module: AppModule,
            instrument: true,
            authorize: () => auth.check(),
            api: async req => {
              auth.check();
              return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: req.path }) };
            },
          });
          auth = host.app.get(AuthService);
          ready();
          await hold;
        },
        { kind: 'custom' },
      );
      await readyP;
      expect(h.rt.registry.openTraceCount()).toBe(1);
      await hammer(host!.port, REQUESTS);
      expect(auth.calls).toBeGreaterThan(REQUESTS * 0.9);
      releaseRoot();
      await root;
      await h.settle();
      h.rollups!.shutdown();
      const items = [...h.items, ...h.queue.drain(1_000_000, Number.MAX_SAFE_INTEGER).filter((i): i is TraceItem => i.type === 'trace')];
      expect(items.map(i => i.trace.operation)).toEqual(['host.bootstrap']);
      // the open root contains only its own root span (plus none of the 1000+ AuthService.check calls)
      expect(items[0].spans.map(s => s.operation)).not.toContain('AuthService.check');
      expect(items[0].trace.spanCount).toBeLessThanOrEqual(30); // the bootstrap itself (Nest init provider calls) is the only source
      expect(items[0].spans.filter(s => /AuthService/.test(s.operation))).toHaveLength(0);
      await sleep(10);
    }, 120_000);
  });
}
