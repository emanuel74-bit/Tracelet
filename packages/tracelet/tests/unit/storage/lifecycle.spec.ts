import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { HeartbeatFactory, TelemetryItem, TelemetryQueue } from '../../../src/contracts/tracelet-internal-contracts';
const mocks = vi.hoisted(() => ({ client: { db: vi.fn(), connect: vi.fn(), close: vi.fn() }, index: vi.fn() }));
vi.mock('../../../src/storage/mongo-client.factory', () => ({ createMongoClient: () => mocks.client }));
vi.mock('../../../src/storage/indexes', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/storage/indexes')>(), createTelemetryIndexSetup: () => mocks.index }));
import { createStorage } from '../../../src/storage/index';
import { TelemetryIndexSetupError } from '../../../src/storage/indexes';
import { MongoTelemetryStore } from '../../../src/storage/documents';
import { traceletAls } from '../../../src/shared/als';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(queueOverride?: TelemetryQueue, heartbeatFactory: HeartbeatFactory = () => { throw new Error('no heartbeat'); }) {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.client.db.mockReturnValue({ collection: () => ({}) });
  mocks.client.connect.mockResolvedValue(undefined); mocks.client.close.mockResolvedValue(undefined); mocks.index.mockResolvedValue(undefined);
  const queue = queueOverride ?? { depth: () => 0, waitForItems: () => new Promise<void>(() => undefined) } as unknown as TelemetryQueue;
  const storage = createStorage({ serviceName: 'worker', storage: { uri: 'mongodb://example' }, buffer: { shutdownFlushTimeoutMs: 100, batchSize: 2 } }, queue, { instanceId: 'pod-a', serviceName: 'worker' } as never, heartbeatFactory);
  return storage;
}
describe('storage facade lifecycle', () => {
  it('finishes pending and queued drop accounting before stop resolves when the facade deadline is earlier', async () => {
    const items = ['trace', 'profile', 'rollup', 'metric'].map(type => ({ type, estimatedBytes: 10 }) as TelemetryItem);
    const remaining = [...items];
    const reportDropped = vi.fn();
    const queue = { depth: () => remaining.length, drain: (max: number) => remaining.splice(0, max), reportDropped, waitForItems: () => new Promise<void>(() => undefined) } as unknown as TelemetryQueue;
    const storage = setup(queue);
    let complete!: () => void;
    const write = vi.spyOn(MongoTelemetryStore.prototype, 'write').mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const flush = storage.flush(); await vi.advanceTimersByTimeAsync(0);
    // Model time spent entering the writer after the facade computes its deadline.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1);
    let resolved = false;
    const stop = storage.stop().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(99); expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await stop;
    expect(queue.depth()).toBe(0);
    expect(reportDropped.mock.calls.flatMap(([dropped]) => dropped)).toEqual(items);
    expect(reportDropped.mock.calls.every(([, reason]) => reason === 'shutdown')).toBe(true);
    complete(); await flush; await storage.stop();
    expect(write).toHaveBeenCalledTimes(1);
    expect(reportDropped.mock.calls.flatMap(([dropped]) => dropped)).toEqual(items);
    expect(mocks.client.close).toHaveBeenCalledTimes(1);
  });
  it('sends the first heartbeat while indexes are pending, and never after stop', async () => {
    const factory = vi.fn(() => ({ instanceId: 'pod-a', serviceName: 'worker' }) as never);
    const storage = setup(undefined, factory);
    let ready!: () => void;
    mocks.index.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const write = vi.spyOn(MongoTelemetryStore.prototype, 'writeHeartbeat').mockResolvedValue();
    storage.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    ready(); await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    await storage.stop(); await vi.advanceTimersByTimeAsync(30000);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('does not restart heartbeats if index creation finishes after stop', async () => {
    const factory = vi.fn(() => ({ instanceId: 'pod-a', serviceName: 'worker' }) as never);
    const storage = setup(undefined, factory);
    let ready!: () => void;
    mocks.index.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const write = vi.spyOn(MongoTelemetryStore.prototype, 'writeHeartbeat').mockResolvedValue();
    storage.start(); await vi.advanceTimersByTimeAsync(0); await storage.stop();
    ready(); await vi.advanceTimersByTimeAsync(30000);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('does not start heartbeats or indexes if connection finishes after stop', async () => {
    const factory = vi.fn(() => ({ instanceId: 'pod-a', serviceName: 'worker' }) as never);
    const storage = setup(undefined, factory);
    let ready!: () => void;
    mocks.client.connect.mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    storage.start(); await vi.advanceTimersByTimeAsync(0); await storage.stop();
    ready(); await vi.advanceTimersByTimeAsync(30000);
    expect(factory).not.toHaveBeenCalled(); expect(mocks.index).not.toHaveBeenCalled();
  });
  it('reports repeated startup failures once using a safe diagnostic', async () => {
    const storage = setup();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    mocks.client.connect.mockRejectedValue(new Error('mongodb://user:secret@example'));
    storage.start(); await vi.advanceTimersByTimeAsync(1000); await storage.stop();
    expect(mocks.client.connect).toHaveBeenCalledTimes(2);
    expect(mocks.index).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([message]) => message === 'Storage connection failed; retrying.')).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
  it.each([
    [true, false, 'missing createIndex privilege'],
    [false, true, 'conflicting index'],
  ])('keeps heartbeats independent of TTL index failure (%s/%s)', async (unauthorized, conflict, reason) => {
    const factory = vi.fn(() => ({ instanceId: 'pod-a', serviceName: 'worker' }) as never);
    const storage = setup(undefined, factory);
    const write = vi.spyOn(MongoTelemetryStore.prototype, 'writeHeartbeat').mockResolvedValue();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    mocks.index.mockRejectedValue(new TelemetryIndexSetupError(true, unauthorized as boolean, conflict as boolean));
    storage.start(); await vi.advanceTimersByTimeAsync(31000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(mocks.client.connect).toHaveBeenCalledTimes(1);
    expect(mocks.index.mock.calls.length).toBeGreaterThan(2);
    expect(warn.mock.calls).toEqual([[expect.stringContaining(`TTL index setup incomplete (${reason})`), 'TraceletStorage']]);
    expect(String(warn.mock.calls[0]![0])).toContain('automatic expiry is not verified');
    await storage.stop(); const attempts = mocks.index.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(write).toHaveBeenCalledTimes(2); expect(mocks.index).toHaveBeenCalledTimes(attempts);
  });
  it('reports query-only conflicts separately from retention and never logs driver text', async () => {
    const storage = setup();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mocks.index.mockRejectedValue(new TelemetryIndexSetupError(false, false, true));
    storage.start(); await vi.advanceTimersByTimeAsync(0);
    expect(warn.mock.calls.some(([message]) => String(message).includes('Query index setup incomplete (conflicting index)'))).toBe(true);
    expect(warn.mock.calls.some(([message]) => String(message).includes('TTL'))).toBe(false);
    mocks.index.mockRejectedValue(new Error('mongodb://user:secret@example'));
    await vi.advanceTimersByTimeAsync(1000); await storage.stop();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
  it('bounds stop even while driver close never resolves and does not restart', async () => {
    const storage = setup(); mocks.client.close.mockImplementation(() => new Promise(() => undefined));
    const contexts: unknown[] = []; mocks.client.connect.mockImplementation(async () => { contexts.push(traceletAls.getStore()); });
    traceletAls.run(new Map([['business', true]]), () => storage.start()); await vi.advanceTimersByTimeAsync(0);
    const stop = storage.stop(); await vi.advanceTimersByTimeAsync(100); await stop;
    expect(mocks.client.close).toHaveBeenCalledTimes(1); expect(storage.health().connected).toBe(false);
    storage.start(); await storage.stop(); expect(mocks.client.connect).toHaveBeenCalledTimes(1); expect(contexts).toEqual([undefined]);
  });
  it('retries startup index failures then stops retrying after shutdown', async () => {
    const storage = setup(); mocks.index.mockRejectedValueOnce(new Error('offline'));
    storage.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.index).toHaveBeenCalledTimes(2);
    await storage.stop(); await vi.advanceTimersByTimeAsync(30000); expect(mocks.index).toHaveBeenCalledTimes(2);
  });
});
