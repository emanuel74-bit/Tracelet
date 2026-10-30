import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { ProfileItem } from '../../../src/contracts/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { generateCodeHeavy } from '../../support/profiling/generate-code-heavy.js';
import type { GeneratedCodeHeavy } from '../../support/profiling/generate-code-heavy.js';
import { absolutePathViolations, continuity, runMixedLoad, stallSeries, summarizeSeries } from '../../support/profiling/load.js';
import { contentionPreflight, windowDiagnostics } from '../../support/profiling/contention-gate.js';
import { skipIfBusyWait } from '../../support/profiling/runtime-gate.js';

/* T09 (plan 16): 30 s CPU-bound + concurrent allocation-heavy loop on the code-heavy fixture, windowMs 5000, 99 Hz. */

const WINDOW_MS = 5000;
const MAX_GAP_MS = 250;

describe('T09 profiler contiguity under CPU load (code-heavy fixture)', () => {
  let fixture: GeneratedCodeHeavy;
  beforeAll(() => {
    fixture = generateCodeHeavy(12_000);
  });
  afterAll(() => {
    try {
      rmSync(fixture.dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best effort
    }
  });

  it('keeps sampling contiguous: sample-based gaps <= 250 ms, coverage >= 0.95, burnCpu in every window, state never disabled/error', async (ctx) => {
    skipIfBusyWait(ctx);
    const outFile = resolve(process.cwd(), '../../artifacts/02_t09_run.json');
    const gate = await contentionPreflight(ctx, 'T09', outFile);
    expect(fixture.module.functionCount).toBeGreaterThanOrEqual(10_000);

    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 50 });
    const profiler = new ContinuousProfiler(
      { enabled: true, sampleRateHz: 99, windowMs: WINDOW_MS },
      { queue, serviceName: 'poc', instanceId: 'poc-instance' },
    );
    const states = new Set<string>();
    const watch = setInterval(() => states.add(profiler.profilerHealth().state), 50);
    const t0 = Date.now();
    await profiler.start();
    expect(profiler.profilerHealth().state, JSON.stringify(profiler.profilerHealth())).toBe('running');

    // 30 s of load, then keep going until the 6th rotation completed (rotations happen at windowMs + the previous stalls)
    await runMixedLoad(fixture.module, 30_000, undefined);
    await runMixedLoad(fixture.module, 8_000, () => profiler.debug().windows.length >= 6);
    // keep the load on for 2 s more so the final flush window (closed by stop()) also holds a meaningful sample set
    await runMixedLoad(fixture.module, 2_000);
    states.add(profiler.profilerHealth().state);
    await profiler.stop();
    clearInterval(watch);
    const wallMs = Date.now() - t0;
    const post = await gate.after();

    const debug = profiler.debug();
    const windows = debug.windows;
    const rotated = windows.filter((w) => !w.final);
    expect(rotated.length, post.diag({ windows: windowDiagnostics(windows) })).toBeGreaterThanOrEqual(6);

    const c = continuity(windows, MAX_GAP_MS);
    const series = stallSeries(windows);
    const items = queue.drain(1000, Number.MAX_SAFE_INTEGER).filter((i): i is ProfileItem => i.type === 'profile');

    // saved log for artifacts/02_POC_RESULTS.md
    const out = outFile;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          node: process.version,
          contention: { before: gate.before, after: post.reading },
          wallMs,
          functionCount: fixture.module.functionCount,
          states: [...states],
          continuity: c,
          startStallMs: summarizeSeries(series.startStallMs),
          stopStallMs: summarizeSeries(series.stopStallMs),
          foldMs: summarizeSeries(series.foldMs),
          achievedSampleRateHz: windows.map((w) => w.achievedSampleRateHz),
          windows: windows.map((w) => ({
            seq: w.seq,
            final: w.final,
            sampleCount: w.sampleCount,
            idleSampleCount: w.idleSampleCount,
            sampledSpanMs: Math.round(w.sampledSpanMs),
            gapBeforeMs: w.gapBeforeMs,
            durationMs: Math.round(w.durationMs),
          })),
          counters: debug.counters,
        },
        null,
        2,
      ),
    );

    // gap-bearing windows: every window except the first
    const diag = post.diag({ continuity: c, windows: windowDiagnostics(windows) });
    expect(c.withGap, diag).toBeGreaterThanOrEqual(5);
    expect(c.contiguous, `gaps ${JSON.stringify(c.gaps)} (max ${MAX_GAP_MS}); ${diag}`).toBeGreaterThanOrEqual(5);
    expect(c.coverage, `coverage ${c.coverage} (min 0.95); ${diag}`).toBeGreaterThanOrEqual(0.95);
    for (const w of windows) expect(w.sampleCount, `window ${w.seq}; ${diag}`).toBeGreaterThan(0);
    expect(items.length).toBe(windows.length);
    for (const item of items) {
      expect(item.profile.sampleCount).toBeGreaterThan(0);
      expect(item.profile.stacks.some((s) => /burnCpu/.test(s.stack)), item.profile.profileId).toBe(true);
    }
    expect(absolutePathViolations(items)).toEqual([]);
    expect(debug.keepAlive, JSON.stringify(debug.keepAliveOffReason)).toBe('active');
    expect(states.has('disabled')).toBe(false);
    expect(states.has('error')).toBe(false);
    if (states.has('backoff')) expect(debug.counters.lastBackoffReason).toBeTruthy();
    // stall series recorded for every rotation
    expect(series.startStallMs.length).toBe(rotated.length);
    expect(series.stopStallMs.length).toBe(rotated.length);
    expect(series.foldMs.length).toBe(rotated.length);
  }, 120_000);
});
