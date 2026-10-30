import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { isDevOrTestEnv, resolveOptions, TraceletConfigError } from '../../../src/config/index.js';
import { isDevOrTest } from '../../../src/shared/env.js';
import type { TraceletModuleOptions } from '../../../src/contracts/index.js';

const URI = 'mongodb://tracelet_user:s3cr3t-Passw0rd@mongo.internal:27017/observability?authSource=admin';
const base = (over: Partial<TraceletModuleOptions> = {}): TraceletModuleOptions => ({ serviceName: 'orders', storage: { uri: URI }, ...over });
const PROD = {} as Record<string, string | undefined>;
const DEV = { NODE_ENV: 'development' };
const TEST = { NODE_ENV: 'test' };

function issues(opts: unknown, env: Record<string, string | undefined> = PROD): string[] {
  try {
    resolveOptions(opts as TraceletModuleOptions, env);
  } catch (e) {
    expect(e).toBeInstanceOf(TraceletConfigError);
    return [...(e as TraceletConfigError).issues];
  }
  throw new Error('expected resolveOptions to throw');
}

describe('config/options: defaults', () => {
  it('production defaults (NODE_ENV unset): frozen conservative values', () => {
    const c = resolveOptions(base(), PROD);
    expect(c.devOrTest).toBe(false);
    expect(c.enabled).toBe(false);
    expect(c.enabledSource).toBe('default');
    expect(c.tracing).toMatchObject({
      enabled: true, sampleRate: 0.05, keepFailedRoots: true, maxRootsPerSecond: 20, maxOpenTraces: 5000, maxSpansPerTrace: 2000,
      maxOpenSpans: 50_000, maxTraceDurationMs: 300_000, spanCollapse: { threshold: 20, keepSlowest: 3 }, errorMessages: 'omit',
    });
    expect(c.profiling).toEqual({ enabled: false, sampleRateHz: 99, windowMs: 30_000, maxStacksPerProfile: 2000, maxProfileBytes: 1024 * 1024, maxFramesPerStack: 128, maxStallMs: 250 });
    expect(c.runtimeMetrics).toEqual({ enabled: true, intervalMs: 30_000 });
    expect(c.buffer).toEqual({
      maxQueuedTraces: 2000, maxQueuedBytes: 16 * 1024 * 1024, maxQueuedProfiles: 10, maxQueuedControlItems: 64, maxQueuedControlBytes: 4 * 1024 * 1024,
      flushIntervalMs: 1000, batchSize: 200, maxBatchBytes: 4 * 1024 * 1024, maxWriteDocsPerSecond: 2000, maxRetries: 3, shutdownFlushTimeoutMs: 5000,
    });
    expect(c.retention).toEqual({ tracesHours: 72, profilesHours: 72, rollupsDays: 14, instancesHours: 24 });
    expect(c.storage).toEqual({ uri: URI, database: 'observability', collectionPrefix: 'tracelet_', maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
    expect(c.hostName).toBe(hostname());
    expect(c.serviceVersion).toBeUndefined();
  });

  it('dev and test defaults: enabled, sampleRate 1, 200 roots/s, redacted messages', () => {
    for (const env of [DEV, TEST]) {
      const c = resolveOptions(base(), env);
      expect(c.devOrTest).toBe(true);
      expect(c.enabled).toBe(true);
      expect(c.tracing).toMatchObject({ sampleRate: 1, maxRootsPerSecond: 200, errorMessages: 'redacted' });
      expect(c.profiling.enabled).toBe(false); // profiling stays opt-in everywhere
    }
  });

  it('only NODE_ENV development/test is non-production (unset, empty, staging, prod, Production, test ) and agrees with shared/env', () => {
    for (const v of [undefined, '', 'staging', 'prod', 'production', 'Production', 'TEST', ' test']) {
      const env = { NODE_ENV: v };
      expect(resolveOptions(base(), env).devOrTest).toBe(false);
      expect(isDevOrTestEnv(env)).toBe(false);
    }
    const prev = process.env.NODE_ENV;
    try {
      for (const v of [undefined, '', 'staging', 'development', 'test', 'production']) {
        if (v === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = v;
        expect(isDevOrTestEnv(process.env)).toBe(isDevOrTest());
      }
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('explicit values override defaults, including a production opt-in to redacted messages and sampleRate 0', () => {
    const c = resolveOptions(
      base({ serviceVersion: '1.2.3', hostName: 'pod-1', tracing: { sampleRate: 0, errorMessages: 'redacted', spanCollapse: false, maxRootsPerSecond: 0 }, profiling: { enabled: true, sampleRateHz: 50 } }),
      PROD,
    );
    expect(c).toMatchObject({ serviceVersion: '1.2.3', hostName: 'pod-1' });
    expect(c.tracing).toMatchObject({ sampleRate: 0, errorMessages: 'redacted', spanCollapse: false, maxRootsPerSecond: 0 });
    expect(c.profiling).toMatchObject({ enabled: true, sampleRateHz: 50, windowMs: 30_000 });
  });

  it('is assignable to the contract options type (the storage factory consumes it)', () => {
    const c = resolveOptions(base(), DEV);
    const asOptions: TraceletModuleOptions = c;
    expect(asOptions.serviceName).toBe('orders');
  });

  it('does not mutate or alias user input', () => {
    const patterns = [/secret/];
    const user = base({ tracing: { redaction: { patterns } } });
    const c = resolveOptions(user, DEV);
    expect(c.tracing.redaction.patterns).toEqual(patterns);
    expect(c.tracing.redaction.patterns).not.toBe(patterns);
    expect(Object.keys(user)).toEqual(['serviceName', 'storage', 'tracing']);
  });
});

describe('config/options: enable precedence (TRACELET_DISABLED > option > TRACELET_ENABLED > dev/test)', () => {
  it('TRACELET_DISABLED=1 beats everything, including enabled:true and TRACELET_ENABLED=true', () => {
    const c = resolveOptions(base({ enabled: true }), { ...DEV, TRACELET_DISABLED: '1', TRACELET_ENABLED: 'true' });
    expect(c.enabled).toBe(false);
    expect(c.enabledSource).toBe('TRACELET_DISABLED');
  });

  it('TRACELET_DISABLED only counts for the exact value 1', () => {
    for (const v of ['0', 'true', 'yes', '', '2']) {
      expect(resolveOptions(base({ enabled: true }), { TRACELET_DISABLED: v }).enabled).toBe(true);
    }
  });

  it('the kill switch does not validate (a host can disable Tracelet without fixing its config) and never keeps the URI', () => {
    const c = resolveOptions({ nonsense: true, storage: { uri: URI }, tracing: { sampleRate: 99 } } as unknown as TraceletModuleOptions, { TRACELET_DISABLED: '1' });
    expect(c.enabled).toBe(false);
    expect(JSON.stringify(c)).not.toContain('s3cr3t');
    expect(c.tracing.sampleRate).toBe(0.05);
  });

  it('option beats TRACELET_ENABLED, both directions', () => {
    expect(resolveOptions(base({ enabled: false }), { ...DEV, TRACELET_ENABLED: 'true' })).toMatchObject({ enabled: false, enabledSource: 'option' });
    expect(resolveOptions(base({ enabled: true }), { TRACELET_ENABLED: 'false' })).toMatchObject({ enabled: true, enabledSource: 'option' });
  });

  it('TRACELET_ENABLED beats the dev/test default, both directions; other values are ignored', () => {
    expect(resolveOptions(base(), { TRACELET_ENABLED: 'true' })).toMatchObject({ enabled: true, enabledSource: 'TRACELET_ENABLED' });
    expect(resolveOptions(base(), { ...DEV, TRACELET_ENABLED: 'false' })).toMatchObject({ enabled: false, enabledSource: 'TRACELET_ENABLED' });
    expect(resolveOptions(base(), { ...DEV, TRACELET_ENABLED: '1' })).toMatchObject({ enabled: true, enabledSource: 'default' });
    expect(resolveOptions(base(), { TRACELET_ENABLED: 'TRUE' })).toMatchObject({ enabled: false, enabledSource: 'default' });
  });
});

describe('config/options: every range bound', () => {
  type Case = [path: string, make: (v: unknown) => Partial<TraceletModuleOptions>, valid: unknown[], invalid: unknown[]];
  const MIB = 1024 * 1024;
  const cases: Case[] = [
    ['storage.maxPoolSize', v => ({ storage: { uri: URI, maxPoolSize: v as number } }), [1, 5], [0, 6, 1.5, NaN, '5']],
    ['storage.serverSelectionTimeoutMS', v => ({ storage: { uri: URI, serverSelectionTimeoutMS: v as number } }), [1, 30000], [0, 30001, Infinity]],
    ['tracing.sampleRate', v => ({ tracing: { sampleRate: v as number } }), [0, 0.5, 1], [-0.01, 1.01, NaN, Infinity, '0.5']],
    ['tracing.maxRootsPerSecond', v => ({ tracing: { maxRootsPerSecond: v as number } }), [0, 100_000], [-1, 100_001, 2.5]],
    ['tracing.maxOpenTraces', v => ({ tracing: { maxOpenTraces: v as number } }), [1, 1_000_000], [0, 1_000_001]],
    ['tracing.maxSpansPerTrace', v => ({ tracing: { maxSpansPerTrace: v as number } }), [1, 5000], [0, 5001]],
    ['tracing.maxOpenSpans', v => ({ tracing: { maxOpenSpans: v as number } }), [1, 5_000_000], [0, 5_000_001]],
    ['tracing.maxTraceDurationMs', v => ({ tracing: { maxTraceDurationMs: v as number } }), [1000, 86_400_000], [999, 86_400_001]],
    ['tracing.spanCollapse.threshold', v => ({ tracing: { spanCollapse: { threshold: v as number } } }), [2, 5000], [1, 5001]],
    ['tracing.spanCollapse.keepSlowest', v => ({ tracing: { spanCollapse: { keepSlowest: v as number } } }), [0, 100], [-1, 101]],
    ['profiling.sampleRateHz', v => ({ profiling: { sampleRateHz: v as number } }), [1, 1000], [0, 1001, NaN]],
    ['profiling.windowMs', v => ({ profiling: { windowMs: v as number } }), [5000, 120_000], [4999, 120_001]],
    ['profiling.maxStacksPerProfile', v => ({ profiling: { maxStacksPerProfile: v as number } }), [1, 5000], [0, 5001]],
    ['profiling.maxProfileBytes', v => ({ profiling: { maxProfileBytes: v as number } }), [4096, 16 * MIB], [4095, 16 * MIB + 1, 640]],
    ['profiling.maxFramesPerStack', v => ({ profiling: { maxFramesPerStack: v as number } }), [2, 1024], [1, 1025, 0]],
    ['profiling.maxStallMs', v => ({ profiling: { maxStallMs: v as number } }), [0, 60_000], [-1, 60_001]],
    ['runtimeMetrics.intervalMs', v => ({ runtimeMetrics: { intervalMs: v as number } }), [10_000, 3_600_000], [9999, 3_600_001, 0]],
    ['buffer.maxQueuedTraces', v => ({ buffer: { maxQueuedTraces: v as number } }), [1, 100_000], [0, 100_001]],
    ['buffer.maxQueuedBytes', v => ({ buffer: { maxQueuedBytes: v as number } }), [64 * 1024, 512 * MIB], [64 * 1024 - 1, 512 * MIB + 1]],
    ['buffer.maxQueuedProfiles', v => ({ buffer: { maxQueuedProfiles: v as number } }), [1, 1000], [0, 1001]],
    ['buffer.maxQueuedControlItems', v => ({ buffer: { maxQueuedControlItems: v as number } }), [1, 10_000], [0, 10_001]],
    ['buffer.maxQueuedControlBytes', v => ({ buffer: { maxQueuedControlBytes: v as number } }), [2 * MIB, 256 * MIB], [2 * MIB - 1, 256 * MIB + 1, 0]],
    ['buffer.flushIntervalMs', v => ({ buffer: { flushIntervalMs: v as number } }), [100, 60_000], [99, 60_001]],
    ['buffer.batchSize', v => ({ buffer: { batchSize: v as number } }), [1, 5000], [0, 5001]],
    ['buffer.maxBatchBytes', v => ({ buffer: { maxBatchBytes: v as number } }), [64 * 1024, 64 * MIB], [64 * 1024 - 1, 64 * MIB + 1]],
    ['buffer.maxWriteDocsPerSecond', v => ({ buffer: { maxWriteDocsPerSecond: v as number } }), [1, 100_000], [0, 100_001]],
    ['buffer.maxRetries', v => ({ buffer: { maxRetries: v as number } }), [0, 10], [-1, 11]],
    ['buffer.shutdownFlushTimeoutMs', v => ({ buffer: { shutdownFlushTimeoutMs: v as number } }), [1, 15_000], [0, 15_001]],
    ['retention.tracesHours', v => ({ retention: { tracesHours: v as number } }), [1, 8760], [0, 8761]],
    ['retention.profilesHours', v => ({ retention: { profilesHours: v as number } }), [1, 8760], [0, 8761]],
    ['retention.rollupsDays', v => ({ retention: { rollupsDays: v as number } }), [1, 365], [0, 366]],
    ['retention.instancesHours', v => ({ retention: { instancesHours: v as number } }), [1, 8760], [0, 8761]],
  ];

  for (const [path, make, valid, invalid] of cases) {
    it(`${path}: accepts ${JSON.stringify(valid)} and rejects ${invalid.map(String).join(', ')}`, () => {
      for (const v of valid) expect(() => resolveOptions(base(make(v)), PROD), `${path}=${String(v)}`).not.toThrow();
      for (const v of invalid) {
        const found = issues(base(make(v)));
        expect(found.length, `${path}=${String(v)}`).toBe(1);
        expect(found[0].startsWith(path)).toBe(true);
      }
    });
  }

  it('maxQueuedControlBytes below 2 MiB is rejected with an explicit message (plan 9 / Stage 03)', () => {
    expect(issues(base({ buffer: { maxQueuedControlBytes: 1024 * 1024 } }))[0]).toBe('buffer.maxQueuedControlBytes must be between 2097152 and 268435456 (got 1048576)');
  });

  it('runtimeMetrics.intervalMs below 10000 has an explicit message', () => {
    expect(issues(base({ runtimeMetrics: { intervalMs: 1000 } }))[0]).toBe('runtimeMetrics.intervalMs must be between 10000 and 3600000 (got 1000)');
  });

  it('collects ALL issues in one error and names the options', () => {
    let err: TraceletConfigError | undefined;
    try {
      resolveOptions(base({ tracing: { sampleRate: 2 }, profiling: { windowMs: 1 }, buffer: { maxQueuedControlBytes: 1 } }), PROD);
    } catch (e) {
      err = e as TraceletConfigError;
    }
    expect(err?.issues).toHaveLength(3);
    expect(err?.message).toMatch(/^Invalid Tracelet configuration: tracing\.sampleRate .*; profiling\.windowMs .*; buffer\.maxQueuedControlBytes /);
  });

  it('an invalid value falls back to the default internally but the call still throws (never a half-valid config)', () => {
    expect(() => resolveOptions(base({ tracing: { sampleRate: 7 } }), DEV)).toThrow(TraceletConfigError);
  });

  it('enum, boolean and structural errors', () => {
    expect(issues(base({ tracing: { errorMessages: 'full' as never } }))).toEqual(["tracing.errorMessages must be 'redacted' or 'omit'"]);
    expect(issues(base({ profiling: { enabled: 'yes' as never } }))).toEqual(['profiling.enabled must be a boolean']);
    expect(issues(base({ enabled: 1 as never }))).toEqual(['enabled must be a boolean']);
    expect(issues(base({ tracing: [] as never }))).toEqual(['tracing must be an object']);
    expect(issues(base({ tracing: { redaction: { patterns: ['x'] as never } } }))).toEqual(['tracing.redaction.patterns must be an array of at most 64 RegExp']);
    expect(issues(base({ tracing: { redaction: { keys: [''] } } }))[0]).toMatch(/^tracing\.redaction\.keys /);
    expect(issues(null)).toContain('options must be an object');
  });

  it('unknown options are rejected (a typo must not leave a safety option at its default); names are sanitised', () => {
    expect(issues(base({ tracing: { sampleRat: 1 } as never }))).toEqual(['tracing.sampleRat is not a known option']);
    expect(issues({ ...base(), bogus: 1 })).toEqual(['options.bogus is not a known option']);
    const weird = issues({ ...base(), ['x\n<script>']: 1 });
    expect(weird[0]).not.toMatch(/[\n<>]/);
  });

  it('serviceName, serviceVersion, hostName, database and prefix constraints', () => {
    expect(issues({ storage: { uri: URI } })).toEqual(['serviceName is required']);
    expect(issues(base({ serviceName: '' }))[0]).toMatch(/^serviceName must be/);
    expect(issues(base({ serviceName: 'x'.repeat(129) }))[0]).toMatch(/^serviceName must be/);
    expect(issues(base({ serviceVersion: 'v'.repeat(65) }))[0]).toMatch(/^serviceVersion /);
    expect(issues(base({ hostName: 'a\nb' }))[0]).toMatch(/^hostName /);
    expect(issues(base({ storage: { uri: URI, database: 'a/b' } }))[0]).toMatch(/^storage\.database /);
    expect(issues(base({ storage: { uri: URI, collectionPrefix: 'a-b' } }))[0]).toMatch(/^storage\.collectionPrefix /);
    expect(() => resolveOptions(base({ serviceName: 'x'.repeat(128) }), PROD)).not.toThrow();
  });
});

describe('config/options: storage.uri is never echoed (T16 style, with a password)', () => {
  const secret = 's3cr3t-Passw0rd';
  const render = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      const err = e as TraceletConfigError;
      return [err.message, err.stack ?? '', JSON.stringify(err.issues), JSON.stringify(err, Object.getOwnPropertyNames(err)), String(err)].join('\n');
    }
    throw new Error('expected a throw');
  };

  it('a non-mongo URI containing a password is reported without the value', () => {
    const bad = `postgres://admin:${secret}@db.internal/x`;
    const text = render(() => resolveOptions(base({ storage: { uri: bad } }), PROD));
    expect(text).toContain('storage.uri must be a mongodb://');
    for (const leak of [secret, 'admin', 'db.internal', 'postgres']) expect(text).not.toContain(leak);
  });

  it('a too-long mongo URI is rejected without echoing any part of it', () => {
    const bad = `mongodb://u:${secret}@h/${'a'.repeat(5000)}`;
    const text = render(() => resolveOptions(base({ storage: { uri: bad } }), PROD));
    expect(text).toContain('storage.uri');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('aaaaaaaa');
  });

  it('a URI with whitespace, a non-string URI and a missing/empty URI', () => {
    expect(render(() => resolveOptions(base({ storage: { uri: `mongodb://u:${secret}@h h` } }), PROD))).not.toContain(secret);
    expect(issues(base({ storage: { uri: 42 as never } }))[0]).toMatch(/^storage\.uri must be/);
    expect(issues(base({ storage: { uri: '' } }))).toEqual(['storage.uri is required']);
    expect(issues({ serviceName: 'x' })).toEqual(['storage is required']);
  });

  it('other validation failures in the same config do not leak the valid URI either', () => {
    const text = render(() => resolveOptions(base({ tracing: { sampleRate: 5 }, buffer: { batchSize: 0 } }), PROD));
    expect(text).not.toContain(secret);
    expect(text).not.toContain('mongo.internal');
  });

  it('mongodb+srv is accepted; the successful config keeps the URI only in storage.uri', () => {
    const c = resolveOptions(base({ storage: { uri: 'mongodb+srv://u:p@cluster.example.net/db' } }), PROD);
    expect(c.storage.uri).toContain('cluster.example.net');
    expect(JSON.stringify({ ...c, storage: { ...c.storage, uri: undefined } })).not.toContain('cluster.example.net');
  });
});
