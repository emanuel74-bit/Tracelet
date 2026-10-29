export { BoundedTelemetryQueue, DEFAULT_QUEUE_LIMITS } from './telemetry-queue.js';
export type { TelemetryQueueLimits } from './telemetry-queue.js';
export { toTraceItem } from './record-mapper.js';
export type { MapperContext } from './record-mapper.js';
export { computeSelfTimes } from './self-time.js';
export { sanitizeError, fingerprint } from './error-sanitizer.js';
export { boundAttributes } from './attributes.js';
export { bucketIndex, emptyHistogram } from './histogram.js';
export {
  RollupAccumulator,
  ROLLUP_FLUSH_INTERVAL_MS,
  ROLLUP_BUCKET_MS,
  MAX_ROLLUP_OPERATIONS,
  MAX_ROLLUP_METHODS,
  OTHER_OPERATION,
} from './rollups.js';
export type { RollupAccumulatorOptions, RollupRootEvent } from './rollups.js';
export { createBufferHooks } from './hooks.js';
export type { BufferHooks } from './hooks.js';
