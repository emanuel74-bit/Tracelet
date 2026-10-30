import { QueryError } from '../query/filters';

/** One process-wide budget for expensive API queries, shared by service facades. */
export class ConcurrencyLimiter {
  private active = 0;
  constructor(private readonly limit = 4) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) throw new QueryError('RATE_LIMITED', 429, 'Too many concurrent queries');
    this.active++;
    try { return await fn(); } finally { this.active--; }
  }
}
export const heavyQueryLimiter = new ConcurrencyLimiter();
