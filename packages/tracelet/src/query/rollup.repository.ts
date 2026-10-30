import { QueryRepository, TraceQuery, iso, Stats, sumGroup, statsProject } from './base.repository';
import type { MethodStatsList, ObserveTrace, Overview } from '../contracts/observe-contracts';
import { percentile } from './percentiles';
import type { MongoCollection } from '../storage/collections';

export class RollupRepository extends QueryRepository {
  protected async aggregateStats(collection: MongoCollection, filter: Record<string, unknown>, id: unknown, tail: Record<string, unknown>[] = []) { await this.skipped(collection, filter); return collection.aggregate<Stats>([{ $match: filter }, { $group: sumGroup(id) }, { $project: statsProject() }, ...tail], { maxTimeMS: 5000 }).toArray(); }
  async overview(q: TraceQuery): Promise<Overview> {
    this.validate(q, ['service', 'instanceId', 'from', 'to']); const w = this.window(q); const filter = this.filter(q, w, 'bucketStart');
    return this.expensive(async () => {
      const [totals, series, operations] = await Promise.all([this.aggregateStats(this.collections.operations, filter, null), this.aggregateStats(this.collections.operations, filter, '$bucketStart', [{ $sort: { _id: 1 } }]), this.aggregateStats(this.collections.operations, filter, { operation: '$operation', kind: '$kind' }, [{ $sort: { durationSumMs: -1 } }, { $limit: 10 }])]);
      const total = totals[0]; const hist = total?.histogram ?? [];
      return { window: { ...w, bucketMs: 60000 }, totals: { executions: total?.count ?? 0, errors: total?.errorCount ?? 0, errorRate: total?.count ? total.errorCount / total.count : 0, p50Ms: percentile(hist, .5), p95Ms: percentile(hist, .95), percentileMethod: 'histogram-approx' }, series: series.map(r => ({ t: iso(r._id), executions: r.count, errors: r.errorCount, p95Ms: percentile(r.histogram, .95) })), slowestOperations: operations.map(r => { const id = r._id as { operation: string; kind: ObserveTrace['kind'] }; return { operation: id.operation, kind: id.kind, executions: r.count, errors: r.errorCount, avgMs: r.count ? r.durationSumMs / r.count : 0, p95Ms: percentile(r.histogram, .95), maxMs: r.durationMaxMs }; }), dataNotes: { executionsAreSampled: false, methodStatsAreSampled: true } };
    });
  }
  async methods(q: TraceQuery): Promise<MethodStatsList> {
    this.validate(q, ['service', 'instanceId', 'from', 'to', 'search']); const w = this.window(q);
    return this.expensive(async () => {
      const rows = await this.aggregateStats(this.collections.methods, this.filter(q, w, 'bucketStart'), { serviceName: '$serviceName', operation: '$operation', className: '$className', method: '$method' }, [{ $sort: { durationSumMs: -1 } }]);
      return { window: w, sampled: true, items: rows.filter(r => !q.search || String((r._id as Record<string, unknown>).operation).toLowerCase().includes(q.search.toLowerCase())).slice(0, 500).map(r => { const id = r._id as Record<string, string>; const selfCount = Number(r.selfCount); return { operation: id.operation!, ...(id.serviceName !== undefined ? { serviceName: id.serviceName } : {}), ...(id.className !== undefined ? { className: id.className } : {}), ...(id.method !== undefined ? { method: id.method } : {}), calls: r.count, errors: r.errorCount, avgMs: r.count ? r.durationSumMs / r.count : 0, p95Ms: percentile(r.histogram, .95), maxMs: r.durationMaxMs, ...(selfCount ? { selfAvgMs: Number(r.selfSumMs) / selfCount } : {}), selfSampleCount: selfCount }; }) };
    });
  }
}
