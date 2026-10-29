import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../src/buffer/index.js';
import type { ProfileItem } from '../../src/contracts/index.js';
import { ContinuousProfiler } from '../../src/profiling/index.js';
import { samplerBusyWaitReason } from '../../src/profiling/vendor/cpu-sampler.js';
import type { ProfilerDebug } from '../../src/profiling/index.js';
import { generateCodeHeavy } from '../../tests/support/profiling/generate-code-heavy.js';
import type { CodeHeavyModule } from '../../tests/support/profiling/generate-code-heavy.js';
import { stallSeries, summarizeSeries } from '../../tests/support/profiling/load.js';
import { burn, createOrdersApp } from '../../tests/support/instrumentation/orders-app.js';
import type { OrdersApp } from '../../tests/support/instrumentation/orders-app.js';

/*
 * T20 (Mission 06): sampler OFF vs ON, alternating A/B pairs, on (a) idle and (b) CPU-intensive load, on the code-heavy fixture
 * and on a small Nest application workload (tests/support/instrumentation/orders-app.ts, unmodified). No pass/fail threshold on
 * performance; the numbers are written to artifacts/06_bench_profiler_ab_node<major>.json.
 *
 * Gated: runs only with TRACELET_BENCH_AB=1 (it takes many minutes). Knobs: TRACELET_BENCH_PAIRS (default 6), TRACELET_BENCH_RUN_MS
 * (8000), TRACELET_BENCH_WINDOW_MS (4000), TRACELET_BENCH_SCENARIOS (comma list, default all), TRACELET_BENCH_HEAP_MB (300).
 */

const ENABLED = process.env.TRACELET_BENCH_AB === '1';
const PAIRS = Number(process.env.TRACELET_BENCH_PAIRS ?? 6);
const RUN_MS = Number(process.env.TRACELET_BENCH_RUN_MS ?? 8000);
const WINDOW_MS = Number(process.env.TRACELET_BENCH_WINDOW_MS ?? 4000);
const HEAP_MB = Number(process.env.TRACELET_BENCH_HEAP_MB ?? 300);
const ONLY = (process.env.TRACELET_BENCH_SCENARIOS ?? '').split(',').filter(Boolean);

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const r = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
// two-sided 95% Student t critical values, df = 1..12
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179];
const t95 = (n: number): number => T95[Math.min(Math.max(n - 1, 1), T95.length) - 1];

interface RunResult {
  mode: 'off' | 'on';
  wallMs: number;
  /** Work done (units for cpu scenarios, ticks for idle). */
  work: number;
  workPerSecond: number;
  /** (user + system) process CPU time / wall time, all threads (includes the inspector's sampling thread). */
  cpuFraction: number;
  cpuMs: number;
  /** Process CPU time (all threads) per unit of work: the primary profiler-cost metric (CR-002; wall throughput is not valid for timer-paced rows on win32). */
  cpuMsPerUnit: number;
  rssMb: number;
  heapUsedMb: number;
  eventLoopUtilization: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  windows: number;
  stalls?: { startStallMs: ReturnType<typeof summarizeSeries>; stopStallMs: ReturnType<typeof summarizeSeries>; foldMs: ReturnType<typeof summarizeSeries>; keepAliveMs: ReturnType<typeof summarizeSeries> };
  achievedSampleRateHz?: number[];
  frames?: FrameStats;
}

interface FrameStats {
  profiles: number;
  samples: number;
  idleSamples: number;
  idleShare: number;
  programShare: number;
  gcShare: number;
  anonymousLeafShare: number;
  /** leaf frames without a script path other than (program)/(garbage collector): native or builtin frames, by name. */
  nativeLeafShare: number;
  droppedSampleCount: number;
}

