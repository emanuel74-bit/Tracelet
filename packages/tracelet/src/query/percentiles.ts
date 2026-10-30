import { HISTOGRAM_BOUNDS_MS } from '../contracts/observe-contracts';
export const percentile = (hist: number[], fraction: number): number | undefined => {
  const total = hist.reduce((a, b) => a + b, 0); if (!total) return undefined;
  const target = Math.ceil(total * fraction); let seen = 0;
  for (let i = 0; i < hist.length; i++) { seen += hist[i]; if (seen >= target) return Number.isFinite(HISTOGRAM_BOUNDS_MS[i]) ? HISTOGRAM_BOUNDS_MS[i] : undefined; }
  return undefined;
};
