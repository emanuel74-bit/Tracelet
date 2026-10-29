import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import { ContinuousProfiler } from '../../../src/profiling/profiler.service.js';
import { samplerBusyWaitReason, samplingIntervalUs } from '../../../src/profiling/vendor/cpu-sampler.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';
import { ScriptedSession } from '../../support/profiling/scripted-session.js';

// V8 11.3 (Node 20) on Windows busy-waits its sampler thread when the next sample is < 100 ms away (measured: one core at idle);
// V8 11.8+ sleeps on a high-resolution waitable timer (Windows 10 1803 / build 17134+). See CR-002.
describe('samplerBusyWaitReason', () => {
  const node20 = '11.3.244.8-node.30';
  const node22 = '12.4.254.21-node.33';
  const win10 = '10.0.19045';

  it('flags Node 20 V8 on Windows at the default 99 Hz and down to 10 Hz', () => {
    for (const hz of [1000, 99, 49, 19, 11, 10]) {
      expect(samplerBusyWaitReason(hz, 'win32', node20, win10), `${hz} Hz`).toMatch(/busy-waits about one core/);
    }
    expect(samplerBusyWaitReason(99, 'win32', node20, win10)).toContain('V8 11.3.244.8-node.30');
  });

  it('does not flag rates whose interval takes the condition-variable path (>= 110 ms, i.e. <= 9 Hz)', () => {
    expect(samplingIntervalUs(9)).toBeGreaterThanOrEqual(110_000);
    expect(samplingIntervalUs(10)).toBeLessThan(110_000);
    for (const hz of [9, 5, 1]) expect(samplerBusyWaitReason(hz, 'win32', node20, win10), `${hz} Hz`).toBeUndefined();
  });

  it('does not flag non-Windows platforms (V8 waits on a condition variable there)', () => {
    for (const p of ['linux', 'darwin', 'freebsd']) expect(samplerBusyWaitReason(99, p, node20, '6.8.0')).toBeUndefined();
  });

  it('does not flag V8 >= 11.8 on Windows 10 1803+, but does on an older Windows build', () => {
    expect(samplerBusyWaitReason(99, 'win32', node22, win10)).toBeUndefined();
    expect(samplerBusyWaitReason(99, 'win32', '11.8.172.17-node.15', '10.0.17134')).toBeUndefined();
    expect(samplerBusyWaitReason(99, 'win32', '13.6.233.10-node.20', '10.0.22631')).toBeUndefined();
    expect(samplerBusyWaitReason(99, 'win32', node22, '10.0.14393')).toMatch(/Windows build 14393 has no high-resolution/);
    // unknown OS build: assume the timer exists (no false alarm)
    expect(samplerBusyWaitReason(99, 'win32', node22, '')).toBeUndefined();
  });

  it('is defensive about odd inputs and never throws', () => {
    expect(samplerBusyWaitReason(0, 'win32', node20, win10)).toBeUndefined();
    expect(samplerBusyWaitReason(Number.NaN, 'win32', node20, win10)).toBeUndefined();
    // unparseable V8 version: treated as old (warn rather than stay silent)
    expect(samplerBusyWaitReason(99, 'win32', '', win10)).toMatch(/busy-waits/);
    expect(samplerBusyWaitReason(99, 'win32', 'garbage', 'x')).toMatch(/busy-waits/);
  });
});

