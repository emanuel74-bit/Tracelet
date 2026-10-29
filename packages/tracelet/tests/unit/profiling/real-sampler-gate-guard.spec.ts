import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * CR-002 guard: every integration/bench file that can start a REAL V8 sampler must either import the runtime gate
 * (tests/support/profiling/runtime-gate.js: skipIfBusyWait / BUSY_WAIT_REASON / samplerBusyWaitReason) or inject its own
 * session (createSession), otherwise it spins a core on Node 20 + Windows or fails there after minutes. A new file that
 * starts a profiler without either fails this test.
 */
const ROOT = process.cwd();
const REAL_SAMPLER = /\b(ContinuousProfiler|ContinuousCpuSampler)\b|inspector\.Session|new Session\(|createInspectorKeepAlive|Profiler\.start/;
const GATED = /runtime-gate|samplerBusyWaitReason/;
const INJECTED = /createSession\s*[:(]|createSession,/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(int-spec|spec)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('real-sampler tests are gated for Node 20 + Windows', () => {
  const files = [...walk(resolve(ROOT, 'tests/integration')), ...walk(resolve(ROOT, 'bench'))];

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every integration / bench file that starts a profiler imports the gate or injects createSession', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!REAL_SAMPLER.test(src)) continue;
      if (!GATED.test(src) && !INJECTED.test(src)) offenders.push(relative(ROOT, f));
    }
    expect(offenders, 'ungated real-sampler test files (import skipIfBusyWait from tests/support/profiling/runtime-gate.js)').toEqual([]);
  });

  it('files that call skipIfBusyWait call it as the first statement of the test body (before any fixture or artifact write)', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const re = /async \(ctx\) => \{\s*\n\s*(.*)\n/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) if (!m[1].startsWith('skipIfBusyWait(ctx)')) bad.push(`${relative(ROOT, f)}: ${m[1].slice(0, 60)}`);
    }
    expect(bad).toEqual([]);
  });
});
