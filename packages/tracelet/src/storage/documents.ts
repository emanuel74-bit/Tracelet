import { createHash } from 'node:crypto';
import type { TelemetryItem, StorageHealthSource } from '../contracts/tracelet-internal-contracts';
import type { InstanceHeartbeat, ObserveTrace, ObserveSpan } from '../contracts/observe-contracts';
import type { MongoCollection, TelemetryCollections } from './collections';

/** Reject calendar rollover (Date.parse alone accepts February 30). */
export function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

export interface TelemetryStoreOptions {
  retentionMs?: number;
  retention?: { tracesHours: number; profilesHours: number; rollupsDays: number; instancesHours: number };
  maxSpansPerTrace: number;
  maxItemBytes?: number;
}
const hash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);
const bson = (value: Record<string, unknown>, fields: string[]): Record<string, unknown> => {
  const result = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const field of fields) if (result[field] !== undefined) result[field] = new Date(result[field] as string);
  return result;
};
function duplicateOnly(error: unknown): boolean {
  const e = error as { code?: number; writeErrors?: Array<{ code?: number }>; writeConcernErrors?: unknown[] };
  return !!e && (!e.writeConcernErrors?.length) && (e.writeErrors?.length ? e.writeErrors.every((v) => v.code === 11000) : e.code === 11000);
}
export class MongoTelemetryStore implements StorageHealthSource {
  private connected = false;
  private lastFlushAt?: string;
  private lastFlushErrorCode?: string;
  private readonly retention: { trace: number; profile: number; rollup: number; instance: number };
  constructor(private readonly collections: TelemetryCollections, private readonly options: TelemetryStoreOptions) {
    const r = options.retention;
    this.retention = r ? { trace: r.tracesHours * 3600000, profile: r.profilesHours * 3600000, rollup: r.rollupsDays * 86400000, instance: r.instancesHours * 3600000 } : { trace: options.retentionMs ?? 86400000, profile: options.retentionMs ?? 86400000, rollup: options.retentionMs ?? 604800000, instance: options.retentionMs ?? 86400000 };
    if (Object.values(this.retention).some((v) => !Number.isFinite(v) || v <= 0) || !Number.isInteger(options.maxSpansPerTrace) || options.maxSpansPerTrace < 1 || options.maxSpansPerTrace > 5000 || !Number.isSafeInteger(options.maxItemBytes ?? 8 * 1024 * 1024) || (options.maxItemBytes ?? 1) < 1) throw new Error('invalid storage limits');
  }
  storageHealth(): ReturnType<StorageHealthSource['storageHealth']> { return { connected: this.connected, lastFlushAt: this.lastFlushAt, lastFlushErrorCode: this.lastFlushErrorCode }; }
  private async operation(fn: () => Promise<void>): Promise<void> {
    try { await fn(); this.connected = true; this.lastFlushAt = new Date().toISOString(); this.lastFlushErrorCode = undefined; }
    catch (error) { this.connected = false; this.lastFlushErrorCode = 'STORAGE_UNAVAILABLE'; throw error; }
  }
  private bounded(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > (this.options.maxItemBytes ?? 8 * 1024 * 1024)) throw new Error('telemetry item too large');
  }
  private document(value: Record<string, unknown>, id: string, source: string, retention: number, fields: string[]): Record<string, unknown> {
    const result = bson(value, fields);
    const expireAt = new Date(Date.parse(source) + retention);
    if (!Number.isFinite(expireAt.valueOf())) throw new Error('invalid telemetry expiry');
    return { ...result, _id: id, schemaVersion: 1, expireAt };
  }
  private async insert(collection: MongoCollection, documents: Record<string, unknown>[], beforeWrite: () => Promise<void>): Promise<void> {
    if (!documents.length) return;
    for (const document of documents) { await beforeWrite(); try { await collection.insertMany([document], { ordered: false }); } catch (error) { if (!duplicateOnly(error)) throw error; } }
  }
  async write(item: TelemetryItem, beforeWrite: () => Promise<void> = async () => undefined): Promise<void> {
    this.bounded(item);
    switch (item.type) {
      case 'trace': {
        this.validateTrace(item.trace, item.spans);
        const trace = this.document({ ...item.trace }, item.trace.traceId, item.trace.startedAt, this.retention.trace, ['startedAt']);
        const spans = item.spans.map((span) => this.document({ ...span, serviceName: item.trace.serviceName, instanceId: item.trace.instanceId, startedAt: item.trace.startedAt }, span.spanId, item.trace.startedAt, this.retention.trace, ['startedAt']));
        await this.operation(async () => { await this.insert(this.collections.traces, [trace], beforeWrite); await this.insert(this.collections.spans, spans, beforeWrite); });
        return;
      }
      case 'profile': {
        const p = item.profile; validateTelemetry('CpuProfile', p);
        if (Date.parse(p.periodStart) >= Date.parse(p.periodEnd) || p.sampleCount !== p.stacks.reduce((n, s) => n + s.samples, 0) + (p.droppedSampleCount ?? 0) || p.stacks.some((s) => s.stack.split(';').length > 128)) throw new Error('invalid profile invariants');
        const doc = this.document({ ...p }, p.profileId, p.periodStart, this.retention.profile, ['periodStart', 'periodEnd']);
        await this.operation(() => this.insert(this.collections.profiles, [doc], beforeWrite)); return;
      }
      case 'metric': {
        const m = item.metric; validateTelemetry('MetricRollup', m);
        if (Date.parse(m.intervalStart) >= Date.parse(m.intervalEnd)) throw new Error('invalid metric interval');
        const id = `${m.instanceId}|${Date.parse(m.intervalStart)}`;
        const doc = this.document({ ...m }, id, m.intervalStart, this.retention.rollup, ['intervalStart', 'intervalEnd']);
        await this.operation(async () => { await beforeWrite(); await this.collections.metrics.replaceOne({ _id: id }, doc, { upsert: true }); }); return;
      }
      case 'rollup': {
        if (item.operations.length > 501 || item.methods.length > 2001) throw new Error('invalid rollup cardinality');
        // Validate the complete item before any writes; serial writes preserve full-snapshot ordering.
        const documents = [...item.operations.map((v) => ({ v, type: 'OperationRollup' as const, collection: this.collections.operations, key: `${v.instanceId}|${Date.parse(v.bucketStart)}|${hash(v.operation + '\u0000' + v.kind)}` })), ...item.methods.map((v) => ({ v, type: 'MethodRollup' as const, collection: this.collections.methods, key: `${v.instanceId}|${Date.parse(v.bucketStart)}|${hash(v.operation)}` }))];
        for (const { v, type } of documents) { validateTelemetry(type, v); if (v.histogram.reduce((n, b) => n + b, 0) !== v.count || Date.parse(v.bucketStart) % 60000 !== 0 || v.errorCount > v.count) throw new Error('invalid rollup invariants'); }
        await this.operation(async () => { for (const { v, key, collection } of documents) { await beforeWrite(); await collection.replaceOne({ _id: key }, this.document({ ...v }, key, v.bucketStart, this.retention.rollup, ['bucketStart']), { upsert: true }); } }); return;
      }
      default: throw new Error('invalid telemetry type');
    }
  }
  async writeHeartbeat(heartbeat: InstanceHeartbeat): Promise<void> {
    this.bounded(heartbeat); validateTelemetry('InstanceHeartbeat', heartbeat);
    const doc = this.document({ ...heartbeat }, heartbeat.instanceId, heartbeat.lastSeenAt, this.retention.instance, ['startedAt', 'lastSeenAt']);
    const profiler = doc.profiler as Record<string, unknown>;
    const buffer = doc.buffer as Record<string, unknown>;
    if (profiler.lastWindowAt) profiler.lastWindowAt = new Date(profiler.lastWindowAt as string);
    if (buffer.lastFlushAt) buffer.lastFlushAt = new Date(buffer.lastFlushAt as string);
    await this.operation(async () => { await this.collections.instances.replaceOne({ _id: heartbeat.instanceId }, doc, { upsert: true }); });
  }
  private validateTrace(trace: ObserveTrace, spans: ObserveSpan[]): void {
    validateTelemetry('Trace', trace);
    if (spans.length > this.options.maxSpansPerTrace || trace.spanCount !== spans.length || (trace.error === undefined) !== (trace.errorFingerprint === undefined)) throw new Error('invalid trace invariants');
    const ids = new Set<string>();
    for (const span of spans) { validateTelemetry('Span', span); if (span.traceId !== trace.traceId || ids.has(span.spanId)) throw new Error('invalid trace spans'); ids.add(span.spanId); }
    const roots = spans.filter((s) => s.parentSpanId === null);
    if (roots.length !== 1 || trace.rootSpanId !== undefined && roots[0]!.spanId !== trace.rootSpanId || roots[0]!.operation !== trace.operation || roots[0]!.durationMs !== trace.durationMs || roots[0]!.startOffsetMs !== 0 || trace.status === 'error' && roots[0]!.status !== 'error' || trace.detail === 'rootOnly' && spans.length !== 1 || trace.errorCount !== spans.filter((s) => s.sanitizedError !== undefined).length) throw new Error('invalid trace root');
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    for (const span of spans) {
      let current = span; const visited = new Set<string>();
      while (current.parentSpanId !== null) { if (visited.has(current.spanId)) throw new Error('cyclic trace spans'); visited.add(current.spanId); const parent = byId.get(current.parentSpanId); if (!parent) throw new Error('missing parent span'); current = parent; }
    }
  }
}

