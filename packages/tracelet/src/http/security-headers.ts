/**
 * Response headers (plan 12). Pure functions returning fresh objects.
 *
 * CSP: nothing is inline. The runtime config is a non-executable `<script type="application/json">` data block which the
 * browser never runs, so no 'unsafe-inline', nonce or hash is needed. No external host, font or CDN is allowed.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const COMMON: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

/** JSON API responses and error envelopes. */
export function apiHeaders(): Record<string, string> {
  return { ...COMMON, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
}

/** The HTML entry document (contains the injected config, so never cached). */
export function htmlHeaders(): Record<string, string> {
  return { ...COMMON, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP };
}

/** Static files. `immutable` is the manifest flag of content-hashed files. */
export function assetHeaders(contentType: string, immutable: boolean): Record<string, string> {
  return {
    ...COMMON,
    'Content-Type': contentType,
    'Cache-Control': immutable ? 'private, max-age=86400, immutable' : 'no-store',
    'Content-Security-Policy': CSP,
  };
}
