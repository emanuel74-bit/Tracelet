import { AsyncLocalStorage } from 'node:async_hooks';
import { projectDto, QueryError } from './filters';
import { fingerprint, decodeCursor, encodeCursor, invalidCursor } from './cursor';
import type { Cursor } from './cursor';
import { HISTOGRAM_BOUNDS_MS } from '../contracts/observe-contracts';
import type { MongoCollection, TelemetryCollections } from '../storage/collections';
import { isIsoDateTime } from '../storage/documents';
import type { Health, TimeWindow } from '../contracts/observe-contracts';
export type TraceQuery = Readonly<Record<string, string | undefined>>;
export interface QueryLimits { defaultLimit: number; maxLimit: number; maxWindowMs: number }
export interface QueryServiceOptions extends Partial<QueryLimits> { now?: () => number; servedBy?: () => Health['servedBy'] }
export { QueryError } from './filters';
export const invalid = (): never => { throw new QueryError('INVALID_QUERY', 400, 'Invalid query parameters'); };
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
export const keys = (value: Record<string, unknown>, fields: string[]): Record<string, unknown> => Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
export const TRACE = 'schemaVersion traceId serviceName serviceVersion instanceId operation kind startedAt durationMs status spanCount errorCount isComplete rootSpanId sampleRate detail droppedSpanCount unfinishedSpanCount attributes error errorFingerprint'.split(' ');
export const SPAN = 'spanId traceId parentSpanId operation origin className method startOffsetMs durationMs selfDurationMs status sanitizedError collapsedCount'.split(' ');
export const PROFILE = 'schemaVersion profileId serviceName serviceVersion instanceId periodStart periodEnd format sampleRateHz sampleCount durationMs idleSampleCount droppedStackCount droppedSampleCount gapBeforeMs'.split(' ');
export const HEARTBEAT = 'schemaVersion instanceId serviceName serviceVersion hostName pid bootId startedAt lastSeenAt versions tracing profiler buffer storage'.split(' ');
export const projection = (fields: string[]): Record<string, 0 | 1> => Object.fromEntries([['_id', 0], ...fields.map(k => [k, 1])]);
export const json = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
export const dto = <T>(row: Record<string, unknown>, fields: string[]): T => projectDto<T>(keys(row, fields), fields === TRACE ? 'Trace' : fields === SPAN ? 'Span' : fields === HEARTBEAT ? 'InstanceHeartbeat' : 'CpuProfileSummary');
export type Stats = Record<string, unknown> & { count: number; errorCount: number; durationSumMs: number; durationMaxMs: number; histogram: number[] };
export const sumGroup = (id: unknown): Record<string, unknown> => ({ _id: id, count: { $sum: '$count' }, errorCount: { $sum: '$errorCount' }, sampledCount: { $sum: '$sampledCount' }, durationSumMs: { $sum: '$durationSumMs' }, durationMaxMs: { $max: '$durationMaxMs' }, selfSumMs: { $sum: '$selfSumMs' }, selfCount: { $sum: '$selfCount' }, ...Object.fromEntries(HISTOGRAM_BOUNDS_MS.map((_, i) => [`h${i}`, { $sum: { $arrayElemAt: ['$histogram', i] } }])) });
export const statsProject = (): Record<string, unknown> => ({ _id: 1, count: 1, errorCount: 1, sampledCount: 1, durationSumMs: 1, durationMaxMs: 1, selfSumMs: 1, selfCount: 1, histogram: HISTOGRAM_BOUNDS_MS.map((_, i) => `$h${i}`) });

export interface QueryRuntime { diagnostics: AsyncLocalStorage<{ skipped: number; seen: Map<MongoCollection, Set<string>> }>; limiter?: { run<T>(fn: () => Promise<T>): Promise<T> }; heavy: number }
export const createQueryRuntime = (): QueryRuntime => ({ diagnostics: new AsyncLocalStorage(), heavy: 0 });
export class QueryRepository {
  protected readonly now: () => number;
  protected readonly servedBy: () => Health['servedBy'];

