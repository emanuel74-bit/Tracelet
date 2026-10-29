import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Injectable, Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { trace } from '../../src/context/index.js';
import { createAppFor } from '../../tests/support/instrumentation/orders-app.js';
import { startHarness } from '../../tests/support/instrumentation/harness.js';

/* T20 seed: off / on-untraced / on-traced, p50 and p95 per provider call and per message. No pass/fail threshold. */

const WARMUP = 2_000;
const ITERATIONS = 20_000;
const YIELD_EVERY = 100;

@Injectable()
class BenchSvc {
  work(n: number): number {
    return n + 1;
  }
}

@Module({ providers: [BenchSvc] })
class BenchModule {}

interface Stats {
  p50Us: number;
  p95Us: number;
  p99Us: number;
  meanUs: number;
  samples: number;
}

function stats(samplesMs: number[]): Stats {
  const sorted = Float64Array.from(samplesMs).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 1000;
  const mean = (samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length) * 1000;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { p50Us: r(at(0.5)), p95Us: r(at(0.95)), p99Us: r(at(0.99)), meanUs: r(mean), samples: samplesMs.length };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runMode(mode: 'off' | 'on-untraced' | 'on-traced') {
  const h = startHarness({ tracing: { enabled: mode === 'on-traced' }, queue: { maxQueuedTraces: 100_000 } });
  const app = await createAppFor(BenchModule, { enabled: mode !== 'off' });
  const svc = app.get(BenchSvc);

  const perCall: number[] = [];
  const perMessage: number[] = [];
  let sink = 0;

  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const record = i >= WARMUP;

    // per provider call
    if (mode === 'on-traced') {
      trace('bench.call', () => {
        const t0 = performance.now();
        sink += svc.work(i);
        const t1 = performance.now();
        if (record) perCall.push(t1 - t0);
      });
    } else {
      const t0 = performance.now();
      sink += svc.work(i);
      const t1 = performance.now();
      if (record) perCall.push(t1 - t0);
    }

    // per message: a root with three provider calls
    const m0 = performance.now();
    trace('bench.message', () => {
      sink += svc.work(1) + svc.work(2) + svc.work(3);
    });
    const m1 = performance.now();
    if (record) perMessage.push(m1 - m0);

    if (i % YIELD_EVERY === 0) {
      await tick(); // lets deferred completions run so memory stays bounded
      h.queue.drain(1_000_000, Number.MAX_SAFE_INTEGER);
    }
  }
  await h.settle(60_000);
  const queueCounters = h.queue.counters();
  await app.close();
  h.stop();
  return { perCall: stats(perCall), perMessage: stats(perMessage), counters: queueCounters, sink };
}

describe('T20 seed: instrumentation overhead', () => {
  it('measures off / on-untraced / on-traced and writes artifacts/02_bench_overhead.json', async () => {
    const results: Record<string, unknown> = {};
    for (const mode of ['off', 'on-untraced', 'on-traced'] as const) {
      results[mode] = await runMode(mode);
    }
    const out = resolve(process.cwd(), '../../artifacts/02_bench_overhead.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedBy: 'bench/instrumentation/overhead.int-spec.ts',
          note: 'Indicative only; no threshold. Caller-side latency; deferred mapping runs in timers and is not in these numbers. Stage 00 indicative: 0.17 / 0.80 / 19.8 us.',
          warmup: WARMUP,
          iterations: ITERATIONS,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          cpu: cpus()[0]?.model,
          cpuCount: cpus().length,
          timestamp: new Date().toISOString(),
          modes: {
            off: 'instrument enabled:false, tracing disabled (pass-through)',
            'on-untraced': 'instrumented providers (proxies installed), tracing runtime disabled: trace() is a pass-through and every provider call takes the no-store untraced path',
            'on-traced': 'instrumented providers inside a sampled root (sampleRate 1)',
          },
          results,
        },
        null,
        2,
      ),
    );
    expect(Object.keys(results)).toHaveLength(3);
  });
});
