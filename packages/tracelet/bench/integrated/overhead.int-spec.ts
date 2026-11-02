import { fork, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { describe, it } from 'vitest';
import { samplerBusyWaitReason } from '../../src/profiling/vendor/cpu-sampler.js';
import { acquireMongo } from '../../tests/support/e2e/mongo.js';
import { classifyContention, cpuBusyBetween, formatReading, measureContention } from '../../tests/support/profiling/contention.js';
import type { ContentionReading, CpuTimesList } from '../../tests/support/profiling/contention.js';
import { mean, pairStats, pctDelta, round, stdev } from '../../tests/support/bench/stats.js';

/*
 * T20 (Mission 09): INTEGRATED runtime overhead. A real Nest application (nest-worker shape: amqplib-style consumer callback wrapped in
 * trace(), nested providers, Promise.all, occasional errors) runs in a CHILD PROCESS against a REAL mongod (mongodb-memory-server)
 * with the full Tracelet pipeline (deferred mapping, Mongo writer, rollups, metrics collector; profiling only in variant D).
 *
 * Gated: runs only with TRACELET_BENCH_INTEGRATED=1 AND TRACELET_E2E_MONGO=memory (or TRACELET_E2E_MONGO_URI). It takes tens of
 * minutes. It never runs in the default integration run and never rewrites committed artifacts unless enabled.
 *
 * Knobs: TRACELET_BENCH_PAIRS (6 measured pairs, one extra warm-up pair is run first and discarded), TRACELET_BENCH_MESSAGES (20000),
 * TRACELET_BENCH_RATE (offered msgs/s, 2000), TRACELET_BENCH_CONCURRENCY (closed-loop in-flight, 32), TRACELET_BENCH_WORK_US (200),
 * TRACELET_BENCH_SCENARIOS (comma list of "<variant>-<load>", e.g. "B-closed,C-offered"; default all), TRACELET_BENCH_OUT (output file).
 */

const ENABLED = process.env.TRACELET_BENCH_INTEGRATED === '1';
const PAIRS = Number(process.env.TRACELET_BENCH_PAIRS ?? 6);
const MESSAGES = Number(process.env.TRACELET_BENCH_MESSAGES ?? 20000);
const RATE = Number(process.env.TRACELET_BENCH_RATE ?? 2000);
const CONCURRENCY = Number(process.env.TRACELET_BENCH_CONCURRENCY ?? 32);
const WORK_US = Number(process.env.TRACELET_BENCH_WORK_US ?? 200);
const ONLY = (process.env.TRACELET_BENCH_SCENARIOS ?? '').split(',').filter(Boolean);

const PKG = resolve(__dirname, '..', '..');
const REPO = resolve(PKG, '..', '..');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

interface Variant {
  id: 'B' | 'C' | 'D';
  title: string;
  env: Record<string, string>;
}
const VARIANTS: Variant[] = [
  { id: 'B', title: 'enabled, production defaults (sampleRate default 0.05, maxRootsPerSecond 20, errorMessages omit, rollups on, metrics on, profiling off)', env: {} },
  { id: 'C', title: 'enabled, sampleRate 1 and maxRootsPerSecond 100000 (worst case; writer pacing/queue bounds stay at defaults)', env: { BENCH_SAMPLE_RATE: '1', BENCH_MAX_ROOTS_PER_SECOND: '100000' } },
  { id: 'D', title: 'as B plus continuous profiling ON at the product default (99 Hz, 30 s window)', env: { BENCH_PROFILING: '1' } },
];
const LOADS = [
  { id: 'offered', title: `offered rate ${RATE} msg/s (open loop), ${MESSAGES} messages`, env: { BENCH_RATE: String(RATE) } },
  { id: 'closed', title: `closed-loop saturation, ${CONCURRENCY} in flight, ${MESSAGES} messages`, env: { BENCH_RATE: '0', BENCH_CONCURRENCY: String(CONCURRENCY) } },
] as const;

interface RunResult {
  event: 'result';
  messages: number;
  settled: number;
  acked: number;
  nacked: number;
  wallMs: number;
  throughputPerSec: number;
  cpuMs: number;
  cpuUsPerMessage: number;
  latencyUs: { n: number; p50: number; p95: number; p99: number; max: number };
  eventLoopDelayMs: { p50: number; p99: number; max: number; mean: number };
  eventLoopUtilization: number;
  rssPeakMb: number;
  rssEndMb: number;
  heapUsedPeakMb: number;
  heapUsedEndMb: number;
  lifecycleState: string;
  countersAtEnd?: Record<string, number>;
  queueDepthAtEnd?: number;
  traceQueueDepthAtEnd?: number;
}
interface StopResult {
  shutdownMs: number;
  shutdownCpuMs: number;
  counters?: Record<string, number>;
  queueDepth?: number;
  traceQueueDepth?: number;
  heapUsedEndMb: number;
  rssEndMb: number;
}
interface RunRow {
  mode: 'off' | 'on';
  valid: boolean;
  invalidReasons: string[];
  result?: RunResult;
  stop?: StopResult;
  mongoCounts?: Record<string, number>;
  /** whole-host CPU busy fraction while the load ran (os.cpus delta; includes the child, mongod, the parent and other processes) */
  hostBusyDuringRun?: number;
  /** hostBusyDuringRun minus the child's own CPU share: load from everything else (mongod, other agents) */
  otherLoadDuringRun?: number;
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`);
}

interface Child {
  proc: ChildProcess;
  waitFor<T>(event: string, timeoutMs: number): Promise<T>;
  stderr(): string;
}
function startChild(script: string, env: Record<string, string>): Child {
  const proc = fork(script, [], {
    env: { ...process.env, TRACELET_DISABLED: '', NODE_PATH: join(REPO, 'node_modules'), NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let err = '';
  proc.stderr?.on('data', d => (err += String(d)));
  proc.stdout?.on('data', () => undefined);
  const events: Array<Record<string, unknown>> = [];
  const waiters: Array<{ event: string; resolve: (e: never) => void; reject: (e: Error) => void }> = [];
  proc.on('message', m => {
    const e = m as Record<string, unknown>;
    events.push(e);
    for (const w of [...waiters]) {
      if (w.event === e.event) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e as never);
      } else if (e.event === 'error') {
        waiters.splice(waiters.indexOf(w), 1);
        w.reject(new Error(`worker error: ${String(e.message)}`));
      }
    }
  });
  proc.once('exit', code => {
    for (const w of waiters.splice(0)) w.reject(new Error(`worker exited (code ${code}) before "${w.event}"; stderr: ${err.slice(-800)}`));
  });
  return {
    proc,
    stderr: () => err,
    waitFor<T>(event: string, timeoutMs: number): Promise<T> {
      const have = events.find(e => e.event === event);
      if (have) return Promise.resolve(have as T);
      return new Promise<T>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout waiting for "${event}"; stderr: ${err.slice(-800)}`)), timeoutMs);
        waiters.push({
          event,
          resolve: e => {
            clearTimeout(timer);
            res(e as T);
          },
          reject: e => {
            clearTimeout(timer);
            rej(e);
          },
        });
      });
    },
  };
}

