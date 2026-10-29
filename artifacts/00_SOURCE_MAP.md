# 00 — Source map: `nestjs/observe` (pinned)

Mission 00 (SDK reconnaissance). Read-only. Every row below cites the pinned checkout. Line numbers refer to the pinned revision only.

> Stage 01 corrections (2026-10-29), from the independent Stage 00 review, applied in place: H1 (profiler duty/window coverage, section 7), L3 (POC sample counts, section 7), L4 (error identity was not asserted, section 4), plus annotations for M7 (decorator not fail-open, section 2) and H6 (stale ALS join, section 3). The full transitive vendor closure (M2) is in `artifacts/01_IMPLEMENTATION_PLAN.md` section 4.

## Pin

| Item | Value | Evidence |
|---|---|---|
| Repository | https://github.com/nestjs/observe | `git clone --depth 1`, then `git fetch --depth 30` |
| Local checkout | `D:\codeShit\Tracelet-refs\observe` (outside the repo, untrusted, no scripts run) | |
| Pinned commit | `7500fba7f61f4d0e177e415b291ec6d4d366b052` ("chore(): release v0.3.19", 2026-10-28T13:43:19+01:00) | `git log -1` |
| npm `gitHead` for 0.3.19 | `319a3d016ba47ad0856ef18b85f1495270a8b6d6` (parent of the commit above) | `npm view @nestjs/observe@0.3.19 gitHead` |
| Source delta between the two | Only `package.json` and `package-lock.json` (version bump). `src/` is identical. | `git diff --stat 319a3d0 7500fba` |
| npm tarball integrity | `sha512-tGw1Mp5JgZmeTeR9uJnYCA9KEwJsGy+bhpuKx4QqerO56GEGdnYqjnouGxVOcUXT83VVJF74ksu9c5LVqlB8Vw==` | `npm view ... dist.integrity` |
| Package / version | `@nestjs/observe` `0.3.19` | `package.json:2-3` |
| License | MIT, "Copyright (c) 2017-present Kamil Mysliwiec" | `LICENSE:1-3`, `package.json:73` |
| Runtime dependency | `@jridgewell/trace-mapping@0.3.31` (only one) | `package.json:74-76` |
| Module format | ESM only (`"type": "module"`, `module: nodenext`). CJS consumers rely on `require(esm)`. | `package.json:194`, `tsconfig.json`, `README.md:481-491` |
| Node engine | `>= 20.19.0` (the floor for `require(esm)`) | `package.json:50-51`, `README.md:483-486` |
| CI Node matrix | 20.19, 22, 24 | `.github/workflows/ci.yml:32` |
| Nest peers | `@nestjs/common` and `@nestjs/core` `^11.0.0 \|\| ^12.0.0`, `reflect-metadata ^0.1.12 \|\| ^0.2.0`, `rxjs ^7`. Other protocol peers are optional. | `package.json:77-127` |
| Public export surface | `.` and `./package.json` only, so deep subpath imports are blocked for bare specifiers | `package.json:36-42` |
| Public symbols | custom-metrics, `createInstanceDecorator`, interfaces, `observe.constants` (incl. `TRACE_REGISTRY_KEY`, `CALLER_METADATA_KEY`), objectives, `createObserveModule`, `TracerService`, `SPAN_COLLAPSED_TAG`, `UNFINISHED_SPANS_TAG`, `TraceSpanDelegate`, `defaultTraceIdGenerator` | `src/index.ts:1-11`, `src/services/index.ts:1-3` |
| NOT exported | `OperationTraceRegistry`, `JobTraceRunner`, `ObserveAgentSharedBuffer`, `ObserveAgentWorker`, `CpuProfilerService`, `SpanSliceRecorder`, `foldProfile`, `NodeRuntimeMetricsService`, encoders | absent from `src/index.ts` |

### Nest core hook used by the SDK (verified by tarball bisect)

