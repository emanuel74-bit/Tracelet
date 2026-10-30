import type { TraceletModuleOptions } from '../contracts/observe-contracts';
import type { HeartbeatFactory, InstanceIdentity, TelemetryQueue } from '../contracts/tracelet-internal-contracts';
import { runOutsideTrace } from '../shared/als';
import { createDiagnostics } from '../shared/diagnostics';
import { telemetryCollections } from './collections';
import { MongoTelemetryStore } from './documents';
import { HeartbeatWriter } from './heartbeat-writer';
import { ensureTelemetryIndexes } from './indexes';
import { createMongoClient } from './mongo-client.factory';
import { BoundedTelemetryWriter } from './telemetry-writer';
import { retryDelay } from './retry';

/** Nest lifecycle wiring remains LEAD-owned. start is detached and best-effort. */
export function createStorage(config: TraceletModuleOptions, queue: TelemetryQueue, identity: InstanceIdentity, heartbeatFactory: HeartbeatFactory) {
  const diagnostics = createDiagnostics('TraceletStorage');
  const client = runOutsideTrace(() => createMongoClient(config.storage));
  const collections = telemetryCollections(client.db(config.storage.database ?? 'observability'), config.storage.collectionPrefix);
  const store = new MongoTelemetryStore(collections, { maxSpansPerTrace: config.tracing?.maxSpansPerTrace ?? 2000, retention: { tracesHours: config.retention?.tracesHours ?? 72, profilesHours: config.retention?.profilesHours ?? 72, rollupsDays: config.retention?.rollupsDays ?? 14, instancesHours: config.retention?.instancesHours ?? 24 } });
  const b = config.buffer;
  const writer = new BoundedTelemetryWriter(queue, store, { batchItems: b?.batchSize ?? 200, batchBytes: b?.maxBatchBytes ?? 4 * 1024 * 1024, flushIntervalMs: b?.flushIntervalMs ?? 1000, maxWriteDocsPerSecond: b?.maxWriteDocsPerSecond ?? 2000, retryLimit: b?.maxRetries ?? 3, shutdownTimeoutMs: b?.shutdownFlushTimeoutMs ?? 5000 });
  const heartbeat = new HeartbeatWriter(store, () => {
    const value = heartbeatFactory();
    if (value.instanceId !== identity.instanceId || value.serviceName !== identity.serviceName) throw new Error('invalid heartbeat identity');
    return value;
  });
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let wakeRetry: (() => void) | undefined;
  const connect = async () => {
    for (let attempt = 0; !stopped; attempt++) {
      try { await client.connect(); if (stopped) return; await ensureTelemetryIndexes(collections); return; }
      catch { if (stopped) return; diagnostics.warn('startup', 'Storage connection or index setup failed; retrying.'); await new Promise<void>(resolve => { const timer = setTimeout(() => { wakeRetry = undefined; resolve(); }, retryDelay(attempt)); timer.unref?.(); wakeRetry = () => { clearTimeout(timer); wakeRetry = undefined; resolve(); }; }); }
    }
  };
  const bounded = async (work: Promise<unknown>, deadline: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  return {
    start(): void { runOutsideTrace(() => { if (started || stopped) return; started = true; writer.start(); heartbeat.start(); void connect(); }); },
    stop(): Promise<void> { return runOutsideTrace(() => stopPromise ??= (async () => { stopped = true; wakeRetry?.(); heartbeat.stop(); const deadline = Date.now() + (b?.shutdownFlushTimeoutMs ?? 5000); await bounded(writer.shutdown(), deadline); await bounded(client.close(), deadline); })()); },
    flush(): Promise<void> { return writer.flush(); },
    health: () => stopped ? { ...writer.storageHealth(), connected: false } : writer.storageHealth(),
  };
}
