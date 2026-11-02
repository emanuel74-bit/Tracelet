import { afterEach, describe, expect, it } from 'vitest';
import type { TelemetryQueue } from '../../../src/contracts/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { FakeClock, FakeSession } from '../../support/profiling/fake-session.js';
import type { FakeSessionOptions } from '../../support/profiling/fake-session.js';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';

/** A FakeSession whose Profiler.* answers are held until the test releases them (deterministic deferred inspector startup). */
class GatedSession extends FakeSession {
  readonly pending: Array<{ run: () => void; fail: (e: Error) => void }> = [];
  constructor(
    o: FakeSessionOptions,
    public gated: boolean,
  ) {
    super(o);
  }
  override post(method: string, params: object | undefined, callback: (err: Error | null, result?: any) => void): void {
    if (!this.gated) return super.post(method, params, callback);
    this.pending.push({ run: () => super.post(method, params, callback), fail: (e) => callback(e) });
  }
  /** Answer every held call successfully (and keep answering later ones). */
  release(): void {
    this.gated = false;
    for (const p of this.pending.splice(0)) p.run();
  }
  releaseWithError(message: string): void {
    this.gated = false;
    for (const p of this.pending.splice(0)) p.fail(new Error(message));
  }
}

const profilers: ContinuousProfiler[] = [];
afterEach(async () => {
  await Promise.all(profilers.splice(0).map((p) => p.stop()));
});

async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

function setup(gatedFirst: number) {
  const clock = new FakeClock();
  const sessions: GatedSession[] = [];
  const offered: unknown[] = [];
  const queue = { offer: (item: unknown) => (offered.push(item), true), count: () => undefined } as unknown as TelemetryQueue;
  const profiler = new ContinuousProfiler(
    { enabled: true, sampleRateHz: 99, windowMs: 25 },
    {
      queue,
      serviceName: 'svc',
      instanceId: 'race-1',
      now: clock.now,
      createKeepAlive: null,
      createSession: () => {
        const s = new GatedSession({ clock }, sessions.length < gatedFirst);
        sessions.push(s);
        return s;
      },
    },
  );
  profilers.push(profiler);
  return { profiler, sessions, offered };
}