The SDK instruments through `NestFactory.create*(…, { instrument: { instanceDecorator } })`. I downloaded `@nestjs/core` tarballs with `npm pack --ignore-scripts` into the scratchpad and grepped them:

| `@nestjs/core` | `instanceDecorator` present |
|---|---|
| 11.0.0, 11.0.20, 11.1.0, 11.1.1, 11.1.2, 11.1.3 | no (0 files) |
| 11.1.4, 11.1.6 | yes (7 files) |

In 11.1.4, `injector/injector.js:23-25` stores the hook, and `injector.js:414` and `:419` replace `instanceHost.instance` with the decorated instance for class and factory providers. `injector/module.js:242-247` does the same for value providers. `nest-factory.js:97-100` (`initialize`, shared by `create`, `createMicroservice` and `createApplicationContext`) passes `options.instrument?.instanceDecorator`. **Effective floor: `@nestjs/core` >= 11.1.4**, even though the peer range says `^11.0.0`. The HTTP hooks also need 11.1.4 (`src/protocols/http-observe-agent.service.ts:40-45`, `:345`).

---

## 1. Root trace lifecycle

| Concern | File:lines | Notes |
|---|---|---|
| ALS instance created once per `createObserveModule()` | `src/observe.module.ts:175` | `new AsyncLocalStorage<Map<…>>()`. Provided as the `AsyncLocalStorage` token and exported (`:196-199`, `:251`). |
| Registry created before DI (the instrument hook needs it) | `src/observe.module.ts:176-186`, configured at `:200-223` | Holds the span-collapse, skip-spans and redaction config. |
| Open a root | `src/services/operation-trace.registry.ts:243-275` `startTrace(registryKey, data, reportedTraceId)` | Stores a snapshot keyed by the registry key, with `startTimestamp = performance.now()`. **Internal API.** |
| Close a root | `operation-trace.registry.ts:277-366` `endTrace` | **A snapshot with zero spans is deleted (`:294-309`).** A root whose callback never calls an instrumented provider is dropped. |
| Hand-off | `operation-trace.registry.ts:770-837` `pluckSnapshot` | Waits `SNAPSHOT_COMPLETION_TIMEOUT_MS = 1000` (`:25`, `:781-798`) for unfinished spans, removes them and tags `observe.unfinishedSpans` (`:850-876`), then collapses repeated spans (`:828-833`). |
| Deferred completion | `src/protocols/deferred-trace-completion.ts:158-175` | `setTimeout(0)` plus a guarded promise. A completion failure is never rethrown. |
| Abort cleanup | `operation-trace.registry.ts:754-757` `abandonTrace` | Used by HTTP on client abort (`http-observe-agent.service.ts:321`). |
| HTTP root (reference implementation) | `src/protocols/http-observe-agent.service.ts:133,141` (adapter hooks), `:163` (`als.run(store)`), `:224` startTrace, `:261` endTrace, `:267` pluck, `:281` insertRequestSnapshot, `:368-380` `http.ignore` | Needs adapter hooks from Nest 11.1.4. |
| **Job root (the closest thing to a custom root)** | `src/protocols/job-trace-runner.ts:89-365` `JobTraceRunner.run(job, invoke, settlesItself)` | See section 5. |
| RPC/WS/GraphQL roots | `rpc-observe-agent.service.ts:176,213,229,269,313-322`; `ws-observe-agent.service.ts:173,202-242`; `graphql-observe-agent.service.ts:401,483-490` | Same pattern. |

## 2. Provider/method auto-instrumentation