import schema from '../contracts/telemetry.schema.json';

type Rule = { $ref?: string; type?: string; const?: unknown; enum?: unknown[]; anyOf?: Rule[]; properties?: Record<string, Rule>; required?: string[]; additionalProperties?: boolean | Rule; propertyNames?: Rule; items?: Rule; format?: string; pattern?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; maxProperties?: number };
const definitions = schema.$defs as unknown as Record<string, Rule>;
const invalid = (): never => { throw new Error('invalid telemetry'); };

/** Validates the frozen telemetry-only schema without a production validator dependency.
 * The schema rejects extra fields so raw payloads cannot be smuggled into persisted DTOs. */
function check(value: unknown, rule: Rule): boolean {
  if (rule.$ref) return check(value, definitions[rule.$ref.slice('#/$defs/'.length)]!);
  if (rule.anyOf && !rule.anyOf.some((v) => check(value, v))) return false;
  if ('const' in rule && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  switch (rule.type) {
    case 'null': if (value !== null) return false; break;
    case 'boolean': if (typeof value !== 'boolean') return false; break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isSafeInteger(value))) return false;
      if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum || rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) return false;
      break;
    case 'string':
      if (typeof value !== 'string') return false;
      if (rule.minLength !== undefined && value.length < rule.minLength || rule.maxLength !== undefined && value.length > rule.maxLength) return false;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
      if (rule.format === 'date-time' && !isIsoDateTime(value)) return false;
      break;
    case 'array':
      if (!Array.isArray(value)) return false;
      if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) return false;
      if (rule.items && !value.every((v) => check(v, rule.items!))) return false;
      break;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined);
      if (rule.maxProperties !== undefined && keys.length > rule.maxProperties) return false;
      if (rule.required?.some((k) => !Object.hasOwn(record, k) || record[k] === undefined)) return false;
      for (const key of keys) {
        if (rule.propertyNames && !check(key, { type: 'string', ...rule.propertyNames })) return false;
        const child = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
        if (child ? !check(record[key], child) : rule.additionalProperties === false || typeof rule.additionalProperties === 'object' && !check(record[key], rule.additionalProperties)) return false;
      }
      break;
    }
  }
  return true;
}

function validateTelemetry(name: 'Trace' | 'Span' | 'CpuProfile' | 'OperationRollup' | 'MethodRollup' | 'MetricRollup' | 'InstanceHeartbeat', value: unknown): void {
  if (!check(value, definitions[name]!)) invalid();
}
