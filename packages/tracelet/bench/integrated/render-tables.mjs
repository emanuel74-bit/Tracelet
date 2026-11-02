// Renders markdown tables from artifacts/09_T20_integrated_node<major>.json (written by overhead.int-spec.ts).
// Usage: node bench/integrated/render-tables.mjs ../../artifacts/09_T20_integrated_node22.json
import { readFileSync } from 'node:fs';

const d = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const f = (n, k = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(k) : String(n));
const out = [];
out.push(`### ${d.host.node} on ${d.host.platform} (${d.host.cpu}), status ${d.status}`);
out.push(`Host contention at start: ${JSON.stringify(d.contentionStart)}; at end: ${JSON.stringify(d.contentionEnd)}`);
out.push('');
const KEYS = [
  ['cpuUsPerMessage', 'CPU us/msg [primary]', 1],
  ['throughputPerSec', 'throughput msg/s', 0],
  ['latencyP50Us', 'latency p50 us', 0],
  ['latencyP95Us', 'latency p95 us', 0],
  ['latencyP99Us', 'latency p99 us', 0],
  ['eventLoopDelayP99Ms', 'ELD p99 ms', 2],
  ['eventLoopDelayMaxMs', 'ELD max ms', 1],
  ['eventLoopUtilization', 'ELU', 3],
  ['rssPeakMb', 'RSS peak MB', 1],
  ['heapUsedPeakMb', 'heap peak MB', 1],
  ['shutdownMs', 'shutdown ms', 0],
];
for (const [name, s] of Object.entries(d.scenarios)) {
  out.push(`#### ${name}: ${s.variant} | ${s.load}`);
  if (s.status !== 'RAN') {
    out.push(`${s.status}: ${s.reason}`, '');
    continue;
  }
  out.push(`pairs valid ${s.pairsValid}/${s.pairsRequested}; pairs started on contended host: ${s.pairsContended}; lowConfidence: ${s.lowConfidence}${s.lowConfidenceReason ? ` (${s.lowConfidenceReason})` : ''}`, '');
  for (const [label, sum] of [['all valid pairs', s.summaryAllValidPairs], ['quiet-start pairs only', s.summaryQuietPairsOnly]]) {
    out.push(`${label} (n=${sum.pairsUsed}):`, '', '| metric | off mean | on mean | mean delta % | median % | 95% half % | mean w/o 1st % | neg pairs | mean delta abs | verdict |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const [k, lab, dp] of KEYS) {
      const m = sum[k];
      if (!m) continue;
      const p = m.deltaPercent;
      out.push(`| ${lab} | ${f(m.meanOff, dp)} | ${f(m.meanOn, dp)} | ${f(p.mean)} | ${f(p.median)} | ${f(p.ci95Half)} | ${f(p.meanWithoutFirstPair)} | ${p.negativePairs}/${p.n} | ${f(m.deltaAbsolute.mean, dp)} | ${p.verdict}: ${p.verdictReason} |`);
    }
    out.push('');
  }
  out.push('per-pair CPU us/msg (off -> on) and persisted counts:', '', '| pair | order | probe-contended | other-load off/on | off | on | delta % | traces | spans | op rollups | metric rollups | dropped(adm/queue/storage) | shutdown on ms | queueDepth after stop |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of s.pairs) {
    const o = p.off.result;
    const n = p.on.result;
    const c = n?.countersAtEnd ?? {};
    const mc = p.on.mongoCounts ?? {};
    const invalid = !p.off.valid || !p.on.valid ? ` INVALID: ${[...p.off.invalidReasons, ...p.on.invalidReasons].join(' | ')}` : '';
    out.push(`| ${p.pair}${invalid} | ${p.order} | ${p.contended} | ${p.off.otherLoadDuringRun ?? '-'}/${p.on.otherLoadDuringRun ?? '-'} | ${o ? f(o.cpuUsPerMessage) : '-'} | ${n ? f(n.cpuUsPerMessage) : '-'} | ${o && n ? f(((n.cpuUsPerMessage - o.cpuUsPerMessage) / o.cpuUsPerMessage) * 100) : '-'} | ${mc.traces ?? '-'} | ${mc.spans ?? '-'} | ${mc.operation_rollups ?? '-'} | ${mc.metric_rollups ?? '-'} | ${c.tracesDroppedAdmission ?? '-'}/${c.tracesDroppedQueueFull ?? '-'}/${c.tracesDroppedStorage ?? '-'} | ${p.on.stop ? f(p.on.stop.shutdownMs, 0) : '-'} | ${p.on.stop?.queueDepth ?? '-'} |`);
  }
  out.push('');
}
console.log(out.join('\n'));
