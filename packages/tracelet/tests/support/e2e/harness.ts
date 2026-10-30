import { fork, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { httpRequest } from '../http/http.js';

export const PKG = resolve(__dirname, '..', '..', '..');
export const REPO = resolve(PKG, '..', '..');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Builds packages/tracelet/dist (the real `npm run build` compile step). */
export function buildDist(): void {
  const r = run(process.execPath, [join(PKG, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PKG, 'tsconfig.build.json')], PKG);
  if (r.status !== 0) throw new Error(`tsc build failed:\n${r.out}`);
}

/** Compiles the fixture worker (and the example it wraps) into a fresh temp dir; returns the script path and a cleanup. */
export function compileFixture(): { script: string; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'tracelet-e2e-fixture-'));
  const r = run(process.execPath, [TSC, '-p', join(PKG, 'tests', 'support', 'e2e', 'tsconfig.json'), '--outDir', dir], PKG);
  if (r.status !== 0) throw new Error(`fixture compile failed:\n${r.out}`);
  return { script: join(dir, 'tests', 'support', 'e2e', 'worker-fixture.js'), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface WorkerEvent {
  event: 'ready' | 'drained' | 'stopped';
  port?: number;
  instanceId?: string;
  state?: string;
  pid?: number;
  acks?: string[];
  counters?: Record<string, number>;
  queueDepth?: number;
  traceQueueDepth?: number;
  shutdownMs?: number;
}

export interface WorkerProc {
  child: ChildProcess;
  ready: WorkerEvent;
  events: WorkerEvent[];
  waitFor(event: WorkerEvent['event'], timeoutMs?: number): Promise<WorkerEvent>;
  /** Graceful stop over IPC (SIGTERM is a hard kill on Windows). Resolves with the 'stopped' event. */
  shutdown(timeoutMs?: number): Promise<WorkerEvent>;
  kill(): void;
  stderr(): string;
}

export async function startWorkerProc(script: string, env: Record<string, string>): Promise<WorkerProc> {
  const child = fork(script, [], {
    env: { ...process.env, NODE_PATH: join(REPO, 'node_modules'), NODE_ENV: 'test', OBSERVE_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const events: WorkerEvent[] = [];
  const waiters: Array<{ event: string; resolve: (e: WorkerEvent) => void }> = [];
  let err = '';
  child.stderr?.on('data', d => (err += String(d)));
  child.stdout?.on('data', () => undefined);
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.on('message', m => {
    const e = m as WorkerEvent;
    events.push(e);
    for (const w of [...waiters]) if (w.event === e.event) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  const waitFor = (event: WorkerEvent['event'], timeoutMs = 60_000): Promise<WorkerEvent> => {
    const have = events.find(e => e.event === event);
    if (have) return Promise.resolve(have);
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"; stderr: ${err.slice(-800)}`)), timeoutMs);
      void exited.then(() => reject(new Error(`worker exited before "${event}"; stderr: ${err.slice(-800)}`)));
      waiters.push({ event, resolve: e => { clearTimeout(timer); resolveWait(e); } });
    });
  };
  const ready = await waitFor('ready');
  return {
    child,
    ready,
    events,
    waitFor,
    shutdown: async timeoutMs => {
      child.send('shutdown');
      const stopped = await waitFor('stopped', timeoutMs ?? 30_000);
      await Promise.race([exited, sleep(5_000)]);
      return stopped;
    },
    kill: () => void child.kill(),
    stderr: () => err,
  };
}

export async function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const r = await httpRequest({ port, path });
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = r.text;
  }
  return { status: r.status, body };
}

export async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timeout: ${what}${last ? ` (${String(last)})` : ''}`);
    await sleep(250);
  }
}

/** The ack log the business logic must produce: every 5th message (1-based 5, 10, ...) is poisoned and nacked. */
export function expectedAcks(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${i % 5 === 4 ? 'nack' : 'ack'}:m-${i + 1}`);
}
