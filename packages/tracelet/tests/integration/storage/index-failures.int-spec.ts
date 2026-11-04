import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceHeartbeat } from '../../../src/contracts/observe-contracts';
import { BoundedTelemetryQueue } from '../../../src/buffer';
import { createStorage } from '../../../src/storage';

// Opt-in, disposable AUTH-ENABLED server with user/role administration privileges.
// Only creates/drops uniquely named databases; never use production credentials.
const uri = process.env.TRACELET_INDEX_TEST_MONGO_URI;
const suffixes = ['traces', 'spans', 'profiles', 'operation_rollups', 'method_rollups', 'metric_rollups', 'instances'];
async function until(probe: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Storage index/heartbeat recovery did not complete');
}

describe.skipIf(!uri)('real Mongo index failures', () => {
  it('persists heartbeats without createIndex and explicitly warns that retention is unverified', async () => {
    const admin = new MongoClient(uri!);
    const name = `tracelet_index_test_${randomUUID().replaceAll('-', '')}`;
    const password = 'private-test-password';
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    let storage: ReturnType<typeof createStorage> | undefined;
    try {
      await admin.connect();
      const db = admin.db(name);
      await db.command({ createRole: 'writer', privileges: [{ resource: { db: name, collection: '' }, actions: ['find', 'insert', 'update'] }], roles: [] });
      await db.command({ createUser: 'writer', pwd: password, roles: [{ role: 'writer', db: name }] });
      const restricted = new URL(uri!); restricted.username = 'writer'; restricted.password = password;
      restricted.searchParams.set('authSource', name);
      const identity = { serviceName: 'index-test', instanceId: 'index-test-pod' };
      const heartbeat = (): InstanceHeartbeat => ({ schemaVersion: 1, ...identity, hostName: 'test', pid: process.pid, bootId: 'test',
        startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), versions: { node: process.versions.node, tracelet: 'test' },
        tracing: { enabled: true, sampleRate: 1 }, profiler: { state: 'disabled' }, buffer: { queueDepth: 0, droppedTraces: 0, droppedProfiles: 0 }, storage: { connected: true } });
      storage = createStorage({ serviceName: identity.serviceName, storage: { uri: restricted.toString(), database: name }, buffer: { shutdownFlushTimeoutMs: 1000 } }, new BoundedTelemetryQueue(), identity as never, heartbeat);
      storage.start();
      await until(async () => await db.collection('tracelet_instances').countDocuments() === 1 && warn.mock.calls.length > 0);
      const indexes = await db.collection('tracelet_instances').listIndexes().toArray();
      expect(indexes.some(i => i.expireAfterSeconds !== undefined)).toBe(false);
      const diagnostics = JSON.stringify(warn.mock.calls);
      expect(diagnostics).toMatch(/TTL|retention/i);
      expect(diagnostics).toMatch(/privilege|permission|authoriz/i);
      expect(diagnostics).not.toContain(password);
      expect(diagnostics).not.toContain('mongodb://');
      await storage.stop();
      expect(storage.health().connected).toBe(false);
    } finally { await storage?.stop(); await admin.db(name).dropDatabase(); await admin.close(); warn.mockRestore(); }
  }, 30000);

  it('keeps heartbeats and other TTL indexes working during a conflict, then retries the failed index', async () => {
    const admin = new MongoClient(uri!);
    const name = `tracelet_index_test_${randomUUID().replaceAll('-', '')}`;
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    let storage: ReturnType<typeof createStorage> | undefined;
    try {
      await admin.connect();
      const db = admin.db(name);
      await db.collection('tracelet_traces').createIndex({ expireAt: 1 }, { expireAfterSeconds: 60 });
      const identity = { serviceName: 'index-test', instanceId: 'conflict-test-pod' };
      const heartbeat = (): InstanceHeartbeat => ({ schemaVersion: 1, ...identity, hostName: 'test', pid: process.pid, bootId: 'test',
        startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), versions: { node: process.versions.node, tracelet: 'test' },
        tracing: { enabled: true, sampleRate: 1 }, profiler: { state: 'disabled' }, buffer: { queueDepth: 0, droppedTraces: 0, droppedProfiles: 0 }, storage: { connected: true } });
      storage = createStorage({ serviceName: identity.serviceName, storage: { uri: uri!, database: name }, buffer: { shutdownFlushTimeoutMs: 1000 } }, new BoundedTelemetryQueue(), identity as never, heartbeat);
      storage.start();
      await until(async () => await db.collection('tracelet_instances').countDocuments() === 1 && warn.mock.calls.length > 0);
      for (const suffix of suffixes.slice(1)) {
        await until(async () => (await db.collection(`tracelet_${suffix}`).listIndexes().toArray()).some(i => i.expireAfterSeconds === 0));
      }
      expect(JSON.stringify(warn.mock.calls)).toMatch(/conflict/i);
      await db.collection('tracelet_traces').dropIndex('expireAt_1');
      await until(async () => (await db.collection('tracelet_traces').listIndexes().toArray()).some(i => i.expireAfterSeconds === 0));
      expect(await db.collection('tracelet_instances').countDocuments()).toBe(1);
    } finally { await storage?.stop(); await admin.db(name).dropDatabase(); await admin.close(); warn.mockRestore(); }
  }, 30000);
});
