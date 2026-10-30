import { QueryRepository, TraceQuery, invalid, UUID7, ID, TRACE, SPAN, projection, dto } from './base.repository';
import type { ObserveSpan, ObserveTrace, Page } from '../contracts/observe-contracts';
import { escapeSearch } from './filters';

export class TraceRepository extends QueryRepository {
  async traces(q: TraceQuery): Promise<Page<ObserveTrace>> {
    this.validate(q, ['service', 'instanceId', 'status', 'kind', 'search', 'from', 'to', 'limit', 'cursor']);
    const w = this.window(q); const limit = this.limit(q); const filter = this.filter(q, w); const c = this.cursor(this.resolved(q, w), 'traces');
    if (q.status) filter.status = q.status; if (q.kind) filter.kind = q.kind;
    if (q.search) { if (UUID7.test(q.search)) filter._id = q.search; else filter.operation = { $regex: '^' + escapeSearch(q.search) }; }
    if (c) filter.$or = [{ startedAt: { $lt: new Date(c.s) } }, { startedAt: new Date(c.s), _id: { $lt: c.t } }];
    const rows = await this.find(this.collections.traces, filter, TRACE, { startedAt: -1, _id: -1 }, limit + 1); const items = rows.slice(0, limit).map(r => dto<ObserveTrace>(r, TRACE)); const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? this.encode(this.resolved(q, w), 'traces', Date.parse(last.startedAt), last.traceId) : null };
  }
  async trace(id: string): Promise<{ trace: ObserveTrace; spans: ObserveSpan[] } | null> {
    if (!ID.test(id) || id.length < 8) invalid();
    await this.skipped(this.collections.traces, { _id: id });
    const row = await this.collections.traces.findOne({ _id: id, schemaVersion: 1 }, { projection: projection(TRACE), maxTimeMS: 5000 }); if (!row) return null;
    const spans = await this.find(this.collections.spans, { traceId: id, schemaVersion: 1 }, SPAN, { startOffsetMs: 1, _id: 1 }, 5000);
    return { trace: dto<ObserveTrace>(row, TRACE), spans: spans.map(r => dto<ObserveSpan>(r, SPAN)) };
  }
}
