import { userInfo } from 'node:os';
import type { WindowRecord } from '../../../src/profiling/profiler.service.js';
import type { CodeHeavyModule } from './generate-code-heavy.js';

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoadStats {
  cpuUnits: number;
  allocChunks: number;
}

/**
 * CPU-bound loop (burnCpu in short chunks so the event loop, and therefore the sampler's timers, still run) plus a concurrent
 * allocation-heavy loop. Resolves after durationMs of wall time or when `until` returns true (checked between chunks).
 */
export async function runMixedLoad(mod: CodeHeavyModule, durationMs: number, until?: () => boolean): Promise<LoadStats> {
  const stats: LoadStats = { cpuUnits: 0, allocChunks: 0 };
  const end = Date.now() + durationMs;
  const live = (): boolean => Date.now() < end && !(until?.() ?? false);
  const cpu = (async () => {
    while (live()) {
      mod.burnCpu(25);
      stats.cpuUnits++;
      await yieldToLoop();
    }
  })();
  const alloc = (async () => {
    while (live()) {
      mod.allocateChunk(4_000);
      stats.allocChunks++;
      await yieldToLoop();
    }
  })();
  await Promise.all([cpu, alloc]);
  return stats;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export interface StallSeries {
  startStallMs: number[];
  stopStallMs: number[];
  foldMs: number[];
}

export function stallSeries(windows: WindowRecord[]): StallSeries {
  // the final window (closed by stop()) has no restart, so it is not part of the rotation series
  const w = windows.filter((r) => !r.final);
  return { startStallMs: w.map((r) => r.startStallMs), stopStallMs: w.map((r) => r.stopStallMs), foldMs: w.map((r) => r.foldMs) };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function summarizeSeries(values: number[]): { values: number[]; p50: number; max: number } {
  return { values: values.map(r2), p50: r2(percentile(values, 0.5)), max: r2(values.length ? Math.max(...values) : 0) };
}

export interface Continuity {
  windows: number;
  /** Windows that have a gapBeforeMs (every window except the first). */
  withGap: number;
  contiguous: number;
  gaps: number[];
  /** sum(sampledSpanMs) / (lastSample(last) - firstSample(first)); undefined with fewer than two windows holding samples. */
  coverage?: number;
  totalSpanMs?: number;
}

/** Plan 16 T09/T10 definitions: sample-based gaps and first-to-last-sample coverage (never startTime/endTime). */
export function continuity(windows: WindowRecord[], maxGapMs: number): Continuity {
  const withSamples = windows.filter((w) => w.firstSampleMs !== undefined && w.lastSampleMs !== undefined);
  const gaps = windows.filter((w) => w.gapBeforeMs !== undefined).map((w) => w.gapBeforeMs as number);
  let coverage: number | undefined;
  let totalSpanMs: number | undefined;
  if (withSamples.length >= 1) {
    totalSpanMs = (withSamples[withSamples.length - 1].lastSampleMs as number) - (withSamples[0].firstSampleMs as number);
    const sum = withSamples.reduce((a, w) => a + w.sampledSpanMs, 0);
    coverage = totalSpanMs > 0 ? sum / totalSpanMs : undefined;
  }
  return {
    windows: windows.length,
    withGap: gaps.length,
    contiguous: gaps.filter((g) => g <= maxGapMs).length,
    gaps: gaps.map(r2),
    ...(coverage !== undefined ? { coverage } : {}),
    ...(totalSpanMs !== undefined ? { totalSpanMs } : {}),
  };
}

/** M2: no stored frame may contain an absolute path, a drive letter, a backslash, a parent traversal or the OS user name. */
export function absolutePathViolations(items: Array<{ profile: { stacks: Array<{ stack: string }> } }>): string[] {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return '';
    }
  })();
  const bad: string[] = [];
  for (const item of items) {
    for (const s of item.profile.stacks) {
      for (const frame of s.stack.split(';')) {
        const space = frame.lastIndexOf(' ');
        const where = space === -1 ? '' : frame.slice(space + 1);
        const isBad =
          frame.includes(String.fromCharCode(92)) ||
          /(^|[ (])[A-Za-z]:\//.test(frame) ||
          where.startsWith('/') ||
          frame.includes(' ../') ||
          where.startsWith('../') ||
          (user.length > 2 && frame.toLowerCase().includes(user.toLowerCase()));
        if (isBad) bad.push(frame);
      }
    }
  }
  return bad;
}