| Concern | File:lines | Notes |
|---|---|---|
| Instrument object returned to the app | `src/observe.module.ts:408-431` | `ObserveInstrument.instanceDecorator`. The app passes it to `NestFactory.create*`. **Public API.** |
| Exclusions | `observe.module.ts:356-406` | The user `skipInstrumentation` runs first. Agent services, `ModulesContainer`, `DiscoveryService`, `MetadataScanner` and the GraphQL host are excluded. An instance that throws on inspection is skipped. |
| Framework noise | `src/instrument/create-instance-decorator.instrument.ts:37-49` | `Reflector` is never instrumented. |
| Proxy creation | `create-instance-decorator.instrument.ts:264-412` | `new Proxy(instance, { get })`. Wraps own and inherited function properties lazily on access and caches them in a `WeakMap` (`:313`, `:343-346`, `:408`). |
| Skipped values | `:321-334`, `:508-548` | Constructors, callable objects (Mongoose models, Axios) and `constructor` are not wrapped. |
| Raw-receiver fallback | `:280-310`, `:561-660` | Classes with native `#private` members and slot-backed built-ins run against the raw target. **Nested `this.x()` calls inside such classes are not traced.** Bare built-ins are returned untouched. |
| Traced wrapper | `:99-223` | The "is there a trace" gate is `als.getStore()?.get(TRACE_REGISTRY_KEY) ?? get(traceIdKey)` (`:117-122`). Without one the call runs untraced (zero spans, proxy cost only). |
| Start step | `:126-131` → `operation-trace.registry.ts:440-486` | Creates a node (uuidv7 span id) and attaches it under the live caller, or at the root (`:502-516`). |
| Child context | `create-instance-decorator.instrument.ts:176-180` | `als.run(new Map([...store, [CALLER_METADATA_KEY, newStepId]]))`. **Copy-on-call: each span gets its own shallow store copy.** |
| Async result | `:184-213` | A plain native promise becomes `result.then(settled, failed)`, so the rejection is preserved. A non-plain promise or subclass is returned as-is and watched on a side branch, which **marks its rejection handled** (`:205-212`). |
| Sync result / throw | `:214-219` | Rethrows the identical error object (`:171-175`) by source reading. **Not fail-open (Stage 01, M7):** `internalStartTraceStep` (`:126`) and the sync-return `onReturnValue` (`:214`) and sync-throw `onError` (`:216`) paths are not wrapped in `ignoreFailure`, so a registry failure there reaches the caller; `setActive(true)` (`:123`) precedes the start call and is never reset if it throws. Nest 11.1.4/11.1.6 call `instanceDecorator` without a try/catch (`injector.js:414,419`; `module.js:247`), so a throwing decorator aborts bootstrap. |
| Re-entrancy guard | `:111-116`, `:359-371` | Keyed per (target, method) and held only during the synchronous part of the call (`finally` at `:217-219`), so concurrent async calls are unaffected. Synchronous direct recursion is traced once. |
| Observables / async iterables | `:183-214` | Only `instanceof Promise` is awaited. An Observable or iterator return ends the span immediately (subscription time only). **Not supported. Must be documented (T08).** |
| DI receives the proxy | Nest 11.1.4 `injector.js:410-420` | `instanceHost.instance = instanceDecorator(...)`, so injected dependencies are proxies. Confirmed by POC (`OrdersService` → `Repo` spans). |
| `forwardRef` circular providers | Nest 11.1.4 `injector.js:410-412` | `Object.assign(instanceHost.instance, new metatype())` then decorate. Earlier-injected references may hold the raw object, not the proxy. **UNCERTAIN, test as T06.** |

## 3. ALS context isolation

