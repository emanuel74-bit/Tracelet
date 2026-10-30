import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { sleep, stallSeries, summarizeSeries } from '../../support/profiling/load.js';
import { skipIfBusyWait } from '../../support/profiling/runtime-gate.js';

/**
 * M3 regression: with ~150 MB of retained heap a plain Profiler.stop/start re-creates the V8 CpuProfiler and re-walks the heap
 * (about 1 s). The rotation keep-alive keeps the CpuProfiler alive, so startStallMs stays tiny. The second test opts the
 * keep-alive out and only RECORDS the high stall (documentation of the contrast, no bound).
 */

const retained: unknown[][] = [];
afterAll(() => {
  retained.length = 0;
});

function retainHeap(targetMb: number): number {
  const chunk: unknown[] = [];
  retained.push(chunk);
  while (process.memoryUsage().heapUsed < targetMb * 1024 * 1024) {
    for (let i = 0; i < 50_000; i++) chunk.push({ i, name: 'item-' + i, tags: [i, i + 1], text: 'y'.repeat(24) });
  }
  return process.memoryUsage().heapUsed / 1048576;
}

async function rotations(opts: { keepAlive: boolean }) {
  const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 50 });
  const profiler = new ContinuousProfiler(
    { enabled: true, sampleRateHz: 99, windowMs: 1200, maxStallMs: 1e9 },
    { queue, serviceName: 'heap', instanceId: 'heap-1', ...(opts.keepAlive ? {} : { createKeepAlive: null }) },
  );
  await profiler.start();
  const t0 = Date.now();
  while (profiler.debug().windows.filter((w) => !w.final).length < 3 && Date.now() - t0 < 60_000) await sleep(100);
  const debug = profiler.debug();
  await profiler.stop();
  return { debug, series: stallSeries(debug.windows) };
}

describe('rotation keep-alive on a large heap (M3)', () => {
  it('keeps the start stall tiny with ~150 MB retained (3 rotations)', async (ctx) => {
    skipIfBusyWait(ctx);
    const heapMb = retainHeap(150);
    expect(heapMb).toBeGreaterThanOrEqual(150);
    const { debug, series } = await rotations({ keepAlive: true });
    expect(debug.keepAlive, JSON.stringify(debug.keepAliveOffReason)).toBe('active');
    expect(series.startStallMs.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...series.startStallMs), JSON.stringify(series)).toBeLessThan(20);
    const out = resolve(process.cwd(), '../../artifacts/02_keepalive_heap.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ node: process.version, heapUsedMb: Math.round(heapMb), keepAlive: summarize(series) }, null, 2));
  }, 120_000);

  it('records (no bound) the stall with the keep-alive opted out', async (ctx) => {
    skipIfBusyWait(ctx);
    const heapMb = retainHeap(150);
    const { debug, series } = await rotations({ keepAlive: false });
    expect(debug.keepAlive).toBe('off');
    expect(debug.keepAliveOffReason).toBe('disabled by option');
    expect(series.startStallMs.length).toBeGreaterThanOrEqual(3);
    const out = resolve(process.cwd(), '../../artifacts/02_keepalive_heap_optout.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ node: process.version, heapUsedMb: Math.round(heapMb), plainStopStart: summarize(series) }, null, 2));
  }, 120_000);
});

function summarize(series: ReturnType<typeof stallSeries>) {
  return { startStallMs: summarizeSeries(series.startStallMs), stopStallMs: summarizeSeries(series.stopStallMs), foldMs: summarizeSeries(series.foldMs) };
}
