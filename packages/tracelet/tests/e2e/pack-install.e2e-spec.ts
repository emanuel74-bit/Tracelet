import { fork, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PKG } from '../support/e2e/harness.js';
import { httpRequest } from '../support/http/http.js';

/*
 * T19: `npm pack` the package, install the TARBALL (not the workspace link) into a temp CommonJS Nest app and a temp ESM Nest app
 * (`"type": "module"`), boot both with TraceletModule + Tracelet.setup and request /observe/ and /observe/api/v1/health.
 * Everything happens under the OS temp dir; nothing is written into the repository. Needs network access to the npm registry
 * for @nestjs/* and mongodb (npm cache is used when warm).
 */

const NEST = '^11.1.4';
const root = mkdtempSync(join(tmpdir(), 'tracelet-pack-'));
const packDir = join(root, 'pack');
let tarball = '';
let packJson: { filename: string; size: number; unpackedSize: number; files: Array<{ path: string; size: number }> };

const npm = (args: string[], cwd: string): { status: number | null; out: string; stdout: string } => {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const CJS_MAIN = `'use strict';
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const tracelet = require('tracelet');
const { TraceletModule, Tracelet, TraceletInstrument, trace, version } = tracelet;
class AppModule {}
Module({ imports: [TraceletModule.forRoot({ enabled: true, serviceName: 'pack-cjs', storage: { uri: process.env.TRACELET_STORAGE_URI, database: 'tracelet_pack_test', serverSelectionTimeoutMS: 1000 } })] })(AppModule);
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, instrument: TraceletInstrument });
  app.enableShutdownHooks();
  Tracelet.setup(app, { authorize: (req) => req.headers['x-pack-test'] === 'yes' });
  await app.listen(0, '127.0.0.1');
  const result = await trace('pack.job', async () => 'done', { kind: 'custom' });
  process.send({ event: 'ready', port: app.getHttpServer().address().port, exports: Object.keys(tracelet).sort(), version, result });
  process.on('message', (m) => { if (m === 'shutdown') app.close().then(() => process.exit(0)); });
}
main().catch((e) => { console.error(e); process.exit(1); });
`;

const ESM_MAIN = `import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TraceletModule, Tracelet, TraceletInstrument, createTraceletInstrument, trace, currentTraceId, version } from 'tracelet';
import * as ns from 'tracelet';
class AppModule {}
Module({ imports: [TraceletModule.forRoot({ enabled: true, serviceName: 'pack-esm', storage: { uri: process.env.TRACELET_STORAGE_URI, database: 'tracelet_pack_test', serverSelectionTimeoutMS: 1000 } })] })(AppModule);
async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, instrument: TraceletInstrument });
  app.enableShutdownHooks();
  Tracelet.setup(app, { authorize: (req) => req.headers['x-pack-test'] === 'yes' });
  await app.listen(0, '127.0.0.1');
  const result = await trace('pack.job', async () => 'done', { kind: 'custom' });
  process.send({ event: 'ready', port: app.getHttpServer().address().port, exports: Object.keys(ns).filter((k) => k !== 'default').sort(), named: [typeof createTraceletInstrument, typeof currentTraceId], version, result });
  process.on('message', (m) => { if (m === 'shutdown') app.close().then(() => process.exit(0)); });
}
main().catch((e) => { console.error(e); process.exit(1); });
`;

beforeAll(() => {
  mkdirSync(packDir, { recursive: true });
  const r = npm(['pack', '--json', '--pack-destination', packDir], PKG);
  if (r.status !== 0) throw new Error(`npm pack failed:\n${r.out}`);
  const jsonStart = r.stdout.lastIndexOf('\n[\n') + 1;
  packJson = JSON.parse(r.stdout.slice(jsonStart).trim())[0];
  tarball = join(packDir, packJson.filename);
}, 240_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('T19 npm pack tarball content', () => {
  it('has the shipped files and none of the forbidden ones; reports the listing', () => {
    const paths = packJson.files.map(f => f.path);
    console.log(`[pack] ${packJson.filename}: ${paths.length} files, tarball ${packJson.size} bytes, unpacked ${packJson.unpackedSize} bytes`);
    expect(paths).toEqual(expect.arrayContaining(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'assets/dashboard/index.html', 'assets/dashboard/asset-manifest.json', 'third_party/nestjs-observe/LICENSE']));
    expect(paths.some(p => p === 'README.md')).toBe(true);
    expect(paths.filter(p => /\.map$/.test(p))).toEqual([]);
    expect(paths.filter(p => /^(ui|tests|bench|examples|src|docs|artifacts)\//.test(p))).toEqual([]);
    expect(paths.filter(p => /(fixture|demo|\.env|\.npmrc|id_rsa|\.pem|secret)/i.test(p))).toEqual([]);
    expect(paths.filter(p => p.endsWith('.gitattributes'))).toEqual([]);
    expect(paths.filter(p => /\.(ts|mts)$/.test(p) && !/\.d\.ts$/.test(p))).toEqual([]);
    // every non-dist file is one of the declared groups
    expect(paths.filter(p => !/^(dist|assets\/dashboard|third_party)\//.test(p)).sort()).toEqual(['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json']);
    expect(packJson.unpackedSize).toBeLessThan(2 * 1024 * 1024);
  });

  it('the MIT licence file names the placeholder copyright holder', () => {
    const text = readFileSync(join(PKG, 'LICENSE'), 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2026 Tracelet contributors');
  });
});

for (const flavour of ['cjs', 'esm'] as const) {
  describe(`T19 installed tarball boots in a temp ${flavour.toUpperCase()} Nest app`, () => {
    const appDir = join(root, flavour);
    let child: ReturnType<typeof fork> | undefined;

    afterAll(() => {
      child?.kill();
    });

    it('installs the tarball, serves /observe/ and /observe/api/v1/health from the installed package', async () => {
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({
          name: `tracelet-pack-${flavour}`,
          version: '0.0.0',
          private: true,
          ...(flavour === 'esm' ? { type: 'module' } : {}),
          dependencies: { '@nestjs/common': NEST, '@nestjs/core': NEST, '@nestjs/platform-express': NEST, 'reflect-metadata': '^0.2.2', rxjs: '^7.8.1', tracelet: `file:${tarball.replace(/\\/g, '/')}` },
        }),
      );
      writeFileSync(join(appDir, flavour === 'esm' ? 'main.mjs' : 'main.cjs'), flavour === 'esm' ? ESM_MAIN : CJS_MAIN);
      const install = npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--install-links=false'], appDir);
      expect(install.status, install.out).toBe(0);

      const installed = join(appDir, 'node_modules', 'tracelet');
      // a real copy from the tarball (not a link to the workspace)
      expect(existsSync(join(installed, 'package.json'))).toBe(true);
      const files = walk(installed).map(f => relative(installed, f).replace(/\\/g, '/'));
      expect(files.filter(f => f.startsWith('node_modules/'))).toEqual([]);
      expect(files.filter(f => /\.map$/.test(f))).toEqual([]);
      expect(files).toEqual(expect.arrayContaining(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'assets/dashboard/index.html', 'dist/index.js']));
      const total = walk(installed).reduce((n, f) => n + statSync(f).size, 0);
      console.log(`[pack:${flavour}] installed package: ${files.length} files, ${total} bytes`);
      // fixtures / secrets never ship in the dashboard bundle
      for (const f of files.filter(f => f.startsWith('assets/dashboard/') && /\.(js|css|html|json)$/.test(f))) {
        const text = readFileSync(join(installed, f), 'utf8');
        expect(text).not.toMatch(/0199aabb-ccd1|0199f0e0-0000/);
      }
      for (const f of files.filter(f => /\.(js|json|md)$/.test(f))) {
        const text = readFileSync(join(installed, f), 'utf8');
        expect(text, f).not.toMatch(/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}/);
      }

      const main = join(appDir, flavour === 'esm' ? 'main.mjs' : 'main.cjs');
      child = fork(main, [], { cwd: appDir, env: { ...process.env, NODE_ENV: 'production', TRACELET_STORAGE_URI: process.env.TRACELET_E2E_MONGO_URI ?? 'mongodb://127.0.0.1:1/x', NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let err = '';
      child.stderr?.on('data', d => (err += String(d)));
      const ready = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ready message; stderr: ${err}`)), 60_000);
        child!.once('message', m => {
          clearTimeout(timer);
          resolve(m);
        });
        child!.once('exit', code => reject(new Error(`child exited ${code}; stderr: ${err}`)));
      });
      expect(ready.version).toBe('0.1.0');
      expect(ready.result).toBe('done');
      const expectedExports = ['Tracelet', 'TraceletInstrument', 'TraceletModule', 'createTraceletInstrument', 'currentTraceId', 'trace', 'version'];
      expect(ready.exports.filter((k: string) => k !== '__esModule' && k !== 'default' && k !== 'module.exports')).toEqual(expectedExports);
      if (flavour === 'esm') expect(ready.named).toEqual(['function', 'function']);

      const port = ready.port as number;
      // production defaults + authorize hook: no header -> 403 everywhere, header -> allowed
      expect((await httpRequest({ port, path: '/observe/' })).status).toBe(403);
      expect((await httpRequest({ port, path: '/observe/api/v1/health' })).status).toBe(403);
      const headers = { 'x-pack-test': 'yes' };
      const page = await httpRequest({ port, path: '/observe/', headers });
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text).toContain('id="tracelet-config"');
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      // every asset the manifest lists is served from the INSTALLED package with the manifest's bytes
      const manifest = JSON.parse(readFileSync(join(installed, 'assets', 'dashboard', 'asset-manifest.json'), 'utf8')) as { files: Record<string, { size: number }> };
      const assetNames = Object.keys(manifest.files).filter(n => n !== 'index.html');
      expect(assetNames.length).toBeGreaterThanOrEqual(2);
      for (const name of assetNames) {
        const r = await httpRequest({ port, path: `/observe/${name}`, headers });
        expect(r.status, name).toBe(200);
        expect(r.body.length, name).toBe(manifest.files[name].size);
      }
      const health = await httpRequest({ port, path: '/observe/api/v1/health', headers });
      if (process.env.TRACELET_E2E_MONGO_URI) {
        expect(health.status).toBe(200);
        expect(JSON.parse(health.text).servedBy.serviceName).toBe(`pack-${flavour}`);
      } else {
        // no Mongo in this run: the API answers the documented envelope instead of failing the host
        expect([200, 503]).toContain(health.status);
        if (health.status === 503) expect(JSON.parse(health.text).error.code).toBe('STORAGE_UNAVAILABLE');
      }
      expect((await httpRequest({ port, path: '/observe/missing.js', headers })).status).toBe(404);

      // graceful shutdown over IPC exits cleanly
      const exited = new Promise<number | null>(resolve => child!.once('exit', c => resolve(c)));
      child.send('shutdown');
      expect(await exited).toBe(0);
    }, 420_000);
  });
}
