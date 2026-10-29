import { describe, expect, it } from 'vitest';
import { achievedSampleRateHz, foldProfile, sanitizeFramePath, TRUNCATED_FRAME } from '../../../src/profiling/vendor/fold-profile.js';
import type { V8Profile, V8ProfileNode } from '../../../src/profiling/vendor/fold-profile.js';

const node = (id: number, functionName: string, url = '', lineNumber = -1, children?: number[]): V8ProfileNode => ({
  id,
  callFrame: { functionName, url, lineNumber, columnNumber: 0 },
  ...(children ? { children } : {}),
});

/** Shape of resources/fixtures/cpu-samples.folded (read-only kit fixture, copied here as literal lines): "<;-joined frames> <count>". */
const FIXTURE_FOLDED = [
  'node;MessageConsumer.handle;Transformer.execute;compileMapping 46',
  'node;MessageConsumer.handle;Transformer.execute;JSON.stringify 24',
  'node;Validator.validate;checkSchema 17',
  'node;runtime;gc 13',
];

describe('foldProfile', () => {
  it('produces "frame;frame count" lines in the cpu-samples.folded shape, root-first, most samples first', () => {
    // tree mirroring the fixture: (root) -> node -> {MessageConsumer.handle -> Transformer.execute -> {compileMapping, JSON.stringify}, Validator.validate -> checkSchema, runtime -> gc}
    const nodes = [
      node(1, '(root)', '', -1, [2]),
      node(2, 'node', '', -1, [3, 7, 9]),
      node(3, 'MessageConsumer.handle', '', -1, [4]),
      node(4, 'Transformer.execute', '', -1, [5, 6]),
      node(5, 'compileMapping'),
      node(6, 'JSON.stringify'),
      node(7, 'Validator.validate', '', -1, [8]),
      node(8, 'checkSchema'),
      node(9, 'runtime', '', -1, [10]),
      node(10, 'gc'),
    ];
    const samples: number[] = [];
    const add = (id: number, n: number) => samples.push(...new Array<number>(n).fill(id));
    add(10, 13);
    add(5, 46);
    add(8, 17);
    add(6, 24);
    const profile: V8Profile = { nodes, startTime: 1_000_000, endTime: 3_000_000, samples, timeDeltas: samples.map(() => 10_000) };
    const fold = foldProfile(profile, { cwd: '/app' });
    const lines = fold.stacks.map((s) => `${s.stack} ${s.samples}`);
    expect(lines).toEqual(FIXTURE_FOLDED);
    expect(fold.sampleCount).toBe(100);
    expect(fold.idleSampleCount).toBe(0);
    expect(fold.totalSampleCount).toBe(100);
    for (const l of lines) expect(l).toMatch(/^[^ ;][^ ]*(;[^ ;]+)* \d+$/);
  });

  it('formats frames as "fn relpath:line" (1-based), strips file://, keeps native frames, program and gc, drops root and idle', () => {
    const cwd = process.platform === 'win32' ? 'C:/app' : '/app';
    const url = process.platform === 'win32' ? 'file:///C:/app/src/svc.js' : 'file:///app/src/svc.js';
    const nodes = [
      node(1, '(root)', '', -1, [2, 3, 4, 5]),
      node(2, '(idle)'),
      node(3, '(program)'),
      node(4, '(garbage collector)'),
      node(5, 'handle', url, 41, [6]),
      node(6, '', url, 0, [7]),
      node(7, 'node:internal/fs', 'node:internal/fs/promises', 9),
    ];
    const profile: V8Profile = { nodes, startTime: 0, endTime: 100_000, samples: [2, 3, 4, 6, 7], timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000] };
    const fold = foldProfile(profile, { cwd });
    const byStack = new Map(fold.stacks.map((s) => [s.stack, s.samples]));
    expect(byStack.get('(program)')).toBe(1);
    expect(byStack.get('(garbage collector)')).toBe(1);
    expect(byStack.get('handle src/svc.js:42;(anonymous) src/svc.js:1')).toBe(1);
    expect(byStack.get('handle src/svc.js:42;(anonymous) src/svc.js:1;node:internal/fs node:internal/fs/promises:10')).toBe(1);
    expect(fold.idleSampleCount).toBe(1);
    expect(fold.sampleCount).toBe(4);
    expect(fold.totalSampleCount).toBe(5);
  });

  it("replaces ';' inside a frame with ','", () => {
    const nodes = [node(1, '(root)', '', -1, [2]), node(2, 'a;b;c')];
    const fold = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [2], timeDeltas: [1] });
    expect(fold.stacks[0].stack).toBe('a,b,c');
  });

  it('counts idle separately and derives first/last sample times from startTime + cumulative timeDeltas (idle included)', () => {
    const nodes = [node(1, '(root)', '', -1, [2, 3]), node(2, '(idle)'), node(3, 'work')];
    const profile: V8Profile = { nodes, startTime: 1_000, endTime: 99_999, samples: [2, 3, 2, 2], timeDeltas: [500, 10_000, 10_000, 10_000] };
    const fold = foldProfile(profile);
    expect(fold.firstSampleUs).toBe(1_500);
    expect(fold.lastSampleUs).toBe(31_500);
    expect(fold.idleSampleCount).toBe(3);
    expect(fold.sampleCount).toBe(1);
    expect(fold.totalSampleCount).toBe(4);
    // endTime plays no role in the sample range
    expect(fold.lastSampleUs).not.toBe(profile.endTime);
  });

  it('caps depth: keeps the 127 leaf-most frames behind a (truncated) root frame', () => {
    const nodes: V8ProfileNode[] = [node(1, '(root)', '', -1, [2])];
    for (let i = 2; i <= 301; i++) nodes.push(node(i, `f${i}`, '', -1, i < 301 ? [i + 1] : undefined));
    const fold = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [301], timeDeltas: [1] });
    const frames = fold.stacks[0].stack.split(';');
    expect(frames).toHaveLength(128);
    expect(frames[0]).toBe(TRUNCATED_FRAME);
    expect(frames[1]).toBe('f175');
    expect(frames[127]).toBe('f301');
    const small = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [301], timeDeltas: [1] }, { maxFramesPerStack: 10 });
    expect(small.stacks[0].stack.split(';')).toHaveLength(10);
  });

  it('merges stacks that become equal after truncation and sorts deterministically', () => {
    const nodes = [
      node(1, "(root)", "", -1, [10]),
      node(10, "p", "", -1, [11, 21]),
      node(11, "x", "", -1, [12]),
      node(12, "leaf"),
      node(21, "y", "", -1, [22]),
      node(22, "leaf"),
    ];
    const fold = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [12, 22, 22], timeDeltas: [1, 1, 1] }, { maxFramesPerStack: 2 });
    expect(fold.stacks).toEqual([{ stack: `${TRUNCATED_FRAME};leaf`, samples: 3 }]);
  });

  it('empty and sample-less profiles fold to zero counts without sample times', () => {
    const fold = foldProfile({ nodes: [node(1, '(root)')], startTime: 0, endTime: 1 });
    expect(fold).toEqual({ stacks: [], sampleCount: 0, idleSampleCount: 0, totalSampleCount: 0 });
  });
});

