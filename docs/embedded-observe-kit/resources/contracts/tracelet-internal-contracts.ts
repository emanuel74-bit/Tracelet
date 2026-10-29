/**
 * Tracelet frozen v1 INTERNAL module-boundary contracts (CONTRACT_VERSION 1.0.0).
 * STATUS: FROZEN v1 candidate - pending independent review (see artifacts/01_CONTRACT_FREEZE.md).
 *
 * These interfaces are the only coupling allowed between owner write scopes:
 *   instrumentation (src/context, src/instrumentation, src/buffer)  -> produces TelemetryItem into TelemetryQueue
 *   profiler        (src/profiling)                                  -> produces profile/metric items into TelemetryQueue
 *   storage         (src/storage)                                    -> drains TelemetryQueue, writes Mongo
 *   query/api       (src/query, src/api)                             -> implements ApiHandler over Mongo
 *   integration     (src/http, src/tracelet.module.ts, src/index.ts) -> wires everything, owns auth and mounts
 * Copied byte-identical to packages/tracelet/src/contracts/tracelet-internal-contracts.ts at Mission 02 scaffold time
 * (checked by tests/contract/contracts-sync.spec.ts).
 */
import type {
  CpuProfile,
  InstanceHeartbeat,
  MethodRollup,
  MetricRollup,
  ObserveSpan,
  ObserveTrace,
  OperationRollup,
  ProfilerState,
  TelemetryCounters,
} from './observe-contracts';

/* ---------------- telemetry hand-off (producer -> storage) ---------------- */

/** One completed trace exactly as it must be stored (API DTO shape; storage adds _id/expireAt/BSON dates). */
export interface TraceItem {
  type: 'trace';
  trace: ObserveTrace;
  spans: ObserveSpan[];
  /** Producer's size estimate used for the byte cap. */
  estimatedBytes: number;
}
export interface ProfileItem { type: 'profile'; profile: CpuProfile; estimatedBytes: number }
export interface MetricItem { type: 'metric'; metric: MetricRollup; estimatedBytes: number }
/** Full replacement of this instance's rollup documents for the listed buckets (idempotent upsert). */
export interface RollupItem {
  type: 'rollup';
  operations: OperationRollup[];
  methods: MethodRollup[];
  estimatedBytes: number;
}
export type TelemetryItem = TraceItem | ProfileItem | MetricItem | RollupItem;

export type DropReason = 'queueFull' | 'admission' | 'storage' | 'shutdown';

/** Names of the monotonically increasing counters reported in MetricRollup.telemetry. */
export type TelemetryCounterName = keyof TelemetryCounters;

/** Write side of the counters. Context (admission, span budgets), buffer, profiler and storage all count through
 *  this sink; MetricsCollector reads TelemetryQueue.counters() and reports deltas. Never throws, O(1). */
export interface TelemetryCounterSink {
  count(name: TelemetryCounterName, n?: number): void;
}

/** Queue pools. Each pool has its own item and byte caps, so a flood in one pool cannot starve another:
 *  'trace' = TraceItem; 'profile' = ProfileItem; 'control' = RollupItem + MetricItem (reserved capacity). */
export type QueuePool = 'trace' | 'profile' | 'control';

/** Bounded, non-blocking, single-process queue. Implemented by instrumentation (src/buffer/telemetry-queue.ts).
 *  Also the process's TelemetryCounterSink. */
export interface TelemetryQueue extends TelemetryCounterSink {
  /** O(1), never throws, never awaits. Returns false (and counts the drop for the item's pool) when it does not fit. */
  offer(item: TelemetryItem): boolean;
  /** Removes items FIFO across pools until maxItems or maxBytes (sum of estimatedBytes) would be exceeded.
   *  A head item larger than maxBytes on its own is dropped and counted (reason 'storage') instead of being returned,
   *  so a non-empty queue never yields an empty batch forever. Never throws. */
  drain(maxItems: number, maxBytes: number): TelemetryItem[];
  /** Storage reports items it gave up on after retries. */
  reportDropped(items: readonly TelemetryItem[], reason: DropReason): void;
  depth(pool?: QueuePool): number;
  estimatedBytes(pool?: QueuePool): number;
  counters(): Readonly<TelemetryCounters>;
  /** Resolves when an offer happens or the timeout elapses (lets the writer sleep). Never rejects. */
  waitForItems(timeoutMs: number): Promise<void>;
}

/* ---------------- health sources (read by heartbeat + /health) ---------------- */

export interface TracingHealthSource {
  tracingHealth(): { enabled: boolean; sampleRate: number; instrumentInstalled: boolean; openTraces: number };
}
export interface ProfilerHealthSource {
  profilerHealth(): { state: ProfilerState; reason?: string; sampleRateHz?: number; achievedSampleRateHz?: number; windowMs?: number; lastWindowAt?: string };
}
export interface StorageHealthSource {
  storageHealth(): { connected: boolean; lastFlushAt?: string; lastFlushErrorCode?: string };
}

/** Process identity, created once at import time by src/shared/instance-identity.ts. */
export interface InstanceIdentity {
  serviceName: string;
  serviceVersion?: string;
  hostName: string;
  pid: number;
  /** uuidv7 generated at process start. */
  bootId: string;
  /** `${sanitizedHostName}-${last 12 hex chars of bootId}`. sanitizedHostName = hostName with every char outside
   *  [A-Za-z0-9._-] replaced by '-', then truncated to its first 115 chars (host names may be 253), so
   *  instanceId <= 115 + 1 + 12 = 128 chars and matches /^[A-Za-z0-9._:-]+$/. hostName itself is kept untruncated. */
  instanceId: string;
  startedAt: string;
}

export type HeartbeatFactory = () => InstanceHeartbeat;

/* ---------------- adapter-neutral HTTP (api + dashboard) ---------------- */

export interface TraceletHttpRequest {
  method: string;
  /** Path relative to the dashboard base path, always starting with '/'. No query string. */
  path: string;
  /** Decoded query parameters; repeated keys keep the first value. */
  query: Readonly<Record<string, string | undefined>>;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface TraceletHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON responses are pre-serialised strings; assets are Buffers. */
  body: string | Buffer;
}

/** Implemented by src/api/query-api.handler.ts for paths under '/api/v1/'. Never throws: maps failures to ErrorEnvelope. */
export type ApiHandler = (req: TraceletHttpRequest) => Promise<TraceletHttpResponse>;

/** Written by the dashboard build to assets/dashboard/asset-manifest.json; read by src/http/static-assets.ts. */
export interface DashboardAssetManifest {
  manifestVersion: 1;
  /** Must be 'index.html'. Contains the literal placeholder "<!--tracelet:config-->" exactly once. */
  entry: 'index.html';
  files: Record<string, { size: number; sha256: string; contentType: string; immutable: boolean }>;
}

/** Injected by the integration layer in place of "<!--tracelet:config-->" as
 *  <script id="tracelet-config" type="application/json">JSON</script> (a non-executable data block).
 *  The JSON text is produced by JSON.stringify and then escaped: '<' -> <, '>' -> >, '&' -> &,
 *  U+2028 ->  , U+2029 ->  , so a value can never close the script element or start a comment. */
export interface DashboardRuntimeConfig {
  basePath: string;
  apiBase: string;
  contractVersion: string;
  schemaVersion: 1;
}
