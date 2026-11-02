# T20 integrated runtime overhead (Mission 09)

Status: MEASURED on one Windows host, five runtimes (Node 22.22.0, 24.22.2, 20.19.5 plus two extra points, 22.23.4 and 20.20.2). The integrated pipeline
(deferred mapping, Mongo writer, rollups, metrics collector, and with variant D the profiler) is now inside the measured window, which the older
`bench/instrumentation/overhead.int-spec.ts` microbenchmark excluded. What the data can and cannot show is stated per section; read "Limits" before quoting any number.

Worktree `D:\codeShit\Tracelet-wt\m09`, branch `tracelet/m09-release`, HEAD `2877dad`, plus the uncommitted `src/profiling/profiler.service.ts`,
`src/tracelet.module.ts`, `src/tracelet.ts` edits of a parallel workstream (last modified 19:20, before every full run below started; the runs build the
working-tree `src`, there is no src hash in the JSON).

## Method

Real Nest app in a CHILD PROCESS per run (`tests/support/bench/integrated-worker.ts`, compiled with tsc into a temp dir; the Tracelet package under test is a private tsc build of the
current `src`, so a concurrent edit of `dist` cannot change a run). Workload per message (nest-worker shape):

- amqplib-style consumer callback on an in-process fake channel (`tests/support/bench/fake-channel.ts`; no socket, no RabbitMQ),
  `JSON.parse` of the body, `trace('rabbitmq.consume', ...)` as custom root, then `Consumer.process` (200 us synchronous busy-wait, identical in all modes),
  `Promise.all` of 1 to 3 `Repo.find`, `Validator.validate` -> `Transformer.execute` (nested providers, about 6 to 7 instrumented provider calls per message),
  every 50th message fails in the deepest provider (nack, error message contains a fake credential URL; `errorMessages` stays at the production default `omit`).
  Provider "I/O" yields use `setImmediate`, never timers.
- Message count 20 000 per run after 500 warm-up messages (not measured, but they are in the telemetry counters: `rootsStarted` 20 500).
- Load A, offered rate 2000 msg/s open loop. Arrivals are scheduled on a monotonic clock and a coarse 1 ms timer tick delivers everything that is due (Windows timer
  granularity changes the burst size, not the average rate; every run reached 1996 to 1998.5 msg/s). About 10 s per run.
- Load B, closed-loop saturation: 32 messages in flight, the next starts when one settles. About 4.5 to 6 s per run.

Modes (A = Tracelet absent for the baseline; the module is never even `require`d in the child):

| id | mode |
|---|---|
| off | Tracelet absent |
| B | enabled, production defaults: `NODE_ENV=production`, sampleRate default 0.05, `maxRootsPerSecond` default 20, `errorMessages` omit, rollups on, runtimeMetrics on (30 s default), profiling off |
| C | as B with sampleRate 1 and `maxRootsPerSecond` 100000 (worst case; writer pacing and queue bounds stay at defaults) |
| D | as B plus profiling ON at the product default (99 Hz, 30 s window). Skipped with a recorded NOT RUN reason on Node 20 + Windows (CR-002) |

Real `mongod` (mongodb-memory-server, mongod 8.2.6 binary, started in the parent, loopback), one throwaway database per run, row counts read back with the `mongodb` driver and the database dropped.
Per scenario: 1 discarded warm-up pair plus 6 measured pairs, ALTERNATING order (off>on, on>off, ...). Statistics (Student t 95%, df = pairs-1, same style as `bench/profiling/ab-overhead.int-spec.ts`):
per-pair deltas, mean, median, stdev, 95% half width, mean without the first measured pair, count of negative deltas, and a verdict:
`bounded` only if every pair has the harmful sign (for throughput the harmful sign is negative), the mean is a cost and 0 lies outside the 95% interval;
otherwise `cannot-bound` and no overhead figure may be quoted for that metric. Metrics: child `process.cpuUsage()` user+system per message (PRIMARY), throughput, caller-visible callback latency p50/p95/p99
(from callback entry to ack/nack), `monitorEventLoopDelay` p50/p99/max, ELU, RSS and heapUsed peaks (100 ms sampling) and end values, shutdown time, telemetry counters (before and after shutdown), Mongo row counts.

