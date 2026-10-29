import type { ExecutionKind, TelemetryCounterName, TelemetryCounterSink, TelemetryQueue, TracingHealthSource } from '../contracts/index.js';
import { getGlobalSlot, isRuntimeCompatible } from '../shared/als.js';
import { createDiagnostics, type Diagnostics } from '../shared/diagnostics.js';
import { Admission } from './admission.js';
import type { RootToken } from './root-token.js';
import { ignoreFailure } from './settle.js';
import { TraceRegistry, type TraceletSnapshot } from './vendor/trace-registry.js';

export interface RootSettledEvent {
  name: string;
  kind: ExecutionKind;
  sampled: boolean;
  status: 'ok' | 'error' | 'incomplete';
  durationMs: number;
}

/** Resolved tracing configuration (the `tracing` block of TraceletModuleOptions plus the two buffer hand-off hooks). */
export interface TracingRuntimeConfig {
  enabled: boolean;
  sampleRate: number;
  keepFailedRoots: boolean;
  maxRootsPerSecond: number;
  maxOpenTraces: number;
  maxSpansPerTrace: number;
  maxOpenSpans: number;
  maxTraceDurationMs: number;
  /** Buffer hand-off, injected by the integration layer (context never imports buffer). Called outside any trace. */
  onTraceComplete?: (snapshot: TraceletSnapshot) => void;
  /** Rollup hook; called exactly once per root (settle or force-close, whichever comes first). */
  onRootSettled?: (event: RootSettledEvent) => void;
}

export const DEFAULT_TRACING_CONFIG: TracingRuntimeConfig = {
  enabled: false,
  sampleRate: 1,
  keepFailedRoots: true,
  maxRootsPerSecond: 200,
  maxOpenTraces: 5000,
  maxSpansPerTrace: 2000,
  maxOpenSpans: 50_000,
  maxTraceDurationMs: 300_000,
};

const NOOP_SINK: TelemetryCounterSink = { count() {} };

/** Process singleton stored in the global slot (`shared/als.ts`). */
export interface TraceletRuntime {
  registry: TraceRegistry;
  admission: Admission;
  config: TracingRuntimeConfig;
  sink: TelemetryCounterSink;
  diagnostics: Diagnostics;
  instrumentInstalled: boolean;
  /** Completions scheduled and not yet finished (test and shutdown aid). */
  pendingCompletions: number;
  sweeperTimer?: ReturnType<typeof setInterval>;
}

export interface RuntimeDeps {
  registry?: TraceRegistry;
  admission?: Admission;
  config?: Partial<TracingRuntimeConfig>;
  sink?: TelemetryCounterSink;
  diagnostics?: Diagnostics;
  completionTimeoutMs?: number;
}

function buildRuntime(deps: RuntimeDeps = {}): TraceletRuntime {
  const rt = {
    config: { ...DEFAULT_TRACING_CONFIG, ...deps.config },
    sink: deps.sink ?? NOOP_SINK,
    diagnostics: deps.diagnostics ?? createDiagnostics('Tracelet'),
    instrumentInstalled: false,
    pendingCompletions: 0,
  } as TraceletRuntime;
  rt.registry =
    deps.registry ??
    new TraceRegistry({
      limits: () => rt.config,
      count: (name, n) => rt.sink.count(name, n),
      ...(deps.completionTimeoutMs !== undefined ? { completionTimeoutMs: deps.completionTimeoutMs } : {}),
    });
  rt.admission = deps.admission ?? new Admission(() => rt.config, () => rt.registry.openTraceCount());
  return rt;
}

/** The process runtime; created with defaults (tracing disabled, pass-through) until configureTracing runs. */
export function getRuntime(): TraceletRuntime {
  const slot = getGlobalSlot();
  let rt = slot.runtime as TraceletRuntime | undefined;
  if (rt === undefined) {
    rt = buildRuntime();
    slot.runtime = rt;
  }
  return rt;
}

/** Enables tracing with the given settings (merged over the current ones). Integration layer only. */
export function configureTracing(cfg: Partial<TracingRuntimeConfig>): void {
  if (!isRuntimeCompatible()) return;
  const rt = getRuntime();
  rt.config = { ...rt.config, ...cfg, enabled: cfg.enabled ?? true };
}

/** Attaches the queue as the process counter sink. */
export function setTelemetryQueue(queue: TelemetryQueue): void {
  if (!isRuntimeCompatible()) return;
  getRuntime().sink = queue;
}

/** Test seam: replaces the process runtime with one built from `deps` (tracing enabled unless the config says otherwise). */
export function createRuntimeForTesting(deps: RuntimeDeps = {}): TraceletRuntime {
  const rt = buildRuntime({ ...deps, config: { enabled: true, ...deps.config } });
  const slot = getGlobalSlot();
  const previous = slot.runtime as TraceletRuntime | undefined;
  if (previous?.sweeperTimer) clearInterval(previous.sweeperTimer);
  slot.runtime = rt;
  return rt;
}

/** Test seam: drops the runtime so the next getRuntime() builds a default (disabled) one. */
export function resetRuntimeForTesting(): void {
  const slot = getGlobalSlot();
  const previous = slot.runtime as TraceletRuntime | undefined;
  if (previous?.sweeperTimer) clearInterval(previous.sweeperTimer);
  slot.runtime = undefined;
}

/** Counts through the sink; a throwing sink never reaches the business code. */
export function countSafely(rt: TraceletRuntime, name: TelemetryCounterName, n = 1): void {
  ignoreFailure(() => rt.sink.count(name, n));
}

/** Runs the rollup hook once per root (guarded by the token). */
export function recordRootOnce(rt: TraceletRuntime, token: RootToken, event: RootSettledEvent): void {
  if (token.recorded) return;
  token.recorded = true;
  ignoreFailure(() => rt.config.onRootSettled?.(event));
}

export const tracingHealthSource: TracingHealthSource = {
  tracingHealth() {
    const rt = getRuntime();
    return {
      enabled: rt.config.enabled,
      sampleRate: rt.config.sampleRate,
      instrumentInstalled: rt.instrumentInstalled,
      openTraces: rt.registry.openTraceCount(),
    };
  },
};

/** Implements TracingHealthSource. */
export function tracingHealth(): ReturnType<TracingHealthSource['tracingHealth']> {
  return tracingHealthSource.tracingHealth();
}
