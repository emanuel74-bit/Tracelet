import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * The real guard for the stack-frame relabel (plan 6.3). Vitest's source-map-aware Error.prepareStackTrace rewrites frame names,
 * so the decorator is compiled with tsc into a temp dir and run in plain node: frames must read `<Class>.<method>`, never `Proxy.`.
 */
describe('compiled decorator in plain node: stack frames read like the call the user made', () => {
  let dir: string;
  let result: { stack: string; nested: string; relabeled: boolean };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracelet-frames-'));
    const root = resolve(process.cwd(), '../..');
    const tsc = resolve(root, 'node_modules/typescript/lib/tsc.js');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', join(dir, 'dist'), '--declaration', 'false', '--sourceMap', 'false'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const script = [
      "require('reflect-metadata');",
      "const { AsyncLocalStorage } = require('node:async_hooks');",
      "const { createInstanceDecorator } = require('./dist/instrumentation/vendor/instance-decorator.js');",
      'const als = new AsyncLocalStorage();',
      "const registry = { internalStartTraceStep: () => 'step', internalEndTraceStep: () => {} };",
      'const decorate = createInstanceDecorator({ als, getRegistry: () => registry, skipInstrumentation: () => false });',
      "class UserService { fail() { throw new Error('boom'); } }",
      'class OrderService { constructor(users) { this.users = users; } fail() { this.users.fail(); } }',
      'const users = decorate(new UserService());',
      'const orders = decorate(new OrderService(users));',
      "const run = (fn) => als.run(new Map([['#tracelet.registryKey', 't']]), () => { try { fn(); } catch (e) { return e.stack; } return ''; });",
      'const stack = run(() => users.fail());',
      'const nested = run(() => orders.fail());',
      "process.stdout.write(JSON.stringify({ stack, nested, relabeled: true }));",
    ].join('\n');
    writeFileSync(join(dir, 'run.cjs'), script);
    const out = execFileSync(process.execPath, [join(dir, 'run.cjs')], {
      cwd: dir,
      env: { ...process.env, NODE_PATH: resolve(root, 'node_modules') },
      encoding: 'utf8',
    });
    result = JSON.parse(out);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the throwing method frame and every decorator frame carry the class name, none says Proxy.', () => {
    const lines = result.stack.split('\n');
    expect(lines[1]).toContain('UserService.fail');
    expect(result.stack).not.toContain('Proxy.');
    const decoratorFrames = lines.filter((l) => /instance-decorator\.js/.test(l));
    expect(decoratorFrames.length).toBeGreaterThan(0);
    for (const frame of decoratorFrames) expect(frame).toContain('UserService.fail');
  });

  it('nested calls: each frame is labelled with its own class, the caller does not inherit the callee name', () => {
    expect(result.nested).not.toContain('Proxy.');
    const failFrames = result.nested.split('\n').filter((l) => /\.fail /.test(l));
    expect(failFrames[0]).toContain('UserService.fail');
    expect(failFrames.some((f) => f.includes('OrderService.fail'))).toBe(true);
  });
});
