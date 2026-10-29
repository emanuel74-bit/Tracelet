import { createHash } from 'node:crypto';
import type { SanitizedError } from '../contracts/index.js';
import type { LogRedactor } from '../context/vendor/log-redactor.js';
import type { ErrorPayload } from '../context/vendor/trace-registry.js';

const MAX_NAME = 128;
const MAX_MESSAGE = 1024;
const MAX_FRAMES = 20;
const MAX_FRAME_LENGTH = 256;
/**
 * Input caps applied BEFORE any regex runs, so redaction CPU on the main thread is bounded whatever the error carries (R-4).
 * Stored limits above stay as they are; these only bound the work: message 2 KB (stored <= 1 KB), frame line 512 chars (stored <= 256).
 */
export const MAX_MESSAGE_INPUT = 2048;
export const MAX_FRAME_INPUT = 512;

export interface SanitizeOptions {
  /** 'omit' (production default) keeps name, fingerprint and redacted frames but no message text. */
  errorMessages: 'redacted' | 'omit';
  redactor: LogRedactor;
  /** Paths are made relative to this directory. Default process.cwd(). */
  cwd?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Makes one stack frame privacy-safe: `file://` stripped, paths relative to cwd, `node_modules/<pkg>/...` shortened, any
 * remaining absolute path reduced to its file name, then truncated.
 */
export function sanitizeFrame(line: string, cwd: string): string {
  let out = line.trim();
  out = out.replace(/file:\/\/(?=\/)/g, '').replace(/\/([A-Za-z]:[\\/])/g, '$1');
  out = out.replace(/\\/g, '/');
  const cwdNorm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (cwdNorm.length > 0) {
    out = out.replace(new RegExp(`${escapeRegExp(cwdNorm)}/`, process.platform === 'win32' ? 'gi' : 'g'), '');
  }
  // node_modules/<pkg>/...: drop everything before the last node_modules segment.
  out = out.replace(/[^\s()]*node_modules\//g, 'node_modules/');
  // Any absolute path that is left: keep only the file name.
  out = out.replace(/(?<![\w.$:-])(?:[A-Za-z]:)?\/[^\s():]*/g, (match) => {
    const base = match.slice(match.lastIndexOf('/') + 1);
    return base.length > 0 ? base : match;
  });
  return out.length > MAX_FRAME_LENGTH ? out.slice(0, MAX_FRAME_LENGTH) : out;
}

/**
 * Frame lines (`at ...`, at most 20) of a V8 stack. The header (name + message, possibly multi-line) is cut off first so a
 * message line that starts with 'at ' is never kept (matters under errorMessages: 'omit').
 */
function frameLines(payload: ErrorPayload): string[] {
  const stack = payload.stack;
  if (!stack) return [];
  const lines = stack.split('\n');
  let start = 0;
  if (typeof payload.headerLines === 'number') {
    // The registry counted the header lines before capping the message: skip exactly that many (O-b).
    start = Math.min(payload.headerLines, lines.length);
  } else if (payload.message.length > 0) {
    // Hand-built payloads: cut after the message when it is found at the top of the stack.
    const at = stack.indexOf(payload.message);
    if (at >= 0 && at <= 256) start = stack.slice(0, at + payload.message.length).split('\n').length;
  }
  const frames: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s*at\s/.test(lines[i])) {
      frames.push(lines[i]);
      if (frames.length >= MAX_FRAMES) break;
    }
  }
  return frames;
}

/**
 * Cuts `text` to `max` chars BEFORE redaction. When something was cut, the trailing partial token (back to the last whitespace or
 * delimiter) is dropped too, so a secret split at the cut (`mongodb://admin:hunter2@...` cut after `admin`) never reaches stored
 * text half-redacted (O-a). A text without any delimiter in its last chars is kept as cut.
 */
export function capInput(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const idx = cut.search(/[\s,;"'()<>[\]{}][^\s,;"'()<>[\]{}]*$/);
  return idx > 0 ? cut.slice(0, idx) : cut;
}

/** Raw registry payload to the stored `SanitizedError`. Never throws. */
export function sanitizeError(payload: ErrorPayload, options: SanitizeOptions): SanitizedError {
  try {
    const cwd = options.cwd ?? process.cwd();
    const name = (payload.cls && payload.cls.length > 0 ? payload.cls : 'NonError').slice(0, MAX_NAME);
    const result: SanitizedError = { name };
    if (options.errorMessages !== 'omit') {
      result.message = options.redactor.redactMessage(capInput(payload.message, MAX_MESSAGE_INPUT)).slice(0, MAX_MESSAGE);
    }
    const frames = frameLines(payload)
      .map((line) => sanitizeFrame(options.redactor.redactMessage(capInput(line, MAX_FRAME_INPUT)), cwd));
    if (frames.length > 0) {
      result.stack = frames;
    }
    return result;
  } catch {
    return { name: 'Error' };
  }
}

/**
 * First 16 hex of sha1(name NUL first in-app frame without line/col NUL operation). NUL separators so field boundaries cannot
 * shift. "In-app" = the first frame that is neither inside node_modules nor a node internal.
 */
export function fingerprint(error: SanitizedError, operation: string): string {
  const frames = error.stack ?? [];
  const frame =
    frames.find((f) => !f.includes('node_modules/') && !/\(?node:/.test(f) && !f.includes('<anonymous>)')) ?? frames[0] ?? '';
  const withoutPosition = frame.replace(/:\d+(?::\d+)?(\)?)$/, '$1');
  return createHash('sha1').update(`${error.name}\u0000${withoutPosition}\u0000${operation}`).digest('hex').slice(0, 16);
}
