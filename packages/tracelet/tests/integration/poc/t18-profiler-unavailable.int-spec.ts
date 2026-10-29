import { describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler, probeInspector } from '../../../src/profiling/index.js';
import { FakeClock, FakeSession } from '../../support/profiling/fake-session.js';
import { sleep } from '../../support/profiling/load.js';

/* T18 (plan 16): unavailable inspector is reported truthfully, never throws, never produces a profile. */

const deps = (queue: BoundedTelemetryQueue) => ({ queue, serviceName: 'poc', instanceId: 'poc-t18' });

describe('T18 profiler unavailable', () => {
  it('a session factory that throws on connect gives state unavailable with a reason and no items', async () => {
    const queue = new BoundedTelemetryQueue();
    const clock = new FakeClock();
    const profiler = new ContinuousProfiler(
      { enabled: true, windowMs: 50 },
      {
        ...deps(queue),
        createSession: () => new FakeSession({ clock, failConnect: true }),
      },
    );
    await expect(profiler.start()).resolves.toBeUndefined();
    const h = profiler.profilerHealth();
    expect(h.state).toBe('unavailable');
    expect(h.reason).toMatch(/fake connect failure/);
    await sleep(200);
    expect(queue.depth()).toBe(0);
    expect(profiler.debug().windows).toHaveLength(0);
    await expect(profiler.stop()).resolves.toBeUndefined();
    expect(profiler.profilerHealth().state).toBe('unavailable');
  });

  it('a session factory that itself throws gives state unavailable', async () => {
    const queue = new BoundedTelemetryQueue();
    const profiler = new ContinuousProfiler(
      { enabled: true },
      {
        ...deps(queue),
        createSession: () => {
          throw new Error('no inspector module');
        },
      },
    );
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('unavailable');
    expect(profiler.profilerHealth().reason).toMatch(/no inspector module/);
    expect(queue.depth()).toBe(0);
  });

  it('a probe reporting v8_enable_inspector false gives state unavailable and never opens a session', async () => {
    const queue = new BoundedTelemetryQueue();
    let sessions = 0;
    const profiler = new ContinuousProfiler(
      { enabled: true },
      {
        ...deps(queue),
        probe: () => probeInspector({ v8EnableInspector: 0 }),
        createSession: () => {
          sessions++;
          return new FakeSession({ clock: new FakeClock() });
        },
      },
    );
    await expect(profiler.start()).resolves.toBeUndefined();
    const h = profiler.profilerHealth();
    expect(h.state).toBe('unavailable');
    expect(h.reason).toMatch(/v8_enable_inspector/);
    expect(sessions).toBe(0);
    expect(queue.depth()).toBe(0);
    await profiler.stop();
  });

  it('probeInspector: flag false and a throwing loader are unavailable with reasons; the real process is available', () => {
    expect(probeInspector({ v8EnableInspector: false })).toMatchObject({ available: false });
    expect(probeInspector({ v8EnableInspector: 1, loadInspector: () => { throw new Error('boom'); } })).toEqual({
      available: false,
      reason: 'node:inspector unavailable: boom',
    });
    const real = probeInspector();
    expect(real.available, JSON.stringify(real)).toBe(true);
  });

  it('profiling.enabled false is state disabled (distinct from unavailable)', async () => {
    const profiler = new ContinuousProfiler({ enabled: false }, deps(new BoundedTelemetryQueue()));
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('disabled');
  });
});
