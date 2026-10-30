import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { ProfileItem } from '../../../src/contracts/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { absolutePathViolations, continuity, sleep, stallSeries, summarizeSeries } from '../../support/profiling/load.js';
import { contentionPreflight, windowDiagnostics } from '../../support/profiling/contention-gate.js';
import { skipIfBusyWait } from '../../support/profiling/runtime-gate.js';

/* T10 (plan 16): 30 s idle, windowMs 5000, 99 Hz: windows are still produced and contiguous by the same sample-based rule. */

const MIN_FINAL_WINDOW_MS = 1000;

describe('T10 profiler contiguity while idle', () => {
  it('produces contiguous windows with idle samples and stays running', async (ctx) => {
    skipIfBusyWait(ctx);
    const outFile = resolve(process.cwd(), '../../artifacts/02_t10_run.json');
    const gate = await contentionPreflight(ctx, 'T10', outFile);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 50 });
    const profiler = new ContinuousProfiler(
      { enabled: true, sampleRateHz: 99, windowMs: 5000 },
      { queue, serviceName: 'poc', instanceId: 'poc-idle' },
    );
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('running');
    const states = new Set<string>();
    const t0 = Date.now();
    // a fully idle process: only a sleeping timer, no work
    // The 6th rotation lands at ~30.05 s, i.e. right when the loop used to exit, so stop() could close a final window of only a few
    // ms that holds no idle sample (a test-timing artefact, not a sampler fault). Keep going until the open window is at least
    // MIN_FINAL_WINDOW_MS old; thresholds and assertions are unchanged.
    let seen = 0;
    let lastRotationAt = t0;
    while (Date.now() - t0 < 30_000 || profiler.debug().windows.length < 6 || Date.now() - lastRotationAt < MIN_FINAL_WINDOW_MS) {
      await sleep(250);
      states.add(profiler.profilerHealth().state);
      const n = profiler.debug().windows.length;
      if (n !== seen) {
        seen = n;
        lastRotationAt = Date.now();
      }
      if (Date.now() - t0 > 45_000) break;
    }
    await profiler.stop();
    const post = await gate.after();

    const debug = profiler.debug();
    const windows = debug.windows;
    const c = continuity(windows, 250);
    const series = stallSeries(windows);
    const items = queue.drain(1000, Number.MAX_SAFE_INTEGER).filter((i): i is ProfileItem => i.type === 'profile');

    const out = outFile;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          node: process.version,
          contention: { before: gate.before, after: post.reading },
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
            totalSampleCount: w.totalSampleCount,
            sampledSpanMs: Math.round(w.sampledSpanMs),
            gapBeforeMs: w.gapBeforeMs,
          })),
          counters: debug.counters,
        },
        null,
        2,
      ),
    );

    const diag = post.diag({ continuity: c, windows: windowDiagnostics(windows) });
    expect(windows.filter((w) => !w.final).length, diag).toBeGreaterThanOrEqual(5);
    expect(c.withGap, diag).toBeGreaterThanOrEqual(5);
    expect(c.contiguous, `gaps ${JSON.stringify(c.gaps)} (max 250); ${diag}`).toBeGreaterThanOrEqual(5);
    expect(c.coverage, `coverage ${c.coverage} (min 0.95); ${diag}`).toBeGreaterThanOrEqual(0.95);
    for (const w of windows) expect(w.idleSampleCount, `window ${w.seq}; ${diag}`).toBeGreaterThan(0);
    const idleTotal = windows.reduce((a, w) => a + w.idleSampleCount, 0);
    const activeTotal = windows.reduce((a, w) => a + w.sampleCount, 0);
    expect(idleTotal).toBeGreaterThan(0);
    // "sampleCount small": non-idle samples are a small fraction of an idle process
    expect(activeTotal, diag).toBeLessThan(idleTotal);
    expect(items.every((i) => i.profile.idleSampleCount! > 0)).toBe(true);
    expect(absolutePathViolations(items)).toEqual([]);
    expect(debug.keepAlive, JSON.stringify(debug.keepAliveOffReason)).toBe('active');
    expect(states.has('disabled') || states.has('error') || states.has('unavailable')).toBe(false);
    expect([...states]).toContain('running');
  }, 120_000);
});
