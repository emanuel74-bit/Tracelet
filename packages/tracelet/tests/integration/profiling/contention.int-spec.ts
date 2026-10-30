import { describe, expect, it } from 'vitest';
import {
  CONTENTION_THRESHOLDS,
  classifyContention,
  cpuBusyBetween,
  measureContention,
  notRunMessage,
  percentileOf,
} from '../../support/profiling/contention.js';
import type { ContentionReading, CpuTimesList } from '../../support/profiling/contention.js';

const reading = (o: Partial<ContentionReading>): ContentionReading => ({ cpuBusy: 0.05, lagP99Ms: 1, lagMaxMs: 3, samples: 1000, durationMs: 1700, ...o });
const cpu = (user: number, idle: number): CpuTimesList => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];

describe('host contention classifier (T09/T10 gate)', () => {
  it('classifies a quiet host as not contended', () => {
    expect(classifyContention(reading({})).contended).toBe(false);
    expect(classifyContention(reading({ cpuBusy: 0.89, lagP99Ms: 34.9, lagMaxMs: 49.9 })).contended).toBe(false);
  });

  it('classifies each signal at its threshold as contended, with reasons', () => {
    const t = CONTENTION_THRESHOLDS;
    expect(classifyContention(reading({ cpuBusy: t.cpuBusy })).reasons[0]).toMatch(/cpuBusy/);
    expect(classifyContention(reading({ lagP99Ms: t.lagP99Ms })).reasons[0]).toMatch(/p99/);
    expect(classifyContention(reading({ lagMaxMs: t.lagMaxMs })).reasons[0]).toMatch(/max/);
    expect(classifyContention(reading({ cpuBusy: 1, lagP99Ms: 500, lagMaxMs: 900 })).reasons).toHaveLength(3);
  });

  it('honours injected thresholds', () => {
    expect(classifyContention(reading({ cpuBusy: 0.2 }), { cpuBusy: 0.1, lagP99Ms: 20, lagMaxMs: 100 }).contended).toBe(true);
  });

  it('formats the exact NOT RUN message', () => {
    expect(notRunMessage(reading({ cpuBusy: 0.987, lagP99Ms: 42.5 }))).toBe(
      'NOT RUN: host contended (cpuBusy=98.7%, lag p99=42.5 ms); T09/T10 need a quiet host, thresholds unchanged',
    );
  });

  it('computes cpu busy fraction from os.cpus() deltas', () => {
    expect(cpuBusyBetween(cpu(0, 0), cpu(750, 250))).toBeCloseTo(0.75);
    expect(cpuBusyBetween(cpu(100, 100), cpu(100, 300))).toBe(0);
    expect(cpuBusyBetween(cpu(5, 5), cpu(5, 5))).toBe(0);
  });

  it('measures with injected os and clock readings', async () => {
    let t = 0;
    let calls = 0;
    const r = await measureContention(20, {
      now: () => (t += 4), // every clock read advances 4 ms => 4 ms preemption gaps
      cpus: () => (calls++ === 0 ? cpu(0, 0) : cpu(900, 100)),
      ownCpuMs: () => 0,
    });
    expect(r.cpuBusy).toBeCloseTo(0.9);
    expect(r.lagP99Ms).toBe(4);
    expect(r.lagMaxMs).toBe(4);
    expect(classifyContention(r).contended).toBe(true);
  });

  it('percentileOf handles empty and unsorted input', () => {
    expect(percentileOf([], 0.99)).toBe(0);
    expect(percentileOf([5, 1, 3], 0.5)).toBe(3);
  });
});

describe('host contention probe on the real host', () => {
  it('returns a plausible reading', async () => {
    const r = await measureContention(300);
    expect(r.cpuBusy).toBeGreaterThanOrEqual(0);
    expect(r.cpuBusy).toBeLessThanOrEqual(1);
    expect(r.samples).toBeGreaterThan(10);
    expect(r.lagMaxMs).toBeGreaterThanOrEqual(r.lagP99Ms);
  });
});
