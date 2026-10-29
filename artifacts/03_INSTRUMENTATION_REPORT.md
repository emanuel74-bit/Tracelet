# 03 - Instrumentation hardening report (Mission 03, INS)

Branch `tracelet/m03-instrumentation` (base `tracelet/m02-poc` @ `d0f2a23`), worktree `D:\codeShit\Tracelet-wt\m03`. Not committed (orchestrator commits after review). Node 22.22.0 unless stated. No frozen contract file was touched; no change request was needed.

## 1. Files

Source (src/):
- NEW `buffer/histogram.ts` (`bucketIndex`, `emptyHistogram`), `buffer/rollups.ts` (`RollupAccumulator`), `buffer/hooks.ts` (`createBufferHooks`: `onTraceComplete` = map + `recordSpans` + `offer`; `onRootSettled` = `recordRoot`), `context/raw-attributes.ts` (`capRawAttributes`).
- CHANGED `buffer/index.ts` (exports), `context/completion.ts` (`whenCompletionsIdle`, completion start/finish bookkeeping), `context/runtime.ts` (`idleWaiters`), `context/index.ts` (export `whenCompletionsIdle`), `context/root-runner.ts` (raw attribute cap at root start), `context/vendor/trace-registry.ts` (early pluck resolve, unref'd pluck timer).
- `context/sweeper.ts`: unchanged (`closeAllOpenRoots(reason)` already existed from M02 and is exercised by the new tests).

Tests / support / bench / example:
- `tests/unit/buffer/{rollups,control-pool}.spec.ts`; ported `tests/unit/buffer/collapse-repeated-spans.spec.ts`; ported `tests/unit/context/{uuid-v7,sensitive-keys,log-redactor,deferred-trace-completion,operation-trace.registry}.spec.ts`; ported `tests/unit/instrumentation/create-instance-decorator.spec.ts`.
- `tests/integration/instrumentation/{shutdown,span-budgets,redaction,edge-providers,exclusions,failure-injection,hostile-providers,example}.int-spec.ts`. `tests/integration/poc/edge-providers.int-spec.ts` was MOVED (deleted, `git rm --cached`, staged) into `tests/integration/instrumentation/edge-providers.int-spec.ts` with gating assertions; it no longer writes `artifacts/02_edge_providers.json` (that committed file is now a historical record).
- `tests/support/instrumentation/harness.ts` (optional `rollups: true` wiring through `createBufferHooks`, `mapper` overrides), `orders-app.ts` (`abortOnError: false`, so a failed bootstrap is a test failure instead of a process abort).
- `examples/direct-callback/{main.ts,tsconfig.json,README.md}` (LEAD-authorised path).
- `third_party/nestjs-observe/{FORK_DELTA.instrumentation.md,PIN.md}` (delta + dropped/skipped list of every ported spec), `artifacts/03_bench_overhead.json`, this report.

## 2. Exact checks and results (all run in the worktree, all actually executed)

| Check | Result |
|---|---|
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `eslint src tests bench` | exit 0, no output |
| `tsc -p examples/direct-callback/tsconfig.json` (compiles example + src) and `node ../../node_modules/.cache/tracelet-example/examples/direct-callback/main.js` | exit 0; printed 3 traces, ack log `ack:m-1, nack:m-2, ack:m-3`, rollup line |
| unit suite (`vitest.config.mts`), Node 22.22.0 / 20.19.5 / 24.22.2 | 21 files, **355 passed, 0 skipped** on each |
| integration (`tests/integration` = poc + instrumentation + profiling, plus `tests/contract`), Node 22.22.0 / 20.19.5 / 24.22.2 | 24 files, **122 passed** on each |
| bench `bench/instrumentation` (Node 22) | 1 passed |
| 10x loop of t02, h6, r1, m7 + shutdown + span-budgets (Node 22) | 10/10 runs green, 6 files / 56 tests each |
| Mutation check | with the early-resolve call in `completeNode` disabled, 2 shutdown tests and the registry O-2 test fail; restored |

Nothing is skipped any more (the 4 relabel cases of the ported decorator spec run, section 6). The unit baseline before this mission was 12 files / 157 tests (M02 slice B), the integration baseline 16 files / 67 tests; poc is now 13 files (edge-providers moved out).

Integration runs rewrite committed `artifacts/02_*.json` files; they were restored with `git checkout --` after every run (the working tree has no modified `02_*` file). The overhead bench wrote `02_bench_overhead.json`, which was copied to `03_bench_overhead.json` and then restored.

## 3. Test-matrix status

| ID | Status | Where |
|---|---|---|
| T01-T05, H6, R1, M7, R11 | PASS (unchanged M02 tests, re-run on 3 Node versions, 10x loop) | `tests/integration/poc` |
| T06-T08 | DECIDED, gating on current behaviour (section 5) | `tests/integration/instrumentation/edge-providers.int-spec.ts` |
| T11 (INS queue part) | PASS: long-outage case (100 flush intervals, 16.7 bucket minutes, metric per interval, injected clock): pool never above 64 items / 4 MiB, one RollupItem per bucket, every bucket's stored aggregate equals the accumulator's final one, evictions metrics-first and counted (`rollupsDropped` == evictions), folded counters equal the offered totals; byte-pressure case (newest bucket survives, oldest rollups evicted); trace flood (20 000 + 5 000 offers) gives zero control-pool drops; drained batches obey 200 items / 4 MiB, oversize head dropped and counted. The Mongo half of T11 is STO | `tests/unit/buffer/control-pool.spec.ts` |
| T14-adjacent | PASS: branded class / subclass / instance-level brand, Nest internals, registry and ALS never proxied; a completion hook calling a branded provider that calls proxied providers creates no extra trace (N hooks for N roots) | `exclusions.int-spec.ts` |
| T16 | PASS: Mongo URI with password, bearer token, e-mail, JWT, PEM (real RSA key), in error messages (provider error, root error, sync string throw, rootOnly unsampled failure, error with hostile stack, object throw) and attributes (sensitive keys and harmless keys), `errorMessages` `redacted` and `omit`; full `JSON.stringify` of every queued TraceItem and RollupItem scanned | `redaction.int-spec.ts` |
| T17 | PASS (graceful path); hard kill UNSUPPORTED (section 4) | `shutdown.int-spec.ts` |
| T22 / R6 | PASS: 5300 sync provider calls with `maxSpansPerTrace` 5000 give 5000 stored spans, `droppedSpanCount` 301 (= `spansDropped`), business results equal, mapper output validates against `telemetry.schema.json` (Trace + Span, 5000 spans); collapse-on variant; mapper hard cap keeps ancestors. With `maxOpenSpans` 500 and 20 concurrent traces: peak open spans exactly 500, 12 traces complete + 8 affected traces each `droppedSpanCount` 40, stored + dropped = attempted, budget released to 0, a later trace gets all its spans; root refused by the budget runs unsampled and counts `tracesDroppedAdmission` | `span-budgets.int-spec.ts` |
| T23 (INS half) | PASS: throwing `onTraceComplete`, throwing `queue.offer`, throwing mapper (redactor), throwing rollup accumulator: business results and ack log identical to the disabled run, exactly 3 roots started (no recursion), registry and `pendingCompletions` back to 0, diagnostics <= 1 line and never inside a trace store; a diagnostics sink that itself calls a proxied provider is not traced; shutdown with a failing hand-off still terminates. Storage/query failures (STO) are not covered here | `failure-injection.int-spec.ts` |
| tracingHealth | PASS: exactly the 4 contract fields (`enabled`, `sampleRate`, `instrumentInstalled`, `openTraces`), `instrumentInstalled` only after a proxied instance; `rootsStarted`, `rootsSampledOut`, `tracesDroppedAdmission`, `spansDropped` verified to flow through the sink (the other 4 counters belong to queue/storage/profiler) | `failure-injection.int-spec.ts` |
| T20 (INS seed) | numbers in section 7 | `bench/instrumentation` |

## 4. Shutdown contract (T17, O-2)

Required order, to be wired by LEAD in `onApplicationShutdown`: `stopSweeper()` (earlier, in `beforeApplicationShutdown`) -> `closeAllOpenRoots('shutdown')` -> `await whenCompletionsIdle(timeoutMs)` -> `rollups.shutdown()` -> the writer's final flush with `shutdownFlushTimeoutMs`.

- `closeAllOpenRoots(reason)` closes every open SAMPLED root as `incomplete` (token flipped, `recordRoot` once, completion scheduled). Unsampled roots are not tracked (documented limitation: an unsampled root still running at shutdown is never counted).
- `whenCompletionsIdle(timeoutMs): Promise<boolean>`: `true` when every scheduled completion reached `onTraceComplete` (or failed and was abandoned), `false` on timeout, never rejects (NaN / negative timeout = immediate timeout). Completions scheduled while waiting are awaited too. Its own timer is ref'd and bounded.
- Early pluck (O-2): a closed root's pluck resolves the moment the LAST open span ends; the 1000 ms ceiling remains and is unref'd. Measured: a shutdown-closed root with open spans (150 ms of work left) completed in < 700 ms instead of 1000 ms+; a span that never ends costs exactly the ceiling and is reported as `unfinishedSpanCount` with `isComplete: false`. Worst-case shutdown delay from tracing is therefore `max(ceiling = 1000 ms)` plus mapping time, so LEAD should pass `whenCompletionsIdle(>= 1500)` and keep it inside `shutdownFlushTimeoutMs`.
- Stored shape of a shutdown-closed trace: `trace.status 'incomplete'`, `isComplete false`, root span `status 'incomplete'`, `durationMs` measured to the close, the rollup counts it once as a non-error root; the business promise settling later changes nothing and creates no second trace (asserted).
- Hard kill (SIGKILL, OOM kill, `process.exit()` bypassing hooks): UNSUPPORTED by design. The in-memory queue, open roots, unflushed rollup buckets (up to 10 s of aggregates) are lost and nothing counts them. A separate process cannot be asserted inside the test run, so this is documentation only.

## 5. T06-T08 decision: supported / unsupported (Nest 11.2.8 as installed; gating tests)

| Case | Verdict |
|---|---|
| Singleton DI providers, `useFactory` / `useValue` objects, symbol-keyed methods, plain methods | SUPPORTED |
| Request-scoped providers resolved through a real contextId (`ModuleRef.resolve(Type, ContextIdFactory.create())`, the `injector.loadPerContext` path HTTP/transport request scoping uses) | SUPPORTED: the instance and its request-scoped dependencies are proxied and traced (`RequestFacade.handle > ReqScoped.work > ReqDep.work`). A real HTTP request was NOT tested (no HTTP in this mission); it uses the same injector path, LEAD/M07 should confirm once with an Express app |
| Request-scoped and transient providers obtained by `app.resolve(Type)` WITHOUT a contextId | UNSUPPORTED: not proxied (`types.isProxy` false), no span; business result correct. This explains the M02 "no span" finding: it was specific to `app.resolve()`. Transient providers injected into a singleton were not separately tested |
| `forwardRef` dependencies | PARTIAL: the entry call on the container instance is traced; calls made through the forwardRef-injected reference are NOT (the injected reference is the raw instance) |
| `#private` classes | PARTIAL: entry call traced, nested `this.helper()` is not (raw receiver, by design) |
| Getter properties | not methods, not traced |
| Observable / async-iterable / async-generator returns | UNSUPPORTED beyond return time: the span covers only the call that created the stream (asserted: span < 25 ms while the stream takes >= 40 ms) |
| Non-native thenables | settle at return time (plan 6.2) |

No decorator semantics were changed. The above are documented limitations.

## 6. Ported upstream specs and deviations

All eight listed upstream specs run and pass; every dropped or skipped case is listed with its reason in `FORK_DELTA.instrumentation.md` ("Ported specs"). Summary: `log-redactor` loses the 3 `redactSource` cases; `deferred-trace-completion` loses the 4 helper cases that are not vendored; `operation-trace.registry` loses the HTTP/GraphQL/skipSpans/slice/route/redaction/captureError/logger cases (rewritten against `startRoot`/`endRoot`, 38 tests, `CHANGED` cases labelled); `create-instance-decorator` has 1 dropped case (needs `pg`) and no skips; `hostile-providers` uses a hand-built strict Proxy (no `nestjs-cls` devDependency, no change request) and no HTTP.

**Decorator relabel cases (review L2, resolved).** Vitest's source-map-aware `Error.prepareStackTrace` rewrites frame function names, which hid the `named()` renames (frames read `Proxy.apply` / `call`); the suite now sets `Error.prepareStackTrace = undefined` around each test and all 4 cases run and pass. Two of them also filtered on the upstream file names and could never match; the regexes are fixed. The first case exposed one real (cosmetic) gap: the arrow passed to `runAndSettle` was an unnamed frame; it is now `named(frameName, ...)`. The permanent guard is `decorator-frames.int-spec.ts` (tsc-compiles the decorator to a temp dir and checks the frames in plain node: `UserService.fail`, never `Proxy.`).

## 7. Overhead (indicative only, `artifacts/03_bench_overhead.json`, Node 22.22.0, i5-7400 4 cores, 2 000 warm-up + 20 000 iterations, no threshold)

| Mode | per provider call p50 / p95 / p99 (us) | per message (root + 3 sync calls) p50 / p95 / p99 (us) |
|---|---|---|
| off | 0.1 / 0.1 / 0.2 | 0.3 / 0.4 / 3.2 |
| on-untraced | 0.5 / 0.7 / 10.0 | 1.5 / 2.3 / 6.0 |
| on-traced | 13.3 / 20.5 / 47.1 | 61.3 / 97.4 / 205.8 |

Same as the M02 run within noise (13.1 / 21.0 / 49.3 and 61.1 / 104.0 / 220.5). The bench does not include the rollup hook; a separate micro-timing of `RollupAccumulator.recordRoot` (compiled output, 1 000 000 calls over 50 operations, includes building the event object and the operation-name string) gave about 0.73 us per call, i.e. about 1% of a traced message. Caveats: single machine, Windows, not a CPU-quota environment, caller-side latency only (deferred mapping, pluck and queueing run in timers and are not measured), GC/RSS not measured.

## 8. Limitations and risks

- Method rollups are derived from the MAPPED trace: calls beyond `maxSpansPerTrace` (counted in `droppedSpanCount`) are not in method stats; a collapsed span contributes `collapsedCount` calls at the mean duration (max is the mean) and no error info; `errorCount` counts every span with `status: error` (ancestors that rethrow included), unlike the trace-level `errorCount` (origins only).
- A trace is bucketed by its end time (start + duration), operation rows by settle time; a trace completing after its minute closed still lands in the right (kept) bucket for 2 previous minutes, later ones in the oldest kept bucket.
- Rollup buckets whose `offer` is refused stay dirty and are retried on the next flush; a bucket older than current - 2 minutes is evicted after its last offer attempt. Items with no documents are never offered.
- `RollupAccumulator.recordRoot` uses `Date.now()` for the minute (wall clock); clock steps move buckets. Operation cap: 499 real operations + `(other)` = 500; methods 1999 + `(other)`.
- The cap warning is emitted once per accumulator (not per minute); the plan said "diagnostics log once when the cap is hit".
- Pluck timer unref'd: if the process has nothing else alive, a pending completion never finishes unless `whenCompletionsIdle` (ref'd) is awaited. Normal operation always has the Nest app alive.
- `capRawAttributes` keeps raw attribute strings up to 1024 chars unredacted in memory until the mapper runs (as before, but now bounded).
- The sampler-independent profiler, storage and API were not touched. G0 (host compatibility) is still UNVERIFIED.
- Request-scoped via a real HTTP request, and HTTP/Fastify adapters, are not tested here.

