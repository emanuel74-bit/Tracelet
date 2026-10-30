// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md

import type { CompleteTraceEventNode, OngoingTraceEventNode } from '../../context/vendor/trace-events.interfaces.js';

type Node = CompleteTraceEventNode | OngoingTraceEventNode;

/**
 * Tag under which a collapsed node records how many calls it stands for. On a node that carries it, `duration` is the *sum*
 * of the replaced calls' durations, `startOffset` and `spanId` are the earliest call's, `selfDuration` is the sum of the
 * members' self times (Tracelet addition) and `children` holds every child the replaced calls had.
 */
export const SPAN_COLLAPSED_TAG = 'observe.collapsed';

/** Resolved span-collapse settings (option type declared locally; upstream imported it from observe-options.interface). */
export interface SpanCollapseSettings {
  /** Siblings sharing a frame that may stand before the surplus collapses. */
  threshold: number;
  /** Slowest instances kept whole once a group collapses. */
  keepSlowest: number;
}

export const DEFAULT_SPAN_COLLAPSE: SpanCollapseSettings = {
  threshold: 20,
  keepSlowest: 3,
};

/**
 * Turns the user-facing option into settings, or `undefined` when collapsing is switched off (`false`). Unusable values fall
 * back to the default for that field rather than disabling the feature.
 */
export function resolveSpanCollapseSettings(
  option: { threshold?: number; keepSlowest?: number } | false | undefined,
): SpanCollapseSettings | undefined {
  if (option === false) {
    return undefined;
  }
  return {
    threshold: toInteger(option?.threshold, 1, DEFAULT_SPAN_COLLAPSE.threshold),
    keepSlowest: toInteger(option?.keepSlowest, 0, DEFAULT_SPAN_COLLAPSE.keepSlowest),
  };
}

function toInteger(value: unknown, min: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Collapses repeated siblings throughout a completed span tree, in place. Within one list of siblings, auto spans are grouped
 * by `className` and `methodKey`. A group larger than `threshold` keeps its `keepSlowest` longest-running members and every
 * member that errored as ordinary spans; the rest are replaced by one node that records how many calls it stands for.
 * Manual and root spans are never collapsed. Returns the new sibling list for the level passed in.
 */
export function collapseRepeatedSpans(siblings: Node[], settings: SpanCollapseSettings): Node[] {
  const collapsed = collapseSiblings(siblings, settings);
  for (const node of collapsed) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      const children = collapseRepeatedSpans(node.children, settings);
      if (children.length > 0) {
        node.children = children as never;
      } else {
        delete (node as Partial<CompleteTraceEventNode>).children;
      }
    }
  }
  return collapsed;
}

function collapseSiblings(siblings: Node[], settings: SpanCollapseSettings): Node[] {
  if (siblings.length <= settings.threshold) {
    return siblings;
  }

  const groups = new Map<string, CompleteTraceEventNode[]>();
  for (const node of siblings) {
    if (!isCollapsible(node)) {
      continue;
    }
    // A separator no identifier contains, so `A.b` + `c` and `A` + `b.c` cannot share a key.
    const key = `${node.className}\0${node.methodKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(node);
    } else {
      groups.set(key, [node]);
    }
  }

  // Which node each collapsed call is replaced by: the earliest call maps to the collapsed node, the others to nothing.
  const replacements = new Map<CompleteTraceEventNode, CompleteTraceEventNode>();
  const removed = new Set<CompleteTraceEventNode>();

  for (const group of groups.values()) {
    if (group.length <= settings.threshold) {
      continue;
    }

    const candidates = group.filter((node) => !node.error).sort((a, b) => b.duration - a.duration);
    const surplus = candidates.slice(settings.keepSlowest);
    // A node standing for a single call would be a relabelled span, not an aggregate.
    if (surplus.length < 2) {
      continue;
    }

    const earliest = surplus.reduce((first, node) => (compareStart(node, first, siblings) < 0 ? node : first));
    replacements.set(earliest, toCollapsedNode(surplus, earliest));
    for (const node of surplus) {
      if (node !== earliest) {
        removed.add(node);
      }
    }
  }

  if (replacements.size === 0) {
    return siblings;
  }

  const result: Node[] = [];
  for (const node of siblings) {
    if (removed.has(node as CompleteTraceEventNode)) {
      continue;
    }
    result.push(replacements.get(node as CompleteTraceEventNode) ?? node);
  }
  return result;
}

/** Earlier of two calls: `startOffset` decides; nodes with no offset fall back to their position in the sibling list. */
function compareStart(a: CompleteTraceEventNode, b: CompleteTraceEventNode, siblings: Node[]): number {
  if (typeof a.startOffset === 'number' && typeof b.startOffset === 'number') {
    return a.startOffset - b.startOffset;
  }
  return siblings.indexOf(a) - siblings.indexOf(b);
}

function toCollapsedNode(surplus: CompleteTraceEventNode[], earliest: CompleteTraceEventNode): CompleteTraceEventNode {
  let duration = 0;
  let selfSum = 0;
  let selfComputable = true;
  let startOffset: number | undefined;
  const children: CompleteTraceEventNode[] = [];
  for (const node of surplus) {
    duration += node.duration;
    if (typeof node.selfDuration === 'number') {
      selfSum += node.selfDuration;
    } else {
      selfComputable = false;
    }
    if (typeof node.startOffset === 'number' && (startOffset === undefined || node.startOffset < startOffset)) {
      startOffset = node.startOffset;
    }
    if (Array.isArray(node.children)) {
      children.push(...node.children);
    }
  }

  const collapsed: CompleteTraceEventNode = {
    origin: 'auto',
    className: earliest.className,
    methodKey: earliest.methodKey,
    // Reads as an aggregate in a waterfall rather than as one more call.
    name: `${earliest.className}.${earliest.methodKey} ×${surplus.length}`,
    tags: { [SPAN_COLLAPSED_TAG]: surplus.length },
    duration,
    children,
  };
  if (selfComputable) {
    collapsed.selfDuration = selfSum;
  }
  if (startOffset !== undefined) {
    collapsed.startOffset = startOffset;
  }
  if (earliest.spanId !== undefined) {
    collapsed.spanId = earliest.spanId;
  }
  if (children.length === 0) {
    delete (collapsed as Partial<CompleteTraceEventNode>).children;
  }
  return collapsed;
}

/** Only completed auto spans collapse. `type` is what marks a node as still ongoing. */
function isCollapsible(node: Node): node is CompleteTraceEventNode {
  return (
    !('type' in node) &&
    node.origin === 'auto' &&
    typeof node.className === 'string' &&
    typeof node.methodKey === 'string' &&
    typeof node.duration === 'number'
  );
}
