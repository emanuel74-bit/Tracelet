import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_PLACEHOLDER, createStaticAssets, escapeJsonForHtml } from '../../../src/http/static-assets.js';
import { createDiagnostics } from '../../../src/shared/diagnostics.js';
import { LS, PS } from '../../support/http/http.js';

const REAL_DIR = resolve(__dirname, '..', '..', '..', 'assets', 'dashboard');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); // plain mkdtemp directories created by this test
});

/** A private copy of the packaged dashboard that a test can tamper with. */
function copyAssets(mutate?: (dir: string, manifest: any) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracelet-assets-'));
  dirs.push(dir);
  cpSync(REAL_DIR, dir, { recursive: true });
  if (mutate) {
    const manifestPath = join(dir, 'asset-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mutate(dir, manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  return dir;
}

function silent() {
  const lines: string[] = [];
  return { lines, diagnostics: createDiagnostics('t', (_l, _s, m) => lines.push(m)) };
}

const JS = 'assets/index-DZSRTth0.js';
const CSS = 'assets/index-8H8qAzKJ.css';

/** Rewrites a manifest entry for new bytes so only the targeted validation can fail. */
function replaceFile(dir: string, manifest: any, name: string, bytes: Buffer | string): void {
  writeFileSync(join(dir, name), bytes);
  const b = Buffer.from(bytes);
  manifest.files[name].size = b.length;
  manifest.files[name].sha256 = sha(b);
}

function configOf(html: string): any {
  const m = /<script id="tracelet-config" type="application\/json">([^<]*)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]);
}

describe('static-assets: the packaged dashboard', () => {
  it('loads and validates the committed manifest (bytes, sizes, hashes)', () => {
    const a = createStaticAssets('/observe');
    expect(a.unavailableReason).toBeUndefined();
    expect(a.available).toBe(true);
  });

  it('injects the frozen runtime config exactly once in place of the placeholder', () => {
    const a = createStaticAssets('/internal/observe');
    const res = a.serve('/', 'GET', undefined)!;
    expect(res.status).toBe(200);
    const html = (res.body as Buffer).toString('utf8');
    expect(html).not.toContain(CONFIG_PLACEHOLDER);
    expect(html.match(/tracelet-config/g)).toHaveLength(1);
    expect(configOf(html)).toEqual({ basePath: '/internal/observe', apiBase: '/internal/observe/api/v1', contractVersion: '1.0.0', schemaVersion: 1 });
    expect(Object.isFrozen(a.runtimeConfig)).toBe(true);
    // the bundle is still referenced with relative URLs
    expect(html).toContain('./assets/index-DZSRTth0.js');
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
  });

  it('/index.html serves the same document as /', () => {
    const a = createStaticAssets('/observe');
    expect(a.serve('/index.html', 'GET', undefined)!.body).toEqual(a.serve('/', 'GET', undefined)!.body);
  });

  it('serves hashed assets as immutable with their content type; the HTML is never cached', () => {
    const a = createStaticAssets('/observe');
    const js = a.serve('/' + JS, 'GET', undefined)!;
    expect(js.status).toBe(200);
    expect(js.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['Cache-Control']).toBe('private, max-age=86400, immutable');
    expect(js.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(Buffer.isBuffer(js.body) && js.body.length).toBe(232148);
    expect(a.serve('/' + CSS, 'GET', undefined)!.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect(a.serve('/', 'GET', undefined)!.headers['Cache-Control']).toBe('no-store');
  });

  it('serves nothing that is not in the manifest: no source maps, no manifest, no fixtures, no dotfiles, no traversal', () => {
    const a = createStaticAssets('/observe');
    for (const p of ['/' + JS + '.map', '/asset-manifest.json', '/.gitattributes', '/assets/', '/assets', '/assets/nope.js', '/../package.json', '/assets/../index.html', '/fixtures/api-responses.json', '/demo/observe_dashboard_demo_v2.html', '/INDEX.HTML', '//assets/' + JS.slice(7)]) {
      expect(a.has(p), p).toBe(false);
      expect(a.serve(p, 'GET', undefined), p).toBeUndefined();
    }
  });

  it('the committed assets directory contains no .map file reachable through the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(REAL_DIR, 'asset-manifest.json'), 'utf8'));
    expect(Object.keys(manifest.files).filter(f => /\.map$|fixture/i.test(f))).toEqual([]);
  });
});

describe('static-assets: ETag, conditional requests and HEAD', () => {
  const a = createStaticAssets('/observe');

  it('every response carries a strong ETag; the html ETag is the hash of the INJECTED bytes', () => {
    const html = a.serve('/', 'GET', undefined)!;
    expect(html.headers.ETag).toBe(`"${sha(html.body as Buffer)}"`);
    const js = a.serve('/' + JS, 'GET', undefined)!;
    expect(js.headers.ETag).toBe('"97e00b85f5dc261fb6a69865c726a35d5383e268ea6bb4c34b6d970f3d5aaa10"');
  });

  it('a different base path gives a different html ETag (the injected config differs)', () => {
    expect(createStaticAssets('/other').serve('/', 'GET', undefined)!.headers.ETag).not.toBe(a.serve('/', 'GET', undefined)!.headers.ETag);
  });

  it('If-None-Match: exact, weak, list and * give 304 without a body; a stale tag gives 200', () => {
    const etag = a.serve('/' + JS, 'GET', undefined)!.headers.ETag;
    for (const inm of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
      const r = a.serve('/' + JS, 'GET', inm)!;
      expect(r.status, inm).toBe(304);
      expect(r.body).toBe('');
      expect(r.headers.ETag).toBe(etag);
      expect(r.headers['Content-Length']).toBeUndefined();
      expect(r.headers['Content-Type']).toBeUndefined();
      expect(r.headers['Cache-Control']).toBe('private, max-age=86400, immutable');
    }
    expect(a.serve('/' + JS, 'GET', '"stale"')!.status).toBe(200);
    expect(a.serve('/' + JS, 'GET', [etag!])!.status).toBe(304);
    expect(a.serve('/', 'GET', etag)!.status).toBe(200); // another resource's tag
  });

  it('HEAD returns the headers of GET (incl. Content-Length and ETag) and no body', () => {
    for (const p of ['/', '/' + JS]) {
      const get = a.serve(p, 'GET', undefined)!;
      const head = a.serve(p, 'HEAD', undefined)!;
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers).toEqual(get.headers);
      expect(head.headers['Content-Length']).toBe(String((get.body as Buffer).length));
    }
    expect(a.serve('/', 'head', undefined)!.body).toBe('');
  });

  it('returned header objects are copies (callers cannot poison the cache)', () => {
    const r1 = a.serve('/' + JS, 'GET', undefined)!;
    r1.headers['Cache-Control'] = 'x';
    expect(a.serve('/' + JS, 'GET', undefined)!.headers['Cache-Control']).toBe('private, max-age=86400, immutable');
  });
});

