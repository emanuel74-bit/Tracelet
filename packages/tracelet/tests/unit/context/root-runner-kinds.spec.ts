import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeForTesting,
  currentTraceId,
  resetRuntimeForTesting,
  trace,
  type RootSettledEvent,
} from '../../../src/context/index.js';
import type { ExecutionKind } from '../../../src/contracts/index.js';
import { createDiagnostics } from '../../../src/shared/index.js';

const silent = createDiagnostics('t', () => {});

function setup() {
  const roots: RootSettledEvent[] = [];
  createRuntimeForTesting({ diagnostics: silent, config: { onRootSettled: (e) => roots.push(e) } });
  return roots;
}

/** Runs `inner` synchronously inside an open outer root and reports both trace ids plus the roots settled so far. */
function nested(innerKind: ExecutionKind, options: { forceRoot?: boolean; join?: boolean } = {}) {
  let outerId: string | undefined;
  let innerId: string | undefined;
  const result = trace('outer', () => {
    outerId = currentTraceId();
    return trace('inner', () => { innerId = currentTraceId(); return 'inner-value'; }, { kind: innerKind, ...options });
  });
  return { outerId, innerId, result };
}

describe('trace() root-vs-join policy by kind (R3)', () => {
  afterEach(() => resetRuntimeForTesting());

  it("kind 'rabbitmq' delivered inside an open trace gets its OWN root", () => {
    const roots = setup();
    const { outerId, innerId, result } = nested('rabbitmq');
    expect(result).toBe('inner-value');
    expect(outerId).toBeTypeOf('string');
    expect(innerId).toBeTypeOf('string');
    expect(innerId).not.toBe(outerId);
    expect(roots.map((r) => [r.name, r.kind]).sort()).toEqual([['inner', 'rabbitmq'], ['outer', 'custom']]);
  });

  for (const kind of ['custom', 'event', 'scheduled', 'http'] as const) {
    it(`kind '${kind}' inside an open trace JOINS it (same traceId, no new root)`, () => {
      const roots = setup();
      const { outerId, innerId, result } = nested(kind);
      expect(result).toBe('inner-value');
      expect(innerId).toBeTypeOf('string');
      expect(innerId).toBe(outerId);
      expect(roots.map((r) => r.name)).toEqual(['outer']);
    });
  }

  it("kind 'custom' with forceRoot:true gets its own root", () => {
    const roots = setup();
    const { outerId, innerId, result } = nested('custom', { forceRoot: true });
    expect(result).toBe('inner-value');
    expect(innerId).not.toBe(outerId);
    expect(roots.map((r) => r.name).sort()).toEqual(['inner', 'outer']);
  });

  it("kind 'rabbitmq' with join:true joins; forceRoot:true wins over join", () => {
    let roots = setup();
    const joined = nested('rabbitmq', { join: true });
    expect(joined.innerId).toBe(joined.outerId);
    expect(roots.map((r) => r.name)).toEqual(['outer']);
    resetRuntimeForTesting();
    roots = setup();
    const forced = nested('rabbitmq', { join: true, forceRoot: true });
    expect(forced.innerId).not.toBe(forced.outerId);
    expect(roots).toHaveLength(2);
  });

  it("kind 'rabbitmq' with an explicit forceRoot:false JOINS the open trace", () => {
    const roots = setup();
    const { outerId, innerId, result } = nested('rabbitmq', { forceRoot: false });
    expect(result).toBe('inner-value');
    expect(innerId).toBeTypeOf('string');
    expect(innerId).toBe(outerId);
    expect(roots.map((r) => r.name)).toEqual(['outer']);
  });

  it('inside an UNSAMPLED outer root: a joining kind passes through (no trace id, no extra root) and the value is unchanged', () => {
    const roots = setup();
    // sampleRate 0: every root is an unsampled root (context only, nothing recorded)
    createRuntimeForTesting({ diagnostics: silent, config: { sampleRate: 0, onRootSettled: (e) => roots.push(e) } });
    let outerId: string | undefined = 'unset';
    let innerId: string | undefined = 'unset';
    const result = trace('outer', () => {
      outerId = currentTraceId();
      return trace('inner', () => { innerId = currentTraceId(); return 'inner-value'; }, { kind: 'custom' });
    });
    expect(result).toBe('inner-value');
    expect(outerId).toBeUndefined(); // unsampled roots have no trace id
    expect(innerId).toBeUndefined();
    expect(roots.filter((r) => r.name === 'inner')).toEqual([]); // joined: no root of its own
  });

  it('exceptions thrown by the callback propagate unchanged in every case', () => {
    const cases: Array<[ExecutionKind, { forceRoot?: boolean; join?: boolean }]> = [
      ['rabbitmq', {}], ['custom', {}], ['event', {}], ['scheduled', {}], ['custom', { forceRoot: true }], ['rabbitmq', { join: true }],
    ];
    for (const [kind, options] of cases) {
      setup();
      const boom = new Error(`boom-${kind}`);
      expect(() => trace('outer', () => trace('inner', () => { throw boom; }, { kind, ...options }))).toThrow(boom);
      resetRuntimeForTesting();
    }
  });

  it('async return values and rejections pass through unchanged', async () => {
    setup();
    const boom = new Error('async-boom');
    for (const kind of ['rabbitmq', 'custom'] as const) {
      await expect(trace('outer', () => trace('inner', async () => 42, { kind }))).resolves.toBe(42);
      await expect(trace('outer', () => trace('inner', () => Promise.reject(boom), { kind }))).rejects.toBe(boom);
    }
  });
});
