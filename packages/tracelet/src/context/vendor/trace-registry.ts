// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import type { Attributes, ExecutionKind, TelemetryCounterName } from '../../contracts/index.js';
import { uuidv7 } from '../../shared/uuid-v7.js';
import type { RootToken } from '../root-token.js';
import type { CompleteTraceEventNode, OngoingTraceEventNode } from './trace-events.interfaces.js';

export const SNAPSHOT_COMPLETION_TIMEOUT_MS = 1000;

/** Kept for parity with upstream; Tracelet reports the count in `TraceletSnapshot.unfinishedSpanCount`. */
export const UNFINISHED_SPANS_TAG = 'observe.unfinishedSpans';

type TraceKey = string;
type Node = CompleteTraceEventNode | OngoingTraceEventNode;

/** Raw (not yet sanitized or redacted) error payload; lives in memory only until the snapshot is mapped. */
export interface ErrorPayload {
  cls?: string;
  message: string;
  stack?: string;
  /** Number of lines the V8 stack header (name + message) occupies, computed before the message is capped. */
  headerLines?: number;
}

export interface RootMeta {
  name: string;
  kind: ExecutionKind;
  attributes?: Attributes;
  /** Date.now() at root start. */
  startedAt: number;
  sampleRate: number;
}

/** The snapshot handed to the buffer once a trace is plucked. Public fields only. */
export interface TraceletSnapshot {
  traceId: string;
  key: string;
  name: string;
  kind: ExecutionKind;
  attributes?: Attributes;
  startedAt: number;
  /** Root duration (monotonic) in ms. */
  duration: number;
  sampleRate: number;
  status: 'ok' | 'error' | 'incomplete';
  isComplete: boolean;
  detail: 'full' | 'rootOnly';
  rootSpanId: string;
  /** Single root: the synthetic root span (origin 'root') with the whole tree below it. */
  root: Node;
  droppedSpanCount: number;
  unfinishedSpanCount: number;
  /** Payload of the error that escaped the root (root span may carry `true` when the origin was deeper). */
  rootError?: ErrorPayload;
}

export interface RegistryLimits {
  maxSpansPerTrace: number;
  maxOpenSpans: number;
}

export interface TraceRegistryDeps {
  limits: () => RegistryLimits;
  /** Counts through the TelemetryCounterSink; the registry guards against it throwing. */
  count: (name: TelemetryCounterName, n: number) => void;
  /** Test seam; default 1000 ms (upstream). */
  completionTimeoutMs?: number;
}

export interface EndedRoot {
  key: string;
  name: string;
  kind: ExecutionKind;
  durationMs: number;
  status: 'ok' | 'error' | 'incomplete';
  token: RootToken;
}

interface InternalSnapshot {
  traceId: string;
  key: string;
  name: string;
  kind: ExecutionKind;
  attributes?: Attributes;
  startedAt: number;
  startTimestamp: number;
  duration: number;
  sampleRate: number;
  status: 'ok' | 'error' | 'incomplete';
  isComplete: boolean;
  rootSpanId: string;
  root: OngoingTraceEventNode;
  droppedSpanCount: number;
  unfinishedSpanCount: number;
  rootError?: ErrorPayload;
  /** Counts references to this snapshot: started spans (root included). */
  refsCounter: number;
  /** When `refsCounter` equals `refsMarkedAsComplete`, the snapshot is complete. */
  refsMarkedAsComplete: number;
  /** true once the root settled or was force-closed; no new spans start afterwards. */
  closed: boolean;
  token: RootToken;
  /** Error values already seen in this trace (identity): the first span ending with one is the origin. */
  errorSeen: Set<unknown>;
  /** Spans started (stored) in this trace, root included. */
  spanCount: number;
  /** Spans started and not yet ended; released from the global budget at end or pluck. */
  openSpans: number;
}

