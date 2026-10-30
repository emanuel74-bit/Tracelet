import { hostname } from 'node:os';
import type { RedactionOptions, TraceletModuleOptions } from '../contracts/observe-contracts';

/**
 * Option defaults, environment overrides and range validation (plan 3.10, 12, 13).
 *
 * Import rule (eslint, plan 5): `config` may import only `contracts`. The dev/test rule of `shared/env.ts` is therefore
 * restated here against the `env` argument (pure function, no process access); a unit test keeps both copies identical.
 *
 * Invalid configuration THROWS a `TraceletConfigError` (the module turns it into "tracing disabled + diagnostic").
 * The error message names the option path and the allowed range. It never contains a configured string value; in
 * particular `storage.uri` (may carry credentials) is never echoed, logged or stored in the error.
 */

export type TraceletEnv = Readonly<Record<string, string | undefined>>;

export const MIB = 1024 * 1024;

export class TraceletConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid Tracelet configuration: ${issues.join('; ')}`);
    this.name = 'TraceletConfigError';
    this.issues = issues;
  }
}

type Resolved<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };

export interface ResolvedTraceletConfig {
  /** Final decision: TRACELET_DISABLED=1 > option > TRACELET_ENABLED > dev/test default. */
  enabled: boolean;
  /** Which rule decided `enabled` (diagnostics and health). */
  enabledSource: 'TRACELET_DISABLED' | 'option' | 'TRACELET_ENABLED' | 'default';
  /** NODE_ENV is exactly 'development' or 'test'. */
  devOrTest: boolean;
  serviceName: string;
  serviceVersion?: string;
  hostName: string;
  storage: { uri: string; database: string; collectionPrefix: string; maxPoolSize: number; serverSelectionTimeoutMS: number };
  tracing: {
    enabled: boolean;
    sampleRate: number;
    keepFailedRoots: boolean;
    maxRootsPerSecond: number;
    maxOpenTraces: number;
    maxSpansPerTrace: number;
    maxOpenSpans: number;
    maxTraceDurationMs: number;
    spanCollapse: { threshold: number; keepSlowest: number } | false;
    errorMessages: 'redacted' | 'omit';
    redaction: RedactionOptions;
  };
  profiling: Resolved<NonNullable<TraceletModuleOptions['profiling']>>;
  runtimeMetrics: Resolved<NonNullable<TraceletModuleOptions['runtimeMetrics']>>;
  buffer: Resolved<NonNullable<TraceletModuleOptions['buffer']>>;
  retention: Resolved<NonNullable<TraceletModuleOptions['retention']>>;
}

export function isDevOrTestEnv(env: TraceletEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Collector {
  readonly issues: string[] = [];
  add(msg: string): void {
    this.issues.push(msg);
  }
  /** Rejects unknown keys (typos silently ignored would leave a safety option at its default). */
  section(path: string, v: unknown, allowed: readonly string[]): Obj {
    if (v === undefined) return {};
    if (!isObj(v)) {
      this.add(`${path} must be an object`);
      return {};
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.add(`${path}.${k.slice(0, 40).replace(/[^\w.-]/g, '?')} is not a known option`);
    return v;
  }
  int(path: string, v: unknown, def: number, min: number, max: number): number {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
      this.add(`${path} must be an integer between ${min} and ${max}`);
      return def;
    }
    if (v < min || v > max) {
      this.add(`${path} must be between ${min} and ${max} (got ${v})`);
      return def;
    }
    return v;
  }
  num(path: string, v: unknown, def: number, min: number, max: number): number {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.add(`${path} must be a finite number between ${min} and ${max}`);
      return def;
    }
    if (v < min || v > max) {
      this.add(`${path} must be between ${min} and ${max} (got ${v})`);
      return def;
    }
    return v;
  }
  bool(path: string, v: unknown, def: boolean): boolean {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') {
      this.add(`${path} must be a boolean`);
      return def;
    }
    return v;
  }
  str(path: string, v: unknown, def: string, re: RegExp, what: string): string {
    if (v === undefined) return def;
    if (typeof v !== 'string' || !re.test(v)) {
      this.add(`${path} must be ${what}`);
      return def;
    }
    return v;
  }
}

const ENABLED_VALUES = (env: TraceletEnv): boolean | undefined => (env.TRACELET_ENABLED === 'true' ? true : env.TRACELET_ENABLED === 'false' ? false : undefined);

/** Mongo connection strings only; the value is never reflected into messages. */
const MONGO_URI = /^mongodb(\+srv)?:\/\/[^\s]+$/;

export function resolveOptions(user: TraceletModuleOptions, env: TraceletEnv = process.env): ResolvedTraceletConfig {
  const devOrTest = isDevOrTestEnv(env);
  const c = new Collector();
  const opts: Obj = isObj(user) ? user : {};
  if (!isObj(user)) c.add('options must be an object');

  // Kill switch: TRACELET_DISABLED=1 always wins and nothing else is validated (a host must be able to switch Tracelet
  // off without first fixing its configuration).
  if (env.TRACELET_DISABLED === '1') {
    return defaults(devOrTest, { enabled: false, enabledSource: 'TRACELET_DISABLED', serviceName: typeof opts.serviceName === 'string' ? opts.serviceName.slice(0, 128) : 'unknown' });
  }

  const top = c.section('options', opts, ['enabled', 'serviceName', 'serviceVersion', 'hostName', 'storage', 'tracing', 'profiling', 'runtimeMetrics', 'buffer', 'retention']);

  let enabled: boolean;
  let enabledSource: ResolvedTraceletConfig['enabledSource'];
  const envEnabled = ENABLED_VALUES(env);
  if (top.enabled !== undefined) {
    enabled = c.bool('enabled', top.enabled, false);
    enabledSource = 'option';
  } else if (envEnabled !== undefined) {
    enabled = envEnabled;
    enabledSource = 'TRACELET_ENABLED';
  } else {
    enabled = devOrTest;
    enabledSource = 'default';
  }

  const serviceName = c.str('serviceName', top.serviceName, '', /^[^\u0000-\u001f]{1,128}$/, 'a non-empty string of at most 128 characters');
  if (top.serviceName === undefined) c.add('serviceName is required');
  const serviceVersion = top.serviceVersion === undefined ? undefined : c.str('serviceVersion', top.serviceVersion, '', /^[^\u0000-\u001f]{1,64}$/, 'a string of 1 to 64 characters');
  const hostName = c.str('hostName', top.hostName, hostname(), /^[^\u0000-\u001f]{1,253}$/, 'a string of 1 to 253 characters');

  const st = c.section('storage', top.storage, ['uri', 'database', 'collectionPrefix', 'maxPoolSize', 'serverSelectionTimeoutMS']);
  if (top.storage === undefined) c.add('storage is required');
  let uri = '';
  if (st.uri === undefined || st.uri === '') {
    if (top.storage !== undefined) c.add('storage.uri is required');
  } else if (typeof st.uri !== 'string' || st.uri.length > 4096 || !MONGO_URI.test(st.uri)) {
    // Deliberately no value, no prefix, no length: the URI may contain credentials.
    c.add('storage.uri must be a mongodb:// or mongodb+srv:// connection string of at most 4096 characters (value not shown)');
  } else uri = st.uri;
  const storage = {
    uri,
    database: c.str('storage.database', st.database, 'observability', /^[A-Za-z0-9_-]{1,63}$/, '1 to 63 characters of A-Z a-z 0-9 _ -'),
    collectionPrefix: c.str('storage.collectionPrefix', st.collectionPrefix, 'tracelet_', /^[A-Za-z0-9_]{1,64}$/, '1 to 64 characters of A-Z a-z 0-9 _'),
    maxPoolSize: c.int('storage.maxPoolSize', st.maxPoolSize, 5, 1, 5),
    serverSelectionTimeoutMS: c.int('storage.serverSelectionTimeoutMS', st.serverSelectionTimeoutMS, 5000, 1, 30000),
  };

  const t = c.section('tracing', top.tracing, ['enabled', 'sampleRate', 'keepFailedRoots', 'maxRootsPerSecond', 'maxOpenTraces', 'maxSpansPerTrace', 'maxOpenSpans', 'maxTraceDurationMs', 'spanCollapse', 'errorMessages', 'redaction']);
  let spanCollapse: ResolvedTraceletConfig['tracing']['spanCollapse'] = { threshold: 20, keepSlowest: 3 };
  if (t.spanCollapse === false) spanCollapse = false;
  else if (t.spanCollapse !== undefined) {
    const sc = c.section('tracing.spanCollapse', t.spanCollapse, ['threshold', 'keepSlowest']);
    const threshold = c.int('tracing.spanCollapse.threshold', sc.threshold, 20, 2, 5000);
    spanCollapse = { threshold, keepSlowest: c.int('tracing.spanCollapse.keepSlowest', sc.keepSlowest, 3, 0, 100) };
  }
  let errorMessages: 'redacted' | 'omit' = devOrTest ? 'redacted' : 'omit';
  if (t.errorMessages !== undefined) {
    if (t.errorMessages === 'redacted' || t.errorMessages === 'omit') errorMessages = t.errorMessages;
    else c.add("tracing.errorMessages must be 'redacted' or 'omit'");
  }
  const redaction: RedactionOptions = {};
  if (t.redaction !== undefined) {
    const r = c.section('tracing.redaction', t.redaction, ['patterns', 'keys']);
    if (r.patterns !== undefined) {
      if (!Array.isArray(r.patterns) || r.patterns.length > 64 || !r.patterns.every(p => p instanceof RegExp)) c.add('tracing.redaction.patterns must be an array of at most 64 RegExp');
      else redaction.patterns = [...(r.patterns as RegExp[])];
    }
    if (r.keys !== undefined) {
      if (!Array.isArray(r.keys) || r.keys.length > 256 || !r.keys.every(k => typeof k === 'string' && k.length > 0 && k.length <= 128)) c.add('tracing.redaction.keys must be an array of at most 256 non-empty strings of at most 128 characters');
      else redaction.keys = [...(r.keys as string[])];
    }
  }
  const tracing: ResolvedTraceletConfig['tracing'] = {
    enabled: c.bool('tracing.enabled', t.enabled, true),
    sampleRate: c.num('tracing.sampleRate', t.sampleRate, devOrTest ? 1 : 0.05, 0, 1),
    keepFailedRoots: c.bool('tracing.keepFailedRoots', t.keepFailedRoots, true),
    maxRootsPerSecond: c.int('tracing.maxRootsPerSecond', t.maxRootsPerSecond, devOrTest ? 200 : 20, 0, 100_000),
    maxOpenTraces: c.int('tracing.maxOpenTraces', t.maxOpenTraces, 5000, 1, 1_000_000),
    maxSpansPerTrace: c.int('tracing.maxSpansPerTrace', t.maxSpansPerTrace, 2000, 1, 5000),
    maxOpenSpans: c.int('tracing.maxOpenSpans', t.maxOpenSpans, 50_000, 1, 5_000_000),
    maxTraceDurationMs: c.int('tracing.maxTraceDurationMs', t.maxTraceDurationMs, 300_000, 1000, 86_400_000),
    spanCollapse,
    errorMessages,
    redaction,
  };

  const p = c.section('profiling', top.profiling, ['enabled', 'sampleRateHz', 'windowMs', 'maxStacksPerProfile', 'maxProfileBytes', 'maxFramesPerStack', 'maxStallMs']);
  const profiling: ResolvedTraceletConfig['profiling'] = {
    enabled: c.bool('profiling.enabled', p.enabled, false),
    sampleRateHz: c.int('profiling.sampleRateHz', p.sampleRateHz, 99, 1, 1000),
    windowMs: c.int('profiling.windowMs', p.windowMs, 30_000, 5000, 120_000),
    maxStacksPerProfile: c.int('profiling.maxStacksPerProfile', p.maxStacksPerProfile, 2000, 1, 5000),
    maxProfileBytes: c.int('profiling.maxProfileBytes', p.maxProfileBytes, MIB, 4096, 16 * MIB),
    maxFramesPerStack: c.int('profiling.maxFramesPerStack', p.maxFramesPerStack, 128, 2, 1024),
    maxStallMs: c.int('profiling.maxStallMs', p.maxStallMs, 250, 0, 60_000),
  };

  const rm = c.section('runtimeMetrics', top.runtimeMetrics, ['enabled', 'intervalMs']);
  const runtimeMetrics: ResolvedTraceletConfig['runtimeMetrics'] = {
    enabled: c.bool('runtimeMetrics.enabled', rm.enabled, true),
    intervalMs: c.int('runtimeMetrics.intervalMs', rm.intervalMs, 30_000, 10_000, 3_600_000),
  };

  const b = c.section('buffer', top.buffer, ['maxQueuedTraces', 'maxQueuedBytes', 'maxQueuedProfiles', 'maxQueuedControlItems', 'maxQueuedControlBytes', 'flushIntervalMs', 'batchSize', 'maxBatchBytes', 'maxWriteDocsPerSecond', 'maxRetries', 'shutdownFlushTimeoutMs']);
  const buffer: ResolvedTraceletConfig['buffer'] = {
    maxQueuedTraces: c.int('buffer.maxQueuedTraces', b.maxQueuedTraces, 2000, 1, 100_000),
    maxQueuedBytes: c.int('buffer.maxQueuedBytes', b.maxQueuedBytes, 16 * MIB, 64 * 1024, 512 * MIB),
    maxQueuedProfiles: c.int('buffer.maxQueuedProfiles', b.maxQueuedProfiles, 10, 1, 1000),
    maxQueuedControlItems: c.int('buffer.maxQueuedControlItems', b.maxQueuedControlItems, 64, 1, 10_000),
    maxQueuedControlBytes: c.int('buffer.maxQueuedControlBytes', b.maxQueuedControlBytes, 4 * MIB, 2 * MIB, 256 * MIB),
    flushIntervalMs: c.int('buffer.flushIntervalMs', b.flushIntervalMs, 1000, 100, 60_000),
    batchSize: c.int('buffer.batchSize', b.batchSize, 200, 1, 5000),
    maxBatchBytes: c.int('buffer.maxBatchBytes', b.maxBatchBytes, 4 * MIB, 64 * 1024, 64 * MIB),
    maxWriteDocsPerSecond: c.int('buffer.maxWriteDocsPerSecond', b.maxWriteDocsPerSecond, 2000, 1, 100_000),
    maxRetries: c.int('buffer.maxRetries', b.maxRetries, 3, 0, 20),
    shutdownFlushTimeoutMs: c.int('buffer.shutdownFlushTimeoutMs', b.shutdownFlushTimeoutMs, 5000, 0, 60_000),
  };

  const r = c.section('retention', top.retention, ['tracesHours', 'profilesHours', 'rollupsDays', 'instancesHours']);
  const retention: ResolvedTraceletConfig['retention'] = {
    tracesHours: c.int('retention.tracesHours', r.tracesHours, 72, 1, 8760),
    profilesHours: c.int('retention.profilesHours', r.profilesHours, 72, 1, 8760),
    rollupsDays: c.int('retention.rollupsDays', r.rollupsDays, 14, 1, 365),
    instancesHours: c.int('retention.instancesHours', r.instancesHours, 24, 1, 8760),
  };

  if (c.issues.length > 0) throw new TraceletConfigError(c.issues);

  return { enabled, enabledSource, devOrTest, serviceName, ...(serviceVersion !== undefined ? { serviceVersion } : {}), hostName, storage, tracing, profiling, runtimeMetrics, buffer, retention };
}

/** Fully defaulted, disabled configuration used by the TRACELET_DISABLED kill switch (nothing user-supplied is validated or used). */
function defaults(devOrTest: boolean, base: { enabled: false; enabledSource: 'TRACELET_DISABLED'; serviceName: string }): ResolvedTraceletConfig {
  return {
    ...base,
    devOrTest,
    hostName: hostname(),
    storage: { uri: '', database: 'observability', collectionPrefix: 'tracelet_', maxPoolSize: 5, serverSelectionTimeoutMS: 5000 },
    tracing: {
      enabled: false,
      sampleRate: devOrTest ? 1 : 0.05,
      keepFailedRoots: true,
      maxRootsPerSecond: devOrTest ? 200 : 20,
      maxOpenTraces: 5000,
      maxSpansPerTrace: 2000,
      maxOpenSpans: 50_000,
      maxTraceDurationMs: 300_000,
      spanCollapse: { threshold: 20, keepSlowest: 3 },
      errorMessages: devOrTest ? 'redacted' : 'omit',
      redaction: {},
    },
    profiling: { enabled: false, sampleRateHz: 99, windowMs: 30_000, maxStacksPerProfile: 2000, maxProfileBytes: MIB, maxFramesPerStack: 128, maxStallMs: 250 },
    runtimeMetrics: { enabled: false, intervalMs: 30_000 },
    buffer: { maxQueuedTraces: 2000, maxQueuedBytes: 16 * MIB, maxQueuedProfiles: 10, maxQueuedControlItems: 64, maxQueuedControlBytes: 4 * MIB, flushIntervalMs: 1000, batchSize: 200, maxBatchBytes: 4 * MIB, maxWriteDocsPerSecond: 2000, maxRetries: 3, shutdownFlushTimeoutMs: 5000 },
    retention: { tracesHours: 72, profilesHours: 72, rollupsDays: 14, instancesHours: 24 },
  };
}
