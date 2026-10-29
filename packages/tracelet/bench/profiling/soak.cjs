/* eslint-disable */
// Reproducible natural-GC soak (CR-001 / results section 13.4). Build first:  npx tsc -p tsconfig.build.json  (emits dist/).
// Run (two processes, optionally concurrently):
//   node --expose-gc bench/profiling/soak.cjs keepalive 5 ../../artifacts/02_soak_keepalive.json
//   node --expose-gc bench/profiling/soak.cjs plain 5 ../../artifacts/02_soak_plain.json
// TRACELET_DIST overrides the dist directory. Not part of any vitest include pattern.
// Natural-GC soak: node --expose-gc soak.js <keepalive|plain> <minutes> <out.json>
// NO global.gc() during the run; one forced full GC only AFTER the run to compare retained memory.
const path = require('node:path');
const fs = require('node:fs');
const dist = process.env.TRACELET_DIST || path.join(__dirname, '..', '..', 'dist');
const { ContinuousProfiler } = require(path.join(dist, 'profiling', 'index.js'));
const { BoundedTelemetryQueue } = require(path.join(dist, 'buffer', 'index.js'));

const mode = process.argv[2];
const minutes = Number(process.argv[3] || 5);
const out = process.argv[4];
const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 4 });
const profiler = new ContinuousProfiler(
  { enabled: true, sampleRateHz: 99, windowMs: 1000, maxStallMs: 1e9 },
  { queue, serviceName: 'soak', instanceId: 'soak-' + mode, ...(mode === 'plain' ? { createKeepAlive: null } : {}) },
);

// realistic churn: a rolling retained set (~100 MB) replaced continuously, short-lived garbage, and compiled-code churn
const ring = new Array(150000).fill(null);
let ri = 0;
let fnCount = 0;
const fnKeep = [];
function churn() {
  for (let i = 0; i < 3000; i++) {
    ring[ri] = { id: ri, name: 'item-' + ri + '-' + Math.random(), payload: new Array(8).fill(ri), text: 'x'.repeat(64) };
    ri = (ri + 1) % ring.length;
  }
  const tmp = [];
  for (let i = 0; i < 2000; i++) tmp.push({ a: i, b: String(i) });
  for (let i = 0; i < 20; i++) {
    const f = new Function('x', 'return x * ' + fnCount++ + ' + 1;');
    f(1);
    if (fnKeep.length < 2000) fnKeep.push(f);
    else fnKeep[fnCount % 2000] = f;
  }
  let acc = 0;
  for (let i = 0; i < 20000; i++) acc += (i * 31) % 7;
  return acc + tmp.length;
}

const mb = (n) => Math.round((n / 1048576) * 10) / 10;
const samples = [];
const t0 = Date.now();
function snap() {
  const m = process.memoryUsage();
  samples.push({ tSec: Math.round((Date.now() - t0) / 1000), rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) });
}

(async () => {
  await profiler.start();
  const end = t0 + minutes * 60_000;
  let nextSnap = t0 + 10_000;
  while (Date.now() < end) {
    churn();
    if (Date.now() >= nextSnap) {
      snap();
      nextSnap += 10_000;
    }
    await new Promise((r) => setImmediate(r));
    if (Math.random() < 0.02) await new Promise((r) => setTimeout(r, 2));
  }
  snap();
  const dbg = profiler.debug();
  const stalls = dbg.windows.filter((w) => !w.final);
  await profiler.stop();
  const before = process.memoryUsage();
  global.gc();
  global.gc();
  const after = process.memoryUsage();
  const avg = (xs, k) => Math.round((xs.reduce((a, s) => a + s[k], 0) / Math.max(1, xs.length)) * 10) / 10;
  const first = samples.filter((s) => s.tSec >= 30 && s.tSec <= 90);
  const last = samples.filter((s) => s.tSec >= minutes * 60 - 90);
  const pct = (v, p) => { const a = v.slice().sort((x, y) => x - y); return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 100) / 100 : 0; };
  const result = {
    mode, node: process.version, minutes, keepAlive: dbg.keepAlive, keepAliveOffReason: dbg.keepAliveOffReason,
    rotations: stalls.length, backoffs: dbg.counters.backoffs, errors: dbg.counters.errors,
    startStallMs: { p50: pct(stalls.map((w) => w.startStallMs), 0.5), max: pct(stalls.map((w) => w.startStallMs), 1) },
    stopStallMs: { p50: pct(stalls.map((w) => w.stopStallMs), 0.5), max: pct(stalls.map((w) => w.stopStallMs), 1) },
    trend: {
      rss: { min30to90s: avg(first, 'rss'), last90s: avg(last, 'rss') },
      heapUsed: { min30to90s: avg(first, 'heapUsed'), last90s: avg(last, 'heapUsed') },
      heapTotal: { min30to90s: avg(first, 'heapTotal'), last90s: avg(last, 'heapTotal') },
      external: { min30to90s: avg(first, 'external'), last90s: avg(last, 'external') },
    },
    finalBeforeGc: { rss: mb(before.rss), heapUsed: mb(before.heapUsed), heapTotal: mb(before.heapTotal) },
    finalAfterFullGc: { rss: mb(after.rss), heapUsed: mb(after.heapUsed), heapTotal: mb(after.heapTotal), nonHeap: mb(after.rss - after.heapTotal) },
    samples,
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: undefined }));
})();
