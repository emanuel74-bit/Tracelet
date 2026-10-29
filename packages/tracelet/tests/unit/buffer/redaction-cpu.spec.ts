import { describe, expect, it } from 'vitest';
import { sanitizeError } from '../../../src/buffer/index.js';
import { boundAttributes } from '../../../src/buffer/attributes.js';
import { LogRedactor } from '../../../src/context/index.js';

/* R-4: redaction CPU is bounded on the main thread: linear rules, and inputs capped before any regex runs. */

const redactor = new LogRedactor();
const KB64 = 64 * 1024;
const BUDGET_MS = 50;

const adversarial: Record<string, string> = {
  'URI rule: a.a.a. run': 'a.'.repeat(KB64 / 2),
  'URI rule: scheme-like run with ://': 'ab+c.'.repeat(KB64 / 5) + '://',
  'e-mail rule: local-part run': 'a.'.repeat(KB64 / 2),
  'e-mail rule: many @ and dots': 'a@a.'.repeat(KB64 / 4),
  'e-mail rule: long domain, no tld': 'x@' + 'a.'.repeat(KB64 / 2),
  'PEM rule: repeated BEGIN without END': '-----BEGIN PRIVATE KEY-----'.repeat(KB64 / 27),
  'PEM rule: BEGINs, one END, more BEGINs': '-----BEGIN PRIVATE KEY-----'.repeat(KB64 / 54) + '-----END PRIVATE KEY-----' + '-----BEGIN PRIVATE KEY-----'.repeat(KB64 / 54),
  'PEM rule: END markers only': '-----END '.repeat(KB64 / 9),
  'key=value rule: repeated keys': 'token'.repeat(KB64 / 5),
  'key=value rule: key then long whitespace': 'password' + ' '.repeat(KB64),
  'bearer rule': 'Bearer ' + 'a'.repeat(KB64),
  'bearer rule: repeated scheme': 'Bearer '.repeat(KB64 / 7),
  'jwt rule': 'eyJ-'.repeat(KB64 / 4),
  'card rule': '1 '.repeat(KB64 / 2),
  'aws rule': 'AKIA'.repeat(KB64 / 4),
};

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('redaction rules are linear on 64 KB adversarial input', () => {
  for (const [name, input] of Object.entries(adversarial)) {
    it(`${name} < ${BUDGET_MS} ms`, () => {
      expect(input.length).toBeGreaterThanOrEqual(KB64 - 64);
      redactor.redactMessage(input.slice(0, 256)); // warm up
      expect(timeMs(() => redactor.redactMessage(input))).toBeLessThan(BUDGET_MS);
    });
  }

  it('still redacts what it is supposed to (the linear rules did not lose coverage)', () => {
    expect(redactor.redactMessage('mongodb://u:p@h/x')).toBe('mongodb://[REDACTED]@h/x');
    expect(redactor.redactMessage('x http://a.b+c://u:p@h')).toContain('[REDACTED]@h');
    expect(redactor.redactMessage('mail me: a.b+c@d-e.example.org now')).toBe('mail me: [EMAIL] now');
    expect(redactor.redactMessage('x.y@z.com,q@r.io')).toBe('[EMAIL],[EMAIL]');
  });
});

describe('sanitizer and attributes cap input before redacting', () => {
  it('sanitizeError on a 64 KB message and 64 KB of frame lines < 50 ms', () => {
    const big = 'a.'.repeat(KB64 / 2);
    const stack = ['Error: m', ...Array.from({ length: 200 }, () => `    at fn (${big})`)].join('\n');
    const payload = { cls: 'E', message: big, stack };
    sanitizeError(payload, { errorMessages: 'redacted', redactor, cwd: '/x' }); // warm up
    const ms = timeMs(() => sanitizeError(payload, { errorMessages: 'redacted', redactor, cwd: '/x' }));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('the stored message is still <= 1024 chars and frames <= 256 after the input caps', () => {
    const out = sanitizeError(
      { cls: 'E', message: 'x'.repeat(100_000), stack: `Error\n    at ${'y'.repeat(100_000)}` },
      { errorMessages: 'redacted', redactor, cwd: '/x' },
    );
    expect(out.message!.length).toBe(1024);
    expect(out.stack![0].length).toBeLessThanOrEqual(256);
  });

  it('boundAttributes on 16 attributes of 64 KB < 50 ms', () => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < 16; i++) attrs[`k${i}`] = 'a.'.repeat(KB64 / 2);
    boundAttributes(attrs, redactor);
    expect(timeMs(() => boundAttributes(attrs, redactor))).toBeLessThan(BUDGET_MS);
    expect(Object.values(boundAttributes(attrs, redactor)!).every((v) => (v as string).length <= 256)).toBe(true);
  });
});

describe('PEM rule keeps redacting real keys', () => {
  it('redacts multi-line private keys, including two in one text and a long body', () => {
    const body = ('A'.repeat(64) + '\n').repeat(50);
    const out = redactor.redactMessage(`x -----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY----- y`);
    expect(out).toBe('x [REDACTED] y');
    const two = [
      '-----BEGIN PRIVATE KEY-----',
      'abc',
      '-----END PRIVATE KEY----- mid -----BEGIN EC PRIVATE KEY-----',
      'z'.repeat(20000),
      '-----END EC PRIVATE KEY-----',
    ].join('\n');
    expect(redactor.redactMessage(two)).toBe('[REDACTED] mid [REDACTED]');
    // An unterminated BEGIN (a key cut off by an input cap) is redacted to the end of the text, never left as is (N-1).
    expect(redactor.redactMessage('-----BEGIN PRIVATE KEY----- no end here')).toBe('[REDACTED]');
    expect(redactor.redactMessage('keep -----BEGIN PRIVATE KEY-----\nMIIE')).toBe('keep [REDACTED]');
  });
});
