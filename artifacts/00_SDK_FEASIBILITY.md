# 00 — SDK feasibility (Mission 00)

**Verdict: CONDITIONAL GO**, using a **vendored partial fork** (file-level, MIT, pinned) inside Tracelet's own package. The `@nestjs/observe` npm package should not be used as a runtime dependency or adapter.

Pinned upstream: `nestjs/observe` @ `7500fba7f61f4d0e177e415b291ec6d4d366b052` (v0.3.19 release commit). Its `src/` is identical to npm `gitHead` `319a3d0`; the only diff is the `package.json`/lock version bump. MIT. Full line-level evidence is in `artifacts/00_SOURCE_MAP.md`.

> **Stage 01 corrections (2026-10-29), from the independent Stage 00 review.** Applied in place below.
> - **H1:** `dutyMs == windowMs` is **not** continuous. `start()` arms `setInterval(runWindow, windowMs)` (`cpu-profiler.service.ts:113-115`); `runWindow` returns early while `running` (`:145-147`); the burst ends only when the duty timer fires `dutyMs` after the handshake (`:156-161`), and `running` is cleared only after `Profiler.stop` resolves (`:193-194`). With `dutyMs == windowMs` the tick at `T+W` always finds `running === true` and is skipped, so the next burst starts at `T+2W`: about 50% coverage. Static analysis only; Mission 02 T09/T10 must prove the replacement (a chained stop-then-start loop) with at least N-1 contiguous windows.
> - **L3:** POC numbers now match the saved log `poc-run1.log`: 180 samples / 171 in `burnCpuHotLoop` (was 185/176); overhead 0.166 / 0.802 / 19.834 µs per call (was 0.17 / 0.70 / 20.2).
> - **L4:** the POC asserted only `reason instanceof Error && reason.marker === "m4"` (`poc.cjs:106`), not reference identity. Earlier "identical/same error object" wording is corrected; T05 must assert `rejected === thrown`.

Environment of this investigation: Windows 10, **Node v22.22.0, npm 10.9.4** (local). **The target host application is not in this repository.** Its Node version, `@nestjs/core` version, CJS/ESM mode, HTTP adapter, amqplib usage, Mongo driver and OpenShift base image are **UNVERIFIED**. See section 3.

---

