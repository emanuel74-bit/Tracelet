import { Inject, Injectable, Module } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { burn, createAppFor, sleep } from '../../support/instrumentation/orders-app.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';

@Injectable()
class Child {
  async wait(ms: number): Promise<void> {
    await sleep(ms);
  }
}

@Injectable()
class Parent {
  constructor(@Inject(Child) private readonly child: Child) {}
  async run(): Promise<void> {
    burn(5); // 5 ms of synchronous work owned by the parent
    await Promise.all([this.child.wait(20), this.child.wait(20)]); // two overlapping siblings
  }
}

@Module({ providers: [Child, Parent] })
class OverlapModule {}

describe('T04 Promise.all siblings and self time (union, not double subtraction)', () => {
  let h: Harness;
  beforeEach(() => {
    h = startHarness();
  });
  afterEach(() => h.stop());

  it('both siblings sit under the parent, overlap, and the parent self time is the union remainder', async () => {
    const app = await createAppFor(OverlapModule);
    await trace('overlap.root', () => app.get(Parent).run(), { kind: 'custom' });
    const [item] = await h.settle();
    const parent = item.spans.find((s) => s.operation === 'Parent.run')!;
    const kids = item.spans.filter((s) => s.operation === 'Child.wait');
    expect(kids).toHaveLength(2);
    for (const k of kids) {
      expect(k.parentSpanId).toBe(parent.spanId);
      expect(k.selfDurationMs).toBeGreaterThanOrEqual(0);
    }
    // overlap: the second starts before the first ends
    const [a, b] = kids.sort((x, y) => x.startOffsetMs - y.startOffsetMs);
    expect(b.startOffsetMs).toBeLessThan(a.startOffsetMs + a.durationMs);

    expect(parent.selfDurationMs).toBeGreaterThanOrEqual(0);
    // Double subtraction would give about 27 - 40 -> 0; the union remainder is the 5 ms of sync work (+ scheduling slack).
    expect(parent.selfDurationMs).toBeGreaterThanOrEqual(3);
    expect(parent.selfDurationMs).toBeLessThanOrEqual(12);
    expect(parent.durationMs).toBeGreaterThanOrEqual(20);
    await app.close();
  });
});
