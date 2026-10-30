import { createHash } from 'node:crypto';
import { QueryError } from './filters';

export type Cursor = { v: 1; s: number; t: string; f: string } | { v: 2; s: number; t: string; f: string; from: number; to: number };
export const invalidCursor = (): never => { throw new QueryError('INVALID_CURSOR', 400, 'Invalid cursor or filters'); };
export function fingerprint(route: string, q: Readonly<Record<string, string | undefined>>): string {
  return createHash('sha256').update(JSON.stringify([route, ...Object.keys(q).filter(k => !['cursor', 'limit'].includes(k)).sort().map(k => [k, q[k]])])).digest('hex').slice(0, 8);
}
export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (!c || ![1, 2].includes(c.v) || !Number.isSafeInteger(c.s) || typeof c.t !== 'string' || !c.t.length || c.t.length > 128 || typeof c.f !== 'string' || !/^[0-9a-f]{8}$/.test(c.f)) throw new Error();
    if (Object.keys(c).sort().join(',') !== (c.v === 1 ? 'f,s,t,v' : 'f,from,s,t,to,v')) throw new Error();
    if (c.v === 2 && (!Number.isSafeInteger(c.from) || !Number.isSafeInteger(c.to) || c.from >= c.to || Math.abs(c.from) > 8640000000000000 || Math.abs(c.to) > 8640000000000000)) throw new Error();
    return c;
  } catch { return invalidCursor(); }
}
export function encodeCursor(s: number, t: string, f: string, from: number, to: number): string {
  return Buffer.from(JSON.stringify({ v: 2, s, t, f, from, to })).toString('base64url');
}
