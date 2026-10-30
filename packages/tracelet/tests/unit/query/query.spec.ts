import { describe, expect, it, vi } from 'vitest';
import type { MongoCollection, TelemetryCollections } from '../../../src/storage/collections';
import { QueryService } from '../../../src/api/routes';
import { createQueryApiHandler } from '../../../src/api/query-api.handler';
import { projectDto } from '../../../src/query/filters';
import type { TraceletHttpRequest } from '../../../src/contracts/tracelet-internal-contracts';

function fixtures(rows: Record<string, unknown>[] = []) {
  const cursor = () => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue(rows) });
  const c = { find: vi.fn(cursor), findOne: vi.fn().mockResolvedValue(rows[0] ?? null), aggregate: vi.fn(() => ({ ...cursor(), toArray: vi.fn().mockResolvedValue([{ count: 2 }]) })) } as unknown as MongoCollection;
  return { c, collections: { traces: c, spans: c, profiles: c, operations: c, methods: c, metrics: c, instances: c } satisfies TelemetryCollections };
}
const request = (path: string, query: Record<string, string> = {}, method = 'GET'): TraceletHttpRequest => ({ path, query, method, headers: {} });
const trace = (id: string) => ({ schemaVersion: 1, traceId: id, operation: 'job', startedAt: new Date('2026-10-30T00:30:00Z'), error: { name: 'Error', message: 'safe', payload: { password: 'secret' } } });