function frameStats(items: ProfileItem[]): FrameStats {
  let samples = 0;
  let idle = 0;
  let program = 0;
  let gc = 0;
  let anon = 0;
  let native = 0;
  let dropped = 0;
  for (const it of items) {
    samples += it.profile.sampleCount;
    idle += it.profile.idleSampleCount ?? 0;
    dropped += it.profile.droppedSampleCount ?? 0;
    for (const s of it.profile.stacks) {
      const leaf = s.stack.slice(s.stack.lastIndexOf(';') + 1);
      if (leaf === '(program)') program += s.samples;
      else if (leaf === '(garbage collector)') gc += s.samples;
      else if (leaf.startsWith('(anonymous)')) anon += s.samples;
      else if (!/ \S+:\d+$/.test(leaf)) native += s.samples;
    }
  }
  const total = samples + idle;
  const share = (n: number, d: number): number => (d > 0 ? r(n / d, 4) : 0);
  return {
    profiles: items.length,
    samples,
    idleSamples: idle,
    idleShare: share(idle, total),
    programShare: share(program, samples),
    gcShare: share(gc, samples),
    anonymousLeafShare: share(anon, samples),
    nativeLeafShare: share(native, samples),
    droppedSampleCount: dropped,
  };
}

interface Workload {
  name: string;
  kind: 'cpu' | 'idle';
  /** Runs for runMs, returns the amount of work done. */
  run(runMs: number): Promise<number>;
}

async function once(w: Workload, sampler: boolean, runMs: number, windowMs: number, keepAlive: boolean = true): Promise<RunResult> {
  const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 1000 });
  const profiler = new ContinuousProfiler(
    { enabled: sampler, sampleRateHz: 99, windowMs },
    { queue, serviceName: 'bench', instanceId: 'bench-1', ...(keepAlive ? {} : { createKeepAlive: null }) },
  );
  await profiler.start();
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const work = await w.run(runMs);
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const elu = performance.eventLoopUtilization(elu0).utilization;
  delay.disable();
  const mem = process.memoryUsage();
  const debug: ProfilerDebug = profiler.debug();
  await profiler.stop();
  const series = stallSeries(debug.windows);
  const items = queue.drain(10_000, 1e10).filter((i): i is ProfileItem => i.type === 'profile');
  const achieved = debug.windows.filter((x) => x.achievedSampleRateHz !== undefined).map((x) => r(x.achievedSampleRateHz as number));
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    mode: sampler ? 'on' : 'off',
    wallMs: r(wallMs, 1),
    work,
    workPerSecond: r(work / (wallMs / 1000), 2),
    cpuFraction: r(cpuMs / wallMs, 4),
    cpuMs: r(cpuMs, 1),
    cpuMsPerUnit: r(work > 0 ? cpuMs / work : 0, 4),
    rssMb: r(mem.rss / 1048576, 1),
    heapUsedMb: r(mem.heapUsed / 1048576, 1),
    eventLoopUtilization: r(elu, 4),
    eventLoopDelayMs: { p50: r(delay.percentile(50) / 1e6), p99: r(delay.percentile(99) / 1e6), max: r(delay.max / 1e6) },
    windows: debug.windows.length,
    ...(sampler
      ? {
          stalls: {
            startStallMs: summarizeSeries(series.startStallMs),
            stopStallMs: summarizeSeries(series.stopStallMs),
            foldMs: summarizeSeries(series.foldMs),
            keepAliveMs: summarizeSeries(debug.windows.filter((x) => !x.final).map((x) => x.keepAliveMs)),
          },
          achievedSampleRateHz: achieved,
          frames: frameStats(items),
        }
      : {}),
  };
}