const COLLECTIONS = ['traces', 'spans', 'profiles', 'operation_rollups', 'method_rollups', 'metric_rollups', 'instances'] as const;

async function oneRun(script: string, entry: string, mongoUri: string, mode: 'off' | 'on', env: Record<string, string>, tag: string): Promise<RunRow> {
  const db = `bench_${tag}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
  const child = startChild(script, {
    BENCH_MODE: mode,
    BENCH_MESSAGES: String(MESSAGES),
    BENCH_WORK_US: String(WORK_US),
    BENCH_TRACELET_ENTRY: entry,
    BENCH_MONGO_URI: mongoUri,
    BENCH_DB: db,
    ...env,
  });
  const row: RunRow = { mode, valid: true, invalidReasons: [] };
  const client = mode === 'on' ? await MongoClient.connect(mongoUri) : undefined;
  try {
    const ready = await child.waitFor<{ state: string }>('ready', 120_000);
    if (mode === 'on' && ready.state !== 'active') {
      row.valid = false;
      row.invalidReasons.push(`lifecycle state after warm-up is "${ready.state}", not active`);
    }
    const cpuA = cpus() as CpuTimesList;
    child.proc.send('go');
    row.result = await child.waitFor<RunResult>('result', 600_000);
    row.hostBusyDuringRun = round(cpuBusyBetween(cpuA, cpus() as CpuTimesList), 3);
    row.otherLoadDuringRun = round(Math.max(0, row.hostBusyDuringRun - row.result.cpuMs / (row.result.wallMs * cpus().length)), 3);
    child.proc.send('shutdown');
    row.stop = await child.waitFor<StopResult>('stopped', 120_000);
    await new Promise<void>(r => (child.proc.exitCode !== null ? r() : child.proc.once('exit', () => r())));
    const r = row.result;
    if (r.settled !== r.messages) {
      row.valid = false;
      row.invalidReasons.push(`settled ${r.settled} != messages ${r.messages}`);
    }
    const expectNacks = Math.floor(MESSAGES / 50);
    if (Math.abs(r.nacked - expectNacks) > 1) {
      row.valid = false;
      row.invalidReasons.push(`nacked ${r.nacked} != expected ~${expectNacks}`);
    }
    if (mode === 'on' && r.lifecycleState !== 'active') {
      row.valid = false;
      row.invalidReasons.push(`lifecycle state at end "${r.lifecycleState}"`);
    }
    if (client) {
      const counts: Record<string, number> = {};
      for (const c of COLLECTIONS) counts[c] = await client.db(db).collection(`tracelet_${c}`).countDocuments();
      row.mongoCounts = counts;
      await client.db(db).dropDatabase();
      if (counts.traces === 0) {
      row.valid = false;
      row.invalidReasons.push('no traces persisted in Mongo: data was not actually produced/written');
    }
    }
  } catch (e) {
    row.valid = false;
    row.invalidReasons.push(String((e as Error).message).slice(0, 600));
    child.proc.kill();
  } finally {
    await client?.close().catch(() => undefined);
  }
  return row;
}

const METRICS: Array<{ key: string; label: string; pick: (r: RunRow) => number; higherIsBetter?: boolean }> = [
  { key: 'cpuUsPerMessage', label: 'child CPU (user+system) per message, us [PRIMARY]', pick: r => r.result!.cpuUsPerMessage },
  { key: 'throughputPerSec', label: 'throughput msg/s (closed loop is meaningful; offered is pinned to the rate)', pick: r => r.result!.throughputPerSec, higherIsBetter: true },
  { key: 'wallMs', label: 'wall time ms', pick: r => r.result!.wallMs },
  { key: 'latencyP50Us', label: 'callback latency p50 us', pick: r => r.result!.latencyUs.p50 },
  { key: 'latencyP95Us', label: 'callback latency p95 us', pick: r => r.result!.latencyUs.p95 },
  { key: 'latencyP99Us', label: 'callback latency p99 us', pick: r => r.result!.latencyUs.p99 },
  { key: 'eventLoopDelayP50Ms', label: 'event-loop delay p50 ms', pick: r => r.result!.eventLoopDelayMs.p50 },
  { key: 'eventLoopDelayP99Ms', label: 'event-loop delay p99 ms', pick: r => r.result!.eventLoopDelayMs.p99 },
  { key: 'eventLoopDelayMaxMs', label: 'event-loop delay max ms', pick: r => r.result!.eventLoopDelayMs.max },
  { key: 'eventLoopUtilization', label: 'event-loop utilization', pick: r => r.result!.eventLoopUtilization },
  { key: 'rssPeakMb', label: 'RSS peak MB', pick: r => r.result!.rssPeakMb },
  { key: 'rssEndMb', label: 'RSS end-of-run MB', pick: r => r.result!.rssEndMb },
  { key: 'heapUsedPeakMb', label: 'heapUsed peak MB', pick: r => r.result!.heapUsedPeakMb },
  { key: 'heapUsedEndMb', label: 'heapUsed end-of-run MB', pick: r => r.result!.heapUsedEndMb },
  { key: 'shutdownMs', label: 'shutdown time ms', pick: r => r.stop!.shutdownMs },
];

function summarize(pairs: Array<{ off: RunRow; on: RunRow; contended: boolean }>, only: 'all' | 'quiet') {
  const used = pairs.filter(p => p.off.valid && p.on.valid && (only === 'all' || !p.contended));
  const out: Record<string, unknown> = { pairsUsed: used.length };
  for (const m of METRICS) {
    const offV = used.map(p => m.pick(p.off));
    const onV = used.map(p => m.pick(p.on));
    out[m.key] = {
      label: m.label,
      meanOff: round(mean(offV), 3),
      meanOn: round(mean(onV), 3),
      stdevOff: round(stdev(offV), 3),
      stdevOn: round(stdev(onV), 3),
      deltaPercent: pairStats(used.map((_, i) => pctDelta(offV[i], onV[i])), m.higherIsBetter),
      deltaAbsolute: pairStats(used.map((_, i) => onV[i] - offV[i]), m.higherIsBetter),
    };
  }
  return out;
}

describe.skipIf(!ENABLED)('T20 (M09): integrated runtime overhead, real Nest app in a child process, real mongod', () => {
  it('measures Tracelet absent vs enabled (B production defaults, C sampleRate 1, D with profiling) with alternating A/B pairs', async (ctx) => {
    const mongo = await acquireMongo();
    if (!mongo) {
      ctx.skip('NOT RUN: no disposable MongoDB (set TRACELET_E2E_MONGO=memory)');
      return;
    }
    const major = process.versions.node.split('.')[0];
    const outFile = resolve(process.env.TRACELET_BENCH_OUT ?? join(process.cwd(), '..', '..', 'artifacts', `09_T20_integrated_node${major}.json`));
    const tmp = mkdtempSync(join(tmpdir(), 'tracelet-integrated-bench-'));
    try {
      // A private build of the CURRENT src and the worker, so a concurrent edit of dist cannot change a run midway.
      run(process.execPath, [TSC, '-p', join(PKG, 'tsconfig.build.json'), '--outDir', join(tmp, 'tracelet'), '--declaration', 'false'], PKG);
      run(process.execPath, [TSC, '-p', join(PKG, 'tests', 'support', 'bench', 'tsconfig.json'), '--outDir', join(tmp, 'worker')], PKG);
      const script = join(tmp, 'worker', 'integrated-worker.js');
      const entry = join(tmp, 'tracelet', 'index.js');

      const profilerReason = samplerBusyWaitReason(99);
      const hostInfo = {
        node: process.version,
        v8: process.versions.v8,
        platform: `${platform()} ${release()} ${arch()}`,
        cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
        totalMemMb: Math.round(totalmem() / 1048576),
        mongod: mongo.source,
      };
      const config = { pairs: PAIRS, warmupPairDiscarded: 1, messages: MESSAGES, offeredRatePerSec: RATE, closedLoopConcurrency: CONCURRENCY, workUsPerMessage: WORK_US, errorEvery: 50 };
      const doc: Record<string, unknown> = { generatedAt: new Date().toISOString(), status: 'running', host: hostInfo, config, scenarios: {} };
      const scenarios = doc.scenarios as Record<string, unknown>;
      const write = (): void => {
        mkdirSync(dirname(outFile), { recursive: true });
        writeFileSync(outFile, JSON.stringify(doc, null, 2));
      };
      doc.contentionStart = await measureContention(1700);
      console.info(`[T20] host at start: ${formatReading(doc.contentionStart as ContentionReading)}`);
      write();

      for (const v of VARIANTS) {
        for (const load of LOADS) {
          const name = `${v.id}-${load.id}`;
          if (ONLY.length && !ONLY.includes(name)) continue;
          if (v.id === 'D' && profilerReason) {
            scenarios[name] = { variant: v.title, load: load.title, status: 'NOT RUN', reason: `Node 20 on Windows busy-waits the V8 sampler thread, CR-002 (${profilerReason}); the profiler reports unavailable at the default rate here` };
            continue;
          }
          const pairs: Array<{ off: RunRow; on: RunRow; contended: boolean; contention: ContentionReading }> = [];
          // pair index 0 is the discarded warm-up pair
          for (let k = 0; k <= PAIRS; k++) {
            const contention = await measureContention(1000);
            const contended = classifyContention(contention).contended;
            const order: Array<'off' | 'on'> = k % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
            const rows: Partial<Record<'off' | 'on', RunRow>> = {};
            for (const mode of order) {
              rows[mode] = await oneRun(script, entry, mongo.uri, mode, { ...load.env, ...v.env }, `${name}_${k}_${mode}_${Date.now() % 100000}`);
            }
            const p = { off: rows.off!, on: rows.on!, contended, contention };
            const cpuInfo = p.off.result && p.on.result ? `cpu/msg off ${round(p.off.result.cpuUsPerMessage, 1)} on ${round(p.on.result.cpuUsPerMessage, 1)} us` : `invalid: ${[...p.off.invalidReasons, ...p.on.invalidReasons].join(' | ')}`;
            console.info(`[T20] ${name} pair ${k}${k === 0 ? ' (warm-up, discarded)' : ''} order ${order.join('>')} ${contended ? 'CONTENDED ' : ''}${cpuInfo}`);
            if (k > 0) pairs.push(p);
          }
          const valid = pairs.filter(p => p.off.valid && p.on.valid);
          const contendedCount = pairs.filter(p => p.contended).length;
          scenarios[name] = {
            variant: v.title,
            load: load.title,
            status: 'RAN',
            pairsRequested: PAIRS,
            pairsValid: valid.length,
            pairsContended: contendedCount,
            lowConfidence: contendedCount > 0 || valid.length < PAIRS,
            lowConfidenceReason: [contendedCount > 0 ? `${contendedCount} pair(s) started on a contended host` : '', valid.length < PAIRS ? `only ${valid.length} of ${PAIRS} pairs valid` : ''].filter(Boolean).join('; ') || undefined,
            summaryAllValidPairs: summarize(pairs, 'all'),
            summaryQuietPairsOnly: summarize(pairs, 'quiet'),
            pairs: pairs.map((p, i) => ({ pair: i + 1, order: (i + 1) % 2 === 0 ? 'off>on' : 'on>off', contended: p.contended, contention: p.contention, off: p.off, on: p.on })),
          };
          write();
        }
      }
      doc.contentionEnd = await measureContention(1700);
      doc.status = 'done';
      write();
      console.info(`[T20] wrote ${outFile}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      await mongo.stop().catch(() => undefined);
    }
  }, 4 * 60 * 60 * 1000);
});
