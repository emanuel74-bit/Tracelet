import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import schema from '../../../src/contracts/telemetry.schema.json';
import { toProfileItem } from '../../../src/profiling/index.js';
import type { FoldResult } from '../../../src/profiling/vendor/fold-profile.js';

/* M06: maxStacksPerProfile and maxProfileBytes trimming accounting, over many random folds. */

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const validate = ajv.getSchema((schema as { $id: string }).$id + '#/$defs/CpuProfile')!;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ALPHABET = ['a', 'b', 'Z', '0', '/', '.', ' ', ':', '"', String.fromCharCode(92), 'é', '中', '\u{1f600}', '\u0001'];

function randomFold(r: () => number, n: number, maxLen: number): FoldResult {
  const stacks: FoldResult['stacks'] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * maxLen);
    let text = '';
    for (let k = 0; k < len; k++) text += ALPHABET[Math.floor(r() * ALPHABET.length)];
    text = `f${i};${text}`;
    if (seen.has(text)) continue;
    seen.add(text);
    const samples = 1 + Math.floor(r() * 50);
    total += samples;
    stacks.push({ stack: text, samples });
  }
  const idle = Math.floor(r() * 20);
  return { stacks, sampleCount: total, idleSampleCount: idle, totalSampleCount: total + idle, firstSampleUs: 1, lastSampleUs: 2 };
}

const ctx = { serviceName: 'svc', instanceId: 'host-abcdef123456', periodStartMs: 1_700_000_000_000, periodEndMs: 1_700_000_030_000, sampleRateHz: 99, durationMs: 30_000 };

describe('mapper accounting (random folds, unicode / escaped characters included)', () => {
  it('sampleCount === sum(stacks) + droppedSampleCount, dropped counts add up, order is samples-desc and kept stacks outrank dropped ones', () => {
    const r = rng(7);
    for (let round = 0; round < 200; round++) {
      const fold = randomFold(r, 1 + Math.floor(r() * 400), 1 + Math.floor(r() * 300));
      const maxStacksPerProfile = Math.floor(r() * 120);
      const maxProfileBytes = 700 + Math.floor(r() * 30_000);
      const { profile, estimatedBytes } = toProfileItem(fold, { ...ctx, maxStacksPerProfile, maxProfileBytes });
      const kept = profile.stacks.reduce((a, s) => a + s.samples, 0);
      expect(kept + (profile.droppedSampleCount ?? 0)).toBe(profile.sampleCount);
      expect(profile.sampleCount).toBe(fold.sampleCount);
      expect(profile.stacks.length + (profile.droppedStackCount ?? 0)).toBe(fold.stacks.length);
      expect(profile.stacks.length).toBeLessThanOrEqual(maxStacksPerProfile);
      for (let i = 1; i < profile.stacks.length; i++) expect(profile.stacks[i - 1].samples).toBeGreaterThanOrEqual(profile.stacks[i].samples);
      const minKept = profile.stacks.length > 0 ? profile.stacks[profile.stacks.length - 1].samples : Infinity;
      const keptSet = new Set(profile.stacks.map((s) => s.stack));
      for (const s of fold.stacks) if (!keptSet.has(s.stack)) expect(s.samples).toBeLessThanOrEqual(minKept);
      expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
      // the serialized size bound, measured for real (UTF-8 bytes of the JSON the writer stores)
      const bytes = Buffer.byteLength(JSON.stringify(profile), 'utf8');
      expect(bytes, `round ${round}`).toBeLessThanOrEqual(maxProfileBytes);
      expect(estimatedBytes).toBeGreaterThanOrEqual(bytes);
    }
  });

  it('defaults: 2000 stacks and 1 MiB hold for 6000 distinct stacks of 400 characters', () => {
    const r = rng(11);
    const fold = randomFold(r, 6000, 400);
    const { profile } = toProfileItem(fold, ctx);
    expect(profile.stacks.length).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(JSON.stringify(profile), 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    expect(profile.stacks.reduce((a, s) => a + s.samples, 0) + (profile.droppedSampleCount ?? 0)).toBe(fold.sampleCount);
    expect(validate(profile)).toBe(true);
  });

  it('maxStacksPerProfile 0 keeps nothing and drops every sample', () => {
    const fold = randomFold(rng(3), 10, 20);
    const { profile } = toProfileItem(fold, { ...ctx, maxStacksPerProfile: 0 });
    expect(profile.stacks).toEqual([]);
    expect(profile.droppedStackCount).toBe(fold.stacks.length);
    expect(profile.droppedSampleCount).toBe(fold.sampleCount);
  });
});
