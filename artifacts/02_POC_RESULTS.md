# 02 — POC results, Mission 02 slice A (instrumentation + LEAD scaffold)

Author: tracelet-implementer (Sonnet), 2026-10-29. Worktree `D:\codeShit\Tracelet-wt\m02`, branch `tracelet/m02-poc`. **Nothing is committed.**
Scope of this slice: LEAD scaffold + INS files (`src/shared`, `src/context`, `src/instrumentation`, `src/buffer/{self-time,record-mapper,error-sanitizer,telemetry-queue,attributes}.ts` + `buffer/vendor/collapse-repeated-spans.ts`) + the INS POC tests and benchmark.
**Not in this slice (slice B / later):** profiling (T09, T10, T18, `bench/profiling`), Mongo, HTTP, UI, `buffer/{histogram,rollups}.ts`, ported upstream specs (plan 3.12 list), `tests/integration/instrumentation/*` (Mission 03).
Gate G0 (host compatibility) remains UNVERIFIED (D1 deferred); everything here is proven on the stated baseline in a fixture app.

## 1. Environment

| Item | Value |
|---|---|
| OS / CPU | Windows 10 Home 10.0.19045, Intel Core i5-7400 @ 3.00 GHz, 4 cores |
| Node (default) | v22.22.0 (`process.config.variables.v8_enable_inspector` = `1`) |
| Node 20 floor | v20.19.5 via `npx -y -p node@20.19.5` (worked, no fallback needed) |
| Node 24 | v24.22.2 via `npx -y -p node@24` (worked, AsyncContextFrame) |
| npm | 10.9.4 |
| Key dev deps resolved | `@nestjs/core` / `common` 11.2.8, `vitest` 4.1.12, `typescript` 5.9.3, `eslint` 9.39.5, `unplugin-swc` 2.x, `rxjs` 7.8.x, `reflect-metadata` 0.2.x |
| Upstream | `nestjs/observe@7500fba7f61f4d0e177e415b291ec6d4d366b052` (read-only `D:\codeShit\Tracelet-refs\observe`) |

## 2. Commands run and results (all run by me; counts are from the vitest summary lines)

All from `D:\codeShit\Tracelet-wt\m02` unless a `cd` is shown. Install: `npm install --legacy-peer-deps` (first time, creates the lockfile), then `Remove-Item node_modules; npm ci` (**passed**, 186 packages, with `.npmrc` `legacy-peer-deps=true`, see deviation D1).

| # | Command | Result |
|---|---|---|
| 1 | `npm run -w packages/tracelet typecheck` (`tsc -p tsconfig.json --noEmit`) | exit 0, no diagnostics |
| 2 | `npm run -w packages/tracelet lint` (`eslint src tests bench`) | exit 0, no findings |
| 2b | lint negative control: temporary files `src/{profiling,context,shared,instrumentation}/neg.ts` importing a forbidden module | 4 `no-restricted-imports` errors reported (files removed afterwards) |
| 3 | `cd packages/tracelet; npx vitest run --config vitest.config.mts` | **8 files, 92 tests passed** (telemetry-queue 18, self-time 9, error-sanitizer 12, record-mapper 14, rollup-once 5, redaction-cpu 20, als-abi 2, key-material 12) |
| 4 | `npx vitest run --config vitest.int.config.mts tests/integration/poc --reporter=verbose` | **11 files, 54 tests passed** (Node 22.22.0), 25 s |
| 5 | `npx vitest run --config vitest.int.config.mts tests/contract` | **1 file, 4 tests passed** |
| 6 | `npx vitest run --config vitest.int.config.mts bench` | **1 file, 1 test passed** (writes `artifacts/02_bench_overhead.json`) |
| 7 | 10x loop of `t02`, `h6`, `r1`, `m7` files (PowerShell `for ($i=1;$i -le 10;$i++)`, plan 16 command) | **10/10 runs green, each 4 files / 33 tests**; no flake observed |
| 8 | `npx -y -p node@20.19.5 -- node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts tests/integration/poc` | **11 files, 54 tests passed (unit: 8 files / 92 tests) on v20.19.5** (verified: the edge-provider artifact records `nodeVersion v20.19.5`) |
| 9 | `npx -y -p node@24 -- node ../../node_modules/vitest/vitest.mjs run ...tests/integration/poc` | **11 files, 54 tests passed on v24.22.2** (unit: 8 files / 92 tests) (artifact records `v24.22.2`) |
| 10 | `tsc -p tsconfig.build.json` then `node -e "require('./dist/context/index.js') ..."` | CJS build emits; smoke `trace('smoke', () => 7)` returned 7 and produced one snapshot (dist removed afterwards) |
| 11 | `node -p "process.config.variables.v8_enable_inspector"` | `1` |

