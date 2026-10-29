import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { ProfileItem } from '../../../src/contracts/index.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import { ContinuousProfiler, foldProfile, toProfileItem } from '../../../src/profiling/index.js';
import type { V8Profile } from '../../../src/profiling/vendor/fold-profile.js';
import { ScriptedSession } from '../../support/profiling/scripted-session.js';
import { sleep } from '../../support/profiling/load.js';

/* M06 / T09-T10 additions: malformed profile JSON never throws, never yields an invalid ProfileItem, and a structurally unusable
 * window is counted as a dropped profile. */

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const validateProfile = ajv.getSchema((schema as { $id: string }).$id + '#/$defs/CpuProfile')!;

const frame = (functionName: string, url = '', lineNumber = -1) => ({ functionName, url, lineNumber, columnNumber: 0 });
const ROOT = { id: 1, callFrame: frame('(root)'), children: [2] };
const nodeA = { id: 2, callFrame: frame('a', 'file:///app/a.js', 4) };
const base = (over: Record<string, unknown> = {}): V8Profile =>
  ({ nodes: [ROOT, nodeA], startTime: 1_000_000, endTime: 1_100_000, samples: [2, 2, 2], timeDeltas: [10_000, 10_000, 10_000], ...over }) as V8Profile;

function assertValid(p: V8Profile, opts: { maxStacksPerProfile?: number; maxProfileBytes?: number } = {}): ProfileItem {
  const fold = foldProfile(p, { cwd: '/app' });
  const item = toProfileItem(fold, {
    serviceName: 's',
    instanceId: 'i',
    periodStartMs: 1000,
    periodEndMs: 2000,
    sampleRateHz: 99,
    durationMs: 100,
    ...opts,
  });
  expect(validateProfile(item.profile), JSON.stringify(validateProfile.errors)).toBe(true);
  const p2 = item.profile;
  expect(p2.stacks.reduce((a, s) => a + s.samples, 0) + (p2.droppedSampleCount ?? 0)).toBe(p2.sampleCount);
  expect(JSON.stringify(item.profile).length).toBeLessThanOrEqual(opts.maxProfileBytes ?? 1024 * 1024);
  return item;
}

