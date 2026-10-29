import type {
  ExecutionKind,
  Histogram,
  MethodRollup,
  OperationRollup,
  RollupItem,
  TelemetryItem,
  TraceItem,
} from '../contracts/index.js';
import { runOutsideTrace } from '../shared/als.js';
import { bucketIndex, emptyHistogram } from './histogram.js';

/** R9 cadence: dirty buckets are offered every 10 s (constant; `flushIntervalMs` option is the test seam). */
export const ROLLUP_FLUSH_INTERVAL_MS = 10_000;
export const ROLLUP_BUCKET_MS = 60_000;
export const MAX_ROLLUP_OPERATIONS = 500;
export const MAX_ROLLUP_METHODS = 2000;
/** Buckets kept in memory besides the current one. */
export const ROLLUP_PREVIOUS_BUCKETS = 2;
export const OTHER_OPERATION = '(other)';

/** Estimated serialized bytes per document / per item (plan 9: a full-cardinality item is about 0.75 MB). */
const BYTES_PER_DOC = 300;
const BYTES_PER_ITEM = 200;

/** What the context rollup hook reports for every settled root (`RootSettledEvent`, declared structurally). */
export interface RollupRootEvent {
  name: string;
  kind: ExecutionKind;
  sampled: boolean;
  status: 'ok' | 'error' | 'incomplete';
  durationMs: number;
}

export interface RollupAccumulatorOptions {
  serviceName: string;
  instanceId: string;
  /** Receives one RollupItem per dirty bucket. Returns false when the queue refused it (the bucket then stays dirty). */
  offer: (item: TelemetryItem) => boolean;
  /** Clock seam (ms since epoch). Default Date.now. */
  now?: () => number;
  /** Timer period; default ROLLUP_FLUSH_INTERVAL_MS (test seam). */
  flushIntervalMs?: number;
  /** One warning when a cardinality cap is first hit. Must not throw (guarded anyway). */
  warn?: (message: string) => void;
  /** Runs `fn` soon, outside any trace (minute-close flush). Default: a 0 ms unref'd timer armed in runOutsideTrace. */
  defer?: (fn: () => void) => void;
  maxOperations?: number;
  maxMethods?: number;
}

interface OpAgg {
  operation: string;
  kind: ExecutionKind;
  count: number;
  errorCount: number;
  sampledCount: number;
  durationSumMs: number;
  durationMaxMs: number;
  histogram: Histogram;
}
interface MethodAgg {
  operation: string;
  className?: string;
  method?: string;
  count: number;
  errorCount: number;
  durationSumMs: number;
  durationMaxMs: number;
  selfSumMs: number;
  selfCount: number;
  histogram: Histogram;
}
interface Bucket {
  start: number;
  dirty: boolean;
  ops: Map<string, OpAgg>;
  methods: Map<string, MethodAgg>;
}

