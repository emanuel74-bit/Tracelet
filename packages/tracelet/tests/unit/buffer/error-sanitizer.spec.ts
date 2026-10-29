import { describe, expect, it } from 'vitest';
import { fingerprint, sanitizeError } from '../../../src/buffer/index.js';
import { sanitizeFrame } from '../../../src/buffer/error-sanitizer.js';
import { LogRedactor } from '../../../src/context/index.js';

const redactor = new LogRedactor();
const CWD = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';
const sep = process.platform === 'win32' ? '\\' : '/';
const p = (...parts: string[]) => `${CWD}${sep}${parts.join(sep)}`;

const stack = (...frames: string[]) => ['Error: boom', ...frames.map((f) => `    at ${f}`)].join('\n');

describe('sanitizeError', () => {
  it('name <= 128, message redacted and <= 1024, stack frames only', () => {
    const out = sanitizeError(
      {
        cls: 'E'.repeat(300),
        message: `${'x'.repeat(2000)} Authorization: Bearer abcdefghijklmnop`,
        stack: stack('a (src/a.ts:1:1)'),
      },
      { errorMessages: 'redacted', redactor, cwd: CWD },
    );
    expect(out.name).toHaveLength(128);
    expect(out.message!.length).toBeLessThanOrEqual(1024);
    expect(out.stack).toEqual(['at a (src/a.ts:1:1)']);
  });

  it('redacts credentials in messages: bearer, URI userinfo, e-mail, key=value, card numbers', () => {
    const msg =
      'connect mongodb://admin:s3cr3t@db.internal:27017/x failed; user bob@example.com token=abc123 Authorization: Bearer abcdefghijklmnop card 4111 1111 1111 1111';
    const out = sanitizeError({ cls: 'MongoError', message: msg }, { errorMessages: 'redacted', redactor, cwd: CWD });
    expect(out.message).not.toContain('s3cr3t');
    expect(out.message).not.toContain('bob@example.com');
    expect(out.message).not.toContain('abc123');
    expect(out.message).not.toContain('abcdefghijklmnop');
    expect(out.message).not.toContain('4111');
    expect(out.message).toContain('mongodb://[REDACTED]@db.internal');
    expect(out.message).toContain('[EMAIL]');
  });

  it("errorMessages 'omit' keeps name and frames but no message text", () => {
    const out = sanitizeError(
      { cls: 'TypeError', message: 'secret details', stack: stack('f (src/x.ts:2:3)') },
      { errorMessages: 'omit', redactor, cwd: CWD },
    );
    expect(out.message).toBeUndefined();
    expect(out.name).toBe('TypeError');
    expect(out.stack).toHaveLength(1);
  });

  it('keeps at most 20 frames, each <= 256 chars', () => {
    const frames = Array.from({ length: 50 }, (_, i) => `fn${i} (src/${'d/'.repeat(200)}f.ts:${i}:1)`);
    const out = sanitizeError({ cls: 'E', message: 'm', stack: stack(...frames) }, { errorMessages: 'redacted', redactor, cwd: CWD });
    expect(out.stack).toHaveLength(20);
    for (const f of out.stack!) expect(f.length).toBeLessThanOrEqual(256);
  });

  it('paths are relative to cwd; node_modules shortened; no absolute path survives', () => {
    const frames = [
      `OrdersService.handle (${p('src', 'orders', 'orders.service.ts')}:10:5)`,
      `Layer.handle (${p('node_modules', '@nestjs', 'core', 'router', 'x.js')}:5:1)`,
      `Foo.bar (${p('packages', 'a', 'node_modules', 'lodash', 'index.js')}:1:1)`,
      `other (${process.platform === 'win32' ? 'D:\\elsewhere\\lib\\z.js' : '/elsewhere/lib/z.js'}:3:3)`,
      `esm (file:///${process.platform === 'win32' ? 'C:/work/app' : 'work/app'}/src/m.mjs:4:4)`,
      'node:internal/process/task_queues:95:5',
    ];
    const out = sanitizeError({ cls: 'E', message: 'm', stack: stack(...frames) }, { errorMessages: 'redacted', redactor, cwd: CWD });
    const joined = out.stack!.join('\n');
    expect(out.stack![0]).toBe('at OrdersService.handle (src/orders/orders.service.ts:10:5)');
    expect(out.stack![1]).toBe('at Layer.handle (node_modules/@nestjs/core/router/x.js:5:1)');
    expect(out.stack![2]).toBe('at Foo.bar (node_modules/lodash/index.js:1:1)');
    expect(out.stack![3]).toBe('at other (z.js:3:3)');
    expect(out.stack![4]).toBe('at esm (src/m.mjs:4:4)');
    expect(out.stack![5]).toBe('at node:internal/process/task_queues:95:5');
    expect(joined).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(joined).not.toContain('C:\\');
    expect(joined).not.toContain(CWD);
  });

  it("a message line that starts with 'at ' is not kept as a frame, especially under errorMessages 'omit'", () => {
    const message = ['first line', '    at secret-token-in-message (x.ts:1:1)', 'last'].join('\n');
    const stack = `Error: ${message}\n    at real (src/a.ts:2:2)`;
    for (const errorMessages of ['omit', 'redacted'] as const) {
      const out = sanitizeError({ cls: 'Error', message, stack }, { errorMessages, redactor, cwd: CWD });
      expect(out.stack).toEqual(['at real (src/a.ts:2:2)']);
      expect(JSON.stringify(out)).not.toContain(errorMessages === 'omit' ? 'secret-token' : 'zzz');
    }
  });

  it('non-Error payloads get a stable name and never throw', () => {
    expect(sanitizeError({ message: 'plain string' }, { errorMessages: 'redacted', redactor }).name).toBe('NonError');
    expect(() => sanitizeError(null as never, { errorMessages: 'redacted', redactor })).not.toThrow();
  });

  it('sanitizeFrame truncates to 256', () => {
    expect(sanitizeFrame(`at ${'x'.repeat(1000)}`, CWD).length).toBe(256);
  });
});

