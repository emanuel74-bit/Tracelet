/**
 * The token every root store carries (plan 6.2). The same object lives in the store and, for sampled roots, in the registry,
 * so `forceClose`/`closeAllOpenRoots` flipping `open` is visible to every store copy.
 */
export interface RootToken {
  /** false as soon as the root settles or is force-closed (flipped synchronously, before deferred completion). */
  open: boolean;
  sampled: boolean;
  /** Registry key of a sampled root. */
  key?: string;
  /** performance.now() + maxTraceDurationMs. Checked at join time for unsampled roots. */
  deadline: number;
  /** Guard so the rollup hook runs exactly once per root (settle or force-close, whichever comes first). */
  recorded: boolean;
}

/** JOIN-IF-OPEN (R2): join only an open token whose sampled trace the registry still holds, or an unsampled one before its deadline. */
export function isJoinable(
  token: RootToken | undefined,
  registry: { has(key: string): boolean },
  now: number = performance.now(),
): token is RootToken {
  if (!token || token.open !== true) return false;
  if (token.sampled) {
    return token.key !== undefined && registry.has(token.key);
  }
  return now < token.deadline;
}
