// Rewritten using nestjs/observe@7500fba `protocols/job-trace-runner.ts:230-364` (MIT, Copyright (c) 2017-present Kamil Mysliwiec)
// as reference. Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import type { Attributes, ExecutionKind, TraceOptions } from '../contracts/index.js';
import { isRuntimeCompatible, traceletAls, type TraceletStore } from '../shared/als.js';
import { uuidv7 } from '../shared/uuid-v7.js';
import { scheduleCompletion, scheduleSnapshot } from './completion.js';
import { CALLER_KEY, REGISTRY_KEY, ROOT_TOKEN_KEY, TRACE_ID_KEY } from './constants.js';
import { isJoinable, type RootToken } from './root-token.js';
import { countSafely, getRuntime, recordRootOnce, type TraceletRuntime } from './runtime.js';
import { ignoreFailure, runAndSettle, tryValue } from './settle.js';
import { createRootOnlySnapshot } from './vendor/trace-registry.js';

interface RootPlan {
  type: 'root';
  sampled: boolean;
  store: TraceletStore;
  token: RootToken;
  key: string | undefined;
  rootSpanId: string | undefined;
  name: string;
  kind: ExecutionKind;
  attributes: Attributes | undefined;
  startedAt: number;
  startPerf: number;
  sampleRate: number;
}
interface JoinPlan {
  type: 'join';
  store: TraceletStore;
  key: string;
  spanId: string;
}
interface PassPlan {
  type: 'pass';
}
type Plan = RootPlan | JoinPlan | PassPlan;

/**
 * trace(name, fn, options?) - see the `TraceFn` contract. fn is invoked synchronously, exactly once, from exactly one call
 * site per path; every telemetry step is individually guarded and a failure before fn falls back to `fn()` in the caller's
 * store (M7, R1).
 */
export function trace<T>(name: string, fn: () => T, options?: TraceOptions): T {
  let rt: TraceletRuntime | undefined;
  try {
    rt = isRuntimeCompatible() ? getRuntime() : undefined;
  } catch {
    rt = undefined;
  }
  if (rt === undefined || rt.config.enabled !== true) {
    return fn();
  }

  let plan: Plan;
  try {
    plan = prepare(rt, name, options);
  } catch {
    plan = { type: 'pass' };
  }

  if (plan.type === 'pass') {
    return fn();
  }
  if (plan.type === 'join') {
    return runJoined(rt, plan, fn);
  }
  return runRoot(rt, plan, fn);
}

