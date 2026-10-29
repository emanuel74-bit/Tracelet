import type { ObserveSpan, ObserveTrace, SanitizedError, TraceItem } from '../contracts/index.js';
import type { LogRedactor } from '../context/vendor/log-redactor.js';
import type { CompleteTraceEventNode, OngoingTraceEventNode } from '../context/vendor/trace-events.interfaces.js';
import type { ErrorPayload, TraceletSnapshot } from '../context/vendor/trace-registry.js';
import { boundAttributes } from './attributes.js';
import { fingerprint, sanitizeError } from './error-sanitizer.js';
import { computeSelfTimes } from './self-time.js';
import {
  collapseRepeatedSpans,
  DEFAULT_SPAN_COLLAPSE,
  SPAN_COLLAPSED_TAG,
  type SpanCollapseSettings,
} from './vendor/collapse-repeated-spans.js';

type Node = CompleteTraceEventNode | OngoingTraceEventNode;

/** Schema bounds (telemetry.schema.json): operation 1..256, className/method 1..128. Empty values get a placeholder. */
const clamp = (value: string | undefined, max: number, placeholder: string): string => {
  const v = typeof value === 'string' ? value.slice(0, max) : '';
  return v.length > 0 ? v : placeholder;
};

export interface MapperContext {
  serviceName: string;
  serviceVersion?: string;
  instanceId: string;
  errorMessages: 'redacted' | 'omit';
  redactor: LogRedactor;
  /** undefined = defaults (threshold 20, keep slowest 3); false = collapse disabled. */
  spanCollapse?: SpanCollapseSettings | false;
  /** Hard cap of stored spans per trace. Default 2000. */
  maxSpansPerTrace?: number;
  cwd?: string;
}

/**
 * Snapshot to `TraceItem` (freeze doc section 3). Order (plan 6.4): (1) self time on the full tree, (2) collapse, (3) flatten
 * depth-first, (4) sanitize errors and attributes, (5) cap spans, (6) estimate bytes. Mutates the snapshot tree (it is owned
 * by the caller after pluck).
 */
export function toTraceItem(snapshot: TraceletSnapshot, ctx: MapperContext): TraceItem {
  const root = snapshot.root;
  computeSelfTimes(root);

  const collapse = ctx.spanCollapse === false ? undefined : (ctx.spanCollapse ?? DEFAULT_SPAN_COLLAPSE);
  if (collapse && root.children && root.children.length > 0) {
    root.children = collapseRepeatedSpans(root.children as Node[], collapse) as never;
  }

  const sanitizeOpts = { errorMessages: ctx.errorMessages, redactor: ctx.redactor, ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}) };
  // A root-origin error is sanitized (and redacted) once: its payload object is shared by the root span and the trace.
  const sanitizedCache = new Map<object, SanitizedError>();
  const sanitizeOnce = (payload: ErrorPayload): SanitizedError => {
    let out = sanitizedCache.get(payload);
    if (!out) {
      out = sanitizeError(payload, sanitizeOpts);
      sanitizedCache.set(payload, out);
    }
    return out;
  };
  const spans: ObserveSpan[] = [];
  let errorTextBytes = 0;

  // Depth-first pre-order, iterative.
  const stack: Array<{ node: Node; parent: string | null }> = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    const isRoot = parent === null;
    const done = node as CompleteTraceEventNode;
    const span: ObserveSpan = {
      spanId: node.spanId ?? '',
      traceId: snapshot.traceId,
      parentSpanId: parent,
      operation:
        node.origin === 'auto'
          ? clamp(`${clamp(node.className, 128, 'Anonymous')}.${clamp(node.methodKey, 128, 'anonymous')}`, 256, 'anonymous')
          : clamp(node.name, 256, '(unnamed)'),
      origin: node.origin,
      startOffsetMs: isRoot ? 0 : (done.startOffset ?? 0),
      durationMs: typeof done.duration === 'number' ? done.duration : 0,
      status: 'ok',
    };
    if (node.origin === 'auto') {
      span.className = clamp(node.className, 128, 'Anonymous');
      span.method = clamp(node.methodKey, 128, 'anonymous');
    }
    if (typeof node.selfDuration === 'number') {
      span.selfDurationMs = node.selfDuration;
    }
    const collapsedCount = node.tags?.[SPAN_COLLAPSED_TAG];
    if (typeof collapsedCount === 'number') {
      span.collapsedCount = collapsedCount;
    }
    if (node.error) {
      span.status = 'error';
      if (typeof node.error === 'object') {
        const sanitized = sanitizeOnce(node.error);
        span.sanitizedError = sanitized;
        errorTextBytes += (sanitized.message?.length ?? 0) + (sanitized.stack?.reduce((n, f) => n + f.length, 0) ?? 0);
      }
    } else if (isRoot && snapshot.status === 'incomplete') {
      span.status = 'incomplete';
    }
    spans.push(span);

    const children = (node.children ?? []) as Node[];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parent: span.spanId });
    }
  }

  const maxSpans = ctx.maxSpansPerTrace ?? 2000;
  let droppedSpanCount = snapshot.droppedSpanCount;
  if (spans.length > maxSpans) {
    // Pre-order prefix: every kept span still has its ancestors.
    droppedSpanCount += spans.length - maxSpans;
    spans.length = maxSpans;
  }

  const rootSpan = spans[0];
  let error: SanitizedError | undefined;
  if (snapshot.rootError) {
    error = sanitizeOnce(snapshot.rootError);
  }

  const trace: ObserveTrace = {
    schemaVersion: 1,
    traceId: snapshot.traceId,
    serviceName: ctx.serviceName,
    instanceId: ctx.instanceId,
    operation: clamp(snapshot.name, 256, '(unnamed)'),
    kind: snapshot.kind,
    startedAt: new Date(snapshot.startedAt).toISOString(),
    durationMs: rootSpan.durationMs,
    status: snapshot.status,
    spanCount: spans.length,
    errorCount: spans.filter((s) => s.sanitizedError !== undefined).length,
    isComplete: snapshot.isComplete,
    rootSpanId: snapshot.rootSpanId,
    sampleRate: snapshot.sampleRate,
    detail: snapshot.detail,
    droppedSpanCount,
    unfinishedSpanCount: snapshot.unfinishedSpanCount,
  };
  if (ctx.serviceVersion !== undefined) trace.serviceVersion = ctx.serviceVersion;
  const attributes = boundAttributes(snapshot.attributes, ctx.redactor);
  if (attributes !== undefined) trace.attributes = attributes;
  if (error !== undefined) {
    trace.error = error;
    trace.errorFingerprint = fingerprint(error, trace.operation);
    errorTextBytes += (error.message?.length ?? 0) + (error.stack?.reduce((n, f) => n + f.length, 0) ?? 0);
  }

  return { type: 'trace', trace, spans, estimatedBytes: 600 + 280 * spans.length + errorTextBytes };
}
