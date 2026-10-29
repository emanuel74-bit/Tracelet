import { describe, expect, it } from 'vitest';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';

describe('TimerLeakTracker (negative control for the leak assertions)', () => {
  it('sees an unref-ed live timer and forgets it once cleared', async () => {
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const t = setTimeout(() => undefined, 1_000_000);
      t.unref();
      expect((await tracker.leakedSince(before)).length).toBe(1);
      clearTimeout(t);
      expect(await tracker.leakedSince(before)).toEqual([]);
      const i = setInterval(() => undefined, 1_000_000);
      i.unref();
      expect((await tracker.leakedSince(before)).length).toBe(1);
      clearInterval(i);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });
});
