// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md

export interface TraceSpan {
  /** Unique identifier for the trace span (uuidv7). */
  spanId?: string;
  /** Human-readable name. Used by root and manual spans. */
  name?: string;
  /**
   * - 'root': the synthetic root span of a trace (Tracelet addition).
   * - 'manual': a joined nested trace() call.
   * - 'auto': created by the instance decorator.
   */
  origin: 'root' | 'manual' | 'auto';
  /** Tags associated with the trace span. */
  tags?: Record<string, string | number | boolean>;
  /**
   * undefined: no error. true: the error propagated through this span but originated deeper (no payload).
   * object: the error originated here (first span to end with that error value).
   */
  error?:
    | boolean
    | {
        cls?: string;
        message: string;
        stack?: string;
        tags?: Record<string, string | number | boolean>;
      };
}
