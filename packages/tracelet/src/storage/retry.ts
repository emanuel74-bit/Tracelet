/** Accepted full-jitter backoff, bounded at 8 s. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.floor(Math.min(8000, 500 * 2 ** attempt) * Math.max(0, Math.min(1, random())));
}
