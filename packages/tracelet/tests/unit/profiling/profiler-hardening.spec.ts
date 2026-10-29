import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler } from '../../../src/profiling/index.js';
import { ContinuousCpuSampler, keepAliveDisabledReason } from '../../../src/profiling/vendor/cpu-sampler.js';
import { FakeClock, FakeSession } from '../../support/profiling/fake-session.js';
import { sleep } from '../../support/profiling/load.js';

const WINDOW = 25;
const active: ContinuousProfiler[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((p) => p.stop()));
});

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  expect(cond(), 'condition not reached in time').toBe(true);
}

function profilerWith(session: (n: number, clock: FakeClock) => FakeSession, extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  let n = 0;
  const sessions: FakeSession[] = [];
  const profiler = new ContinuousProfiler(
    { enabled: true, windowMs: WINDOW, ...cfg },
    {
      queue: new BoundedTelemetryQueue({ maxQueuedProfiles: 1000 }),
      serviceName: 's',
      instanceId: 'i',
      now: clock.now,
      retryDelayMs: 30,
      createSession: () => {
        const s = session(n++, clock);
        sessions.push(s);
        return s;
      },
      ...extra,
    },
  );
  active.push(profiler);
  return { profiler, sessions, clock };
}

describe('keepAliveDisabledReason (M1)', () => {
  it('is undefined on a plain environment', () => {
    expect(keepAliveDisabledReason({}, [])).toBeUndefined();
    expect(keepAliveDisabledReason({ NODE_OPTIONS: '--max-old-space-size=512' }, ['--expose-gc'])).toBeUndefined();
    expect(keepAliveDisabledReason({ NODE_V8_COVERAGE: '' }, [])).toBeUndefined();
  });
  it('NODE_V8_COVERAGE turns it off', () => {
    expect(keepAliveDisabledReason({ NODE_V8_COVERAGE: '/tmp/cov' }, [])).toMatch(/NODE_V8_COVERAGE/);
  });
  it('--cpu-prof and every --cpu-prof-* flag in execArgv turn it off', () => {
    for (const flag of ['--cpu-prof', '--cpu-prof-dir=prof', '--cpu-prof-name=x.cpuprofile', '--cpu-prof-interval=500']) {
      expect(keepAliveDisabledReason({}, ['--expose-gc', flag]), flag).toMatch(/execArgv/);
    }
    expect(keepAliveDisabledReason({}, ['--cpu-profile'])).toBeUndefined();
  });
  it('--cpu-prof in NODE_OPTIONS turns it off', () => {
    expect(keepAliveDisabledReason({ NODE_OPTIONS: '--no-warnings --cpu-prof --cpu-prof-dir=x' }, [])).toMatch(/NODE_OPTIONS/);
    expect(keepAliveDisabledReason({ NODE_OPTIONS: '--cpu-prof-dir=x' }, [])).toMatch(/NODE_OPTIONS/);
  });
  it('the default decision of a real-session sampler uses it; an explicit factory or null overrides', async () => {
    const mk = (opts: Partial<ConstructorParameters<typeof ContinuousCpuSampler>[0]>) =>
      new ContinuousCpuSampler({ sampleRateHz: 99, windowMs: 60_000, onWindow: () => undefined, onError: () => undefined, ...opts });
    const off = mk({ keepAliveEnv: () => 'NODE_V8_COVERAGE is set' });
    await off.start();
    expect(off.keepAliveState).toBe('off');
    expect(off.keepAliveOffReason).toBe('NODE_V8_COVERAGE is set');
    await off.stop();
    const on = mk({ keepAliveEnv: () => undefined });
    await on.start();
    expect(on.keepAliveState).toBe('active');
    await on.stop();
    const optOut = mk({ createKeepAlive: null, keepAliveEnv: () => undefined });
    await optOut.start();
    expect(optOut.keepAliveState).toBe('off');
    expect(optOut.keepAliveOffReason).toBe('disabled by option');
    await optOut.stop();
  });
});

describe('debug keepAlive state and cost (M1/M3)', () => {
  it("is 'off' with an injected session, 'active' with a working keep-alive, 'failed' when begin throws", async () => {
    const off = profilerWith((_n, clock) => new FakeSession({ clock }));
    await off.profiler.start();
    expect(off.profiler.debug().keepAlive).toBe('off');
    expect(off.profiler.debug().keepAliveOffReason).toBe('injected session');

    let last: FakeSession | undefined;
    const act = profilerWith((_n, clock) => (last = new FakeSession({ clock })), { createKeepAlive: () => last?.keepAlive({}) });
    await act.profiler.start();
    await until(() => act.profiler.debug().windows.length >= 1);
    expect(act.profiler.debug().keepAlive).toBe('active');

    const bad = profilerWith((_n, clock) => (last = new FakeSession({ clock })), { createKeepAlive: () => last?.keepAlive({ begin: true }) });
    await bad.profiler.start();
    await until(() => bad.profiler.debug().windows.length >= 1);
    expect(bad.profiler.debug().keepAlive).toBe('failed');
  });

  it('records the keep-alive cost separately and names it in the backoff reason when it dominates', async () => {
    let last: FakeSession | undefined;
    const { profiler } = profilerWith(
      (_n, clock) => (last = new FakeSession({ clock, stopMs: 5, startMs: 5 })),
      { createKeepAlive: () => last?.keepAlive({ costMs: 300 }) },
      { maxStallMs: 100 },
    );
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'backoff');
    const w = profiler.debug().windows[0];
    expect(w.keepAliveMs).toBe(300);
    expect(w.stopStallMs).toBe(305);
    expect(profiler.profilerHealth().reason).toMatch(/rotation keep-alive itself cost 300 ms/);
    expect(profiler.profilerHealth().reason).toMatch(/another inspector session has the Profiler enabled/);
  });

  it('a normal backoff reason carries no keep-alive hint', async () => {
    const { profiler } = profilerWith((_n, clock) => new FakeSession({ clock, startMs: 200 }), {}, { maxStallMs: 100 });
    await profiler.start();
    await until(() => profiler.profilerHealth().state === 'backoff');
    expect(profiler.profilerHealth().reason).not.toMatch(/keep-alive/);
  });
});

