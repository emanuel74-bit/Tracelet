/**
 * Tracelet frozen v1 contracts (schemaVersion 1, CONTRACT_VERSION 1.0.0).
 * STATUS: FROZEN v1 candidate - pending independent review (see artifacts/01_CONTRACT_FREEZE.md).
 *
 * These are Tracelet's own interfaces. They are NOT upstream @nestjs/observe APIs.
 * Single source of truth for shapes: telemetry.schema.json ($defs). This file mirrors it for
 * TypeScript consumers; artifacts/01_CONTRACT_FREEZE.md section 9 lists the parity checks.
 * Changes only through the change-request protocol (artifacts/01_IMPLEMENTATION_PLAN.md section 19).
 *
 * Optional fields marked "v1 producer always emits" are optional only so that proposal-era
 * fixtures and older readers stay valid; a v1 writer MUST emit them.
 */

export const CONTRACT_VERSION = '1.0.0' as const;
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* 1. Telemetry DTOs (API/wire JSON: dates are ISO 8601 UTC strings)   */
/* ------------------------------------------------------------------ */

export type ExecutionKind = 'http' | 'rabbitmq' | 'scheduled' | 'event' | 'custom';
export type ExecutionStatus = 'ok' | 'error' | 'incomplete';
export type SpanOrigin = 'root' | 'auto' | 'manual';
export type TraceDetailLevel = 'full' | 'rootOnly';
export type ProfilerState = 'starting' | 'running' | 'backoff' | 'disabled' | 'unavailable' | 'stopped' | 'error';
export type IsoDateTime = string;
export type AttributeValue = string | number | boolean;
/** At most 16 keys matching /^[A-Za-z0-9_.-]{1,64}$/, string values at most 256 chars. */
export type Attributes = Record<string, AttributeValue>;

export interface SanitizedError {
  /** Error constructor name, at most 128 chars. */
  name: string;
  /** Redacted and truncated (<= 1024 chars). Absent when errorMessages = 'omit'. */
  message?: string;
  /** At most 20 redacted "at ..." frame lines, paths relative to cwd, <= 256 chars each. No message line. */
  stack?: string[];
}

export interface ObserveTrace {
  schemaVersion: 1;
  traceId: string;
  serviceName: string;
  serviceVersion?: string;
  instanceId: string;
  /** Root name passed to trace(); equals the root span's operation. */
  operation: string;
  kind: ExecutionKind;
  startedAt: IsoDateTime;
  /** Equals the root span's durationMs (monotonic clock). */
  durationMs: number;
  /** 'error' if the root threw/rejected; 'incomplete' if force-closed (timeout/shutdown). */
  status: ExecutionStatus;
  /** Number of span records stored for this trace (a collapsed span counts as 1). */
  spanCount: number;
  /** Number of error-origin spans (spans carrying sanitizedError). */
  errorCount: number;
  /** false when the root was force-closed or unfinished spans were left out. */
  isComplete: boolean;
  /** v1 producer always emits. */
  rootSpanId?: string;
  /** Head-sampling probability in effect for this root. v1 producer always emits. */
  sampleRate?: number;
  /** 'rootOnly' = sampled-out root kept only because it failed. Absent means 'full'. v1 producer always emits. */
  detail?: TraceDetailLevel;
  /** Spans refused by maxSpansPerTrace. Absent means 0. v1 producer always emits. */
  droppedSpanCount?: number;
  /** Spans still open 1000 ms after the root settled, left out with their subtrees. Absent means 0. v1 producer always emits. */
  unfinishedSpanCount?: number;
  /** User-supplied, bounded and redacted labels (TraceOptions.attributes). */
  attributes?: Attributes;
  /** The error that escaped the root, when status = 'error'. */
  error?: SanitizedError;
  /** 16 lowercase hex chars; present iff error is present. */
  errorFingerprint?: string;
}

export interface ObserveSpan {
  spanId: string;
  traceId: string;
  /** null only for the root span; exactly one root span per trace. */
  parentSpanId: string | null;
  /** Root: trace operation. Auto: `${className}.${method}`. Manual (joined nested trace()): its name. */
  operation: string;
  /** Absent means parentSpanId === null ? 'root' : 'auto'. v1 producer always emits. */
  origin?: SpanOrigin;
  className?: string;
  method?: string;
  /** Relative to trace start, monotonic clock. Root span = 0. */
  startOffsetMs: number;
  durationMs: number;
  /** Exclusive time = durationMs minus the union of child intervals clipped to this span.
   *  Omitted when not computable (a child without an offset, or a child left out as unfinished). */
  selfDurationMs?: number;
  status: ExecutionStatus;
  /** Present only on the span where an error originated (first span to end with that error value). */
  sanitizedError?: SanitizedError;
  /** Present when >= 2 repeated sibling calls were collapsed into this record. durationMs and
   *  selfDurationMs are then sums; startOffsetMs is the earliest call's. */
  collapsedCount?: number;
}

