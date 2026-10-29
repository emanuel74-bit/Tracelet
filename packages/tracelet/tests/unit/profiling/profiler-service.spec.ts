import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { ProfileItem } from '../../../src/contracts/index.js';
import { runOutsideTrace, traceletAls } from '../../../src/shared/als.js';
import { ContinuousProfiler, probeInspector } from '../../../src/profiling/index.js';
import type { ContinuousProfilerConfig } from '../../../src/profiling/index.js';
import { createInspectorKeepAlive } from '../../../src/profiling/vendor/cpu-sampler.js';
import { FakeClock, FakeSession } from '../../support/profiling/fake-session.js';
import type { FakeSessionOptions } from '../../support/profiling/fake-session.js';
import { sleep } from '../../support/profiling/load.js';

const WINDOW = 25;
const active: ContinuousProfiler[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((p) => p.stop()));
});

function make(opts: {
  config?: Partial<ContinuousProfilerConfig>;
  session?: Omit<FakeSessionOptions, 'clock'>;
  queue?: BoundedTelemetryQueue;
  retryDelayMs?: number;
  sessions?: FakeSession[];
  /** Inject a recording keep-alive bound to the latest fake session (optionally failing). */
  keepAlive?: { begin?: boolean; end?: boolean; costMs?: number };
}) {
  const clock = new FakeClock();
  let last: FakeSession | undefined;
  const queue = opts.queue ?? new BoundedTelemetryQueue({ maxQueuedProfiles: 1000 });
  const profiler = new ContinuousProfiler(
    { enabled: true, sampleRateHz: 99, windowMs: WINDOW, ...opts.config },
    {
      queue,
      serviceName: 'svc',
      instanceId: 'unit-1',
      now: clock.now,
      ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
      createSession: () => {
        const s = new FakeSession({ clock, ...opts.session });
        last = s;
        opts.sessions?.push(s);
        return s;
      },
      ...(opts.keepAlive ? { createKeepAlive: () => last?.keepAlive(opts.keepAlive) } : {}),
    },
  );
  active.push(profiler);
  return { profiler, queue, clock };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  expect(cond(), 'condition not reached in time').toBe(true);
}