Host load: a contention probe (`tests/support/profiling/contention.ts`, spin-gap + os.cpus busy) before every pair (flag `probe-contended`) and at start/end of each file; in addition each run records
`hostBusyDuringRun` (os.cpus delta) and `otherLoadDuringRun` (that minus the child's own CPU share; it INCLUDES `mongod` and the vitest parent, so it is about 0.05 to 0.2 higher in on-mode rows).
Each scenario is marked `lowConfidence` when any pair started contended or any pair was invalid. Rows are never dropped; `summaryQuietPairsOnly` repeats the statistics without probe-contended pairs.
Invalid-row rule (all 6 pairs of every scenario below were valid): a row is invalid if not all messages settled, the nack count is off, the lifecycle is not `active` or no trace reached Mongo.

Host: Windows 10 Home 10.0.19045 x64, Intel Core i5-7400 3.0 GHz, 4 cores, 16 344 MB, shared with other agents (see per-runtime start/end probe below).

## Commands (exact)

Default integration run is unaffected: `bench/integrated/overhead.int-spec.ts` is `describe.skipIf(TRACELET_BENCH_INTEGRATED !== '1')` and needs a disposable Mongo;
`bench/integrated/stats.int-spec.ts` (3 fast tests of the statistics) always runs. Nothing is written unless enabled.

```
cd D:\codeShit\Tracelet-wt\m09\packages\tracelet
# Node 22.22.0 (local), 6 pairs, 20 000 messages
TRACELET_E2E_MONGO=memory TRACELET_BENCH_INTEGRATED=1 TRACELET_BENCH_OUT=../../artifacts/09_T20_integrated_node22.22.0.json \
  npx vitest run --config vitest.int.config.mts bench/integrated/overhead
# default output file is ../../artifacts/09_T20_integrated_node<major>.json
# Node 24.22.2 and Node 20.19.5
TRACELET_E2E_MONGO=memory TRACELET_BENCH_INTEGRATED=1 npx -y -p node@24 -- node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts bench/integrated/overhead
TRACELET_E2E_MONGO=memory TRACELET_BENCH_INTEGRATED=1 TRACELET_BENCH_OUT=../../artifacts/09_T20_integrated_node20.19.5.json \
  npx -y -p node@20.19.5 -- node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts bench/integrated/overhead
# full tables from a JSON
node bench/integrated/render-tables.mjs ../../artifacts/09_T20_integrated_node24.json
```

Knobs: `TRACELET_BENCH_PAIRS` (6), `_MESSAGES` (20000), `_RATE` (2000), `_CONCURRENCY` (32), `_WORK_US` (200), `_SCENARIOS` (e.g. `B-closed,C-offered`), `_OUT`.
Wall time: about 17 to 19 min per runtime with D, about 10 min on Node 20 (D skipped). Note: `npx -p node@22` resolves to the newest 22.x (it gave 22.23.4); the local binary is 22.22.0, and `node@20` gave 20.20.2 (so `node@20.19.5` was used for the requested one).
Raw artifacts (one per runtime, all `status: done`):
`artifacts/09_T20_integrated_node22.22.0.json`, `..._node24.json` (v24.22.2), `..._node20.19.5.json`, `..._node22.23.4.json` (extra), `..._node20.20.2.json` (extra).

## Results (closed-loop saturation, the most reproducible load)

Primary metric: child CPU per message, mean paired delta of 6 pairs, off baseline about 220 us/msg. Format: delta % +- 95% half width (absolute us/msg). All verdicts `bounded` unless noted;
every pair had the same sign. Baseline spread of the off mode across pairs (coefficient of variation) was 0.6 to 1.3% on all quiet runs, so a 15% delta is far outside CPU-accounting noise in this load.

| runtime | B defaults | C sampleRate 1 | D profiling ON (B + profiler) |
|---|---|---|---|
| Node 24.22.2 | +14.7% +-2.3 (+32.1 us) | +50.1% +-3.4 (+108.9 us) | +14.8% +-1.7 (+31.9 us) |
| Node 22.22.0 | +19.6% +-3.2 (+43.5 us) | +66.3% +-5.7 (+146.5 us) | +18.8% +-2.0 (+41.6 us) |
| Node 20.19.5 | +22.3% +-2.4 (+49.7 us) | +73.4% +-3.4 (+163.3 us) | NOT RUN (CR-002, see below) |
| Node 22.23.4 (extra, host load up to 0.8-0.9 in B/C-closed pairs: LOW CONFIDENCE) | +21.2% +-3.3 (+47.9 us) | +80.8% +-8.8 (+179.6 us), 3 pairs probe-contended | +18.9% +-0.9 (+42.0 us) |
| Node 20.20.2 (extra) | +21.8% +-2.1 (+48.4 us) | +86.1% +-11.2 (+190.1 us) | NOT RUN |

Closed-loop throughput (msg/s, 32 in flight, off about 4370 to 4560 on the quiet runs), delta % +- 95% half width, all `bounded` (6/6 pairs lower) except where noted:

| runtime | B | C | D |
|---|---|---|---|
| 24.22.2 | -10.0 +-1.4 | -28.4 +-0.6 | -8.5 +-0.8 |
| 22.22.0 | -13.4 +-0.5 | -33.3 +-1.2 | -10.6 +-0.7 |
| 20.19.5 | -11.8 +-7.6 (cannot-bound: 1 of 6 pairs favoured on) | -36.9 +-2.8 | NOT RUN |

Reading: in this synthetic handler (about 220 us of CPU per message, 6 to 7 instrumented provider calls) the Tracelet pipeline at production defaults costs about 32 to 50 us of CPU per message,
about 3 to 4 times that at sampleRate 1, and enabling the profiler on top adds nothing that this design can separate from B (D vs B CIs overlap on every runtime; the profiler's own cost is better bounded by
`bench/profiling/ab-overhead.int-spec.ts`). The absolute us/msg is the transferable number; the percentages are relative to this unusually cheap handler and would be about 0.1 to 1% for a handler that spends 5 to 50 ms per message.
Most of the B cost is the unsampled path (provider proxies, root token, admission) rather than the 5% that are recorded: B persisted only about 125 to 225 traces from 20 500 roots.

Caller-visible latency, closed loop (mean of 6 pairs, us, off -> on, p50 delta % +- half width): B 24.22.2 p50 6931 -> 7553 (+9.0 +-1.8), p95 8095 -> 10220, p99 9691 -> 14211 (p99 `cannot-bound`, 1 of 6 pairs negative);
B 22.22.0 p50 7214 -> 8197 (+13.6 +-0.7), p95 8273 -> 10485, p99 9382 -> 12397; C 22.22.0 p50 7195 -> 10629 (+47.7 +-2.8), p99 9868 -> 17364. CAUTION: with 32 messages in flight these latencies are queueing times
(Little's law: about 32 / throughput), so they mostly restate the throughput change and are not a per-message service-time overhead.

Offered load (2000 msg/s, open loop): throughput is pinned to the rate (delta 0.0 to -0.1%, `cannot-bound` everywhere, as expected). Callback latency is dominated by the burst delivery of the coarse timer tick
(off p50 about 3.5 ms, p95 about 8.9 ms), so only the deltas are interpretable: B p95 +38.8% +-6.2 (+3.5 ms, bounded) on 22.22.0, +36.3% +-10.0 (+3.2 ms) on 24.22.2; B p99 deltas are `cannot-bound` on 22.22.0 and 20.19.5.
CPU per message in the offered load is noisier (off CV 6 to 34%: Windows CPU accounting is tick-based and the load is sparse): B +29.0% +-17.7 (24), +18.1% +-16.8 `cannot-bound` (22.22.0, 1 of 6 pairs negative), +40.6% +-12.5 (20.19.5);
C +163.5% +-124.1 (24; off CV 33.6%, treat as order of magnitude only), +127.4% +-14.7 (22.22.0), +118.8% +-15.9 (20.19.5); D +25.0% +-42.4 `cannot-bound` (24), +16.6% +-8.3 (22.22.0). Prefer the closed-loop CPU numbers.

Event loop and memory (22.22.0 closed loop unless stated; ELU is 1.00 in every closed-loop row and therefore uninformative there): event-loop delay p99 B 16.6 -> 18.3 ms (+10.6% +-3.2, bounded), C `cannot-bound` (1 of 6 pairs negative; 17.1 -> 19.1 ms),
D `cannot-bound`. RSS peak B +18 to +21 MB on Node 20/22 (e.g. 86 -> 107 MB) and +43 MB on Node 24 (97 -> 140 MB); C +30 to +130 MB (24: 94 -> 222 MB end RSS, heapUsed peak 29 -> 100 MB); D about +24 to +54 MB. These are peak/end values
of a 5 to 10 s run (module load, mongodb driver, buffers, a full trace queue in C); the data cannot separate a fixed footprint from per-message growth and says nothing about a leak (no long-duration run was done).

Shutdown (`app.close()` incl. final flush): off 1.5 to 2 ms; B 12 to 16 ms; D 35 to 50 ms (final profile window persisted at shutdown); C 5.01 to 5.03 s in EVERY pair on every runtime (see finding 1).

## Proof that data was produced and persisted

Read back from the real mongod after each on-run (B/D; Node 24 shown, the other runtimes match): `rootsStarted` 20 500 (incl. 500 warm-up), `rootsSampledOut` 19 427 to 19 568 (B, offered),
`tracesDroppedAdmission` 812 to 983 (default `maxRootsPerSecond` 20 against about 200 sampled roots/s in the closed load; 85 to 90% of sampled roots are rejected by the per-instance admission bucket at this rate, which is the production default behaviour),
Mongo rows: B-offered 223 traces + 223 spans + 1 `operation_rollups` + 1 `metric_rollups` per run, B-closed 118 to 129 traces/spans + 1 to 2 operation rollups + 1 metric rollup, D identical plus exactly 1 `profiles` row (all 24 D runs on 22.22.0, 24.22.2 and 22.23.4).
C: roots all sampled (`rootsSampledOut` 0), trace queue full (`tracesDroppedQueueFull` 16 098 to 18 067), 786 (closed) to 2 652 (offered) traces persisted on Node 24.
Not exercised or zero: `method_rollups` is 0 in every row (not investigated; the run is shorter than any rollup interval, so no conclusion), and `metric_rollups` is only the single shutdown flush, because the 30 s metrics interval never elapses inside a 5 to 10 s run;
in D the 30 s profile window never closes inside the run either, so the single profile is the shutdown-time final window. Periodic rollup/metric ticks and profile window boundaries inside a run are therefore NOT in the measured window.

## Findings for the parent (not fixed here, out of scope)

1. Shutdown loses rollups, metrics and (often) the heartbeat when the trace queue is saturated. In all 60 C on-runs (5 runtimes x 2 loads x 6 pairs) shutdown took the full 5 s `shutdownFlushTimeoutMs` (5.01 to 5.03 s), `metric_rollups` was 0 in 60 of 60 and `operation_rollups` 0 in 59 of 60
   (one run persisted 2), and the post-shutdown counters show `tracesDroppedStorage` 1 162 to 2 034 and `rollupsDropped` 1 to 3 (e.g. 24.22.2 C-closed pairs 1 to 6: `tracesDroppedQueueFull`/`tracesDroppedStorage`/`rollupsDropped` = 18 099/1 616/2, 18 099/1 599/2, 18 099/1 636/2, 18 099/1 609/2, 18 099/1 608/2, 18 099/1 630/2).
   So under sampleRate 1 at 2 000 to 4 500 msg/s the control items queued behind traces are discarded at the timeout. In B and D all 96 runs flushed in 12 to 69 ms except one heavily loaded run (22.23.4 B-closed pair 4: 2 330 ms, other-load 0.89, rollups still persisted).
   Whether control items should get priority in the final flush is a product decision.
   Related, unexplained: the `instances` (heartbeat) row was 0 in EVERY on-run of three files (24.22.2, 22.23.4, 20.20.2; the first batch, run while the `C:` temp volume was nearly full) and 1 in every B/D run and C run of the two later files (22.22.0, 20.19.5; `TEMP` on `D:`). Same src, same code path; I did not establish the cause (slow temp disk delaying the first heartbeat is a hypothesis only).
2. Default `maxRootsPerSecond: 20` rejects most sampled roots at consumer rates above a few hundred msg/s; counter `tracesDroppedAdmission` shows it, the dashboard would show a very sparse trace sample for a busy consumer.
3. Windows `process.cpuUsage()` is tick-based: with sparse (offered, 2000 msg/s) load the baseline CPU/msg varied 6 to 34% between pairs, while the saturated closed loop was stable to about 1%.

## What this can and cannot show

Can show: on this host and workload, a bounded (95% t-interval over 6 alternating pairs, same sign in every pair) CPU cost per message of the whole in-process pipeline against a real mongod, for production defaults, worst-case sampling and profiling-on, for three Node majors,
with the data demonstrably produced and persisted, plus the shutdown behaviour above.
Cannot show: Linux or OpenShift numbers (cgroup CPU limits, scheduler, timers and `cpuUsage` accounting differ), a real RabbitMQ socket/amqplib channel (a fake in-process channel, no network, no prefetch),
a handler with real I/O (the 200 us busy-wait plus `setImmediate` yields is a deliberately cheap stand-in: relative percentages are inflated versus real services), multi-replica contention on one Mongo, a networked Mongo (a loopback in-memory mongod
shares the 4 cores with the app, which is why the on-mode `otherLoad` is higher; its CPU is NOT in the child's CPU figure, only in the writer's client-side cost), runs longer than 10 s (leaks, rollup/metric interval ticks, profile window boundaries, retention/TTL),
or any per-handler latency in milliseconds beyond the caveats above. Six pairs give wide t-intervals (t = 2.571); the `bounded` verdict is only as good as the host stayed quiet. The shared host varied from 6% to 86% busy between runs; the per-run `otherLoadDuringRun` and per-pair probe flags are in the JSON.
Mode D on Node 20 on Windows is NOT RUN: the profiler refuses the default rate there (CR-002, "V8 11.3.244.8-node.38 predates its precise sleep timer"); recorded in the JSON as `status: NOT RUN` with the reason.
Disk note: during this work `C:` ran out of space (0 MB free) and two attempts to run Node 22.22.0 and 20.19.5 aborted (mongod died, or mongodb-memory-server could not start, which the spec reports as skipped, not as a pass); the final runs used `TEMP` on `D:` and completed.
The JSON files from the aborted attempts were deleted and replaced.

## Addendum (orchestrator, 2026-11-02): Node 22.22.0 RERUN on a healthy disk supersedes the first 22.22.0 file

The first full runs (all five JSON files above) were taken while the host's C: drive had about 0.4 GB free. mongod refuses index creation below 500 MB free
(`available disk space ... less than required minimum`), which the orchestrator reproduced and which explains the earlier T12 timeouts and missing `instances` rows.
Those files may therefore contain storage-side losses unrelated to Tracelet; they are kept for the record but their row counts and shutdown times must not be quoted.
Rerun: `artifacts/09_T20_integrated_node22.22.0_rerun.json` (Node 22.22.0, TEMP/TMP on D:, 12 GB free, host probe quiet at start: cpuBusy 0.17, lag p99 1.4 ms;
6/6 valid pairs and 0 contended pairs in every scenario). Only this runtime was rerun; the Node 24 / 20 files are NOT re-measured and stay low-trust.
There is still no source hash in the JSON; the tree was the m09 working tree at the time (uncommitted M1/M2/L3 changes included).

Mean paired CPU us/msg (the primary metric; synthetic 200 us handler, so relative figures are large; the absolute added cost is the transferable number):

| scenario | off | on | delta | abs added us/msg | throughput delta | verdict |
|---|---|---|---|---|---|---|
| B-offered (defaults, 2000 msg/s) | 212.3 | 270.3 | +27.5% | 58 | none (rate-limited) | bounded |
| B-closed (defaults, saturation) | 219.6 | 257.2 | +17.1% | 38 | -11.7% | bounded |
| C-offered (sampleRate 1) | 207.9 | 465.0 | +124% | 257 | none | bounded |
| C-closed (sampleRate 1) | 219.9 | 345.2 | +57% | 125 | -30.8% | bounded |
| D-offered (defaults + profiler 99 Hz) | 221.3 | 268.0 | +21.3% | 47 | none | bounded; profiler cost not separable from B (B 27.5% vs D 21.3%, intervals overlap) |
| D-closed (defaults + profiler) | 220.1 | 258.7 | +17.6% | 39 | -11.1% | bounded; p99 latency cannot-bound |

Reading: at production defaults Tracelet costs roughly 40 to 60 us of CPU per message and a p99 latency increase of 30 to 60% in this workload; this is NOT a "negligible overhead" result and
must not be described as one. The sampleRate 1 worst case roughly doubles CPU per message and shows heavy queue shedding (about 85% of traces dropped at the bounded queue, which is the designed protection).
Defects/observations from the rerun:
- C (sampleRate 1) shutdown always ends at the 5 s flush bound (5013 to 5024 ms) and persists 0 operation and 0 metric rollups although queue depth after stop is 0: the control items queued behind a saturated trace pool are discarded.
  Only the saturated worst-case configuration shows it; at defaults rollups persist (1 metric rollup per run). Recorded as a known limitation, not fixed in Stage 09; owner to be decided (queue drain order is Claude-owned, writer drain is Codex-owned).
- `method_rollups` stays 0 in every row (per-method rollups are not produced by this workload path); uninvestigated.
