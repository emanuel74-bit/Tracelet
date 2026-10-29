export { BoundedTelemetryQueue, DEFAULT_QUEUE_LIMITS } from './telemetry-queue.js';
export type { TelemetryQueueLimits } from './telemetry-queue.js';
export { toTraceItem } from './record-mapper.js';
export type { MapperContext } from './record-mapper.js';
export { computeSelfTimes } from './self-time.js';
export { sanitizeError, fingerprint } from './error-sanitizer.js';
export { boundAttributes } from './attributes.js';
// RollupAccumulator (src/buffer/rollups.ts) is not part of Mission 02 slice A.