describe('ContinuousProfiler: windows and sample-based continuity', () => {
  it('rotates stop->start on ONE persistent session and computes gapBeforeMs from sample timestamps', async () => {
    const sessions: FakeSession[] = [];
    const { profiler, queue } = make({ session: { stopMs: 7, startMs: 40 }, sessions });
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('running');
    await until(() => profiler.debug().windows.length >= 3);
    await profiler.stop();
    expect(sessions).toHaveLength(1);
    const calls = sessions[0].calls;
    expect(calls.slice(0, 3)).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
    expect(calls.filter((c) => c === 'Profiler.enable')).toHaveLength(1);
    // strict alternation stop,start,stop,start... after the first start
    const rest = calls.slice(3);
    rest.forEach((c, i) => expect(c).toBe(i % 2 === 0 ? 'Profiler.stop' : 'Profiler.start'));
    expect(sessions[0].disconnected).toBe(true);

    const w = profiler.debug().windows;
    expect(w[0].gapBeforeMs).toBeUndefined();
    // gap(i+1) = stopMs + startMs + first-sample interval (10) -> 57 ms, from SAMPLES, not startTime/endTime
    expect(w[1].gapBeforeMs).toBeCloseTo(57, 6);
    expect(w[2].gapBeforeMs).toBeCloseTo(57, 6);
    expect(w[1].stopStallMs).toBe(7);
    expect(w[1].startStallMs).toBe(40);
    expect(w[0].sampledSpanMs).toBeCloseTo(40, 6); // 5 samples 10 ms apart
    const items = queue.drain(100, Number.MAX_SAFE_INTEGER) as ProfileItem[];
    expect(items.length).toBe(w.length);
    expect(items[1].profile.gapBeforeMs).toBeCloseTo(57, 3);
    expect(items[0].profile.gapBeforeMs).toBeUndefined();
    expect(items[1].profile.stacks.some((s) => s.stack.includes('burnCpu'))).toBe(true);
  });

  it('the endTime-based gap would hide the stall: gapBeforeMs uses first sample, not startTime', async () => {
    // startMs 120 puts the first sample 130 ms after startTime; startTime(i+1) - endTime(i) would be only the stop stall
    const { profiler } = make({ session: { stopMs: 3, startMs: 120 } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 2);
    await profiler.stop();
    expect(profiler.debug().windows[1].gapBeforeMs).toBeCloseTo(3 + 120 + 10, 6);
  });

  it('timers and the session run outside any trace (start() called from inside a store)', async () => {
    const stores: unknown[] = [];
    const clock = new FakeClock();
    const profiler = new ContinuousProfiler(
      { enabled: true, windowMs: WINDOW },
      {
        queue: new BoundedTelemetryQueue(),
        serviceName: 's',
        instanceId: 'i',
        now: clock.now,
        createSession: () => {
          const s = new FakeSession({ clock });
          const post = s.post.bind(s);
          s.post = (m, p, cb) => {
            stores.push(traceletAls.getStore());
            post(m, p, (e, r) => {
              stores.push(traceletAls.getStore());
              cb(e, r);
            });
          };
          return s;
        },
      },
    );
    active.push(profiler);
    await traceletAls.run(new Map([['marker', 1]]), () => profiler.start());
    await until(() => profiler.debug().windows.length >= 2);
    await profiler.stop();
    expect(stores.length).toBeGreaterThan(4);
    expect(stores.every((s) => s === undefined)).toBe(true);
    expect(runOutsideTrace(() => traceletAls.getStore())).toBeUndefined();
  });
});

describe('ContinuousProfiler: rotation keep-alive (no CpuProfiler re-creation between stop and start)', () => {
  it('brackets every rotation: keepAlive.begin, Profiler.stop, Profiler.start, keepAlive.end; never around the first start or the final stop', async () => {
    const sessions: FakeSession[] = [];
    const { profiler } = make({ session: { stopMs: 2, startMs: 1 }, sessions, keepAlive: {} });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 3);
    await profiler.stop();
    const calls = sessions[0].calls;
    expect(calls.slice(0, 3)).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
    const rest = calls.slice(3);
    // final stop() closes the last window without a bracket (the CpuProfiler is meant to be disposed then)
    expect(rest[rest.length - 1]).toBe('Profiler.stop');
    const rotations = rest.slice(0, -1);
    expect(rotations.length % 4).toBe(0);
    expect(rotations.length / 4).toBeGreaterThanOrEqual(2);
    rotations.forEach((c, i) => expect(c).toBe(['keepAlive.begin', 'Profiler.stop', 'Profiler.start', 'keepAlive.end'][i % 4]));
    // the bracket does not change the measured stalls or the sample-based gap
    const w = profiler.debug().windows;
    expect(w[1].stopStallMs).toBe(2);
    expect(w[1].startStallMs).toBe(1);
    expect(w[1].gapBeforeMs).toBeCloseTo(2 + 1 + 10, 6);
  });

  it('a failing Profiler.start inside the bracket still ends the keep-alive, delivers the window and reports error', async () => {
    const sessions: FakeSession[] = [];
    const { profiler, queue } = make({
      session: { failMethod: { method: 'Profiler.start', atCall: 1 } },
      sessions,
      keepAlive: {},
      retryDelayMs: 10_000,
    });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'error');
    const calls = sessions[0].calls;
    expect(calls.filter((c) => c === 'keepAlive.begin')).toHaveLength(1);
    expect(calls.filter((c) => c === 'keepAlive.end')).toHaveLength(1);
    expect(calls.indexOf('keepAlive.end')).toBeGreaterThan(calls.lastIndexOf('Profiler.start'));
    expect(queue.depth('profile')).toBe(1);
  });

  it('a failing Profiler.stop inside the bracket still ends the keep-alive', async () => {
    const sessions: FakeSession[] = [];
    const { profiler } = make({ session: { failMethod: { method: 'Profiler.stop', atCall: 0 } }, sessions, keepAlive: {}, retryDelayMs: 10_000 });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'error');
    const calls = sessions[0].calls;
    expect(calls.filter((c) => c === 'keepAlive.begin')).toHaveLength(1);
    expect(calls.filter((c) => c === 'keepAlive.end')).toHaveLength(1);
  });

  it('a throwing keepAlive.begin degrades to a plain stop/start rotation (no end call, state running)', async () => {
    const sessions: FakeSession[] = [];
    const { profiler } = make({ sessions, keepAlive: { begin: true } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 3);
    expect(profiler.profilerHealth().state).toBe('running');
    await profiler.stop();
    const calls = sessions[0].calls;
    expect(calls.filter((c) => c === 'keepAlive.begin').length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c === 'keepAlive.end')).toHaveLength(0);
  });

  it('a throwing keepAlive.end disables the keep-alive after the first failure (at most one extra open profile)', async () => {
    const sessions: FakeSession[] = [];
    const { profiler } = make({ sessions, keepAlive: { end: true } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 3);
    expect(profiler.profilerHealth().state).toBe('running');
    await profiler.stop();
    const calls = sessions[0].calls;
    expect(calls.filter((c) => c === 'keepAlive.begin')).toHaveLength(1);
    expect(calls.filter((c) => c === 'keepAlive.end')).toHaveLength(1);
  });

  it('with an injected session and no injected keep-alive there is no bracket (the default keep-alive targets the real inspector)', async () => {
    const sessions: FakeSession[] = [];
    const { profiler } = make({ sessions });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 2);
    await profiler.stop();
    expect(sessions[0].calls.some((c) => c.startsWith('keepAlive'))).toBe(false);
  });

  it('createInspectorKeepAlive returns a begin/end pair on the real inspector that does not throw', () => {
    const ka = createInspectorKeepAlive();
    expect(ka).toBeDefined();
    expect(() => {
      ka?.begin();
      ka?.end();
    }).not.toThrow();
  });
});