describe('achievedSampleRateHz', () => {
  it('is (samples including idle - 1) / (first-to-last sample span in seconds)', () => {
    // 100 samples 10 ms apart: span 990 ms -> 99 intervals / 0.99 s = 100 Hz
    expect(achievedSampleRateHz(100, 990)).toBeCloseTo(100, 10);
    expect(achievedSampleRateHz(496, 5000)).toBeCloseTo(99, 10);
  });
  it('is undefined when it is not defined', () => {
    expect(achievedSampleRateHz(1, 0)).toBeUndefined();
    expect(achievedSampleRateHz(0, 0)).toBeUndefined();
    expect(achievedSampleRateHz(10, 0)).toBeUndefined();
    expect(achievedSampleRateHz(10, -5)).toBeUndefined();
  });
  it('the sampler computes it from sample timestamps and sampleCount + idleSampleCount', async () => {
    const { ContinuousCpuSampler } = await import('../../../src/profiling/vendor/cpu-sampler.js');
    const { FakeClock, FakeSession } = await import('../../support/profiling/fake-session.js');
    const clock = new FakeClock();
    const windows: any[] = [];
    const sampler = new ContinuousCpuSampler({
      sampleRateHz: 99,
      windowMs: 5000,
      now: clock.now,
      createSession: () => new FakeSession({ clock, samplesPerWindow: 11, intervalMs: 10, idleEvery: 4 }),
      onWindow: (w) => void windows.push(w),
      onError: () => undefined,
    });
    await sampler.start();
    await sampler.stop();
    const w = windows[0];
    expect(w.fold.sampleCount + w.fold.idleSampleCount).toBe(11);
    expect(w.sampledSpanMs).toBeCloseTo(100, 6);
    expect(w.achievedSampleRateHz).toBeCloseTo(100, 6);
  });
});