## 1. The four questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| Q1 | Can it launch an **arbitrary custom root**? | **NO via public API. VERIFIED via internal `JobTraceRunner`. A fork is required for supported use.** | No public root API: `TracerService.createSpan` requires an existing trace (`src/services/tracer.service.ts:51-69`, `:443-455`). `JobTraceRunner` (`src/protocols/job-trace-runner.ts:89-365`) is generic over any callback but is not exported (`src/index.ts:1-11`), and the `exports` map blocks subpaths (`package.json:36-42`). Its dependencies (`OperationTraceRegistry`, `ObserveAgentSharedBuffer`) are reachable only as TS-private fields of `TracerService` (`tracer.service.ts:38-44`). POC: a deep import by absolute path plus private-field access gave 4 concurrent roots, 4 distinct trace ids and correct nesting. **Gap:** a root whose callback calls no instrumented provider is dropped (`operation-trace.registry.ts:294-309`; POC `bareCallbackRecorded: false`), and the root callback itself gets no span. |
| Q2 | Can it **automatically trace nested Nest methods**? | **VERIFIED** (when a trace context exists and the app is created with `instrument`) | `createInstanceDecorator` proxy (`src/instrument/create-instance-decorator.instrument.ts:264-412`, wrapper `:99-223`, ALS caller propagation `:176-180`). Nest replaces the injected instance with the decorated one (`@nestjs/core@11.1.4 injector/injector.js:410-420`). POC tree: `OrdersConsumer.process` → `OrdersService.handle` → {`compute`, `Repo.find` ×2 overlapping}, with plausible durations (~22–29 ms for a 20 ms timer). **Requires `@nestjs/core >= 11.1.4`** (tarball bisect: hook absent in 11.0.0–11.1.3). **Caveats:** classes with native `#private` members lose nested `this.x()` spans (`:280-310`). Observables and async iterables are measured to return only (`:183-214`). `forwardRef` circular providers are UNCERTAIN. |
| Q3 | Can **CPU samples be recorded continuously**? | **NO as shipped. The internal sampler is VERIFIED to produce stack samples, but it is duty-cycled and self-disables under load. Continuous mode must be proven in Mission 02/06 with a fixed copy.** | Shelved: `src/agent/observe-agent.worker.ts:192-197` (`// this.startContinuousProfiling();`), and the option is commented out at `src/interfaces/observe-options.interface.ts:277-326`. Published dist is identical (`dist/agent/observe-agent.worker.js:167`). The sampler `src/profiling/cpu-profiler.service.ts` uses `node:inspector` at 99 Hz, a 60 s window and a **10 s duty** (`:13-38`). POC: 180 samples, 171 attributed to `burnCpuHotLoop poc.cjs:127` (saved log `poc-run1.log`; corrected in Stage 01, L3). **Setting `dutyMs == windowMs` does not make it continuous** (about 50% coverage, see H1 correction below). **Budget kill-switch** `:229-246` (`> 100 + 3 %` of one core) **permanently disabled profiling in 3/3 allocation-heavy runs** (180.8–196.3 %, because parallel GC threads count). This defeats T09. Per-span attribution (`span-slice-recorder.ts`) is unsound under concurrent awaits. Do not use it. |
| Q4 | Can **export be fully local** (no vendor telemetry)? | **VERIFIED for the SDK (repointable endpoint). For Tracelet it is moot under the recommendation: the SDK transport is not used at all.** | Endpoint: `options.endpoint ?? process.env.OBSERVE_ENDPOINT ?? "https://observe-api.nestjs.com"` (`observe-agent.worker.ts:47,52-53,607-609`). POC: exactly one `POST /applications/telemetry` to the loopback fake collector, gzip JSON, **no `x-api-key`** (credentials are sent only if both are configured, `detached-observe-worker.ts:125-128`). No runtime phone-home was found outside the worker and the dormant profile uploader (grep for `fetch(`, `http(s).request` and hosted hosts; the CLI `link` runs only when invoked). **Hazard:** the default is the hosted collector. If `endpoint` is unset and credentials exist, data leaves the network. An OS-level egress test was **not run** here and is deferred to the product-brief exit check 8. |

---

## 2. What the SDK gives us vs what Tracelet needs

| Tracelet need | SDK status | Consequence |
|---|---|---|
| `observe.trace(name, fn)` for amqplib, Redis, emitter, any async fn | Internal only. No root span. Drops empty roots. | Vendor the registry and write our own root runner with a synthetic root span. |
| Nested provider spans | Solid, battle-tested proxy | Vendor `create-instance-decorator` almost verbatim. |
| In-process sink to Mongo | Snapshots go to a 16 MB SAB → worker thread → HTTP to `/applications/telemetry` in the hosted wire contract | An adapter would mean either a loopback HTTP receiver (gzip and short-key decoding, extra thread, self-traced ingest route) or monkey-patching the private `insertJobSnapshot`. Both are fragile. Write our own bounded queue → Mongo. |
| Continuous CPU profile | Shelved, duty-cycled, kill-switch misfires | Vendor `cpu-profiler` + `fold-profile` and fix the budget logic and duty defaults. |
| Runtime metrics | Present (`node-runtime-metrics.service.ts`) | Vendor. |
| No vendor egress by default | Hosted default endpoint | Removed by construction: no worker or uploader is vendored. |
| Privacy | Redaction on by default. **Source code frames shipped by default** (`sourceContext: true`). | Keep the redactor. Make source context opt-in. |

---

## 3. Compatibility (host app unverified)

