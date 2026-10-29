// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import { createSensitiveKeyMatcher, type SensitiveKeyMatcher } from './sensitive-keys.js';

/**
 * Strips secrets out of error messages and stacks before they leave the process.
 *
 * The default patterns are deliberately high-precision rather than exhaustive: a redactor that mangles ordinary
 * content gets switched off. It is a safety net for secrets that leak into errors by accident, not a guarantee.
 */

/** Declared locally (upstream imports it from observe-options.interface.ts, which is not vendored). */
export interface RedactionOptions {
  /** Extra global patterns; matches are replaced by the replacement. */
  patterns?: RegExp[];
  /** Extra sensitive key names (case/separator-insensitive). */
  keys?: string[];
  /** Replacement text. Default "[REDACTED]". */
  replacement?: string;
  /** false disables the built-in rules and the card-number rule. */
  useDefaultPatterns?: boolean;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';
const EMAIL_REPLACEMENT = '[EMAIL]';

/** Key names recognised inside free text, as `key=value` or `"key": "value"`. */
const TEXT_KEY_ALTERNATION = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'api[_-]?key',
  'authorization',
  'auth',
  'credentials?',
  'private[_-]?key',
  'access[_-]?key',
  'secret[_-]?key',
  'session[_-]?id',
  'set-cookie',
  'cookie',
].join('|');

interface CompiledRule {
  pattern: RegExp;
  /** Keeps the part that identifies what was redacted (key name, scheme) while masking only the value. */
  replace: (replacement: string, ...groups: string[]) => string;
}

function buildDefaultRules(): CompiledRule[] {
  const value = '(?:"[^"]*"|\'[^\']*\'|(?:Bearer|Basic|Token)\\s+\\S+|[^\\s,;&}"\']+)';
  return [
    // Tracelet addition: URI userinfo (`scheme://user:pass@host`), first so the narrower rules never see the password.
    {
      // Leading boundary instead of \b: only the start of a scheme-like run scans forward, so 'a.a.a.' input is linear (R-4).
      pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/g,
      replace: (replacement, scheme) => `${scheme}${replacement}@`,
    },
    // Authorization schemes: `Bearer eyJ...`, `Basic dXNlcjpwYXNz`. Must precede the key=value rule.
    {
      pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      replace: (replacement, scheme) => `${scheme} ${replacement}`,
    },
    // key=value / "key": "value". Keeps the key so the text still says what was removed.
    {
      pattern: new RegExp(`((?:${TEXT_KEY_ALTERNATION})["']?\\s*[:=]\\s*)${value}`, 'gi'),
      replace: (replacement, prefix) => `${prefix}${replacement}`,
    },
    // Bare JWTs. Must not follow a token character (a `\b` start made `eyJ-eyJ-...` runs quadratic).
    {
      pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
      replace: (replacement) => replacement,
    },
    // AWS access key ids.
    {
      pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
      replace: (replacement) => replacement,
    },
    // Tracelet addition: e-mail addresses.
    {
      // Leading boundary: only the start of a local-part run scans forward (linear, R-4).
      pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
      replace: () => EMAIL_REPLACEMENT,
    },
  ];
}

/**
 * PEM private-key blocks, found with a linear scan instead of a lazy regex: repeated BEGIN markers without an END made the regex
 * quadratic (R-4). If no END exists after a BEGIN, none can exist after a later BEGIN, so the scan stops.
 */
const PEM_BEGIN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/y;
const PEM_END = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/y;

export function redactPem(text: string, replacement: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const begin = text.indexOf('-----BEGIN ', pos);
    if (begin < 0) break;
    PEM_BEGIN.lastIndex = begin;
    const bm = PEM_BEGIN.exec(text);
    if (!bm) {
      out += text.slice(pos, begin + 1);
      pos = begin + 1;
      continue;
    }
    let endAt = text.indexOf('-----END ', begin + bm[0].length);
    let endMatchEnd = -1;
    while (endAt >= 0) {
      PEM_END.lastIndex = endAt;
      const em = PEM_END.exec(text);
      if (em) {
        endMatchEnd = endAt + em[0].length;
        break;
      }
      endAt = text.indexOf('-----END ', endAt + 1);
    }
    if (endMatchEnd < 0) {
      // BEGIN without END (typically a key cut off by an input cap): redact from BEGIN to the end of the text. Nothing after it
      // can match anyway, and leaking the key start is worse than over-redacting the tail (N-1).
      out += text.slice(pos, begin) + replacement;
      pos = text.length;
      break;
    }
    out += text.slice(pos, begin) + replacement;
    pos = endMatchEnd;
  }
  return out + text.slice(pos);
}

/** Card numbers, validated with Luhn rather than pattern-matched. */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const MAX_ATTRIBUTE_DEPTH = 8;

export class LogRedactor {
  private readonly rules: CompiledRule[];
  private readonly matchesSensitiveKey: SensitiveKeyMatcher;
  private readonly replacement: string;
  private readonly redactCards: boolean;
  private readonly redactDefaults: boolean;

  constructor(options: RedactionOptions = {}) {
    this.replacement = options.replacement ?? DEFAULT_REPLACEMENT;
    this.redactCards = options.useDefaultPatterns !== false;
    this.redactDefaults = options.useDefaultPatterns !== false;

    const defaults = options.useDefaultPatterns === false ? [] : buildDefaultRules();
    const extra: CompiledRule[] = (options.patterns ?? []).map((pattern) => ({
      // Rebuilt with the global flag: a caller-supplied pattern without /g would silently redact only the first match.
      pattern: pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g'),
      replace: (replacement: string) => replacement,
    }));

    this.rules = [...defaults, ...extra];
    this.matchesSensitiveKey = createSensitiveKeyMatcher(options.keys);
  }

  /** Whether a key names a credential: the built-in rules plus the configured `keys`. */
  isSensitiveKey(key: string): boolean {
    return this.matchesSensitiveKey(key);
  }

  redactMessage(message: string): string {
    let output = this.redactDefaults ? redactPem(message, this.replacement) : message;
    for (const rule of this.rules) {
      output = output.replace(rule.pattern, (...args) => {
        // String.replace passes offset and the whole string after the groups.
        const groups = args.slice(1, -2).map((group) => group ?? '');
        return rule.replace(this.replacement, ...groups);
      });
    }

    if (this.redactCards) {
      output = output.replace(CARD_CANDIDATE, (match) => {
        const digits = match.replace(/[ -]/g, '');
        return digits.length >= 13 && isLuhnValid(digits) ? this.replacement : match;
      });
    }

    return output;
  }

  redactAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!attributes) {
      return attributes;
    }
    return this.redactValue(attributes, 0) as Record<string, unknown>;
  }

  private redactValue(value: unknown, depth: number): unknown {
    if (depth > MAX_ATTRIBUTE_DEPTH) {
      return this.replacement;
    }

    if (typeof value === 'string') {
      return this.redactMessage(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          // A sensitive key masks its value whatever the shape.
          this.matchesSensitiveKey(key) ? this.replacement : this.redactValue(item, depth + 1),
        ]),
      );
    }
    return value;
  }
}
