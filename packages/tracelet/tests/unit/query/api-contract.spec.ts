import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import schema from '../../../src/contracts/telemetry.schema.json';
import fixtures from '../../../../../docs/embedded-observe-kit/resources/contracts/v1-fixtures/api-responses.json';
import { mapResponse } from '../../../src/api/dto-mappers';
import { createQueryApiHandler } from '../../../src/api/query-api.handler';
import { QueryService } from '../../../src/api/routes';
import { ConcurrencyLimiter } from '../../../src/api/concurrency-limiter';
import type { MongoCollection, TelemetryCollections } from '../../../src/storage/collections';

const paths: Record<string, string> = {
  TracePage: '/traces', TraceDetail: '/traces/trace-0001', ServiceList: '/services',
  InstanceList: '/instances', Overview: '/overview', MethodStatsList: '/methods',
  ProfileSummaryPage: '/profiles', Flamegraph: '/flamegraph', ErrorGroupPage: '/errors', Health: '/health',
};
const ajv = new Ajv2020({ strict: false });
addFormats(ajv); ajv.addSchema(schema);
const validate = (name: string, value: unknown) => {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
};
function service() {
  const c = {
    find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) })),
    findOne: vi.fn().mockResolvedValue(null),
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
  } as unknown as MongoCollection;
  const collections: TelemetryCollections = { traces: c, spans: c, profiles: c, operations: c, methods: c, metrics: c, instances: c };
  return { c, query: new QueryService(collections) };
}
describe('API schema and failure boundaries', () => {
  it.each(Object.entries(paths))('preserves the complete frozen %s DTO while removing unknown fields', (name, path) => {
    const source = (fixtures as Record<string, unknown>)[name];
    expect(source).toBeDefined();
    const projected = mapResponse({ ...source as object, injectedSecret: 'secret' }, path);
    expect(projected).toEqual(source);
    validate(name, projected);
  });
  it.each(Object.entries(paths).filter(([name]) => !['TraceDetail'].includes(name)))('returns schema-valid empty %s responses', async (name, path) => {
    const { query } = service();
    const result = await createQueryApiHandler(query, { authorize: () => true })({ path: `/api/v1${path}`, method: 'GET', query: {}, headers: {} });
    expect(result.status).toBe(200);
    validate(name, JSON.parse(String(result.body)));
  });
  it.each([undefined, () => false, () => { throw new Error('secret'); }])('denies before any Mongo access', async authorize => {
    const { query, c } = service();
    const result = await createQueryApiHandler(query, { authorize })({ path: '/api/v1/traces', method: 'GET', query: {}, headers: {} });
    expect(result.status).toBe(403); validate('ErrorEnvelope', JSON.parse(String(result.body)));
    expect(c.find).not.toHaveBeenCalled(); expect(c.aggregate).not.toHaveBeenCalled();
  });
  it('rejects unknown parameters, invalid limits and oversized service names before reads', async () => {
    const { query, c } = service();
    const handler = createQueryApiHandler(query, { authorize: () => true });
    for (const params of [{ unknown: '1' }, { limit: '101' }, { limit: '1.5' }, { service: 's'.repeat(129) }]) {
      const result = await handler({ path: '/api/v1/traces', method: 'GET', query: params, headers: {} });
      expect(result.status).toBe(400);
    }
    expect(c.find).not.toHaveBeenCalled(); expect(c.aggregate).not.toHaveBeenCalled();
  });
  it('maps driver timeout safely, and HEAD has identical headers without a body', async () => {
    const { query, c } = service();
    vi.mocked(c.aggregate).mockImplementation(() => { throw Object.assign(new Error('mongodb://secret'), { code: 50 }); });
    const handler = createQueryApiHandler(query, { authorize: () => true });
    const request = { path: '/api/v1/traces', method: 'GET', query: {}, headers: {} };
    const get = await handler(request); const head = await handler({ ...request, method: 'HEAD' });
    expect(get.status).toBe(503); expect(JSON.parse(String(get.body)).error.code).toBe('QUERY_TIMEOUT');
    expect(get.body).not.toContain('secret'); expect(head.status).toBe(get.status); expect(head.headers).toEqual(get.headers); expect(head.body).toBe('');
  });
  it('enforces the opaque TraceId length without requiring a UUID', async () => {
    const { query, c } = service();
    const handler = createQueryApiHandler(query, { authorize: () => true });
    const request = { method: 'GET', query: {}, headers: {} };
    expect((await handler({ ...request, path: '/api/v1/traces/short' })).status).toBe(400);
    expect(c.findOne).not.toHaveBeenCalled();
    expect((await handler({ ...request, path: '/api/v1/traces/trace-0001' })).status).toBe(404);
    expect(c.findOne).toHaveBeenCalled();
  });
  it('refuses a fifth expensive query and releases its slot after rejection', async () => {
    const limiter = new ConcurrencyLimiter();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: 4 }, () => limiter.run(() => pending));
    await expect(limiter.run(async () => undefined)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    release(); await Promise.all(held);
    await expect(limiter.run(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    await expect(limiter.run(async () => 'available')).resolves.toBe('available');
  });
});
