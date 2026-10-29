import type { Attributes } from '../contracts/index.js';

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_KEYS = 16;
/** Same input bound as buffer/attributes.ts (MAX_ATTRIBUTE_INPUT): strings are cut before they are held or redacted. */
const MAX_RAW_STRING = 1024;
/** Own keys visited at most (a huge object must not cost an unbounded scan). */
const MAX_SCANNED_KEYS = 64;

/**
 * Bounds the raw `TraceOptions.attributes` object when a root starts, so a caller cannot pin an unbounded object in the
 * registry until the trace is mapped: at most 16 accepted keys, key pattern, strings cut to 1024 chars, finite numbers and
 * booleans only (everything else is dropped); at most 64 keys are scanned. Selection mirrors `boundAttributes` in the buffer, which later redacts and cuts
 * to the stored 256 chars; redaction is NOT done here (context does not import buffer). Never throws; undefined when empty.
 */
export function capRawAttributes(input: unknown): Attributes | undefined {
  try {
    if (typeof input !== 'object' || input === null) return undefined;
    const out: Attributes = {};
    let count = 0;
    let scanned = 0;
    for (const key in input as Record<string, unknown>) {
      if (count >= MAX_KEYS || scanned >= MAX_SCANNED_KEYS) break;
      scanned += 1;
      if (!Object.prototype.hasOwnProperty.call(input, key) || !KEY_PATTERN.test(key)) continue;
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        // One char OVER the buffer's 1024 input cap on purpose: buffer/attributes.ts `capInput(value, 1024)` must still see an
        // over-long text so it drops the trailing partial token (a secret split at the cut is never stored half-redacted, O-a).
        out[key] = value.length > MAX_RAW_STRING + 1 ? value.slice(0, MAX_RAW_STRING + 1) : value;
        count += 1;
      } else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
        out[key] = value;
        count += 1;
      }
    }
    return count > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
