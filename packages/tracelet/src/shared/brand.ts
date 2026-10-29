/** Marker on every Tracelet class registered with Nest DI; the instrument never proxies such instances. */
export const TRACELET_INTERNAL: unique symbol = Symbol.for('tracelet.internal') as never;

export function markInternal<T extends object>(ctor: T): T {
  try {
    Object.defineProperty(ctor, TRACELET_INTERNAL, { value: true, configurable: true });
  } catch {
    // ignore
  }
  return ctor;
}

/** Never throws; a hostile instance (throwing getter or proxy trap) answers false. */
export function isTraceletInternal(x: unknown): boolean {
  try {
    if (x === null || (typeof x !== 'object' && typeof x !== 'function')) return false;
    const ctor = (x as { constructor?: unknown }).constructor as Record<symbol, unknown> | undefined;
    return (
      (ctor !== undefined && ctor !== null && ctor[TRACELET_INTERNAL] === true) ||
      (x as Record<symbol, unknown>)[TRACELET_INTERNAL] === true
    );
  } catch {
    return false;
  }
}
