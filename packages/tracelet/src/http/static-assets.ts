import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DashboardAssetManifest, DashboardRuntimeConfig, TraceletHttpResponse } from '../contracts/tracelet-internal-contracts';
import { CONTRACT_VERSION } from '../contracts';
import { createDiagnostics } from '../shared/diagnostics';
import type { Diagnostics } from '../shared/diagnostics';
import { normalizeBasePath } from './base-path';
import { assetHeaders, htmlHeaders } from './security-headers';

/**
 * Built dashboard assets, held in memory (plan 3.10, 12).
 *
 * At creation (synchronous, once, start-up only) the manifest and every listed file are read and VALIDATED: declared
 * size, actual size and sha256 must all match, the entry must be `index.html` and contain the placeholder
 * `<!--tracelet:config-->` exactly once, the total must stay within 8 MB, and the manifest must not list source maps,
 * fixtures, absolute or traversing paths. ANY failure fails closed: `available` is false, nothing is served from the
 * directory, `unavailableReason` carries a short diagnostic (no file contents) and the same text is logged once.
 * The API keeps working; the dashboard reports itself unavailable.
 */

export const CONFIG_PLACEHOLDER = '<!--tracelet:config-->';
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;
const DEFAULT_ASSET_DIR = resolve(__dirname, '..', '..', 'assets', 'dashboard');

export interface StaticAssetsOptions {
  /** Directory holding asset-manifest.json. Default: the package's assets/dashboard. */
  assetDir?: string;
  /** Default 8 MB. */
  maxTotalBytes?: number;
  diagnostics?: Diagnostics;
}

export interface StaticAssets {
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  /** The (frozen) config injected into the HTML. */
  readonly runtimeConfig: DashboardRuntimeConfig;
  /** True for the entry ('/' and '/index.html') and every manifest file ('/assets/x.js'). `relPath` is the decoded path below the base. */
  has(relPath: string): boolean;
  /** Undefined when `relPath` is not a served file. 304 when `ifNoneMatch` matches. HEAD returns the headers of GET with an empty body. */
  serve(relPath: string, method: string, ifNoneMatch: string | string[] | undefined): TraceletHttpResponse | undefined;
}

