import type { TelemetryCollections } from './collections';

/** Only coarse categories survive setup; driver text may contain credentials. */
export class TelemetryIndexSetupError extends Error {
  constructor(readonly ttlFailed: boolean, readonly unauthorized: boolean, readonly conflict: boolean) {
    super('Telemetry index setup incomplete');
  }
}

/** Exactly the frozen index set; Mongo supplies the unique natural-key _id index.
 * A setup session remembers successes, so a failed index never replays healthy DDL.
 */
export function createTelemetryIndexSetup(c: TelemetryCollections): () => Promise<void> {
  const jobs: (() => Promise<string>)[] = Object.values(c).map((v) => () => v.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }));
  const ttlCount = jobs.length;
  jobs.push(
    () => c.traces.createIndex({ serviceName: 1, startedAt: -1, _id: -1 }),
    () => c.traces.createIndex({ instanceId: 1, startedAt: -1, _id: -1 }),
    () => c.traces.createIndex({ serviceName: 1, status: 1, startedAt: -1, _id: -1 }),
    () => c.traces.createIndex({ serviceName: 1, operation: 1, startedAt: -1, _id: -1 }),
    () => c.traces.createIndex({ startedAt: -1, _id: -1 }),
    () => c.spans.createIndex({ traceId: 1, startOffsetMs: 1, _id: 1 }),
    () => c.profiles.createIndex({ serviceName: 1, periodStart: -1, _id: -1 }),
    () => c.profiles.createIndex({ instanceId: 1, periodStart: -1, _id: -1 }),
    () => c.operations.createIndex({ serviceName: 1, bucketStart: -1 }),
    () => c.operations.createIndex({ instanceId: 1, bucketStart: -1 }),
    () => c.methods.createIndex({ serviceName: 1, bucketStart: -1 }),
    () => c.methods.createIndex({ instanceId: 1, bucketStart: -1 }),
    () => c.metrics.createIndex({ instanceId: 1, intervalStart: -1 }),
    () => c.metrics.createIndex({ serviceName: 1, intervalStart: -1 }),
    () => c.instances.createIndex({ serviceName: 1, lastSeenAt: -1 }),
  );
  const pending = new Map(jobs.map((job, index) => [index, job]));
  return async () => {
    const batch = [...pending];
    const results = await Promise.allSettled(batch.map(([, job]) => Promise.resolve().then(job)));
    let failed = false, ttlFailed = false, unauthorized = false, conflict = false;
    results.forEach((result, offset) => {
      const index = batch[offset]![0];
      if (result.status === 'fulfilled') { pending.delete(index); return; }
      failed = true;
      ttlFailed ||= index < ttlCount;
      const code = result.reason?.code;
      unauthorized ||= code === 13;
      conflict ||= code === 85 || code === 86;
    });
    if (failed) throw new TelemetryIndexSetupError(ttlFailed, unauthorized, conflict);
  };
}

export async function ensureTelemetryIndexes(c: TelemetryCollections): Promise<void> {
  await createTelemetryIndexSetup(c)();
}