Mutation controls (to show the tests are not vacuous; each mutation was reverted, typecheck re-run green):
- `ignoreFailure` rethrowing instead of swallowing: `m7` + `r1` = **4 failed**, 22 passed.
- JOIN-IF-OPEN ignoring `token.open`: `h6` = **3 failed** ((a) x2, (e) sweeper), 7 passed.
- Removing the decorator's L-a token check alone: `h6` still 10/10 green. This is expected, not a gap: the registry also refuses new spans once a root is `closed` (second line of defence), so the outcome is identical. The decorator check is kept as planned (4 row 1 e).

## 3. Results per test

| Test (file in `tests/integration/poc/`) | Status | Notes |
|---|---|---|
| T01 `t01-direct-root` (2 tests) | PASS | bare root (no providers, the upstream gap `registry:294-309`) and a full tree: 7 spans, `spanCount` 7, `currentTraceId()` inside == stored `traceId`, undefined after |
| T02 `t02-concurrency` n=25 and n=100 | PASS | distinct `traceId`s, own-root ancestor chains, exact 7-path span set per message, unique `msgId` attributes, `currentTraceId()` stable across awaits and `undefined` afterwards, all span ids globally unique |
| T03 `t03-nesting` (3) | PASS | sync, async-across-awaits, and the exact orders tree; offsets ordered and children inside parents |
| T04 `t04-promise-all-self-time` | PASS | two overlapping 20 ms children under `Parent.run` (which burns 5 ms synchronously): parent self in [3, 12] ms (union, not double subtraction). Timing-based; sensitive to a heavily loaded host (never failed in 10+ runs) |
| T05 `t05-errors-ack-parity` (4) | PASS | ordered ack/nack log `[ack:a-ok, nack:b-async-fail, nack:c-sync-fail, ack:d-ok]` and per-message outcomes identical disabled vs enabled; `rejected === thrown` and sync `caught === thrown` by reference in both modes; origin span has `sanitizedError`, ancestors `status:'error'` without payload, `errorCount === 1`, trace `status:'error'` + fingerprint |
| H6 `h6-stale-context` a-g (10 tests) | PASS | (a) AsyncResource and a real loopback `net` socket pair created inside `trace('setup')` deliver after close: precondition asserted (the callback runs in a store whose token is `open:false`), every message gets a fresh root with its full 7-span tree, `setup` has 1 span; (b) nested `custom` becomes a `manual` child; (c) `forceRoot` separate root; (d) unsampled outer (`sampleRate` 0 then 1): plain nested joins the unsampled root (no trace), `forceRoot` nested is a separate sampled root; (e) sweeper-closed sampled outer and deadline-expired unsampled outer: later nested `trace()` starts fresh roots, and the late settle emits no second trace; (f) synchronous delivery inside setup: `kind:'rabbitmq'` is its own root per delivery, `join:true` is a `manual` child span of setup; (g) provider call from the stale store inside the pluck window and from a force-closed root with a held snapshot produces no span, while the span started before settle (fire-and-forget `Repo.find`) still ends and is kept. **Upstream behaviour change confirmed**: late un-awaited provider calls after settle are untraced |
| R1 `r1-joined-span-settle` (3) | PASS | sync value identity (no promise introduced), sync throw identity, plain-promise rejection identity (chained promise), resolve value, `Promise` subclass and own-property promise returned as the same object, non-native thenable returned untouched; with `startManualSpan` throwing and, separately, `endManualSpan` throwing, `fn` is called exactly once and results are identical |
| M7 `m7-fail-open` (18) | PASS | each of `startRoot`, `endRoot`, `internalStartTraceStep`, `internalEndTraceStep`, `startManualSpan`, `endManualSpan`, `pluckSnapshot` throwing on every call (with an assertion that the injected failure was actually called), a throwing counter sink, and a throwing `onTraceComplete` hook: ack log, outcomes and thrown references identical to the disabled run; active flag not stuck after recovery (4 cases: next call fully traced, 7 spans); a throwing `skipInstrumentation` and a Proxy provider whose `getPrototypeOf` throws still boot `createApplicationContext` |
| R11 `r11-instrument-enable` (9) | PASS | unset/`production`/`staging`/`prod`/empty NODE_ENV untouched (`===`); `TRACELET_DISABLED=1` wins over `enabled:true` + `TRACELET_ENABLED=true`; `enabled:false` untouched under `test`; `test`/`development` or `enabled:true` or `TRACELET_ENABLED=true` proxied; decision re-evaluated at every decoration; `skipInstrumentation` honoured, throwing = skip |
| egress `egress-none` | PASS | spies on `net.Socket.prototype.connect`, `tls.connect`, `http.request`, `https.request`, `globalThis.fetch`, `dns.lookup`: zero calls during a 22-message scenario with errors |
| T06-T08 `edge-providers` | RECORDED (not gating) | see section 5 |
| T20 seed `bench/instrumentation/overhead` | RECORDED | see section 6 |
| T09, T10, T18 (profiler) | NOT RUN | PRO / slice B |
| contract `contracts-sync` | PASS | 3 copies equal to the kit files and to the SHA-256 recorded in the freeze doc (compared after CRLF to LF normalisation, see D5) |
| flaky | none observed | 10/10 repetitions of t02/h6/r1/m7 and 3 full-suite runs on Node 22 (+1 each on Node 20 and 24) |

