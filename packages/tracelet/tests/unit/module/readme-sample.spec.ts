import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Executes the authorize() sample printed in README.md so the documented code is the tested code. */
function loadSample(): (token: string | undefined) => (req: any) => boolean {
  const readme = readFileSync(resolve(__dirname, '..', '..', '..', 'README.md'), 'utf8');
  const m = /<!-- sample:authorize:begin -->\s*```ts\n([\s\S]*?)```\s*<!-- sample:authorize:end -->/.exec(readme);
  expect(m, 'README sample markers').not.toBeNull();
  const js = ts.transpileModule(m![1], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod: { exports: any } = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, createRequire(__filename));
  return mod.exports.bearerAuthorize;
}

const req = (authorization?: string) => ({ method: 'GET', path: '/', headers: authorization === undefined ? {} : { authorization }, remoteAddress: '203.0.113.9', raw: {}, adapter: 'express' });

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