describe('foldProfile on malformed input never throws and mapping always yields a schema-valid ProfileItem', () => {
  it('missing nodes array: malformed, nothing folded', () => {
    const f = foldProfile({ startTime: 0, endTime: 1, samples: [1], timeDeltas: [1] } as unknown as V8Profile);
    expect(f.malformed).toMatch(/no nodes/);
    expect(f.stacks).toEqual([]);
    const item = toProfileItem(f, { serviceName: 's', instanceId: 'i', periodStartMs: 1, periodEndMs: 2, sampleRateHz: 99, durationMs: 0 });
    expect(validateProfile(item.profile)).toBe(true);
  });

  it('null / non-object / samples not an array', () => {
    expect(foldProfile(null as unknown as V8Profile).malformed).toBeDefined();
    expect(foldProfile(42 as unknown as V8Profile).malformed).toBeDefined();
    expect(foldProfile(base({ samples: 'x' })).malformed).toMatch(/samples/);
    expect(foldProfile(base({ nodes: { not: 'an array' } })).malformed).toBeDefined();
  });

  it('a profile without samples is a valid empty window (not malformed)', () => {
    const f = foldProfile({ nodes: [ROOT], startTime: 0, endTime: 10 } as V8Profile);
    expect(f.malformed).toBeUndefined();
    expect(f.totalSampleCount).toBe(0);
  });

  it('cycles in the parent chain terminate, are counted and give a bounded stack', () => {
    const nodes = [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('a', 'file:///app/a.js', 1), children: [3] },
      { id: 3, callFrame: frame('b', 'file:///app/b.js', 2), children: [2] }, // 3 -> 2 closes a loop
    ];
    const f = foldProfile(base({ nodes, samples: [3, 3] }), { cwd: '/app' });
    expect(f.cycleCount).toBeGreaterThan(0);
    expect(f.sampleCount).toBe(2);
    expect(f.stacks[0].stack.startsWith('(truncated);')).toBe(true);
    assertValid(base({ nodes, samples: [3, 3] }));
    // self-referential node
    const self = [{ id: 1, callFrame: frame('(root)'), children: [1, 2] }, nodeA];
    expect(() => foldProfile(base({ nodes: self }))).not.toThrow();
  });

  it('negative, NaN, infinite, string and missing timeDeltas are neutralised and counted, timestamps stay finite and monotonic', () => {
    const p = base({ samples: [2, 2, 2, 2, 2], timeDeltas: [-5, Number.NaN, Number.POSITIVE_INFINITY, 'x', 1000] });
    const f = foldProfile(p);
    expect(f.invalidDeltaCount).toBe(4);
    expect(Number.isFinite(f.firstSampleUs)).toBe(true);
    expect(Number.isFinite(f.lastSampleUs)).toBe(true);
    expect((f.lastSampleUs as number) >= (f.firstSampleUs as number)).toBe(true);
    assertValid(p);
    const short = foldProfile(base({ samples: [2, 2, 2], timeDeltas: [10] }));
    expect(short.totalSampleCount).toBe(3);
    expect(short.invalidDeltaCount).toBeUndefined();
  });

  it('NaN / non-numeric startTime and endTime do not poison the item', () => {
    assertValid(base({ startTime: Number.NaN, endTime: undefined }));
    assertValid(base({ startTime: 'a', endTime: 'b' }));
  });

  it('huge callFrame strings are capped before frames are built (name 256, frame 512) and the item stays schema-valid', () => {
    const huge = 'x'.repeat(2_000_000);
    const nodes = [ROOT, { id: 2, callFrame: frame(huge, 'file:///app/' + huge + '.js', 3) }];
    const f = foldProfile(base({ nodes }), { cwd: '/app' });
    expect(f.stacks).toHaveLength(1);
    expect(f.stacks[0].stack.length).toBeLessThanOrEqual(512);
    assertValid(base({ nodes }));
  });

  it('non-string / missing callFrame fields are tolerated', () => {
    const nodes = [
      ROOT,
      { id: 2, callFrame: { functionName: 12, url: null, lineNumber: 'q', columnNumber: {} } },
      { id: 3, callFrame: undefined },
    ] as unknown as V8Profile['nodes'];
    (nodes[0] as { children: number[] }).children = [2, 3];
    const p = base({ nodes, samples: [2, 3, 3] });
    expect(() => foldProfile(p)).not.toThrow();
    assertValid(p);
  });

  it("a ';' in function names or urls cannot add frames; names with newlines and control characters stay in one frame", () => {
    const nodes = [ROOT, { id: 2, callFrame: frame('evil;frame\nname\u0000', 'file:///app/a;b.js', 0) }];
    const f = foldProfile(base({ nodes, samples: [2] }), { cwd: '/app' });
    expect(f.stacks[0].stack.split(';')).toHaveLength(1);
    assertValid(base({ nodes, samples: [2] }));
  });

  it('stacks deeper than the cap keep the leaf-most frames behind (truncated); a 200 000 deep chain is bounded', () => {
    const depth = 200_000;
    const nodes: V8Profile['nodes'] = [{ id: 1, callFrame: frame('(root)'), children: [2] }];
    for (let i = 2; i <= depth; i++) {
      nodes.push({ id: i, callFrame: frame(`f${i}`, 'file:///app/deep.js', i), ...(i < depth ? { children: [i + 1] } : {}) });
    }
    const t0 = Date.now();
    const f = foldProfile(base({ nodes, samples: [depth, depth] }), { cwd: '/app', maxFramesPerStack: 128 });
    expect(Date.now() - t0).toBeLessThan(1500);
    const frames = f.stacks[0].stack.split(';');
    expect(frames).toHaveLength(128);
    expect(frames[0]).toBe('(truncated)');
    expect(frames[frames.length - 1]).toMatch(new RegExp(`^f${depth} `));
    assertValid(base({ nodes, samples: [depth, depth] }));
  });

  it('samples referencing unknown node ids are counted, never stacked, and the item stays valid', () => {
    const p = base({ samples: [2, 999, 2, -1, 2], timeDeltas: [1, 1, 1, 1, 1] });
    const f = foldProfile(p);
    expect(f.invalidSampleCount).toBe(2);
    expect(f.sampleCount).toBe(3);
    expect(f.totalSampleCount).toBe(5);
    assertValid(p);
    const bad = foldProfile(base({ samples: [null, 'a', undefined, 2] }) as unknown as V8Profile);
    expect(bad.invalidSampleCount).toBe(3);
  });

  it('duplicate node ids and children pointing at missing ids do not throw', () => {
    const nodes = [{ id: 1, callFrame: frame('(root)'), children: [2, 77] }, nodeA, nodeA, null, 'junk'] as unknown as V8Profile['nodes'];
    expect(() => foldProfile(base({ nodes }))).not.toThrow();
    assertValid(base({ nodes }));
  });

  it('randomised corruption of a valid profile never throws and the mapped item is always schema-valid', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const junk = [undefined, null, Number.NaN, -1, 1e308, '', 'x'.repeat(5000), {}, [], true];
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    for (let round = 0; round < 300; round++) {
      const p = JSON.parse(JSON.stringify(base({ samples: [2, 2, 3, 2], nodes: [ROOT, nodeA, { id: 3, callFrame: frame('b', 'file:///app/b.js', 9) }] }))) as Record<string, any>;
      p.nodes[0].children = [2, 3];
      for (let k = 0; k < 3; k++) {
        const pool = [p, p.nodes, p.nodes?.[1], p.nodes?.[1]?.callFrame, p.nodes?.[2]?.callFrame, p.samples, p.timeDeltas].filter((x) => x !== null && typeof x === 'object');
        const target = pick(pool) as Record<string, unknown>;
        const keys = Object.keys(target);
        if (keys.length > 0) target[pick(keys)] = pick(junk);
      }
      let item: ProfileItem | undefined;
      expect(() => {
        const f = foldProfile(p as V8Profile, { cwd: '/app' });
        item = toProfileItem(f, { serviceName: 's', instanceId: 'i', periodStartMs: 1, periodEndMs: 2, sampleRateHz: 99, durationMs: 1 });
      }, JSON.stringify(p).slice(0, 300)).not.toThrow();
      expect(validateProfile(item!.profile), JSON.stringify(validateProfile.errors)).toBe(true);
    }
  });
});

