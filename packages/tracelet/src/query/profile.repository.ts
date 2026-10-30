import { QueryRepository, TraceQuery, invalid, HOUR, ID, iso, PROFILE, projection, dto } from './base.repository';
import type { Flamegraph, ProfileSummaryPage, TimeWindow } from '../contracts/observe-contracts';

export class ProfileRepository extends QueryRepository {
  async profiles(q: TraceQuery): Promise<ProfileSummaryPage> {
    this.validate(q, ['service', 'instanceId', 'from', 'to', 'limit', 'cursor']); const { w, c } = this.page(q, 'profiles'); const limit = this.limit(q); const filter = this.filter(q, w, 'periodStart');
    if (c) filter.$or = [{ periodStart: { $lt: new Date(c.s) } }, { periodStart: new Date(c.s), _id: { $lt: c.t } }];
    const rows = await this.find(this.collections.profiles, filter, PROFILE, { periodStart: -1, _id: -1 }, limit + 1); const items = rows.slice(0, limit).map(r => dto<ProfileSummaryPage['items'][number]>(r, PROFILE)); const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? this.encode(this.resolved(q, w), 'profiles', Date.parse(last.periodStart), last.profileId) : null };
  }
  private merge(rows: Record<string, unknown>[], w: TimeWindow, truncated: boolean): Flamegraph {
    const map = new Map<string, number>(); let dropped = 0; let count = 0; let idle = 0;
    for (const r of rows) { count += Number(r.sampleCount); idle += Number(r.idleSampleCount ?? 0); dropped += Number(r.droppedSampleCount ?? 0); for (const s of r.stacks as Array<{ stack: string; samples: number }>) map.set(s.stack, (map.get(s.stack) ?? 0) + s.samples); }
    const stacks = [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [, samples] of stacks.slice(5000)) dropped += samples;
    const rates = new Set(rows.map(r => Number(r.sampleRateHz)));
    return { semantics: 'cpu-samples', window: w, instanceIds: [...new Set(rows.map(r => String(r.instanceId)))].sort(), profileCount: rows.length, ...(rates.size === 1 ? { sampleRateHz: [...rates][0] } : {}), sampleCount: count, idleSampleCount: idle, droppedSampleCount: dropped, truncated: truncated || stacks.length > 5000, stacks: stacks.slice(0, 5000).map(([stack, samples]) => ({ stack, samples })) };
  }
  async flamegraph(id: string): Promise<Flamegraph | null> {
    if (!ID.test(id)) invalid(); await this.skipped(this.collections.profiles, { _id: id }); const row = await this.collections.profiles.findOne({ _id: id, schemaVersion: 1 }, { projection: projection([...PROFILE, 'stacks']), maxTimeMS: 5000 });
    return row ? this.merge([row], { from: iso(row.periodStart), to: iso(row.periodEnd) }, false) : null;
  }
  async mergedFlamegraph(q: TraceQuery): Promise<Flamegraph> {
    this.validate(q, ['service', 'instanceId', 'from', 'to']); const w = this.window(q, 6 * HOUR);
    return this.expensive(async () => { const rows = await this.find(this.collections.profiles, this.filter(q, w, 'periodStart'), [...PROFILE, 'stacks'], { periodStart: -1, _id: -1 }, 121); return this.merge(rows.slice(0, 120), w, rows.length > 120); });
  }
}
