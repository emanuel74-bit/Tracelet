import { resetRuntimeForTesting } from '../../../src/context/index.js';
import type { InstanceHeartbeat, TelemetryItem, TelemetryQueue } from '../../../src/contracts/index.js';
import type { LifecycleDeps } from '../../../src/tracelet.module.js';
import type { Diagnostics } from '../../../src/shared/diagnostics.js';

export interface DiagLine {
  level: 'warn' | 'error';
  key: string;
  message: string;
}

export function recordingDiagnostics(): { diagnostics: Diagnostics; lines: DiagLine[] } {
  const lines: DiagLine[] = [];
  return {
    lines,
    diagnostics: {
      warn: (key, message) => void lines.push({ level: 'warn', key, message }),
      error: (key, message) => void lines.push({ level: 'error', key, message }),
    },
  };
}

export interface FakeStorageLog {
  events: string[];
  created: number;
  queue?: TelemetryQueue;
  heartbeat?: () => InstanceHeartbeat;
  /** Items still queued when stop() was called (queue.drain at that moment). */
  atStop?: TelemetryItem[];
  connected: boolean;
}

/** A createStorage replacement: no Mongo client, no timers. */
export function fakeCreateStorage(log: FakeStorageLog, opts: { stopDelayMs?: number; throwOnCreate?: boolean; collections?: unknown } = {}): NonNullable<LifecycleDeps['createStorage']> {
  return ((_config: unknown, queue: TelemetryQueue, _identity: unknown, heartbeat: () => InstanceHeartbeat) => {
    log.created++;
    if (opts.throwOnCreate) throw new Error('boom mongodb://admin:hunter2@db.internal');
    log.queue = queue;
    log.heartbeat = heartbeat;
    return {
      collections: (opts.collections ?? {}) as never,
      start: () => void log.events.push('storage.start'),
      stop: async () => {
        log.events.push('storage.stop');
        log.atStop = queue.drain(10_000, Number.MAX_SAFE_INTEGER);
        if (opts.stopDelayMs) await new Promise(r => setTimeout(r, opts.stopDelayMs));
        log.events.push('storage.stopped');
      },
      flush: async () => undefined,
      health: () => ({ connected: log.connected }),
    };
  }) as never;
}

export const VALID_OPTIONS = {
  serviceName: 'unit-worker',
  storage: { uri: 'mongodb://127.0.0.1:1/unit' },
  tracing: { sampleRate: 1 },
  runtimeMetrics: { enabled: true, intervalMs: 10_000 },
};

export const TEST_ENV = { NODE_ENV: 'test' } as const;

export function resetTracing(): void {
  resetRuntimeForTesting();
}
