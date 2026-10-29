import type { Attributes } from '../contracts/index.js';
import { capInput } from './error-sanitizer.js';
import type { LogRedactor } from '../context/vendor/log-redactor.js';

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_KEYS = 16;
const MAX_STRING = 256;
/** Attribute strings are cut to this BEFORE redaction so the regex work is bounded (R-4); stored limit stays 256. */
export const MAX_ATTRIBUTE_INPUT = 1024;

/**
 * Bounds and redacts `TraceOptions.attributes`: at most 16 keys, key pattern, sensitive key names replaced by [REDACTED],
 * strings redacted and cut to 256 chars, finite numbers and booleans only. Never throws; returns undefined when empty.
 */
export function boundAttributes(input: unknown, redactor: LogRedactor): Attributes | undefined {
  try {
    if (typeof input !== 'object' || input === null) return undefined;
    const out: Attributes = {};
    let count = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (count >= MAX_KEYS) break;
      if (!KEY_PATTERN.test(key)) continue;
      if (redactor.isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
        count += 1;
      } else if (typeof value === 'string') {
        out[key] = redactor.redactMessage(capInput(value, MAX_ATTRIBUTE_INPUT)).slice(0, MAX_STRING);
        count += 1;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        out[key] = value;
        count += 1;
      } else if (typeof value === 'boolean') {
        out[key] = value;
        count += 1;
      }
    }
    return count > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
