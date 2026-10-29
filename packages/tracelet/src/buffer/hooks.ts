import type { TelemetryQueue } from '../contracts/index.js';
import type { TraceletSnapshot } from '../context/vendor/trace-registry.js';
import { toTraceItem, type MapperContext } from './record-mapper.js';
import type { RollupAccumulator, RollupRootEvent } from './rollups.js';

export interface BufferHooks {
  /** Pass as `TracingRuntimeConfig.onTraceComplete`: map, record method stats (sampled traces), offer. Throws are guarded by the caller. */
  onTraceComplete: (snapshot: TraceletSnapshot) => void;
  /** Pass as `TracingRuntimeConfig.onRootSettled`: O(1) operation rollup. */
  onRootSettled: (event: RollupRootEvent) => void;
}

/**
 * The context -> buffer hand-off, ready to spread into `configureTracing({ ...hooks })` (integration layer only wires it).
 * `onTraceComplete` runs outside any trace (deferred completion); a rootOnly record (failed unsampled root) is offered but
 * contributes no method stats.
 */
export function createBufferHooks(deps: { queue: TelemetryQueue; rollups: RollupAccumulator; mapper: MapperContext }): BufferHooks {
  return {
    onTraceComplete(snapshot) {
      const item = toTraceItem(snapshot, deps.mapper);
      if (snapshot.detail === 'full') {
        deps.rollups.recordSpans(item);
      }
      deps.queue.offer(item);
    },
    onRootSettled(event) {
      deps.rollups.recordRoot(event);
    },
  };
}
