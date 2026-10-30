import { cpus } from 'node:os';

/**
 * Host-contention probe for the wall-clock profiler gates (T09/T10).
 *
 * Those tests assert wall-clock sample gaps (<= 250 ms) and coverage (>= 0.95). A main thread that the OS did not schedule for >250 ms
 * cannot be told apart from a sampler fault, so before the run we measure (a) the host CPU busy fraction (os.cpus() time deltas) and
 * (b) the main-thread scheduling lag (preemption gaps of a spinning clock reader). If either exceeds the thresholds below the host is 'contended'
 * and the gate is recorded as NOT RUN (never as pass). Thresholds of the gates themselves are NOT touched.
 */

export interface ContentionReading {
  /** Host-wide CPU busy fraction 0..1 over the measurement window. */
  cpuBusy: number;
  /** Main-thread preemption: p99 / max of the per-5 ms-slice largest gap between two reads of a spinning monotonic clock (ms). */
  lagP99Ms: number;
  lagMaxMs: number;
  samples: number;
  durationMs: number;
}

export interface ContentionThresholds {
  /** contended when host CPU busy fraction >= this */
  cpuBusy: number;
  /** contended when main-thread preemption gap p99 >= this (ms) */
  lagP99Ms: number;
  /** contended when a single main-thread stall >= this (ms) */
  lagMaxMs: number;
}

/** Calibrated on the 4-core dev host, see artifacts/06_CPU_PROFILE_REPORT.md ("Load-aware T09/T10 gating"). */
export const CONTENTION_THRESHOLDS: ContentionThresholds = { cpuBusy: 0.9, lagP99Ms: 35, lagMaxMs: 50 };

export interface ContentionVerdict {
  contended: boolean;
  reasons: string[];
}

export function classifyContention(r: ContentionReading, t: ContentionThresholds = CONTENTION_THRESHOLDS): ContentionVerdict {
  const reasons: string[] = [];
  if (r.cpuBusy >= t.cpuBusy) reasons.push(`cpuBusy ${pct(r.cpuBusy)}% >= ${pct(t.cpuBusy)}%`);
  if (r.lagP99Ms >= t.lagP99Ms) reasons.push(`lag p99 ${r.lagP99Ms} ms >= ${t.lagP99Ms} ms`);
  if (r.lagMaxMs >= t.lagMaxMs) reasons.push(`lag max ${r.lagMaxMs} ms >= ${t.lagMaxMs} ms`);
  return { contended: reasons.length > 0, reasons };
}

const pct = (f: number): number => Math.round(f * 1000) / 10;
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function formatReading(r: ContentionReading): string {
  return `cpuBusy=${pct(r.cpuBusy)}%, lag p99=${r.lagP99Ms} ms, lag max=${r.lagMaxMs} ms`;
}

/** The exact pre-run skip message required for T09/T10. */
export function notRunMessage(r: ContentionReading): string {
  return `NOT RUN: host contended (cpuBusy=${pct(r.cpuBusy)}%, lag p99=${r.lagP99Ms} ms); T09/T10 need a quiet host, thresholds unchanged`;
}

export type CpuTimesList = Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;

/** Busy fraction between two os.cpus() snapshots (pure; exported for tests). */
export function cpuBusyBetween(a: CpuTimesList, b: CpuTimesList): number {
  let busy = 0;
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i].times;
    const y = b[i].times;
    const idle = y.idle - x.idle;
    const all = y.user - x.user + (y.nice - x.nice) + (y.sys - x.sys) + (y.irq - x.irq) + idle;
    busy += all - idle;
    total += all;
  }
  return total > 0 ? Math.max(0, Math.min(1, busy / total)) : 0;
}

export function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export interface ProbeDeps {
  cpus: () => CpuTimesList;
  /** monotonic clock in ms */
  now: () => number;
  /** cumulative CPU ms (user+system) of this process; defaults to process.cpuUsage() */
  ownCpuMs?: () => number;
}

const realDeps: ProbeDeps = { cpus: () => cpus() as CpuTimesList, now: () => Number(process.hrtime.bigint()) / 1e6 };

/** Slice length used to turn raw spin gaps into a distribution (each slice contributes its largest gap). */
const SLICE_MS = 5;

/**
 * Measures the host for ~durationMs (default 1.7 s). The main thread spins on a monotonic clock and records the largest gap between two
 * consecutive reads per 5 ms slice: a gap is time the OS did not run this thread (preemption by other processes). A timer-based sampler
 * is NOT used because Windows timer granularity (~15 ms) would dominate the reading. The spin itself occupies one core for the probe
 * duration, which is accounted for in cpuBusy by subtracting this thread's own CPU time.
 */
export async function measureContention(durationMs = 1700, deps: ProbeDeps = realDeps): Promise<ContentionReading> {
  const cpuA = deps.cpus();
  const ownCpuMs = deps.ownCpuMs ?? ((): number => (process.cpuUsage().user + process.cpuUsage().system) / 1000);
  const own0 = ownCpuMs();
  const start = deps.now();
  const sliceMax: number[] = [];
  let last = start;
  let sliceStart = start;
  let curMax = 0;
  let max = 0;
  let t = start;
  while (t - start < durationMs) {
    t = deps.now();
    const gap = t - last;
    last = t;
    if (gap > curMax) curMax = gap;
    if (t - sliceStart >= SLICE_MS) {
      sliceMax.push(curMax);
      if (curMax > max) max = curMax;
      curMax = 0;
      sliceStart = t;
    }
  }
  const end = deps.now();
  const own = ownCpuMs() - own0;
  const cpuB = deps.cpus();
  const ownCores = own / Math.max(1, end - start);
  const cores = Math.max(1, cpuB.length);
  const rawBusy = cpuBusyBetween(cpuA, cpuB);
  const cpuBusy = Math.max(0, rawBusy - Math.min(ownCores, 1) / cores);
  return {
    cpuBusy: Math.round(cpuBusy * 1000) / 1000,
    lagP99Ms: r1(percentileOf(sliceMax, 0.99)),
    lagMaxMs: r1(max),
    samples: sliceMax.length,
    durationMs: r1(end - start),
  };
}
