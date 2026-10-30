import { QueryRepository, TraceQuery, DAY, TRACE, dto } from './base.repository';
import type { ErrorGroup, ErrorGroupPage, ObserveTrace } from '../contracts/observe-contracts';

export class ErrorRepository extends QueryRepository {
  async errors(q: TraceQuery): Promise<ErrorGroupPage> {
    this.validate(q, ['service', 'instanceId', 'from', 'to', 'limit', 'cursor']); const { w, c } = this.page(q, 'errors', DAY); const limit = this.limit(q);
    return this.expensive(async () => {
      const rows = await this.find(this.collections.traces, { ...this.filter(q, w), status: 'error' }, TRACE, { startedAt: -1, _id: -1 }, 10001); const groups = new Map<string, ErrorGroup>();
      for (const r of rows.slice(0, 10000)) {
        const t = dto<ObserveTrace>(r, TRACE); if (!t.errorFingerprint || !t.error) continue;
        const old = groups.get(t.errorFingerprint);
        if (old) { old.count++; if (t.startedAt < old.firstSeenAt) old.firstSeenAt = t.startedAt; if (t.startedAt > old.lastSeenAt) { old.lastSeenAt = t.startedAt; old.sampleTraceId = t.traceId; } }
        else groups.set(t.errorFingerprint, { fingerprint: t.errorFingerprint, name: t.error.name, ...(t.error.message !== undefined ? { message: t.error.message } : {}), operation: t.operation, serviceName: t.serviceName, count: 1, firstSeenAt: t.startedAt, lastSeenAt: t.startedAt, sampleTraceId: t.traceId });
      }
      const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint)).filter(g => !c || g.count < c.s || (g.count === c.s && g.fingerprint > c.t)); const items = sorted.slice(0, limit); const last = items.at(-1);
      return { items, nextCursor: sorted.length > limit && last ? this.encode(this.resolved(q, w), 'errors', last.count, last.fingerprint) : null, scannedTraces: Math.min(rows.length, 10000), truncated: rows.length > 10000 };
    });
  }
}
