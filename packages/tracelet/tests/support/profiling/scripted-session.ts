import type { InspectorSessionLike } from '../../../src/profiling/vendor/cpu-sampler.js';

/**
 * An InspectorSessionLike whose Profiler.stop returns, in order, the profiles it was given (verbatim, not type checked: tests
 * feed malformed JSON on purpose). After the list is exhausted it returns a small valid profile. Profiler.start / enable /
 * setSamplingInterval always succeed.
 */
export class ScriptedSession implements InspectorSessionLike {
  connected = false;
  disconnected = false;
  calls: string[] = [];
  private stops = 0;
  private profiling = false;
  private t = 1_000_000;

  constructor(private readonly profiles: unknown[]) {}

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected = false;
  }

  post(method: string, _params: object | undefined, callback: (err: Error | null, result?: any) => void): void {
    this.calls.push(method);
    if (method === 'Profiler.start') {
      this.profiling = true;
      callback(null, {});
      return;
    }
    if (method === 'Profiler.stop') {
      if (!this.profiling) {
        callback(new Error('Profiler is not started'));
        return;
      }
      this.profiling = false;
      const next = this.stops < this.profiles.length ? this.profiles[this.stops] : this.valid();
      this.stops++;
      callback(null, { profile: next });
      return;
    }
    callback(null, {});
  }

  /** A small valid two-sample profile on the session's own clock. */
  valid(): unknown {
    const start = this.t;
    this.t += 30_000;
    return {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
        { id: 2, callFrame: { functionName: 'ok', url: 'file:///app/ok.js', lineNumber: 0, columnNumber: 0 } },
      ],
      startTime: start,
      endTime: this.t,
      samples: [2, 2],
      timeDeltas: [10_000, 10_000],
    };
  }
}