## 4. Observed trace output for a sample message (redacted; produced by a temporary test, then deleted)

Message `m-1` through the fake channel, `trace('rabbitmq.consume', ..., { kind: 'rabbitmq', attributes: { queue: 'orders', token: 'abc-secret' } })`, Node 22. Ids shortened, durations rounded to 0.1 ms. The attribute with a sensitive key name is masked:

```
trace: operation rabbitmq.consume, kind rabbitmq, status ok, spanCount 7, errorCount 0, isComplete true, detail full,
       sampleRate 1, droppedSpanCount 0, unfinishedSpanCount 0, durationMs 49.2, attributes { queue: "orders", token: "[REDACTED]" }
span 01a186ad..0d9f  parent null          rabbitmq.consume          root   off 0.0   dur 49.2 self 1.7
span 01a186ad..12ad  parent ..0d9f        OrdersConsumer.process    auto   off 1.4   dur 47.5 self 0.8
span 01a186ad..1a0c  parent ..12ad        Validator.validate        auto   off 1.9   dur 31.3 self 16.4
span 01a186ad..24d9  parent ..1a0c        Transformer.execute       auto   off 18.2  dur 14.9 self 14.9
span 01a186ad..3901  parent ..12ad        OrdersService.handle      auto   off 33.4  dur 15.5 self 0.2
span 01a186ad..847f  parent ..3901        Repo.find                 auto   off 33.6  dur 15.3 self 15.3
span 01a186ad..3848  parent ..3901        Repo.find                 auto   off 33.9  dur 15.1 self 15.1
```

Failing message `m-2` (error created with `db down at mongodb://svc:p4ss@db.internal:27017 for bob@example.com`): trace `status: error`, `spanCount 4`, `errorCount 1`, `errorFingerprint 1d2da1b30a930e35`, `error.message` = `db down at mongodb://[REDACTED]@db.internal:27017 for [EMAIL]`, stack frames relative to cwd (`at fn (tests/integration/poc/zz-sample.int-spec.ts:11:101)`, ...). `sanitizedError` only on `Transformer.execute`; `Validator.validate`, `OrdersConsumer.process` and the root have `status: error` and no payload.

## 5. Edge-provider behaviour (T06-T08, recorded; identical on Node 20.19.5, 22.22.0 and 24.22.2; raw data `artifacts/02_edge_providers.json`)

| Case | Business result | Observed tracing |
|---|---|---|
| `forwardRef` A<->B pair, singleton | correct | the entry call (`FwdA.callB`, `FwdB.callA`) is a span; the nested call through the **forwardRef-injected dependency is NOT traced**: that injected reference is the raw instance (`util.types.isProxy` false), the singleton obtained from the container is a Proxy (true) |
| Request-scoped provider (`app.resolve`) | correct | **no span**: the instance is not a Proxy; Nest 11.2.8 does not hand it to the instrument hook (or `app.resolve` bypasses it) |
| Transient provider (`app.resolve`) | correct | **no span**, same as request-scoped |
| Class with `#private` members | correct | `PrivateKeeper.run` traced; the nested `this.helper()` is not (raw receiver, as designed) |
| Symbol-keyed method | correct | traced, operation `Exotic.Symbol(edge.symMethod)` |
| Getter property | correct | not a method, not traced |
| Plain method on the same class | correct | traced |
| Observable return | correct | span `Streams.observable` ends at return time (0.6 ms) while the subscription takes ~30 ms: **unsupported**, as planned |
| Async-iterable / async generator return | correct | span `Streams.iterate` ends at return time: **unsupported**, as planned |

