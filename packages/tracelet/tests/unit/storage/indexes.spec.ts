import { describe, expect, it, vi } from 'vitest';
import type { MongoCollection, TelemetryCollections } from '../../../src/storage/collections';
import { createTelemetryIndexSetup, TelemetryIndexSetupError } from '../../../src/storage/indexes';

function collections(): TelemetryCollections {
  const collection = () => ({ createIndex: vi.fn().mockResolvedValue('index') }) as unknown as MongoCollection;
  return { traces: collection(), spans: collection(), profiles: collection(), operations: collection(), methods: collection(), metrics: collection(), instances: collection() };
}

describe('index setup recovery', () => {
  it.each([13, 85, 86])('classifies code %i without retaining raw driver text', async code => {
    const c = collections();
    vi.mocked(c.traces.createIndex).mockRejectedValueOnce(Object.assign(new Error('mongodb://user:secret@example'), { code }));
    const setup = createTelemetryIndexSetup(c);
    await expect(setup()).rejects.toMatchObject({ ttlFailed: true, unauthorized: code === 13, conflict: code === 85 || code === 86 });
    // Only the failed TTL call retries; all other 21 successes are remembered.
    await setup(); await setup();
    expect(c.traces.createIndex).toHaveBeenCalledTimes(7);
    for (const collection of Object.values(c) as MongoCollection[]) {
      if (collection !== c.traces) expect(vi.mocked(collection.createIndex).mock.calls.filter(([keys]) => 'expireAt' in keys)).toHaveLength(1);
    }
  });
  it('waits for all indexes to settle before retrying only failed definitions', async () => {
    const c = collections();
    let resolve!: (index: string) => void;
    vi.mocked(c.spans.createIndex).mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    vi.mocked(c.traces.createIndex).mockRejectedValueOnce({ code: 13, message: 'secret' });
    const setup = createTelemetryIndexSetup(c);
    let settled = false;
    const first = setup().catch(error => { settled = true; return error; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    resolve('ttl'); const error = await first;
    expect(error).toBeInstanceOf(TelemetryIndexSetupError);
    expect(JSON.stringify(error)).not.toContain('secret'); expect(String(error)).not.toContain('secret');
    await setup();
    expect(c.spans.createIndex).toHaveBeenCalledTimes(2);
    expect(c.traces.createIndex).toHaveBeenCalledTimes(7);
  });
  it('distinguishes query-only failure from TTL failures and recovers synchronously thrown DDL', async () => {
    const c = collections();
    vi.mocked(c.traces.createIndex).mockImplementation(keys => {
      if ('serviceName' in keys) throw { code: 86, message: 'secret' };
      return Promise.resolve('index');
    });
    const setup = createTelemetryIndexSetup(c);
    await expect(setup()).rejects.toMatchObject({ ttlFailed: false, unauthorized: false, conflict: true });
    expect(Object.values(c).reduce((sum, collection) => sum + vi.mocked(collection.createIndex).mock.calls.length, 0)).toBe(22);
    vi.mocked(c.traces.createIndex).mockResolvedValue('index'); await setup();
    expect(c.traces.createIndex).toHaveBeenCalledTimes(9);
  });
  it('a new startup session rechecks indexes instead of sharing completion across clients', async () => {
    const c = collections(); await createTelemetryIndexSetup(c)(); await createTelemetryIndexSetup(c)();
    expect(c.instances.createIndex).toHaveBeenCalledTimes(4);
  });
});
