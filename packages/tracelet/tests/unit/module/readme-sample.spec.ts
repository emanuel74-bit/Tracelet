import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Extracts the TypeScript sample between the README markers. Accepts LF and CRLF checkouts (autocrlf). */
function extractSample(readmeText: string): string | undefined {
  const readme = readmeText.replace(/\r\n?/g, '\n');
  return /<!-- sample:authorize:begin -->\s*```ts\n([\s\S]*?)```\s*<!-- sample:authorize:end -->/.exec(readme)?.[1];
}

/** Executes the authorize() sample so the documented code is the tested code. */
function compileSample(source: string | undefined): (token: string | undefined) => (req: any) => boolean {
  expect(source, 'README sample markers').toBeDefined();
  const js = ts.transpileModule(source!, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod: { exports: any } = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, createRequire(__filename));
  return mod.exports.bearerAuthorize;
}

const readmeText = (): string => readFileSync(resolve(__dirname, '..', '..', '..', 'README.md'), 'utf8');
const loadSample = () => compileSample(extractSample(readmeText()));

const req = (authorization?: string) => ({ method: 'GET', path: '/', headers: authorization === undefined ? {} : { authorization }, remoteAddress: '203.0.113.9', raw: {}, adapter: 'express' });

describe('README sample extraction line endings (L3)', () => {
  it('extracts the same working sample from LF and CRLF versions of the README', () => {
    const lf = readmeText().replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(crlf).toContain('\r\n');
    const fromLf = extractSample(lf);
    expect(fromLf).toContain('bearerAuthorize');
    expect(extractSample(crlf)).toBe(fromLf);
    for (const text of [lf, crlf]) {
      const authorize = compileSample(extractSample(text))('tok');
      expect(authorize(req('Bearer tok'))).toBe(true);
      expect(authorize(req('Bearer nope'))).toBe(false);
    }
  });
});

describe('README authorize sample', () => {
  const bearerAuthorize = loadSample();
  it('denies EVERYTHING when the token env var is unset or empty (undefined === undefined must not allow)', () => {
    for (const unset of [undefined, '']) {
      const authorize = bearerAuthorize(unset);
      expect(authorize(req())).toBe(false);
      expect(authorize(req('Bearer '))).toBe(false);
      expect(authorize(req('Bearer undefined'))).toBe(false);
      expect(authorize(req('Bearer '))).toBe(false);
    }
  });
  it('allows only the exact bearer token', () => {
    const authorize = bearerAuthorize('s3cret-token');
    expect(authorize(req('Bearer s3cret-token'))).toBe(true);
    expect(authorize(req('Bearer s3cret-toke'))).toBe(false);
    expect(authorize(req('Bearer s3cret-token-longer'))).toBe(false);
    expect(authorize(req('s3cret-token'))).toBe(false);
    expect(authorize({ ...req(), headers: { authorization: ['Bearer s3cret-token'] } })).toBe(true);
  });
});
