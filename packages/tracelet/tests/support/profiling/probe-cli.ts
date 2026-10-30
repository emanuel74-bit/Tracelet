import { spawn } from 'node:child_process';
import { classifyContention, measureContention } from './contention.js';

/**
 * Dev-only calibration helper: `tsx tests/support/profiling/probe-cli.ts <readings> [busyLoops] [warmupMs]` prints contention readings
 * (JSON lines) while optionally running <busyLoops> busy-loop children that it owns and kills on exit.
 */
async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 1);
  const loops = Number(process.argv[3] ?? 0);
  const kids = Array.from({ length: loops }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  );
  const stop = (): void => kids.forEach((k) => k.kill());
  process.on('exit', stop);
  try {
    await new Promise((r) => setTimeout(r, loops ? 1500 : 0));
    for (let i = 0; i < n; i++) {
      const r = await measureContention();
      console.log(JSON.stringify({ loops, ...r, contended: classifyContention(r).contended }));
    }
  } finally {
    stop();
  }
}
void main();