describe('fingerprint', () => {
  const base = sanitizeError(
    { cls: 'Error', message: 'm', stack: stack('Svc.run (src/svc.ts:10:5)', 'Other.x (src/o.ts:1:1)') },
    { errorMessages: 'omit', redactor, cwd: CWD },
  );

  it('16 lowercase hex chars', () => {
    expect(fingerprint(base, 'rabbitmq.consume')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores line/column and message, differs by name, frame and operation', () => {
    const moved = sanitizeError(
      { cls: 'Error', message: 'other message', stack: stack('Svc.run (src/svc.ts:99:1)', 'Other.x (src/o.ts:1:1)') },
      { errorMessages: 'redacted', redactor, cwd: CWD },
    );
    expect(fingerprint(moved, 'op')).toBe(fingerprint(base, 'op'));
    expect(fingerprint(base, 'op2')).not.toBe(fingerprint(base, 'op'));
    expect(fingerprint({ ...base, name: 'TypeError' }, 'op')).not.toBe(fingerprint(base, 'op'));
    const otherFrame = sanitizeError(
      { cls: 'Error', message: 'm', stack: stack('Svc.other (src/svc.ts:10:5)') },
      { errorMessages: 'omit', redactor, cwd: CWD },
    );
    expect(fingerprint(otherFrame, 'op')).not.toBe(fingerprint(base, 'op'));
  });

  it('uses the first in-app frame, skipping node_modules and node internals', () => {
    const viaLib = sanitizeError(
      {
        cls: 'Error',
        message: 'm',
        stack: stack(`lib (${p('node_modules', 'pkg', 'i.js')}:1:1)`, 'node:internal/x:1:1', 'App.go (src/app.ts:3:3)'),
      },
      { errorMessages: 'omit', redactor, cwd: CWD },
    );
    const onlyApp = sanitizeError({ cls: 'Error', message: 'm', stack: stack('App.go (src/app.ts:77:7)') }, { errorMessages: 'omit', redactor, cwd: CWD });
    expect(fingerprint(viaLib, 'op')).toBe(fingerprint(onlyApp, 'op'));
  });

  it('NUL separators: field boundaries cannot shift', () => {
    const a = fingerprint({ name: 'AB', stack: ['at C (x.ts:1:1)'] }, 'op');
    const b = fingerprint({ name: 'A', stack: ['at BC (x.ts:1:1)'] }, 'op');
    expect(a).not.toBe(b);
  });
});