## 6. Benchmark (`bench/instrumentation/overhead.int-spec.ts`, Node 22.22.0, i5-7400; 2 000 warm-up + 20 000 iterations; written to `artifacts/02_bench_overhead.json`; no threshold)

Caller-side latency in microseconds (deferred mapping and pluck run in timers and are not in these numbers). `on-untraced` = proxies installed, tracing runtime disabled (every provider call takes the no-store untraced path). `on-traced` = inside a sampled root.

| Mode | per provider call p50 / p95 / p99 | per message (root + 3 sync provider calls) p50 / p95 / p99 |
|---|---|---|
| off | 0.1 / 0.1 / 0.6 | 0.3 / 0.4 / 3.1 |
| on-untraced | 0.6 / 0.7 / 10.0 | 1.6 / 2.3 / 5.5 |
| on-traced | 13.1 / 21.0 / 49.3 | 61.1 / 104.0 / 220.5 |

Stage 00 indicative 0.17 / 0.80 / 19.8 µs per call: off and on-untraced agree; on-traced is lower in p50 (13.1 vs 19.8 µs) on this CPU. A traced message with three sync provider calls costs about 60 µs on the caller side, dominated by root creation (uuidv7 x4, two Map allocations, registry bookkeeping). Not a pass/fail result.

## 7. Unsupported or partial coverage (observed or by design)

- Request-scoped and transient providers, and dependencies injected through `forwardRef`, are not proxied (section 5). Singleton DI instances, `useFactory`/`useValue` objects and standalone functions are.
- Observables and async iterables end their span at return time.
- Nested `this.x()` calls inside `#private` / slot-backed classes are not traced.
- Provider calls made after the root settled (fire-and-forget) are untraced; spans started before settle are kept (documented behaviour change vs upstream).
- Pluck waits the full completion timeout (default 1000 ms) whenever any span is still open at root end (upstream behaviour: a fixed `setTimeout`, not "until spans end"). A root with a fire-and-forget child therefore holds its snapshot (and occupies `maxOpenTraces`) for the full second. Worth a decision before Mission 03 (poll for completion instead).
- No HTTP auto-roots, no outgoing-call spans, no per-trace CPU, no rollups/histograms yet (all by plan).
- Origin-error `stack` frames include Tracelet wrapper frames (`runAndSettle`, `root-runner`) below the application frames when the error was created inside a traced call; the 20-frame cap bounds it. Cosmetic; a frame filter for the package's own directory is a possible follow-up.

## 8. Deviations from the frozen plan and contracts (no contract file was changed; the three contract copies equal the kit files)

| # | Deviation | Why / impact |
|---|---|---|
| D1 | Added root `.npmrc` with `legacy-peer-deps=true` | `npm install` with npm 10.9.4 crashes (`Cannot read properties of null (reading 'edgesOut')`, arborist) on vitest 4's optional peers. With the flag, `npm install` and `npm ci` both work. LEAD should keep it or pin a newer npm |
| D2 | Root `workspaces` lists only `packages/tracelet` | `packages/tracelet/ui` and `examples/nest-worker` do not exist yet; LEAD adds them when they do |
| D3 | `endRoot(key, error?, failed = error !== undefined)`, `internalEndTraceStep(..., error?, failed = error !== undefined)` and `endManualSpan(key, spanId, error?, failed = error !== undefined)` carry an explicit `failed` flag as the LAST parameter, so the plan's `endRoot(key, error?)` argument order is kept (R-6; my first version reordered it) | a falsy thrown value (`throw undefined`) must still be an error; additive |
| D4 | Context hand-off hooks are fields of the tracing config: `TracingRuntimeConfig.onTraceComplete(snapshot)` (buffer hand-off, outside any trace) and `onRootSettled(event)` (rollup hook, exactly once per root). `src/context/completion.ts` (scheduleCompletion/scheduleSnapshot) is an extra small file | plan said "injected function" without naming it. LEAD wiring: `configureTracing({ ..., onTraceComplete: snap => queue.offer(toTraceItem(snap, ctx)), onRootSettled: ... })` plus `setTelemetryQueue(queue)` |
| D5 | `contracts-sync` compares after CRLF to LF normalisation | with `core.autocrlf=true` a Windows checkout turns the git blob (whose SHA-256 the freeze doc records) into CRLF; the committed blobs are LF-identical to the kit files |
| D6 | The registry stores a raw (unredacted, capped) error payload; redaction/relativisation happen in `buffer/error-sanitizer.ts` | plan 3.7 places sanitisation in buffer; upstream redacted inside the registry |
| D7 | Extra test artifact `artifacts/02_edge_providers.json` (written by the edge test) | holds the T06-T08 raw record |
| D8 | `import 'reflect-metadata'` added to the vendored decorator; `createDiagnostics` takes an injectable sink | typings for `Reflect.getMetadata*`; testability |
| D9 | `LICENSE` for Tracelet itself not created; `package.json` says `MIT`; `THIRD_PARTY_NOTICES.md` carries a TODO for the copyright holder name | per instruction (no invented name) |
| D10 | Ported upstream specs, `rollups.ts`, `histogram.ts`, `control-pool.spec.ts` (injected-clock outage test) not written | outside the assigned slice; queue caps, coalescing, eviction and counter folding are unit-tested in `telemetry-queue.spec.ts` |

