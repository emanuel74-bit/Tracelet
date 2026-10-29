export interface InspectorProbeResult {
  available: boolean;
  reason?: string;
}

type SessionCtor = new () => { connect(): void; disconnect(): void };

export interface InspectorProbeDeps {
  /** process.config.variables.v8_enable_inspector. */
  v8EnableInspector?: unknown;
  /** Loader of 'node:inspector'; may throw. */
  loadInspector?: () => { Session: SessionCtor };
}

function defaultLoad(): { Session: SessionCtor } {
  const mod = process.getBuiltinModule?.('node:inspector') as { Session: SessionCtor } | undefined;
  if (!mod || typeof mod.Session !== 'function') throw new Error("require('node:inspector') is not available");
  return mod;
}

function describe(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? m.slice(0, 200) : m;
}

/**
 * Is a CPU profile obtainable in this process? Checks the build flag, the module and a throwaway Session.connect(). Never
 * throws. The probe's session is disconnected immediately and creates no profile.
 */
export function probeInspector(deps: InspectorProbeDeps = {}): InspectorProbeResult {
  try {
    const flag =
      'v8EnableInspector' in deps
        ? deps.v8EnableInspector
        : (process.config?.variables as Record<string, unknown> | undefined)?.v8_enable_inspector;
    if (flag === 0 || flag === false || flag === '0') {
      return { available: false, reason: 'this Node.js build has v8_enable_inspector disabled' };
    }
    const inspector = (deps.loadInspector ?? defaultLoad)();
    const session = new inspector.Session();
    try {
      session.connect();
    } catch (err) {
      return { available: false, reason: `inspector Session.connect() failed: ${describe(err)}` };
    }
    try {
      session.disconnect();
    } catch {
      // the probe session is throwaway
    }
    return { available: true };
  } catch (err) {
    return { available: false, reason: `node:inspector unavailable: ${describe(err)}` };
  }
}
