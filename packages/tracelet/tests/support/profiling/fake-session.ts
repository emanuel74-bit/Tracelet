import type { InspectorSessionLike, RotationKeepAlive } from '../../../src/profiling/vendor/cpu-sampler.js';
import type { V8Profile } from '../../../src/profiling/vendor/fold-profile.js';

/** Deterministic clock shared by a FakeSession and the sampler under test (ms). */
export class FakeClock {
  ms = 1_000;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

export interface FakeSessionOptions {
  clock: FakeClock;
  /** Simulated event-loop block of Profiler.stop / Profiler.start (advance the fake clock and V8 time). Numbers or per-call functions. */
  stopMs?: number | ((call: number) => number);
  startMs?: number | ((call: number) => number);
  /** Samples per window and spacing (ms). */
  samplesPerWindow?: number;
  intervalMs?: number;
  /** Throw from connect(). */
  failConnect?: boolean;
  /** Fail the n-th (0-based) call of this method with an error. */
  failMethod?: { method: string; atCall: number; error?: string };
  /** Include (idle) samples: every k-th sample is idle (0 = none). */
  idleEvery?: number;
}

const NODES = [
  { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4] },
  { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1 } },
  { id: 3, callFrame: { functionName: 'burnCpu', url: 'file:///app/work.js', lineNumber: 9, columnNumber: 0 }, children: [5] },
  { id: 4, callFrame: { functionName: '(program)', url: '', lineNumber: -1, columnNumber: -1 } },
  { id: 5, callFrame: { functionName: 'inner', url: 'file:///app/work.js', lineNumber: 19, columnNumber: 0 } },
];

/** An InspectorSessionLike that answers the Profiler.* methods the sampler uses with synthetic V8 profiles. */
export class FakeSession implements InspectorSessionLike {
  connected = false;
  disconnected = false;
  calls: string[] = [];
  private counts = new Map<string, number>();
  private v8Us = 5_000_000;
  private startUs = 0;
  private sampleBaseUs = 0;
  private profiling = false;

  constructor(private readonly o: FakeSessionOptions) {}

  /** A rotation keep-alive that records 'keepAlive.begin' / 'keepAlive.end' in this session's call log; optional failures. */
  keepAlive(fail?: { begin?: boolean; end?: boolean; costMs?: number }): RotationKeepAlive {
    return {
      begin: () => {
        this.calls.push('keepAlive.begin');
        if (fail?.costMs) this.o.clock.advance(fail.costMs);
        if (fail?.begin) throw new Error('fake keep-alive begin failure');
      },
      end: () => {
        this.calls.push('keepAlive.end');
        if (fail?.end) throw new Error('fake keep-alive end failure');
      },
    };
  }

  connect(): void {
    if (this.o.failConnect) throw new Error('fake connect failure');
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected = false;
  }

  post(method: string, _params: object | undefined, callback: (err: Error | null, result?: any) => void): void {
    this.calls.push(method);
    const n = this.counts.get(method) ?? 0;
    this.counts.set(method, n + 1);
    const f = this.o.failMethod;
    if (f && f.method === method && f.atCall === n) {
      callback(new Error(f.error ?? `fake ${method} failure`));
      return;
    }
    const pick = (v: number | ((c: number) => number) | undefined): number => (typeof v === 'function' ? v(n) : (v ?? 0));
    if (method === 'Profiler.start') {
      this.startUs = this.v8Us;
      const stall = pick(this.o.startMs);
      this.o.clock.advance(stall);
      this.v8Us += stall * 1000;
      this.sampleBaseUs = this.v8Us;
      this.profiling = true;
      callback(null, {});
      return;
    }
    if (method === 'Profiler.stop') {
      if (!this.profiling) {
        callback(new Error('Profiler is not started'));
        return;
      }
      const count = this.o.samplesPerWindow ?? 5;
      const interval = (this.o.intervalMs ?? 10) * 1000;
      const samples: number[] = [];
      const timeDeltas: number[] = [];
      for (let i = 0; i < count; i++) {
        const idle = this.o.idleEvery ? i % this.o.idleEvery === this.o.idleEvery - 1 : false;
        samples.push(idle ? 2 : i % 2 === 0 ? 5 : 4);
        timeDeltas.push(i === 0 ? this.sampleBaseUs - this.startUs + interval : interval);
      }
      const last = this.startUs + timeDeltas.reduce((a, b) => a + b, 0);
      this.v8Us = last;
      const profile: V8Profile = { nodes: NODES, startTime: this.startUs, endTime: last + 500, samples, timeDeltas };
      const stall = pick(this.o.stopMs);
      this.o.clock.advance(stall);
      this.v8Us += stall * 1000;
      this.profiling = false;
      callback(null, { profile });
      return;
    }
    callback(null, {});
  }
}