## 9. Exit-criteria status (plan 16) for the INS half

| Criterion | Status |
|---|---|
| T01-T05, H6 a-g, R1, M7, R11, egress pass on Node 22 and on 20.19.x | PASS (22.22.0, 20.19.5) |
| 24.x run | PASS (24.22.2) |
| 10/10 repetitions green | PASS |
| bench recorded | DONE (INS half; the profiler bench is PRO) |
| edge-provider behaviour recorded | DONE |
| fork delta and LICENSE committed with the first vendored file | files exist in the worktree (`third_party/nestjs-observe/{LICENSE,PIN.md,FORK_DELTA.instrumentation.md}`); they must go into the same commit as the vendored sources (not committed by me) |
| no unbounded buffer (queue caps asserted in a unit test) | PASS (`telemetry-queue.spec.ts`: 100 000-trace flood stays at the caps; control pool caps hold over 500 mixed offers) |
| T09, T10, T18 | NOT RUN (slice B) |


## 10. Review round 1 (APPROVE-WITH-CHANGES): per-item results

All re-verified with the commands in section 2 after the changes (typecheck exit 0, lint exit 0, unit 7 files / 80 tests, poc 11 files / 54 tests, contract 4, bench 1, 10x loop 10/10 at 33 tests per run, Node 20.19.5 and 24.22.2: poc 54/54 and unit 80/80). Mutation controls re-run for R-1, R-2 and R-5 (each new test fails when its fix is reverted).

| Item | Result |
|---|---|
| R-1 | FIXED. `runAndSettle` guards result detection and the side branch; a throw there means "plain value": `onOk` runs, value returned. New M7 test returns a Proxy whose `getPrototypeOf` throws from a root, a joined span and a provider call: values identical, trace emitted, registry empty. |
| R-2 | FIXED. The get trap reads `attributeValue` once outside the guard; the catch and the non-proxied path return it. New test: plain and throwing getter each run exactly once, original error thrown. FORK_DELTA item (c) updated. |
| R-3 | FIXED. Split into (i) throwing `skipInstrumentation`: instances untouched (`isProxy` false), and (ii) non-throwing skip plus a hostile-prototype provider: boots, `types.isProxy(app.get(Plain))` is true. |
| R-4 | FIXED. Input caps before redaction (message 2048, frame line 512, attribute 1024; constants documented), linear URI and e-mail rules (leading lookbehind), PEM rule replaced by a linear scan (the bounded regex was still 59-65 ms on 64 KB, flaky), root-origin errors sanitized once (shared payload plus cache). New `redaction-cpu.spec.ts`: 15 adversarial 64 KB inputs, each rule < 50 ms; sanitizer and attributes < 50 ms; coverage tests show the rules still redact. The old e-mail and URI regexes measured 5.1 s and 3.1 s on 64 KB of `a.` here. FORK_DELTA updated. |
| R-5 | FIXED. A refused `startRoot` now yields a fresh unsampled root plan and counts `tracesDroppedAdmission`. Test with `maxOpenSpans: 1`: the rabbitmq delivery inside `setup` sees `currentTraceId() === undefined`, reaches `onRootSettled` (sampled=false) and the counter is 1. |
| R-6 | FIXED. `endRoot(key, error?, failed = error !== undefined)`; callers and D3 text updated. |
| O-1 | DONE. `operation` clamped 1..256, `className`/`method` 1..128 with placeholders (`Anonymous`, `anonymous`, `(unnamed)`). `record-mapper.spec.ts` validates mapper output against `telemetry.schema.json` (`Trace` and `Span` defs, ajv 2020, devDeps `ajv` and `ajv-formats` added to the lockfile) for ordinary, error, collapsed, rootOnly and force-closed traces; anonymous class does not yield `''`. |
| O-1b | DONE. Stack header (name + message, possibly multi-line) is cut before frame extraction: a message line starting with `at ` is never stored, tested for `omit` and `redacted`. |
| O-1c | DOCUMENTED + test. Error-origin identity: objects by reference, primitives by value (two unrelated `throw 'x'` count as one origin). |
| O-3 | DONE. The M7 scenario now calls a sync provider (`Validator.validateSync`) on the ok path, so `internalEndTraceStep` failing is exercised for a sync return. |
| O-4 | DONE. `tests/unit/shared/als-abi.spec.ts`: same ABI shares slot and ALS; different ABI: not shared, one `emitWarning`, first slot untouched, `trace()` is a pass-through, `configureTracing` no-op, instrument returns instances untouched. |
| O-4b | DONE. `BoundedTelemetryQueue(limits, warn?)` logs an oversize control item once (counted every time); a throwing warn hook is swallowed. Test added. |
| O-5 | DOCUMENTED in FORK_DELTA.instrumentation.md ("Notes for the README"). |