function summarizePairs(runs: RunResult[], higherIsBetter: boolean) {
  const off = runs.filter((x) => x.mode === 'off');
  const on = runs.filter((x) => x.mode === 'on');
  const metric = (f: (x: RunResult) => number) => {
    const deltas = off.map((o, i) => {
      const a = f(o);
      const b = f(on[i]);
      return a === 0 ? 0 : ((b - a) / a) * 100;
    });
    const m = mean(deltas);
    const sd = stdev(deltas);
    const half = deltas.length > 1 ? (t95(deltas.length) * sd) / Math.sqrt(deltas.length) : Number.NaN;
    const sorted = deltas.slice().sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
    const rest = deltas.slice(1);
    const halfRest = rest.length > 1 ? (t95(rest.length) * stdev(rest)) / Math.sqrt(rest.length) : Number.NaN;
    const negativePairs = deltas.filter((d) => d < 0).length;
    return {
      meanOff: r(mean(off.map(f)), 3),
      meanOn: r(mean(on.map(f)), 3),
      stdevOff: r(stdev(off.map(f)), 3),
      stdevOn: r(stdev(on.map(f)), 3),
      pairDeltaPercent: deltas.map((d) => r(d)),
      meanDeltaPercent: r(m),
      stdevDeltaPercent: r(sd),
      medianDeltaPercent: r(median),
      /** same statistics with the first pair dropped (it often carries JIT / warm-up noise) */
      meanDeltaPercentWithoutFirstPair: r(mean(rest)),
      ci95HalfWidthPercentWithoutFirstPair: r(halfRest),
      pairsWithNegativeDelta: negativePairs,
      ci95HalfWidthPercent: r(half),
      /** true when 0 lies inside the 95% interval of the paired deltas: the difference is NOT distinguishable from noise */
      withinNoise: !(Math.abs(m) > half),
    };
  };
  return {
    pairs: off.length,
    higherIsBetter,
    workPerSecond: metric((x) => x.workPerSecond),
    cpuMsPerUnit: metric((x) => x.cpuMsPerUnit),
    cpuFraction: metric((x) => x.cpuFraction),
    rssMb: metric((x) => x.rssMb),
    heapUsedMb: metric((x) => x.heapUsedMb),
    eventLoopDelayP99Ms: metric((x) => x.eventLoopDelayMs.p99),
    eventLoopDelayMaxMs: metric((x) => x.eventLoopDelayMs.max),
    eventLoopUtilization: metric((x) => x.eventLoopUtilization),
  };
}

function across(runs: RunResult[], pick: (s: NonNullable<RunResult['stalls']>) => ReturnType<typeof summarizeSeries>) {
  const all = runs.filter((x) => x.stalls).flatMap((x) => pick(x.stalls!).values);
  return summarizeSeries(all);
}

/** Host busy percentage over ~1 s (os.cpus times; os.loadavg is always 0 on Windows). Recorded so a loaded host is visible. */
async function hostBusyPercent(ms = 1000): Promise<number> {
  const snap = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 });
  const a = snap();
  await sleep(ms);
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? r((1 - (b.idle - a.idle) / total) * 100, 1) : 0;
}

/** Rows whose load is paced by setTimeout: on win32 the sampler changes timer granularity (CR-002), so wall throughput and event-loop delay of these rows are NOT valid overhead measures. */
const TIMER_PACED = new Set(['codeheavy-idle', 'nest-cpu', 'nest-idle']);
const IDLE_CPU_GATE = 0.1;