const MAX_RAW_MESSAGE = 8192;
const MAX_RAW_STACK = 16384;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Builds the raw error payload. Never throws. */
export function toErrorPayload(error: unknown): ErrorPayload {
  try {
    if (error instanceof Error) {
      const payload: ErrorPayload = { message: cap(String(error.message), MAX_RAW_MESSAGE) };
      const ctor = (error as { constructor?: { name?: unknown } }).constructor;
      const name = typeof ctor?.name === 'string' && ctor.name ? ctor.name : error.name;
      if (typeof name === 'string') payload.cls = name;
      if (typeof error.stack === 'string') payload.stack = cap(error.stack, MAX_RAW_STACK);
      payload.headerLines = String(error.message).split('\n').length;
      return payload;
    }
    const payload: ErrorPayload = { message: cap(String(error), MAX_RAW_MESSAGE) };
    if (typeof error === 'object' && error !== null) {
      const ctorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof ctorName === 'string' && ctorName) payload.cls = ctorName;
    }
    return payload;
  } catch {
    return { message: '[unprintable error]' };
  }
}

/** A node and everything below it. */
function countNodes(node: { children?: Node[] }): number {
  let count = 1;
  for (const child of node.children ?? []) {
    count += countNodes(child);
  }
  return count;
}

export class TraceRegistry {
  private readonly snapshots: Map<TraceKey, InternalSnapshot> = new Map();
  private readonly callerIdsByTraceId: Map<TraceKey, Map<string, OngoingTraceEventNode>> = new Map();
  /** Spans open across all traces (R6). */
  private openSpanTotal = 0;
  /** Plucks waiting out the completion timeout. */
  private awaitingCompletion = 0;

  constructor(private readonly deps: TraceRegistryDeps) {}

  /* ------------------------------ queries ------------------------------ */

  has(key: TraceKey): boolean {
    return this.snapshots.has(key);
  }

  openTraceCount(): number {
    return this.snapshots.size;
  }

  openSpanCount(): number {
    return this.openSpanTotal;
  }

  hasSnapshotsAwaitingCompletion(): boolean {
    return this.awaitingCompletion > 0;
  }

  /* ------------------------------- roots ------------------------------- */

  /**
   * Starts a trace with a synthetic root span (origin 'root') and keeps the root's token so force-close can flip it (R2).
   * Returns the root span id, or undefined when nothing was registered (the caller then runs untraced).
   */
  startRoot(key: TraceKey, meta: RootMeta, token: RootToken): string | undefined {
    if (this.snapshots.has(key)) {
      return undefined;
    }
    const limits = this.deps.limits();
    if (this.openSpanTotal >= limits.maxOpenSpans) {
      this.count('spansDropped', 1);
      return undefined;
    }
    const rootSpanId = uuidv7();
    const startTime = performance.now();
    const root: OngoingTraceEventNode = {
      origin: 'root',
      type: 'start',
      name: meta.name,
      className: '',
      methodKey: '',
      startTime,
      startOffset: 0,
      children: [],
      spanId: rootSpanId,
    };
    const snapshot: InternalSnapshot = {
      traceId: key,
      key,
      name: meta.name,
      kind: meta.kind,
      startedAt: meta.startedAt,
      startTimestamp: startTime,
      duration: 0,
      sampleRate: meta.sampleRate,
      status: 'ok',
      isComplete: true,
      rootSpanId,
      root,
      droppedSpanCount: 0,
      unfinishedSpanCount: 0,
      refsCounter: 1,
      refsMarkedAsComplete: 0,
      closed: false,
      token,
      errorSeen: new Set(),
      spanCount: 1,
      openSpans: 1,
    };
    if (meta.attributes !== undefined) snapshot.attributes = meta.attributes;
    const refs = new Map<string, OngoingTraceEventNode>();
    refs.set(rootSpanId, root);
    // Both maps are written last so a failure above leaves nothing registered.
    this.snapshots.set(key, snapshot);
    this.callerIdsByTraceId.set(key, refs);
    this.openSpanTotal += 1;
    return rootSpanId;
  }

