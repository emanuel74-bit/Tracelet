// Public API of the `tracelet` package. Explicit named re-exports only (no `export *`), so that Node's cjs-module-lexer detects
// every name when an ESM application imports this CommonJS package.
export { trace, currentTraceId } from './context/root-runner';
export { TraceletInstrument, createTraceletInstrument } from './instrumentation/instrument';
export { TraceletModule } from './tracelet.module';
export { Tracelet } from './tracelet';
export { TRACELET_VERSION as version } from './version';

export type {
  ExecutionKind,
  Attributes,
  AttributeValue,
  TraceOptions,
  TraceFn,
  CurrentTraceIdFn,
  TraceletInstrumentOptions,
  RedactionOptions,
  TraceletModuleOptions,
} from './contracts';
export type { TraceletAuthRequest, TraceletSetupOptions, TraceletStandaloneServerOptions } from './contracts/observe-contracts';
export type { StandaloneServer } from './http/standalone-server';
export type { TraceletModuleAsyncOptions } from './tracelet.module';
