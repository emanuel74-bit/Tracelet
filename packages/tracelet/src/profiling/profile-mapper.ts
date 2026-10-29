import type { CpuProfile, ProfileItem, ProfileStack } from '../contracts/index.js';
import { uuidv7 } from '../shared/uuid-v7.js';
import { TRUNCATED_FRAME } from './vendor/fold-profile.js';
import type { FoldResult } from './vendor/fold-profile.js';

export const DEFAULT_MAX_STACKS_PER_PROFILE = 2000;
export const DEFAULT_MAX_PROFILE_BYTES = 1024 * 1024;
/** Schema bounds: CpuProfile.stacks.maxItems, sampleRateHz in (0, 1000]. */
export const SCHEMA_MAX_STACKS = 5000;
export const SCHEMA_MAX_SAMPLE_RATE_HZ = 1000;
/** Schema bound of ProfileStack.stack. */
const MAX_STACK_CHARS = 32768;
/** Estimated JSON overhead of one stack object: {"stack":"...","samples":N}, rounded up. */
const STACK_OVERHEAD = 32;
/** Estimated JSON size of a profile with no stacks (all the summary fields), rounded up. */
const BASE_BYTES = 640;

export interface ProfileMapperContext {
  serviceName: string;
  serviceVersion?: string;
  instanceId: string;
  periodStartMs: number;
  periodEndMs: number;
  sampleRateHz: number;
  /** V8 endTime - startTime, ms. */
  durationMs: number;
  /** Sample-based gap (plan 7); omitted for the first window after (re)start or backoff. */
  gapBeforeMs?: number;
  maxStacksPerProfile?: number;
  maxProfileBytes?: number;
  /** Test hook; defaults to uuidv7(). */
  profileId?: string;
}

/** Serialized size of one stack entry: the JSON-escaped string in UTF-8 bytes (quotes, backslashes, control characters and
 *  non-ASCII names expand) plus the object overhead. */
export function estimateStackBytes(stack: string): number {
  return Buffer.byteLength(JSON.stringify(stack), 'utf8') + STACK_OVERHEAD;
}

/** Keeps a stack within the schema's 32768 chars by dropping root-most frames behind a "(truncated)" root frame. */
function clampStack(stack: string): string {
  if (stack.length <= MAX_STACK_CHARS) return stack;
  const keep = MAX_STACK_CHARS - TRUNCATED_FRAME.length - 1;
  let cut = stack.length - keep;
  const sep = stack.indexOf(';', cut);
  cut = sep === -1 ? stack.length - 1 : sep + 1;
  const tail = stack.slice(cut);
  return `${TRUNCATED_FRAME};${tail.length > 0 ? tail : stack.slice(-1)}`.slice(0, MAX_STACK_CHARS);
}

/**
 * FoldResult to ProfileItem: top-K by samples (maxStacksPerProfile), then the lowest-sample stacks are trimmed until the
 * estimated serialized size is within maxProfileBytes. Every removed stack is accounted in droppedStackCount and
 * droppedSampleCount, so sampleCount === sum(stacks[].samples) + droppedSampleCount always holds.
 */
export function toProfileItem(fold: FoldResult, ctx: ProfileMapperContext): ProfileItem {
  // No configuration may produce a schema-invalid item: non-finite values fall back to the defaults, the stack count is capped
  // at the schema's 5000 and the byte cap cannot go below the size of an empty profile (then zero stacks are kept).
  const num = (v: number | undefined, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const maxStacks = Math.min(SCHEMA_MAX_STACKS, Math.max(0, Math.floor(num(ctx.maxStacksPerProfile, DEFAULT_MAX_STACKS_PER_PROFILE))));
  const baseBytes = BASE_BYTES + (ctx.serviceVersion?.length ?? 0) + ctx.serviceName.length + ctx.instanceId.length;
  const maxBytes = Math.max(baseBytes, num(ctx.maxProfileBytes, DEFAULT_MAX_PROFILE_BYTES));
  const sampleRateHz = Math.min(SCHEMA_MAX_SAMPLE_RATE_HZ, Math.max(0.001, num(ctx.sampleRateHz, 99)));

  // clamping can make two stacks equal; merge, then order most samples first (deterministic ties)
  const merged = new Map<string, number>();
  for (const s of fold.stacks) {
    const key = clampStack(s.stack);
    merged.set(key, (merged.get(key) ?? 0) + s.samples);
  }
  const all: ProfileStack[] = [];
  for (const [stack, samples] of merged) all.push({ stack, samples });
  all.sort((a, b) => b.samples - a.samples || (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0));

  let keep = Math.min(all.length, maxStacks);
  let bytes = baseBytes;
  let kept = 0;
  for (; kept < keep; kept++) {
    const b = estimateStackBytes(all[kept].stack);
    if (bytes + b > maxBytes) break;
    bytes += b;
  }
  keep = kept;
  const stacks = all.slice(0, keep);
  let droppedSampleCount = 0;
  for (let i = keep; i < all.length; i++) droppedSampleCount += all[i].samples;

  const profile: CpuProfile = {
    schemaVersion: 1,
    profileId: ctx.profileId ?? uuidv7(),
    serviceName: ctx.serviceName,
    ...(ctx.serviceVersion !== undefined ? { serviceVersion: ctx.serviceVersion } : {}),
    instanceId: ctx.instanceId,
    periodStart: new Date(ctx.periodStartMs).toISOString(),
    periodEnd: new Date(Math.max(ctx.periodStartMs, ctx.periodEndMs)).toISOString(),
    format: 'folded-stacks',
    sampleRateHz,
    sampleCount: fold.sampleCount,
    durationMs: round(ctx.durationMs),
    idleSampleCount: fold.idleSampleCount,
    droppedStackCount: all.length - keep,
    droppedSampleCount,
    ...(ctx.gapBeforeMs !== undefined ? { gapBeforeMs: round(ctx.gapBeforeMs) } : {}),
    stacks,
  };
  return { type: 'profile', profile, estimatedBytes: bytes };
}

function round(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : 0;
}
