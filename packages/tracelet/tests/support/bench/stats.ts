/* Paired A/B statistics for the T20 integrated bench (same style as bench/profiling/ab-overhead.int-spec.ts: Student t, 95% two-sided). */

export const round = (n: number, d = 2): number => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// two-sided 95% Student t critical values, df = 1..20 (df beyond 20 uses the df=20 value, slightly conservative)
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
/** Critical t for a sample of n paired deltas (df = n - 1). */
export const t95 = (n: number): number => T95[Math.min(Math.max(n - 1, 1), T95.length) - 1];

/** Half width of the 95% interval of the mean of `xs`; NaN for n < 2. */
export const ci95Half = (xs: number[]): number => (xs.length > 1 ? (t95(xs.length) * stdev(xs)) / Math.sqrt(xs.length) : Number.NaN);

export interface PairStats {
  n: number;
  deltas: number[];
  mean: number;
  stdev: number;
  median: number;
  ci95Half: number;
  meanWithoutFirstPair: number;
  ci95HalfWithoutFirstPair: number;
  negativePairs: number;
  /** 0 lies inside the 95% interval: the difference is not distinguishable from noise */
  withinNoise: boolean;
  /** 'bounded': all deltas positive, mean > 0 and 0 outside the interval. Otherwise the data cannot bound the overhead. */
  verdict: 'bounded' | 'cannot-bound';
  verdictReason: string;
}

/**
 * Statistics over paired deltas (on - off, in the unit of the caller: percent or absolute). With higherIsBetter (throughput) the
 * verdict judges the harmful direction (negative deltas); the reported deltas and negativePairs stay raw (negative = on lower).
 */
export function pairStats(deltas: number[], higherIsBetter = false): PairStats {
  const n = deltas.length;
  const m = mean(deltas);
  const half = ci95Half(deltas);
  const rest = deltas.slice(1);
  const negativePairs = deltas.filter(d => d < 0).length;
  const harmful = higherIsBetter ? deltas.map(d => -d) : deltas; // positive = Tracelet costs something
  const harmMean = higherIsBetter ? -m : m;
  const harmNegatives = harmful.filter(d => d < 0).length;
  const withinNoise = !(Math.abs(m) > half); // NaN half (n<2) -> within noise
  let verdict: PairStats['verdict'] = 'cannot-bound';
  let verdictReason: string;
  if (n < 2) verdictReason = 'fewer than 2 valid pairs';
  else if (harmNegatives > 0 && harmNegatives < n) verdictReason = `sign inconsistent (${harmNegatives} of ${n} pairs favour Tracelet-on)`;
  else if (harmNegatives === n) verdictReason = 'Tracelet-on looked better in every pair: no overhead can be derived (noise or confound)';
  else if (harmMean <= 0) verdictReason = 'no change or not a cost (mean harm not positive)';
  else if (withinNoise) verdictReason = '0 lies inside the 95% interval';
  else {
    verdict = 'bounded';
    verdictReason = 'all pairs positive and 0 outside the 95% interval';
  }
  return {
    n,
    deltas: deltas.map(d => round(d, 3)),
    mean: round(m, 3),
    stdev: round(stdev(deltas), 3),
    median: round(median(deltas), 3),
    ci95Half: round(half, 3),
    meanWithoutFirstPair: round(mean(rest), 3),
    ci95HalfWithoutFirstPair: round(ci95Half(rest), 3),
    negativePairs,
    withinNoise,
    verdict,
    verdictReason,
  };
}

/** Percent delta of b relative to a (0 when a is 0). */
export const pctDelta = (a: number, b: number): number => (a === 0 ? 0 : ((b - a) / a) * 100);
