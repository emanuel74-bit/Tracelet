import type { CompleteTraceEventNode, OngoingTraceEventNode } from '../context/vendor/trace-events.interfaces.js';

type Node = CompleteTraceEventNode | OngoingTraceEventNode;

/**
 * Exclusive (self) time, contract invariant 6: `durationMs` minus the UNION of the child intervals clipped to the parent,
 * floored at 0 (overlapping siblings from Promise.all are not double-subtracted). Sets `selfDuration` on every completed
 * node, in place, on the FULL tree (before collapse). Omitted (property deleted) when not computable: a child without an
 * offset, a child left out as unfinished (`leftOutChildren`), or an unfinished node.
 */
export function computeSelfTimes(root: Node): void {
  // Iterative post-order: trees can be 5000 spans deep.
  const stack: Array<{ node: Node; visited: boolean }> = [{ node: root, visited: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    if (!frame.visited) {
      stack.push({ node, visited: true });
      for (const child of node.children ?? []) {
        stack.push({ node: child, visited: false });
      }
      continue;
    }
    const self = selfOf(node);
    if (self === undefined) {
      delete node.selfDuration;
    } else {
      node.selfDuration = self;
    }
  }
}

function selfOf(node: Node): number | undefined {
  if ('type' in node && node.type === 'start') {
    return undefined; // unfinished node: no duration
  }
  const parent = node as CompleteTraceEventNode;
  if (typeof parent.duration !== 'number') {
    return undefined;
  }
  if ((node.leftOutChildren ?? 0) > 0) {
    return undefined;
  }
  const children = node.children ?? [];
  if (children.length === 0) {
    return parent.duration;
  }
  if (typeof parent.startOffset !== 'number') {
    return undefined;
  }
  const lo = parent.startOffset;
  const hi = parent.startOffset + parent.duration;
  const intervals: Array<[number, number]> = [];
  for (const child of children as CompleteTraceEventNode[]) {
    if (typeof child.startOffset !== 'number' || typeof child.duration !== 'number') {
      return undefined;
    }
    const start = Math.max(child.startOffset, lo);
    const end = Math.min(child.startOffset + child.duration, hi);
    if (end > start) {
      intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let union = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const [s, e] of intervals) {
    if (!open) {
      curStart = s;
      curEnd = e;
      open = true;
    } else if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      union += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (open) union += curEnd - curStart;
  return Math.max(0, parent.duration - union);
}
