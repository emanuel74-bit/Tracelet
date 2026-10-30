import type { HeartbeatFactory } from '../contracts/tracelet-internal-contracts';
import { runOutsideTrace } from '../shared/als';
import { createDiagnostics } from '../shared/diagnostics';
import type { MongoTelemetryStore } from './documents';
import { retryDelay } from './retry';

/** No overlapping heartbeat writes; timers and factories inherit no business trace. */
export class HeartbeatWriter {
  private stopped = false;
  private started = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private readonly diagnostics = createDiagnostics('TraceletStorage');
  constructor(private readonly store: Pick<MongoTelemetryStore, 'writeHeartbeat'>, private readonly factory: HeartbeatFactory) {}
  start(): void { runOutsideTrace(() => { if (!this.stopped && !this.started) { this.started = true; this.schedule(0); } }); }
  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      let delay = 30000;
      this.pending = Promise.resolve().then(() => this.store.writeHeartbeat(this.factory())).then(() => { this.failures = 0; }).catch(() => { delay = retryDelay(this.failures++); this.diagnostics.warn('heartbeat', 'Instance heartbeat could not be persisted.'); });
      void this.pending.finally(() => { if (!this.stopped) this.schedule(delay); });
    }, ms);
    this.timer.unref?.();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