function defaultDefer(fn: () => void): void {
  runOutsideTrace(() => {
    const timer = setTimeout(fn, 0);
    timer.unref();
  });
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function opKey(name: string, kind: ExecutionKind): string {
  return `${kind}\u0000${name}`;
}

function blankMethod(operation: string, className?: string, method?: string): MethodAgg {
  const agg: MethodAgg = {
    operation,
    count: 0,
    errorCount: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
    selfSumMs: 0,
    selfCount: 0,
    histogram: emptyHistogram(),
  };
  if (className !== undefined) agg.className = className;
  if (method !== undefined) agg.method = method;
  return agg;
}

/**
 * Per-minute in-memory accumulators (plan 3.7, 9): operations (every settled root, sampled or not) and methods (spans of
 * sampled traces). At most 500 operations and 2000 methods per instance-minute (overflow goes to `(other)`), current + 2
 * previous minutes kept. `flush()` offers ONE RollupItem per dirty bucket holding that bucket's FULL aggregates (never
 * deltas), so a replacement in the queue is idempotent. `recordRoot`/`recordSpans` do O(1) work per root / span.
 */
export class RollupAccumulator {
  private readonly buckets = new Map<number, Bucket>();
  private readonly now: () => number;
  private readonly maxOps: number;
  private readonly maxMethods: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentMinute = -1;
  private closeFlushScheduled = false;
  private capWarned = false;

  constructor(private readonly opts: RollupAccumulatorOptions) {
    this.now = opts.now ?? Date.now;
    this.maxOps = opts.maxOperations ?? MAX_ROLLUP_OPERATIONS;
    this.maxMethods = opts.maxMethods ?? MAX_ROLLUP_METHODS;
  }

  /* ------------------------------ recording ------------------------------ */

  /** Operation stats for one settled root (the context guarantees exactly once per root). Never throws. */
  recordRoot(event: RollupRootEvent): void {
    try {
      const bucket = this.bucketAt(this.now(), false);
      const dur = finite(event.durationMs);
      // Keyed by what is STORED (name cut to 256): two long names sharing their first 256 chars must not yield two rows with
      // the same storage _id sha1(operation NUL kind).
      const name = event.name.slice(0, 256) || '(unnamed)';
      const key = opKey(name, event.kind);
      let agg = bucket.ops.get(key);
      if (agg === undefined) {
        agg = this.newOp(bucket, key, name, event.kind);
      }
      agg.count += 1;
      if (event.status === 'error') agg.errorCount += 1;
      if (event.sampled) agg.sampledCount += 1;
      agg.durationSumMs += dur;
      if (dur > agg.durationMaxMs) agg.durationMaxMs = dur;
      agg.histogram[bucketIndex(dur)] += 1;
      bucket.dirty = true;
    } catch {
      // never throws
    }
  }

  /**
   * Method stats from a sampled, mapped trace (call after `toTraceItem`). The root span is excluded (it is in the operation
   * rollup). Bucketed by the root's end time so a late-completing trace lands next to its operation row. A collapsed span
   * counts `collapsedCount` calls with its summed duration (one histogram entry per call, at the mean duration); calls
   * beyond `maxSpansPerTrace` are not recorded. Never throws.
   */
  recordSpans(item: TraceItem): void {
    try {
      const now = this.now();
      const started = Date.parse(item.trace.startedAt);
      const endedAt = Number.isFinite(started) ? started + finite(item.trace.durationMs) : now;
      // A trace that ended before the oldest kept bucket still counts, in the oldest kept one.
      const bucket = this.bucketAt(Math.min(endedAt, now), true);
      for (const span of item.spans) {
        if (span.parentSpanId === null) continue;
        const calls = typeof span.collapsedCount === 'number' && span.collapsedCount > 0 ? span.collapsedCount : 1;
        const dur = finite(span.durationMs);
        // Keyed by operation only: the storage _id is sha1(operation), so an auto span `A.b` and a manual trace('A.b') merge.
        const key = span.operation.slice(0, 256) || '(unnamed)';
        let agg = bucket.methods.get(key);
        if (agg === undefined) {
          agg = this.newMethod(bucket, key, span.className, span.method);
        }
        agg.count += calls;
        if (span.status === 'error') agg.errorCount += calls;
        agg.durationSumMs += dur;
        if (dur / calls > agg.durationMaxMs) agg.durationMaxMs = dur / calls;
        if (typeof span.selfDurationMs === 'number' && Number.isFinite(span.selfDurationMs)) {
          agg.selfSumMs += Math.max(0, span.selfDurationMs);
          agg.selfCount += calls;
        }
        agg.histogram[bucketIndex(dur / calls)] += calls;
      }
      bucket.dirty = true;
    } catch {
      // never throws
    }
  }

  private newOp(bucket: Bucket, key: string, name: string, kind: ExecutionKind): OpAgg {
    let storeKey = key;
    let operation = name;
    let useKind = kind;
    if (bucket.ops.size >= this.maxOps - 1) {
      // 499 real rows + one (other) row = the 500 cap.
      this.warnCap('operations');
      storeKey = opKey(OTHER_OPERATION, 'custom');
      operation = OTHER_OPERATION;
      useKind = 'custom';
      const existing = bucket.ops.get(storeKey);
      if (existing) return existing;
    }
    const agg: OpAgg = {
      operation,
      kind: useKind,
      count: 0,
      errorCount: 0,
      sampledCount: 0,
      durationSumMs: 0,
      durationMaxMs: 0,
      histogram: emptyHistogram(),
    };
    bucket.ops.set(storeKey, agg);
    return agg;
  }

  private newMethod(
    bucket: Bucket,
    key: string,
    className: string | undefined,
    method: string | undefined,
  ): MethodAgg {
    if (bucket.methods.size >= this.maxMethods - 1) {
      this.warnCap('methods');
      const otherKey = OTHER_OPERATION;
      const existing = bucket.methods.get(otherKey);
      if (existing) return existing;
      const other = blankMethod(OTHER_OPERATION);
      bucket.methods.set(otherKey, other);
      return other;
    }
    const agg = blankMethod(key, className, method);
    bucket.methods.set(key, agg);
    return agg;
  }

  private warnCap(what: string): void {
    if (this.capWarned) return;
    this.capWarned = true;
    try {
      this.opts.warn?.(
        `rollup ${what} cardinality cap reached for this minute; further distinct names are aggregated under "${OTHER_OPERATION}". ` +
          'Operation names must be static, low-cardinality labels.',
      );
    } catch {
      // diagnostics never throw
    }
  }

  /* ------------------------------- buckets ------------------------------- */

  private bucketAt(timeMs: number, allowOld: boolean): Bucket {
    const nowMinute = Math.floor(this.now() / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    if (nowMinute > this.currentMinute) {
      if (this.currentMinute !== -1) this.scheduleCloseFlush();
      this.currentMinute = nowMinute;
    }
    let start = Math.floor(timeMs / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    const oldest = this.currentMinute - ROLLUP_PREVIOUS_BUCKETS * ROLLUP_BUCKET_MS;
    if (start < oldest) start = allowOld ? oldest : this.currentMinute;
    let bucket = this.buckets.get(start);
    if (bucket === undefined) {
      bucket = { start, dirty: false, ops: new Map(), methods: new Map() };
      this.buckets.set(start, bucket);
    }
    return bucket;
  }

  /** The minute rolled over: flush soon, outside the recording call (keeps recordRoot O(1)). */
  private scheduleCloseFlush(): void {
    if (this.closeFlushScheduled) return;
    this.closeFlushScheduled = true;
    try {
      (this.opts.defer ?? defaultDefer)(() => {
        this.closeFlushScheduled = false;
        this.flush();
      });
    } catch {
      this.closeFlushScheduled = false;
    }
  }

  /* -------------------------------- flush -------------------------------- */

  /**
   * Offers one RollupItem per dirty bucket (full aggregates), then drops buckets older than current - 2 minutes. Called by
   * the 10 s timer, on minute close and at shutdown. Returns the number of items the queue accepted. Never throws.
   */
  flush(): number {
    let accepted = 0;
    try {
      const nowMinute = Math.floor(this.now() / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
      if (nowMinute > this.currentMinute) this.currentMinute = nowMinute;
      const starts = [...this.buckets.keys()].sort((a, b) => a - b);
      for (const start of starts) {
        const bucket = this.buckets.get(start)!;
        if (bucket.dirty) {
          const item = this.toItem(bucket);
          if (item === undefined) {
            bucket.dirty = false;
          } else {
            let ok = false;
            try {
              ok = this.opts.offer(item);
            } catch {
              ok = false;
            }
            if (ok) {
              bucket.dirty = false;
              accepted += 1;
            }
          }
        }
        if (start < this.currentMinute - ROLLUP_PREVIOUS_BUCKETS * ROLLUP_BUCKET_MS) {
          this.buckets.delete(start); // its last full aggregate was just offered (a refusal is counted by the queue)
        }
      }
    } catch {
      // never throws
    }
    return accepted;
  }

  private toItem(bucket: Bucket): RollupItem | undefined {
    if (bucket.ops.size === 0 && bucket.methods.size === 0) return undefined;
    const base = {
      schemaVersion: 1 as const,
      serviceName: this.opts.serviceName,
      instanceId: this.opts.instanceId,
      bucketStart: new Date(bucket.start).toISOString(),
      bucketMs: 60000 as const,
    };
    const operations: OperationRollup[] = [];
    for (const a of bucket.ops.values()) {
      operations.push({ ...base, ...a, histogram: a.histogram.slice() });
    }
    const methods: MethodRollup[] = [];
    for (const a of bucket.methods.values()) {
      methods.push({ ...base, ...a, histogram: a.histogram.slice() });
    }
    return {
      type: 'rollup',
      operations,
      methods,
      estimatedBytes: BYTES_PER_ITEM + BYTES_PER_DOC * (operations.length + methods.length),
    };
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Arms the unref'd flush timer (outside any trace). Idempotent. */
  start(): void {
    try {
      if (this.timer) return;
      this.timer = runOutsideTrace(() => {
        const timer = setInterval(() => {
          this.flush();
        }, this.opts.flushIntervalMs ?? ROLLUP_FLUSH_INTERVAL_MS);
        timer.unref();
        return timer;
      });
    } catch {
      // never throws
    }
  }

  /** Stops the timer and flushes once (call before the writer's final flush). Returns the items accepted. */
  shutdown(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    return this.flush();
  }

  /** Test aid: number of buckets held. */
  bucketCount(): number {
    return this.buckets.size;
  }
}
