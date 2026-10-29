import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { configureTracing, trace } from '../../../src/context/index.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';
import { createOrdersApp, type OrdersApp } from '../../support/instrumentation/orders-app.js';

/* T16: secrets in error messages and attributes never reach the queued items (scan of the FULL serialized items). */

const PASSWORD = 'S3cretPassw0rdXyZ';
const BEARER = 'abc123bearerTOKENvalue9876';
const EMAIL = 'alice.example@corp-example.com';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_BODY_CHUNK = PEM.split('\n')[2]; // a 64-char base64 line of the key
const MONGO_URI = `mongodb://dbadmin:${PASSWORD}@mongo.internal:27017/orders?authSource=admin`;

const SECRETS = [PASSWORD, BEARER, EMAIL, JWT, PEM_BODY_CHUNK, 'MIIE', 'dbadmin'];

function leaks(serialized: string): string[] {
  return SECRETS.filter((secret) => serialized.includes(secret));
}

const secretMessage = (): string =>
  [
    `connect failed ${MONGO_URI}`,
    `Authorization: Bearer ${BEARER}`,
    `user ${EMAIL} token=${JWT}`,
    PEM,
  ].join(' | ');

describe.each(['redacted', 'omit'] as const)('T16 redaction, errorMessages = %s', (mode) => {
  let h: Harness | undefined;
  let orders: OrdersApp | undefined;
  afterEach(async () => {
    await orders?.close();
    orders = undefined;
    h?.stop();
    h = undefined;
  });

  it('a provider error, a root error and attributes carrying secrets leave no secret in any queued item', async () => {
    h = startHarness({ errorMessages: mode, rollups: true });
    orders = await createOrdersApp();
    const error = new Error(secretMessage());
    const sensitiveAttrs = {
      queue: 'orders',
      password: PASSWORD, // sensitive key name
      authorization: `Bearer ${BEARER}`, // sensitive key name
      note: `see ${MONGO_URI} and ${EMAIL}`, // secrets in a harmless key
      jwt_in_value: JWT,
      pem: PEM,
      mail: EMAIL,
    };

    // provider error (origin deep in the tree, rethrown by ancestors)
    await expect(
      trace('rabbitmq.consume', () => orders!.consumer.process({ id: 'x', fail: 'transform', error }), {
        kind: 'rabbitmq',
        attributes: sensitiveAttrs,
      }),
    ).rejects.toBe(error);
    // error thrown by the root callback itself
    await expect(
      trace('root.fails', () => Promise.reject(new Error(secretMessage())), { kind: 'custom', attributes: sensitiveAttrs }),
    ).rejects.toThrow();
    // synchronous root throw with a non-Error value carrying a secret
    expect(() =>
      trace('root.sync', () => {
        throw `plain string ${MONGO_URI} Bearer ${BEARER}`;
      }),
    ).toThrow();
    // failed UNSAMPLED root kept as rootOnly
    configureTracing({ sampleRate: 0 });
    await expect(trace('unsampled.fails', () => Promise.reject(new Error(secretMessage())), { attributes: sensitiveAttrs })).rejects.toThrow();
    configureTracing({ sampleRate: 1 });

    h.rollups!.shutdown();
    await h.settle();
    expect(h.items.length).toBe(4);
    expect(h.items.some((i) => i.trace.detail === 'rootOnly')).toBe(true);

    for (const item of h.items) {
      expect(leaks(JSON.stringify(item)), `trace ${item.trace.operation}`).toEqual([]);
      for (const span of item.spans) {
        if (mode === 'omit' && span.sanitizedError) expect(span.sanitizedError.message).toBeUndefined();
      }
      if (mode === 'omit' && item.trace.error) expect(item.trace.error.message).toBeUndefined();
    }
    for (const rollup of h.rollupItems) expect(leaks(JSON.stringify(rollup))).toEqual([]);

    // the redaction itself ran (the content is replaced, not just dropped), in redacted mode
    const first = h.items.find((i) => i.trace.operation === 'rabbitmq.consume')!;
    expect(first.trace.attributes).toMatchObject({ queue: 'orders', password: '[REDACTED]', authorization: '[REDACTED]' });
    const note = String(first.trace.attributes!.note);
    expect(note).toContain('[REDACTED]@mongo.internal');
    expect(note).toContain('[EMAIL]');
    if (mode === 'redacted') {
      const msg = first.spans.find((s) => s.sanitizedError)?.sanitizedError?.message ?? '';
      expect(msg).toContain('mongodb://[REDACTED]@mongo.internal:27017');
      expect(msg).toContain('[EMAIL]');
    }
    // the thrown reference is untouched (redaction works on a copy)
    expect(error.message).toContain(PASSWORD);
  });

  it('secrets in a thrown error stack frames text and a non-Error object throw are not stored either', async () => {
    h = startHarness({ errorMessages: mode });
    const error = new Error('x');
    error.stack = `Error: ${secretMessage()}\n    at ${MONGO_URI} (/srv/app/node_modules/pkg/index.js:1:1)\n    at handler (${process.cwd()}/src/a.ts:3:4)`;
    await expect(trace('stack.secret', () => Promise.reject(error))).rejects.toBe(error);
    const objectError = { message: secretMessage(), code: PASSWORD, toString: () => secretMessage() };
    await expect(trace('object.secret', () => Promise.reject(objectError))).rejects.toBe(objectError);
    await h.settle();
    for (const item of h.items) expect(leaks(JSON.stringify(item)), item.trace.operation).toEqual([]);
  });
});
