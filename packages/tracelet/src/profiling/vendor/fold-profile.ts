// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.profiling.md
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shape `Profiler.stop` returns over the inspector protocol. */
export interface V8ProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  children?: number[];
}

export interface V8Profile {
  nodes: V8ProfileNode[];
  /** Microseconds, on V8's monotonic clock. */
  startTime: number;
  endTime: number;
  /** Node id per sample. */
  samples?: number[];
  /** Microseconds since the previous sample. */
  timeDeltas?: number[];
}

export interface FoldOptions {
  /** Frames kept per stack; deeper stacks keep the (max - 1) leaf-most frames behind a "(truncated)" root frame. Default 128. */
  maxFramesPerStack?: number;
  /** Directory frame paths are made relative to. Default process.cwd(). */
  cwd?: string;
}

export interface FoldedStack {
  /** Root-first frames joined by ';'. */
  stack: string;
  samples: number;
}

export interface FoldResult {
  /** Distinct stacks, most samples first (ties: stack text ascending, so the output is deterministic). */
  stacks: FoldedStack[];
  /** Non-idle samples (sum of stacks[].samples). */
  sampleCount: number;
  /** Samples whose leaf is "(idle)". */
  idleSampleCount: number;
  /** Samples in the profile, including any whose stack folded to nothing (leaf "(root)"). */
  totalSampleCount: number;
  /** profile.startTime + cumulative timeDeltas of the first / last sample, microseconds on V8's monotonic clock; idle
   *  samples included. Undefined when the profile has no samples. */
  firstSampleUs?: number;
  lastSampleUs?: number;
  /** Set only when the profile was structurally unusable (not an object, no `nodes` array, `samples` not an array). Nothing
   *  was folded; the caller must count the window as a dropped profile. */
  malformed?: string;
  /** Samples whose node id is unknown or not an integer; counted in totalSampleCount, never in a stack. Only set when > 0. */
  invalidSampleCount?: number;
  /** timeDeltas entries that were NaN, infinite, non-numeric or negative (treated as 0). Only set when > 0. */
  invalidDeltaCount?: number;
  /** Stacks cut short because their parent chain contains a cycle. Only set when > 0. */
  cycleCount?: number;
}

const DEFAULT_MAX_FRAMES = 128;
const MAX_FRAME_CHARS = 512;
/** Input caps applied before a frame string is built (a hostile or corrupt profile must not make us build megabyte strings). */
const MAX_NAME_CHARS = 256;
const MAX_URL_CHARS = 2048;
/** Upper bound on ancestors visited per sampled leaf (cycle and runaway-depth guard; frames beyond maxFrames are not kept). */
const MAX_WALK = 10_000;
/** A single timeDelta above this (about 2.8 h in microseconds) cannot come from a real window; it is counted as invalid and treated as 0 so timestamps stay finite. */
const MAX_DELTA_US = 1e10;
export const TRUNCATED_FRAME = '(truncated)';
const IDLE = '(idle)';
const ROOT = '(root)';
const ANONYMOUS = '(anonymous)';

/** achievedSampleRateHz = (samples including idle - 1) / (first-to-last sample span in seconds). Sample timestamps, never
 *  durationMs (plan 7, L4). Returns undefined when it is not defined (fewer than 2 samples or a non-positive span). */
export function achievedSampleRateHz(totalSamples: number, sampledSpanMs: number): number | undefined {
  if (!(totalSamples >= 2) || !(sampledSpanMs > 0)) return undefined;
  return (totalSamples - 1) / (sampledSpanMs / 1000);
}

const BS = String.fromCharCode(92);
const EXTERNAL = '<external>';

function slashes(p: string): string {
  return p.split(BS).join('/');
}

function isDrive(p: string): boolean {
  return p.length >= 3 && p[1] === ':' && p[2] === '/' && /[A-Za-z]/.test(p[0]);
}

/** Absolute in any OS flavour: posix root, Windows drive or UNC (input already uses '/'). */
function isAbsoluteAny(p: string): boolean {
  return p.startsWith('/') || isDrive(p);
}

