import type { TelemetryCollections } from './collections';

/** Exactly the frozen index set; Mongo supplies the unique natural-key _id index. */
export async function ensureTelemetryIndexes(c: TelemetryCollections): Promise<void> {
  const jobs: Promise<string>[] = Object.values(c).map((v) => v.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }));
  jobs.push(
    c.traces.createIndex({ serviceName: 1, startedAt: -1, _id: -1 }),
    c.traces.createIndex({ instanceId: 1, startedAt: -1, _id: -1 }),
    c.traces.createIndex({ serviceName: 1, status: 1, startedAt: -1, _id: -1 }),
    c.traces.createIndex({ serviceName: 1, operation: 1, startedAt: -1, _id: -1 }),
    c.traces.createIndex({ startedAt: -1, _id: -1 }),
    c.spans.createIndex({ traceId: 1, startOffsetMs: 1, _id: 1 }),
    c.profiles.createIndex({ serviceName: 1, periodStart: -1, _id: -1 }),
    c.profiles.createIndex({ instanceId: 1, periodStart: -1, _id: -1 }),
    c.operations.createIndex({ serviceName: 1, bucketStart: -1 }),
    c.operations.createIndex({ instanceId: 1, bucketStart: -1 }),
    c.methods.createIndex({ serviceName: 1, bucketStart: -1 }),
    c.methods.createIndex({ instanceId: 1, bucketStart: -1 }),
    c.metrics.createIndex({ instanceId: 1, intervalStart: -1 }),
    c.metrics.createIndex({ serviceName: 1, intervalStart: -1 }),
    c.instances.createIndex({ serviceName: 1, lastSeenAt: -1 }),
  );
  await Promise.all(jobs);
}
