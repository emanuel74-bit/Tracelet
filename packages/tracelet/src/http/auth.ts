import type { TraceletAuthRequest } from '../contracts/observe-contracts';
import { createDiagnostics } from '../shared/diagnostics';
import type { Diagnostics } from '../shared/diagnostics';
import { isDevOrTest } from '../shared/env';

/**
 * Default-deny authorisation gate (plan 12, R10, L9).
 *
 * Decision (the caller has already answered non-GET/HEAD with 405):
 *   1. `authorize` set: `await authorize(req)` with a timeout; only the value `true` allows; false, any other value,
 *      a throw, a rejection or a timeout denies. The exception is never surfaced (a constant diagnostic is logged).
 *   2. else `allowLoopbackWithoutAuth` and the SOCKET peer address is 127.0.0.1, ::1 or ::ffff:127.0.0.1 -> allow.
 *   3. else deny.
 * `allowLoopbackWithoutAuth` defaults to true only when NODE_ENV is 'development' or 'test' (unset = production = false).
 * `req.headers` is never consulted: X-Forwarded-For and friends cannot influence the decision, and the mounts feed
 * `remoteAddress` from the socket, never from req.ip / request.ip (which follow trust proxy settings).
 */
export type AuthGate = (req: TraceletAuthRequest) => Promise<boolean>;

export interface AuthGateOptions {
  authorize?: (req: TraceletAuthRequest) => boolean | Promise<boolean>;
  /** Default: isDevOrTest() evaluated when the gate is created. */
  allowLoopbackWithoutAuth?: boolean;
  /** Default 2000. */
  authorizeTimeoutMs?: number;
  diagnostics?: Diagnostics;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined): boolean {
  return typeof address === 'string' && LOOPBACK.has(address.toLowerCase());
}

export function createAuthGate(options: AuthGateOptions = {}): AuthGate {
  const allowLoopback = options.allowLoopbackWithoutAuth ?? isDevOrTest();
  const authorize = options.authorize;
  const timeoutMs = options.authorizeTimeoutMs ?? 2000;
  const diagnostics = options.diagnostics ?? createDiagnostics('TraceletHttp');

  return async req => {
    if (authorize !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          timer.unref?.();
        });
        const result = await Promise.race([Promise.resolve().then(() => authorize(req)), timeout]);
        if (result === 'timeout') {
          diagnostics.warn('authorize-timeout', 'The authorize() hook did not answer in time; request denied.');
          return false;
        }
        return result === true;
      } catch {
        diagnostics.warn('authorize-error', 'The authorize() hook failed; request denied.');
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return allowLoopback && isLoopbackAddress(req.remoteAddress);
  };
}
