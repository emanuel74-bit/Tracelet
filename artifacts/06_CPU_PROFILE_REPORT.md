# Mission 06: profiling completion report

Author: tracelet-implementer (Sonnet), 2026-10-29. Branch `tracelet/m06-profiling` (based on `8b800cb`), uncommitted. Host: Windows 10, i5-7400 (4 cores), 17 GB. No contract file, scaffold file, or file outside the PRO write scope was changed. Change requests: CR-001 (rotation keep-alive, approved earlier) and CR-002 (Node 20 + Windows sampler busy-wait, approved option A, applied; see sections 7 and 9). All numbers below were measured by me in this session; anything not run is marked.

> **UPDATE (CR-002, applied; supersedes the Node 20 statements below).** Root cause of the Node 20 idle-CPU finding, the option-A behaviour, the re-done benchmark and the flaky-test fixes are in sections 7 and 8. The original section 3 numbers are history only (kept in artifacts/06_bench_profiler_ab_node*.INVALID_history.json): idle/Nest rows and every wall-throughput or event-loop-delay delta in them are invalid on Windows, and no overhead may be claimed from them.

## 1. Files

New: `src/profiling/metrics-collector.ts`, `src/profiling/vendor/runtime-metrics.ts`, `src/profiling/vendor/node-runtime-metrics.interface.ts`; `tests/unit/profiling/{malformed-profile,mapper-accounting,runtime-metrics,metrics-collector,leak-tracker}.spec.ts`; `tests/integration/profiling/lifecycle.int-spec.ts`; `tests/support/profiling/{scripted-session,leak-tracker}.ts`; `bench/profiling/ab-overhead.int-spec.ts` (gated by `TRACELET_BENCH_AB=1`); `artifacts/06_bench_profiler_ab_node{20,22,24}.json`; this report.
Modified: `src/profiling/{index,profile-mapper,profiler.service}.ts`, `src/profiling/vendor/{cpu-sampler,fold-profile}.ts`, `third_party/nestjs-observe/FORK_DELTA.profiling.md`.

Source changes beyond the new files (found by the new malformed-profile tests):
- `foldProfile` threw on a profile without `nodes`, and a throw inside `finishWindow` (outside any try) surfaced as an unhandled rejection from the rotation timer. Now: `foldProfile` never throws (returns `malformed`), `finishWindow` wraps the fold, and the rotation timer has a `.catch` that tears down and reports through `onError`.
- Cycle-safe, bounded parent walk (visited set, 10 000 ancestor cap, leaf-most frames kept); invalid sample ids and bad `timeDeltas` counted; callFrame name/url capped before frame strings are built. `ProfilerDebug.counters` gained `malformedWindows`, `invalidSamples`, `invalidDeltas`, `cyclicStacks`. A malformed window increments the queue counter `profilesDropped`.
- `estimateStackBytes` now measures UTF-8 bytes of the JSON-escaped stack (was UTF-16 length); the random-fold test showed the real serialized bound only holds with this.
- Runtime metrics: event-loop delay percentiles are reported as the excess over the histogram resolution (raw values kept in `raw*`); `reset()` per interval has a documented caveat (a stall starting within one histogram tick after a reset is in neither interval). GC via `PerformanceObserver`; anything unsampled is listed in `unavailable` and is 0, never estimated.

## 2. Checks actually run (exact)

> The counts in this table are from the first pass and are superseded by the final tallies in section 9a. The bench table in section 7 is the first re-run; the final re-run is in section 9.

| Check | Node | Result |
|---|---|---|
| `tsc -p tsconfig.json --noEmit` | 22.22.0 | exit 0 (after the last source edit; the bench file was re-typechecked after its one type fix) |
| `eslint src tests bench` | 22.22.0 | exit 0, no output |
| unit suite | 22.22.0 | 26 files, **390 passed** (baseline before my tests: 4 profiling files / 65 tests in the profiling dir) |
| unit suite | 20.19.5 / 24.22.2 | 26 files, 390 passed / 26 files, 390 passed |
| integration (`vitest.int.config.mts`, default include: poc + instrumentation + profiling + contract + bench) | 22.22.0 | 27 files passed, 1 skipped (the gated A/B bench), **133 tests passed, 1 skipped** (T09 and T10 included, both green) |
| `tests/integration tests/contract` | 20.19.5 / 24.22.2 | 25 files, **131 passed** on each |
| T09 on Node 22 in that run | 22.22.0 | 6/6 gaps contiguous (max 10.21 ms), coverage 0.9992, start stall max 0.22, stop max 1.25, fold max 3.9 ms, state only `running` |
| T10 on Node 22 in that run | 22.22.0 | 6/6 contiguous (max 8.58 ms), coverage 0.9992, idle samples in every window |

Not run: the integration suite was run once per Node version (no 10x repetition of the new tests); no Linux or container run (Docker Desktop daemon is not running on this host). T09/T10/T18 thresholds are unchanged. The committed `artifacts/02_*.json` files rewritten by the runs were restored with `git checkout --` (`git status` shows none modified).