describe.skipIf(!ENABLED)('T20 (M06): sampler overhead, alternating A/B pairs', () => {
  it('measures off vs on for idle and CPU-intensive load, code-heavy fixture and Nest app, plus the large-heap keep-alive case', async () => {
    const major = process.versions.node.split('.')[0];
    const outFile = resolve(process.cwd(), `../../artifacts/06_bench_profiler_ab_node${major}.json`);
    const busyWait = samplerBusyWaitReason(99);
    if (busyWait) {
      // CR-002 option A: the profiler refuses to start here, so there is nothing to A/B. Record that instead of a number.
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, status: 'unavailable', reason: busyWait, note: 'NOT RUN: the profiler reports state unavailable at the default rate on this runtime (CR-002); no overhead is claimed.' }, null, 2));
      return;
    }
    const hostBusyStartPct = await hostBusyPercent();
    const fixture = generateCodeHeavy(12_000);
    let ordersApp: OrdersApp | undefined;
    try {
      const mod: CodeHeavyModule = fixture.module;
      ordersApp = await createOrdersApp({ enabled: false });
      const consumer = ordersApp.consumer;

      const codeCpu: Workload = {
        name: 'codeheavy-cpu',
        kind: 'cpu',
        async run(ms) {
          const t0 = performance.now();
          let units = 0;
          let i = 0;
          while (performance.now() - t0 < ms) {
            mod.work(5);
            units += 5;
            if (++i % 10 === 0) mod.allocateChunk(2_000);
            await yieldToLoop();
          }
          return units;
        },
      };
      const idleTick = (touchEveryMs: number): Workload['run'] => async (ms) => {
        const t0 = performance.now();
        let ticks = 0;
        while (performance.now() - t0 < ms) {
          await sleep(touchEveryMs);
          mod.work(1); // ~1000 calls: a trickle of real work so the profile is not empty
          ticks++;
        }
        return ticks;
      };
      const nestCpu: Workload = {
        name: 'nest-cpu',
        kind: 'cpu',
        async run(ms) {
          const t0 = performance.now();
          let done = 0;
          let id = 0;
          const lane = async (): Promise<void> => {
            while (performance.now() - t0 < ms) {
              await consumer.process({ id: `m${id++}`, delayMs: 1 });
              burn(0.3);
              done++;
            }
          };
          await Promise.all(Array.from({ length: 32 }, lane));
          return done;
        },
      };
      const nestIdle: Workload = {
        name: 'nest-idle',
        kind: 'idle',
        async run(ms) {
          const t0 = performance.now();
          let done = 0;
          let id = 0;
          while (performance.now() - t0 < ms) {
            await consumer.process({ id: `m${id++}`, delayMs: 1 });
            done++;
            await sleep(100); // ~10 msg/s
          }
          return done;
        },
      };
      const workloads: Workload[] = [
        codeCpu,
        { name: 'codeheavy-idle', kind: 'idle' as const, run: idleTick(50) },
        nestCpu,
        nestIdle,
      ].filter((w) => ONLY.length === 0 || ONLY.includes(w.name));

      const scenarios: Record<string, unknown> = {};
      for (const w of workloads) {
        await once(w, false, 2000, WINDOW_MS); // warm-up (JIT), discarded
        await once(w, true, 2000, WINDOW_MS);
        const runs: RunResult[] = [];
        for (let i = 0; i < PAIRS; i++) {
          // alternate A/B order so slow drift (thermal, background load) hits both modes equally
          const order: boolean[] = i % 2 === 0 ? [false, true] : [true, false];
          const pair: RunResult[] = [];
          for (const s of order) pair.push(await once(w, s, RUN_MS, WINDOW_MS));
          runs.push(...pair.sort((a, b) => (a.mode === 'off' ? -1 : 1) - (b.mode === 'off' ? -1 : 1)));
        }
        const win = process.platform === 'win32';
        const timerPaced = TIMER_PACED.has(w.name);
        const onIdleCpu = runs.filter((x) => x.mode === 'on').map((x) => x.cpuFraction);
        scenarios[w.name] = {
          kind: w.kind,
          hostBusyPercentBeforeScenario: await hostBusyPercent(500),
          validity: {
            cpuMsPerUnit: w.kind === 'cpu',
            // on win32 the sampler changes timer granularity and the tick-based CPU accounting shows an unexplained bias, so NO row's wall
            // throughput, cpuFraction or event-loop delay may be quoted as profiler cost there (CR-002 review)
            wallThroughputAndEventLoopDelay: !win,
            note: win
              ? timerPaced
                ? 'INVALID on win32: timer-paced load; the sampler changes timer granularity (CR-002). Do not read throughput, cpuFraction or event-loop-delay deltas of this row as overhead.'
                : 'INVALID on win32 for workPerSecond / cpuFraction / event-loop delay (timer granularity and an unexplained bias: cpuMsPerUnit is lower with the sampler on in most pairs, which a real profiler cannot cause). The data cannot bound the overhead.'
              : undefined,
          },
          ...(w.kind === 'idle'
            ? { idleCpuGate: { threshold: IDLE_CPU_GATE, maxCpuFractionWithSamplerOn: Math.max(...onIdleCpu), pass: Math.max(...onIdleCpu) <= IDLE_CPU_GATE } }
            : {}),
          summary: summarizePairs(runs, true),
          stallSeriesAllOnRuns: {
            startStallMs: across(runs, (s) => s.startStallMs),
            stopStallMs: across(runs, (s) => s.stopStallMs),
            foldMs: across(runs, (s) => s.foldMs),
            keepAliveMs: across(runs, (s) => s.keepAliveMs),
          },
          runs,
        };
      }

      // large retained heap: keep-alive on vs off (rotation stall) and sampler off, same workload
      const heapCase: Record<string, unknown> = {};
      if (ONLY.length === 0 || ONLY.includes('heap')) {
        const keep: unknown[] = [];
        const per = 100_000;
        const target = HEAP_MB * 1024 * 1024;
        while (process.memoryUsage().heapUsed < target) {
          const chunk: unknown[] = [];
          for (let i = 0; i < per; i++) chunk.push({ id: i, name: `n${i}`, tags: [i, i + 1], pad: 'x'.repeat(32) });
          keep.push(chunk);
        }
        const heapMb = r(process.memoryUsage().heapUsed / 1048576, 1);
        const heapRuns: Record<string, RunResult[]> = { off: [], keepAliveOn: [], keepAliveOff: [] };
        const w: Workload = { ...codeCpu, name: 'codeheavy-cpu-largeheap' };
        await once(w, false, 2000, WINDOW_MS);
        const HEAP_PAIRS = Math.max(2, Math.min(PAIRS, 4));
        for (let i = 0; i < HEAP_PAIRS; i++) {
          heapRuns.off.push(await once(w, false, RUN_MS, WINDOW_MS));
          heapRuns.keepAliveOn.push(await once(w, true, RUN_MS, WINDOW_MS, true));
          heapRuns.keepAliveOff.push(await once(w, true, RUN_MS, WINDOW_MS, false));
        }
        heapCase.retainedHeapUsedMb = heapMb;
        heapCase.runs = heapRuns;
        heapCase.stallSeries = {
          keepAliveOn: {
            startStallMs: across(heapRuns.keepAliveOn, (s) => s.startStallMs),
            stopStallMs: across(heapRuns.keepAliveOn, (s) => s.stopStallMs),
            keepAliveMs: across(heapRuns.keepAliveOn, (s) => s.keepAliveMs),
          },
          keepAliveOff: {
            startStallMs: across(heapRuns.keepAliveOff, (s) => s.startStallMs),
            stopStallMs: across(heapRuns.keepAliveOff, (s) => s.stopStallMs),
          },
        };
        heapCase.eventLoopDelayMaxMs = {
          off: heapRuns.off.map((x) => x.eventLoopDelayMs.max),
          keepAliveOn: heapRuns.keepAliveOn.map((x) => x.eventLoopDelayMs.max),
          keepAliveOff: heapRuns.keepAliveOff.map((x) => x.eventLoopDelayMs.max),
        };
        heapCase.workPerSecond = {
          off: heapRuns.off.map((x) => x.workPerSecond),
          keepAliveOn: heapRuns.keepAliveOn.map((x) => x.workPerSecond),
          keepAliveOff: heapRuns.keepAliveOff.map((x) => x.workPerSecond),
        };
        keep.length = 0;
      }

      const out = outFile;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            node: process.version,
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            totalMemGb: r(totalmem() / 1e9, 1),
            platform: `${process.platform} ${process.arch}`,
            fixture: { generatedFunctions: mod.functionCount },
            config: { sampleRateHz: 99, windowMs: WINDOW_MS, runMs: RUN_MS, pairs: PAIRS, order: 'alternating off/on and on/off per pair; one discarded warm-up pair per scenario' },
            hostBusyPercentAtStart: hostBusyStartPct,
            hostBusyPercentAtEnd: await hostBusyPercent(500),
            scenarios,
            largeHeap: heapCase,
          },
          null,
          2,
        ),
      );
      expect(Object.keys(scenarios).length).toBeGreaterThan(0);
      // idle-CPU gate: with the sampler on and the app idle, the process must not burn a core
      for (const [name, sc] of Object.entries(scenarios)) {
        const gate = (sc as { idleCpuGate?: { pass: boolean } }).idleCpuGate;
        if (gate) expect(gate.pass, `idle CPU gate failed for ${name}`).toBe(true);
      }
    } finally {
      await ordersApp?.close();
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }, 3_600_000);
});
