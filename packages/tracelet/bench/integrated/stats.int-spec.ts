import { describe, expect, it } from 'vitest';
import { ci95Half, mean, median, pairStats, pctDelta, stdev, t95 } from '../../tests/support/bench/stats.js';

/* Fast, always-on check of the paired statistics used by the (gated) integrated overhead bench. No processes, no Mongo. */
describe('integrated bench paired statistics', () => {
  it('computes mean/median/stdev/t95 as in ab-overhead', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(t95(6)).toBe(2.571);
    expect(ci95Half([1, 3])).toBeCloseTo((12.706 * Math.SQRT2) / Math.SQRT2, 3);
    expect(pctDelta(100, 110)).toBeCloseTo(10, 6);
    expect(pctDelta(0, 5)).toBe(0);
  });

  it('bounds only a consistently positive, distinguishable delta', () => {
    const s = pairStats([10, 11, 9, 10, 12, 10]);
    expect(s.verdict).toBe('bounded');
    expect(s.negativePairs).toBe(0);
    expect(s.withinNoise).toBe(false);
    expect(s.meanWithoutFirstPair).toBeCloseTo(10.4, 3);
  });

  it('refuses to bound sign-inconsistent, all-negative, noisy or tiny samples', () => {
    expect(pairStats([5, -3, 4, -2, 6, 1]).verdict).toBe('cannot-bound');
    expect(pairStats([5, -3, 4, -2, 6, 1]).verdictReason).toMatch(/sign inconsistent/);
    expect(pairStats([-1, -2, -1.5, -1, -2, -1]).verdictReason).toMatch(/better in every pair/);
    expect(pairStats([0.1, 5, 0.2, 7, 0.1, 9]).verdict).toBe('cannot-bound'); // all positive but 0 inside the interval
    // throughput (higher is better): consistently lower with Tracelet is a real cost, consistently higher is not
    expect(pairStats([-10, -11, -9, -10, -12, -10], true).verdict).toBe('bounded');
    expect(pairStats([10, 11, 9, 10, 12, 10], true).verdictReason).toMatch(/better in every pair/);
    expect(pairStats([4]).verdict).toBe('cannot-bound');
    expect(pairStats([]).n).toBe(0);
  });
});