describe('ContinuousProfiler with malformed profiles from the inspector', () => {
  const active: ContinuousProfiler[] = [];
  afterEach(async () => {
    await Promise.all(active.splice(0).map((p) => p.stop()));
  });

  async function run(profiles: unknown[], windows: number) {
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
    const sessions: ScriptedSession[] = [];
    const profiler = new ContinuousProfiler(
      { enabled: true, windowMs: 20 },
      {
        queue,
        serviceName: 's',
        instanceId: 'i',
        createSession: () => {
          const s = new ScriptedSession(profiles);
          sessions.push(s);
          return s;
        },
      },
    );
    active.push(profiler);
    await profiler.start();
    const end = Date.now() + 4000;
    while (profiler.debug().counters.windows < windows && Date.now() < end) await sleep(5);
    return { profiler, queue };
  }

  it('structurally unusable windows are counted as profilesDropped, the rotation continues and the state stays running', async () => {
    const bad = [{ startTime: 1, endTime: 2, samples: [1] }, null, 'garbage', { nodes: [], samples: 5 }, 12];
    const { profiler, queue } = await run(bad, bad.length + 3);
    const d = profiler.debug();
    expect(d.counters.malformedWindows).toBe(bad.length);
    expect(queue.counters().profilesDropped).toBe(bad.length);
    expect(profiler.profilerHealth().state).toBe('running');
    expect(d.counters.errors).toBe(0);
    // the valid windows after the malformed ones were offered and are schema-valid
    const items = queue.drain(100, 1e9) as ProfileItem[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const it of items) expect(validateProfile(it.profile), JSON.stringify(validateProfile.errors)).toBe(true);
  });

  it('partially corrupt windows (unknown node ids, bad deltas, a cycle) are offered valid and counted in the debug counters', async () => {
    const cyc = { nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('a', 'file:///app/a.js', 1), children: [1] }], startTime: 1, endTime: 50_000, samples: [2, 77, 2], timeDeltas: [10, Number.NaN, 10] };
    const { profiler, queue } = await run([cyc], 3);
    const c = profiler.debug().counters;
    expect(c.invalidSamples).toBeGreaterThanOrEqual(1);
    expect(c.invalidDeltas).toBeGreaterThanOrEqual(1);
    expect(c.malformedWindows).toBe(0);
    const items = queue.drain(100, 1e9) as ProfileItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const it of items) expect(validateProfile(it.profile), JSON.stringify(validateProfile.errors)).toBe(true);
  });

  it('process-level: no unhandled rejection or uncaught exception from corrupt windows', async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    process.on('uncaughtException', onRej);
    try {
      await run([undefined, { nodes: [{ id: 'x' }], samples: [1], timeDeltas: [] }, { nodes: [null], samples: [1] }], 6);
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onRej);
      process.off('uncaughtException', onRej);
    }
    expect(seen).toEqual([]);
  });
});
