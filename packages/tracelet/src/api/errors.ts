import type { ApiErrorCode, ErrorEnvelope } from '../contracts/observe-contracts';
import type { TraceletHttpResponse } from '../contracts/tracelet-internal-contracts';

export const response = (status: number, body: unknown): TraceletHttpResponse => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, body: JSON.stringify(body) });
export const error = (code: ApiErrorCode, message: string, status: number): TraceletHttpResponse => response(status, { error: { code, message } satisfies ErrorEnvelope['error'] });