| Item | Requirement found | Status |
|---|---|---|
| `@nestjs/core` | **>= 11.1.4** for `instrument.instanceDecorator` (verified by tarball bisect, see source map) | **UNVERIFIED on host.** If the host is on Nest 10 or < 11.1.4, the fallback is an `onModuleInit` DiscoveryService walk that wraps instance methods in place (mutates provider instances, misses the receiver-proxy trick, needs its own review) or a host upgrade. Stop and decide; do not force. |
| Node | npm package: >= 20.19 (ESM-only, `require(esm)`). Vendored code: needs `AsyncLocalStorage`, `node:inspector` `Session`, `perf_hooks.monitorEventLoopDelay`, `performance.eventLoopUtilization`. All exist on Node 18+, but the vendored code targets ES2023 (`tsconfig.json`). | **UNVERIFIED on host.** The product brief warns the host may be on Node 18.8.0. If so: Node 18 is EOL, so the decision is an upgrade or a down-level compile. Mission 01 must decide. |
| Module mode | Vendored code compiled into Tracelet's own package (CJS or dual) removes the ESM-only constraint | Our build choice |
| HTTP adapter | Not needed for roots or method tracing. The SDK's HTTP tracing uses Nest 11.1.4 adapter hooks (Express/Fastify). | Dashboard mounting is a separate concern (lead/Codex) |
| OpenShift image | Needs a Node build with the inspector compiled in | **UNVERIFIED.** Check in Mission 02: `node -p "process.config.variables.v8_enable_inspector"` and `node -e "new (require('inspector').Session)().connect()"` inside the real image. |
| Worker-only process | `NestFactory.createApplicationContext` also receives `instrument` (`nest-factory.js:97-100`, `initialize`) | VERIFIED (the POC used `createApplicationContext`) |

---

## 4. Risk matrix

| Risk | Likelihood | Impact | Evidence | Mitigation / owner |
|---|---|---|---|---|
| **Root creation**: no public API, empty roots dropped, no root span | Certain | High | `tracer.service.ts:51-69`; `registry:294-309`; POC | Vendored registry gets `startRoot()` with a synthetic root span (origin `"root"`). Empty roots are kept. Mission 02. |
| **Automatic provider coverage**: `#private` classes, Observables, `forwardRef`, request/transient scope | Medium | Medium | decorator `:280-310`, `:183-214`; core `injector.js:410-412` | T06, T07, T08 tests. Document unsupported cases. |
| **ALS correctness**: concurrent roots, `Promise.all`, roots inside roots | Low (POC passed at n=4) | High | decorator `:176-180`; runner `:250-268` | T02 at n=25, T03, T04 in Mission 02. Define the nested-root policy (join vs new root) in the Mission 01 contract. |
| **Protocol capture** (amqplib ack/nack semantics) | Low | Critical | Runner returns `invoke`'s value or a chained promise and rethrows the same error reference (`job-trace-runner.ts:341-362`). POC checked only same class + marker property, **not** reference identity (L4). | T05. Wrapper must never `await` extra work before calling `fn`. No telemetry I/O on the call path. |
| **Behaviour change by wrapper**: non-plain promise rejections become handled; `err.stack` relabelled | Low | Medium | decorator `:205-212`, `:474-495` | Keep the plain-promise path, document the rest, test in T05. |
| **Retry semantics / backpressure** | Medium | High | The SDK buffer is a single slot plus HTTP pauses, hosted-specific | Own bounded queue: drop-newest plus counters, no retries beyond a small window, Mongo-down test T11. |
| **Continuous profiling**: shelved, duty-cycled, kill-switch misfires | Certain (as shipped) | High | `worker.ts:192-197`; `cpu-profiler.service.ts:229-246`; POC 3/3 disabled | Vendor and fix: measure sampler overhead, not whole-process CPU. Options: compare ELU or main-thread time with and without sampling, or make the budget a warning with a backoff instead of a permanent kill. **Not** `dutyMs == windowMs` (H1: about 50% coverage); replace the interval+duty scheduling with a chained stop-then-start loop on one persistent session. T09/T10/T18, contiguity assertion N-1 windows. |
| **Per-trace CPU attribution false claims** | High if enabled | High (truthfulness) | `span-slice-recorder.ts:45-50`; enter/exit at span boundaries | Do not vendor `SpanSliceRecorder` into v1. Correlate by time window + service + instance only. |
| **Instrumentation overhead** | Medium | Medium | POC (indicative, single 20k-span trace): raw 0.17 µs/call, proxy without trace 0.80 µs/call, **traced 19.8 µs/call** (saved log: 0.166 / 0.802 / 19.834; corrected in Stage 01, L3) | Measure p50/p95 in T20 with realistic trees. Keep span collapse and per-trace span caps (T22). |
| **Memory**: unbounded open traces | Medium | High | Registry keeps snapshots until `pluck`. HTTP has an abort path; custom roots need one too. | Root timeout/abandon plus max open roots and max spans per trace. T17, T22. |
| **Self-instrumentation** of Tracelet Mongo writes and `/observe` | Medium | Medium | SDK patches `mongodb` `Connection.prototype` (`outgoing/mongodb.integration.ts:126-127`) | Do not vendor `outgoing/*`. Run sink flushes under `als.exit()`. Exclude Tracelet providers via `skipInstrumentation`. T14, T23. |
| **Privacy**: source code frames and error text | Medium | High | `registry:181-232`; `sourceContext` default `true` | Keep `LogRedactor`. Set `sourceContext` off by default. T16. |
| **Library licensing** | Low | Medium | MIT, `LICENSE:1-3`. Sole dependency `@jridgewell/trace-mapping` is MIT. | Keep the upstream MIT notice in a `THIRD_PARTY_NOTICES` and a per-file header with SHA. Do not copy hosted UI. Use a distinct product name. |
| **Source mapping** of profile frames (TS → JS) | Medium | Low | `fold-profile.util.ts:161-176` emits JS `file:line`. `utils/source-map-resolver.util.ts` exists. | v1 shows compiled frames. Optional later: resolve with `trace-mapping`. |
| **Host version mismatch** (Nest < 11.1.4 / Node 18) | Unknown | **Blocking** | section 3 | Mission 01 must read the real host versions before freezing contracts. |
| **Upstream drift** | Certain over time | Low | Fork is pinned | Record SHA plus delta. Re-diff on upgrade. |

