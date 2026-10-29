import { createHook } from 'node:async_hooks';

/**
 * Tracks live Timeout resources (setTimeout / setInterval) through async_hooks (init adds, destroy removes). Unlike
 * process.getActiveResourcesInfo() this also sees unref'd timers, which is exactly what a leaked profiler timer would be.
 * `snapshot()` returns the ids alive now; `leakedSince(snapshot)` the ids created after it that are still alive.
 */
export class TimerLeakTracker {
  private readonly live = new Map<number, string>();
  private readonly hook = createHook({
    init: (id, type) => {
      if (type === 'Timeout') this.live.set(id, type);
    },
    destroy: (id) => {
      this.live.delete(id);
    },
  });

  constructor() {
    this.hook.enable();
  }

  snapshot(): Set<number> {
    return new Set(this.live.keys());
  }

  /** Lets destroy hooks of just-finished timers run (they fire after the callback), then lists what is still alive. */
  async leakedSince(before: Set<number>): Promise<string[]> {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const out: string[] = [];
    for (const [id, type] of this.live) if (!before.has(id)) out.push(`${type}#${id}`);
    return out;
  }

  dispose(): void {
    this.hook.disable();
    this.live.clear();
  }
}