/** The traceId of the active SAMPLED root whose token is still open and whose trace the registry still holds. */
export function currentTraceId(): string | undefined {
  try {
    const store = traceletAls.getStore();
    const token = store?.get(ROOT_TOKEN_KEY) as RootToken | undefined;
    if (!token || !token.sampled || token.open !== true || token.key === undefined) return undefined;
    if (!getRuntime().registry.has(token.key)) return undefined;
    const id = store?.get(TRACE_ID_KEY);
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

function prepare(rt: TraceletRuntime, name: string, options: TraceOptions | undefined): Plan {
  const kind = options?.kind ?? 'custom';
  // R3: effective forceRoot. A consume callback gets its own root even when delivered synchronously inside an open trace.
  const forceRoot = options?.forceRoot ?? (kind === 'rabbitmq' && options?.join !== true);
  const store = traceletAls.getStore();
  const token = store?.get(ROOT_TOKEN_KEY) as RootToken | undefined;

  if (!forceRoot && store !== undefined && isJoinable(token, rt.registry)) {
    if (!token.sampled) {
      return { type: 'pass' }; // joined, unsampled: fn runs in the current store (part of the outer unsampled root)
    }
    const key = token.key as string;
    const callerId = store.get(CALLER_KEY) as string | undefined;
    const spanId = tryValue(() => rt.registry.startManualSpan(key, callerId, name));
    if (spanId === undefined) {
      return { type: 'pass' };
    }
    return { type: 'join', store, key, spanId };
  }
  return prepareRoot(rt, name, kind, options);
}

function prepareRoot(rt: TraceletRuntime, name: string, kind: ExecutionKind, options: TraceOptions | undefined): Plan {
  countSafely(rt, 'rootsStarted', 1);
  const cfg = rt.config;
  const startedAt = Date.now();
  const startPerf = performance.now();
  const attributes = options?.attributes ? { ...options.attributes } : undefined;

  let sampled = rt.admission.shouldSample();
  if (!sampled) {
    countSafely(rt, 'rootsSampledOut', 1);
  } else if (!rt.admission.hasCapacity() || !rt.admission.takeToken()) {
    sampled = false;
    countSafely(rt, 'tracesDroppedAdmission', 1);
  }

  const deadline = startPerf + cfg.maxTraceDurationMs;
  const unsampledPlan = (): RootPlan => {
    const token: RootToken = { open: true, sampled: false, deadline, recorded: false };
    const store: TraceletStore = new Map<string, unknown>([[ROOT_TOKEN_KEY, token]]);
    return {
      type: 'root',
      sampled: false,
      store,
      token,
      key: undefined,
      rootSpanId: undefined,
      name,
      kind,
      attributes,
      startedAt,
      startPerf,
      sampleRate: cfg.sampleRate,
    };
  };
  if (!sampled) {
    return unsampledPlan();
  }

  const key = uuidv7();
  const token: RootToken = { open: true, sampled: true, key, deadline, recorded: false };
  const rootSpanId = rt.registry.startRoot(
    key,
    { name, kind, ...(attributes !== undefined ? { attributes } : {}), startedAt, sampleRate: cfg.sampleRate },
    token,
  );
  if (rootSpanId === undefined) {
    // Budget refusal (maxOpenSpans) is an admission refusal: a fresh unsampled root, never a pass-through in the caller's store
    // (that would leak the outer trace id into this delivery and skip rollups) (R-5).
    token.open = false;
    countSafely(rt, 'tracesDroppedAdmission', 1);
    return unsampledPlan();
  }
  try {
    const store: TraceletStore = new Map<string, unknown>([
      [REGISTRY_KEY, key],
      [CALLER_KEY, rootSpanId],
      [ROOT_TOKEN_KEY, token],
      [TRACE_ID_KEY, key],
    ]);
    return {
      type: 'root',
      sampled: true,
      store,
      token,
      key,
      rootSpanId,
      name,
      kind,
      attributes,
      startedAt,
      startPerf,
      sampleRate: cfg.sampleRate,
    };
  } catch (error) {
    // A failure before fn must not leave a half-open root.
    token.open = false;
    ignoreFailure(() => rt.registry.abandonTrace(key));
    throw error;
  }
}

function runRoot<T>(rt: TraceletRuntime, plan: RootPlan, fn: () => T): T {
  return traceletAls.run(plan.store, () =>
    runAndSettle(
      fn,
      () => settleRoot(rt, plan, false, undefined),
      (error) => settleRoot(rt, plan, true, error),
    ),
  );
}

/** Settles a root: token closes synchronously, then registry end, rollup hook and deferred completion (each guarded). */
function settleRoot(rt: TraceletRuntime, plan: RootPlan, failed: boolean, error: unknown): void {
  plan.token.open = false;

  if (plan.sampled) {
    const key = plan.key as string;
    let ended: ReturnType<typeof rt.registry.endRoot>;
    try {
      ended = rt.registry.endRoot(key, error, failed);
    } catch {
      // endRoot failed midway: drop the trace so nothing leaks in the registry.
      ignoreFailure(() => rt.registry.abandonTrace(key));
      return;
    }
    if (ended === undefined) {
      return; // already force-closed (sweeper or shutdown): recorded and scheduled there
    }
    recordRootOnce(rt, plan.token, {
      name: ended.name,
      kind: ended.kind,
      sampled: true,
      status: ended.status,
      durationMs: ended.durationMs,
    });
    scheduleCompletion(rt, key);
    return;
  }

  const durationMs = performance.now() - plan.startPerf;
  recordRootOnce(rt, plan.token, {
    name: plan.name,
    kind: plan.kind,
    sampled: false,
    status: failed ? 'error' : 'ok',
    durationMs,
  });
  if (failed && rt.config.keepFailedRoots && rt.admission.takeToken()) {
    const id = uuidv7();
    const snapshot = createRootOnlySnapshot({
      traceId: id,
      rootSpanId: uuidv7(),
      name: plan.name,
      kind: plan.kind,
      ...(plan.attributes !== undefined ? { attributes: plan.attributes } : {}),
      startedAt: plan.startedAt,
      durationMs,
      sampleRate: plan.sampleRate,
      error,
    });
    scheduleSnapshot(rt, snapshot);
  }
}

/** Joined (manual) span: same settle routine as roots (R1). */
function runJoined<T>(rt: TraceletRuntime, plan: JoinPlan, fn: () => T): T {
  const { key, spanId } = plan;
  let childStore: TraceletStore;
  try {
    childStore = new Map(plan.store);
    childStore.set(CALLER_KEY, spanId);
  } catch {
    ignoreFailure(() => rt.registry.endManualSpan(key, spanId));
    return fn();
  }
  return traceletAls.run(childStore, () =>
    runAndSettle(
      fn,
      () => rt.registry.endManualSpan(key, spanId),
      (error) => rt.registry.endManualSpan(key, spanId, error, true),
    ),
  );
}