## 11. Known follow-ups (deferred to Mission 03, not implemented)

**O-2 must be carried to M03/LEAD BEFORE the shutdown wiring is written** (shutdown-closed roots with open spans wait the full pluck timeout and can miss the final flush).

- O-2: early pluck resolve (stop waiting as soon as all spans ended), unref'd pluck timer, and `whenCompletionsIdle(timeoutMs)` for the LEAD shutdown path: shutdown-closed roots with open spans currently wait the full 1 s and can miss the final flush.
- Cap the raw `TraceOptions.attributes` copy at root start (`root-runner.ts`, currently a shallow copy of whatever the caller passes; bounding happens in the mapper).
- Replace the side-effect `import 'reflect-metadata'` in the vendored decorator with `/// <reference types="reflect-metadata" />`.
- Check whether the request-scoped / transient "no span" result is specific to `app.resolve()` (Nest creating those instances per context) or applies to HTTP/transport-resolved instances too.

## 12. Review round 2: N-1, O-a, O-b

| Item | Result |
|---|---|
| N-1 (Medium) | FIXED. `redactPem` redacts a BEGIN without END from the BEGIN to the end of the text (still a linear scan). The assertion that expected the leak was flipped (`'-----BEGIN PRIVATE KEY----- no end here'` now gives `[REDACTED]`). New `tests/unit/buffer/key-material.spec.ts` uses real keys from `crypto.generateKeyPairSync` (RSA PKCS8): a 4096-bit key in an error message under `errorMessages: 'redacted'`, a key at the start of the message, a key cut mid-body by the cap, and 2048-bit and 4096-bit keys as attribute values (plain and wrapped). Every stored output is asserted free of any 40+ character base64 run and of the `MII` prefix. Reverting the fix makes 6 tests fail. |
| O-a (Low) | FIXED. `capInput` drops the trailing partial token when a cut happened (used for messages, frame lines and attribute strings). Test: a 2048-bit PEM followed by `mongodb://admin:hunter2@...` with the 2048 cut falling inside `admin`: the stored message contains no `mongodb`, `admin`, `hunter2` or key material. Plus `capInput` unit cases. Reverting makes 2 tests fail. |
| O-b (Low) | FIXED. The registry records `headerLines` before capping the message; the sanitizer skips that many lines. Tests: a message over 8192 chars with an `at ` line after the registry cut, and a 400-character class name, both under `omit`, store no message line; the hand-built-payload fallback is also tested. Reverting makes the long-message test fail. |


## 13. Slice B (PRO sampler POC): final status after investigation (keep-alive, CR-001) and review round

Author: tracelet-implementer (Sonnet), 2026-10-29. Not committed. Files: `src/profiling/{vendor/{cpu-sampler,fold-profile}.ts,inspector-probe.ts,profile-mapper.ts,profiler.service.ts,index.ts}`, `third_party/nestjs-observe/FORK_DELTA.profiling.md`, `tests/unit/profiling/*`, `tests/integration/poc/{t09,t10,t18}-*`, `tests/integration/profiling/keepalive-heap.int-spec.ts`, `tests/support/profiling/*`, `bench/profiling/sampler-overhead.int-spec.ts`. Not done (Mission 06): `metrics-collector.ts`, `vendor/runtime-metrics.ts`, `vendor/node-runtime-metrics.interface.ts`. The sampler mechanism is the keep-alive of `docs/tracelet-handoff/change-requests/CR-001-profiler-rotation-keepalive.md` (draft; the orchestrator approves).