describe('static-assets: runtime config escaping (L8)', () => {
  it('escapeJsonForHtml turns < > & U+2028 U+2029 into \\u sequences and the result still parses to the same value', () => {
    const hostile = { a: `</script><!--${LS}${PS}&amp;<>`, b: ['</SCRIPT>', '-->'] };
    const text = escapeJsonForHtml(JSON.stringify(hostile));
    for (const ch of ['<', '>', '&', LS, PS]) expect(text.includes(ch), JSON.stringify(ch)).toBe(false);
    expect(text).toContain('\\u003c/script\\u003e\\u003c!--\\u2028\\u2029\\u0026amp;\\u003c\\u003e');
    expect(JSON.parse(text)).toEqual(hostile);
  });

  it('a page that contains "$&" or "$1" patterns is not corrupted by the replacement (no regex replacement semantics)', () => {
    const dir = copyAssets((d, m) => replaceFile(d, m, 'index.html', `<html><head>${CONFIG_PLACEHOLDER}</head><body>$& $1 $\`</body></html>`));
    const html = (createStaticAssets('/observe', { assetDir: dir }).serve('/', 'GET', undefined)!.body as Buffer).toString('utf8');
    expect(html).toContain('<body>$& $1 $`</body>');
    expect(configOf(html).basePath).toBe('/observe');
  });

  it('the injected block contains no raw < > & inside the JSON for any accepted base path', () => {
    for (const base of ['/observe', '/a/b-c/d.e', '/~x_y']) {
      const html = (createStaticAssets(base).serve('/', 'GET', undefined)!.body as Buffer).toString('utf8');
      const json = /<script id="tracelet-config" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
      expect(json).not.toMatch(/[<>&]/);
      expect(JSON.parse(json).basePath).toBe(base);
    }
  });

  it('base paths that could carry markup are refused before anything is built', () => {
    for (const bad of ['', '/', 'observe', '/a/../b', '/a//b', '/<script>', '/a b', '/a"b', '/a\\b', `/a${LS}b`]) {
      expect(() => createStaticAssets(bad), JSON.stringify(bad)).toThrow();
    }
    expect(createStaticAssets('/observe/').runtimeConfig.basePath).toBe('/observe');
  });
});

