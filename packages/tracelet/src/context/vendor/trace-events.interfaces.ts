// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md

import type { TraceSpan } from './trace-span.interface.js';

export interface OngoingTraceEventNode extends TraceSpan {
  type: 'start';
  /** The class where the traced method is defined. Empty for root and manual spans. */
  className: string;
  /** The traced method name. Empty for root and manual spans. */
  methodKey: string;
  /** High-resolution start timestamp (performance.now()). */
  startTime: number;
  /** Milliseconds between the start of the trace root and the start of this span. Root = 0. */
  startOffset?: number;
  children: Array<CompleteTraceEventNode | OngoingTraceEventNode>;
  /** Undefined for the root node. */
  parent?: OngoingTraceEventNode;
  /** Exclusive time (ms), set by buffer/self-time.ts on completed nodes. Tracelet addition. */
  selfDuration?: number;
  /** Number of children removed because they were unfinished at pluck. Tracelet addition (self time is then omitted). */
  leftOutChildren?: number;
}

export interface CompleteTraceEventNode extends TraceSpan {
  className: string;
  methodKey: string;
  /** Duration in milliseconds (monotonic clock). */
  duration: number;
  startOffset?: number;
  children?: Array<CompleteTraceEventNode>;
  /** Exclusive time (ms), set by buffer/self-time.ts. Tracelet addition. */
  selfDuration?: number;
  /** Number of children removed because they were unfinished at pluck. Tracelet addition (self time is then omitted). */
  leftOutChildren?: number;
}
