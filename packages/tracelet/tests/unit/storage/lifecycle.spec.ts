import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { TelemetryQueue } from '../../../src/contracts/tracelet-internal-contracts';
const mocks = vi.hoisted(() => ({ client: { db: vi.fn(), connect: vi.fn(), close: vi.fn() }, index: vi.fn() }));
vi.mock('../../../src/storage/mongo-client.factory', () => ({ createMongoClient: () => mocks.client }));
vi.mock('../../../src/storage/indexes', () => ({ ensureTelemetryIndexes: mocks.index }));
import { createStorage } from '../../../src/storage/index';
import { traceletAls } from '../../../src/shared/als';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.client.db.mockReturnValue({ collection: () => ({}) });
  mocks.client.connect.mockResolvedValue(undefined); mocks.client.close.mockResolvedValue(undefined); mocks.index.mockResolvedValue(undefined);
  const queue = { depth: () => 0, waitForItems: () => new Promise<void>(() => undefined) } as unknown as TelemetryQueue;
  const storage = createStorage({ serviceName: 'worker', storage: { uri: 'mongodb://example' }, buffer: { shutdownFlushTimeoutMs: 100 } }, queue, { instanceId: 'pod-a', serviceName: 'worker' } as never, () => { throw new Error('no heartbeat'); });
  return storage;
}
describe('storage facade lifecycle', () => {
  it('reports repeated startup failures once using a safe diagnostic', async () => {
    const storage = setup();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    mocks.index.mockRejectedValue(new Error('mongodb://user:secret@example'));
    storage.start(); await vi.advanceTimersByTimeAsync(1000); await storage.stop();
    expect(mocks.index).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter(([message]) => message === 'Storage connection or index setup failed; retrying.')).toHaveLength(1);
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