### 13.1 Final results (after the keep-alive and the review-round changes)

| Check | Node | Result |
|---|---|---|
| typecheck, lint | 22.22.0 | exit 0, exit 0 |
| unit suite | 22.22.0 / 20.19.5 / 24.22.2 | 12 files, **153 / 153 / 153** passed (profiling unit tests: 4 files, 61 tests) |
| `tests/integration` (poc + profiling) + `tests/contract` | 22.22.0 | 16 files, **67 tests passed** (T09 1, T10 1, T18 5, keep-alive heap 2, contract 4, the 54 earlier poc tests) |
| T09 + T10 + T18 + keep-alive heap test | 20.19.5 / 24.22.2 | 4 files, **9 tests passed** on each |
| T09 (30 s CPU + allocation, 12 000 generated functions, windowMs 5000, 99 Hz) | 22.22.0, 10 consecutive runs | **10/10 passed**; every run 6/6 gaps contiguous, max gap 8.9-20.3 ms, coverage 0.9982-0.9990, start stall max 0.22-0.32 ms, stop max 1.30-1.54 ms, fold max 2.85-3.07 ms, 0 backoffs |
| T09 final per-version run (log `artifacts/02_t09_run.final.node{20,22,24}.json`) | 20.19.5 / 22.22.0 / 24.22.2 | 6/6 contiguous each; max gap 10.5 / 11.5 / 11.7 ms; coverage 0.9986 / 0.9986 / 0.9990; start p50/max 0.26/0.46, 0.15/0.35, 0.15/0.32 ms; stop p50/max 1.72/8.90, 1.22/1.60, 1.46/5.28 ms; fold p50/max 2.12/3.04, 1.73/3.00, 2.18/3.82 ms |
| T10 (30 s idle) final per-version run | 20.19.5 / 22.22.0 / 24.22.2 | 6/6 contiguous; max gap 10.4 / 9.6 / 10.6 ms; coverage 0.9993 / 0.9991 / 0.9993; idle samples > 0 in every window; state running |
| T09/T10 added assertions | all | `debug.keepAlive === 'active'`; no stored frame holds an absolute path, drive letter, backslash, `../` or the OS user name |
| keep-alive heap regression (`artifacts/02_keepalive_heap*.json`, Node 22, 150 MB heap, 3 rotations at 1200 ms) | 22.22.0 | with keep-alive: start stall 0.13-0.20 ms (asserted max < 20 ms); opted out (plain stop/start): start stall 275-290 ms, stop 14-15 ms (recorded, unasserted) |
| 10x loop of the light profiling unit tests (earlier round, 33 tests) | 22.22.0 | 10/10 green; not repeated for the 61 tests of this round (the new tests were run once per Node version above) |

The T09 bound (gap <= 250 ms, >= 5 of 6, coverage >= 0.95), `maxStallMs` 250 and every other threshold are unchanged. The contract files were not touched. The keep-alive option is internal/debug-only (`createKeepAlive`), not a `profiling.*` config field (the frozen config contract has no such field).

### 13.2 Review-round items

- M1: default keep-alive off under `NODE_V8_COVERAGE`, `--cpu-prof`/`--cpu-prof-*` in execArgv or NODE_OPTIONS and with injected sessions; per-window `keepAliveMs`; backoff reason hints "another inspector session has the Profiler enabled" when the keep-alive cost dominates. Unit-tested.
- M2: `sanitizeFramePath` (no absolute paths, drive letters, UNC, user names, URL queries stored). The T09 fixture lives in `C:/Users/User/AppData/Local/Temp` while cwd is on `D:`; its frames are now `<external>/code-heavy.cjs:LINE`. The CpuProfile frame format (`fn relpath:line`) still validates against `telemetry.schema.json` (mapper unit tests).
- M3: `ProfilerDebug.keepAlive` (`active`/`off`/`failed`, debug only, no contract change) plus the heap regression test above.
- M4: this section, the CR memory correction and soak (13.4).
- L1 (onWindow throw tears down before onError), L2 (initial-start/resume cost counters, documented), L3 (retry budget restored after 10 healthy windows), L4 (negative raw gaps counted), L5 (orderly stop never reports an error or retries), L6 (host `console.profile` note in the fork delta): done with unit tests.
- L7: the profiler bench cannot resolve overhead below roughly 10 %; no overhead claim is made from it (below).