export interface ProfileStack {
  /** Root-first frames joined by ';'. Frame = "fn relpath:line" or "fn" for native/internal.
   *  ';' inside a frame is replaced by ','. Deep stacks keep the 127 leaf-most frames behind a "(truncated)" root frame. */
  stack: string;
  samples: number;
}

export interface CpuProfileSummary {
  schemaVersion: 1;
  profileId: string;
  serviceName: string;
  serviceVersion?: string;
  instanceId: string;
  periodStart: IsoDateTime;
  periodEnd: IsoDateTime;
  format: 'folded-stacks';
  sampleRateHz: number;
  /** Non-idle samples in the window = sum(stacks[].samples) + droppedSampleCount. */
  sampleCount: number;
  /** V8 profile endTime - startTime. v1 producer always emits. NOT a coverage measure: V8 stamps startTime before the
   *  Profiler.start stall, so the first ~10-120 ms of the window can hold no samples. Use sample timestamps for coverage. */
  durationMs?: number;
  /** "(idle)" samples (not in stacks). v1 producer always emits. */
  idleSampleCount?: number;
  /** Distinct stacks removed by the maxStacksPerProfile cap. v1 producer always emits. */
  droppedStackCount?: number;
  /** Samples belonging to dropped stacks. v1 producer always emits. */
  droppedSampleCount?: number;
  /** Unsampled gap before this window on this instance, measured from SAMPLES (continuity evidence):
   *  firstSampleTime(this window) - lastSampleTime(previous window), where a sample's time is
   *  profile.startTime + cumulative timeDeltas (µs, V8 monotonic clock of the one persistent session), / 1000.
   *  Absent for the first window after (re)start or backoff. Never derived from startTime/endTime. */
  gapBeforeMs?: number;
}

export interface CpuProfile extends CpuProfileSummary {
  stacks: ProfileStack[];
}

/** Fixed bucket upper bounds (ms, inclusive). histogram[i] counts durations <= HISTOGRAM_BOUNDS_MS[i] and > the previous bound. */
export const HISTOGRAM_BOUNDS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, Number.POSITIVE_INFINITY] as const;
export type Histogram = number[]; // length 16

/** Every settled root (sampled or not) on one instance, per operation, per minute. */
export interface OperationRollup {
  schemaVersion: 1;
  serviceName: string;
  instanceId: string;
  bucketStart: IsoDateTime;
  bucketMs: 60000;
  operation: string;
  kind: ExecutionKind;
  count: number;
  errorCount: number;
  sampledCount: number;
  durationSumMs: number;
  durationMaxMs: number;
  histogram: Histogram;
}

/** Auto/manual spans of SAMPLED traces only, per class.method, per minute. */
export interface MethodRollup {
  schemaVersion: 1;
  serviceName: string;
  instanceId: string;
  bucketStart: IsoDateTime;
  bucketMs: 60000;
  className?: string;
  method?: string;
  operation: string;
  count: number;
  errorCount: number;
  durationSumMs: number;
  durationMaxMs: number;
  selfSumMs: number;
  /** Spans whose selfDurationMs was computable. */
  selfCount: number;
  histogram: Histogram;
}

/** spansDropped includes spans refused by maxSpansPerTrace and by the global maxOpenSpans budget.
 *  rollupsDropped includes rollup and metric items dropped from the control pool or by storage. */
export interface TelemetryCounters {
  rootsStarted: number;
  rootsSampledOut: number;
  tracesDroppedAdmission: number;
  tracesDroppedQueueFull: number;
  tracesDroppedStorage: number;
  spansDropped: number;
  profilesDropped: number;
  rollupsDropped: number;
}

/** Runtime gauges + telemetry counters for one instance and interval (deltas within the interval). */
export interface MetricRollup {
  schemaVersion: 1;
  serviceName: string;
  instanceId: string;
  intervalStart: IsoDateTime;
  intervalEnd: IsoDateTime;
  cpuFraction: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes?: number;
  eventLoopDelayP50Ms: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization: number;
  gcCount: number;
  gcDurationMs: number;
  telemetry: TelemetryCounters;
}