  /**
   * Completes the root span. Flips the token (`open = false`) synchronously. Returns undefined when the trace is unknown
   * or was already closed (late settle after a force-close).
   */
  endRoot(key: TraceKey, error?: unknown, failed: boolean = error !== undefined): EndedRoot | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot || snapshot.closed) {
      return undefined;
    }
    snapshot.closed = true;
    snapshot.token.open = false;
    this.completeNode(snapshot, snapshot.root, failed, error);
    snapshot.duration = (snapshot.root as unknown as CompleteTraceEventNode).duration;
    snapshot.status = failed ? 'error' : 'ok';
    if (failed) {
      // Reuse the payload when the root itself is the origin, so the mapper sanitizes (redacts) it once.
      const rootNodeError = (snapshot.root as { error?: unknown }).error;
      snapshot.rootError =
        typeof rootNodeError === 'object' && rootNodeError !== null ? (rootNodeError as ErrorPayload) : toErrorPayload(error);
    }
    return this.endedRoot(snapshot);
  }

  /** Force-closes a root as 'incomplete' (sweeper timeout or shutdown). Flips the same token the store holds. */
  forceClose(key: TraceKey, _reason: 'timeout' | 'shutdown'): EndedRoot | undefined {
    const snapshot = this.snapshots.get(key);
    if (!snapshot || snapshot.closed) {
      return undefined;
    }
    snapshot.closed = true;
    snapshot.token.open = false;
    this.completeNode(snapshot, snapshot.root, false, undefined);
    snapshot.duration = (snapshot.root as unknown as CompleteTraceEventNode).duration;
    snapshot.status = 'incomplete';
    snapshot.isComplete = false;
    return this.endedRoot(snapshot);
  }

  /** Force-closes every root older than maxTraceDurationMs. */
  closeExpired(maxTraceDurationMs: number, now: number = performance.now()): EndedRoot[] {
    const closed: EndedRoot[] = [];
    for (const snapshot of [...this.snapshots.values()]) {
      if (!snapshot.closed && now - snapshot.startTimestamp >= maxTraceDurationMs) {
        const ended = this.forceClose(snapshot.key, 'timeout');
        if (ended) closed.push(ended);
      }
    }
    return closed;
  }

  /** Force-closes every open root (graceful shutdown). */
  closeAllOpenRoots(reason: 'timeout' | 'shutdown' = 'shutdown'): EndedRoot[] {
    const closed: EndedRoot[] = [];
    for (const snapshot of [...this.snapshots.values()]) {
      if (!snapshot.closed) {
        const ended = this.forceClose(snapshot.key, reason);
        if (ended) closed.push(ended);
      }
    }
    return closed;
  }

  private endedRoot(snapshot: InternalSnapshot): EndedRoot {
    return {
      key: snapshot.key,
      name: snapshot.name,
      kind: snapshot.kind,
      durationMs: snapshot.duration,
      status: snapshot.status,
      token: snapshot.token,
    };
  }

  /* ------------------------------- spans ------------------------------- */

  /** Starts an auto span (instance decorator). Returns the span id, or undefined when no span was opened. */
  internalStartTraceStep(
    traceId: TraceKey,
    className: string,
    methodKey: string,
    callerId: string | undefined,
  ): string | undefined {
    return this.startSpan(traceId, callerId, { origin: 'auto', className, methodKey });
  }

  /**
   * Starts a manual span (joined nested trace()). Synchronous; books into the same refs ledger as auto spans (R1).
   * Returns undefined when the trace is gone or closed, or a budget refused the span.
   */
  startManualSpan(traceId: TraceKey, callerId: string | undefined, name: string): string | undefined {
    return this.startSpan(traceId, callerId, { origin: 'manual', className: '', methodKey: '', name });
  }

  private startSpan(
    traceId: TraceKey,
    callerId: string | undefined,
    spec: { origin: 'auto' | 'manual'; className: string; methodKey: string; name?: string },
  ): string | undefined {
    const snapshot = this.snapshots.get(traceId);
    if (!snapshot || snapshot.closed) {
      return undefined;
    }
    const limits = this.deps.limits();
    if (snapshot.spanCount >= limits.maxSpansPerTrace || this.openSpanTotal >= limits.maxOpenSpans) {
      snapshot.droppedSpanCount += 1;
      this.count('spansDropped', 1);
      return undefined;
    }

    const newNodeId = uuidv7();
    const startTime = performance.now();
    const newNode: OngoingTraceEventNode = {
      origin: spec.origin,
      type: 'start',
      className: spec.className,
      methodKey: spec.methodKey,
      startTime,
      startOffset: startTime - snapshot.startTimestamp,
      children: [],
      spanId: newNodeId,
    };
    if (spec.name !== undefined) newNode.name = spec.name;

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    if (!refsByCaller) {
      return undefined;
    }
    this.attachToCaller(snapshot, refsByCaller, callerId, newNode);
    refsByCaller.set(newNodeId, newNode);
    snapshot.refsCounter += 1;
    snapshot.spanCount += 1;
    snapshot.openSpans += 1;
    this.openSpanTotal += 1;
    return newNodeId;
  }

  /**
   * Nests a freshly opened node under its caller when that caller is still live, and under the live root span otherwise
   * (single-root invariant; upstream pushed to `snapshot.traces`).
   */
  private attachToCaller(
    snapshot: InternalSnapshot,
    refsByCaller: Map<string, OngoingTraceEventNode>,
    callerId: string | undefined,
    newNode: OngoingTraceEventNode,
  ): void {
    const caller = callerId ? refsByCaller.get(callerId) : undefined;
    const parent = caller?.type === 'start' ? caller : snapshot.root;
    parent.children.push(newNode);
    newNode.parent = parent;
  }

  /**
   * Ends an auto span. `callerId` is the span id returned by internalStartTraceStep (upstream parameter naming).
   * `failed` says the call threw/rejected even when the thrown value is falsy.
   */
  internalEndTraceStep(
    traceId: TraceKey,
    _spanLabel: string | undefined,
    _className: string,
    _methodKey: string,
    callerId: string | undefined,
    error?: unknown,
    failed: boolean = error !== undefined,
  ): void {
    this.endSpan(traceId, callerId, failed, error);
  }

  /** Ends a manual span started by startManualSpan. */
  endManualSpan(traceId: TraceKey, spanId: string, error?: unknown, failed: boolean = error !== undefined): void {
    this.endSpan(traceId, spanId, failed, error);
  }

  private endSpan(traceId: TraceKey, spanId: string | undefined, failed: boolean, error: unknown): void {
    const snapshot = this.snapshots.get(traceId);
    if (!snapshot) {
      // The trace was handed off while this span was still open (pluck shipped it without the span) or force-dropped.
      return;
    }
    const cursor = spanId === undefined ? undefined : this.callerIdsByTraceId.get(traceId)?.get(spanId);
    if (!cursor || cursor.type !== 'start') {
      return;
    }
    this.completeNode(snapshot, cursor, failed, error);
  }

  /** Converts an ongoing node into a complete one and records its error. */
  private completeNode(snapshot: InternalSnapshot, node: OngoingTraceEventNode, failed: boolean, error: unknown): void {
    const duration = performance.now() - node.startTime;

    // `type`, `startTime` and `parent` are exactly what separates an ongoing node from a complete one.
    const completing = node as Partial<OngoingTraceEventNode>;
    delete completing.type;
    delete completing.startTime;
    delete completing.parent;

    if (Object.keys(node.tags || {}).length === 0) {
      delete completing.tags;
    }
    if (node.children.length === 0) {
      delete completing.children;
    }

    const done = node as unknown as CompleteTraceEventNode;
    done.duration = duration;

    snapshot.refsMarkedAsComplete += 1;
    snapshot.openSpans -= 1;
    this.openSpanTotal -= 1;

    if (failed) {
      // Origin tracking: the first span to end with this error value gets the payload, ancestors get `true`.
      if (snapshot.errorSeen.has(error)) {
        done.error = true;
      } else {
        snapshot.errorSeen.add(error);
        done.error = toErrorPayload(error);
      }
    }
  }

  /* -------------------------------- pluck -------------------------------- */

  /** Drops a trace that will never be plucked, freeing both maps and the global span budget. */
  abandonTrace(traceId: TraceKey): void {
    const snapshot = this.snapshots.get(traceId);
    this.cleanup(traceId, snapshot);
  }

  private cleanup(traceId: TraceKey, snapshot: InternalSnapshot | undefined): void {
    this.callerIdsByTraceId.delete(traceId);
    this.snapshots.delete(traceId);
    if (snapshot) {
      this.openSpanTotal -= snapshot.openSpans;
      snapshot.openSpans = 0;
    }
  }

  /**
   * Waits up to the completion timeout for spans that were still open when the root ended, leaves out what is still
   * unfinished, removes the trace from the registry and returns the public snapshot.
   */
  async pluckSnapshot(traceId: TraceKey): Promise<TraceletSnapshot | undefined> {
    const snapshot = this.snapshots.get(traceId);
    if (!snapshot || !snapshot.closed) {
      return undefined;
    }
    if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
      this.awaitingCompletion += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, this.deps.completionTimeoutMs ?? SNAPSHOT_COMPLETION_TIMEOUT_MS));
      } finally {
        this.awaitingCompletion -= 1;
      }
      if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
        this.leaveOutUnfinishedSpans(snapshot);
      }
    }
    this.cleanup(traceId, snapshot);

    return {
      traceId: snapshot.traceId,
      key: snapshot.key,
      name: snapshot.name,
      kind: snapshot.kind,
      ...(snapshot.attributes !== undefined ? { attributes: snapshot.attributes } : {}),
      startedAt: snapshot.startedAt,
      duration: snapshot.duration,
      sampleRate: snapshot.sampleRate,
      status: snapshot.status,
      isComplete: snapshot.isComplete,
      detail: 'full',
      rootSpanId: snapshot.rootSpanId,
      root: snapshot.root,
      droppedSpanCount: snapshot.droppedSpanCount,
      unfinishedSpanCount: snapshot.unfinishedSpanCount,
      ...(snapshot.rootError !== undefined ? { rootError: snapshot.rootError } : {}),
    };
  }

  /**
   * Takes every span that is still open out of the tree, together with everything recorded under it. The parent of a
   * removed node loses its self time (`leftOutChildren`).
   */
  private leaveOutUnfinishedSpans(snapshot: InternalSnapshot): void {
    let leftOut = 0;
    const prune = (node: Node): void => {
      if (!node.children || node.children.length === 0) return;
      const kept: Node[] = [];
      let removed = 0;
      for (const child of node.children as Node[]) {
        if ('type' in child && child.type === 'start') {
          leftOut += countNodes(child);
          removed += 1;
        } else {
          prune(child);
          kept.push(child);
        }
      }
      if (removed > 0) {
        node.leftOutChildren = (node.leftOutChildren ?? 0) + removed;
        if (kept.length === 0) {
          delete (node as Partial<CompleteTraceEventNode>).children;
        } else {
          node.children = kept as never;
        }
      }
    };
    prune(snapshot.root);
    if (leftOut > 0) {
      snapshot.unfinishedSpanCount += leftOut;
      snapshot.isComplete = false;
    }
  }

  private count(name: TelemetryCounterName, n: number): void {
    try {
      this.deps.count(name, n);
    } catch {
      // counting is a side effect (M7)
    }
  }
}

/**
 * Builds a one-span snapshot for a failed root that was sampled out (`rootOnly`, plan 6.2). Pure; never stored in a registry.
 */
export function createRootOnlySnapshot(args: {
  traceId: string;
  rootSpanId: string;
  name: string;
  kind: ExecutionKind;
  attributes?: Attributes;
  startedAt: number;
  durationMs: number;
  sampleRate: number;
  error: unknown;
}): TraceletSnapshot {
  const payload = toErrorPayload(args.error);
  const root: CompleteTraceEventNode = {
    origin: 'root',
    name: args.name,
    className: '',
    methodKey: '',
    spanId: args.rootSpanId,
    startOffset: 0,
    duration: args.durationMs,
    error: payload,
  };
  return {
    traceId: args.traceId,
    key: args.traceId,
    name: args.name,
    kind: args.kind,
    ...(args.attributes !== undefined ? { attributes: args.attributes } : {}),
    startedAt: args.startedAt,
    duration: args.durationMs,
    sampleRate: args.sampleRate,
    status: 'error',
    isComplete: true,
    detail: 'rootOnly',
    rootSpanId: args.rootSpanId,
    root,
    droppedSpanCount: 0,
    unfinishedSpanCount: 0,
    rootError: payload,
  };
}