describe('ContinuousProfiler: stop() racing the initial start (M1)', () => {
  it('delayed success: stop wins, the local sampler is disconnected before publication, state stays stopped, no timers, no offers', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const { profiler, sessions, offered } = setup(1);
      const starting = profiler.start();
      await tick();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].pending.length).toBeGreaterThan(0); // Profiler.enable is held
      await profiler.stop();
      expect(profiler.profilerHealth().state).toBe('stopped');
      sessions[0].release();
      await starting;
      await tick();
      expect(profiler.profilerHealth().state).toBe('stopped');
      expect(profiler.profilerHealth().reason).toBeUndefined();
      expect(sessions[0].disconnected).toBe(true);
      expect(offered).toEqual([]);
      expect(profiler.debug().windows).toEqual([]);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('delayed failure: stop wins, the failure does not relabel the stopped profiler as unavailable', async () => {
    const { profiler, sessions, offered } = setup(1);
    const starting = profiler.start();
    await tick();
    await profiler.stop();
    sessions[0].releaseWithError('inspector went away');
    await starting;
    await tick();
    expect(profiler.profilerHealth().state).toBe('stopped');
    expect(profiler.profilerHealth().reason).toBeUndefined();
    expect(sessions[0].disconnected).toBe(true);
    expect(offered).toEqual([]);
  });

  it('start, stop, start again: the superseded start is torn down and the second sampler survives', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const { profiler, sessions, offered } = setup(1);
      const first = profiler.start();
      await tick();
      await profiler.stop();
      await profiler.start(); // the second session is not gated
      expect(profiler.profilerHealth().state).toBe('running');
      expect(sessions).toHaveLength(2);
      sessions[0].release();
      await first;
      await tick();
      expect(profiler.profilerHealth().state).toBe('running');
      expect(sessions[0].disconnected).toBe(true);
      expect(sessions[1].disconnected).toBe(false);
      expect(offered).toEqual([]);
      await profiler.stop();
      expect(profiler.profilerHealth().state).toBe('stopped');
      expect(sessions[1].disconnected).toBe(true);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('start, stop, start again with the first start failing late: the second start is not disturbed', async () => {
    const { profiler, sessions } = setup(1);
    const first = profiler.start();
    await tick();
    await profiler.stop();
    await profiler.start();
    sessions[0].releaseWithError('late failure');
    await first;
    await tick();
    expect(profiler.profilerHealth().state).toBe('running');
    expect(sessions[1].disconnected).toBe(false);
  });

  it('resume() after backoff: stop while the resume is in flight leaves a stopped, disconnected profiler with no offers or timers', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const clock = new FakeClock();
      const sessions: GatedSession[] = [];
      const offered: unknown[] = [];
      const queue = { offer: (i: unknown) => (offered.push(i), true), count: () => undefined } as unknown as TelemetryQueue;
      const profiler = new ContinuousProfiler(
        { enabled: true, sampleRateHz: 99, windowMs: 25, maxStallMs: 1 },
        {
          queue,
          serviceName: 'svc',
          instanceId: 'race-3',
          now: clock.now,
          createKeepAlive: null,
          createSession: () => {
            const s = new GatedSession({ clock, stopMs: 30, startMs: 30 }, false);
            sessions.push(s);
            return s;
          },
        },
      );
      profilers.push(profiler);
      await profiler.start();
      const until = async (cond: () => boolean): Promise<void> => {
        const end = Date.now() + 3000;
        while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
        expect(cond()).toBe(true);
      };
      await until(() => profiler.profilerHealth().state === 'backoff');
      sessions[0].gated = true; // the resume's Profiler.start is now held
      await until(() => sessions[0].pending.some(() => true));
      const offeredBefore = offered.length;
      await profiler.stop();
      sessions[0].release();
      await tick(10);
      expect(profiler.profilerHealth().state).toBe('stopped');
      expect(profiler.profilerHealth().reason).toBeUndefined();
      expect(sessions[0].disconnected).toBe(true);
      expect(offered.length).toBe(offeredBefore);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });

  it('retry(): stop and a fresh start while the retry is starting never let the retry publish or kill the new sampler', async () => {
    // session 0: first Profiler.stop fails -> error state -> retry timer; session 1 (the retry): held; session 2: fresh start after stop
    const clock = new FakeClock();
    const sessions: GatedSession[] = [];
    const queue = { offer: () => true, count: () => undefined } as unknown as TelemetryQueue;
    const profiler = new ContinuousProfiler(
      { enabled: true, sampleRateHz: 99, windowMs: 25 },
      {
        queue,
        serviceName: 'svc',
        instanceId: 'race-2',
        now: clock.now,
        createKeepAlive: null,
        retryDelayMs: 5,
        createSession: () => {
          const i = sessions.length;
          const s = new GatedSession({ clock, ...(i === 0 ? { failMethod: { method: 'Profiler.stop', atCall: 0 } } : {}) }, i === 1);
          sessions.push(s);
          return s;
        },
      },
    );
    profilers.push(profiler);
    await profiler.start();
    const deadline = Date.now() + 3000;
    while (sessions.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(sessions).toHaveLength(2); // the retry began and its inspector start is held
    await profiler.stop();
    await profiler.start(); // session 2, not gated
    expect(sessions).toHaveLength(3);
    expect(profiler.profilerHealth().state).toBe('running');
    sessions[1].release();
    await tick(10);
    expect(profiler.profilerHealth().state).toBe('running');
    expect(sessions[1].disconnected).toBe(true);
    expect(sessions[2].disconnected).toBe(false);
    await profiler.stop();
    expect(profiler.profilerHealth().state).toBe('stopped');
    expect(sessions[2].disconnected).toBe(true);
  });
});