describe('ContinuousProfiler refuses to start where the sampler thread busy-waits (CR-002 option A)', () => {
  const versions = Object.getOwnPropertyDescriptor(process, 'versions')!;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const simulateNode20Windows = (): void => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    Object.defineProperty(process, 'versions', { ...versions, value: { ...process.versions, v8: '11.3.244.8-node.30' } });
  };

  afterEach(() => {
    Object.defineProperty(process, 'versions', versions);
    Object.defineProperty(process, 'platform', platform);
  });

  async function run(sampleRateHz: number, enabled = true) {
    const warnings: string[] = [];
    const calls = { probe: 0, session: 0 };
    const queue = new BoundedTelemetryQueue();
    const p = new ContinuousProfiler(
      { enabled, sampleRateHz, windowMs: 60_000 },
      {
        queue,
        serviceName: 's',
        instanceId: 'i',
        busyWaitReason: samplerBusyWaitReason,
        probe: () => {
          calls.probe++;
          return { available: true };
        },
        createSession: () => {
          calls.session++;
          return new ScriptedSession([]);
        },
        diagnostics: createDiagnostics('t', (level, _scope, message) => {
          if (level === 'warn') warnings.push(message);
        }),
      },
    );
    const tracker = new TimerLeakTracker();
    const before = tracker.snapshot();
    let thrown: unknown;
    try {
      await p.start();
    } catch (err) {
      thrown = err;
    }
    const health = p.profilerHealth();
    const leaked = await tracker.leakedSince(before);
    await p.stop();
    const after = p.profilerHealth();
    tracker.dispose();
    return { warnings, calls, health, after, leaked, thrown, queue, p };
  }

  it('affected runtime at the default 99 Hz: state unavailable with the reason, no probe, no session, no timer, no throw, no item', async () => {
    simulateNode20Windows();
    const r = await run(99);
    expect(r.thrown).toBeUndefined();
    expect(r.health.state).toBe('unavailable');
    expect(r.health.reason).toBe(samplerBusyWaitReason(99));
    expect(r.health.reason).toMatch(/busy-waits about one core/);
    expect(r.health.reason).toContain('sampleRateHz <= 9');
    expect(r.calls).toEqual({ probe: 0, session: 0 });
    expect(r.leaked).toEqual([]);
    expect(r.after.state).toBe('unavailable'); // stop() does not invent a state
    expect(r.queue.depth()).toBe(0);
    expect(r.p.debug().windows).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].startsWith('[tracelet] profiler not started: on Windows the V8 CPU sampler thread busy-waits')).toBe(true);
  });

  it('every rate from 10 Hz up is refused on the affected runtime', async () => {
    simulateNode20Windows();
    for (const hz of [1000, 99, 49, 11, 10]) {
      const r = await run(hz);
      expect([hz, r.health.state, r.calls.session]).toEqual([hz, 'unavailable', 0]);
    }
  });

  it('sampleRateHz <= 9 is the explicit opt-in: running, no warning, no reason', async () => {
    simulateNode20Windows();
    for (const hz of [9, 5, 1]) {
      const r = await run(hz);
      expect([hz, r.health.state, r.health.reason, r.warnings.length]).toEqual([hz, 'running', undefined, 0]);
      expect(r.calls.session).toBe(1);
    }
  });

  it('a disabled profiler stays disabled (not unavailable) on the affected runtime', async () => {
    simulateNode20Windows();
    const r = await run(99, false);
    expect(r.health.state).toBe('disabled');
    expect(r.calls).toEqual({ probe: 0, session: 0 });
  });

  it('with an injected fake session and no busyWaitReason seam, the gate is not applied (fake-session tests stay valid everywhere)', async () => {
    simulateNode20Windows();
    const calls = { session: 0 };
    const p = new ContinuousProfiler(
      { enabled: true, sampleRateHz: 99, windowMs: 60_000 },
      { queue: new BoundedTelemetryQueue(), serviceName: 's', instanceId: 'i', probe: () => ({ available: true }), createSession: () => (calls.session++, new ScriptedSession([])) },
    );
    await p.start();
    expect(p.profilerHealth().state).toBe('running');
    await p.stop();
    expect(calls.session).toBe(1);
  });

  it('an unaffected runtime (this one, unless it is Node 20 on Windows) is unchanged: running at 99 Hz', async () => {
    const r = await run(99);
    const affected = samplerBusyWaitReason(99) !== undefined;
    expect(r.health.state).toBe(affected ? 'unavailable' : 'running');
    expect(r.calls.session).toBe(affected ? 0 : 1);
  });

  it('simulated Node 22 / Windows 10 1803+ and Linux: running at 99 Hz', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    Object.defineProperty(process, 'versions', { ...versions, value: { ...process.versions, v8: '12.4.254.21-node.33' } });
    expect((await run(99)).health.state).toBe(samplerBusyWaitReason(99) === undefined ? 'running' : 'unavailable');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'versions', { ...versions, value: { ...process.versions, v8: '11.3.244.8-node.30' } });
    expect((await run(99)).health.state).toBe('running');
  });
});
