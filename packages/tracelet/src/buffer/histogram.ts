import { HISTOGRAM_BOUNDS_MS, type Histogram } from '../contracts/index.js';

/** Index of the fixed duration bucket for `durationMs` (bound inclusive; non-finite or negative values land in bucket 0, huge in the last). */
export function bucketIndex(durationMs: number): number {
  if (!(durationMs > HISTOGRAM_BOUNDS_MS[0])) return 0; // NaN, negative, <= 1 ms
  // 16 bounds: a linear scan over at most 15 comparisons is O(1) and branch-predictable.
  for (let i = 1; i < HISTOGRAM_BOUNDS_MS.length - 1; i++) {
    if (durationMs <= HISTOGRAM_BOUNDS_MS[i]) return i;
  }
  return HISTOGRAM_BOUNDS_MS.length - 1;
}

export function emptyHistogram(): Histogram {
  return new Array<number>(HISTOGRAM_BOUNDS_MS.length).fill(0);
}