describe('static-assets: fail closed on validation errors (dashboard unavailable, no exception)', () => {
  function expectClosed(dir: string, reasonRe: RegExp, maxTotalBytes?: number): void {
    const { lines, diagnostics } = silent();
    const a = createStaticAssets('/observe', { assetDir: dir, diagnostics, ...(maxTotalBytes !== undefined ? { maxTotalBytes } : {}) });
    expect(a.available).toBe(false);
    expect(a.unavailableReason).toMatch(reasonRe);
    for (const p of ['/', '/index.html', '/' + JS, '/' + CSS]) {
      expect(a.has(p)).toBe(false);
      expect(a.serve(p, 'GET', undefined)).toBeUndefined();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Dashboard assets are unavailable/);
  }

  it('a tampered byte with the same size is detected (sha256)', () => {
    const dir = copyAssets(d => {
      const f = join(d, JS);
      const b = readFileSync(f);
      b[1000] = b[1000] ^ 0xff;
      writeFileSync(f, b);
    });
    expectClosed(dir, /^sha256 mismatch \(assets\/index-DZSRTth0\.js\)$/);
  });

  it('a different size is detected before hashing', () => {
    expectClosed(copyAssets(d => writeFileSync(join(d, JS), Buffer.concat([readFileSync(join(d, JS)), Buffer.from('x')]))), /^size mismatch/);
  });

  it('a tampered entry html is detected (the injected variant is never built from unverified bytes)', () => {
    expectClosed(copyAssets(d => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('Observe', 'Observx'))), /^sha256 mismatch \(index\.html\)$/);
  });

  it('a missing file, a missing manifest and an unparsable manifest', () => {
    expectClosed(copyAssets(d => rmSync(join(d, CSS))), /^asset file is missing or unreadable \(assets\/index-8H8qAzKJ\.css\)$/);
    {
      const dir = copyAssets();
      rmSync(join(dir, 'asset-manifest.json'));
      expectClosed(dir, /missing or is not valid JSON/);
    }
    {
      const dir = copyAssets();
      writeFileSync(join(dir, 'asset-manifest.json'), '{nope');
      expectClosed(dir, /missing or is not valid JSON/);
    }
  });

  it('manifest structure errors', () => {
    expectClosed(copyAssets((_d, m) => { m.manifestVersion = 2; }), /unsupported manifestVersion/);
    expectClosed(copyAssets((_d, m) => { m.entry = 'other.html'; }), /entry must be index\.html/);
    expectClosed(copyAssets((_d, m) => { delete m.files['index.html']; }), /does not list index\.html/);
    expectClosed(copyAssets((_d, m) => { m.files = {}; }), /no files/);
    expectClosed(copyAssets((_d, m) => { m.files[JS].sha256 = 'XYZ'; }), /manifest entry is malformed/);
    expectClosed(copyAssets((_d, m) => { m.files[JS].size = -1; }), /manifest entry is malformed/);
    expectClosed(copyAssets((_d, m) => { m.files[JS].contentType = 'text/javascript\r\nX: y'; }), /manifest entry is malformed/);
    expectClosed(copyAssets((_d, m) => { m.files[JS].immutable = 'yes'; }), /manifest entry is malformed/);
    expectClosed(copyAssets((_d, m) => { m.files['index.html'].contentType = 'text/plain'; }), /index\.html must be text\/html/);
  });

  it('a manifest that lists a source map, a fixture, an absolute or a traversing path is refused', () => {
    for (const bad of [`${JS}.map`, 'fixtures/api.json', 'demo/x.html', '../package.json', '/etc/passwd', 'assets//x.js', 'assets\\x.js']) {
      const dir = copyAssets((d, m) => {
        m.files[bad] = { size: 1, sha256: sha('x'), contentType: 'text/plain', immutable: true };
      });
      expectClosed(dir, /unsafe file path|must not be served/);
    }
  });

  it('the placeholder must occur exactly once', () => {
    expectClosed(copyAssets((d, m) => replaceFile(d, m, 'index.html', '<html><body>no placeholder</body></html>')), /exactly once/);
    expectClosed(copyAssets((d, m) => replaceFile(d, m, 'index.html', `${CONFIG_PLACEHOLDER}${CONFIG_PLACEHOLDER}`)), /exactly once/);
  });

  it('the 8 MB cap is enforced from the manifest, before any large read', () => {
    expectClosed(copyAssets(), /size cap/, 100_000);
    const exact = 15338 + 232148 + 491;
    expect(createStaticAssets('/observe', { maxTotalBytes: exact }).available).toBe(true);
    expect(createStaticAssets('/observe', { maxTotalBytes: exact - 1, diagnostics: silent().diagnostics }).available).toBe(false);
  });

  it('works again when the files are intact (control for the failure cases above)', () => {
    const { lines, diagnostics } = silent();
    const a = createStaticAssets('/observe', { assetDir: copyAssets((_d, _m) => undefined), diagnostics });
    expect(a.available).toBe(true);
    expect(lines).toEqual([]);
  });

  it('never throws, even for a directory that does not exist', () => {
    const { diagnostics } = silent();
    expect(() => createStaticAssets('/observe', { assetDir: join(tmpdir(), 'tracelet-nonexistent-dir-xyz'), diagnostics })).not.toThrow();
    vi.restoreAllMocks();
  });
});
