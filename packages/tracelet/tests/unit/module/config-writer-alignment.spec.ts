import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { resolveOptions } from '../../../src/config/index.js';
import { createInstanceIdentity } from '../../../src/shared/index.js';
import { createStorage } from '../../../src/storage/index.js';

/* L3: every configuration resolveOptions accepts must be accepted by the storage writer (no misleading init failure). */
const base = { serviceName: 's', storage: { uri: 'mongodb://127.0.0.1:1/x' } };
const edges: Array<Record<string, number>> = [
  { maxRetries: 0 }, { maxRetries: 10 }, { shutdownFlushTimeoutMs: 1 }, { shutdownFlushTimeoutMs: 15_000 },
  { flushIntervalMs: 100 }, { batchSize: 1 }, { maxBatchBytes: 64 * 1024 }, { maxWriteDocsPerSecond: 1 },
  { batchSize: 5000, maxBatchBytes: 64 * 1024 * 1024, maxWriteDocsPerSecond: 100_000, flushIntervalMs: 60_000 },
];

describe('config ranges are accepted by the storage writer', () => {
  for (const buffer of edges) {
    it(`buffer ${JSON.stringify(buffer)}`, async () => {
      const c = resolveOptions({ ...base, buffer }, { NODE_ENV: 'test' });
      const identity = createInstanceIdentity({ serviceName: 's' });
      const storage = createStorage({ serviceName: 's', storage: c.storage, tracing: c.tracing, buffer: c.buffer, retention: c.retention } as never, new BoundedTelemetryQueue(), identity, (() => ({})) as never);
      await storage.stop(); // never started: closes the (unconnected) client
      expect(storage.health().connected).toBe(false);
    });
  }
  it('rejects the values the writer would reject', () => {
    for (const buffer of [{ maxRetries: 11 }, { shutdownFlushTimeoutMs: 0 }, { shutdownFlushTimeoutMs: 15_001 }]) {
      expect(() => resolveOptions({ ...base, buffer }, { NODE_ENV: 'test' })).toThrow(/buffer\./);
    }
  });
});
