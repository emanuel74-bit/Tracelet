import './simulate-node20-win.js'; // side effect first: TRACELET_SIMULATE_NODE20_WIN=1 fakes the affected V8 before the gate is evaluated
import { samplerBusyWaitReason } from '../../../src/profiling/vendor/cpu-sampler.js';

/** Why a real-inspector sampler test cannot run on this runtime at the default rate (CR-002), or undefined. */
export const BUSY_WAIT_REASON: string | undefined = samplerBusyWaitReason(99);

export const NOT_RUN_MESSAGE: string | undefined = BUSY_WAIT_REASON
  ? `NOT RUN: Node 20 on Windows busy-waits the V8 sampler thread, CR-002 (${BUSY_WAIT_REASON})`
  : undefined;

/**
 * Skips (never passes) a test that needs a running real sampler at the default rate on an affected runtime. T09/T10 thresholds are
 * NOT lowered and the test is NOT silently run at 9 Hz: the combination is recorded as NOT RUN.
 */
export function skipIfBusyWait(ctx: { skip: (note?: string) => never }): void {
  if (NOT_RUN_MESSAGE) {
    console.warn(NOT_RUN_MESSAGE);
    ctx.skip(NOT_RUN_MESSAGE);
  }
}
