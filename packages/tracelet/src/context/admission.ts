/** Head sampler + token bucket + open-trace cap (plan 3.5, 9). */
export interface AdmissionConfig {
  sampleRate: number;
  maxRootsPerSecond: number;
  maxOpenTraces: number;
}

export class Admission {
  private tokens: number | undefined;
  private last = 0;

  constructor(
    private readonly cfg: () => AdmissionConfig,
    private readonly openTraces: () => number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Head sampling decision. */
  shouldSample(): boolean {
    const rate = this.cfg().sampleRate;
    if (rate >= 1) return true;
    if (!(rate > 0)) return false;
    return Math.random() < rate;
  }

  /** Token bucket, refilled per millisecond. Shared by sampled roots and rootOnly failure records. */
  takeToken(): boolean {
    const perSecond = this.cfg().maxRootsPerSecond;
    const capacity = Math.max(1, perSecond);
    const t = this.now();
    if (this.tokens === undefined) {
      this.tokens = capacity;
    } else {
      this.tokens = Math.min(capacity, this.tokens + ((t - this.last) * perSecond) / 1000);
    }
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** false when open traces reached maxOpenTraces. */
  hasCapacity(): boolean {
    return this.openTraces() < this.cfg().maxOpenTraces;
  }
}
