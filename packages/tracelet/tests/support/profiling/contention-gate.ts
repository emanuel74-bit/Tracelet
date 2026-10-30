import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyContention, formatReading, measureContention, notRunMessage } from './contention.js';
import type { ContentionReading } from './contention.js';

/**
 * Set TRACELET_FORCE_CONTENDED_RUN=1 to run despite a contended start (flake reproduction only; the run is then not gate evidence).
 * Pre/post-run contention gate for T09/T10. Only the PRE-run reading may convert a test to NOT RUN (skip). A failure after a run that
 * started quiet is always a FAIL; the post reading is attached to the assertion messages as diagnostic text only.
 */
export interface ContentionGate {
  before: ContentionReading;
  /** Measure again after the run; returns the diagnostic prefix used in assertion messages. */
  after(): Promise<{ reading: ContentionReading; diag: (extra: unknown) => string }>;
}

export async function contentionPreflight(
  ctx: { skip: (note?: string) => never },
  label: string,
  outFile: string,
): Promise<ContentionGate> {
  const before = await measureContention();
  const verdict = classifyContention(before);
  const forced = process.env.TRACELET_FORCE_CONTENDED_RUN === '1';
  if (verdict.contended && forced) {
    console.warn(`[${label}] host contended (${formatReading(before)}) but TRACELET_FORCE_CONTENDED_RUN=1: running anyway (diagnostic mode, not gate evidence)`);
  } else if (verdict.contended) {
    const msg = notRunMessage(before);
    console.warn(`[${label}] ${msg} [${verdict.reasons.join('; ')}]`);
    try {
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, JSON.stringify({ status: 'NOT RUN', message: msg, reasons: verdict.reasons, contentionBefore: before }, null, 2));
    } catch {
      // the loud console line above is the primary signal
    }
    ctx.skip(msg);
  }
  console.info(`[${label}] host quiet at start: ${formatReading(before)}`);
  return {
    before,
    async after() {
      const reading = await measureContention(1000);
      const verdictAfter = classifyContention(reading);
      const header =
        `contention before: ${formatReading(before)}; after: ${formatReading(reading)}` +
        (verdictAfter.contended ? ' [host became CONTENDED during/after the run: failure may be host scheduling, still reported as FAIL]' : ' [host quiet after the run]');
      return { reading, diag: (extra: unknown) => `${header}; ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` };
    },
  };
}

/** Per-window numbers for assertion messages. */
export function windowDiagnostics(
  windows: Array<{
    seq: number;
    final: boolean;
    sampleCount: number;
    idleSampleCount: number;
    sampledSpanMs: number;
    gapBeforeMs?: number;
    startStallMs: number;
    stopStallMs: number;
    foldMs: number;
  }>,
): string {
  return windows
    .map(
      (w) =>
        `w${w.seq}${w.final ? '(final)' : ''}{gap=${w.gapBeforeMs === undefined ? '-' : Math.round(w.gapBeforeMs * 10) / 10},span=${Math.round(w.sampledSpanMs)},n=${w.sampleCount},idle=${w.idleSampleCount},stall=${Math.round(w.startStallMs)}/${Math.round(w.stopStallMs)},fold=${Math.round(w.foldMs)}}`,
    )
    .join(' ');
}
