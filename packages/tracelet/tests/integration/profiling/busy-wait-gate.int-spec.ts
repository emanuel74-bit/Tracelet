import inspector from 'node:inspector';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { BUSY_WAIT_REASON } from '../../support/profiling/runtime-gate.js';

/* CR-002 option A against the REAL runtime: where V8 busy-waits its sampler thread (Node 20 on Windows) the profiler refuses with
 * state 'unavailable' and opens no inspector session; elsewhere it runs. sampleRateHz <= 9 is the working opt-in everywhere. */

afterEach(() => vi.restoreAllMocks());

describe('CR-002 gate on this runtime', () => {
  const affected = BUSY_WAIT_REASON !== undefined;
  console.info(`[busy-wait gate] node ${process.version} on ${process.platform}: ${affected ? `AFFECTED (${BUSY_WAIT_REASON})` : 'not affected'}`);

  it(`default 99 Hz is ${affected ? 'refused: unavailable with the reason, no session' : 'running'}`, async () => {
    const connect = vi.spyOn(inspector.Session.prototype, 'connect');
    const queue = new BoundedTelemetryQueue();
    const p = new ContinuousProfiler({ enabled: true, windowMs: 100 }, { queue, serviceName: 'g', instanceId: 'g-1' });
    await expect(p.start()).resolves.toBeUndefined();
    const h = p.profilerHealth();
    if (affected) {
      expect(h.state).toBe('unavailable');
      expect(h.reason).toBe(BUSY_WAIT_REASON);
      expect(connect).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 250));
      expect(queue.depth()).toBe(0);
      expect(p.debug().windows).toHaveLength(0);
    } else {
      expect(h.state).toBe('running');
    }
    await p.stop();
  });

  it('sampleRateHz 9 is an explicit working opt-in on every runtime: running and producing profiles', async () => {
    const queue = new BoundedTelemetryQueue();
    const p = new ContinuousProfiler({ enabled: true, sampleRateHz: 9, windowMs: 300 }, { queue, serviceName: 'g', instanceId: 'g-1' });
    await p.start();
    expect(p.profilerHealth().state).toBe('running');
    const end = Date.now() + 8000;
    while (p.debug().counters.windows < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(p.debug().counters.windows).toBeGreaterThanOrEqual(2);
    expect(p.profilerHealth().reason).toBeUndefined();
    await p.stop();
    expect(queue.depth('profile')).toBeGreaterThanOrEqual(2);
  });
});
