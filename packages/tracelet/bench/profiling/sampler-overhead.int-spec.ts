import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../src/buffer/index.js';
import { ContinuousProfiler } from '../../src/profiling/index.js';
import type { ProfilerDebug } from '../../src/profiling/index.js';
import { generateCodeHeavy } from '../../tests/support/profiling/generate-code-heavy.js';
import type { CodeHeavyModule } from '../../tests/support/profiling/generate-code-heavy.js';
import { stallSeries, summarizeSeries } from '../../tests/support/profiling/load.js';

/* T20 seed / R5: fixed CPU work units with the sampler off vs on, on the code-heavy fixture. No pass/fail threshold. */

const WINDOW_MS = 5000;
const RUN_MS = 16_000; // three full rotations per "on" run
const ROUNDS = 2; // off, on, off, on

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const r = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

async function runMode(mod: CodeHeavyModule, sampler: boolean) {
  const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
  const profiler = new ContinuousProfiler(
    { enabled: sampler, sampleRateHz: 99, windowMs: WINDOW_MS },
    { queue, serviceName: 'bench', instanceId: 'bench-1' },
  );
  await profiler.start();
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  let units = 0;
  let allocs = 0;
  while (performance.now() - t0 < RUN_MS) {
    mod.work(5);
    units += 5;
    if (units % 50 === 0) {
      mod.allocateChunk(2_000);
      allocs++;
    }
    await yieldToLoop();
  }
  const wallMs = performance.now() - t0;
  const elu = performance.eventLoopUtilization(elu0).utilization;
  delay.disable();
  const debug: ProfilerDebug = profiler.debug();
  await profiler.stop();
  const full = stallSeries(debug.windows);
  return {
    sampler,
    wallMs: r(wallMs, 1),
    workUnits: units,
    allocChunks: allocs,
    unitsPerSecond: r(units / (wallMs / 1000), 1),
    eventLoopUtilization: r(elu, 4),
    eventLoopDelayMs: { p50: r(delay.percentile(50) / 1e6), p99: r(delay.percentile(99) / 1e6), max: r(delay.max / 1e6) },
    windows: debug.windows.length,
    stallSeries: sampler
      ? { startStallMs: summarizeSeries(full.startStallMs), stopStallMs: summarizeSeries(full.stopStallMs), foldMs: summarizeSeries(full.foldMs) }
      : undefined,
  };
}

describe('T20 seed: CPU sampler overhead', () => {
  it('measures throughput, ELU, event-loop delay and the stall series, sampler off vs on, and writes artifacts/02_bench_profiler.json', async () => {
    const fixture = generateCodeHeavy(12_000);
    try {
      await runMode(fixture.module, false); // warm-up (JIT), discarded
      const runs: Awaited<ReturnType<typeof runMode>>[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        runs.push(await runMode(fixture.module, false));
        runs.push(await runMode(fixture.module, true));
      }
      const off = runs.filter((x) => !x.sampler);
      const on = runs.filter((x) => x.sampler);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const offRate = mean(off.map((x) => x.unitsPerSecond));
      const onRate = mean(on.map((x) => x.unitsPerSecond));
      const allStalls = {
        startStallMs: on.flatMap((x) => x.stallSeries!.startStallMs.values),
        stopStallMs: on.flatMap((x) => x.stallSeries!.stopStallMs.values),
        foldMs: on.flatMap((x) => x.stallSeries!.foldMs.values),
      };
      const out = resolve(process.cwd(), '../../artifacts/02_bench_profiler.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            node: process.version,
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            platform: process.platform,
            fixture: { generatedFunctions: fixture.module.functionCount },
            config: { sampleRateHz: 99, windowMs: WINDOW_MS, runMs: RUN_MS, rounds: ROUNDS, order: 'off, on, off, on (one discarded off warm-up first)' },
            summary: {
              meanUnitsPerSecondOff: r(offRate, 1),
              meanUnitsPerSecondOn: r(onRate, 1),
              throughputDeltaPercent: r(((onRate - offRate) / offRate) * 100),
              stallSeriesAllOnRuns: {
                startStallMs: summarizeSeries(allStalls.startStallMs),
                stopStallMs: summarizeSeries(allStalls.stopStallMs),
                foldMs: summarizeSeries(allStalls.foldMs),
              },
            },
            runs,
          },
          null,
          2,
        ),
      );
      expect(on.every((x) => x.windows >= 3)).toBe(true);
      expect(off.every((x) => x.windows === 0)).toBe(true);
    } finally {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }, 300_000);
});
