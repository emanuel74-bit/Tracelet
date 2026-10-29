import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAllOpenRoots,
  configureTracing,
  createRuntimeForTesting,
  resetRuntimeForTesting,
  sweepOnce,
  trace,
  type RootSettledEvent,
} from '../../../src/context/index.js';
import { createDiagnostics } from '../../../src/shared/index.js';

const silent = createDiagnostics('t', () => {});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup(extra: Partial<Parameters<typeof createRuntimeForTesting>[0]> = {}) {
  const events: RootSettledEvent[] = [];
  const rt = createRuntimeForTesting({
    diagnostics: silent,
    completionTimeoutMs: 10,
    config: { onRootSettled: (e) => events.push(e), maxTraceDurationMs: 20 },
    ...extra,
  });
  return { rt, events };
}

describe('rollup accounting happens exactly once per root (L5)', () => {
  afterEach(() => resetRuntimeForTesting());

  it('settle only: count 1 (sync, async ok, async error)', async () => {
    const { events } = setup();
    trace('a', () => 1);
    await trace('b', async () => 2);
    await expect(trace('c', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(events.map((e) => [e.name, e.status, e.sampled])).toEqual([
      ['a', 'ok', true],
      ['b', 'ok', true],
      ['c', 'error', true],
    ]);
    for (const e of events) expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('force-close by the sweeper, then late settle: count 1, status incomplete, no second record', async () => {
    const { rt, events } = setup();
    let release!: () => void;
    const p = trace('swept', () => new Promise<void>((r) => (release = r)));
    await sleep(40);
    expect(sweepOnce(rt)).toBe(1);
    release();
    await p;
    await sleep(30);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'swept', status: 'incomplete', sampled: true });
  });

  it('shutdown (closeAllOpenRoots), then late settle: count 1', async () => {
    const { events } = setup();
    let release!: () => void;
    const p = trace('shutdown', () => new Promise<void>((r) => (release = r)));
    expect(closeAllOpenRoots('shutdown')).toBe(1);
    release();
    await p;
    await sleep(30);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('incomplete');
  });

  it('unsampled roots record once, at settle, with sampled=false', async () => {
    const { events } = setup();
    configureTracing({ sampleRate: 0 });
    await trace('unsampled', async () => 1);
    expect(events).toEqual([expect.objectContaining({ name: 'unsampled', sampled: false, status: 'ok' })]);
  });

  it('a throwing rollup hook never reaches the business code', async () => {
    const rt = createRuntimeForTesting({ diagnostics: silent, config: { onRootSettled: vi.fn(() => { throw new Error('hook'); }) } });
    expect(rt.config.enabled).toBe(true);
    expect(trace('x', () => 'v')).toBe('v');
    await expect(trace('y', () => Promise.reject(new Error('r')))).rejects.toThrow('r');
  });
});