/** Plan 11: no absolute paths are stored. Inside cwd: relative. Outside: node_modules/<pkg>/... or <external>/<basename>. */
export function sanitizeFramePath(url: string, cwd: string): string {
  let p = url;
  if (url.startsWith('file://')) {
    try {
      p = fileURLToPath(url);
    } catch {
      // not a valid file URL for this OS: keep only the path (no authority/credentials, no query or fragment)
      const rest = url.slice('file://'.length).split(/[?#]/)[0];
      p = rest.startsWith('/') ? rest : rest.slice(rest.indexOf('/') === -1 ? rest.length : rest.indexOf('/'));
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(url)) {
    if (url.startsWith('node:')) return url; // node:internal/..., kept verbatim
    // other schemes (data:, http:, webpack:): never stored verbatim; no credentials, host, query or code
    if (url.startsWith('data:')) return `${EXTERNAL}/data`;
    let pathname = '';
    try {
      if (url.includes('://')) pathname = new URL(url).pathname; // opaque schemes (mailto:, urn:) carry no file path
    } catch {
      pathname = '';
    }
    const last = pathname.split('/').filter((x) => x.length > 0 && x !== '..').pop();
    return `${EXTERNAL}/${last ?? 'unknown'}`;
  }
  let n = slashes(p);
  // collapse '.'/'..' first so a non-normalized path cannot smuggle a traversal past the cwd test
  n = posix.normalize(n);
  if (n.length >= 4 && n[0] === '/' && isDrive(n.slice(1))) n = n.slice(1); // /C:/x from a file URL parsed on posix
  const c = slashes(cwd).replace(/\/+$/, '');
  if (isAbsoluteAny(n)) {
    const win = isDrive(n);
    const inside = win ? n.toLowerCase().startsWith(c.toLowerCase() + '/') : n.startsWith(c + '/');
    if (c.length > 0 && inside) {
      const rel = n.slice(c.length + 1);
      return rel.length > 0 ? rel : EXTERNAL;
    }
  } else if (n !== '..' && !n.startsWith('../')) {
    return n; // already relative and inside
  }
  // outside cwd (other directory, other drive, UNC) or unresolvable
  const idx = n.lastIndexOf('/node_modules/');
  if (idx !== -1) {
    const parts = n.slice(idx + '/node_modules/'.length).split('/').filter((x) => x.length > 0 && x !== '..');
    const pkgLen = parts[0]?.startsWith('@') ? 2 : 1;
    if (parts.length > pkgLen) return `node_modules/${parts.join('/')}`;
  }
  const base = n.split('/').filter((x) => x.length > 0 && x !== '..').pop();
  return `${EXTERNAL}/${base ?? 'unknown'}`;
}

function formatFrame(node: V8ProfileNode, cwd: string): string {
  const cf = (node.callFrame ?? {}) as Partial<V8ProfileNode['callFrame']>;
  const fn = typeof cf.functionName === 'string' ? cf.functionName.slice(0, MAX_NAME_CHARS) : '';
  const url = typeof cf.url === 'string' ? cf.url.slice(0, MAX_URL_CHARS) : '';
  const lineNumber = typeof cf.lineNumber === 'number' && Number.isFinite(cf.lineNumber) ? cf.lineNumber : 0;
  const name = fn || ANONYMOUS;
  let frame: string;
  if (!url) {
    frame = name; // native and internal frames have no script, kept by name
  } else {
    frame = `${name} ${sanitizeFramePath(url, cwd)}:${(lineNumber >= 0 ? lineNumber : 0) + 1}`;
  }
  if (frame.indexOf(';') !== -1) frame = frame.replace(/;/g, ',');
  return frame.length > MAX_FRAME_CHARS ? frame.slice(0, MAX_FRAME_CHARS) : frame;
}

/**
 * Folds a V8 profile into per-stack sample counts plus idle/total counts and the sample time range. O(nodes + samples) with
 * one stack-string build per distinct sampled leaf. Frames: `fn relpath:line` (1-based), `(root)` and `(idle)` dropped
 * from stacks (idle counted separately), `(program)` and `(garbage collector)` kept.
 */
export function foldProfile(profile: V8Profile, options: FoldOptions = {}): FoldResult {
  const empty = (malformed?: string): FoldResult => ({
    stacks: [],
    sampleCount: 0,
    idleSampleCount: 0,
    totalSampleCount: 0,
    ...(malformed !== undefined ? { malformed } : {}),
  });
  if (profile === null || typeof profile !== 'object') return empty('profile is not an object');
  const requested = options.maxFramesPerStack;
  const maxFrames = Math.max(2, Math.floor(typeof requested === 'number' && Number.isFinite(requested) ? requested : DEFAULT_MAX_FRAMES));
  const cwd = options.cwd ?? process.cwd();
  const rawSamples = profile.samples;
  if (rawSamples !== undefined && !Array.isArray(rawSamples)) return empty('samples is not an array');
  const samples = rawSamples ?? [];
  const n = samples.length;
  if (n === 0) return empty();
  if (!Array.isArray(profile.nodes)) return empty('profile has no nodes array');
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const startTime = typeof profile.startTime === 'number' && Number.isFinite(profile.startTime) ? profile.startTime : 0;

  const byId = new Map<number, V8ProfileNode>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    if (node && typeof node === 'object' && typeof node.id === 'number') byId.set(node.id, node);
  }
  for (const node of byId.values()) {
    const kids = node.children;
    if (Array.isArray(kids)) for (const c of kids) parent.set(c, node.id);
  }

  const frameCache = new Map<number, string>();
  const frameOf = (node: V8ProfileNode): string => {
    let f = frameCache.get(node.id);
    if (f === undefined) {
      f = formatFrame(node, cwd);
      frameCache.set(node.id, f);
    }
    return f;
  };
  let cycleCount = 0;
  const nameOf = (node: V8ProfileNode): unknown => (node.callFrame as { functionName?: unknown } | undefined)?.functionName;
  /** Per sampled leaf: stack text, '' = nothing to count (unknown id or leaf "(root)"), null = idle. */
  const stackCache = new Map<number, string | null>();
  const stackOf = (id: number): string | null => {
    const cached = stackCache.get(id);
    if (cached !== undefined) return cached;
    const leaf = byId.get(id);
    let result: string | null;
    if (!leaf) {
      result = '';
    } else if (nameOf(leaf) === IDLE) {
      result = null;
    } else {
      // leaf-most maxFrames frames, then only a "more ancestors exist" check; bounded by MAX_WALK, cycle safe
      const frames: string[] = [];
      let more = false;
      const seen = new Set<number>();
      let cursor: V8ProfileNode | undefined = leaf;
      let steps = 0;
      while (cursor) {
        if (seen.has(cursor.id) || steps++ >= MAX_WALK) {
          if (seen.has(cursor.id)) cycleCount++;
          more = true;
          break;
        }
        seen.add(cursor.id);
        const name = nameOf(cursor);
        if (name !== ROOT && name !== IDLE) {
          if (frames.length < maxFrames) {
            frames.push(frameOf(cursor));
          } else {
            // cap reached and at least one more real frame above: stop here (do not walk to the root for every distinct leaf)
            more = true;
            break;
          }
        }
        const pid = parent.get(cursor.id);
        cursor = pid === undefined ? undefined : byId.get(pid);
      }
      frames.reverse();
      if (more && frames.length >= maxFrames) {
        result = [TRUNCATED_FRAME, ...frames.slice(frames.length - (maxFrames - 1))].join(';');
      } else if (more) {
        result = [TRUNCATED_FRAME, ...frames].join(';');
      } else {
        result = frames.join(';');
      }
    }
    stackCache.set(id, result);
    return result;
  };

  const counts = new Map<string, number>();
  let idle = 0;
  let nonIdle = 0;
  let invalidSamples = 0;
  let invalidDeltas = 0;
  let t = startTime;
  let first = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const d = deltas[i];
    if (d === undefined) {
      // shorter timeDeltas than samples: no time advance
    } else if (typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= MAX_DELTA_US) {
      t += d;
    } else {
      invalidDeltas++;
    }
    if (i === 0) first = t;
    last = t;
    const sid = samples[i];
    if (typeof sid !== 'number' || !byId.has(sid)) invalidSamples++;
    const stack = typeof sid === 'number' ? stackOf(sid) : '';
    if (stack === null) {
      idle++;
    } else if (stack !== '') {
      nonIdle++;
      counts.set(stack, (counts.get(stack) ?? 0) + 1);
    }
  }

  const stacks: FoldedStack[] = [];
  for (const [stack, c] of counts) stacks.push({ stack, samples: c });
  stacks.sort((a, b) => b.samples - a.samples || (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0));
  return {
    stacks,
    sampleCount: nonIdle,
    idleSampleCount: idle,
    totalSampleCount: n,
    firstSampleUs: first,
    lastSampleUs: last,
    ...(invalidSamples > 0 ? { invalidSampleCount: invalidSamples } : {}),
    ...(invalidDeltas > 0 ? { invalidDeltaCount: invalidDeltas } : {}),
    ...(cycleCount > 0 ? { cycleCount } : {}),
  };
}
