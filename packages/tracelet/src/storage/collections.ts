import type { ObserveTrace, ObserveSpan, CpuProfile } from '../contracts/observe-contracts';

/** Structural subset of mongodb 6.x; callers supply a dedicated telemetry Db. */
export interface MongoFilter { [key: string]: unknown }
export interface MongoReadOptions { projection?: Record<string, 0 | 1>; maxTimeMS?: number }
export interface MongoCursor<T> {
  sort(spec: Record<string, 1 | -1>): MongoCursor<T>;
  limit(n: number): MongoCursor<T>;
  toArray(): Promise<T[]>;
}
export interface MongoCollection<T = Record<string, unknown>> {
  find(filter: MongoFilter, options?: MongoReadOptions): MongoCursor<T>;
  findOne(filter: MongoFilter, options?: MongoReadOptions): Promise<T | null>;
  insertMany(documents: Record<string, unknown>[], options?: { ordered?: boolean }): Promise<unknown>;
  replaceOne(filter: MongoFilter, replacement: Record<string, unknown>, options: { upsert: true }): Promise<unknown>;
  aggregate<U extends Record<string, unknown> = Record<string, unknown>>(pipeline: Record<string, unknown>[], options?: { maxTimeMS?: number }): MongoCursor<U>;
  createIndex(keys: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<string>;
}
export interface TelemetryCollections {
  traces: MongoCollection;
  spans: MongoCollection;
  profiles: MongoCollection;
  operations: MongoCollection;
  methods: MongoCollection;
  metrics: MongoCollection;
  instances: MongoCollection;
}
export interface TelemetryDb { collection(name: string): MongoCollection }
export function telemetryCollections(db: TelemetryDb, prefix = 'tracelet_'): TelemetryCollections {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(prefix)) throw new Error('invalid collection prefix');
  return { traces: db.collection(`${prefix}traces`), spans: db.collection(`${prefix}spans`), profiles: db.collection(`${prefix}profiles`), operations: db.collection(`${prefix}operation_rollups`), methods: db.collection(`${prefix}method_rollups`), metrics: db.collection(`${prefix}metric_rollups`), instances: db.collection(`${prefix}instances`) };
}

/** BSON representation; APIs project these fields back to frozen DTOs. */
export interface StoredMetadata { _id: string; schemaVersion: 1; expireAt: Date }
export type TraceDocument = Omit<ObserveTrace, 'startedAt'> & StoredMetadata & { startedAt: Date };
export type SpanDocument = ObserveSpan & StoredMetadata & { serviceName: string; instanceId: string; startedAt: Date };
export type ProfileDocument = Omit<CpuProfile, 'periodStart' | 'periodEnd'> & StoredMetadata & { periodStart: Date; periodEnd: Date };
