import { BoundedTelemetryQueue, createBufferHooks, RollupAccumulator, toTraceItem } from '../../../src/buffer/index.js';
import type { TelemetryQueueLimits } from '../../../src/buffer/index.js';
import {
  createRuntimeForTesting,
  LogRedactor,
  resetRuntimeForTesting,
  type RuntimeDeps,
  type TraceletRuntime,
  type TracingRuntimeConfig,
} from '../../../src/context/index.js';
import type { ObserveSpan, RollupItem, TraceItem } from '../../../src/contracts/index.js';
import { sleep } from './orders-app.js';

export interface Harness {
  rt: TraceletRuntime;
  queue: BoundedTelemetryQueue;
  /** All trace items produced so far (drained from the queue). */
  items: TraceItem[];
  /** Rollup accumulator wired through createBufferHooks (only with `rollups: true`). */
  rollups?: RollupAccumulator;
  /** Rollup items drained so far (only with `rollups: true`). */
  rollupItems: RollupItem[];
  /** Waits until all scheduled completions finished and the registry is empty, then collects the queue. */
  settle(timeoutMs?: number): Promise<TraceItem[]>;
  stop(): void;
}

export interface HarnessOptions {
  tracing?: Partial<TracingRuntimeConfig>;
  queue?: Partial<TelemetryQueueLimits>;
  errorMessages?: 'redacted' | 'omit';
  completionTimeoutMs?: number;
  runtime?: Omit<RuntimeDeps, 'sink' | 'config'>;
  /** Wire the real buffer hooks (mapper + RollupAccumulator) instead of the mapper-only hook. */
  rollups?: boolean;
  mapper?: { maxSpansPerTrace?: number; spanCollapse?: false | { threshold: number; keepSlowest: number } };
}

/** Wires runtime + real mapper + bounded queue, the same hand-off the integration layer will do. */
export function startHarness(options: HarnessOptions = {}): Harness {
  const queue = new BoundedTelemetryQueue(options.queue);
  const redactor = new LogRedactor();
  const items: TraceItem[] = [];
  const rollupItems: RollupItem[] = [];
  const mapper = {
    serviceName: 'poc',
    instanceId: 'poc-instance',
    errorMessages: options.errorMessages ?? ('redacted' as const),
    redactor,
    ...options.mapper,
  };
  const rollups = options.rollups
    ? new RollupAccumulator({ serviceName: 'poc', instanceId: 'poc-instance', offer: (i) => queue.offer(i), defer: () => {} })
    : undefined;
  const hooks = rollups ? createBufferHooks({ queue, rollups, mapper }) : undefined;
  const rt = createRuntimeForTesting({
    ...options.runtime,
    sink: queue,
    ...(options.completionTimeoutMs !== undefined ? { completionTimeoutMs: options.completionTimeoutMs } : {}),
    config: {
      enabled: true,
      sampleRate: 1,
      maxRootsPerSecond: 100_000,
      ...options.tracing,
      ...(hooks ?? {
        onTraceComplete: (snapshot: Parameters<typeof toTraceItem>[0]) => {
          queue.offer(toTraceItem(snapshot, mapper));
        },
      }),
    },
  });
  const collect = (): void => {
    for (const item of queue.drain(1_000_000, Number.MAX_SAFE_INTEGER)) {
      if (item.type === 'trace') items.push(item);
      else if (item.type === 'rollup') rollupItems.push(item);
    }
  };
  return {
    rt,
    queue,
    items,
    ...(rollups ? { rollups } : {}),
    rollupItems,
    async settle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      // Two quiet polls in a row: completions may schedule nothing further, but timers need a turn to be armed.
      let quiet = 0;
      while (quiet < 2) {
        if (Date.now() > deadline) throw new Error('harness.settle timed out');
        await sleep(5);
        quiet = rt.pendingCompletions === 0 && rt.registry.openTraceCount() === 0 ? quiet + 1 : 0;
      }
      collect();
      return items;
    },
    stop() {
      resetRuntimeForTesting();
    },
  };
}

export interface SpanTree {
  operation: string;
  origin?: string;
  status: string;
  children: SpanTree[];
}

/** Nested view of a flattened trace (children in start-offset order). */
export function spanTree(item: TraceItem): SpanTree {
  const byParent = new Map<string | null, ObserveSpan[]>();
  for (const span of item.spans) {
    const list = byParent.get(span.parentSpanId) ?? [];
    list.push(span);
    byParent.set(span.parentSpanId, list);
  }
  const build = (span: ObserveSpan): SpanTree => ({
    operation: span.operation,
    ...(span.origin !== undefined ? { origin: span.origin } : {}),
    status: span.status,
    children: (byParent.get(span.spanId) ?? [])
      .slice()
      .sort((a, b) => a.startOffsetMs - b.startOffsetMs)
      .map(build),
  });
  return build(byParent.get(null)![0]);
}

/** Operations in a tree, depth-first, as `a > b > c` paths. */
export function operationPaths(tree: SpanTree, prefix = ''): string[] {
  const path = prefix ? `${prefix} > ${tree.operation}` : tree.operation;
  return [path, ...tree.children.flatMap((c) => operationPaths(c, path))];
}