export interface InstanceHeartbeat {
  schemaVersion: 1;
  instanceId: string;
  serviceName: string;
  serviceVersion?: string;
  hostName: string;
  pid: number;
  bootId: string;
  startedAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  versions: { node: string; nestCore?: string; tracelet: string };
  tracing: { enabled: boolean; sampleRate: number; instrumentInstalled?: boolean };
  /** achievedSampleRateHz = last window's (totalSamples - 1) / ((lastSampleTime - firstSampleTime) / 1e6), with
   *  totalSamples = sampleCount + idleSampleCount and sample times as defined for gapBeforeMs; below sampleRateHz
   *  under CPU throttling or long main-thread blocks. Not computed from durationMs (which includes the start stall). */
  profiler: { state: ProfilerState; reason?: string; sampleRateHz?: number; achievedSampleRateHz?: number; windowMs?: number; lastWindowAt?: IsoDateTime };
  buffer: { queueDepth: number; droppedTraces: number; droppedProfiles: number; lastFlushAt?: IsoDateTime; lastFlushErrorCode?: string };
  storage: { connected: boolean };
}

/* ------------------------------------------------------------------ */
/* 2. Query API DTOs (GET {basePath}/api/v1/...)                        */
/* ------------------------------------------------------------------ */

export type ApiErrorCode =
  | 'INVALID_QUERY' | 'INVALID_CURSOR' | 'NOT_FOUND' | 'FORBIDDEN' | 'METHOD_NOT_ALLOWED'
  | 'RATE_LIMITED' | 'STORAGE_UNAVAILABLE' | 'QUERY_TIMEOUT' | 'INTERNAL';
export interface ErrorEnvelope { error: { code: ApiErrorCode; message: string } }

export interface Page<T> {
  items: T[];
  /** Opaque; null when no further page. */
  nextCursor: string | null;
}
export interface TimeWindow { from: IsoDateTime; to: IsoDateTime; bucketMs?: number }

export interface TraceDetail { trace: ObserveTrace; spans: ObserveSpan[] }

export interface ServiceSummary { serviceName: string; instanceCount: number; liveInstanceCount: number; lastSeenAt: IsoDateTime }
export interface ServiceList { items: ServiceSummary[] }

export interface InstanceSummary {
  instanceId: string;
  serviceName: string;
  serviceVersion?: string;
  hostName: string;
  startedAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  /** lastSeenAt within 3 heartbeat intervals (90 s). */
  isLive: boolean;
  profilerState: ProfilerState;
}
export interface InstanceList { items: InstanceSummary[] }

export interface OperationStats { operation: string; kind: ExecutionKind; executions: number; errors: number; avgMs: number; p95Ms?: number; maxMs?: number }
export interface Overview {
  window: TimeWindow;
  totals: { executions: number; errors: number; errorRate: number; p50Ms?: number; p95Ms?: number; percentileMethod: 'histogram-approx' };
  series: Array<{ t: IsoDateTime; executions: number; errors: number; p95Ms?: number }>;
  slowestOperations: OperationStats[];
  dataNotes: { executionsAreSampled: false; methodStatsAreSampled: true; flushLagHintMs?: number };
}

export interface MethodStats {
  serviceName?: string;
  className?: string;
  method?: string;
  operation: string;
  calls: number;
  errors: number;
  avgMs: number;
  p95Ms?: number;
  maxMs?: number;
  selfAvgMs?: number;
  selfSampleCount: number;
}
export interface MethodStatsList { window: TimeWindow; items: MethodStats[]; sampled: true }

export type ProfileSummaryPage = Page<CpuProfileSummary>;

export interface Flamegraph {
  semantics: 'cpu-samples';
  window: TimeWindow;
  instanceIds?: string[];
  profileCount: number;
  sampleRateHz?: number;
  sampleCount: number;
  idleSampleCount?: number;
  droppedSampleCount: number;
  /** true when the merge hit maxProfilesPerMerge or maxStacks. */
  truncated: boolean;
  stacks: ProfileStack[];
}

export interface ErrorGroup {
  fingerprint: string;
  name: string;
  message?: string;
  operation: string;
  serviceName: string;
  count: number;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  sampleTraceId: string;
}
export interface ErrorGroupPage extends Page<ErrorGroup> { scannedTraces: number; truncated: boolean }

