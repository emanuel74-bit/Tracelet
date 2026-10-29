import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sanitizeError } from '../../../src/buffer/index.js';
import { boundAttributes } from '../../../src/buffer/attributes.js';
import { capInput } from '../../../src/buffer/error-sanitizer.js';
import { LogRedactor, toErrorPayload } from '../../../src/context/index.js';

/* N-1, O-a, O-b: input caps must never let key material or half a secret reach stored text. */

const redactor = new LogRedactor();
const pem = (bits: number): string =>
  generateKeyPairSync('rsa', { modulusLength: bits, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    .privateKey;

// 40+ base64 characters in a row is key material (the redaction placeholder and normal words never produce that).
const BASE64_RUN = /[A-Za-z0-9+/]{40,}/;

const KEY_2048 = pem(2048);
const KEY_4096 = pem(4096);

describe('real private keys are fully redacted after the input caps (N-1)', () => {
  it('the generated fixtures are what the test claims (PEM, sizes)', () => {
    expect(KEY_2048.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(KEY_2048.length).toBeGreaterThan(1500);
    expect(KEY_4096.length).toBeGreaterThan(3000); // well beyond the 2048/1024/256 caps
  }, 120_000);

  it('a 4096-bit key inside an error message (errorMessages redacted)', () => {
    const message = `signing failed with key\n${KEY_4096}\nretry later`;
    const out = sanitizeError({ cls: 'Error', message }, { errorMessages: 'redacted', redactor, cwd: '/x' });
    const stored = JSON.stringify(out);
    expect(stored).not.toMatch(BASE64_RUN);
    expect(stored).not.toContain('MII');
    expect(out.message).toContain('[REDACTED]');
    expect(out.message!.startsWith('signing failed with key')).toBe(true);
  }, 120_000);

  it('a 4096-bit key at the very start of the message, and a key cut mid-body by the cap', () => {
    for (const message of [KEY_4096, `${'w '.repeat(950)} ${KEY_2048}`]) {
      const out = sanitizeError({ cls: 'Error', message }, { errorMessages: 'redacted', redactor, cwd: '/x' });
      expect(JSON.stringify(out)).not.toMatch(BASE64_RUN);
    }
  });

  for (const [label, key] of [['2048-bit', KEY_2048], ['4096-bit', KEY_4096]] as const) {
    it(`a ${label} key as an attribute value`, () => {
      const attrs = boundAttributes({ note: key, wrapped: `ctx: ${key} end` }, redactor)!;
      for (const value of Object.values(attrs)) {
        expect(String(value)).not.toMatch(BASE64_RUN);
        expect(String(value)).toContain('[REDACTED]');
      }
    });
  }

  it('the redactor itself redacts an unterminated BEGIN to the end of the text', () => {
    const cut = KEY_4096.slice(0, 700);
    const out = redactor.redactMessage(`before ${cut}`);
    expect(out).toBe('before [REDACTED]');
  });
});

describe('a secret split at the cap does not reach stored text (O-a)', () => {
  it('a 2048-bit PEM followed by a URI with credentials cut inside the user name', () => {
    const needle = 'mongodb://adm';
    const head = `${KEY_2048} `;
    const filler = 'w '.repeat(2048).slice(0, 2048 - head.length - 1 - needle.length);
    const message = `${head}${filler} mongodb://admin:hunter2@db.internal:27017/x`;
    expect(message.indexOf('mongodb://admin') + needle.length).toBe(2048); // the cap cuts inside "admin"
    const out = sanitizeError({ cls: 'Error', message }, { errorMessages: 'redacted', redactor, cwd: '/x' });
    expect(out.message).not.toContain('mongodb');
    expect(out.message).not.toContain('admin');
    expect(out.message).not.toContain('hunter2');
    expect(out.message).not.toMatch(BASE64_RUN);
  });

  it('capInput: untouched when short; trailing partial token dropped when cut; kept as cut when there is no delimiter', () => {
    expect(capInput('short text', 100)).toBe('short text');
    expect(capInput('alpha beta gamma', 12)).toBe('alpha beta'); // "gamma" would be partial ("gam")
    expect(capInput('alpha beta,gamma', 13)).toBe('alpha beta'); // cut inside "gamma": back to the comma
    expect(capInput('x'.repeat(50), 10)).toBe('x'.repeat(10));
    expect(capInput('alpha beta ', 11)).toBe('alpha beta ');
  });

  it('attribute values are cut at a token boundary too', () => {
    const value = `${'w '.repeat(500)}mongodb://admin:hunter2@h`;
    const out = boundAttributes({ v: value }, redactor)!.v as string;
    expect(out).not.toContain('hunter2');
    expect(out.length).toBeLessThanOrEqual(256);
  });
});

describe("message lines starting with 'at ' never become frames (O-b)", () => {
  const frames = '    at real (src/a.ts:2:2)';

  it('a message over 8192 chars (cut by the registry) with an "at " line after the cut, errorMessages omit', () => {
    const message = `${'a'.repeat(9000)}\n    at secret-frame (x.ts:1:1)\nend`;
    const error = new Error(message);
    const payload = toErrorPayload(error);
    expect(payload.message.length).toBeLessThan(message.length); // capped
    const out = sanitizeError(payload, { errorMessages: 'omit', redactor, cwd: process.cwd() });
    expect(JSON.stringify(out)).not.toContain('secret-frame');
    expect(out.message).toBeUndefined();
    expect(out.stack!.length).toBeGreaterThan(0); // the real frames of the Error stay
  });

  it('a very long class name does not matter (header lines are counted, not searched)', () => {
    class E extends Error {}
    Object.defineProperty(E, 'name', { value: 'N'.repeat(400) });
    const error = new E('first\n    at secret-frame (x.ts:1:1)');
    const out = sanitizeError(toErrorPayload(error), { errorMessages: 'omit', redactor, cwd: process.cwd() });
    expect(JSON.stringify(out)).not.toContain('secret-frame');
  });

  it('hand-built payloads without headerLines fall back to locating the message in the stack', () => {
    const message = 'x\n    at secret-frame (x.ts:1:1)';
    const out = sanitizeError(
      { cls: 'Error', message, stack: `Error: ${message}\n${frames}` },
      { errorMessages: 'omit', redactor, cwd: '/x' },
    );
    expect(out.stack).toEqual(['at real (src/a.ts:2:2)']);
  });
});
