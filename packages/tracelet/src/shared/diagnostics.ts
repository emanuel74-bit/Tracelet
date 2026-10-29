import { Logger } from '@nestjs/common';
import { runOutsideTrace } from './als';

export interface Diagnostics {
  /** At most one line per key per 60 s. Never throws; always runs outside any trace. */
  warn(key: string, message: string): void;
  error(key: string, message: string): void;
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 256;

export type DiagnosticsSink = (level: 'warn' | 'error', scope: string, message: string) => void;

const defaultSink: DiagnosticsSink = (level, scope, message) => {
  // Static Logger use only: no host provider is injected here.
  if (level === 'warn') Logger.warn(message, scope);
  else Logger.error(message, undefined, scope);
};

export function createDiagnostics(
  scope: string,
  sink: DiagnosticsSink = defaultSink,
  now: () => number = Date.now,
): Diagnostics {
  const last = new Map<string, number>();
  const emit = (level: 'warn' | 'error', key: string, message: string): void => {
    try {
      const t = now();
      const prev = last.get(level + key);
      if (prev !== undefined && t - prev < WINDOW_MS) return;
      if (last.size >= MAX_KEYS) last.clear();
      last.set(level + key, t);
      runOutsideTrace(() => sink(level, scope, message));
    } catch {
      // diagnostics must never become a failure
    }
  };
  return { warn: (k, m) => emit('warn', k, m), error: (k, m) => emit('error', k, m) };
}