describe('ContinuousProfiler: backoff (M8), no permanent kill switch', () => {
  it('3 consecutive over-budget windows -> backoff with a reason naming the dominant block, then resumes; levels double', async () => {
    const { profiler, queue } = make({ config: { maxStallMs: 100 }, session: { stopMs: 5, startMs: 200 } });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'backoff');
    const h = profiler.profilerHealth();
    expect(h.reason).toMatch(/startStallMs 200/);
    expect(h.reason).toMatch(/dominated by startStallMs/);
    expect(h.reason).toMatch(/maxStallMs 100/);
    expect(h.reason).toMatch(/paused for 1 window/);
    expect(profiler.debug().windows.length).toBe(3);
    // over-budget windows were still offered, not discarded
    expect(queue.depth('profile')).toBe(3);

    // resumes by itself (never a permanent self-disable) and the first window after resume has no gap
    await until(() => profiler.profilerHealth().state === 'running');
    expect(profiler.profilerHealth().reason).toBeUndefined();
    await until(() => profiler.debug().windows.length >= 4);
    expect(profiler.debug().windows[3].gapBeforeMs).toBeUndefined();

    // still over budget: 3 more windows -> second backoff, skip doubles to 2
    await until(() => profiler.profilerHealth().state === 'backoff');
    expect(profiler.profilerHealth().reason).toMatch(/paused for 2 window/);
    expect(profiler.debug().counters.backoffs).toBe(2);
    expect(profiler.debug().counters.lastBackoffReason).toBe(profiler.profilerHealth().reason);
    // never 'disabled' or 'error'
    expect(['backoff', 'running']).toContain(profiler.profilerHealth().state);
  });

  it('a window within budget resets the consecutive counter and the backoff level', async () => {
    // over, over, ok, over, over, ok ... never 3 in a row
    const startMs = (call: number) => (call === 0 ? 0 : call % 3 === 0 ? 5 : 200);
    const { profiler } = make({ config: { maxStallMs: 100 }, session: { stopMs: 1, startMs } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 8);
    expect(profiler.debug().counters.backoffs).toBe(0);
    expect(profiler.profilerHealth().state).toBe('running');
  });

  it('the budget is the SUM of start, stop and fold (each below the limit, sum above)', async () => {
    const { profiler } = make({ config: { maxStallMs: 100 }, session: { stopMs: 60, startMs: 60 } });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'backoff');
    expect(profiler.profilerHealth().reason).toMatch(/window block 120 ms/);
  });
});