New tests (counts from the unit/integration summaries above): malformed profile 16 + profiler-level 3 (cycles, negative/NaN/infinite/string deltas, NaN times, 2 MB names, `;`/newline/NUL in names, 200 000-deep chain under 1.5 s with 128 frames, unknown node ids, duplicate ids, 300 randomised corruptions, every mapped item validated with ajv against `telemetry.schema.json#/$defs/CpuProfile`, queue counter `profilesDropped` equals malformed windows, no unhandledRejection/uncaughtException); mapper accounting 3 (200 random folds incl. unicode/quotes/control chars: `sampleCount = sum(stacks)+droppedSampleCount`, stack counts add up, kept stacks outrank dropped, real `Buffer.byteLength(JSON.stringify(profile)) <= maxProfileBytes`); runtime metrics 5; metrics collector 10 (schema-valid `MetricRollup`, counter deltas tie to the queue's cumulative counters, tie preserved through control-pool eviction, rejected offer does not advance the baseline, never throws, timer outside trace, final partial interval, 25 start/stop cycles without leaked timers, disabled starts nothing, control pool bounded); leak-tracker negative control 1; integration lifecycle 9 (10 restart cycles on the real inspector with 20 connects == 20 disconnects and no leaked timer, shutdown final flush, stop during backoff, disabled opens no session/probe/timer, profile pool bounded with each overflow counted exactly once, no network calls from profiler + collector, host `inspector.Session` coexistence, abrupt host disconnect, host `console.profile` without `profileEnd`).

## 3. Measurements (T20 seed; `artifacts/06_bench_profiler_ab_node{20,22,24}.json`)

Method: sampler off vs on (99 Hz, windowMs 4000, 8 s per run), alternating order per pair (off/on, on/off, ...), 8 pairs on Node 22, 6 on Node 20 and 24, one discarded warm-up pair per scenario, 12 000-function generated fixture and the unmodified `orders-app.ts` (instrument disabled to isolate the profiler). Deltas are paired, with a 95 % t interval; "noise" means 0 lies inside the interval. The queue was drained after each run; the production default windowMs is 30 000, so rotations here are 7.5x more frequent than in production.

**Read this first: only `codeheavy-cpu` is a valid overhead measurement on this host.** In idle and Nest scenarios the "on" runs are 15-67 % FASTER and show lower event-loop delay on all three Node versions. That is an artifact, not a speed-up: those workloads are `setTimeout(1..100)` bound and, on Windows, a running sampler appears to raise the system timer resolution (default ~15.6 ms; the cause was NOT isolated here). Do not use those throughput or event-loop-delay deltas as overhead claims. They are kept in the JSON for completeness.

`codeheavy-cpu` (CPU-bound, ELU 1), work units per second:

| Node | off | on | paired delta | 95 % half-width | verdict |
|---|---|---|---|---|---|
| 22.22.0 (8 pairs) | 8808.6 | 10084.3 | +16.6 % | 16.5 | not distinguishable from noise (borderline), no overhead resolved |
| 24.22.2 (6 pairs) | 10057.6 | 11268.5 | +12.6 % | 9.5 | "on" faster is implausible; ordering/thermal noise; no overhead resolved |
| 20.19.5 (6 pairs) | 10263.2 | 8976.3 | **-12.0 %** | 8.8 | on Node 20 the sampler cost is statistically visible (about 12 %, range 3-21 %) |

Process CPU (`process.cpuUsage`, all threads, fraction of one core): Node 22 0.941 off vs 0.998 on (+6.0 % +-2.2), Node 24 0.954 vs 0.997 (+4.6 % +-3.5, loop already saturates a core), **Node 20 0.935 vs 1.535**. On Node 20.19.5 the sampler used about one extra core even when the application was idle: `codeheavy-idle` 0.001 off vs 0.981 on, `nest-idle` 0 vs 0.976, `nest-cpu` 0.266 vs 1.265. On Node 22 and 24 idle CPU stayed about 0.00 either way. This was measured on Windows only, was not root-caused (a busy sampling thread on this Node 20 build is the obvious suspect) and is not known to occur on Linux; **before enabling the profiler on Node 20.x, measure idle CPU on the real deployment platform.** It is the most important open finding of this mission.

RSS rose 7.8-12.2 % (about 8-10 MB) with the sampler on in nearly every scenario and version (all "SIG"); heapUsed deltas are in the JSON. Event-loop delay p99/max on `codeheavy-cpu`: Node 22 7.99/31.8 ms off vs 5.51/7.4 on (noise for p99), Node 20 7.6/23.9 off vs 24.0/72.4 on (p99 significantly worse with the sampler, max noise), Node 24 6.6/29.3 vs 5.5/18.3 (noise).

Per-rotation stall series (all on-runs, p50 / max, ms), `codeheavy-cpu`:

| Node | startStall | stopStall | fold | keep-alive begin+end |
|---|---|---|---|---|
| 20.19.5 | 0.27 / 0.35 | 1.59 / 12.76 | 2.78 / 5.38 | 0.16 / 0.35 |
| 22.22.0 | 0.13 / 0.46 | 1.33 / 1.72 | 2.00 / 2.77 | 0.16 / 0.37 |
| 24.22.2 | 0.14 / 0.30 | 0.92 / 1.00 | 1.20 / 1.46 | 0.15 / 0.29 |

Large retained heap (about 313 / 314 / 322 MB heapUsed on 20 / 22 / 24, 4 repetitions, 3 rotations each, code-heavy CPU load), rotation stall with the keep-alive vs plain stop/start:

| Node | keep-alive startStall p50 / max | stopStall p50 / max | plain stop/start startStall p50 / max | plain stopStall p50 / max | event-loop max, keep-alive vs plain |
|---|---|---|---|---|---|
| 20.19.5 | 0.14 / 0.15 | 1.36 / 1.55 | 516 / 530 | 28.7 / 28.7 | 33-77 ms vs 521-557 ms |
| 22.22.0 | 0.18 / 0.31 | 1.27 / 1.59 | 699 / 702 | 23.6 / 24.1 | 6-9 ms vs 710-730 ms |
| 24.22.2 | 0.14 / 0.17 | 0.94 / 0.98 | 749 / 765 | 30.8 / 33.2 | 6-28 ms vs 752-801 ms |

The stall without the keep-alive grows with heap size (about 270 ms at 60 MB in a smoke run, 516-765 ms at 300 MB) and would trip `maxStallMs` 250 and cause backoff; with the keep-alive it stays under 0.5 ms. This confirms CR-001 at 300 MB on all three Node versions. Initial `start()` and resume after backoff are not part of this budget (CR-001 L2).

Achieved sample rate (sample-timestamp based, per window): 92-94 Hz on Node 22 and 24 in most runs, 85-88 Hz on a few CPU-bound windows (Node 24 85.3, Node 20 87.8), 97-98 Hz at idle on Node 20, against 99 configured. Expect the 5-15 % shortfall reported by `profiler.achievedSampleRateHz`; Windows timer granularity is the likely cause but was not isolated.

Missing or low-information frames (leaf shares of non-idle samples in the last on-run of each scenario, Node 22): `codeheavy-cpu` `(program)` 59 %, `(garbage collector)` 0.8 %, native-by-name 0.8 %, anonymous 0 %; `nest-cpu` `(program)` 5.8 %, native-by-name 71 % (Nest/Node internals, timers), anonymous 2.3 %, idle 77 % of all samples; idle scenarios are 97-99 % `(idle)` samples with only a handful of other samples, so their non-idle shares are not meaningful. `(program)` is time V8 cannot attribute to JavaScript (native code, the profiler's own work, lazily compiled code); 59 % on the generated fixture is high and should be read as "not attributable", not as application work. No profile in these runs trimmed samples (`droppedSampleCount` 0).

## 4. Limits and caveats

- **Not source-mapped.** Frames are `function relpath:line` taken from V8's call frames, i.e. positions in the executed JavaScript. For a TypeScript build the frames show `dist/...js` lines (and `src/` only if the code runs from ts-node/swc-register); Tracelet does not read `//# sourceMappingURL`, and `--enable-source-maps` does not change inspector profiles. Functions keep their TS names; lines do not map back. Paths outside `process.cwd()` become `node_modules/<pkg>/...` or `<external>/<basename>`; no absolute path, drive letter, user name or URL query is stored.
- **No per-span correlation.** Profiles are keyed by time window, service and instance only. A profile cannot be attributed to a trace or span.
- **Sampling is wall-clock on the main thread only** (worker threads, native threads and child processes are not profiled); idle time appears as `(idle)` and is counted in `idleSampleCount`.
- **Inspector interplay** (tested where marked): a host `inspector.Session` with the Profiler enabled and its own profile running coexists with Tracelet (tested: Tracelet kept rotating, the host's `Profiler.stop` returned its own non-empty profile, no unhandled rejection; the keep-alive profile is also delivered to the host session and its cost lands in `stopStallMs`/`keepAliveMs`, a heap walk per rotation that can trip backoff). Abrupt host disconnect mid-run: no effect (tested). A host `console.profile('x')` without `profileEnd` (Node's global `console.profile` is the V8 inspector console method; tested through `inspector.console` because vitest replaces the global console): rotation continued for 5+ windows with no error; the host profile stays open until `profileEnd` or exit (its memory growth was not measured). DevTools attached, `NODE_V8_COVERAGE`, `--cpu-prof`: the default keep-alive is switched off for the last two (unit-tested decision, existing); with DevTools or a coverage tool the rotation stall can come back and backoff reports the keep-alive cost; a running `--inspect` session with Profiler enabled is the same situation as the tested host session. Not tested live: DevTools, `--cpu-prof`, `NODE_V8_COVERAGE`, a second Tracelet instance in one process.
- **Linux containers: not measured** (no daemon on this host); from design only: needs a Node built with the inspector (`probeInspector()` reports `unavailable` with a reason otherwise, tested via T18); a CPU quota (cgroup `--cpus`) can stretch the sampling interval so `achievedSampleRateHz` drops below 99 and rotation stalls grow when the process is throttled, which can trigger backoff; a read-only root FS is harmless (nothing is written); `NODE_OPTIONS` with `--cpu-prof` disables the keep-alive; running under `--inspect` is the host-session case above. Verify on the target image.
- Event-loop-delay gauge: `reset()` per interval loses a stall that begins within one histogram tick after a collection; reported values are the excess over the 10 ms histogram resolution, with a platform floor (Windows timer granularity).
- GC counts come from asynchronous `PerformanceObserver` delivery and can land one interval late.

## 5. What LEAD must wire (integration-only entrypoints)

```ts
const queue = new BoundedTelemetryQueue(limits);            // LEAD's; setTelemetryQueue(queue) routes the context counters to it
const profiler = new ContinuousProfiler(cfg.profiling /* {enabled, sampleRateHz, windowMs, maxStacksPerProfile, maxProfileBytes, maxFramesPerStack, maxStallMs} */,
  { queue, serviceName, serviceVersion, instanceId });
const metrics = new MetricsCollector({ enabled: cfg.runtimeMetrics?.enabled, intervalMs: cfg.runtimeMetrics?.intervalMs },
  { queue, serviceName, instanceId });
```

**Start (plan 13, `onApplicationBootstrap`, inside `runOutsideTrace`).** Queue and `setTelemetryQueue` exist from `onModuleInit`. In `onApplicationBootstrap` call `void profiler.start()` and `metrics.start()`: **do NOT await `profiler.start()`**. The initial start builds a fresh V8 CpuProfiler and is heap-proportional (about 1.1 s at 550 MB, CR-001 L2), so bootstrap must never wait for the inspector. `start()` never throws and never rejects; its outcome is visible in `profiler.profilerHealth()` (`starting` -> `running`, or `disabled` / `unavailable` with a reason). `metrics.start()` is synchronous and never throws.

**Shutdown: how this composes with the Stage 03 order (`artifacts/03_INSTRUMENTATION_REPORT.md` section 9).** Plan 13 puts the profiler and metrics stop in `beforeApplicationShutdown` and the root closing in `onApplicationShutdown`; Stage 03 lists the `onApplicationShutdown` steps. Together:
1. `beforeApplicationShutdown` (bounded by 2 s in total, race the awaits against a timer): `await profiler.stop()` (final partial window offered), `metrics.stop()` (final partial interval offered), `stopSweeper()`.
2. `onApplicationShutdown`: `configureTracing({ enabled: false })` -> `closeAllOpenRoots('shutdown')` -> `await whenCompletionsIdle(~1500)` -> `rollups.shutdown()` -> **`metrics.flush()`** -> writer final flush (`shutdownFlushTimeoutMs`) -> close Mongo.
3. Why `metrics.flush()` (added in this review, tested): counters incremented after `metrics.stop()` (`closeAllOpenRoots`, rollup drops, queue-full drops during shutdown) would otherwise never reach a `MetricItem`. `flush()` emits one last item with the deltas accumulated since the previous item, also after `stop()`; its event-loop-delay and GC fields are then 0 and listed in `unavailable`; it returns false and offers nothing when nothing changed. Counts that happen after the writer's final flush (drops during the flush itself) cannot be stored and stay only in the in-memory counters.

**Health sources.** `ContinuousProfiler` implements `ProfilerHealthSource`; feed `InstanceHeartbeat.profiler` from `profilerHealth()`. `reason` is clamped to the schema's 256 characters (the full text is in `profiler.debug().reason`). `TracingHealthSource` is NOT provided here: LEAD builds it from the context runtime (`enabled`, `sampleRate`, `instrumentInstalled`, `openTraces`). `MetricsCollector` needs no health source.

**Lifetime rule for the collector.** A `MetricsCollector` must live exactly as long as its queue (create both once, stop both at shutdown). A second collector on the same queue would report the same counter deltas again (double counting). A collector whose queue was replaced sees counters go backwards; it now rebases (the baseline drops to the new reading, `debug().rebased` counts it) instead of under-reporting until the new counters catch up, but the counts lost with the old queue are of course gone.

**Gate caveat.** The CR-002 busy-wait gate is applied only when the real inspector session is used. Passing `createSession` (a test hook) turns the gate off unless `busyWaitReason` is also injected; production wiring must not pass `createSession`.

**Config validation LEAD must enforce (the package is defensive, but silently clamps).** `runtimeMetrics.intervalMs >= 10000`; `profiling.windowMs` 5000..120000; `profiling.sampleRateHz` 1..1000 (and note CR-002: on Node 20 + Windows anything above 9 is refused at start); `profiling.maxStacksPerProfile` 1..5000 (schema `stacks.maxItems`; the mapper caps at 5000); `profiling.maxProfileBytes` at least about 640 + name lengths (the mapper floors the cap at the size of an empty profile and then keeps zero stacks; default 1 MiB); `profiling.maxFramesPerStack` >= 2 (fold floors it at 2); `profiling.maxStallMs` >= 0; `maxQueuedControlBytes >= 2 MiB` (Stage 03). Non-finite values fall back to the defaults.

**Other.** `profiling.enabled` defaults to false (state `disabled`, no session); `MetricsCollector` is enabled unless `enabled === false`. `MetricItem.telemetry` are deltas of the queue's cumulative counters since the last ACCEPTED metric item; the queue's control-pool eviction folding keeps the sums intact (tested). `profilesDropped` is incremented by the profiler itself only for malformed windows; rejected offers are counted by the queue.

## 6. Known gaps and risks

1. Node 20.19.5 on Windows: root-caused (section 7, CR-002): V8 11.3 busy-waits the sampler thread. The profiler now refuses to start there (state `unavailable`) unless `sampleRateHz <= 9`; 9 Hz is spin-free in steady state only (the first window after a start/resume builds a fresh CpuProfiler, and the 9 Hz measurement was a few seconds of raw `node:inspector`, not a soak). Not tested on Linux or on other Windows builds.
2. The A/B bench cannot show overhead for timer-bound workloads on Windows (timer-resolution artifact); a Linux re-run is needed for the idle and Nest rows. The bench data cannot bound the overhead at all (section 9: cpuMsPerUnit is lower with the sampler on in 14 of 14 pairs, an unexplained bias).
3. No Linux/container measurements; no live DevTools, `--cpu-prof` or `NODE_V8_COVERAGE` run.
4. `README` caveats (host `console.profile`, unsourcemapped frames, Node 20 CPU) are LEAD's file; text is in sections 3-4 and `FORK_DELTA.profiling.md`.
5. Soak (5 min natural GC) was not repeated in this mission; the Mission 02 soak result stands.

## 7. CR-002 (approved, option A, applied): Node 20 on Windows

**Root cause (investigator, source-pinned to Node v20.19.5 / V8 11.3.244.8).** `SamplingEventsProcessor::Run` in `deps/v8/src/profiler/cpu-profiler.cc` busy-waits (`while (TimeTicks::Now() < nextSampleTime) {}`) on Windows whenever `use_precise_sampling_` is true (the default; the inspector agent never turns it off and the protocol cannot) and the next sample is under 100 ms away. Node 21+/22/24 (V8 11.8+) first try a high-resolution waitable timer (Windows 10 1803+, build 17134+) and only spin if it cannot be created. Linux and macOS use a condition-variable wait on every version. Not measured on Linux (no host).

| Runtime (raw node:inspector, app idle) | Hottest thread, Gcyc/s | process.cpuUsage (core fraction) |
|---|---|---|
| 20.19.5, off | 0 | 0.000 |
| 20.19.5, 99 Hz, no rotation | 1.64 (one non-main thread) | 0.49-0.57 |
| 20.19.5, 49 / 19 / 11 Hz | 1.11 / 1.64 / spinning | 0.39 / 0.63 / 0.555 |
| 20.19.5, 9 Hz / 5 Hz | 0.001 / 0 | 0.000 / 0.000 |
| 20.19.5, 9 Hz + 2 s rotation + keep-alive | 0.001 | 0.001 |
| 22.22.0, 99 Hz with or without rotation + keep-alive | 0.003-0.004 | 0.000-0.001 |
| 24.22.2, 99 Hz + rotation + keep-alive | 0.005 | 0.000 |

Neither the keep-alive nor the rotation causes it; the cost does not depend on application load and lasts as long as a profile is open. The -12 % Node 20 throughput cost in the history section is consistent with a core taken by the spinner (attribution not isolated separately).

**Behaviour now.** `ContinuousProfiler.start()` consults `samplerBusyWaitReason(sampleRateHz)` first. If it returns a reason (win32 and sampling interval under 110 ms and V8 < 11.8, or V8 >= 11.8 on a Windows build < 17134): state `unavailable`, reason = that text ("...busy-waits about one core between samples at sampleRateHz N (...); use Node >= 22 on Windows 10 1803+, or sampleRateHz <= 9"), no probe session, no sampler session, no timer, one rate-limited warning, never throws. `sampleRateHz <= 9` (interval >= 111 ms) is the explicit working opt-in (state running, no reason). `enabled: false` stays `disabled`. The gate applies to the real inspector session only (an injected `createSession` is not gated unless the `busyWaitReason` seam is injected, so fake-session tests stay valid everywhere). No contract or config change.

**Tests.** `tests/unit/profiling/sampler-busy-wait.spec.ts` (12 tests): unavailable at 99/49/11/10/1000 Hz on a simulated Node 20 + win32 runtime with probe and createSession spies at 0 calls, no leaked timer, no item, one warning; running at 9/5/1 Hz without warning or reason; disabled stays disabled; ungated with a bare fake session; simulated Node 22 and Linux running. `tests/integration/profiling/busy-wait-gate.int-spec.ts` (real runtime): refused with no `Session.connect` where affected, running elsewhere; 9 Hz produces profiles on every runtime. T09, T10, the keep-alive heap test and the real-inspector lifecycle tests call `skipIfBusyWait` (`tests/support/profiling/runtime-gate.ts`): on Node 20 + Windows they are SKIPPED with "NOT RUN: Node 20 on Windows busy-waits the V8 sampler thread, CR-002" and are **recorded as NOT RUN, not passed**. Thresholds are unchanged and nothing is silently run at 9 Hz. T09, T10 and T18 still run and pass on Node 22 and 24. Observed on Node 20.19.5 (win32) for `tests/integration/profiling` + T09/T10/T18: 8 passed, 12 skipped (20).

**Bench re-done (`bench/profiling/ab-overhead.int-spec.ts`).** The primary metric is process CPU time per unit of work (`cpuMsPerUnit`); CPU rows are paced with `setImmediate`; timer-paced rows (`codeheavy-idle`, `nest-cpu`, `nest-idle`) are marked invalid on win32 for wall throughput and event-loop delay (`validity` in the JSON); an idle-CPU gate (the bench fails if idle CPU fraction with the sampler on exceeds 0.1) and the host busy percentage are recorded. Node 20: the bench records `status: unavailable` with the reason (NOT RUN, no overhead claimed). **The host was 82-100 % busy during these runs (another session was using it), so absolute numbers are degraded and the conclusion is weak.** Results (Windows, 99 Hz):

| Node | row | cpuMsPerUnit off -> on (paired delta, 95 % half-width) | idle gate |
|---|---|---|---|
| 22.22.0 (8 pairs) | codeheavy-cpu | 0.123 -> 0.107 (-9.6 %, +-12.9, noise) | n/a |
| 22.22.0 | nest-cpu (timer-paced; wall rows invalid) | 0.345 -> 0.285 (-10.7 %, +-28.4, noise) | n/a |
| 22.22.0 | codeheavy-idle / nest-idle | CPU fraction with sampler on 0.0019 / 0.0037 | pass / pass |
| 24.22.2 (6 pairs) | codeheavy-cpu | 0.112 -> 0.101 (-7.8 %, +-11.9, noise) | n/a |
| 24.22.2 | nest-cpu | 0.298 -> 0.291 (+0.5 %, +-24.8, noise) | n/a |
| 24.22.2 | codeheavy-idle / nest-idle | CPU fraction with sampler on 0.0019 / 0.000 | pass / pass |

Reading: no CPU-per-work difference between sampler on and off is distinguishable from noise on Node 22 or 24 (intervals about +-8-28 %, host saturated); idle CPU stays near 0 with the sampler on (gate passes). The large-heap case repeats (Node 22: keep-alive start stall max 0.24 ms vs plain stop/start p50 812 ms at 314 MB; Node 24: 0.13 ms vs 720 ms at 327 MB). The wall-throughput "on is faster" numbers of the history section are the timer-granularity artifact. The `cpuFraction` and `workPerSecond` columns of the CPU-bound row in the new JSON are also not overhead measures (the on arm completes more work per second in the same artifact-affected loop and the host was saturated) and must not be quoted. A Linux re-run is still needed for the timer-paced rows.

**README caveat text for LEAD.** "On Windows with Node 20 (V8 < 11.8), or on Windows builds older than 10 1803, the V8 CPU sampler thread busy-waits about one CPU core while any profile is open. Tracelet therefore refuses to start the profiler there (health state 'unavailable', with the reason) unless profiling.sampleRateHz is 9 or lower (about 9 samples per second, roughly 270 per 30 s window). Use Node 22 or newer. Linux and macOS are not affected by this mechanism (not measured by us)." Open question for the user (not decided here): raise `engines.node` to `>=22` (Node 20 is EOL), which would also drop Node 20 from the T09/T10 matrix.

## 8. Flaky-test stabilisation (unit suite)

1. `tests/unit/shared/als-abi.spec.ts` second test: `vi.resetModules()` plus re-importing `src/context` and `src/instrumentation` costs 1.4 s alone and exceeded the 5 s default under CPU contention from parallel test files (reproduced: "Test timed out in 5000ms"). The body is import-only, so its timeout is 30 s; nothing it asserts is time based.
2. `runtime-metrics.spec.ts` event-loop-delay tests assumed `sleep(60)` lets the histogram's own timer record a 250 ms stall, and that a tick had happened after `reset()`; under load neither is guaranteed (reproduced). They now wait on an independent `monitorEventLoopDelay` probe until the stall is observed.
3. The same file's CPU test assumed 60 ms of wall spinning gives a CPU fraction above 0.1 (failed under load: 0.088 and 0). It now spins until `process.cpuUsage` itself shows 60 ms and asserts CPU time.
4. `tests/unit/buffer/redaction-cpu.spec.ts` 50 ms budget on one wall-clock sample failed once in 25 loaded runs; it now takes the best of 5 (a super-linear regression is seconds in every run).

## 9. Stage 06 review round (APPROVE-WITH-CHANGES): fixes and evidence

| Item | Result |
|---|---|
| 1 HIGH: ungated `bench/profiling/sampler-overhead.int-spec.ts` | FIXED. `skipIfBusyWait(ctx)` is the first statement of its `it` (before the fixture is generated or `artifacts/02_bench_profiler.json` is written). Audit of every file using `ContinuousProfiler`, `ContinuousCpuSampler`, `inspector.Session`, `createInspectorKeepAlive`: T09, T10, keepalive-heap, lifecycle, idle-cpu, busy-wait-gate and both benches import the gate; T18 and the unit tests inject fake sessions. New guard `tests/unit/profiling/real-sampler-gate-guard.spec.ts` scans `tests/integration` and `bench` and fails for any file that starts a real profiler without the gate or an injected `createSession`, and for a `skipIfBusyWait` that is not the first statement. Mutation: removing the gate import and call from `sampler-overhead.int-spec.ts` makes the guard fail 2 of 3 tests, naming the file. Simulation: `TRACELET_SIMULATE_NODE20_WIN=1` (file `tests/support/profiling/simulate-node20-win.ts`, imported for its side effect by `runtime-gate.ts`, which fakes `process.versions.v8 = 11.3.244.8-node.33` on this win32 host; documented in the file; no scaffold config change). Full default integration suite (`vitest.int.config.mts`: poc + instrumentation + profiling + contract + bench) under the simulation on Node 22: 0 failures, see the tallies below. |
| 2 MEDIUM: deep parent walk | FIXED (`break` once the frame cap is reached and another real frame exists). 10 000-deep chain with 3 000 distinct sampled leaves: 7 351 ms with the old code (mutation run, test fails: "fold took 7351 ms"), under the 1 500 ms bound with the fix (the test asserts every stack is 128 frames, `(truncated)` first, the leaf last, and `sum(stacks) = sampleCount`; a chain of exactly `maxFrames` frames is not truncated, one more is). |
| 3 MEDIUM: cycle-guard mutation survived | FIXED. New exact-stack test: the 2-cycle folds to `[{ stack: '(truncated);a a.js:2;b b.js:3', samples: 2 }]` with `cycleCount` 1. Mutation (`if (steps++ >= MAX_WALK)` without the `seen.has` check) now fails 2 tests: the new one and `malformed-profile > cycles ...`. |
| 4 MEDIUM: health reason over 256 | FIXED. `profilerHealth().reason` is clamped to 256 characters (`...` suffix); the full text is in `debug().reason` and `counters.lastBackoffReason`. Test covers every producer (disabled, probe unavailable with a 600-char reason, busy-wait, session factory throws, backoff, error, error + retry failed with a 600-char message; the last two exceed 256 in `debug().reason`). |
| 5 MEDIUM: config can make the item schema-invalid | FIXED. Mapper: `maxStacksPerProfile` capped at 5000 and non-finite falls back to the default (NaN used to give `droppedStackCount` NaN); `maxProfileBytes` floored at the empty-profile size and non-finite falls back; `sampleRateHz` kept in (0, 1000]. Fold: non-finite `maxFramesPerStack` falls back, floor 2. Profiler: non-finite `sampleRateHz`/`windowMs`/`maxStallMs` fall back, rate capped at 1000. Boundary tests validated with ajv (values: 1e9, Infinity, NaN, negatives, fractions, 5000, 5001, 0, 1, 639, 700...). The limits are in the LEAD validation list (section 5). |
| 6 MEDIUM: LEAD wiring | FIXED in section 5: `profiler.start()` not awaited (plan 13); shutdown order composed with Stage 03 section 9; new `MetricsCollector.flush()` (works after `stop()`, tested) for counters incremented after `metrics.stop()`; gate is off when `createSession` is injected; collector lifetime = queue lifetime and a counter going backwards is now rebased (`debug().rebased`, tested). |
| 7 MEDIUM-LOW: bench honesty | FIXED. `validity.wallThroughputAndEventLoopDelay` is false for EVERY row on win32 with a note; the summary now also has the median, the mean without the first pair and `pairsWithNegativeDelta`; `*.INVALID_history.json` carry top-level `invalid: true` and a reason; new `tests/integration/profiling/idle-cpu.int-spec.ts` (4 s idle with the real sampler at 99 Hz, CPU fraction < 0.1, skipped on the affected runtime) so the idle gate is in the normal suite. |
| Lows | `sanitizeFramePath` fallback drops authority, query and fragment (tests with `user:pass@host`, `?token=`, `#secret`); a single `timeDelta` above 1e10 us (1e308 included) is neutralised and counted so timestamps stay finite (test); stale text refreshed (section 1, 2, 6); wording "9 Hz is spin-free in steady state only" applied (the first window after each start/resume has a fresh CpuProfiler; the 9 Hz rotation measurement was a few seconds of raw `node:inspector`, not a long soak). |

**Bench honesty (item 7), final numbers.** The re-run on the final code (host 87-100 % busy again): `cpuMsPerUnit` of the CPU-bound row is LOWER with the sampler on in 8 of 8 pairs on Node 22 (mean -8.2 %, +-10.1; median -4.4 %; without the first pair, which was -37.7 %: -4.0 % +-1.9) and in 6 of 6 pairs on Node 24 (mean -8.5 %, +-11.2; median -5.1 %; without the first pair -4.2 % +-2.6). A running profiler cannot make the same work cheaper, so this is an unexplained measurement bias (likely tick-based `GetProcessTimes` accounting plus run ordering on a saturated host), not noise and not a speed-up. **The data cannot bound the profiler overhead and no overhead figure may be quoted from them.** What the runs do support: the idle-CPU gate passes (idle CPU fraction with the sampler on <= 0.0037 on Node 22 and 24) and the keep-alive large-heap result (start stall max 0.16 ms at 314 MB on Node 22 and 0.20 ms at 317 MB on Node 24, against plain stop/start p50 705 ms and 743 ms). Node 20 records `status: unavailable` (NOT RUN).

## 9a. Final tallies (after the review fixes; host partly loaded by other sessions)

typecheck exit 0, lint exit 0 (`eslint src tests bench`). Unit suite (29 files, 418 tests): Node 22.22.0 five consecutive runs 418/418 each, plus one run under six busy-loop processes 418/418, plus two more plain runs 418/418; Node 24.22.2 418/418 (twice); Node 20.19.5 418/418 (after one failure of my own new test on the first pass: its "probe unavailable" case did not inject `busyWaitReason`, so on the real affected runtime the gate answered first; fixed). Full default integration suite (`vitest.int.config.mts`: poc + instrumentation + profiling + contract + bench): Node 22.22.0 29 files passed, 1 skipped (the TRACELET_BENCH_AB-gated A/B bench), 136 tests passed, 1 skipped; Node 24.22.2 identical 136 passed, 1 skipped; real Node 20.19.5 on Windows: 29 files passed, 1 skipped, 122 tests passed, 15 skipped (the real-sampler tests, NOT RUN with the CR-002 reason); Node 22 under `TRACELET_SIMULATE_NODE20_WIN=1`: 29 files passed, 1 skipped, 122 passed, 15 skipped, 0 failures (same as the real Node 20 run, which is the point of the simulation). T09, T10, T18 and the new idle-CPU test passed on Node 22 and 24; on Node 20 and in the simulation T09, T10, keepalive-heap, idle-CPU and the real-inspector lifecycle tests are NOT RUN. `artifacts/02_*.json` and `03_bench_overhead.json` were restored with `git checkout --`.

## 10. Load-aware T09/T10 gating (host contention probe)

**Problem.** T09 failed once in 4 full integration runs and T10 once at ~100 % host CPU (another session running). Both assert wall-clock sample gaps (<= 250 ms), coverage >= 0.95 and per-window state, so a descheduled main thread cannot be told from a sampler fault, and the failure text did not show which window failed.

**What was added (tests only, thresholds unchanged).** `tests/support/profiling/contention.ts` (probe + classifier), `contention-gate.ts` (pre/post gate, per-window diagnostics), `tests/integration/profiling/contention.int-spec.ts` (classifier tests with injected os/clock readings). The probe runs ~1.7 s before T09/T10: host CPU busy fraction from `os.cpus()` deltas (own spin CPU subtracted) plus main-thread preemption, measured by spinning on `process.hrtime` and taking the largest gap between two reads per 5 ms slice (p99 and max over slices). A 1 ms `setTimeout` sampler was rejected: Windows timer granularity (~15 ms) dominated it (113 samples in 1.7 s, p99 15-36 ms on a quiet host).
Verdict `contended` when `cpuBusy >= 0.90` OR `lag p99 >= 35 ms` OR `lag max >= 50 ms`. Only a contended reading BEFORE the run converts the test to a skip with the exact text `NOT RUN: host contended (cpuBusy=X%, lag p99=Y ms); T09/T10 need a quiet host, thresholds unchanged` (also printed with `console.warn` and written to `artifacts/02_t09_run.json` / `02_t10_run.json` as `{status:"NOT RUN", reasons, contentionBefore}`). A run that starts quiet is never converted: failures stay failures, and every assertion message now carries `contention before/after` readings plus per-window `gap/span/n/idle/stall/fold`. Passing runs record `contention.before/after` in the run json. `TRACELET_FORCE_CONTENDED_RUN=1` runs despite a contended start (reproduction only, not gate evidence).

**Calibration (4-core host; other sessions kept ambient host busy at 75-86 % the whole time, so a truly idle host was never available).** Readings of the final probe, own busy-loop children added by the experiment driver:

| extra busy loops | readings | cpuBusy | lag p99 ms | lag max ms |
|---|---|---|---|---|
| 0 (ambient only) | 20 probe-only + 52 in-test | 0.75-0.86 | 1.1-30.3 | 1.4-37.8 |
| 2 | 6 | 0.835-0.86 | 27-32.8 | 32-41.1 |
| 4 | 10 + 16 in-test | 0.875-0.893 | 34.6-56.1 | 36.6-64.3 |
| 8 | 10 + 16 in-test | 0.908-0.929 | 67-90.6 | 72-95 |
| 16 | 10 + 16 in-test | 0.932-0.956 | 129-191 | 133-191 |

Thresholds (0.90 / 35 ms / 50 ms) sit above every ambient reading (max 0.86 / 30.7 / 37.8) and below every 8- and 16-loop reading. 4 busy loops on 4 cores is borderline by design (p99 34.6-56 straddles 35; all 16 runs at 4 loops passed anyway); 2 loops are classed quiet.

**Reproduction attempt (gate bypassed with TRACELET_FORCE_CONTENDED_RUN=1, 8 runs each).** T09 / T10 at 4, 8 and 16 busy loops: 48/48 PASS, 0 failures. Largest sample gap T09 17.6 ms (4 loops), 12.1 ms (8), 12.8 (16); T10 1.06 / 9.96 / 8.78 ms; coverage >= 0.9984 (T09) and >= 0.9993 (T10). Pure CPU-contention from busy loops therefore does NOT reproduce a gap/coverage violation here (gaps stay ~10x below 250 ms); the earlier orchestrator failures were not reproduced by this mechanism and their exact assertion was not captured.

**A real, host-independent T10 flake was found and fixed.** In an unforced run on a quiet host (before 0.766/2.2 ms, after 0.754/5 ms) T10 failed on `window 6` (`idleSampleCount > 0`): the test loop exits at 30 s and the 6th rotation lands at ~30.05 s, so `stop()` closed a final window of 10 ms (`w6(final){span=10,n=2,idle=0}`); all gap/coverage numbers were fine (gaps 11.1/0.65/0.55/8.6/0.5/0.65 ms, coverage 0.9993). T10 now waits until the open window is >= 1 s old before `stop()` (no assertion or threshold changed). This is a plausible cause of the T10 failure seen in the full run.

**Proof runs after the fix (host ambient 75-80 % busy by other sessions, probe classified quiet at start in every run, 0 skips):** 12 consecutive T09 runs PASS and 12 consecutive T10 runs PASS (max T09 gap 21.9 ms, coverage >= 0.9983; max T10 gap 11.0 ms, coverage >= 0.9988; start readings cpuBusy 0.75-0.81, lag p99 1.2-30.7 ms). Contended starts without the override (8 busy loops, 2 runs each): both tests skipped with the NOT RUN message and a written `status: "NOT RUN"` artifact; no spurious failure from any quiet-start run in the sample (one failure in 10 earlier runs was the final-window defect above, now fixed).
Residual risk: a host that becomes contended AFTER a quiet start can still fail (reported as FAIL with before/after readings, by design); the ambient p99 occasionally reaches ~30 ms against the 35 ms threshold, so a very noisy host may skip or, rarely, start a run that is then disturbed.
