import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { sleep } from '../../support/profiling/load.js';
import { skipIfBusyWait } from '../../support/profiling/runtime-gate.js';

/*
 * Idle-CPU gate in the normal integration suite (CR-002 found Node 20 on Windows burning a whole core while idle; the A/B bench
 * check alone is behind TRACELET_BENCH_AB=1). With the real sampler at the product default rate and an idle application,
 * the process must use well under a tenth of a core. Skipped (NOT RUN) on an affected runtime, where the profiler refuses to start.
 */
describe('idle CPU with the sampler on (product default 99 Hz)', () => {
  it('process CPU fraction stays below 0.1 over 4 s of idle, including a rotation', async (ctx) => {
    skipIfBusyWait(ctx);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 20 });
    const p = new ContinuousProfiler({ enabled: true, windowMs: 1500 }, { queue, serviceName: 'idle', instanceId: 'idle-1' });
    await p.start();
    expect(p.profilerHealth().state).toBe('running');
    expect(p.profilerHealth().sampleRateHz).toBe(99);
    await sleep(300); // let start-up work finish
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await sleep(4000);
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const fraction = (cpu.user + cpu.system) / 1000 / wallMs;
    const windows = p.debug().counters.windows;
    await p.stop();
    expect(windows, 'at least one rotation happened during the measurement').toBeGreaterThanOrEqual(2);
    expect(fraction, `idle CPU fraction ${fraction.toFixed(4)}`).toBeLessThan(0.1);
  });
});