/** JSON.stringify output made safe inside an HTML data block: '<' '>' '&' U+2028 U+2029 become \uXXXX (plan L8). */
export function escapeJsonForHtml(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

interface Entry {
  body: Buffer;
  etag: string;
  headers: Record<string, string>;
  notModifiedHeaders: Record<string, string>;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const KEY = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._~\-/]+$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(; charset=[A-Za-z0-9-]+)?$/;

class ManifestError extends Error {}

function makeEntry(body: Buffer, etag: string, headers: Record<string, string>): Entry {
  const { 'Content-Type': _ct, ...notModifiedHeaders } = headers;
  return { body, etag, headers: { ...headers, ETag: etag, 'Content-Length': String(body.length) }, notModifiedHeaders: { ...notModifiedHeaders, ETag: etag } };
}

function load(assetDir: string, runtimeConfig: DashboardRuntimeConfig, maxTotal: number): Map<string, Entry> {
  let manifest: DashboardAssetManifest;
  try {
    manifest = JSON.parse(readFileSync(join(assetDir, 'asset-manifest.json'), 'utf8'));
  } catch {
    throw new ManifestError('asset-manifest.json is missing or is not valid JSON');
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.manifestVersion !== 1) throw new ManifestError('unsupported manifestVersion');
  if (manifest.entry !== 'index.html') throw new ManifestError('manifest entry must be index.html');
  const files = manifest.files;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new ManifestError('manifest files must be an object');
  const names = Object.keys(files);
  if (names.length === 0 || names.length > MAX_FILES) throw new ManifestError('manifest lists no files or too many files');
  if (!(manifest.entry in files)) throw new ManifestError('manifest does not list index.html');

  const out = new Map<string, Entry>();
  let total = 0;
  for (const name of names) {
    const meta = files[name];
    if (!KEY.test(name) || name.startsWith('/') || name.endsWith('/')) throw new ManifestError('manifest contains an unsafe file path');
    if (/\.map$/i.test(name) || /(^|\/)(fixtures?|demo|__tests__)(\/|$)/i.test(name)) throw new ManifestError(`manifest lists a file that must not be served (${name})`);
    if (
      meta === null || typeof meta !== 'object' || !Number.isSafeInteger(meta.size) || meta.size < 0 ||
      typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256) ||
      typeof meta.contentType !== 'string' || !CONTENT_TYPE.test(meta.contentType) || typeof meta.immutable !== 'boolean'
    ) {
      throw new ManifestError(`manifest entry is malformed (${name})`);
    }
    total += meta.size;
    if (total > maxTotal) throw new ManifestError('assets exceed the size cap');
    const file = join(assetDir, ...name.split('/'));
    let bytes: Buffer;
    try {
      if (statSync(file).size !== meta.size) throw new ManifestError(`size mismatch (${name})`);
      bytes = readFileSync(file);
    } catch (e) {
      if (e instanceof ManifestError) throw e;
      throw new ManifestError(`asset file is missing or unreadable (${name})`);
    }
    if (bytes.length !== meta.size) throw new ManifestError(`size mismatch (${name})`);
    if (sha256(bytes) !== meta.sha256) throw new ManifestError(`sha256 mismatch (${name})`);

    if (name === manifest.entry) {
      if (!meta.contentType.startsWith('text/html')) throw new ManifestError('index.html must be text/html');
      const html = bytes.toString('utf8');
      const first = html.indexOf(CONFIG_PLACEHOLDER);
      if (first < 0 || html.indexOf(CONFIG_PLACEHOLDER, first + 1) >= 0) throw new ManifestError('index.html must contain the config placeholder exactly once');
      const block = `<script id="tracelet-config" type="application/json">${escapeJsonForHtml(JSON.stringify(runtimeConfig))}</script>`;
      // split/join: the replacement text is never interpreted ($& etc.)
      const injected = Buffer.from(html.split(CONFIG_PLACEHOLDER).join(block), 'utf8');
      out.set(name, makeEntry(injected, `"${sha256(injected)}"`, htmlHeaders()));
    } else {
      out.set(name, makeEntry(bytes, `"${meta.sha256}"`, assetHeaders(meta.contentType, meta.immutable)));
    }
  }
  return out;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw.trim() === '*') return true;
  return raw.split(',').some(t => t.trim().replace(/^W\//, '') === etag);
}

export function createStaticAssets(basePath: string, options: StaticAssetsOptions = {}): StaticAssets {
  const base = normalizeBasePath(basePath);
  const diagnostics = options.diagnostics ?? createDiagnostics('TraceletHttp');
  const runtimeConfig: DashboardRuntimeConfig = Object.freeze({ basePath: base, apiBase: `${base}/api/v1`, contractVersion: CONTRACT_VERSION, schemaVersion: 1 as const });
  let entries = new Map<string, Entry>();
  let reason: string | undefined;
  try {
    entries = load(options.assetDir ?? DEFAULT_ASSET_DIR, runtimeConfig, options.maxTotalBytes ?? MAX_ASSET_BYTES);
  } catch (e) {
    reason = e instanceof ManifestError ? e.message : 'dashboard assets could not be loaded';
    entries = new Map();
    diagnostics.error('assets-invalid', `Dashboard assets are unavailable: ${reason}. The API keeps working.`);
  }
  const resolveKey = (relPath: string): string | undefined => {
    if (reason !== undefined) return undefined;
    if (relPath === '/' || relPath === '/index.html') return 'index.html';
    const key = relPath.startsWith('/') ? relPath.slice(1) : relPath;
    // The entry is only reachable as '/' or '/index.html'; every other key must be a manifest file.
    return key !== 'index.html' && entries.has(key) ? key : undefined;
  };
  return {
    available: reason === undefined,
    unavailableReason: reason,
    runtimeConfig,
    has: relPath => resolveKey(relPath) !== undefined,
    serve(relPath, method, ifNoneMatch) {
      const key = resolveKey(relPath);
      const entry = key === undefined ? undefined : entries.get(key);
      if (entry === undefined) return undefined;
      if (etagMatches(ifNoneMatch, entry.etag)) return { status: 304, headers: { ...entry.notModifiedHeaders }, body: '' };
      return { status: 200, headers: { ...entry.headers }, body: method.toUpperCase() === 'HEAD' ? '' : entry.body };
    },
  };
}
