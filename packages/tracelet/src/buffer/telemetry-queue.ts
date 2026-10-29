import type {
  DropReason,
  MetricItem,
  QueuePool,
  RollupItem,
  TelemetryCounterName,
  TelemetryCounters,
  TelemetryItem,
  TelemetryQueue,
} from '../contracts/index.js';

export interface TelemetryQueueLimits {
  maxQueuedTraces: number;
  maxQueuedBytes: number;
  maxQueuedProfiles: number;
  maxQueuedControlItems: number;
  maxQueuedControlBytes: number;
}

export const DEFAULT_QUEUE_LIMITS: TelemetryQueueLimits = {
  maxQueuedTraces: 2000,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxQueuedProfiles: 10,
  maxQueuedControlItems: 64,
  maxQueuedControlBytes: 4 * 1024 * 1024,
};

const COUNTER_NAMES: TelemetryCounterName[] = [
  'rootsStarted',
  'rootsSampledOut',
  'tracesDroppedAdmission',
  'tracesDroppedQueueFull',
  'tracesDroppedStorage',
  'spansDropped',
  'profilesDropped',
  'rollupsDropped',
];

function emptyCounters(): TelemetryCounters {
  return {
    rootsStarted: 0,
    rootsSampledOut: 0,
    tracesDroppedAdmission: 0,
    tracesDroppedQueueFull: 0,
    tracesDroppedStorage: 0,
    spansDropped: 0,
    profilesDropped: 0,
    rollupsDropped: 0,
  };
}

interface Entry {
  seq: number;
  item: TelemetryItem;
  bytes: number;
  /** Coalescing key of a RollupItem (its bucket start). */
  key?: string;
}

interface Pool {
  entries: Map<number, Entry>;
  bytes: number;
}

function poolOf(item: TelemetryItem): QueuePool {
  return item.type === 'trace' ? 'trace' : item.type === 'profile' ? 'profile' : 'control';
}