---

## 5. Recommended approach (one): vendored partial fork

Tracelet ships its own package (target layout per `spec/ARCHITECTURE.md`). It copies, with attribution, only the SDK files that implement the hard parts, at pinned SHA `7500fba`, and writes everything else itself. No dependency on `@nestjs/observe` at runtime, no worker thread, no HTTP transport, no hosted endpoint constant.

### 5.1 Reuse boundaries (file level)

| Upstream file (pinned) | Destination (proposal, final paths frozen in Mission 01) | Action |
|---|---|---|
| `src/instrument/create-instance-decorator.instrument.ts` | `src/instrumentation/vendor/instance-decorator.ts` | **Copy**. Minimal edits: import paths only. |
| `src/services/operation-trace.registry.ts` | `src/context/vendor/trace-registry.ts` | **Copy + modify**: add root-span support (`startRoot`), keep empty roots, remove hosted wording (`reportMissingInstrumentation`), add max-spans and max-open-traces caps, drop the `activeSliceRecorder` hooks. |
| `src/protocols/job-trace-runner.ts` | `src/context/root-runner.ts` | **Rewrite using it as reference**: no enqueue patching, no `JobSnapshot` coupling. Keep the nested-root and same-job rules (`:243-268`) and the promise/throw settle logic (`:341-362`). |
| `src/protocols/deferred-trace-completion.ts` | `src/context/vendor/deferred.ts` | Copy |
| `src/services/collapse-repeated-spans.util.ts`, `src/services/skip-spans.util.ts` | `src/context/vendor/` | Copy (bounded trees) |
| `src/utils/log-redactor.ts`, `sensitive-keys.ts`, `redact-url-query.ts`, `uuid-v7.util.ts`, `fit-to-length.util.ts` | `src/context/vendor/util/` | Copy |
| `src/utils/source-context.util.ts` | optional | Copy only if source context is kept as opt-in |
| `src/interfaces/trace-events.interfaces.ts` (node shapes) | `src/context/vendor/` | Copy and map to the frozen `observe-contracts.ts` at the buffer boundary |
| `src/profiling/cpu-profiler.service.ts` | `src/profiling/vendor/cpu-sampler.ts` | **Copy + modify**: replace the budget kill-switch, replace the `setInterval` + duty-timer scheduling with a chained stop-then-start window loop on one persistent session (H1; `dutyMs == windowMs` alone gives about 50% coverage), expose health state (`running/disabled/unavailable` + reason) for T18. |
| `src/profiling/fold-profile.util.ts` | `src/profiling/vendor/fold.ts` | Copy, minus the span-slice join |
| `src/services/node-runtime-metrics.service.ts` (+ `interfaces/node-runtime-metrics.interface.ts`) | `src/profiling/runtime-metrics.ts` | Copy, scheduled by our own module |
| **Not reused** | — | `agent/*` (worker, SAB buffer, wire contract, credentials, ingest modes), `encoders/*`, `profiling/profile-uploader.ts`, `profiling/span-slice-recorder.ts`, `cli/*`, `objectives/*`, `outgoing/*`, all `protocols/*` services (HTTP, RPC, GraphQL, WS, Bull, BullMQ, schedule), `stdout-forwarder`, `logger-patcher`, `observe.module.ts` (rewritten as Tracelet's own module, reusing only its exclusion list idea `:356-406`) |

Each copied file keeps an `// Adapted from nestjs/observe@7500fba (MIT, (c) Kamil Mysliwiec)` header. The repo gains `THIRD_PARTY_NOTICES.md` with the full MIT text, plus `docs/.../SDK_FORK_DELTA.md` listing every modification. Upstream tests for copied files (`create-instance-decorator.instrument.spec.ts`, `operation-trace.registry.spec.ts`, `cpu-profiler.service.spec.ts`, `fold-profile.util.spec.ts`) should be ported and kept green, as `spec/ARCHITECTURE.md` requires ("run upstream tests").

### 5.2 Ownership (per `spec/WORKSTREAM_BOUNDARIES.md`)

- Claude instrumentation: `src/instrumentation/**`, `src/context/**`, `src/buffer/**`.
- Claude profiler: `src/profiling/**`.
- Codex: storage, query, API and UI. They consume only the frozen contract (`resources/contracts/observe-contracts.ts`) at the buffer → storage boundary. Mission 01 must freeze the mapping from vendored node shape (`className, methodKey, startOffset, duration, children, error`) to contract spans.

### 5.3 Rejected alternatives

- **Adapter over the npm package** (repoint `endpoint` to an in-app `/observe/ingest` or tap private `insertJobSnapshot`). Rejected for these reasons: no public root API; empty roots dropped; profiling shelved; coupling to the hosted, unversioned short-key wire contract; an extra worker thread with a 16 MB SAB; the ingest route would self-trace; the ESM-only Node >= 20.19 floor; deep-import plus private-field access breaks on any patch release.
- **Full repository fork.** Rejected because it carries about 20k non-test LOC (53k including specs) of hosted-collector, CLI, billing and protocol code that we would have to neutralize and maintain.

---

## 6. Minimal POC design (Mission 02 must prove)

Scope: a throwaway harness in a worktree, not production code. Tests use a real Nest app (`createApplicationContext`, `instrument`), vendored files at the pinned SHA, and an in-memory sink. No Mongo yet.

1. **Root API.** `trace(name, fn, attrs?)` opens a root with a synthetic root span, runs `fn` in a fresh ALS `Map`, and returns `fn`'s exact value or promise semantics. **Assert:** a bare callback (no provider call) is recorded (fixes the `registry:294-309` gap).
2. **amqplib-shaped harness.** A fake channel calls `onMessage(msg)`. The handler calls `channel.ack(msg)` or `nack` itself after nested providers. 25 concurrent messages (T01, T02). One message fails deep in a provider (T05). **Assert:** ack/nack call counts and order are identical with and without tracing, `rejected === thrown` (reference identity, L4), distinct trace ids, correct parent/child, and nonnegative self time with overlapping `Promise.all` siblings (T03, T04).
3. **Nested root policy.** `trace()` inside `trace()` behaves as decided in Mission 01 (join vs new root). Test both directions.
4. **Edge providers.** `#private` class, Observable-returning method, request-scoped provider, `forwardRef` pair (T06, T07, T08). Record actual behaviour.
5. **Continuous sampler.** Vendored and fixed `cpu-sampler` with a chained stop-then-start window loop (H1), 30 s CPU-bound plus allocation-heavy load (T09) and 30 s idle (T10). **Assert:** at least N-1 of N windows contiguous (gap below the frozen bound) with function frames, no self-disable under GC-heavy load, sampler overhead measured (with vs without, same workload), and a truthful `unavailable` state when the inspector is missing or profiling is disabled (T18).
6. **Overhead.** Same harness with tracing off, on-untraced and on-traced. Record p50/p95 per call and per message (T20 seed). Compare with this mission's indicative 0.17 / 0.80 / 19.8 µs per call.
7. **Egress.** Run the harness with outbound network blocked (or a proxy that logs connects). **Assert:** zero non-loopback connections (product-brief exit check 8 seed).
8. **Host check (blocking).** Read `node -v`, `npm ls @nestjs/core @nestjs/common amqplib mongodb`, `tsconfig` module mode, the HTTP adapter and the OpenShift base-image inspector flag in the **real target app**.

Exit for Mission 02: items 1–5 and 8 green with evidence. Item 6 measured. Item 7 run.

---

## 7. Evidence from this mission (what was actually run)

| Step | Command (abbreviated) | Result |
|---|---|---|
| Clone | `git clone --depth 1 https://github.com/nestjs/observe D:\codeShit\Tracelet-refs\observe` (+ `git fetch --depth 30`) | HEAD `7500fba…`, tree clean |
| Nest hook bisect | `npm pack @nestjs/core@{11.0.0,11.0.20,11.1.0..11.1.4,11.1.6} --ignore-scripts` into scratchpad, then `grep -rl instanceDecorator` | 0 files through 11.1.3, 7 files in 11.1.4 and 11.1.6 |
| POC deps (scratchpad only) | `npm install --ignore-scripts @nestjs/observe@0.3.19 @nestjs/common@11.2.8 @nestjs/core@11.2.8 reflect-metadata@0.2.2 rxjs@7.8.2` | 25 packages. Node v22.22.0, npm 10.9.4. |
| POC main | `node <scratch>/pocsrc/poc.cjs <scratch>/pocdeps` (script dir separate from deps) | exit 0. Roots m1–m3 `completed`, m4 `failed`, rejection of the same class with the same `marker` (reference identity not asserted, L4). 4 distinct trace ids. Nested tree correct. Bare-callback root not recorded. One gzip POST to loopback `/applications/telemetry`, no api-key. Profiler: 180 samples, 171 in `burnCpuHotLoop`. Overhead raw/proxy/traced 0.17/0.80/19.8 µs/call (log values 0.166/0.802/19.834). |
| Profiler stress | `node <scratch>/pocsrc/prof-budget.cjs <scratch>/pocdeps` | 3/3 runs self-disabled (193.5 %, 196.3 %, 180.8 % "of one core") |

Scratchpad: `C:\Users\User\AppData\Local\Temp\claude\d--codeShit-Tracelet\ce5de35a-73ff-465a-bcc6-ad5e4d78fc06\scratchpad\` (`pocsrc/poc.cjs`, `pocsrc/prof-budget.cjs`, `poc-run1.log`, `prof-budget.log`). Nothing was installed in the repo.

**Not run:** upstream test suites (`npm test`/`test:int`, which would require running the untrusted repo's scripts); Nest 12 POC; 25-way concurrency; Express/Fastify HTTP path; OS-level egress blocking; target-host checks; Linux/OpenShift image. **Indicative only:** the overhead numbers come from one Windows run, a single 20k-span trace and no warm-up control.

## 8. Blockers and conditions for GO

1. **Blocking, unknown:** the target host's `@nestjs/core` must be **>= 11.1.4** (or an approved fallback or upgrade), and its Node version must be decided (the product brief flags a possible 18.8.0). Mission 01 must read the real host before freezing contracts.
2. Mission 02 must demonstrate items 1, 2 and 5 of section 6 (custom root with a root span, amqplib-shaped concurrency and ack parity, continuous sampling without self-disable).
3. The inspector must be available in the OpenShift runtime image.
4. Licensing: MIT notice and fork delta must be committed alongside the first vendored file.

## 9. Routing checkpoint

This mission's work was source reading plus a bounded POC, done at Opus High. Next steps:

- **Mission 01** (plan and contracts, including the root-span and node-shape → contract mapping): Opus High, because it freezes cross-team contracts.
- **Mission 02** (POC from section 6): start at Sonnet Medium (`tracelet-implementer`) from a frozen plan. Escalate to the investigator only if the ALS/ack-parity tests or the sampler budget fix fail twice.

`MISSION_STATUS.md` and `MISSION_REPORT.md` were not written: the orchestrator owns them per its instructions.