describe('L1 onWindow throwing', () => {
  it('tears the sampler down before onError: session disconnected, no timer, exactly one error, no more windows', async () => {
    const clock = new FakeClock();
    let session!: FakeSession;
    const errors: unknown[] = [];
    let windows = 0;
    const sampler = new ContinuousCpuSampler({
      sampleRateHz: 99,
      windowMs: WINDOW,
      now: clock.now,
      createSession: () => (session = new FakeSession({ clock })),
      onWindow: () => {
        windows++;
        throw new Error('consumer bug');
      },
      onError: (e) => {
        // by the time the error is reported the session is already gone
        expect(session.disconnected).toBe(true);
        errors.push(e);
      },
    });
    await sampler.start();
    await until(() => errors.length === 1);
    await sleep(WINDOW * 5);
    expect(errors).toHaveLength(1);
    expect(windows).toBe(1);
    expect(sampler.isProfiling).toBe(false);
  });
});

describe('L3 retry budget is restored after a healthy period', () => {
  it('error, retry ok, 10+ healthy windows, a second error is retried again', async () => {
    const { profiler, sessions } = profilerWith((n, clock) => {
      if (n === 0) return new FakeSession({ clock, failMethod: { method: 'Profiler.stop', atCall: 0 } });
      if (n === 1) return new FakeSession({ clock, failMethod: { method: 'Profiler.stop', atCall: 12 } });
      return new FakeSession({ clock });
    });
    await profiler.start();
    await until(() => sessions.length === 3 && profiler.profilerHealth().state === 'running', 8000);
    expect(profiler.debug().counters.errors).toBe(2);
  });
});

describe('L4 negative raw gap is counted, not hidden', () => {
  it('counters.negativeGaps increments and gapBeforeMs is clamped to 0', async () => {
    const { profiler } = profilerWith((_n, clock) => new FakeSession({ clock, stopMs: -50 }));
    await profiler.start();
    await until(() => profiler.debug().windows.length >= 2);
    expect(profiler.debug().windows[1].gapBeforeMs).toBe(0);
    expect(profiler.debug().counters.negativeGaps).toBeGreaterThanOrEqual(1);
  });
});

describe('L2 initial start and resume cost are recorded', () => {
  it('lastInitialStartMs and lastResumeMs appear in the debug counters', async () => {
    const { profiler } = profilerWith((_n, clock) => new FakeSession({ clock, startMs: (c) => (c === 0 ? 70 : 200) }), {}, { maxStallMs: 100 });
    await profiler.start();
    expect(profiler.debug().counters.lastInitialStartMs).toBe(70);
    await until(() => profiler.profilerHealth().state === 'backoff');
    await until(() => profiler.profilerHealth().state === 'running');
    expect(profiler.debug().counters.lastResumeMs).toBe(200);
  });
});

describe('L5 orderly stop is not an inspector fault', () => {
  it('a failing final flush logs no error, counts none, sets state stopped and schedules no retry', async () => {
    const { profiler, sessions } = profilerWith(
      (_n, clock) => new FakeSession({ clock, failMethod: { method: 'Profiler.stop', atCall: 0 } }),
      {},
      { windowMs: 60_000 },
    );
    await profiler.start();
    await profiler.stop();
    expect(profiler.debug().counters.errors).toBe(0);
    expect(profiler.profilerHealth().state).toBe('stopped');
    await sleep(120);
    expect(sessions).toHaveLength(1);
  });
});

describe('retry racing stop()', () => {
  it('a stop() during the retry start leaves no live sampler and the state stopped', async () => {
    const { profiler, sessions } = profilerWith((n, clock) => {
      if (n === 0) return new FakeSession({ clock, failMethod: { method: 'Profiler.stop', atCall: 0 } });
      const s = new FakeSession({ clock });
      const post = s.post.bind(s);
      s.post = (m, p, cb) => {
        if (m === 'Profiler.enable') setTimeout(() => post(m, p, cb), 150);
        else post(m, p, cb);
      };
      return s;
    });
    await profiler.start();
    await until(() => sessions.length === 2);
    await profiler.stop();
    await until(() => sessions[1].disconnected, 3000);
    expect(profiler.profilerHealth().state).toBe('stopped');
    const n = sessions[1].calls.length;
    await sleep(WINDOW * 4);
    expect(sessions[1].calls.length).toBe(n);
  });
});