function bytesOf(item: TelemetryItem): number {
  const n = item.estimatedBytes;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function rollupKey(item: RollupItem): string | undefined {
  return item.operations[0]?.bucketStart ?? item.methods[0]?.bucketStart;
}

/**
 * Bounded, non-blocking, single-process queue with three pools (plan 3.7, 9):
 *  - `trace`: drop-newest at maxQueuedTraces items or maxQueuedBytes;
 *  - `profile`: drop-newest at maxQueuedProfiles;
 *  - `control` (rollups + metrics, reserved capacity): evict-oldest (metrics first, then rollups), RollupItems coalesce per
 *    bucket (replace in place, keeping FIFO position), evicted MetricItem counter deltas are folded into the newest queued
 *    MetricItem or a carry-over added to the next one.
 * Also the process TelemetryCounterSink. offer/count/drain never throw and never await.
 */
export class BoundedTelemetryQueue implements TelemetryQueue {
  private readonly limits: TelemetryQueueLimits;
  private readonly pools: Record<QueuePool, Pool> = {
    trace: { entries: new Map(), bytes: 0 },
    profile: { entries: new Map(), bytes: 0 },
    control: { entries: new Map(), bytes: 0 },
  };
  private readonly totals: TelemetryCounters = emptyCounters();
  private carryOver: TelemetryCounters = emptyCounters();
  private seq = 0;
  private waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  private oversizeWarned = false;

  /**  receives rate-limited diagnostics (currently: a control item larger than the whole control pool, once). */
  constructor(
    limits: Partial<TelemetryQueueLimits> = {},
    private readonly warn?: (message: string) => void,
  ) {
    this.limits = { ...DEFAULT_QUEUE_LIMITS, ...limits };
  }

  /* ------------------------------ counters ------------------------------ */

  count(name: TelemetryCounterName, n = 1): void {
    try {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0 && name in this.totals) {
        this.totals[name] += n;
      }
    } catch {
      // never throws
    }
  }

  counters(): Readonly<TelemetryCounters> {
    return { ...this.totals };
  }

  /* -------------------------------- offer -------------------------------- */

  offer(item: TelemetryItem): boolean {
    try {
      const accepted = this.offerInternal(item);
      if (accepted) this.wake();
      return accepted;
    } catch {
      return false;
    }
  }

  private offerInternal(item: TelemetryItem): boolean {
    const pool = poolOf(item);
    const bytes = bytesOf(item);
    if (pool === 'trace') {
      const p = this.pools.trace;
      if (p.entries.size >= this.limits.maxQueuedTraces || p.bytes + bytes > this.limits.maxQueuedBytes) {
        this.count('tracesDroppedQueueFull', 1);
        return false;
      }
      this.push('trace', item, bytes);
      return true;
    }
    if (pool === 'profile') {
      if (this.pools.profile.entries.size >= this.limits.maxQueuedProfiles) {
        this.count('profilesDropped', 1);
        return false;
      }
      this.push('profile', item, bytes);
      return true;
    }
    return this.offerControl(item as RollupItem | MetricItem, bytes);
  }

  private push(pool: QueuePool, item: TelemetryItem, bytes: number, key?: string): void {
    const entry: Entry = { seq: this.seq++, item, bytes, ...(key !== undefined ? { key } : {}) };
    const p = this.pools[pool];
    p.entries.set(entry.seq, entry);
    p.bytes += bytes;
  }

  private offerControl(item: RollupItem | MetricItem, bytes: number): boolean {
    const p = this.pools.control;
    const key = item.type === 'rollup' ? rollupKey(item) : undefined;
    const existing = key !== undefined ? this.findRollup(key) : undefined;

    // A single item larger than the whole pool is rejected, counted, never admitted.
    if (bytes > this.limits.maxQueuedControlBytes) {
      this.count('rollupsDropped', 1);
      if (!this.oversizeWarned) {
        this.oversizeWarned = true;
        try {
          this.warn?.(
            `control item of ~${bytes} bytes exceeds maxQueuedControlBytes (${this.limits.maxQueuedControlBytes}); rejected. Later occurrences are only counted in rollupsDropped.`,
          );
        } catch {
          // diagnostics never throw
        }
      }
      return false;
    }

    // Make room: a replacing item frees its predecessor first.
    const freed = existing ? existing.bytes : 0;
    const extraItems = existing ? 0 : 1;
    while (
      p.entries.size + extraItems > this.limits.maxQueuedControlItems ||
      p.bytes - freed + bytes > this.limits.maxQueuedControlBytes
    ) {
      if (!this.evictOldest(existing)) {
        // nothing left to evict that is not the coalescing target
        this.count('rollupsDropped', 1);
        return false;
      }
    }

    // After eviction, so deltas folded into the carry-over by this very offer reach this item.
    const toAdd: RollupItem | MetricItem = item.type === 'metric' ? this.withCarryOver(item) : item;
    if (existing) {
      // Replace in place: keeps the FIFO position (full aggregates are idempotent replacements).
      p.bytes += bytes - existing.bytes;
      existing.item = toAdd;
      existing.bytes = bytes;
    } else {
      this.push('control', toAdd, bytes, key);
    }
    return true;
  }

  private findRollup(key: string): Entry | undefined {
    for (const entry of this.pools.control.entries.values()) {
      if (entry.key === key && entry.item.type === 'rollup') return entry;
    }
    return undefined;
  }

  /** Evicts the oldest MetricItem, else the oldest RollupItem (never `keep`). Counts rollupsDropped and folds counters. */
  private evictOldest(keep: Entry | undefined): boolean {
    const p = this.pools.control;
    let victim: Entry | undefined;
    for (const entry of p.entries.values()) {
      if (entry !== keep && entry.item.type === 'metric') {
        victim = entry;
        break;
      }
    }
    if (!victim) {
      for (const entry of p.entries.values()) {
        if (entry !== keep) {
          victim = entry;
          break;
        }
      }
    }
    if (!victim) return false;
    p.entries.delete(victim.seq);
    p.bytes -= victim.bytes;
    // The eviction itself is a drop; it lands in the next collected interval.
    this.count('rollupsDropped', 1);
    if (victim.item.type === 'metric') {
      this.foldEvictedMetric(victim.item);
    }
    return true;
  }

  /** Adds the evicted metric's counter deltas to the newest queued MetricItem, else to the carry-over. */
  private foldEvictedMetric(evicted: MetricItem): void {
    let newest: Entry | undefined;
    for (const entry of this.pools.control.entries.values()) {
      if (entry.item.type === 'metric') newest = entry;
    }
    if (newest) {
      const target = newest.item as MetricItem;
      newest.item = {
        ...target,
        metric: { ...target.metric, telemetry: addCounters(target.metric.telemetry, evicted.metric.telemetry) },
      };
    } else {
      this.carryOver = addCounters(this.carryOver, evicted.metric.telemetry);
    }
  }

  private withCarryOver(item: MetricItem): MetricItem {
    if (COUNTER_NAMES.every((name) => this.carryOver[name] === 0)) return item;
    const merged: MetricItem = {
      ...item,
      metric: { ...item.metric, telemetry: addCounters(item.metric.telemetry, this.carryOver) },
    };
    this.carryOver = emptyCounters();
    return merged;
  }

  /* -------------------------------- drain -------------------------------- */

  drain(maxItems: number, maxBytes: number): TelemetryItem[] {
    const out: TelemetryItem[] = [];
    try {
      let bytes = 0;
      while (out.length < maxItems) {
        const found = this.oldestEntry();
        if (!found) break;
        const head = found.entry;
        if (head.bytes > maxBytes) {
          // Larger than a batch on its own: dropped and counted so a non-empty queue never yields an empty batch forever.
          this.removeEntry(found);
          this.reportDropped([head.item], 'storage');
          continue;
        }
        if (bytes + head.bytes > maxBytes) break;
        this.removeEntry(found);
        out.push(head.item);
        bytes += head.bytes;
      }
    } catch {
      // never throws
    }
    return out;
  }

  private oldestEntry(): { entry: Entry; pool: QueuePool } | undefined {
    let best: { entry: Entry; pool: QueuePool } | undefined;
    for (const pool of ['trace', 'profile', 'control'] as const) {
      const first = this.pools[pool].entries.values().next();
      if (!first.done && (best === undefined || first.value.seq < best.entry.seq)) {
        best = { entry: first.value, pool };
      }
    }
    return best;
  }

  private removeEntry(found: { entry: Entry; pool: QueuePool }): void {
    const p = this.pools[found.pool];
    p.entries.delete(found.entry.seq);
    p.bytes -= found.entry.bytes;
  }

  reportDropped(items: readonly TelemetryItem[], reason: DropReason): void {
    try {
      for (const item of items) {
        if (item.type === 'trace') {
          this.count(
            reason === 'queueFull'
              ? 'tracesDroppedQueueFull'
              : reason === 'admission'
                ? 'tracesDroppedAdmission'
                : 'tracesDroppedStorage',
            1,
          );
        } else if (item.type === 'profile') {
          this.count('profilesDropped', 1);
        } else {
          this.count('rollupsDropped', 1);
        }
      }
    } catch {
      // never throws
    }
  }

  /* ----------------------------- introspection ----------------------------- */

  depth(pool?: QueuePool): number {
    if (pool) return this.pools[pool].entries.size;
    return this.pools.trace.entries.size + this.pools.profile.entries.size + this.pools.control.entries.size;
  }

  estimatedBytes(pool?: QueuePool): number {
    if (pool) return this.pools[pool].bytes;
    return this.pools.trace.bytes + this.pools.profile.bytes + this.pools.control.bytes;
  }

  /* ------------------------------- waiting ------------------------------- */

  waitForItems(timeoutMs: number): Promise<void> {
    if (this.depth() > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve();
      }, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0));
      timer.unref();
      this.waiters.push({ resolve, timer });
    });
  }

  private wake(): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

function addCounters(a: Readonly<TelemetryCounters>, b: Readonly<TelemetryCounters>): TelemetryCounters {
  const out = emptyCounters();
  for (const name of COUNTER_NAMES) {
    out[name] = (a[name] ?? 0) + (b[name] ?? 0);
  }
  return out;
}