### 13.3 Bench (Node 22.22.0, 12 000 functions, 16 s per run, off/on/off/on after a discarded warm-up; post-fix numbers, `artifacts/02_bench_profiler.json`)

Throughput 9 553.1 (off) vs 10 438.3 (on) work units/s: +9.27 %, which is run-to-run noise or an ordering effect, not a speed-up; **no overhead claim is made** (the harness cannot resolve differences below about 10 %). ELU 1 in both (CPU-bound loop). Event-loop delay p99 5.79 / 6.77 ms (off) vs 5.49 / 5.50 ms (on); max 17.69 / 39.85 ms (off) vs 34.87 / 6.95 ms (on). Stall series over the 6 rotations of the on runs: start 0.12-0.46 ms (p50 0.14), stop 1.45-1.65 ms (p50 1.52), fold 1.94-3.56 ms (p50 2.24). NOT RUN on Node 20 or 24.

### 13.4 Natural-GC soak (keep-alive vs plain stop/start), review M4

Script in the scratchpad (not committed), compiled `dist` of the package, `node --expose-gc`, **no forced GC during the run**; one forced full GC after it. Both modes ran concurrently for 5 minutes on the same host (Node 22.22.0, windowMs 1000, `maxStallMs` disabled to avoid backoff, rolling ~100 MB retained set, short-lived garbage, 20 `new Function` per tick). Raw: `artifacts/02_soak_keepalive.json`, `artifacts/02_soak_plain.json` (10 s samples).

| | keep-alive | plain stop/start |
|---|---|---|
| rotations in 5 min | 297 | 180 |
| start stall p50 / max | 0.11 / 20.9 ms | 632.5 / 1670.6 ms |
| stop stall p50 / max | 0.46 / 4.0 ms | 10.7 / 27.8 ms |
| RSS, mean 30-90 s to last 90 s | 470.2 to 473.2 MB | 428.9 to 455.1 MB |
| heapUsed, same | 221.3 to 214.6 MB | 179.2 to 229.8 MB |
| heapTotal, same | 254.2 to 274.5 MB | 221.0 to 260.9 MB |
| after final full GC: heapUsed / non-heap / RSS | 68.4 / 362.4 / 465.7 MB | 66.8 / 349.1 / 453.4 MB |

Reading: no growth trend in keep-alive mode over 5 minutes; the post-GC difference is about 12-13 MB of non-heap memory. Caveats: the modes did different amounts of work (plain is slowed by its own stalls), 5 minutes cannot exclude slower growth, and the investigator's earlier 150 s harness (heavier churn, forced GC off) showed RSS 206 to 1295 MB and, after a full GC, heapUsed 53 MB and non-heap 208 MB (keep-alive) against 28 MB and 105 MB (plain): retained profiler state, not a proven leak. The earlier "154-162 MB RSS plateau" claim was measured with `global.gc()` forced every window and is withdrawn (CR-001 corrected).

### 13.5 History: pre-fix results (plain stop/start, kept for the record)

| Check | Node | Result |
|---|---|---|
| T10, T18 | 22 / 20 / 24 | passed (T10 gaps 26-40 ms, coverage 0.992-0.994) |
| T09 | 22.22.0 | passed narrowly (6/6, max gap 248.1 ms, coverage 0.9600; start stall 177-220 ms); `artifacts/02_t09_run.node22.json` |
| T09 | 20.19.5 | **failed**: 3 of 5 gap-bearing windows contiguous, coverage 0.826; backoff fired at start 247 + stop 51 + fold 2 = 299 ms > 250 for 3 windows; `artifacts/02_t09_run.node20.json` |
| T09 | 24.22.2 | **failed**: 0 of 4, gaps 290-439 ms, coverage 0.812, two backoffs (start stall 253-396 ms); `artifacts/02_t09_run.node24.json` |
| Bench (pre-fix) | 22.22.0 | throughput 9 724.7 vs 10 234.7 units/s (+5.2 %, same caveat), event-loop max 16-19 ms (off) vs 199-202 ms (on), stall series start 155-167 ms, stop 27-32 ms, fold 1.9-3.8 ms |
| Intermediate keep-alive runs (investigation) | 20 / 22 / 24 | `artifacts/02_t09_run.keepalive.node{20,22,24}.json`, `02_t10_run.keepalive.node{20,22,24}.json` |

Root cause and the fix are in CR-001: `Profiler.stop` disposes the V8 CpuProfiler when the started-profile count reaches 0 and the next `Profiler.start` rebuilds it with heap walks; the keep-alive profile holds the count above 0 across the rotation.