- One ALS per `createObserveModule()` (`observe.module.ts:175`). Each root gets a fresh `Map`: `job-trace-runner.ts:254-258` and `http-observe-agent.service.ts:163`.
- Each traced call runs in a shallow copy that adds `CALLER_METADATA_KEY` (`create-instance-decorator.instrument.ts:176-180`). The parent/child relationship is the caller id in ALS, not a global stack. That makes concurrent and overlapping siblings correct. POC: 4 concurrent roots gave 4 distinct trace ids, and both `Promise.all` `Repo.find` siblings were nested under `OrdersService.handle`.
- Root nesting rule: a root opened inside an existing trace is suppressed (`job-trace-runner.ts:250-268`), and the inner work joins the outer trace. The same job seen twice is deduplicated (`:243-248`). **Stage 01 note (H6):** the check is `outerStore?.has(traceIdKey)` only, not whether that trace is still open. A callback source created inside a traced operation (an amqplib connection/socket) keeps that ALS store after the trace closes; every later message would "join" a closed trace and record nothing (the registry has no snapshot, so `internalStartTraceStep` returns `undefined`). Tracelet freezes JOIN-IF-OPEN instead (plan section 6.2).
- `TracerService.setAttribute` mutates the current (copied) store (`tracer.service.ts:409-418`). It is visible to the current span scope and its descendants only.
- Store keys `CALLER_METADATA_KEY = "#caller"` and `TRACE_REGISTRY_KEY = "#registryKey"` are plain strings and publicly exported (`src/observe.constants.ts:2,13`).

## 4. Error tracing

| Concern | File:lines |
|---|---|
| Wrapper records then rethrows the same object | `create-instance-decorator.instrument.ts:156-175`, `:215-216`; promise path `:192-195` |
| Stack relabel `Proxy.x` → `Class.x` (mutates `err.stack`, best effort) | `:474-495` |
| Error on root span sets `errorStatusCode` and full payload. Child spans get `error: true`. | `operation-trace.registry.ts:588-606` |
| Snapshot error copied from the first erroring root span | `:354-365` |
| Payload: redacted message and stack, class, optional source **code frames** read from disk | `:181-232`. Redactor is on by default (`:132`, configured `observe.module.ts:215-219`). `sourceContext` defaults to `true` (`registry` ctor `:138`). |
| Manual capture | `tracer.service.ts:127-157` → `registry.captureError` `:705-743` |
| Job status | `job-trace-runner.ts:341-362` (`completed`/`failed`, rethrows) |

POC: the failing root rejected with an error of the same class carrying the same marker (`poc.cjs:106`: `instanceof Error && marker === "m4"`). Reference identity (`rejected === thrown`) was **not** asserted (Stage 01 correction L4); the source path rethrows the same reference (`job-trace-runner.ts:349-352`, `:359-361`), and Mission 02 T05 must assert it. The job status was `failed`, the root span carried `error.cls = "Error"`, and the child carried `error: true`.

## 5. Job trace runner (custom roots)

- `src/protocols/job-trace-runner.ts:89` `export class JobTraceRunner`. It is exported from its own module but **not from the package entry** (`src/index.ts`), and the `exports` map blocks the subpath. **Internal API.**
- Constructor (`:90-98`) needs `ObserveAgentSharedBuffer`, resolved options, `OperationTraceRegistry`, the ALS and a logger. None except the ALS and options are reachable through public DI. The registry and buffer are TS-`private` fields of the public `TracerService` (`tracer.service.ts:38-44`).
- `run(job, invoke, settlesItself)` (`:230-364`) is fully generic. It takes any `{queueName, name, id, opts, metadata}` and any `invoke`, so it **can wrap an arbitrary callback**. The snapshot type is `JobSnapshot` (`src/interfaces/job-snapshot.interface.ts`).
- Construction sites: `queue-observe-agent.service.ts:59-65` (BullMQ, patched decorator at `:170-173`), `bull-observe-agent.service.ts`, `schedule-observe-agent.service.ts`.
- **Limitation:** it creates no span for the root callback itself. If `invoke` calls no instrumented provider, the snapshot is dropped at `registry.endTrace:294-309`. POC: `bareCallbackRecorded: false`.
- `TracerService.createSpan` (`tracer.service.ts:51-69`) needs an existing trace id (`:443-455`). `registry.createManualSpan` (`:946-1041`) with no live span runs the function untraced (`:956-960`). **No public API starts a root.**

## 6. Transport / export