describe('sanitizeFramePath (M2: no absolute paths, drive letters or user names are stored)', () => {
  const winCwd = 'D:/work/app';
  const posixCwd = '/srv/app';

  it('keeps paths inside cwd relative (both flavours, case-insensitive drive)', () => {
    expect(sanitizeFramePath('file:///D:/work/app/src/a.js', winCwd)).toBe('src/a.js');
    expect(sanitizeFramePath('file:///d:/WORK/app/src/a.js', winCwd)).toBe('src/a.js');
    expect(sanitizeFramePath('file:///srv/app/dist/b.js', posixCwd)).toBe('dist/b.js');
    expect(sanitizeFramePath('src/rel.js', posixCwd)).toBe('src/rel.js');
  });

  it('another drive becomes <external>/<basename>', () => {
    const r = sanitizeFramePath('file:///C:/Users/Alice/AppData/Local/Temp/code-heavy.cjs', winCwd);
    expect(r).toBe('<external>/code-heavy.cjs');
    expect(r).not.toMatch(/Alice|Users|C:/);
  });

  it('a path outside cwd on the same drive or root becomes <external>/<basename> (never ../..)', () => {
    expect(sanitizeFramePath('file:///D:/other/place/x.js', winCwd)).toBe('<external>/x.js');
    expect(sanitizeFramePath('file:///home/bob/proj/x.js', posixCwd)).toBe('<external>/x.js');
    expect(sanitizeFramePath('../../up/y.js', posixCwd)).toBe('<external>/y.js');
  });

  it('a UNC path (raw or as a file URL) becomes <external>/<basename>', () => {
    const bs = String.fromCharCode(92);
    expect(sanitizeFramePath(bs + bs + 'fileserver' + bs + 'share' + bs + 'alice' + bs + 'z.js', winCwd)).toBe('<external>/z.js');
    expect(sanitizeFramePath('file://fileserver/share/alice/z.js', posixCwd)).toBe('<external>/z.js');
  });

  it('a posix absolute path outside cwd and a raw Windows path are reduced', () => {
    expect(sanitizeFramePath('/usr/lib/node/x.js', posixCwd)).toBe('<external>/x.js');
    expect(sanitizeFramePath('C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'bob' + String.fromCharCode(92) + 'p.js', winCwd)).toBe('<external>/p.js');
  });

  it('shortens node_modules/<pkg>/... (also scoped packages) outside cwd', () => {
    expect(sanitizeFramePath('file:///C:/Users/Alice/other/node_modules/lodash/fp/get.js', winCwd)).toBe('node_modules/lodash/fp/get.js');
    expect(sanitizeFramePath('file:///opt/x/node_modules/a/node_modules/@nestjs/core/injector.js', posixCwd)).toBe('node_modules/@nestjs/core/injector.js');
    // inside cwd it stays the plain relative path
    expect(sanitizeFramePath('file:///srv/app/node_modules/rxjs/index.js', posixCwd)).toBe('node_modules/rxjs/index.js');
  });

  it('keeps node: urls and never stores other schemes verbatim', () => {
    expect(sanitizeFramePath('node:internal/fs/promises', posixCwd)).toBe('node:internal/fs/promises');
    expect(sanitizeFramePath('https://user:secret@example.com/a/b.js?token=1', posixCwd)).toBe('<external>/b.js');
    expect(sanitizeFramePath('data:text/javascript,alert(1)', posixCwd)).toMatch(/^<external>\//);
  });

  it('frames produced by foldProfile never contain an absolute path', () => {
    const nodes = [
      node(1, '(root)', '', -1, [2, 3]),
      node(2, 'a', 'file:///C:/Users/Alice/secret/proj/a.js', 4),
      node(3, 'b', 'file:///D:/elsewhere/b.js', 9),
    ];
    const fold = foldProfile({ nodes, startTime: 0, endTime: 1, samples: [2, 3], timeDeltas: [1, 1] }, { cwd: 'D:/work/app' });
    const text = fold.stacks.map((s) => s.stack).join('|');
    expect(text).toContain('a <external>/a.js:5');
    expect(text).toContain('b <external>/b.js:10');
    expect(text).not.toMatch(/Alice|Users|[A-Za-z]:\/|elsewhere/);
  });
});

describe('sanitizeFramePath round 2 (credentials without a path, non-normalized paths, data: urls)', () => {
  const cwd = '/srv/app';
  const BS = String.fromCharCode(92);

  it('a URL with no path never leaks credentials, host, port or query', () => {
    for (const u of ['https://user:pass@cdn.example.com', 'https://user:pass@cdn.example.com/', 'http://alice:pw@h:8080?x=1', 'http://alice:pw@h:8080#frag']) {
      const r = sanitizeFramePath(u, cwd);
      expect(r, u).toBe('<external>/unknown');
      expect(r).not.toMatch(/alice|user|pass|pw|example|8080|x=1/);
    }
    expect(sanitizeFramePath('https://u:p@cdn.example.com/a/b/app.js?t=1#h', cwd)).toBe('<external>/app.js');
    expect(sanitizeFramePath('not-a-url:::', cwd)).toBe('<external>/unknown');
  });

  it('non-normalized paths are collapsed before the cwd test', () => {
    expect(sanitizeFramePath('/srv/app/../../home/alice/x.js', cwd)).toBe('<external>/x.js');
    expect(sanitizeFramePath('src/../../../home/alice/x.js', cwd)).toBe('<external>/x.js');
    expect(sanitizeFramePath('a' + BS + '..' + BS + '..' + BS + 'Users' + BS + 'alice' + BS + 'x.js', 'C:/work')).toBe('<external>/x.js');
    expect(sanitizeFramePath('/srv/app/src/./a/../b.js', cwd)).toBe('src/b.js');
    expect(sanitizeFramePath('file:///srv/app/x/../../../etc/passwd', cwd)).toBe('<external>/passwd');
  });

  it('data: urls never keep code', () => {
    expect(sanitizeFramePath('data:text/javascript,const k=1', cwd)).toBe('<external>/data');
    expect(sanitizeFramePath('data:application/json;base64,AAAA', cwd)).toBe('<external>/data');
  });
});