  constructor(protected readonly collections: TelemetryCollections, options: QueryServiceOptions = {}, protected readonly runtime: QueryRuntime = createQueryRuntime()) {
    this.now = options.now ?? Date.now;
    this.servedBy = options.servedBy ?? (() => ({ instanceId: 'unknown', serviceName: 'unknown', mongoConnected: false, schemaVersion: 1 }));
  }
  validate(q: TraceQuery, allowed: string[]): void {
    if (Object.keys(q).some(k => !allowed.includes(k))) invalid();
    if (q.service !== undefined && (!q.service.length || q.service.length > 128 || /[\u0000-\u001f]/.test(q.service))) invalid();
    if (q.instanceId !== undefined && !ID.test(q.instanceId)) invalid();
    if (q.search !== undefined && (q.search.length < 1 || q.search.length > 128)) invalid();
    if (q.status !== undefined && !['ok', 'error', 'incomplete'].includes(q.status)) invalid();
    if (q.kind !== undefined && !['http', 'rabbitmq', 'scheduled', 'event', 'custom'].includes(q.kind)) invalid();
  }
  protected window(q: TraceQuery, max = 7 * DAY): TimeWindow {
    const parse = (s: string): number => { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) || !isIsoDateTime(s)) invalid(); return Date.parse(s); };
    const end = q.to === undefined ? this.now() : parse(q.to); const start = q.from === undefined ? end - HOUR : parse(q.from);
    if (start >= end || end - start > max) invalid();
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  }
  protected limit(q: TraceQuery): number { if (q.limit === undefined) return 50; if (!/^[1-9]\d*$/.test(q.limit)) invalid(); const n = Number(q.limit); if (n > 100) invalid(); return n; }
  protected filter(q: TraceQuery, w?: TimeWindow, field = 'startedAt'): Record<string, unknown> {
    return { schemaVersion: 1, ...(q.service !== undefined ? { serviceName: q.service } : {}), ...(q.instanceId !== undefined ? { instanceId: q.instanceId } : {}), ...(w ? { [field]: { $gte: new Date(w.from), $lt: new Date(w.to) } } : {}) };
  }

  async withDiagnostics<T>(fn: () => Promise<T>): Promise<{ value: T; skipped: number }> {
    return this.runtime.diagnostics.run({ skipped: 0, seen: new Map() }, async () => { const value = await fn(); return { value, skipped: this.runtime.diagnostics.getStore()!.skipped }; });
  }
  protected fingerprint(route: string, q: TraceQuery): string { return fingerprint(route, q); }
  protected page(q: TraceQuery, route: string, max = 7 * DAY): { w: TimeWindow; c: Cursor | undefined } {
    const c = decodeCursor(q.cursor);
    if (!c) return { w: this.window(q, max), c };
    if (route !== 'errors' && Math.abs(c.s) > 8640000000000000) invalidCursor();
    if (c.v === 1 && (q.from === undefined || q.to === undefined)) invalidCursor();
    let w: TimeWindow;
    try {
      if (c.v === 2) {
        if (c.to - c.from > max) invalidCursor();
        // Each supplied bound must match independently; omitted bounds come only from the token.
        w = this.window({ from: q.from ?? new Date(c.from).toISOString(), to: q.to ?? new Date(c.to).toISOString() }, max);
        if (Date.parse(w.from) !== c.from || Date.parse(w.to) !== c.to) invalidCursor();
      } else w = this.window(q, max);
    } catch { return invalidCursor(); }
    if (c.f !== this.fingerprint(route, this.resolved(q, w))) invalidCursor();
    return { w, c };
  }
  protected encode(q: TraceQuery, route: string, s: number, t: string): string { return encodeCursor(s, t, this.fingerprint(route, q), Date.parse(q.from!), Date.parse(q.to!)); }
  protected resolved(q: TraceQuery, w: TimeWindow): TraceQuery { return { ...q, from: w.from, to: w.to }; }
  protected async skipped(collection: MongoCollection, filter: Record<string, unknown>): Promise<void> {
    const state = this.runtime.diagnostics.getStore(); if (!state) return;
    const newer = { ...filter, schemaVersion: { $gt: 1 } }; const key = JSON.stringify(newer);
    const seen = state.seen.get(collection) ?? new Set<string>(); if (seen.has(key)) return;
    seen.add(key); state.seen.set(collection, seen);
    const rows = await collection.aggregate<{ count: number }>([{ $match: newer }, { $count: 'count' }, { $project: { _id: 0, count: 1 } }], { maxTimeMS: 5000 }).toArray();
    state.skipped += Number(rows[0]?.count ?? 0);
  }
  protected async find(collection: MongoCollection, filter: Record<string, unknown>, fields: string[], sort: Record<string, 1 | -1>, limit: number) {
    await this.skipped(collection, filter);
    return collection.find(filter, { projection: projection(fields), maxTimeMS: 5000 }).sort(sort).limit(limit).toArray();
  }
  protected async expensive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.runtime.limiter) return this.runtime.limiter.run(fn);
    if (this.runtime.heavy >= 4) throw new QueryError('RATE_LIMITED', 429, 'Too many concurrent queries');
    this.runtime.heavy++; try { return await fn(); } finally { this.runtime.heavy--; }
  }
}

export type { TelemetryCollections } from '../storage/collections';