export interface InstanceHealth { instance: string; isLive: boolean; heartbeat: InstanceHeartbeat }
export interface Health {
  servedBy: { instanceId: string; serviceName: string; mongoConnected: boolean; schemaVersion?: 1 };
  items: InstanceHealth[];
}

/* ------------------------------------------------------------------ */
/* 3. Public package API (implemented by the lead in Mission 07;       */
/*    trace()/TraceletInstrument by instrumentation in Missions 02-03) */
/* ------------------------------------------------------------------ */

export interface TraceOptions {
  /** Default 'custom'. kind 'rabbitmq' implies forceRoot unless join === true. */
  kind?: ExecutionKind;
  attributes?: Attributes;
  /** Always start a new root, even inside an open trace. Wins over join. Default: kind === 'rabbitmq' && join !== true. */
  forceRoot?: boolean;
  /** Explicit opt-in to JOIN-IF-OPEN for kinds whose default is forceRoot (rabbitmq). Ignored when forceRoot === true. */
  join?: boolean;
}

/** trace(name, fn, options?) contract (implemented in src/context/root-runner.ts):
 *  - fn is invoked synchronously, exactly once, before trace() returns; nothing is awaited first.
 *    Every telemetry step (admission, start, end, scheduling) is individually wrapped (ignoreFailure); a telemetry
 *    failure before fn runs falls back to calling fn in the caller's store; fn is never called twice.
 *  - Sync return value is returned as is. A thrown value is rethrown (same reference).
 *  - A plain native Promise is replaced by a chained promise settling with the same value / same rejection reason.
 *    A Promise subclass or a promise with own properties is returned as is (observed on a side branch).
 *    A thenable that is not a native Promise (instanceof Promise is false) is treated as a plain value: the root or
 *    span settles at return time, and the thenable is returned untouched.
 *  - The same settle code is used for roots and for joined (manual) spans.
 *  - Nested policy JOIN-IF-OPEN: a nested trace() joins (records a 'manual' child span) only if
 *      effective forceRoot is false AND the store's root token is open AND
 *      (sampled: the registry still holds the trace key | unsampled: monotonic now < token deadline).
 *    Otherwise (no store, closed/force-closed/expired/stale token, forceRoot) it starts a new root with a fresh store.
 *  - Never throws because of Tracelet. */
export type TraceFn = <T>(name: string, fn: () => T, options?: TraceOptions) => T;

/** currentTraceId(): the traceId of the active SAMPLED root whose token is still open; undefined when there is no
 *  store, the root is unsampled, or the token is closed (settled, force-closed, or a stale store). */
export type CurrentTraceIdFn = () => string | undefined;

/** Options of createTraceletInstrument(options?). TraceletInstrument === createTraceletInstrument(). */
export interface TraceletInstrumentOptions {
  /** Decides at decoration time whether instances are proxied. Precedence: env TRACELET_DISABLED=1 (always off) >
   *  this option > env TRACELET_ENABLED=true|false > default (on only when NODE_ENV is 'development' or 'test').
   *  When off, the decorator returns every instance untouched. */
  enabled?: boolean;
  /** Return true to leave a DI instance unproxied. A throwing predicate counts as true. */
  skipInstrumentation?: (instance: unknown) => boolean;
}

export interface RedactionOptions {
  /** Extra global patterns; matches are replaced by "[REDACTED]". */
  patterns?: RegExp[];
  /** Extra sensitive key names (case/separator-insensitive). */
  keys?: string[];
}

/** "dev/test" below means NODE_ENV is exactly 'development' or 'test'. Unset or any other value is treated as
 *  PRODUCTION (conservative defaults). */
