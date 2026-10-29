import { AsyncResource } from 'node:async_hooks';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureTracing, ROOT_TOKEN_KEY, sweepOnce, trace } from '../../../src/context/index.js';
import type { RootToken } from '../../../src/context/index.js';
import { traceletAls } from '../../../src/shared/index.js';
import { FakeAmqpChannel } from '../../support/instrumentation/fake-amqp-channel.js';
import { createOrdersApp, sleep, type OrdersApp } from '../../support/instrumentation/orders-app.js';
import { operationPaths, spanTree, startHarness, type Harness } from '../../support/instrumentation/harness.js';

const FULL_TREE_SPANS = 7;

describe('H6 stale async context (JOIN-IF-OPEN, R2, R3, L-a)', () => {
  let h: Harness;
  let app: OrdersApp;

  beforeEach(async () => {
    h = startHarness({ completionTimeoutMs: 400 });
    app = await createOrdersApp({ enabled: true });
  });
  afterEach(async () => {
    await app.close();
    h.stop();
  });

  const byOp = (items: Awaited<ReturnType<Harness['settle']>>, op: string) => items.filter((i) => i.trace.operation === op);

  it('(a) AsyncResource captured inside trace(setup) delivers after setup closed: fresh roots, setup gains no spans', async () => {
    let source!: AsyncResource;
    let staleToken: RootToken | undefined;
    await trace(
      'setup',
      async () => {
        source = new AsyncResource('fake-source');
        await sleep(2);
      },
      { kind: 'custom' },
    );
    for (const kind of ['custom', 'rabbitmq'] as const) {
      for (let i = 0; i < 3; i++) {
        await source.runInAsyncScope(() => {
          staleToken ??= traceletAls.getStore()?.get(ROOT_TOKEN_KEY) as RootToken | undefined;
          return trace(`stale.${kind}`, () => app.consumer.process({ id: `${kind}${i}` }), { kind });
        });
      }
    }
    // precondition: the source really carried the stale store of the closed root
    expect(staleToken).toBeDefined();
    expect(staleToken!.open).toBe(false);

    const items = await h.settle();
    expect(items).toHaveLength(1 + 6);
    const setup = byOp(items, 'setup');
    expect(setup).toHaveLength(1);
    expect(setup[0].trace.spanCount).toBe(1);
    for (const op of ['stale.custom', 'stale.rabbitmq']) {
      const roots = byOp(items, op);
      expect(roots).toHaveLength(3);
      for (const r of roots) {
        expect(r.spans.find((s) => s.parentSpanId === null)!.origin).toBe('root');
        expect(r.trace.spanCount).toBe(FULL_TREE_SPANS);
      }
    }
    expect(new Set(items.map((i) => i.trace.traceId)).size).toBe(items.length);
  });

  it('(a) a real net socket pair created inside trace(setup) delivers after setup closed', async () => {
    let server!: net.Server;
    let client!: net.Socket;
    let serverSide!: net.Socket;
    const received: Array<Promise<void>> = [];
    const stalePrecondition: Array<boolean> = [];

    await trace(
      'setup-net',
      async () => {
        server = net.createServer((sock) => {
          serverSide = sock;
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as net.AddressInfo).port;
        client = net.connect(port, '127.0.0.1');
        await once(client, 'connect');
        client.on('data', (chunk) => {
          const store = traceletAls.getStore();
          const token = store?.get(ROOT_TOKEN_KEY) as RootToken | undefined;
          stalePrecondition.push(token !== undefined && token.open === false);
          received.push(
            trace('net.message', () => app.consumer.process({ id: chunk.toString() }), { kind: 'custom' }).then(() => undefined),
          );
        });
        // wait until the server side accepted the connection
        while (!serverSide) await sleep(2);
      },
      { kind: 'custom' },
    );

    serverSide.write('n1');
    await sleep(30);
    serverSide.write('n2');
    await sleep(30);
    while (received.length < 2) await sleep(5);
    await Promise.all(received);
    client.destroy();
    serverSide.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(stalePrecondition.length).toBeGreaterThanOrEqual(2);
    expect(stalePrecondition.every(Boolean)).toBe(true); // the socket callback really ran in the stale store

    const items = await h.settle();
    const messages = byOp(items, 'net.message');
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.trace.spanCount).toBe(FULL_TREE_SPANS);
      expect(m.spans.find((s) => s.parentSpanId === null)!.origin).toBe('root');
    }
    expect(byOp(items, 'setup-net')[0].trace.spanCount).toBe(1);
  });

  it('(b) nested trace() of kind custom inside an open trace becomes a manual child span', async () => {
    await trace(
      'outer',
      async () => {
        await trace('inner', () => app.consumer.process({ id: 'b' }), { kind: 'custom' });
      },
      { kind: 'custom' },
    );
    const items = await h.settle();
    expect(items).toHaveLength(1);
    const tree = spanTree(items[0]);
    expect(tree.operation).toBe('outer');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ operation: 'inner', origin: 'manual' });
    expect(operationPaths(tree)).toContain('outer > inner > OrdersConsumer.process');
    expect(items[0].trace.spanCount).toBe(FULL_TREE_SPANS + 1);
  });

  it('(c) forceRoot inside an open trace starts a separate root', async () => {
    await trace(
      'outer',
      async () => {
        await trace('inner', () => app.consumer.process({ id: 'c' }), { kind: 'custom', forceRoot: true });
      },
      { kind: 'custom' },
    );
    const items = await h.settle();
    expect(items).toHaveLength(2);
    expect(byOp(items, 'outer')[0].trace.spanCount).toBe(1);
    const inner = byOp(items, 'inner')[0];
    expect(inner.spans.find((s) => s.parentSpanId === null)!.origin).toBe('root');
    expect(inner.trace.spanCount).toBe(FULL_TREE_SPANS);
  });

  it('(d) unsampled outer root: plain nested joins the unsampled root, forceRoot starts a separate sampled root', async () => {
    configureTracing({ sampleRate: 0 });
    await trace(
      'outer-unsampled',
      async () => {
        configureTracing({ sampleRate: 1 });
        await trace('inner-joined', () => app.consumer.process({ id: 'd1' }), { kind: 'custom' });
        await trace('inner-forced', () => app.consumer.process({ id: 'd2' }), { kind: 'custom', forceRoot: true });
      },
      { kind: 'custom' },
    );
    const items = await h.settle();
    expect(byOp(items, 'outer-unsampled')).toHaveLength(0);
    expect(byOp(items, 'inner-joined')).toHaveLength(0); // part of the unsampled outer root
    expect(byOp(items, 'inner-forced')).toHaveLength(1);
    expect(byOp(items, 'inner-forced')[0].trace.spanCount).toBe(FULL_TREE_SPANS);
    expect(h.queue.counters().rootsSampledOut).toBe(1);
  });

  it('(e) sampled outer force-closed by the sweeper: later nested trace() starts a fresh root', async () => {
    h.rt.config.maxTraceDurationMs = 50;
    let source!: AsyncResource;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const outer = trace(
      'outer-swept',
      async () => {
        source = new AsyncResource('src');
        await hold;
      },
      { kind: 'custom' },
    );
    await sleep(80);
    expect(sweepOnce(h.rt)).toBe(1);
    await source.runInAsyncScope(() => trace('late', () => app.consumer.process({ id: 'e' }), { kind: 'custom' }));
    release();
    await outer;
    const items = await h.settle();
    const swept = byOp(items, 'outer-swept');
    expect(swept).toHaveLength(1); // the late settle does not emit a second trace
    expect(swept[0].trace.status).toBe('incomplete');
    expect(swept[0].trace.isComplete).toBe(false);
    expect(swept[0].trace.spanCount).toBe(1);
    const late = byOp(items, 'late');
    expect(late).toHaveLength(1);
    expect(late[0].spans.find((s) => s.parentSpanId === null)!.origin).toBe('root');
    expect(late[0].trace.spanCount).toBe(FULL_TREE_SPANS);
  });

  it('(e) unsampled outer past its deadline: later nested trace() starts a fresh root', async () => {
    h.rt.config.maxTraceDurationMs = 50;
    configureTracing({ sampleRate: 0 });
    let source!: AsyncResource;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const outer = trace(
      'outer-expired',
      async () => {
        source = new AsyncResource('src');
        await hold;
      },
      { kind: 'custom' },
    );
    await sleep(80);
    configureTracing({ sampleRate: 1 });
    await source.runInAsyncScope(() => trace('late-unsampled', () => app.consumer.process({ id: 'e2' }), { kind: 'custom' }));
    release();
    await outer;
    const items = await h.settle();
    const late = byOp(items, 'late-unsampled');
    expect(late).toHaveLength(1);
    expect(late[0].trace.spanCount).toBe(FULL_TREE_SPANS);
  });

  it('(f) synchronous delivery inside setup before it settles: rabbitmq is its own root; join:true is a child span', async () => {
    const channel = new FakeAmqpChannel();
    channel.consume('q', (msg) =>
      trace('rabbitmq.consume', () => app.consumer.process({ id: msg.id }), { kind: 'rabbitmq' }),
    );
    await trace(
      'setup-sync',
      async () => {
        await Promise.all([
          channel.deliverSync('q', { id: 'f1', content: null }),
          channel.deliverSync('q', { id: 'f2', content: null }),
        ]);
      },
      { kind: 'custom' },
    );
    let items = await h.settle();
    expect(byOp(items, 'setup-sync')[0].trace.spanCount).toBe(1); // setup gained nothing
    const roots = byOp(items, 'rabbitmq.consume');
    expect(roots).toHaveLength(2);
    for (const r of roots) expect(r.trace.spanCount).toBe(FULL_TREE_SPANS);

    // join:true opts back in to JOIN-IF-OPEN
    const before = items.length;
    const joinChannel = new FakeAmqpChannel();
    joinChannel.consume('q', (msg) =>
      trace('rabbitmq.consume.joined', () => app.consumer.process({ id: msg.id }), { kind: 'rabbitmq', join: true }),
    );
    await trace(
      'setup-join',
      async () => {
        await joinChannel.deliverSync('q', { id: 'f3', content: null });
      },
      { kind: 'custom' },
    );
    items = await h.settle();
    expect(items.length).toBe(before + 1); // only the setup trace; the delivery is a child
    const setup = byOp(items, 'setup-join')[0];
    expect(setup.trace.spanCount).toBe(FULL_TREE_SPANS + 1);
    expect(spanTree(setup).children[0]).toMatchObject({ operation: 'rabbitmq.consume.joined', origin: 'manual' });
  });

  it('(g) provider called from a stale store within the pluck window produces no span; spans started before settle still end', async () => {
    let stale!: AsyncResource;
    await trace(
      'setup-pluck',
      () => {
        stale = new AsyncResource('src');
        void app.repo.find(150, 'fire-and-forget'); // un-awaited child keeps the snapshot open (pluck window)
      },
      { kind: 'custom' },
    );
    await sleep(30); // root settled (token closed), snapshot held while the child span is open
    expect(h.rt.registry.openTraceCount()).toBe(1);
    const lateResult = await stale.runInAsyncScope(() => app.service.handle({ id: 'late', delayMs: 1 }));
    expect(lateResult).toEqual(['r:late', 'r:late']); // business result unaffected

    const items = await h.settle();
    const setup = byOp(items, 'setup-pluck')[0];
    expect(items).toHaveLength(1);
    expect(setup.spans.map((s) => s.operation).sort()).toEqual(['Repo.find', 'setup-pluck']); // started before settle: kept
    expect(setup.spans.some((s) => s.operation.startsWith('OrdersService'))).toBe(false); // started after settle: untraced
    expect(setup.trace.unfinishedSpanCount).toBe(0);
  });

  it('(g) provider called from a force-closed root whose snapshot is still held produces no span', async () => {
    h.rt.config.maxTraceDurationMs = 50;
    let stale!: AsyncResource;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const outer = trace(
      'closed-held',
      async () => {
        stale = new AsyncResource('src');
        void app.repo.find(200, 'open-child'); // keeps the force-closed snapshot waiting in the pluck window
        await hold;
      },
      { kind: 'custom' },
    );
    await sleep(80);
    expect(sweepOnce(h.rt)).toBe(1);
    expect(h.rt.registry.openTraceCount()).toBe(1); // still held
    await stale.runInAsyncScope(() => app.service.handle({ id: 'late2', delayMs: 1 }));
    release();
    await outer;
    const items = await h.settle();
    const closed = byOp(items, 'closed-held');
    expect(closed).toHaveLength(1);
    expect(closed[0].trace.status).toBe('incomplete');
    expect(closed[0].spans.some((s) => s.operation.startsWith('OrdersService'))).toBe(false);
  });
});