## 9. What LEAD must wire (TraceletModule lifecycle)

1. `onModuleInit`: build `BoundedTelemetryQueue`, `RollupAccumulator({ serviceName, instanceId, offer: (i) => queue.offer(i), warn: (m) => diagnostics.warn('rollup-cap', m) })`, `createBufferHooks({ queue, rollups, mapper })` (mapper = `MapperContext` with the resolved `errorMessages`, a `LogRedactor` built from `redaction.*`, `maxSpansPerTrace`, `spanCollapse`), then `setTelemetryQueue(queue)` and `configureTracing({ enabled, sampleRate, keepFailedRoots, maxRootsPerSecond, maxOpenTraces, maxSpansPerTrace, maxOpenSpans, maxTraceDurationMs, ...hooks })`. Pass the hooks in the SAME `configureTracing` call as the config, before traffic. Since the follow-up, the first call enables tracing (default `enabled: true`) and later calls WITHOUT `enabled` keep the current value, so a hooks-only call can no longer re-enable tracing after a shutdown disable (tested). Per plan 13, errors in `onModuleInit` must leave tracing disabled plus a diagnostic: wrap the wiring in try/catch and call `configureTracing({ enabled: false })` on failure.
2. `onApplicationBootstrap`: `rollups.start()` and `startSweeper()` (both arm unref'd timers outside any trace).
3. `beforeApplicationShutdown`: `stopSweeper()`.
4. `onApplicationShutdown`, in this order: `configureTracing({ enabled: false })` FIRST (roots that start after `closeAllOpenRoots` would never be closed or flushed; with tracing disabled `trace()` is a pass-through; tested in `shutdown.int-spec.ts`), then `closeAllOpenRoots('shutdown')`, `await whenCompletionsIdle(~1500)`, `rollups.shutdown()`, writer final flush (bounded by `shutdownFlushTimeoutMs`), close Mongo.
5. Register `TraceletLifecycle` and every other Tracelet provider with `markInternal` / `static [TRACELET_INTERNAL] = true`.
6. Counters: `setTelemetryQueue(queue)` is what routes `rootsStarted`, `rootsSampledOut`, `tracesDroppedAdmission`, `spansDropped` to the queue; `MetricsCollector` (PRO) reads `queue.counters()`.
7. `/health` and the heartbeat read `tracingHealth()` from `src/context` (the 4 contract fields).
8. Call `resetRuntimeForTesting()` only from tests.
9. Config validation: `maxQueuedControlBytes >= 2 MiB` (plan 9) is enforced by LEAD config, the queue itself accepts any value.
10. Housekeeping: the root `.gitignore` already ignores `node_modules`, which holds the example's compile output; `examples/direct-callback/tsconfig.json` is not part of the package typecheck (the example is type-checked through `tests/integration/instrumentation/example.int-spec.ts`, which imports it).

## 9a. Review follow-ups (Stage 03 review APPROVE-WITH-CHANGES)

| Item | Result |
|---|---|
| M-1 privacy regression | FIXED. `capRawAttributes` slices to 1025 (one over the buffer cap) so `capInput` still drops the trailing partial token. Regression test through the full path (capRawAttributes -> registry snapshot -> mapper -> stored TraceItem) with a 920-char JWT, padding and `mongodb://admin:hunter2secretpassword@...` cut inside the password: stored text has no `hunte`, `admin`, `hunter2`, `mongodb`. Mutation check: with the slice reverted to 1024 (and the length assertion removed) the test fails with `expected '[REDACTED] ...' not to contain 'hunte'`; with the length assertion present it fails earlier on the length. (The first draft of the test used a non-JWT head and was NOT sensitive; it was caught by this mutation check and rebuilt.) |
| M-2 rollup `_id` collisions | FIXED. Methods keyed by `operation.slice(0,256)` only (auto and manual merge), operations by `kind NUL name.slice(0,256)`. Unit test computes the freeze-doc `_id`s (`sha1(operation)`, `sha1(operation NUL kind)`) and asserts uniqueness incl. both collision cases. Mutation checks: restoring the `origin|operation` method key fails 2 tests; removing the 256 cut on operations fails the new test |
| L1 | Report section 9 corrected (warn key, same-call hooks, disable-first shutdown order, onModuleInit failure rule). Runtime change: `configureTracing` keeps the previous `enabled` on calls that omit it (new `configured` flag). Tests: shutdown-order test in `shutdown.int-spec.ts` |
| L2 | See section 6 |
| L3 | T17 headline test drains the queue directly after `whenCompletionsIdle` (mutation `whenCompletionsIdle` always returning true: headline test and 5 others fail; 6 failed / 8 passed); new test that a wait does not wake at the first of two completions (second scheduled while waiting; waited >= 170 ms, both traces drained); rollup timer armed outside any trace (start() inside a trace store; callbacks see no store); registry-snapshot bound asserted for `capRawAttributes` (verified by the 1025 cap and 16-key checks on the snapshot); rollups.spec comment fixed; useFactory (`FactoryMade.work`) and useValue (`Object.work`) probe added to edge-providers |
| L4 | `whenCompletionsIdle(Infinity)` waits (clamped to `MAX_IDLE_WAIT_MS` = 2^31-1 ms, exported); 1e15 clamped; no `TimeoutOverflowWarning`; NaN or negative = immediate timeout. Tested |
| L5 | `capRawAttributes` scans at most 64 keys (tested with 64 rejected keys then a valid one, and a proxy with 100 000 keys: <= 64 reads) |
| L6 | `TRACELET_RUNTIME_ABI` bumped 1 -> 2 (slot runtime gained `idleWaiters`, `configured`); als-abi test updated; policy (bump on ANY slot shape/behaviour change) written in `als.ts`, PIN.md and FORK_DELTA |
| L7 | `resetRuntimeForTesting()` removed from the example; it ends with the documented shutdown order starting with `configureTracing({ enabled: false })` |
| L8 | Method rollup `errorCount` means **calls that ended in error**, rethrowing ancestors included. It must NOT be summed across a call chain to get a number of failures (one failure shows up once per frame it propagated through); STO/DSH must label it "calls ending in error" and use the trace-level `errorCount` (origin spans) or the operation rollup `errorCount` for failure counts |
| L9 | Commit hygiene: orchestrator |

### Results after the follow-ups (all executed)

tsc exit 0; eslint exit 0; example tsc exit 0; unit 21 files / 355 passed (Node 22.22.0, 20.19.5, 24.22.2); integration + contract 24 files / 122 passed (all three Node versions); 10x loop of t02, h6, r1, m7, shutdown, span-budgets: 10/10, 6 files / 56 tests each; `artifacts/02_*.json` restored with `git checkout --` afterwards.

## 10. Contract deviations / change requests

None. No file in `src/contracts` or the kit contracts was modified. No devDependency was added (nestjs-cls and pg cases handled without them).
