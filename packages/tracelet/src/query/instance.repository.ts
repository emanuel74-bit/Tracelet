import { projectDto } from './filters';
import { QueryRepository, HEARTBEAT, json, dto } from './base.repository';
import type { Health, InstanceHeartbeat, InstanceList, ServiceList } from '../contracts/observe-contracts';

export class InstanceRepository extends QueryRepository {
  async services(): Promise<ServiceList> {
    await this.skipped(this.collections.instances, {});
    const rows = await this.collections.instances.aggregate<Record<string, unknown>>([{ $match: { schemaVersion: 1 } }, { $group: { _id: '$serviceName', instanceCount: { $sum: 1 }, liveInstanceCount: { $sum: { $cond: [{ $gte: ['$lastSeenAt', new Date(this.now() - 90000)] }, 1, 0] } }, lastSeenAt: { $max: '$lastSeenAt' } } }, { $sort: { _id: 1 } }, { $limit: 500 }, { $project: { _id: 0, serviceName: '$_id', instanceCount: 1, liveInstanceCount: 1, lastSeenAt: 1 } }], { maxTimeMS: 5000 }).toArray();
    return json<ServiceList>({ items: rows });
  }
  async instances(service?: string): Promise<InstanceList> {
    const q = service === undefined ? {} : { service }; this.validate(q, ['service']);
    const rows = await this.find(this.collections.instances, this.filter(q), HEARTBEAT, { lastSeenAt: -1, _id: -1 }, 500);
    return { items: rows.map(row => { const h = dto<InstanceHeartbeat>(row, HEARTBEAT); return { instanceId: h.instanceId, serviceName: h.serviceName, ...(h.serviceVersion !== undefined ? { serviceVersion: h.serviceVersion } : {}), hostName: h.hostName, startedAt: h.startedAt, lastSeenAt: h.lastSeenAt, isLive: Date.parse(h.lastSeenAt) >= this.now() - 90000, profilerState: h.profiler.state }; }) };
  }
  async health(): Promise<Health> {
    const servedBy = projectDto<Health>( { servedBy: this.servedBy(), items: [] }, 'Health').servedBy;
    try { const rows = await this.find(this.collections.instances, { schemaVersion: 1 }, HEARTBEAT, { lastSeenAt: -1, _id: -1 }, 500); return { servedBy, items: rows.map(r => { const h = dto<InstanceHeartbeat>(r, HEARTBEAT); return { instance: h.instanceId, isLive: Date.parse(h.lastSeenAt) >= this.now() - 90000, heartbeat: h }; }) }; }
    catch { return { servedBy: { ...servedBy, mongoConnected: false }, items: [] }; }
  }
}