| Concern | File:lines | Finding |
|---|---|---|
| Default endpoint | `src/agent/observe-agent.worker.ts:47`, `:52-53` | `process.env.OBSERVE_ENDPOINT ?? "https://observe-api.nestjs.com"` |
| Option | `observe-agent.worker.ts:607-609`; documented `src/interfaces/observe-options.interface.ts:200-208` | `options.endpoint` overrides. **Repointable.** |
| When nothing is sent | `observe-agent.worker.ts:157-184`, `:566-571`, `:599-605` | `enabled:false`, scaffold credentials, or missing credentials **with the hosted endpoint**. With a non-hosted endpoint and no credentials, the worker starts and sends without auth headers. |
| Worker thread | `observe-agent.worker.ts:642-663` | `new Worker(source, { eval: true, workerData })`, restarted on non-zero exit (`:669-682`) |
| Main → worker hand-off | `src/agent/observe-agent.shared-buffer.ts:39` (16 MB `SharedArrayBuffer`), `:203`, lock via `Atomics` (`detached-observe-worker.ts:245-263`) | One batch slot. `encodeAndWrite` (`:696`) throws "Payload too large" over the size (`~:716-718`). |
| Batch caps | `shared-buffer.ts:40` (1000 snapshots/batch default), `:317-337` job cap, `telemetry-wire-contract.ts:74` `MAX_BATCH_ITEMS = 5000` | Excess snapshots are dropped (bounded). |
| URL | `src/agent/detached-observe-worker.ts:71` | `${endpoint}/applications/telemetry` |
| Wire | `detached-observe-worker.ts:109-128`, `:268-277`, `:342-360` | `POST`, `Content-Type: application/json`, **`Content-Encoding: gzip`**, `x-observe-ingest-modes`, `x-observe-sdk-version`. **`x-api-key` / `x-api-secret` only if both are set.** Keep-alive agent, 15 s request timeout (`:319`). |
| Schema | `src/encoders/trace.encoder.ts:32` (`TRACE_KEY_MAP`), `job-snapshot.encoder.ts`, `src/agent/telemetry-wire-contract.ts:295` (`TELEMETRY_BATCH`), `:338` (sections) | Short-key remapped JSON (`q,n,i,ti,c,t[{o,c,m,so,ch,s,d}]`). Top level: `serviceId, snapshots, forwardLogs, jobs, …`. It is the hosted collector's contract, internal, unversioned for third parties. |
| Hosted-specific behaviour | `observe-agent.worker.ts:765-828`, `degraded-ingest.protocol.ts` | Ingest modes, billing messages, 429/401 pauses (`detached-observe-worker.ts:166-220`) |
| Profiles transport (dormant) | `src/profiling/profile-uploader.ts:117-118` | `fetch(${endpoint}/applications/profiles)`, uncompressed JSON, keeps at most 2 windows (`:13`) |
| Other outbound | `src/cli/link.ts:292,332` | Only when the `observe` CLI is run. No runtime phone-home was found in non-test sources (grep for `fetch(`, `http(s).request`, hosted hostnames). |

POC (loopback fake collector): exactly one `POST /applications/telemetry` was received, with `content-encoding: gzip`, `content-type: application/json`, no `x-api-key`, and `x-observe-sdk-version: 0.3.19`. The decoded top-level keys were `serviceId, snapshots, forwardLogs, jobs`. The log line was "Observe is connected: http://127.0.0.1:52253 accepted this app's first batch."

## 7. CPU profiling