describe('query response boundaries', () => {
  it('strips own prototype-named unknown fields at every DTO level', () => {
    const source = JSON.parse('{"constructor":"secret","__proto__":"secret","error":{"name":"Error","constructor":"secret","toString":"secret","__proto__":"secret"}}');
    const result = projectDto<Record<string, unknown>>(source, 'Trace');
    expect(result).toEqual({ error: { name: 'Error' } });
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(Object.hasOwn(result.error as object, 'constructor')).toBe(false);
  });
  it('rejects calendar-invalid query bounds before accessing storage', async () => {
    const { c, collections } = fixtures();
    const handler = createQueryApiHandler(new QueryService(collections), { authorize: () => true });
    const result = await handler(request('/api/v1/traces', { from: '2026-02-30T00:00:00Z', to: '2026-03-03T00:00:00Z' }));
    expect(result.status).toBe(400);
    expect(c.find).not.toHaveBeenCalled();
    expect(c.aggregate).not.toHaveBeenCalled();
  });
  it('strips unknown nested trace, span, heartbeat and health fields', () => {
    expect(projectDto<any>(trace('a'), 'Trace').error).toEqual({ name: 'Error', message: 'safe' });
    expect(projectDto<any>({ sanitizedError: trace('a').error }, 'Span').sanitizedError).toEqual({ name: 'Error', message: 'safe' });
    const h = projectDto<any>({ versions: { node: '22', tracelet: '1', secret: 'secret' }, tracing: { enabled: true, sampleRate: 1, secret: 'secret' }, profiler: { state: 'running', secret: 'secret' }, buffer: { queueDepth: 1, secret: 'secret' }, storage: { connected: true, secret: 'secret' } }, 'InstanceHeartbeat');
    expect(JSON.stringify(h)).not.toContain('secret');
    expect(projectDto<any>({ servedBy: { instanceId: 'a', serviceName: 'b', mongoConnected: true, secret: 'secret' }, items: [] }, 'Health').servedBy).not.toHaveProperty('secret');
  });
  it('denies HEAD without a body or storage access', async () => {
    const { c, collections } = fixtures();
    const result = await createQueryApiHandler(new QueryService(collections))(request('/api/v1/traces', {}, 'HEAD'));
    expect(result.status).toBe(403); expect(result.body).toBe(''); expect(c.find).not.toHaveBeenCalled(); expect(c.aggregate).not.toHaveBeenCalled();
  });
  it('reports newer versions from the same bounded filter and strips nested fields', async () => {
    const { c, collections } = fixtures([trace('a')]);
    const result = await createQueryApiHandler(new QueryService(collections), { authorize: () => true })(request('/api/v1/traces', { service: 'worker', from: '2026-10-30T00:00:00Z', to: '2026-10-30T01:00:00Z' }));
    expect(result.status).toBe(200); expect(result.headers['X-Tracelet-Skipped']).toBe('2'); expect(result.body).not.toContain('secret');
    expect(c.aggregate).toHaveBeenCalledWith(expect.arrayContaining([{ $match: { schemaVersion: { $gt: 1 }, serviceName: 'worker', startedAt: { $gte: new Date('2026-10-30T00:00:00Z'), $lt: new Date('2026-10-30T01:00:00Z') } } }]), { maxTimeMS: 5000 });
  });
  it('emits v2 and preserves implicit and explicit windows across clock advances', async () => {
    const { collections } = fixtures([trace('b'), trace('a')]); let now = Date.parse('2026-10-30T01:00:00Z'); const q = new QueryService(collections, { now: () => now });
    const explicit = { from: '2026-10-30T00:00:00Z', to: '2026-10-30T01:00:00Z', limit: '1' };
    const first = await q.traces(explicit); const implicit = await q.traces({ limit: '1' }); now += 60000;
    await expect(q.traces({ ...explicit, cursor: first.nextCursor! })).resolves.toHaveProperty('items');
    await expect(q.traces({ limit: '1', cursor: implicit.nextCursor! })).resolves.toHaveProperty('items');
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    expect(decoded).toMatchObject({ v: 2, from: Date.parse(explicit.from), to: Date.parse(explicit.to) });
    expect(Object.keys(decoded).sort()).toEqual(['f', 'from', 's', 't', 'to', 'v']);
  });
  it('escapes search literals and maps driver errors without exposing secrets', async () => {
    const { c, collections } = fixtures(); const q = new QueryService(collections); await q.traces({ search: 'a.*$' });
    expect(c.find).toHaveBeenCalledWith(expect.objectContaining({ operation: { $regex: '^a\\.\\*\\$' } }), expect.objectContaining({ maxTimeMS: 5000 }));
    vi.mocked(c.find).mockImplementation(() => { throw new Error('mongodb://password-secret'); });
    const r = await createQueryApiHandler(q, { authorize: () => true })(request('/api/v1/traces')); expect(r.status).toBe(503); expect(r.body).not.toContain('password-secret');
  });
  it.each(['profiles', 'errors'] as const)('binds %s pagination to the resolved window', async route => {
    const rows = route === 'profiles'
      ? ['b', 'a'].map(profileId => ({ schemaVersion: 1, profileId, periodStart: new Date('2026-10-30T00:30:00Z') }))
      : ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'].map(errorFingerprint => ({ ...trace(errorFingerprint), errorFingerprint, status: 'error' }));
    const { collections, c } = fixtures(rows); let now = Date.parse('2026-10-30T01:00:00Z'); const q = new QueryService(collections, { now: () => now });
    const explicit = { to: '2026-10-30T01:00:00Z', limit: '1' };
    const first = await q[route](explicit); const implicit = await q[route]({ limit: '1' }); now += 60000;
    expect(first.nextCursor).toBeTypeOf('string');
    await expect(q[route]({ ...explicit, cursor: first.nextCursor! })).resolves.toHaveProperty('items');
    await expect(q[route]({ limit: '1', cursor: implicit.nextCursor! })).resolves.toHaveProperty('items');
    expect(c.find).toHaveBeenLastCalledWith(expect.objectContaining({ [route === 'profiles' ? 'periodStart' : 'startedAt']: { $gte: new Date('2026-10-30T00:00:00Z'), $lt: new Date('2026-10-30T01:00:00Z') } }), expect.anything());
  });
  it.each(['traces', 'profiles', 'errors'] as const)('continues %s on another pod and validates cursor migration, bounds and filters before storage', async route => {
    const rows = route === 'profiles'
      ? ['profile-b', 'profile-a'].map(profileId => ({ schemaVersion: 1, profileId, periodStart: new Date('2026-10-30T00:30:00Z') }))
      : ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'].map(errorFingerprint => ({ ...trace(errorFingerprint), errorFingerprint, status: 'error' }));
    const { collections, c } = fixtures(rows);
    const firstPod = new QueryService(collections, { now: () => Date.parse('2026-10-30T01:00:00Z') });
    const secondPod = new QueryService(collections, { now: () => Date.parse('2026-11-02T01:00:00Z') });
    const page = await firstPod[route]({ limit: '1', service: 'worker' });
    const token = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const bounds = { from: new Date(token.from).toISOString(), to: new Date(token.to).toISOString() };
    for (const supplied of [{}, { from: bounds.from }, { to: bounds.to }, bounds]) {
      await expect(secondPod[route]({ ...supplied, cursor: page.nextCursor!, service: 'worker', limit: '2' })).resolves.toHaveProperty('items');
      expect(c.find).toHaveBeenLastCalledWith(expect.objectContaining({ [route === 'profiles' ? 'periodStart' : 'startedAt']: { $gte: new Date(bounds.from), $lt: new Date(bounds.to) } }), expect.anything());
    }
    const { from: _from, to: _to, ...legacy } = token;
    const v1 = encode({ ...legacy, v: 1 });
    const migrated = await secondPod[route]({ ...bounds, cursor: v1, service: 'worker', limit: '1' });
    // The fake repository returns both rows; traces/profiles therefore emit another page.
    if (route !== 'errors') expect(JSON.parse(Buffer.from(migrated.nextCursor!, 'base64url').toString()).v).toBe(2);
    const badQueries = [
      { cursor: v1 }, { cursor: v1, from: bounds.from }, { cursor: v1, to: bounds.to },
      { cursor: page.nextCursor!, from: '2026-10-29T23:59:59Z' },
      { cursor: page.nextCursor!, to: '2026-10-30T01:00:01Z' },
      { cursor: page.nextCursor!, service: 'other' },
      { cursor: page.nextCursor!, instanceId: 'other' },
      { cursor: encode({ ...token, v: 3 }) }, { cursor: encode({ ...token, secret: true }) },
      { cursor: encode({ ...token, from: token.to }) },
      { cursor: encode({ ...token, from: token.from + 0.5 }) },
      { cursor: encode({ ...token, to: Number.MAX_SAFE_INTEGER }) },
      { cursor: encode({ ...token, to: token.from + 8 * 86400000 }) },
      { cursor: encode({ ...token, from: String(token.from) }) },
      { cursor: encode({ ...token, f: 'bad' }) }, { cursor: 'a'.repeat(513) }, { cursor: 'not-json' },
    ];
    vi.mocked(c.find).mockClear(); vi.mocked(c.aggregate).mockClear();
    for (const bad of badQueries) await expect(secondPod[route]({ service: 'worker', ...bad })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(c.find).not.toHaveBeenCalled(); expect(c.aggregate).not.toHaveBeenCalled();
    if (route === 'traces') {
      await expect(secondPod.traces({ cursor: page.nextCursor!, service: 'worker', status: 'ok' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
      await expect(secondPod.traces({ cursor: page.nextCursor!, service: 'worker', search: 'job' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    const otherRoute = route === 'traces' ? 'profiles' : 'traces';
    await expect(secondPod[otherRoute]({ cursor: page.nextCursor!, service: 'worker' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
  it.each(['traces', 'profiles'] as const)('rejects unrepresentable %s timestamp seek keys before storage', async route => {
    const rows = route === 'profiles'
      ? ['profile-b', 'profile-a'].map(profileId => ({ schemaVersion: 1, profileId, periodStart: new Date('2026-10-30T00:30:00Z') }))
      : [trace('trace-0002'), trace('trace-0001')];
    const { collections, c } = fixtures(rows);
    const q = new QueryService(collections);
    const bounds = { from: '2026-10-30T00:00:00Z', to: '2026-10-30T01:00:00Z', limit: '1' };
    const page = await q[route](bounds);
    const token = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
    vi.mocked(c.find).mockClear(); vi.mocked(c.aggregate).mockClear();
    for (const s of [8640000000000001, -8640000000000001]) {
      const cursor = Buffer.from(JSON.stringify({ ...token, s })).toString('base64url');
      await expect(q[route]({ ...bounds, cursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    expect(c.find).not.toHaveBeenCalled(); expect(c.aggregate).not.toHaveBeenCalled();
  });
  it('caps merged profiles and stacks while preserving sample accounting', async () => {
    const rows = Array.from({ length: 121 }, (_, n) => ({
      profileId: `profile-${n}`, instanceId: `pod-${n % 2}`, periodStart: new Date('2026-10-30T00:00:00Z'),
      sampleCount: 5002, idleSampleCount: 3, droppedSampleCount: 1, sampleRateHz: 99,
      stacks: Array.from({ length: 5001 }, (_, s) => ({ stack: `frame-${s}`, samples: 1 })),
    }));
    const { collections } = fixtures(rows);
    const result = await new QueryService(collections).mergedFlamegraph({});
    expect(result.profileCount).toBe(120); expect(result.truncated).toBe(true);
    expect(result.stacks).toHaveLength(5000); expect(result.instanceIds).toEqual(['pod-0', 'pod-1']);
    expect(result.sampleCount).toBe(120 * 5002); expect(result.idleSampleCount).toBe(120 * 3);
    expect(result.droppedSampleCount).toBe(240);
    expect(result.stacks.reduce((n, s) => n + s.samples, 0) + result.droppedSampleCount).toBe(result.sampleCount);
    expect(result.semantics).toBe('cpu-samples');
  });
  it('rejects oversized per-route windows and filter changes without reading storage', async () => {
    const { collections, c } = fixtures([trace('trace-0002'), trace('trace-0001')]);
    const q = new QueryService(collections);
    const bounds = { from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' };
    const page = await q.traces({ ...bounds, limit: '1', service: 'a' });
    vi.mocked(c.find).mockClear();
    await expect(q.traces({ ...bounds, cursor: page.nextCursor!, service: 'b' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(q.mergedFlamegraph(bounds)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(q.errors({ ...bounds, from: '2026-10-28T23:59:59Z' })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(c.find).not.toHaveBeenCalled();
  });
});
