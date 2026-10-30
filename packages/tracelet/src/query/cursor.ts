import { createHash } from 'node:crypto';
import { QueryError } from './filters';

export type Cursor = { v: 1; s: number; t: string; f: string };
export function fingerprint(route: string, q: Readonly<Record<string, string | undefined>>): string {
  return createHash('sha256').update(JSON.stringify([route, ...Object.keys(q).filter(k => !['cursor', 'limit'].includes(k)).sort().map(k => [k, q[k]])])).digest('hex').slice(0, 8);
}
export function decodeCursor(value: string | undefined, expected: string): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (c.v !== 1 || !Number.isSafeInteger(c.s) || typeof c.t !== 'string' || !c.t.length || c.t.length > 128 || c.f !== expected || Object.keys(c).sort().join(',') !== 'f,s,t,v') throw new Error();
    return c;
  } catch { throw new QueryError('INVALID_CURSOR', 400, 'Invalid cursor or filters; use explicit time bounds for pagination'); }
}
export function encodeCursor(s: number, t: string, f: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s, t, f })).toString('base64url');
}