export interface TraceletModuleOptions {
  /** Default: true only in dev/test. Precedence: TRACELET_DISABLED=1 > this option > TRACELET_ENABLED=true|false > default.
   *  Must agree with TraceletInstrumentOptions.enabled; a mismatch is reported in health (instrumentInstalled=false) and logged once. */
  enabled?: boolean;
  serviceName: string;
  serviceVersion?: string;
  /** Default os.hostname() (the pod name on OpenShift). */
  hostName?: string;
  storage: {
    /** Dedicated observability database credentials are recommended. Never logged. */
    uri: string;
    /** Default 'observability'. */
    database?: string;
    /** Default 'tracelet_'. Collections: traces, spans, profiles, operation_rollups, method_rollups, metric_rollups, instances. */
    collectionPrefix?: string;
    /** Default 5. */
    maxPoolSize?: number;
    /** Default 5000. */
    serverSelectionTimeoutMS?: number;
  };
  tracing?: {
    /** Default true (when Tracelet is enabled). */
    enabled?: boolean;
    /** 0..1. Default 1 in dev/test, else 0.05. */
    sampleRate?: number;
    /** Keep a rootOnly record for failed sampled-out roots. Default true (shares the maxRootsPerSecond bucket). */
    keepFailedRoots?: boolean;
    /** Sampled (or rootOnly) roots admitted per second per instance (token bucket). Default 200 in dev/test, else 20. */
    maxRootsPerSecond?: number;
    /** Default 5000. */
    maxOpenTraces?: number;
    /** Default 2000, hard maximum 5000. */
    maxSpansPerTrace?: number;
    /** Global budget of simultaneously open spans across all traces; refused starts count into spansDropped. Default 50000. */
    maxOpenSpans?: number;
    /** Roots open longer are force-closed as 'incomplete' (also the deadline of unsampled root tokens). Default 300000. */
    maxTraceDurationMs?: number;
    /** Default { threshold: 20, keepSlowest: 3 }; false disables. */
    spanCollapse?: { threshold?: number; keepSlowest?: number } | false;
    /** Default 'redacted' in dev/test, else 'omit'. */
    errorMessages?: 'redacted' | 'omit';
    redaction?: RedactionOptions;
  };
  profiling?: {
    /** Default false. */
    enabled?: boolean;
    /** 1..1000. Default 99. */
    sampleRateHz?: number;
    /** 5000..120000. Default 30000. */
    windowMs?: number;
    /** Default 2000. */
    maxStacksPerProfile?: number;
    /** Estimated serialized size cap of one CpuProfile; lowest-sample stacks are trimmed into the dropped counts. Default 1 MiB. */
    maxProfileBytes?: number;
    /** Default 128. */
    maxFramesPerStack?: number;
    /** Per-window main-thread block budget = startStallMs + stopStallMs + foldMs (each reported separately);
     *  exceeded 3 windows in a row -> backoff. Default 250. */
    maxStallMs?: number;
  };
  runtimeMetrics?: { enabled?: boolean; intervalMs?: number /* default 30000, min 10000 */ };
  buffer?: {
    maxQueuedTraces?: number; // default 2000 (trace pool)
    maxQueuedBytes?: number; // default 16 MiB (trace pool, estimated)
    maxQueuedProfiles?: number; // default 10 (profile pool)
    maxQueuedControlItems?: number; // default 64 (reserved pool for rollup and metric items)
    maxQueuedControlBytes?: number; // default 4 MiB (reserved pool)
    flushIntervalMs?: number; // default 1000
    batchSize?: number; // default 200 items
    maxBatchBytes?: number; // default 4 MiB (estimated) per writer batch
    maxWriteDocsPerSecond?: number; // default 2000 per instance (writer pacing; excess backs up into the queue and is dropped there)
    maxRetries?: number; // default 3
    shutdownFlushTimeoutMs?: number; // default 5000
  };
  retention?: { tracesHours?: number /* 72 */; profilesHours?: number /* 72 */; rollupsDays?: number /* 14 */; instancesHours?: number /* 24 */ };
}

/** Adapter-neutral view of an incoming dashboard/API request given to authorize(). */
export interface TraceletAuthRequest {
  method: string;
  /** Path after the dashboard base path, e.g. '/api/v1/traces'. */
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Socket peer address (X-Forwarded-For is NOT consulted). */
  remoteAddress: string | undefined;
  /** The underlying Express request or Fastify request, for reuse of the host auth system. */
  raw: unknown;
  adapter: 'express' | 'fastify' | 'node-http';
}

export interface TraceletSetupOptions {
  /** Absolute mount path. Default '/observe'. Global prefixes are NOT applied automatically. */
  path?: string;
  /** Required outside localhost/non-production. Return true to allow. Throwing or rejecting denies (403). */
  authorize?: (req: TraceletAuthRequest) => boolean | Promise<boolean>;
  /** Default: true only in dev/test (NODE_ENV unset = production = false). Allows loopback socket peers without authorize().
   *  Never enable in pods with a proxy sidecar (Istio/Envoy/oauth-proxy): forwarded external traffic arrives from 127.0.0.1. */
  allowLoopbackWithoutAuth?: boolean;
  /** Externally visible base path when behind a path-rewriting proxy. Default = path. */
  publicBasePath?: string;
}

export interface TraceletStandaloneServerOptions extends TraceletSetupOptions {
  /** Default '127.0.0.1'. */
  host?: string;
  port: number;
}
