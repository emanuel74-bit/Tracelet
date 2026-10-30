import { describe, expect, it } from 'vitest';
import { apiHeaders, assetHeaders, CSP, htmlHeaders } from '../../../src/http/security-headers.js';

const directives = (csp: string): Map<string, string[]> => new Map(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe('security headers', () => {
  it('CSP: default-src none, self-only script/style/font/connect/img, no inline, no eval, no external host', () => {
    const d = directives(CSP);
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('style-src')).toEqual(["'self'"]);
    expect(d.get('font-src')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('img-src')).toEqual(["'self'", 'data:']);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*|blob:|nonce-|sha256-/);
  });

  it('html: CSP, no-store, nosniff, no-referrer, same-origin CORP, DENY framing, html content type', () => {
    const h = htmlHeaders();
    expect(h['Content-Security-Policy']).toBe(CSP);
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Content-Type']).toBe('text/html; charset=utf-8');
  });

  it('assets: immutable hashed files are privately cacheable for a day; others are no-store', () => {
    expect(assetHeaders('text/css; charset=utf-8', true)['Cache-Control']).toBe('private, max-age=86400, immutable');
    expect(assetHeaders('text/css; charset=utf-8', false)['Cache-Control']).toBe('no-store');
    const h = assetHeaders('text/javascript; charset=utf-8', true);
    expect(h['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('api: never cached, nosniff, locked-down CSP, no wildcard CORS', () => {
    const h = apiHeaders();
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(Object.keys(h).filter(k => /^access-control-/i.test(k))).toEqual([]);
  });

  it('each call returns a fresh object', () => {
    const a = htmlHeaders();
    a['Cache-Control'] = 'x';
    expect(htmlHeaders()['Cache-Control']).toBe('no-store');
  });
});
