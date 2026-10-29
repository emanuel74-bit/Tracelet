import { AsyncLocalStorage } from 'node:async_hooks';
import { TRACELET_VERSION } from '../version';

/**
 * Internal runtime ABI. Bump whenever the shape or behaviour of anything stored in the global slot changes
 * (runtime, registry, token, store keys), independently of the public contract version (plan 3.4, L-b).
 */
export const TRACELET_RUNTIME_ABI = 2; // 2: the runtime in the slot gained `idleWaiters` (Mission 03). Bump on ANY slot-shape change.

export type TraceletStore = Map<string, unknown>;

export interface TraceletGlobalSlot {
  abi: number;
  packageVersion: string;
  als: AsyncLocalStorage<TraceletStore>;
  runtime?: unknown;
  bootId?: string;
}

const SLOT_KEY = Symbol.for('tracelet.runtime');

let compatible = true;

function initSlot(): TraceletGlobalSlot {
  const g = globalThis as unknown as Record<symbol, TraceletGlobalSlot | undefined>;
  const existing = g[SLOT_KEY];
  if (existing === undefined) {
    const created: TraceletGlobalSlot = {
      abi: TRACELET_RUNTIME_ABI,
      packageVersion: TRACELET_VERSION,
      als: new AsyncLocalStorage(),
    };
    g[SLOT_KEY] = created;
    return created;
  }
  if (existing.abi === TRACELET_RUNTIME_ABI && existing.als instanceof AsyncLocalStorage) {
    return existing;
  }
  // Different ABI: do not share. This copy gets a private slot and becomes a pass-through (trace() and the instrument
  // check isRuntimeCompatible()). Logged once, directly via process warning, because diagnostics depend on this module.
  compatible = false;
  try {
    process.emitWarning(
      `[tracelet] runtime ABI mismatch (this copy abi=${TRACELET_RUNTIME_ABI} v${TRACELET_VERSION}; ` +
        `existing abi=${String(existing.abi)} v${String(existing.packageVersion)}). This copy is a pass-through.`,
    );
  } catch {
    // never throw at import time
  }
  return { abi: TRACELET_RUNTIME_ABI, packageVersion: TRACELET_VERSION, als: new AsyncLocalStorage() };
}

const slot: TraceletGlobalSlot = initSlot();

/** The process-wide slot on globalThis[Symbol.for('tracelet.runtime')] (shared by compatible package copies). */
export function getGlobalSlot(): TraceletGlobalSlot {
  return slot;
}

/** false when another copy with a different ABI owns the global slot; trace() and the instrument must then do nothing. */
export function isRuntimeCompatible(): boolean {
  return compatible;
}

/** The one AsyncLocalStorage. */
export const traceletAls: AsyncLocalStorage<TraceletStore> = slot.als;

/** Runs fn with no Tracelet store (timers, promises and sockets created inside inherit an empty context). */
export function runOutsideTrace<T>(fn: () => T): T {
  return traceletAls.exit(fn);
}
