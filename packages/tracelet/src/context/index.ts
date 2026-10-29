export { trace, currentTraceId } from './root-runner.js';
export {
  configureTracing,
  setTelemetryQueue,
  getRuntime,
  createRuntimeForTesting,
  resetRuntimeForTesting,
  tracingHealth,
  DEFAULT_TRACING_CONFIG,
} from './runtime.js';
export type { TracingRuntimeConfig, TraceletRuntime, RootSettledEvent, RuntimeDeps } from './runtime.js';
export { startSweeper, stopSweeper, closeAllOpenRoots, sweepOnce } from './sweeper.js';
export { TraceRegistry, toErrorPayload, createRootOnlySnapshot } from './vendor/trace-registry.js';
export type { TraceletSnapshot, ErrorPayload } from './vendor/trace-registry.js';
export { CALLER_KEY, REGISTRY_KEY, ROOT_TOKEN_KEY, TRACE_ID_KEY } from './constants.js';
export type { RootToken } from './root-token.js';
export { LogRedactor } from './vendor/log-redactor.js';
export type { RedactionOptions } from './vendor/log-redactor.js';
export { whenCompletionsIdle, MAX_IDLE_WAIT_MS } from './completion.js';
export { runAndSettle, ignoreFailure } from './settle.js';
