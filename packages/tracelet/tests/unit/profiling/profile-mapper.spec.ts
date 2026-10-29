import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import schema from '../../../src/contracts/telemetry.schema.json';
import { estimateStackBytes, toProfileItem } from '../../../src/profiling/profile-mapper.js';
import type { ProfileMapperContext } from '../../../src/profiling/profile-mapper.js';
import type { FoldResult } from '../../../src/profiling/vendor/fold-profile.js';

const ctx = (over: Partial<ProfileMapperContext> = {}): ProfileMapperContext => ({
  serviceName: 'svc',
  serviceVersion: '1.2.3',
  instanceId: 'host-abcdef123456',
  periodStartMs: Date.parse('2026-10-29T10:00:00.000Z'),
  periodEndMs: Date.parse('2026-10-29T10:00:30.000Z'),
  sampleRateHz: 99,
  durationMs: 30_000.1234,
  ...over,
});

function fold(stacks: Array<[string, number]>, idle = 0): FoldResult {
  const list = stacks.map(([stack, samples]) => ({ stack, samples }));
  const sampleCount = list.reduce((a, s) => a + s.samples, 0);
  return { stacks: list, sampleCount, idleSampleCount: idle, totalSampleCount: sampleCount + idle, firstSampleUs: 1, lastSampleUs: 2 };
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const validate = ajv.getSchema((schema as { $id: string }).$id + '#/$defs/CpuProfile')!;
const check = (item: ReturnType<typeof toProfileItem>) => expect(validate(item.profile), JSON.stringify(validate.errors)).toBe(true);

describe('toProfileItem', () => {
  it('maps a fold to a schema-valid ProfileItem with all v1 summary fields', () => {
    const item = toProfileItem(fold([['a;b', 10], ['a;c', 5]], 7), ctx({ gapBeforeMs: 123.456789 }));
    expect(item.type).toBe('profile');
    const p = item.profile;
    expect(p).toMatchObject({
      schemaVersion: 1,
      format: 'folded-stacks',
      sampleRateHz: 99,
      sampleCount: 15,
      idleSampleCount: 7,
      droppedStackCount: 0,
      droppedSampleCount: 0,
      gapBeforeMs: 123.457,
      periodStart: '2026-10-29T10:00:00.000Z',
      periodEnd: '2026-10-29T10:00:30.000Z',
      durationMs: 30000.123,
    });
    expect(p.stacks).toEqual([{ stack: 'a;b', samples: 10 }, { stack: 'a;c', samples: 5 }]);
    expect(item.estimatedBytes).toBeGreaterThan(0);
    check(item);
  });

  it('omits gapBeforeMs when there is none (first window after start or backoff)', () => {
    const item = toProfileItem(fold([['a', 1]]), ctx());
    expect('gapBeforeMs' in item.profile).toBe(false);
    check(item);
  });

  it('keeps the top-K stacks by samples and accounts the rest in droppedStackCount/droppedSampleCount', () => {
    const stacks: Array<[string, number]> = [];
    for (let i = 1; i <= 50; i++) stacks.push([`s${i}`, i]);
    const item = toProfileItem(fold(stacks), ctx({ maxStacksPerProfile: 10 }));
    const p = item.profile;
    expect(p.stacks).toHaveLength(10);
    expect(p.stacks[0]).toEqual({ stack: 's50', samples: 50 });
    expect(p.droppedStackCount).toBe(40);
    // dropped = 1..40
    expect(p.droppedSampleCount).toBe((40 * 41) / 2);
    expect(p.sampleCount).toBe(p.stacks.reduce((a, s) => a + s.samples, 0) + p.droppedSampleCount!);
    check(item);
  });

  it('maxProfileBytes trims the lowest-sample stacks until the estimate fits; sampleCount stays the sum', () => {
    const stacks: Array<[string, number]> = [];
    for (let i = 1; i <= 200; i++) stacks.push([`frame_${'x'.repeat(100)}_${i}`, i]);
    const cap = 4000;
    const item = toProfileItem(fold(stacks), ctx({ maxProfileBytes: cap }));
    const p = item.profile;
    expect(item.estimatedBytes).toBeLessThanOrEqual(cap);
    expect(p.stacks.length).toBeGreaterThan(0);
    expect(p.stacks.length).toBeLessThan(200);
    // the survivors are the highest-sample ones
    const minKept = Math.min(...p.stacks.map((s) => s.samples));
    expect(minKept).toBeGreaterThan(200 - p.stacks.length - 1);
    expect(p.droppedStackCount).toBe(200 - p.stacks.length);
    expect(p.sampleCount).toBe((200 * 201) / 2);
    expect(p.stacks.reduce((a, s) => a + s.samples, 0) + p.droppedSampleCount!).toBe(p.sampleCount);
    // the estimate is the sum of the documented per-stack estimate plus a bounded base
    const stackBytes = p.stacks.reduce((a, s) => a + estimateStackBytes(s.stack), 0);
    expect(item.estimatedBytes - stackBytes).toBeGreaterThan(0);
    expect(item.estimatedBytes - stackBytes).toBeLessThan(1000);
    check(item);
  });

  it('a cap smaller than the base keeps zero stacks but still reports every sample as dropped', () => {
    const item = toProfileItem(fold([['a', 3], ['b', 4]]), ctx({ maxProfileBytes: 10 }));
    expect(item.profile.stacks).toEqual([]);
    expect(item.profile.droppedStackCount).toBe(2);
    expect(item.profile.droppedSampleCount).toBe(7);
    expect(item.profile.sampleCount).toBe(7);
    check(item);
  });

  it('the default 1 MiB cap and 2000 stack cap bound a pathological fold', () => {
    const stacks: Array<[string, number]> = [];
    for (let i = 0; i < 20_000; i++) stacks.push([`f${i};${'y'.repeat(300)}`, 1 + (i % 7)]);
    const item = toProfileItem(fold(stacks), ctx());
    expect(item.profile.stacks.length).toBeLessThanOrEqual(2000);
    expect(item.estimatedBytes).toBeLessThanOrEqual(1024 * 1024);
    check(item);
  });

  it('clamps a stack longer than the schema limit (32768) behind a (truncated) root frame', () => {
    const long = Array.from({ length: 4000 }, (_, i) => `function_number_${i}`).join(';');
    expect(long.length).toBeGreaterThan(32768);
    const item = toProfileItem(fold([[long, 2]]), ctx());
    const s = item.profile.stacks[0].stack;
    expect(s.length).toBeLessThanOrEqual(32768);
    expect(s.startsWith('(truncated);')).toBe(true);
    expect(s.endsWith('function_number_3999')).toBe(true);
    check(item);
  });

  it('a profile with no samples at all is still schema-valid', () => {
    check(toProfileItem(fold([], 0), ctx()));
  });
});
