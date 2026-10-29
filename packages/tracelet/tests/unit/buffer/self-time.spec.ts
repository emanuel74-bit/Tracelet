import { describe, expect, it } from 'vitest';
import { computeSelfTimes } from '../../../src/buffer/index.js';
import type { CompleteTraceEventNode } from '../../../src/context/vendor/trace-events.interfaces.js';

const node = (
  startOffset: number | undefined,
  duration: number,
  children?: CompleteTraceEventNode[],
  extra: Partial<CompleteTraceEventNode> = {},
): CompleteTraceEventNode => {
  const n: CompleteTraceEventNode = { origin: 'auto', className: 'C', methodKey: 'm', duration, ...extra };
  if (startOffset !== undefined) n.startOffset = startOffset;
  if (children) n.children = children;
  return n;
};

describe('computeSelfTimes (union of child intervals, invariant 6)', () => {
  it('a leaf has self = duration', () => {
    const leaf = node(0, 7);
    computeSelfTimes(leaf);
    expect(leaf.selfDuration).toBe(7);
  });

  it('two overlapping siblings are subtracted once (union), not twice', () => {
    const root = node(0, 30, [node(5, 20), node(5, 20)]);
    computeSelfTimes(root);
    expect(root.selfDuration).toBeCloseTo(10, 9); // 30 - union([5,25]) = 10
  });

  it('partially overlapping and disjoint siblings', () => {
    const root = node(0, 100, [node(10, 20), node(20, 20), node(60, 10)]); // union = [10,40] + [60,70] = 40
    computeSelfTimes(root);
    expect(root.selfDuration).toBeCloseTo(60, 9);
  });

  it('children are clipped to the parent interval and self is floored at 0', () => {
    const clipped = node(10, 10, [node(5, 30)]); // child [5,35] clipped to [10,20] = 10 -> self 0
    computeSelfTimes(clipped);
    expect(clipped.selfDuration).toBe(0);
    const over = node(0, 5, [node(0, 4), node(0, 4)]);
    computeSelfTimes(over);
    expect(over.selfDuration).toBeCloseTo(1, 9);
  });

  it('nested trees: every level is computed from its own children', () => {
    const grandChild = node(4, 2);
    const child = node(2, 10, [grandChild]);
    const root = node(0, 20, [child]);
    computeSelfTimes(root);
    expect(grandChild.selfDuration).toBe(2);
    expect(child.selfDuration).toBe(8);
    expect(root.selfDuration).toBe(10);
  });

  it('is omitted when a child has no offset', () => {
    const root = node(0, 10, [node(undefined, 3)]);
    computeSelfTimes(root);
    expect(root.selfDuration).toBeUndefined();
    expect('selfDuration' in root).toBe(false);
  });

  it('is omitted when a child was left out as unfinished', () => {
    const root = node(0, 10, [node(1, 3)], { leftOutChildren: 1 });
    computeSelfTimes(root);
    expect(root.selfDuration).toBeUndefined();
  });

  it('is omitted when the parent itself has no offset but has children', () => {
    const root = node(undefined, 10, [node(1, 3)]);
    computeSelfTimes(root);
    expect(root.selfDuration).toBeUndefined();
  });

  it('handles a 5000-deep chain without recursion limits', () => {
    let deepest = node(0, 1);
    for (let i = 0; i < 5000; i++) deepest = node(0, 2 + i, [deepest]);
    computeSelfTimes(deepest);
    expect(deepest.selfDuration).toBe(1);
  });
});