describe('ContinuousProfiler: errors', () => {
  it('an inspector error mid-run -> state error with reason, one retry after the delay, then error until restart', async () => {
    const sessions: FakeSession[] = [];
    // every Profiler.stop of the 2nd window on fails; first session also fails -> retry session fails the same way
    const { profiler } = make({ session: { failMethod: { method: 'Profiler.stop', atCall: 0 } }, retryDelayMs: 60, sessions });
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('running');
    await until(() => profiler.profilerHealth().state === 'error');
    expect(profiler.profilerHealth().reason).toMatch(/inspector error: fake Profiler.stop failure/);
    expect(profiler.debug().counters.errors).toBe(1);
    expect(sessions[0].disconnected).toBe(true);
    // retry: new session, same failure at its first stop -> error again, and no further retries
    await until(() => profiler.debug().counters.errors === 2, 3000);
    expect(profiler.profilerHealth().state).toBe('error');
    expect(profiler.profilerHealth().reason).toMatch(/retry failed/);
    const n = sessions.length;
    await sleep(WINDOW * 6 + 150);
    expect(sessions.length).toBe(n);
    expect(profiler.profilerHealth().state).toBe('error');
  });

  it('a successful retry returns to running', async () => {
    const sessions: FakeSession[] = [];
    const clock = new FakeClock();
    let created = 0;
    const profiler = new ContinuousProfiler(
      { enabled: true, windowMs: WINDOW },
      {
        queue: new BoundedTelemetryQueue(),
        serviceName: 's',
        instanceId: 'i',
        now: clock.now,
        retryDelayMs: 40,
        createSession: () => {
          const s = new FakeSession({ clock, ...(created++ === 0 ? { failMethod: { method: 'Profiler.stop', atCall: 0 } } : {}) });
          sessions.push(s);
          return s;
        },
      },
    );
    active.push(profiler);
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'error');
    await until(() => profiler.profilerHealth().state === 'running');
    await until(() => profiler.debug().windows.length >= 1);
    expect(sessions).toHaveLength(2);
    // first window after the restart carries no gap
    expect(profiler.debug().windows[0].gapBeforeMs).toBeUndefined();
  });

  it('a failing Profiler.start in the rotation still delivers the finished window, then state error', async () => {
    const { profiler, queue } = make({ session: { failMethod: { method: 'Profiler.start', atCall: 1 } }, retryDelayMs: 10_000 });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'error');
    expect(profiler.debug().windows.length).toBe(1);
    expect(queue.depth('profile')).toBe(1);
  });

  it('enabled false is disabled; stop() on a never-started profiler is a no-op', async () => {
    const { profiler } = make({ config: { enabled: false } });
    await profiler.start();
    expect(profiler.profilerHealth().state).toBe('disabled');
    await profiler.stop();
    expect(profiler.profilerHealth().state).toBe('disabled');
  });
});

describe('ContinuousProfiler: boundedness and drop counting', () => {
  it('the profile pool never exceeds maxQueuedProfiles; rejected offers are counted by the queue exactly once', async () => {
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 2 });
    const { profiler } = make({ queue });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 6);
    await profiler.stop();
    const windows = profiler.debug().windows.length;
    expect(queue.depth('profile')).toBe(2);
    expect(queue.counters().profilesDropped).toBe(windows - 2);
    expect(profiler.debug().counters.profilesRejected).toBe(windows - 2);
    expect(profiler.debug().counters.profilesOffered).toBe(windows);
  });

  it('the debug window ring is bounded and the stop() flush is offered as a final window', async () => {
    const { profiler, queue } = make({ config: { windowMs: 10_000 } });
    await profiler.start();
    await sleep(30);
    await profiler.stop();
    const w = profiler.debug().windows;
    expect(w).toHaveLength(1);
    expect(w[0].final).toBe(true);
    expect(w[0].startStallMs).toBe(0);
    expect(queue.depth('profile')).toBe(1);
    expect(profiler.profilerHealth().state).toBe('stopped');
  });

  it('a window without any sample is not offered and is counted as empty', async () => {
    const { profiler, queue } = make({ session: { samplesPerWindow: 0 } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 2);
    await profiler.stop();
    expect(queue.depth('profile')).toBe(0);
    expect(profiler.debug().counters.emptyWindows).toBe(profiler.debug().windows.length);
  });

  it('profilerHealth reports the configured and the achieved sample rate', async () => {
    const { profiler } = make({ session: { samplesPerWindow: 11, intervalMs: 10 } });
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 1);
    const h = profiler.profilerHealth();
    expect(h.sampleRateHz).toBe(99);
    expect(h.windowMs).toBe(WINDOW);
    expect(h.achievedSampleRateHz).toBeCloseTo(100, 1);
    expect(h.lastWindowAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('probeInspector', () => {
  it('reports the real process as available, the flag 0 and a failing connect as unavailable', () => {
    expect(probeInspector().available).toBe(true);
    expect(probeInspector({ v8EnableInspector: 0 }).available).toBe(false);
    class Bad {
      connect(): void {
        throw new Error('nope');
      }
      disconnect(): void {}
    }
    const r = probeInspector({ v8EnableInspector: 1, loadInspector: () => ({ Session: Bad }) });
    expect(r).toEqual({ available: false, reason: 'inspector Session.connect() failed: nope' });
  });
});