| Concern | File:lines | Finding |
|---|---|---|
| Sampler | `src/profiling/cpu-profiler.service.ts:72-280` | `node:inspector` `Session` in-process. `Profiler.enable` → `setSamplingInterval` → `start`, then `stop` (`:168-217`). No native addon. |
| Defaults | `:13` 99 Hz, `:16` window 60 s, `:28` **duty 10 s per 60 s**, `:38` budget 3 % | **Duty-cycled, not continuous** by default. `dutyMs` is clamped to `windowMs` (`:92`). **Corrected (Stage 01, H1):** `dutyMs == windowMs` gives about **50%** coverage, not near-continuous: the `setInterval` tick (`:113-115`) at `T+W` finds `running === true` (`:145-147`) because the duty timer (`:156-161`) and `Profiler.stop` (`:193-194`) end the burst only after `T+δ+W`, so that tick is skipped and the next burst starts at `T+2W`. Static analysis; not yet run. |
| Budget kill-switch | `:229-246` | Disables **permanently** if `process.cpuUsage` over the burst exceeds `100 + maxCpuPercent` % of one core (`:241`). Process CPU includes GC and libuv threads. |
| Folding | `src/profiling/fold-profile.util.ts:64-111`, frame format `:161-176` | `name file:line` (1-based). Drops `(root)` and `(idle)`. Keeps `(program)` and `(garbage collector)` (`:45`). |
| Span attribution | `src/profiling/span-slice-recorder.ts:52-170`; hooks `operation-trace.registry.ts:459, 543, 977`; global handle `:180-190` | `enter` and `exit` fire at span start and **span end**, not at await suspend/resume. Under concurrent async traces, samples can land on the wrong span. The file's own comment (`:45-50`) admits partial unsoundness. **Do not use for per-trace claims (product brief).** |
| **Enabled?** | `src/agent/observe-agent.worker.ts:192-197` | **NO.** `// this.startContinuousProfiling();` is commented out ("Continuous profiling is shelved"). |
| Option | `src/interfaces/observe-options.interface.ts:277-326` | `profiling` option is commented out ("SHELVED - setting this currently does nothing"). |
| Starter (dead code) | `observe-agent.worker.ts:246-300` | Builds `SpanSliceRecorder` + `ProfileUploader` + `CpuProfilerService`. |
| Published dist matches | `node_modules/@nestjs/observe/dist/agent/observe-agent.worker.js:167` | `// this.startContinuousProfiling();` |

POC (driving the internal class directly): one window with 180 samples, 171 of them in `burnCpuHotLoop …/poc.cjs:127` (values from the saved `poc-run1.log`; earlier text said 185/176, corrected in Stage 01, L3). In the allocation-heavy stress runs, **3 of 3** self-disabled ("CPU use during the sampling burst was 193.5% / 196.3% / 180.8% of one core").

## 8. Runtime metrics

| Concern | File:lines |
|---|---|
| Service | `src/services/node-runtime-metrics.service.ts:57+`. `onModuleInit` `:96`. `monitorEventLoopDelay` `:122` (perf_hooks histogram). GC `PerformanceObserver` `:134-160`. `collectNodeRuntimeMetrics()` `:182`. CPU via `process.cpuUsage` (`:82`). ELU via `performance.eventLoopUtilization` (`:85-86`). |
| Scheduling | `observe-agent.worker.ts:203-229`. Interval default 60 s (`:39`), minimum 30 s (`:40`). Started only if something will be sent (`:188-190`). |
| Distinct from profiling | Yes. Aggregate process gauges only, no stacks (`observe-options.interface.ts:260-268`). |

## 9. Global side effects to keep out of an embedded product

| Patch | File:lines | Risk for Tracelet |
|---|---|---|
| `mongodb` `Connection.prototype` patched | `src/outgoing/mongodb.integration.ts:126-127` | Would span Tracelet's own Mongo writes when they run in a trace-carrying context. |
| `diagnostics_channel` HTTP client subscribe | `src/outgoing/http.integration.ts:83` | Outbound `x-request-id` header injection |
| `process.stdout.write` replaced (if `forwardLogs`) | `src/services/stdout-forwarder.service.ts:149` | Hot path |
| BullMQ/Bull `Queue.prototype.add` patched | `job-trace-runner.ts:106-146` | Not needed |
| HTTP adapter hooks | `http-observe-agent.service.ts:133-141` | Would trace `/observe` itself unless `http.ignore` is set |
