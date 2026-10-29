import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Code-heavy fixture (plan 7, R5): a generated CommonJS module with many distinct functions. V8 logs existing code objects
 * when a profile starts, so a tiny script would under-measure startStallMs. Every function is called once at load time so it
 * is compiled (lazy functions are not code objects until first call).
 *
 * Exports: functionCount, touchAll(x), burnCpu(ms) (CPU-bound, calls into the generated functions), allocateChunk(n)
 * (allocation-heavy).
 */
export interface CodeHeavyModule {
  functionCount: number;
  touchAll(seed: number): number;
  burnCpu(ms: number): number;
  /** Fixed amount of CPU work: units x 1000 calls into the generated functions. */
  work(units: number): number;
  allocateChunk(n: number): number;
}

export interface GeneratedCodeHeavy {
  dir: string;
  file: string;
  module: CodeHeavyModule;
}

export function generateCodeHeavySource(count: number): string {
  const lines: string[] = ["'use strict';", 'const fns = [];'];
  for (let i = 0; i < count; i++) {
    // distinct bodies so V8 cannot share one compiled function; each has a unique name and constants
    lines.push(`function generated_fn_${i}(x) { const y = (x * ${(i % 97) + 3} + ${i}) | 0; return y ^ ${(i * 2654435761) % 65521}; }`);
    lines.push(`fns.push(generated_fn_${i});`);
  }
  lines.push(
    'function touchAll(seed) { let a = seed | 0; for (let i = 0; i < fns.length; i++) a = fns[i](a); return a; }',
    'function burnCpu(ms) {',
    '  const end = performance.now() + ms;',
    '  let acc = 1;',
    '  let i = 0;',
    '  while (performance.now() < end) {',
    '    for (let k = 0; k < 2000; k++) acc = fns[(i++ * 7919) % fns.length](acc);',
    '  }',
    '  return acc;',
    '}',
    'function work(units) {',
    '  let acc = 1;',
    '  for (let u = 0; u < units; u++) for (let k = 0; k < 1000; k++) acc = fns[(u * 1009 + k * 7919) % fns.length](acc);',
    '  return acc;',
    '}',
    'function allocateChunk(n) {',
    '  const keep = [];',
    '  for (let i = 0; i < n; i++) keep.push({ id: i, name: "item-" + i, tags: [i, i + 1, i + 2], text: "x".repeat(i % 64) });',
    '  return keep.length;',
    '}',
    'exports.functionCount = fns.length;',
    'exports.touchAll = touchAll;',
    'exports.burnCpu = burnCpu;',
    'exports.work = work;',
    'exports.allocateChunk = allocateChunk;',
    'touchAll(1);',
  );
  return lines.join('\n') + '\n';
}

/** Writes the module to a fresh temp directory under os.tmpdir() and requires it. */
export function generateCodeHeavy(count = 12_000): GeneratedCodeHeavy {
  const root = join(tmpdir(), 'tracelet-code-heavy');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'run-'));
  const file = join(dir, 'code-heavy.cjs');
  writeFileSync(file, generateCodeHeavySource(count), 'utf8');
  const req = createRequire(file);
  const module = req(file) as CodeHeavyModule;
  return { dir, file, module };
}
