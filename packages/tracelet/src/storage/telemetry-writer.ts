import type { StorageHealthSource, TelemetryItem, TelemetryQueue } from '../contracts/tracelet-internal-contracts';
import { runOutsideTrace } from '../shared/als';
import { createDiagnostics } from '../shared/diagnostics';
import { retryDelay } from './retry';

export interface WriterOptions { batchItems: number; batchBytes: number; flushIntervalMs: number; retryLimit: number; shutdownTimeoutMs: number; maxWriteDocsPerSecond?: number; random?: () => number }
export interface TelemetryStore extends StorageHealthSource { write(item: TelemetryItem, beforeWrite: () => Promise<void>): Promise<void> }

/** One drained batch at a time. Each unresolved item is owned until persisted or counted once. */
export class BoundedTelemetryWriter implements StorageHealthSource {
  private stopping = false;
  private closed = false;
  private running?: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
  private deadline = Infinity;
  private nextWriteAt = 0;
  private readonly active = new Set<TelemetryItem>();
  private readonly diagnostics = createDiagnostics('TraceletStorage');
  constructor(private readonly queue: TelemetryQueue, private readonly store: TelemetryStore, private readonly options: WriterOptions) {
    if ([options.batchItems, options.batchBytes, options.flushIntervalMs, options.shutdownTimeoutMs, options.maxWriteDocsPerSecond ?? 2000].some(v => !Number.isSafeInteger(v) || v < 1) || !Number.isSafeInteger(options.retryLimit) || options.retryLimit < 0 || options.retryLimit > 10) throw new Error('invalid writer limits');
  }
  storageHealth(): ReturnType<StorageHealthSource['storageHealth']> { return this.store.storageHealth(); }
  start(): void { runOutsideTrace(() => { if (!this.running && !this.stopping) this.running = this.loop(); }); }
  flush(): Promise<void> { return runOutsideTrace(() => {
    if (this.closed) return Promise.resolve();
    const current = this.pending.then(() => this.flushBatch());
    this.pending = current.catch(() => undefined);
    return current;
  }); }
  shutdown(): Promise<void> { return runOutsideTrace(() => this.shutdownPromise ??= this.stop()); }
  private async stop(): Promise<void> {
    this.stopping = true;
    this.deadline = Date.now() + this.options.shutdownTimeoutMs;
    const final = (async () => { await this.pending; while (!this.closed && this.queue.depth() && Date.now() < this.deadline) await this.flush(); })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([final, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.shutdownTimeoutMs); })]);
    if (timer) clearTimeout(timer);
    this.closed = true;
    let dropped = this.active.size > 0;
    if (this.active.size) { this.queue.reportDropped([...this.active], 'shutdown'); this.active.clear(); }
    while (this.queue.depth()) { const items = this.queue.drain(this.options.batchItems, this.options.batchBytes); if (items.length) { dropped = true; this.queue.reportDropped(items, 'shutdown'); } }
    if (dropped) this.diagnostics.warn('shutdown', 'Telemetry dropped at the storage shutdown deadline.');
  }
  private async loop(): Promise<void> {
    while (!this.stopping) { await this.queue.waitForItems(this.options.flushIntervalMs); if (!this.stopping) await this.flush(); }
  }
  private async sleep(ms: number): Promise<void> { if (ms > 0) await new Promise<void>(resolve => setTimeout(resolve, ms)); }
  private async pace(itemDeadline: number): Promise<void> {
    await this.sleep(Math.min(Math.max(0, this.nextWriteAt - Date.now()), Math.max(0, Math.min(this.deadline, itemDeadline) - Date.now())));
    if (this.closed || Date.now() >= Math.min(this.deadline, itemDeadline)) throw new Error('writer deadline');
    this.nextWriteAt = Date.now() + 1000 / (this.options.maxWriteDocsPerSecond ?? 2000);
  }
  private async flushBatch(): Promise<void> {
    if (this.closed || Date.now() >= this.deadline) return;
    const batch = this.queue.drain(this.options.batchItems, this.options.batchBytes);
    for (const item of batch) this.active.add(item);
    const batchDeadline = Date.now() + 30000;
    for (const item of batch) {
      if (this.closed) return;
      let ok = false;
      for (let attempt = 0; attempt <= this.options.retryLimit && !this.closed && Date.now() < Math.min(batchDeadline, this.deadline); attempt++) {
        try { await this.store.write(item, () => this.pace(batchDeadline)); ok = true; break; }
        catch { if (attempt < this.options.retryLimit && !this.closed) await this.sleep(Math.min(retryDelay(attempt, this.options.random), Math.max(0, Math.min(batchDeadline, this.deadline) - Date.now()))); }
      }
      if (this.closed) return;
      if (this.active.delete(item) && !ok) {
        this.queue.reportDropped([item], this.stopping && Date.now() >= this.deadline ? 'shutdown' : 'storage');
        this.diagnostics.warn('write', 'Telemetry dropped after bounded storage write attempts.');
      }
    }
  }
}
