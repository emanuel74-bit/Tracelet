# 01 — Implementation plan (Mission 01)

**Status: APPROVED revision 5 (independent review: APPROVE at revision 4; revision 5 applies its four low follow-ups, V1-V4 re-run). Contracts FROZEN v1 as of the Stage 01 commit (freeze doc section 13). Host check G0 still UNVERIFIED and blocks Stage 02.** The first independent review returned APPROVE-WITH-CHANGES; revision 2 applied R1-R14, revision 3 applied L1-L11 and the optionals, and revision 4 applies the re-review's two Medium and two Low items (section 22 lists each item and where it landed). No agent may start Missions 02-07 from this document until the re-review signs off and the orchestrator records approval. Contracts: `artifacts/01_CONTRACT_FREEZE.md` (frozen v1 candidate, revision 4).

- Date: 2026-10-29. Author: Mission 01 (Claude, Opus High).
- Upstream pin: `nestjs/observe@7500fba7f61f4d0e177e415b291ec6d4d366b052` (v0.3.19 release commit, MIT), read-only at `D:\codeShit\Tracelet-refs\observe`. Every upstream line reference below is at this pin.
- Inputs read: kit `README.md`, `AGENTS.md`, `spec/*` (ARCHITECTURE, TELEMETRY_DATA_MODEL, QUERY_API, DASHBOARD_DESIGN, SECURITY_AND_RELIABILITY, WORKSTREAM_BOUNDARIES, TEST_MATRIX, PRODUCT_BRIEF, SOURCE_VERIFICATION, EFFORT_AND_MODEL_ROUTING, DELIVERY_AND_LIMITS), prompts 01-07 and 11, `resources/contracts/*`, `resources/fixtures/*`, `artifacts/00_*`, root `CLAUDE.md`, `AGENTS.md`, `MISSION_REPORT.md`, `docs/tracelet-handoff/MISSION_STATUS.md` (Stage 00 review conditions H1, H6, M2, M7, M8, L3, L4).
- The demo HTML (`resources/demo/observe_dashboard_demo_v2.html`) was **not** re-read for this plan; it is the Mission 05 visual target and does not affect contracts beyond the routes in section 6.6.

---

## 1. Strategy (decided) and compromises

**Vendored partial fork** of `@nestjs/observe` at the pin, compiled into Tracelet's own package. No runtime dependency on `@nestjs/observe`, no worker thread, no HTTP transport, no hosted endpoint constant, no `outgoing/*` prototype patches. Reasons are in `00_SDK_FEASIBILITY.md` section 5 (no public root API, empty roots dropped, profiler shelved and duty-cycled, hosted wire contract, ESM-only, private-field access).

Compromises accepted by this plan (each is also a documented limitation):

1. **HTTP requests are not auto-rooted in v1.** Upstream HTTP roots need adapter hooks (`http-observe-agent.service.ts:133-141`) plus 400+ lines of protocol code. v1 roots are created only by `trace()`. A controller may call `trace()` itself. `kind: 'http'` stays in the enum for forward compatibility. Adding auto HTTP roots later is a CR.
2. **No outgoing-call spans** (Mongo, HTTP client, SQL). Only DI-provider methods and `trace()` roots/joins produce spans.
3. **CPU profiles are per instance, never per trace** (`SpanSliceRecorder` is not vendored; `span-slice-recorder.ts:45-50` admits unsoundness under concurrent awaits).
4. **Main thread only** for profiling; `worker_threads` are not profiled.
5. **Graceful shutdown required** for the last flush: the host must call `app.enableShutdownHooks()` (or `app.close()`); on SIGKILL the in-memory queue is lost (counted nowhere, documented).
6. **Head sampling** with a rootOnly record for failed sampled-out roots; method stats come from sampled traces and are labelled as such.

Licensing: MIT (`LICENSE:1-3` at the pin). Every vendored file keeps a header `// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.*.md`. The verbatim upstream `LICENSE` is copied to `packages/tracelet/third_party/nestjs-observe/LICENSE` in the same commit as the first vendored file. The single runtime dependency of upstream (`@jridgewell/trace-mapping`) is **not** taken (source maps are out of v1). No hosted UI assets are copied; the product name is Tracelet.

---

## 2. Stated baseline and the host gate

| Item | Baseline (user decision) | How Tracelet handles it |
|---|---|---|
| Node | `>= 20.19.0` (`engines`) | Upstream's floor (`package.json:50-51`). Dev machine: 22.22.0. Mission 02 must also run the POC suite on 20.19.x and 24.x (section 16). Node 24 switches `AsyncLocalStorage` to AsyncContextFrame; the same tests must pass on both. |
| `@nestjs/core` / `@nestjs/common` | `>= 11.1.4 < 12` (peer `^11.1.4`) | `instrument.instanceDecorator` exists from 11.1.4 (tarball bisect, `00_SOURCE_MAP.md`). 12.x is UNVERIFIED; adding it is a CR with a test run. |
| Module format | Tracelet ships **CommonJS only** (`"type": "commonjs"`, `tsc` `module: node16`) | CJS hosts `require('tracelet')`. ESM hosts `import { trace } from 'tracelet'` via Node's CJS named-export detection; `src/index.ts` uses explicit named re-exports (no `export *`) so cjs-module-lexer sees them. One build only, to avoid the dual-package hazard (two copies would create two `AsyncLocalStorage` instances and silently break nesting). Vendored ESM sources keep their `.js` relative specifiers, which `node16` resolution maps to `.ts`. |
| HTTP adapter | Express (Nest 11 = Express 5) **and** Fastify, plus no-HTTP worker processes | Dashboard/API mounted as raw adapter routes, not Nest controllers (section 12), so host global guards/interceptors/pipes/filters cannot reshape or block them and nothing is instance-decorated. Worker-only processes use `Tracelet.listen()` (node:http). |
| MongoDB driver | Tracelet's own `mongodb` client (dependency `^6.21.0`, engines `>=16.20.1`; `7.7.0` requires Node `>=20.19.0`) | Own client, own pool (max 5), own credentials and database. The 6 vs 7 major is open decision D3 (depends on the host's Mongo **server** version). |
| amqplib | Any version | Not patched. Users wrap consume callbacks with `trace()`. |
| Inspector | `process.config.variables.v8_enable_inspector` truthy | Without it the profiler reports `unavailable`; tracing is unaffected. |

### Gate G0 — host compatibility: **UNVERIFIED. Must pass before Stage 02 starts.**

The host application is not available to this mission. No host compatibility is claimed. The orchestrator (or the host owner) runs these in the **real host repository** and the **real OpenShift image**, and records outputs in `MISSION_STATUS.md`:

```powershell
# in the host repo
node -v
npm ls @nestjs/core @nestjs/common @nestjs/platform-express @nestjs/platform-fastify @nestjs/microservices amqplib amqp-connection-manager mongodb mongoose reflect-metadata rxjs
node -p "require('./package.json').type"          # 'module' => ESM host
type tsconfig.json                                 # module / moduleResolution
rg -n "NestFactory\.(create|createMicroservice|createApplicationContext)|instrument\s*:" src
rg -n "enableShutdownHooks|app\.close\(" src
```
```sh
# inside the running OpenShift pod (oc rsh / oc exec)
node -v
node -p "process.config.variables.v8_enable_inspector"
node -e "const s=new (require('node:inspector').Session)();s.connect();s.post('Profiler.enable',e=>{console.log(e?'ERR '+e.message:'profiler ok');s.disconnect()})"
echo "$NODE_OPTIONS"; cat /etc/os-release | head -3; cat /sys/fs/cgroup/cpu.max 2>/dev/null
# against the observability Mongo
mongosh "$OBSERVE_MONGO_URI" --quiet --eval "db.version()"
```

Pass criteria: Node `>= 20.19.0` (else STOP: upgrade decision, product brief compatibility gate); `@nestjs/core` `>= 11.1.4 < 12` (else STOP: upgrade or CR for the DiscoveryService fallback, not planned); no existing `instrument:` option (else D5 decorator composition); HTTP adapter recorded; ESM/CJS recorded; `enableShutdownHooks` present or accepted as a host change; inspector `true` and `profiler ok` (else profiling ships as `unavailable` on that image, tracing still GO); Mongo server version recorded (drives D3); container CPU quota recorded (overhead budgets).

---

## 3. Package layout and every file

Owner codes: **LEAD** integration (Claude; scaffold created in M02, owned by LEAD from M02 exit), **INS** instrumentation (Claude M02/M03), **PRO** profiler (Claude M02 for the sampler POC, M06), **STO** storage/query/API (Codex M04), **DSH** dashboard (Codex M05). "Imports" lists internal modules only (node built-ins and third-party noted when relevant).

### 3.1 Repository root (LEAD)

| Path | Role | Notes |
|---|---|---|
| `package.json` | npm workspaces root (`packages/tracelet`, `packages/tracelet/ui`, `examples/nest-worker`), scripts `build`, `test`, `lint`, `typecheck` | private |
| `package-lock.json` | single lockfile | **Only LEAD edits.** Others request dependencies by CR. |
| `.nvmrc` | `22` | dev default; CI matrix 20.19 / 22 / 24 |
| `.gitignore` | `node_modules`, `dist`, `coverage`, `packages/tracelet/assets/dashboard` build output is **committed** (see 3.9) | |

### 3.2 `packages/tracelet/` scaffold (created by M02, then LEAD)

| Path | Role / content |
|---|---|
| `package.json` | `name: tracelet`, `version: 0.1.0`, `private: true` (prevents public publish; `npm pack` still works for T19), `type: commonjs`, `main/types` = `dist/index.*`, `exports {".":{types,require,default}, "./package.json"}`, `files: [dist, assets/dashboard, third_party, THIRD_PARTY_NOTICES.md, README.md]`, `engines.node >=20.19.0`, peers `@nestjs/common ^11.1.4`, `@nestjs/core ^11.1.4`, `reflect-metadata ^0.1.13 \|\| ^0.2.0`, `rxjs ^7.1.0`; optional peers `@nestjs/platform-express`, `@nestjs/platform-fastify`; dependency `mongodb` (D3). DevDeps pinned at M02: `typescript 5.9.x`, `vitest 4.x`, `unplugin-swc`, `@swc/core`, `@types/node 22`, `@nestjs/{common,core,testing,platform-express,platform-fastify}` 11.2.x, `reflect-metadata`, `rxjs`, `supertest`, `@types/supertest`, `ajv 8.20.0`, `ajv-formats 3.0.1`, `eslint 9` + `typescript-eslint`, `prettier`, `mongodb-memory-server` (STO may replace via CR). |
| `tsconfig.json` | typecheck config (src + tests + bench), `strict`, `target ES2023`, `lib ["ES2023"]` (matches upstream `tsconfig.json`; all ES2023 built-ins exist in Node 20.19), `module/moduleResolution node16`, `experimentalDecorators`, `emitDecoratorMetadata`, `useUnknownInCatchVariables: false` (upstream parity) |
| `tsconfig.build.json` | `src/**` only, `declaration`, `outDir dist`, excludes tests |
| `vitest.config.mts` | unit tests `tests/unit/**/*.spec.ts`, SWC transform for decorator metadata |
| `vitest.int.config.mts` | `tests/integration/**/*.int-spec.ts`, `tests/contract/**`, `bench/**/*.int-spec.ts`; `pool: forks`, `testTimeout 120000`, no file parallelism for profiler files |
| `eslint.config.mjs` | includes the import-boundary rules of section 5 (`no-restricted-imports` per directory) |
| `src/version.ts` | `export const TRACELET_VERSION = '0.1.0'` |
| `third_party/nestjs-observe/LICENSE` | verbatim upstream MIT text (INS, M02) |
| `third_party/nestjs-observe/PIN.md` | repo URL, commit SHA, npm gitHead `319a3d0`, tarball integrity, date (INS, M02) |
| `third_party/nestjs-observe/FORK_DELTA.instrumentation.md` | every change to INS-owned vendored files (INS) |
| `third_party/nestjs-observe/FORK_DELTA.profiling.md` | every change to PRO-owned vendored files (PRO) |
| `THIRD_PARTY_NOTICES.md`, `README.md` | LEAD, M07 |

### 3.3 `src/contracts/` (LEAD; copied verbatim at M02 scaffold; frozen)

| File | Exports |
|---|---|
| `observe-contracts.ts` | byte-identical copy of kit `resources/contracts/observe-contracts.ts` |
| `tracelet-internal-contracts.ts` | byte-identical copy of the kit file (import path `./observe-contracts`) |
| `telemetry.schema.json` | byte-identical copy |
| `index.ts` | named re-exports of both TS files |

`tests/contract/contracts-sync.spec.ts` (LEAD) fails if any copy differs from the kit file (SHA-256 compare).

### 3.4 `src/shared/` (INS creates in M02; read-only for every other owner)

| File | Role | Imports | Exports |
|---|---|---|---|
| `als.ts` | the one `AsyncLocalStorage`, held as a **process-global singleton** on `globalThis[Symbol.for('tracelet.runtime')]` = `{ abi: TRACELET_RUNTIME_ABI, packageVersion, als, runtime? }`. `TRACELET_RUNTIME_ABI` (`src/shared/als.ts`, an integer starting at 1) is the internal runtime ABI. It is bumped whenever the shape or behaviour of anything stored in the slot changes (runtime, registry, token, store keys), independently of the public contract version (L-b). A second copy of the package (nested `node_modules`, ESM/CJS mix) shares the existing ALS and runtime **only if `slot.abi === TRACELET_RUNTIME_ABI`**. On a mismatch it does not share: it logs once (both ABIs and package versions) and makes its own `trace()` a pass-through and its instrument a no-op. The first copy keeps working | `node:async_hooks` | `traceletAls: AsyncLocalStorage<Map<string, unknown>>`, `runOutsideTrace<T>(fn: () => T): T` (= `traceletAls.exit`), `getGlobalSlot()` |
| `brand.ts` | internal-instance marker | — | `TRACELET_INTERNAL = Symbol.for('tracelet.internal')`, `markInternal(ctor)`, `isTraceletInternal(x): boolean` (never throws) |
| `uuid-v7.ts` | vendored `utils/uuid-v7.util.ts` (copy) | `node:crypto` | `uuidv7(now?)` |
| `diagnostics.ts` | rate-limited internal logging (1 line per key per 60 s), always via `runOutsideTrace`, never throws | `@nestjs/common` `Logger` (static use only) | `createDiagnostics(scope): Diagnostics` |
| `instance-identity.ts` | `BOOT_ID` minted once per process (stored in the global slot, so duplicate package copies agree), `createInstanceIdentity({serviceName, serviceVersion, hostName}): InstanceIdentity` | `os`, `uuid-v7` | as named |
| `env.ts` | the one NODE_ENV rule: `isDevOrTest()` is true only for `development` or `test`; unset or anything else is production. Also `envDisabled()` (`TRACELET_DISABLED=1`) and `envEnabled()` (`TRACELET_ENABLED=true|false|undefined`) | — | as named |

### 3.5 `src/context/` (INS)

| File | Role | Imports | Exports |
|---|---|---|---|
| `constants.ts` | store keys `REGISTRY_KEY='#tracelet.registryKey'`, `CALLER_KEY='#tracelet.caller'`, `ROOT_TOKEN_KEY='#tracelet.root'`, `TRACE_ID_KEY='#tracelet.traceId'` | — | constants |
| `vendor/key-of.type.ts` | copy of `types/key-of.type.ts` | — | `KeyOf` |
| `vendor/trace-span.interface.ts` | copy+modify: `origin` adds `'root'` | — | `TraceSpan` |
| `vendor/trace-events.interfaces.ts` | copy (imports the local span interface) | above | `OngoingTraceEventNode`, `CompleteTraceEventNode` |
| `vendor/sensitive-keys.ts` | copy | — | `createSensitiveKeyMatcher`, `normaliseKey`, `isSensitiveKeyByDefault` |
| `vendor/log-redactor.ts` | copy+modify: `RedactionOptions` declared locally; add default rules for URI userinfo (`scheme://user:pass@` → `scheme://[REDACTED]@`) and e-mail addresses (`[EMAIL]`) | `sensitive-keys` | `LogRedactor` |
| `vendor/deferred-completion.ts` | copy of `deferTraceCompletion`, `invokeUserCallbackSafely`, `warnSafely`, `describeFailure` (`deferred-trace-completion.ts:4-56,157-176`); `Logger` type replaced by `Diagnostics`; the timer is armed inside `runOutsideTrace` | `shared/diagnostics`, `shared/als` | as named |
| `vendor/trace-registry.ts` | modified `services/operation-trace.registry.ts` (delta in section 4) | `vendor/*`, `constants`, `shared/uuid-v7`, `shared/diagnostics` | `TraceRegistry`, `TraceletSnapshot`, `UNFINISHED_SPANS_TAG` |
| `admission.ts` | head sampler (`Math.random() < sampleRate`), token bucket `maxRootsPerSecond`, `maxOpenTraces` check | `runtime` types | `Admission` |
| `root-token.ts` | `RootToken = { open: boolean; sampled: boolean; key?: string; deadline: number /* performance.now() + maxTraceDurationMs */ }`; `isJoinable(token, registry)` implements the R2 rule (section 6.2) | `vendor/trace-registry` (type) | `RootToken`, `isJoinable` |
| `settle.ts` | the **one** settle routine used by roots and joined spans: `runAndSettle(fn, onOk, onErr)`; sync value / sync throw / plain promise chained with `.then(ok, err)` / non-plain promise watched on a side branch; every `onOk`/`onErr` call wrapped in `ignoreFailure` | — | `runAndSettle`, `ignoreFailure`, `isPlainPromise` |
| `runtime.ts` | process singleton stored in the global slot (`shared/als.ts`): registry, resolved tracing config (defaults until `configureTracing`), enabled flag, counter sink; test seam | `shared/als`, `vendor/trace-registry`, `admission` | `getRuntime()`, `configureTracing(cfg)`, `setTelemetryQueue(q: TelemetryQueue)` (also the `TelemetryCounterSink`), `createRuntimeForTesting(deps)`, `resetRuntimeForTesting()` |
| `root-runner.ts` | `trace()` and `currentTraceId()` (section 6.2); rewrite using `job-trace-runner.ts:230-364` as reference | `runtime`, `root-token`, `settle`, `constants`, `shared/*`, `buffer` (completion hand-off via an injected function, not a static import) | `trace`, `currentTraceId` |
| `sweeper.ts` | every 10 s (unref'd, armed via `runOutsideTrace`) force-closes roots older than `maxTraceDurationMs` as `incomplete`; `closeAllOpenRoots(reason)` for shutdown | `runtime` | `startSweeper()`, `stopSweeper()`, `closeAllOpenRoots()` |
| `index.ts` | package-internal API | above | `trace`, `currentTraceId`, `configureTracing`, `setTelemetryQueue`, `startSweeper`, `stopSweeper`, `closeAllOpenRoots`, `tracingHealth` (implements `TracingHealthSource`) |

### 3.6 `src/instrumentation/` (INS)

| File | Role | Imports | Exports |
|---|---|---|---|
| `vendor/instance-decorator.ts` | copy+modify of `instrument/create-instance-decorator.instrument.ts` (delta in section 4, fail-open M7) | `@nestjs/core` `Reflector`, `context/vendor/trace-registry` (type), `context/constants` | `createInstanceDecorator` |
| `exclusions.ts` | skip predicate: Tracelet brand, `TraceletInstrumentOptions.skipInstrumentation` (throwing = skip), `Reflector` (already in decorator), `ModulesContainer`, `DiscoveryService`, `MetadataScanner`, `HttpAdapterHost`, `ApplicationConfig`, `ModuleRef`, `LazyModuleLoader`, the registry and ALS objects; whole predicate in try/catch returning `true` (upstream `observe.module.ts:356-406`) | `@nestjs/core`, `shared/brand`, `context` | `createSkipPredicate(user?)` |
| `instrument.ts` | the object passed to NestFactory: `createTraceletInstrument(options?: TraceletInstrumentOptions)` (frozen signature; `TraceletInstrument = createTraceletInstrument()`). At **each decoration** it evaluates the enable decision (`TRACELET_DISABLED=1` > `options.enabled` > `TRACELET_ENABLED` > `isDevOrTest()`); when off it returns the instance untouched. Outer `try { return decorate(instance) } catch { return instance }` because Nest 11.1.4/11.1.6 call it without a guard (`injector.js:414,419`, `module.js:247`); sets `instrumentInstalled = true` on the first proxied instance | `vendor/instance-decorator`, `exclusions`, `context`, `shared/env` | `TraceletInstrument`, `createTraceletInstrument` |
| `index.ts` | | | `TraceletInstrument`, `createTraceletInstrument` |

### 3.7 `src/buffer/` (INS)

| File | Role | Imports | Exports |
|---|---|---|---|
| `self-time.ts` | union-of-intervals exclusive time (contract invariant 6) | — | `computeSelfTimes(tree)` |
| `vendor/collapse-repeated-spans.ts` | copy+modify of `services/collapse-repeated-spans.util.ts` (option type local; runs after self-time) | `context/vendor/trace-events.interfaces` | `collapseRepeatedSpans`, `resolveSpanCollapseSettings`, `SPAN_COLLAPSED_TAG` |
| `error-sanitizer.ts` | `SanitizedError` from the registry payload: name <= 128, message redacted + <= 1024 (or omitted), stack frames only, <= 20, paths relative to `process.cwd()`, `node_modules/<pkg>/...` shortened, each <= 256; fingerprint = first 16 hex of sha1(name + "\u0000" + first in-app frame without line/col + "\u0000" + operation) (NUL separators so field boundaries cannot shift) | `context/vendor/log-redactor` | `sanitizeError`, `fingerprint` |
| `attributes.ts` | bound + redact `TraceOptions.attributes` (<= 16 keys, key pattern, string <= 256, finite numbers) | `context/vendor/log-redactor` | `boundAttributes` |
| `record-mapper.ts` | snapshot to `TraceItem` (section 3 of the freeze doc); per-trace span cap check; byte estimate | above, `contracts` | `toTraceItem` |
| `histogram.ts` | bucket index for `HISTOGRAM_BOUNDS_MS` | `contracts` | `bucketIndex`, `emptyHistogram` |
| `rollups.ts` | per-minute in-memory accumulators: operation (every settled root, sampled or not) and method (sampled spans); <= 500 operations and <= 2000 methods per instance-minute, overflow into `(other)`; keeps current + 2 previous minutes. **`flush()` cadence (R9):** called every 10 s (`ROLLUP_FLUSH_INTERVAL_MS`, a constant with a test seam; timer unref'd and armed in `runOutsideTrace`), when a minute bucket closes, and once at shutdown before the writer's final flush. Each call offers **one `RollupItem` per dirty bucket**; every item covers exactly one bucket minute and holds that bucket's **full** current aggregates (operations + methods), never deltas. Items with no documents are never offered | `histogram`, `contracts`, `shared/instance-identity` | `RollupAccumulator` |
| `telemetry-queue.ts` | `BoundedTelemetryQueue implements TelemetryQueue` (also the `TelemetryCounterSink`) with three pools: `trace`, `profile`, `control` (rollups + metrics, reserved capacity) and `drain(maxItems, maxBytes)` (section 9). **Control-pool coalescing (R9):** a `RollupItem` is keyed by its bucket (the `bucketStart` shared by all its documents; one instance per process). An offer whose key is already queued **replaces** the queued item in place, keeping its FIFO position and adjusting the byte total. This is safe because each item is a full, idempotent replacement. Items already drained (in flight) are never touched; with one in-flight batch and FIFO order, a newer aggregate is always written after an older one | `contracts` | as named |
| `index.ts` | | | `BoundedTelemetryQueue`, `RollupAccumulator`, `toTraceItem` |

### 3.8 `src/profiling/` (PRO)

| File | Role | Imports | Exports |
|---|---|---|---|
| `vendor/cpu-sampler.ts` | modified `profiling/cpu-profiler.service.ts` (section 7) | `node:inspector`, `vendor/fold-profile`, `shared/als` | `ContinuousCpuSampler`, `SamplerWindow` |
| `vendor/fold-profile.ts` | modified `profiling/fold-profile.util.ts` (no slices; idle/total counts; frame path relativization; `;` sanitization; depth cap) | — | `foldProfile`, `V8Profile`, `FoldResult` |
| `vendor/node-runtime-metrics.interface.ts` | copy | — | `NodeRuntimeMetrics` |
| `vendor/runtime-metrics.ts` | modified `services/node-runtime-metrics.service.ts` (plain class; no `@Injectable`, no `OBSERVE_OPTIONS`; `start/stop/collect`) | `node:perf_hooks`, `node:os` | `RuntimeMetricsSampler` |
| `inspector-probe.ts` | `process.config.variables.v8_enable_inspector`, `require('node:inspector')`, `Session.connect()` probe | `node:inspector` | `probeInspector(): {available, reason?}` |
| `profile-mapper.ts` | `FoldResult` to `CpuProfile`: top-K `maxStacksPerProfile`, then trim lowest-sample stacks until the estimated serialized size is within `maxProfileBytes`; every trimmed stack goes into `droppedStackCount`/`droppedSampleCount`; `gapBeforeMs` from sample timestamps (section 7) | `contracts`, `shared/*` | `toProfileItem` |
| `profiler.service.ts` | lifecycle, state machine, backoff (M8), health; offers `ProfileItem` to the queue | above | `ContinuousProfiler` (implements `ProfilerHealthSource`) |
| `metrics-collector.ts` | every `intervalMs`: runtime gauges + `TelemetryQueue.counters()` deltas to `MetricItem` | `vendor/runtime-metrics`, `contracts` | `MetricsCollector` |
| `index.ts` | | | `ContinuousProfiler`, `MetricsCollector`, `probeInspector` |

### 3.9 `src/storage/`, `src/query/`, `src/api/` (STO)

| File | Role | Imports |
|---|---|---|
| `storage/mongo-client.factory.ts` | own `MongoClient` (appName `tracelet`, `maxPoolSize`, `serverSelectionTimeoutMS`, `retryWrites: true`); URI never logged | `mongodb` |
| `storage/collections.ts` | collection names with prefix; typed document interfaces | `contracts` |
| `storage/documents.ts` | DTO to document (BSON dates, `expireAt`, `_id`, denormalized span fields) and back | `contracts` |
| `storage/indexes.ts` | `ensureIndexes()` exactly the freeze-doc index set; idempotent | `collections` |
| `storage/retry.ts` | exponential backoff 500 ms to 8 s, full jitter | — |
| `storage/telemetry-writer.ts` | drains `TelemetryQueue` with `drain(batchSize, maxBatchBytes)`, paces document writes to `maxWriteDocsPerSecond` (section 9), counts through the sink; implements `StorageHealthSource` | `contracts`, `shared/diagnostics`, above |
| `storage/heartbeat-writer.ts` | `instances` upsert every 30 s from a `HeartbeatFactory` | above |
| `storage/index.ts` | `createStorage(config, queue, identity, heartbeatFactory)` returning `{start, stop, flush, health}` | |
| `query/filters.ts` | parameter parsing, window caps, search literal escaping | `contracts` |
| `query/cursor.ts` | opaque cursor encode/decode/filter binding | `node:crypto` |
| `query/percentiles.ts` | approx p50/p95 from merged histograms | `contracts` |
| `query/*.repository.ts` | `trace`, `profile`, `rollup`, `error`, `instance` reads; every read projected and `maxTimeMS: 5000` | `storage/collections` |
| `api/query-api.handler.ts` | `createQueryApiHandler(deps): ApiHandler` | `query`, `contracts` |
| `api/routes.ts`, `api/dto-mappers.ts`, `api/errors.ts`, `api/concurrency-limiter.ts`, `api/index.ts` | routing, mapping, error envelope, 4-slot heavy-query limiter | |

### 3.10 `src/http/`, `src/config/`, root entrypoints (LEAD)

| File | Role | Imports | Exports |
|---|---|---|---|
| `config/options.ts` | defaults, env overrides (`TRACELET_ENABLED`, `TRACELET_DISABLED`), range validation | `contracts` | `resolveOptions`, `ResolvedTraceletConfig` |
| `http/auth.ts` | default policy + `authorize()` adapter (section 12) | `contracts` | `createAuthGate` |
| `http/security-headers.ts` | CSP and other headers | — | `apiHeaders`, `assetHeaders`, `htmlHeaders` |
| `http/static-assets.ts` | loads `assets/dashboard/asset-manifest.json` + files into memory (cap 8 MB), ETag, SPA fallback, config injection | `contracts` | `createStaticAssets(basePath)` |
| `http/dispatcher.ts` | auth gate, then `/api/v1/*` to `ApiHandler`, else static/SPA; whole body in `runOutsideTrace` | `api`, `shared/als`, above | `createDispatcher` |
| `http/mount-express.ts` | `app.use(basePath, handler)` on the Express instance (Express 5 prefix match, no wildcard syntax) | `dispatcher` | `mountExpress` |
| `http/mount-fastify.ts` | `instance.route({ method: ['GET','HEAD'], url: basePath })` and `basePath + '/*'` | `dispatcher` | `mountFastify` |
| `http/standalone-server.ts` | `node:http` listener (default `127.0.0.1`) | `dispatcher` | `startStandaloneServer` |
| `tracelet.module.ts` | `TraceletModule.forRoot/forRootAsync`; `TraceletLifecycle` provider (branded internal) | everything | `TraceletModule` |
| `tracelet.ts` | `Tracelet.setup(app, opts)`, `Tracelet.listen(opts)` | `http`, `config` | `Tracelet` |
| `index.ts` | public API, explicit named re-exports | | `trace`, `currentTraceId`, `TraceletInstrument`, `TraceletModule`, `Tracelet`, public types |

### 3.11 Dashboard (DSH)

`packages/tracelet/ui/**` (own `package.json`, Vite + React + TypeScript, Playwright tests, `scripts/write-manifest.mjs`). Build output `packages/tracelet/assets/dashboard/**` including `asset-manifest.json` (`DashboardAssetManifest`) and `index.html` containing `<!--tracelet:config-->` exactly once. Output is committed so the Nest package builds without a UI toolchain. UI imports contract types only, through the TS path alias `@tracelet/contracts` mapped in `ui/tsconfig.json` to `../src/contracts/observe-contracts.ts` (relative to `packages/tracelet/ui/`); type-only imports, so nothing from `src/` is bundled. Production build must not contain fixtures (test: grep the bundle for `0199aabb-ccd1` and `0199f0e0-0000` fixture ids).

### 3.12 Tests, bench and examples

| Path | Owner |
|---|---|
| `tests/unit/{context,instrumentation,buffer}/**`, `tests/integration/{poc,instrumentation}/**`, `tests/support/instrumentation/**` (fake amqp channel, memory queue), `bench/instrumentation/**` | INS |
| `tests/unit/profiling/**`, `tests/integration/profiling/**`, `tests/integration/poc/t09-*`, `t10-*`, `t18-*`, `bench/profiling/**`, `tests/support/profiling/**` | PRO |
| `tests/unit/{storage,query,api}/**`, `tests/integration/storage/**`, `tests/support/storage/**` | STO |
| `tests/unit/{http,config}/**`, `tests/integration/http/**` (Express and Fastify), `tests/e2e/**`, `tests/contract/**` | LEAD |
| `ui/tests/**` | DSH |
| `examples/nest-worker/**` (raw amqplib consumer, `docker-compose.yml` with RabbitMQ + Mongo) | LEAD (M07) |

Ported upstream tests (adapted, with attribution header): `create-instance-decorator.instrument.spec.ts`, `hostile-providers.int-spec.ts` (nestjs-cls case; adds devDep `nestjs-cls` by CR if kept), `operation-trace.registry.spec.ts` (HTTP/GraphQL/skipSpans/slice cases dropped and listed in the fork delta), `collapse-repeated-spans.util.spec.ts`, `deferred-trace-completion.spec.ts` (subset), `log-redactor.spec.ts`, `sensitive-keys.spec.ts`, `uuid-v7.util.spec.ts` (INS); `cpu-profiler.service.spec.ts` (rewritten for the loop), `fold-profile.util.spec.ts` (minus slices), `node-runtime-metrics.service.spec.ts` (PRO).

---

## 4. Full transitive vendor closure (M2)

Starting points: `create-instance-decorator`, `operation-trace.registry`, `job-trace-runner` (reference), `deferred-trace-completion`, `cpu-profiler.service`, `fold-profile.util`, `node-runtime-metrics.service`. Closure computed from every `import`/`export ... from` (including multi-line and type-only imports) at the pin.

| # | Upstream file (pin) | Reached from | Action | Destination / reason |
|---|---|---|---|---|
| 1 | `src/instrument/create-instance-decorator.instrument.ts` (674) | start | **modify** | `src/instrumentation/vendor/instance-decorator.ts`. Changes: (a) M7: `internalStartTraceStep` (`:126`) in try/catch; on failure run untraced and reset the active flag; `setActive(true)` moved after a successful start; (b) M7: sync return (`:214`) becomes `ignoreFailure(() => onReturnValue(result)); return result;`, sync throw (`:215-216`) becomes `ignoreFailure(() => recordError(err)); throw err;`; (c) the proxy `get` trap body wrapped so any failure returns `Reflect.get(target, prop)`; (d) imports re-pointed; **(e) L-a:** the wrapper already reads the store, so it also reads `ROOT_TOKEN_KEY` and runs **untraced** when the token exists and `token.open === false`. Without this, during the pluck window (up to 1000 ms) or while a force-closed snapshot is still held, calls from a stale store would attach spans to a closed trace; constants from `context/constants`. Everything else verbatim (receiver rules `:280-310`, plain-promise rule `:196-212`, callable-object/constructor checks, metadata copy `:394-406`). |
| 2 | `src/services/operation-trace.registry.ts` (1042) | 1 | **modify (substantial)** | `src/context/vendor/trace-registry.ts`. Remove: `Request/JobSnapshot` types, `reportMissingInstrumentation` (`:373-405`), `toErrorStatusCode`/`IntrinsicException`/`setStatusCode` (`:407-438`), `addRouteMetadataToTrace`, `setOperationId`, `applyCustomOperationId`, `addGraphQLMetadataToTrace` (`:609-686`), `skipSpans` (`:902-932`), `activeSliceRecorder` hooks (`:459,543,977`), source-context code frames (`:209-229`), Nest `Logger`. Add: `startRoot(key, meta, token)` creating a synthetic root span node (origin `root`) registered as a caller, and **keeping the root's `RootToken`** (R2); `endRoot(key, error?)` (flips `token.open = false`); `has(key)`; empty roots kept (`:294-309` deletion removed); `maxSpansPerTrace` and the global `maxOpenSpans` budget (start returns `undefined`, counts `spansDropped` through the sink and the trace's `droppedSpanCount`; R6); `maxOpenTraces`; error-origin tracking (per-trace identity set: first span ending with an error value gets the payload, ancestors get `error: true`); `attachToCaller` fallback attaches to the live root span instead of `snapshot.traces` (single-root invariant); `forceClose(key, reason)` and `closeAllOpenRoots(reason)` for sweeper/shutdown, both flipping the stored `token.open = false` (R2); **synchronous** `startManualSpan(key, callerId, name): string | undefined` and `endManualSpan(key, spanId, error?)` that book into the same refs ledger as auto spans (R1). **Removed:** `createManualSpan` (`:946-1041`) — it is `async`, so it would return a promise for a sync `fn` and it calls `spanFunction` itself; the root runner calls `fn` (R1). Pluck no longer collapses (moved to buffer, after self-time). Keep: refs ledger, `internalStartTraceStep/EndTraceStep`, `pluckSnapshot` 1000 ms wait and `leaveOutUnfinishedSpans` (`:770-876`), redactor hook. |
| 3 | `src/observe.constants.ts` | 1, 2 | **rewrite** | `src/context/constants.ts` (only store keys; `OBSERVE_OPTIONS`, `JOB_TRACE_OPTION_KEY` dropped) |
| 4 | `src/types/key-of.type.ts` | 1, 2 | copy | `src/context/vendor/key-of.type.ts` |
| 5 | `src/interfaces/trace-events.interfaces.ts` | 2 | copy | `src/context/vendor/trace-events.interfaces.ts` |
| 6 | `src/interfaces/trace-span.interface.ts` | 5 | modify | adds `origin: 'root'` |
| 7 | `src/interfaces/index.ts` (barrel) | 2 (`JobSnapshot`) | **skip** | pulls custom-metric, graphql, request/job snapshot and options types |
| 8 | `src/interfaces/job-snapshot.interface.ts` | 2, 7 | skip | replaced by `TraceletSnapshot` |
| 9 | `src/interfaces/request-snapshot.interface.ts` | 2, 7 | skip | HTTP-only; it also imports `utils/capture-request.util.ts` (skip) |
| 10 | `src/interfaces/observe-options.interface.ts` (850) | 2, log-redactor, collapse, skip-spans, runtime metrics | **skip** | needed types re-declared locally (`RedactionOptions` in the redactor, collapse option in the collapse util). It imports `@nestjs/microservices` and `outgoing/http.integration.ts`, neither taken. |
| 11 | `src/interfaces/custom-metric.interface.ts`, `graphql.interfaces.ts` | 7, 10 | skip | not used |
| 12 | `src/utils/capture-request.util.ts`, `src/outgoing/http.integration.ts` | 9, 10 (type-only) | skip | HTTP capture / outgoing patch |
| 13 | `src/profiling/span-slice-recorder.ts` | 2, cpu-profiler, fold | skip | unsound per-span attribution |
| 14 | `src/utils/uuid-v7.util.ts` | 2, runner, deferred | copy | `src/shared/uuid-v7.ts` |
| 15 | `src/trace-span.delegate.ts` | 2 (`createManualSpan`) | skip | no manual span tag API in v1; `createManualSpan` itself is replaced (row 2) |
| 16 | `src/utils/source-context.util.ts` | 2 | **skip** | sync `readFileSync` on the error path and source text in payloads (Stage 00 review L9) |
| 17 | `src/utils/source-map-resolver.util.ts`, `@jridgewell/trace-mapping` | 16 | skip | no source maps in v1 |
| 18 | `src/utils/fallback-operation-id.util.ts` | 2 | skip | HTTP-only |
| 19 | `src/utils/log-redactor.ts` | 2 | modify | `src/context/vendor/log-redactor.ts` (local options type, two extra default rules) |
| 20 | `src/utils/sensitive-keys.ts` | 19 | copy | `src/context/vendor/sensitive-keys.ts` |
| 21 | `src/services/collapse-repeated-spans.util.ts` | 2 | modify | `src/buffer/vendor/collapse-repeated-spans.ts` (local option type) |
| 22 | `src/services/skip-spans.util.ts` | 2 | skip | status-code based, HTTP-only |
| 23 | `src/protocols/job-trace-runner.ts` | start (reference) | **rewrite** | `src/context/root-runner.ts`; settle pattern from `:341-362`, but `.then(ok, err)` instead of `.then().catch()` so a telemetry failure in the success path cannot turn into a rejection; JOIN-IF-OPEN replaces `:243-268`; no `Queue.prototype.add` patch (`:106-146`) |
| 24 | `src/agent/observe-agent.shared-buffer.ts` | 23 | skip | SAB transport |
| 25 | `src/utils/default-trace-id-generator.util.ts` | 23 | skip | inherited ids not used |
| 26 | `src/protocols/deferred-trace-completion.ts` | 23 | modify (subset) | `src/context/vendor/deferred-completion.ts` |
| 27 | `src/observe.module.ts` | reference | rewrite | exclusion list idea (`:356-406`) into `exclusions.ts`; instrument shape (`:408-431`) into `instrument.ts` |
| 28 | `src/services/tracer.service.ts`, `trace-sampler.service.ts` | reference | skip | replaced by `trace()` and `admission.ts` |
| 29 | `src/profiling/cpu-profiler.service.ts` (280) | start | **modify (substantial)** | `src/profiling/vendor/cpu-sampler.ts` (section 7) |
| 30 | `src/profiling/fold-profile.util.ts` (201) | 29 | modify | `src/profiling/vendor/fold-profile.ts`. The edit **removes `import { SpanSlice } from "./span-slice-recorder.js"` (`:1`)**, the `slices` option, `findSlice` and the `spanId/traceId` tagging, so row 13 is no longer reached |
| 31 | `src/profiling/profile-uploader.ts` | worker | skip | egress to hosted `/applications/profiles` |
| 32 | `src/services/node-runtime-metrics.service.ts` (272) | start | modify | `src/profiling/vendor/runtime-metrics.ts` |
| 33 | `src/interfaces/node-runtime-metrics.interface.ts` | 32 | copy | `src/profiling/vendor/node-runtime-metrics.interface.ts` |
| 34 | The **reached-but-skipped** files of table 4.1 (`agent/*`, `encoders/*`, `custom-metrics/*`, `objectives/*`, `outgoing/{http.integration,outgoing-span.recorder}`, `utils/{redact-url-query,fit-to-length,capture-request}` etc.) | reached (see 4.1) | skip | each edge is cut by a named edit in table 4.1 |
| 35 | Not reached from the vendored starting set: `cli/*`, `testing/*`, every `protocols/*` service, `outgoing/*` drivers other than `http.integration`/`outgoing-span.recorder`, `services/{tracer,trace-sampler,stdout-forwarder,logger-patcher}.service.ts`, `agent/observe-agent.worker.ts` and the detached worker, `profiling/profile-uploader.ts`, remaining `utils/*` | only via `observe.module.ts`, which is reference-only and never compiled | skip | not in the compiled closure |

Third-party imports kept by the vendored set: `@nestjs/core` (`Reflector`, peer), `@nestjs/common` (`Logger` in `shared/diagnostics.ts` only), Node built-ins. Upstream Nest-11-only symbols removed: `IntrinsicException` (registry `:1,418`). No `@nestjs/microservices`, no `@jridgewell/trace-mapping`.

### 4.1 Reached-but-skipped files and the edit that cuts each edge (L2)

Computed by `scratchpad/cv-src/closure-nomodule.cjs` (a regex walk of every relative `from "..."` specifier, type-only and multi-line included) from the seven vendored or reference starting files: **50 files reached**. With `observe.module.ts` added as a start the walk reaches 83 files; the extra 33 come only through that reference-only file and are rows 35 above.

| Reached file(s) | First edge (importer) | Cut by |
|---|---|---|
| `agent/observe-agent.shared-buffer.ts`, then `agent/degraded-ingest.protocol.ts`, `agent/telemetry-wire-contract.ts`, `custom-metrics/{index,counter,gauge,summary,finite-value.util}.ts`, `objectives/{objectives.registry,objective.decorator}.ts`, `encoders/{custom-metrics,job-snapshot,request-snapshot,runtime-metrics,trace}.encoder.ts`, `encoders/remap-keys.util.ts`, `utils/fit-to-length.util.ts` | `protocols/job-trace-runner.ts:3` | Row 23: the runner is rewritten, not copied; `root-runner.ts` has no buffer import and hands items to `TelemetryQueue` |
| `utils/default-trace-id-generator.util.ts` | `job-trace-runner.ts:15` | Row 23 (no inherited ids) |
| `interfaces/index.ts` and, through it, `custom-metric.interface.ts`, `graphql.interfaces.ts`, `job-snapshot.interface.ts` | `services/operation-trace.registry.ts:5` | Row 2: `JobSnapshot` import removed; `TraceletSnapshot` declared locally |
| `interfaces/request-snapshot.interface.ts`, then `utils/capture-request.util.ts`, then `utils/redact-url-query.ts` | `operation-trace.registry.ts:6` | Row 2: `RequestSnapshot` import removed |
| `interfaces/observe-options.interface.ts`, then `outgoing/http.integration.ts`, then `outgoing/outgoing-span.recorder.ts` (and `@nestjs/microservices`) | `operation-trace.registry.ts:7` (also `log-redactor.ts:1`, `collapse-repeated-spans.util.ts:1`, `skip-spans.util.ts:1-4`, `node-runtime-metrics.service.ts:18`) | Rows 2, 19, 21, 32: each vendored file declares the one option type it needs locally; `observe-options.interface.ts` is never copied |
| `profiling/span-slice-recorder.ts` | `operation-trace.registry.ts:3`, `cpu-profiler.service.ts:4`, `fold-profile.util.ts:1` | Rows 2, 29, 30: imports and hooks removed |
| `trace-span.delegate.ts` | `operation-trace.registry.ts:12` | Row 2: `createManualSpan` removed (R1) |
| `utils/source-context.util.ts`, then `utils/source-map-resolver.util.ts` (and `@jridgewell/trace-mapping`) | `operation-trace.registry.ts:14` | Row 2: code frames removed |
| `utils/fallback-operation-id.util.ts` | `operation-trace.registry.ts:15` | Row 2: HTTP naming removed |
| `services/skip-spans.util.ts` | `operation-trace.registry.ts:23` | Row 2: `skipSpans` removed |

**Reversals of Stage 00 section 5.1 (L2).** Stage 00 proposed to copy `utils/redact-url-query.ts`, `utils/fit-to-length.util.ts` and `services/skip-spans.util.ts`. Stage 01 skips all three:
- `redact-url-query`: v1 captures no URLs (no HTTP roots, no outgoing spans), so nothing calls it. Error messages are scrubbed by `LogRedactor`, plus the URI-userinfo rule.
- `fit-to-length`: in upstream only the encoders and module (service version) use it. Tracelet bounds strings with plain truncation in `attributes.ts`/`error-sanitizer.ts` and needs no hash suffix.
- `skip-spans`: it decides by HTTP status code, which v1 roots do not have.

**Dropped module behaviour (L2).** `propagateTraceIdThrough` (`observe.module.ts:425,445-469`) installs a `setOnDispatchHook` on `@nestjs/microservices` clients so outgoing packets carry `x-request-id`. Tracelet drops it: no cross-service propagation in v1 (product brief non-goal), and it would mutate host client instances. Recorded in `FORK_DELTA.instrumentation.md`.

---

## 5. Module dependency graph (enforced by `eslint no-restricted-imports`)

```
contracts  <- (nothing)
shared     <- contracts
context    <- shared, contracts
instrumentation <- context, shared, contracts, @nestjs/core
buffer     <- context (types + redactor), shared, contracts
profiling  <- shared, contracts                     (never context/buffer)
storage    <- shared, contracts, mongodb            (never context/buffer/profiling)
query      <- storage/collections + documents, shared, contracts, mongodb
api        <- query, shared, contracts
http       <- api (ApiHandler type + factory), shared, contracts
config     <- contracts
tracelet.module.ts / tracelet.ts / index.ts <- everything (LEAD wiring only)
ui         <- contracts (type-only)
```

Cross-owner runtime coupling happens only through `TelemetryQueue`, the health-source interfaces, `ApiHandler`, `InstanceIdentity` and `DashboardAssetManifest`, all wired in `tracelet.module.ts`.

---

## 6. Trace pipeline

### 6.1 Sequence

```
consume callback
  -> trace(name, fn, opts)                         [context/root-runner.ts, sync]
     effective forceRoot (rabbitmq => true unless join); joinable token? -> joined span path (6.2)
     admission (enabled? sampled? bucket? open<cap?)
     store = new Map{REGISTRY_KEY, CALLER_KEY=rootSpanId, ROOT_TOKEN_KEY, TRACE_ID_KEY}
     registry.startRoot(key, {name, kind, attributes, startedAt=Date.now(), sampleRate})
     traceletAls.run(store, fn)                     <- fn invoked synchronously, nothing awaited first
        provider proxy wrapper (instance-decorator) -> registry.internalStartTraceStep(key, cls, m, caller)
           als.run(copy(store)+CALLER_KEY=newSpanId, original)  -> nested spans
           settle -> internalEndTraceStep(... error?)            (fail-open)
     settle root (sync / plain promise .then(ok, err) / non-plain watched on a side branch)
       -> token.open = false; registry.endRoot(key, error?); rollups.recordRoot(...)
       -> deferTraceCompletion via runOutsideTrace(setTimeout 0)
  completion (outside any trace)                   [context + buffer]
     snapshot = await registry.pluckSnapshot(key)   (waits <= 1000 ms for open spans)
     item = toTraceItem(snapshot): self-time -> collapse -> flatten -> sanitize -> cap
     rollups.recordSpans(item)                      (method stats, sampled traces only)
     queue.offer(item)  -> false => counted drop (queueFull)
  writer loop (outside any trace)                  [storage/telemetry-writer.ts]
     waitForItems(flushIntervalMs) ; drain(batchSize, maxBatchBytes) ; pace to maxWriteDocsPerSecond
     insertMany traces + spans (ordered:false), replaceOne rollups, insertMany profiles/metrics
     retry with backoff (<= maxRetries) else reportDropped(items, 'storage')
  query                                             [query/*, api/*]
     GET /observe/api/v1/traces ...  -> seek query on traces indexes -> DTO
  UI                                                [ui, served by http/static-assets.ts]
     fetch apiBase from the injected config block -> waterfall from TraceDetail
```

### 6.2 Root semantics (frozen; H6 and M7)

- **Disabled** (`enabled=false`, `tracing.enabled=false`, `TRACELET_DISABLED=1`, production default without explicit enable, or the runtime failed to initialise): `return fn()`; no ALS, no allocation beyond the call.
- **Effective forceRoot (R3):** `forceRoot = opts.forceRoot ?? (opts.kind === 'rabbitmq' && opts.join !== true)`; `forceRoot: true` wins over `join`. A consume callback therefore always gets its own root even if the delivery fires synchronously inside an open setup trace. Every documented example uses `trace('rabbitmq.consume', () => handle(msg), { kind: 'rabbitmq', attributes: { queue } })`.
- **Nested policy JOIN-IF-OPEN (R2).** Let `token = store?.get(ROOT_TOKEN_KEY)`. **Join** only if `!forceRoot && token?.open === true && (token.sampled ? registry.has(token.key) : performance.now() < token.deadline)`. Otherwise (no store; a closed, force-closed or expired token, i.e. a stale store captured by an amqplib socket/channel created inside an earlier trace; or `forceRoot`) start a **new root with a fresh `Map`** (stale entries are never copied).
- `token = { open, sampled, key?, deadline }` lives in the store **and** (sampled roots) in the registry. `open` flips to `false` synchronously when the root settles (before deferred completion), and also when the sweeper or shutdown force-closes the root (`forceClose`/`closeAllOpenRoots` flip the registry's copy, which is the same object as the store's). Unsampled roots are not in the registry; their token carries `deadline = start + maxTraceDurationMs`, checked at join time.
- **Joined span, sampled (R1):** `spanId = ignoreFailure(() => registry.startManualSpan(key, store.get(CALLER_KEY), name))`. If `spanId` is undefined (start threw, span budget exhausted, trace gone) the runner calls `fn()` in the current store and returns its result untouched. Otherwise it runs `traceletAls.run(copy(store) + {CALLER_KEY: spanId}, () => runAndSettle(fn, ok, err))` where `ok`/`err` call `registry.endManualSpan(key, spanId, error?)` inside `ignoreFailure`. `runAndSettle` is the same routine roots use (`context/settle.ts`), so value identity, throw identity, plain-promise chaining and non-plain promise pass-through are identical. `fn` is invoked from exactly one call site per path, never inside a `try` that could re-invoke it.
- **Joined, unsampled:** `fn()` runs in the current store (part of the outer unsampled root).
- **Sampling/admission** at a new root: if `Math.random() >= sampleRate`, or the token bucket is empty, or open traces `>= maxOpenTraces`, the root runs **unsampled** (fresh store with an unsampled open token; provider calls run untraced because no registry key exists). Counted as `rootsSampledOut` or `tracesDroppedAdmission`. If an unsampled root fails and `keepFailedRoots` is true, a `rootOnly` trace (1 span, status error, sanitized error, duration) is enqueued, subject to the same token bucket.
- **Return/throw** semantics are the `TraceFn` contract. Settle uses `.then(onOk, onErr)` where both handlers wrap telemetry in `ignoreFailure` and then return the value / rethrow the same reason.
- **Fail-open (M7, R1):** every Tracelet step around `fn` (`admission`, token creation, `startRoot`/`startManualSpan`, store creation, `endRoot`/`endManualSpan`, completion scheduling, mapping, `offer`, `count`) is individually wrapped in `ignoreFailure`; on failure before `fn`, `fn` runs exactly once in the caller's original store; after `fn`, the business result is untouched. A failure before `fn` must not leave a half-open root: `startRoot` failure means no token is stored.
- **Timeouts:** the sweeper force-closes roots older than `maxTraceDurationMs` (status `incomplete`, `isComplete=false`, root span duration = time until close, token closed). Late ends are ignored (no snapshot).
- **Rollup accounting exactly once (L5):** `rollups.recordRoot(...)` is called by whichever comes first, root settle or force-close (sweeper or shutdown), guarded by a `recorded` flag on the root token. A force-closed root counts as `count += 1`, not an error, with the duration measured to the close. Its later settle changes nothing (no second `recordRoot`, no second trace). Unsampled roots are not in the registry and record only at settle; an unsampled root that never settles is never counted (documented limitation; no extra tracking structure). Test: `tests/unit/context/rollup-once.spec.ts` covers settle-only, force-close then late settle, and shutdown then late settle, each giving count 1.
- **`currentTraceId()` (L6):** returns the `traceId` only while the store's token is sampled **and** open (and the registry still has the key). It returns `undefined` with no store, an unsampled root, or a closed/stale token, so a stale amqplib store never leaks an old id into logs.
- **Non-native thenables (optional):** `instanceof Promise` is the only async detection, as in upstream (`instance-decorator:184`). A thenable that is not a native Promise is a plain value: the root or span settles at return time and the thenable is returned untouched. Documented in the `TraceFn` contract and the README.
- **IDs:** `traceId` = uuidv7 at root start (`currentTraceId()` reads `TRACE_ID_KEY`); `spanId` = uuidv7 per span (upstream `registry:452`).

### 6.3 Span semantics

- Proxy wrapper and caller propagation are upstream (`instance-decorator:99-223`); each span runs in a shallow copy of the store with its own `CALLER_KEY` (`:176-180`), which is what makes concurrent and overlapping siblings correct.
- Re-entrancy: synchronous direct recursion on the same `(target, method)` is traced once (`:111-116`, `:359-371`).
- Observables and async iterables end at return (`:183-214`): documented unsupported (T08).
- `#private` classes and slot-backed built-ins run with the raw receiver; nested `this.x()` calls are not traced (`:280-310`).
- Errors: the origin span gets `sanitizedError`; ancestors that rethrow get `status: 'error'` only; a span that catches does not get an error. `errorCount` counts origin spans.
- **Observable change kept from upstream (optional):** before recording an error, the wrapper rewrites the top `Proxy.<method>` frame of `err.stack` to `<Class>.<method>` (`relabelProxyFrame`, `instance-decorator:161,474-495`). The error **reference** and every other property are unchanged, but `err.stack` text differs from an uninstrumented run (best effort; a read-only `stack` is left alone). Documented in the README; T05 asserts reference identity, not stack-text equality.

### 6.4 Mapping and caps (buffer)

Order inside `toTraceItem`: (1) self-time on the full tree (union of child intervals clipped to the parent; omitted when a child lacks an offset or a child was left out as unfinished); (2) `collapseRepeatedSpans` (threshold 20, keep slowest 3; a collapsed node's self time = sum of its members'); (3) flatten depth-first; (4) sanitize errors and attributes; (5) if more than `maxSpansPerTrace` spans remain (possible only via collapse arithmetic edge cases) truncate deepest-last and add to `droppedSpanCount`; (6) estimate bytes (`600 + 280 * spans + error text lengths`).

### 6.5 Storage hand-off

See section 9 for bounds and drops. The writer runs entirely inside `runOutsideTrace` (its loop is started there, so all its timers, promises and driver sockets inherit an empty store).

### 6.6 Query and UI

Routes, caps and cursor rules: freeze doc section 6 and `query-api.openapi.yaml`. The UI uses only `apiBase` from the injected `DashboardRuntimeConfig`; it never builds Mongo queries and never falls back to fixtures.

---

## 7. CPU pipeline

```
ContinuousProfiler.start()  (only if profiling.enabled and probeInspector().available)
  ContinuousCpuSampler (one persistent inspector Session, connected once)
    Profiler.enable ; Profiler.setSamplingInterval(round(1e6 / sampleRateHz)) ; Profiler.start   -> window 0
    every windowMs (unref'd timer armed in runOutsideTrace):
       a = performance.now(); profile = await Profiler.stop;  b = performance.now()   -> stopStallMs  = b - a
                              await Profiler.start;            c = performance.now()   -> startStallMs = c - b
       setImmediate -> d; foldProfile(profile) (idle/total counts, top-K, depth cap); e  -> foldMs = e - d
       sampleTime(k) = profile.startTime + sum(timeDeltas[0..k])          (µs, V8 monotonic clock, one persistent session)
       firstSample(i), lastSample(i) = sampleTime of window i's first and last sample (idle samples included)
       gapBeforeMs(window i+1) = (firstSample(i+1) - lastSample(i)) / 1000   (R5 rev 4: from SAMPLES; V8 stamps
                                 startTime BEFORE the Profiler.start stall, so startTime - prev.endTime hides it)
       sampledSpanMs(i) = (lastSample(i) - firstSample(i)) / 1000   (debug counter; basis of coverage and achieved rate)
       toProfileItem (maxStacksPerProfile, maxProfileBytes) -> queue.offer   (false => profilesDropped)
    backoff (replaces the permanent kill switch, cpu-profiler.service.ts:229-246):
       if startStallMs + stopStallMs + foldMs > maxStallMs (default 250) for 3 consecutive windows -> state 'backoff',
       stop sampling for 1, 2, 4 ... (max 8) windows, then resume; reason names which of the three dominated
    inspector error -> state 'error' with reason, retry once after 60 s, then 'error' until restart
    stop(): final Profiler.stop, fold, offer; disconnect; state 'stopped'
MetricsCollector (every runtimeMetrics.intervalMs) -> MetricItem (gauges + counter deltas)
writer -> tracelet_profiles / tracelet_metric_rollups -> /profiles, /flamegraph, /health
```

- **H1 fix:** no `setInterval` plus duty timer; one chained loop, `stop` immediately followed by `start` on the same session, folding moved off the stop/start critical path. The unsampled gap is computed from **sample timestamps** (`gapBeforeMs` = first sample of this window minus last sample of the previous one, R5 revision 4), stored per window, and asserted in T09/T10 (section 16). The re-review measured, with 20 000 compiled functions, that V8's `startTime - prev.endTime` is only 9.6-9.8 ms while the first sample arrives 91-116 ms after `startTime`: V8 stamps `startTime` before the `Profiler.start` stall. A gap from `startTime`/`endTime` would therefore hide the dominant stall, and `sum(durationMs) / wall` would overstate coverage by exactly that stall. `durationMs` is still stored (V8 `endTime - startTime`) but is not used for coverage or for `achievedSampleRateHz`.
- **M8 / R5, per-window event-loop block.** Three main-thread blocks happen once per window and are reported separately (`startStallMs`, `stopStallMs`, `foldMs`; in the profiler's debug counters, in `/health` reason text when backing off, and in T09/T20 output): `Profiler.stop` serialises the whole profile; `Profiler.start` was measured by the review at **28-161 ms**, the dominant stall; the likely cause (unverified here) is V8 logging existing code objects when a profile starts, which would make it grow with the application's code size; `foldProfile` is O(nodes + samples). `maxStallMs` (default 250) budgets the **sum** of the three. Under the sample-based definition this is consistent with the re-review measurement (first sample 91-116 ms after `startTime` with 20 000 functions; `startStallMs` 28-161 ms in the first review): 250 ms leaves headroom for stop and fold on a large app, and still trips backoff on a pathological one. D7 stays open until M02 measures on the code-heavy fixture. For in-flight messages this is a latency spike of that size once per `windowMs` (about 0.1-0.5% of wall time at 30 s windows), not a throughput cost; it is documented in the package README and on the dashboard's profiler page. Longer windows reduce the frequency; default `windowMs` 30 000 stays provisional until Mission 02 measures p50/max of each stall on a code-heavy fixture (open decision D7).
- **Code-heavy fixture (R5):** T09 and the profiler bench must load either a generated module with at least 10 000 distinct functions (`tests/support/profiling/generate-code-heavy.ts` writes it to a temp dir at test start and requires it) or a real Nest application of non-trivial size; a tiny script would under-measure `startStallMs`.
- **Truthful states:** `unavailable` (no inspector, probe failed), `disabled` (config), `starting`, `running`, `backoff`, `error`, `stopped`. No profile record is ever produced from `process.cpuUsage()` or synthesized.
- Frames: `fn relpath:line` (1-based line), paths relative to `process.cwd()`, `file://` stripped, native frames by name, `(program)` and `(garbage collector)` kept, `(root)`/`(idle)` dropped (`fold-profile.util.ts:45`), idle counted in `idleSampleCount`.
- Sampling is wall-clock on the main thread; when the event loop is idle V8 records `(idle)`. Under a cgroup CPU quota, sample timing can stretch. The achieved rate of the last window, `(sampleCount + idleSampleCount - 1) / (sampledSpanMs / 1000)` (sample timestamps, not `durationMs`), is reported as `InstanceHeartbeat.profiler.achievedSampleRateHz` (L4; schema, TS and `/health` description), next to the configured `sampleRateHz`.

---

## 8. Write scopes, worktrees and integration-only entrypoints

| Owner | Mission(s) | May write | Must not write |
|---|---|---|---|
| INS | 02, 03 | `packages/tracelet/src/{shared,context,instrumentation,buffer}/**`, `third_party/nestjs-observe/{LICENSE,PIN.md,FORK_DELTA.instrumentation.md}`, `tests/{unit,integration}/{context,instrumentation,buffer,poc}/**` (except `poc/t09-*`, `t10-*`, `t18-*`), `tests/support/instrumentation/**`, `bench/instrumentation/**`, `artifacts/02_POC_RESULTS.md` (M02), `artifacts/02_bench_overhead.json` (written by `bench/instrumentation/overhead.int-spec.ts`), `artifacts/03_*` | everything else |
| PRO | 02 (sampler POC), 06 | `packages/tracelet/src/profiling/**`, `third_party/nestjs-observe/FORK_DELTA.profiling.md`, `tests/{unit,integration}/profiling/**`, `tests/integration/poc/{t09,t10,t18}-*`, `tests/support/profiling/**`, `bench/profiling/**`, `artifacts/02_bench_profiler.json` (written by `bench/profiling/sampler-overhead.int-spec.ts`), `artifacts/06_*` | everything else |
| STO | 04 | `packages/tracelet/src/{storage,query,api}/**`, `tests/{unit,integration}/{storage,query,api}/**`, `tests/support/storage/**`, `artifacts/04_*` | everything else |
| DSH | 05 | `packages/tracelet/ui/**`, `packages/tracelet/assets/dashboard/**`, `artifacts/05_*` | everything else |
| LEAD | scaffold at 02 exit, 07 | root `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `packages/tracelet/{package.json,tsconfig*.json,vitest*.mts,eslint.config.mjs,README.md,THIRD_PARTY_NOTICES.md}`, `src/{contracts,config,http}/**`, `src/{index.ts,tracelet.module.ts,tracelet.ts,version.ts}`, `tests/{unit/http,unit/config,integration/http,e2e,contract}/**`, `examples/**`, `docs/tracelet-handoff/change-requests/**`, `artifacts/07_*` | other owners' paths |

- M02 is a single sequential session that creates the LEAD scaffold files listed in 3.2/3.3 plus INS and PRO POC files; at M02 exit the scaffold transfers to LEAD. No other mission edits scaffold files; dependency changes go through a CR to LEAD.
- Parallel phase (after M02 is accepted): at most two agents in flight, e.g. INS (M03) with STO (M04), then PRO (M06) with DSH (M05). Write sets above are disjoint by construction.
- Worktrees (per `resources/commands/WORKTREES_WINDOWS.md`): `D:\codeShit\Tracelet-wt\<mission>` on branches `tracelet/m02-poc`, `tracelet/m03-instrumentation`, `tracelet/m04-storage`, `tracelet/m05-dashboard`, `tracelet/m06-profiling`, `tracelet/m07-integration`. LEAD merges one branch at a time.
- Integration-only entrypoints (only LEAD wires them): `TraceletModule`, `Tracelet.setup/listen`, `src/index.ts`, construction of `BoundedTelemetryQueue`, `createStorage`, `ContinuousProfiler`, `MetricsCollector`, `createQueryApiHandler`, `createDispatcher`, and the call to `configureTracing`/`setTelemetryQueue`.
- `MISSION_STATUS.md` and the root `MISSION_REPORT.md` remain orchestrator-owned.

---

## 9. Non-blocking drop logic (every bound)

| Point | Bound (default) | On overflow | Counter |
|---|---|---|---|
| Root admission | `maxRootsPerSecond` 200 dev/test, **20 production** (token bucket, refill per ms; rootOnly records share it) | run unsampled | `tracesDroppedAdmission` |
| Open roots | `maxOpenTraces` 5000 | run unsampled | `tracesDroppedAdmission` |
| Spans per trace | `maxSpansPerTrace` 2000 (hard max 5000) | start returns `undefined`, call runs untraced | trace `droppedSpanCount`, `spansDropped` |
| Open spans, all traces (R6) | `maxOpenSpans` 50 000 (process-wide, incremented at span start, decremented at end/pluck/abandon) | start returns `undefined`, call runs untraced | trace `droppedSpanCount`, `spansDropped` |
| Root age | `maxTraceDurationMs` 300 000 | force-close `incomplete`, token closed | — (status) |
| Unfinished spans at pluck | 1000 ms wait (upstream) | left out with subtree | trace `unfinishedSpanCount` |
| Queue, trace pool | `maxQueuedTraces` 2000 items, `maxQueuedBytes` 16 MiB | `offer` returns false (drop-newest) | `tracesDroppedQueueFull` |
| Queue, profile pool | `maxQueuedProfiles` 10 | drop-newest | `profilesDropped` |
| Queue, control pool (R9) | **reserved** `maxQueuedControlItems` 64, `maxQueuedControlBytes` 4 MiB for rollup and metric items; a trace flood cannot consume it. Rollup items coalesce per bucket, so a bucket occupies at most one slot however long an outage lasts. A full-cardinality `RollupItem` (500 operation + 2 000 method documents) is about 0.75 MB; the cardinality caps bound one item at about 1.5 MB worst case | **evict-oldest** in this pool (unlike drop-newest elsewhere): to admit a new or replacing item, evict the oldest `MetricItem`s first, then the oldest `RollupItem`s, until both caps fit. The newest closing-bucket aggregates therefore always survive. **Counter folding (rev 5):** an evicted `MetricItem`'s `telemetry` counter deltas (all eight, `rollupsDropped` included) are added field by field into the **newest** `MetricItem` still queued. Its gauges and interval stay its own; its counters then cover the evicted intervals too, which the README documents. If no other `MetricItem` is queued (for example, the incoming item is a `RollupItem`), the deltas go into a queue-held carry-over that is added to the next `MetricItem` offered. The eviction itself increments `rollupsDropped`, which lands in the next collected interval. So a long outage can lose gauge samples but never the record of drops. If a single coalesced item is larger than `maxQueuedControlBytes` on its own (possible only if the operator lowered the cap below the worst-case item), it is rejected, counted, and logged once. Config validation requires `maxQueuedControlBytes >= 2 MiB`, so the default and any valid setting admit any item | `rollupsDropped` (rollup and metric evictions and rejections) |
| Writer batch (R7) | `batchSize` 200 items **and** `maxBatchBytes` 4 MiB estimated (well under the 16 MiB BSON document and 48 MB wire-message limits), one in-flight batch | the head item alone larger than `maxBatchBytes` is dropped | `tracesDroppedStorage` etc. |
| Writer pacing (R14) | `maxWriteDocsPerSecond` 2000 per instance (documents, spans included) | writer waits; backlog stays in the queue, overflow is dropped there | queue-full counters |
| Writer retries | `maxRetries` 3, backoff 500 ms-8 s full jitter, total batch age cap 30 s | `reportDropped(items,'storage')` | `tracesDroppedStorage` etc. |
| Rollup memory | current + 2 previous minutes; 500 operations, 2000 methods per minute | overflow bucket `(other)`; a bucket is offered on every 10 s flush while dirty and once at close (coalesced in the queue), then evicted from the accumulator. Its last full aggregate stays in the control pool until written or evicted by the pool rule | `rollupsDropped` |
| Profiles (R7) | top `maxStacksPerProfile` 2000 stacks, `maxFramesPerStack` 128, `maxProfileBytes` 1 MiB (lowest-sample stacks trimmed first) | dropped counts in the record | `droppedStackCount`, `droppedSampleCount` |
| Shutdown flush | `shutdownFlushTimeoutMs` 5000 | remaining items dropped | `shutdown` reason (logged once) |
| Query side | `maxTimeMS` 5000, 4 heavy queries, window caps, limit 100, spans 5000 | 503 / 429 / 400 | — |

`offer`, `trace()` and the decorator never await, never perform I/O and never throw. Mongo latency can only fill the queue; it cannot delay a handler or an ack. All counters are written through the `TelemetryCounterSink` (`count(name, n)`, R8) that the queue implements; the context runtime receives it via `setTelemetryQueue`, so admission and span-budget drops in `src/context` reach `MetricsCollector` without `src/profiling` importing `src/context`.

### 9.1 Shared-Mongo sizing (R14)

Per instance, steady state: `docs/s ≈ sampledRoots/s × (1 + avgStoredSpans) + profiles (1 per windowMs) + rollups (dirty buckets per flush) + 1 metric per intervalMs + 1 heartbeat per 30 s`. Bytes/day ≈ `sampledRoots/day × (600 + 280 × avgStoredSpans)` plus about `86400 / windowMs × profileBytes`. Writes are capped twice: admission (`maxRootsPerSecond`) and writer pacing (`maxWriteDocsPerSecond`).

| Example (production defaults) | Value |
|---|---|
| 10 replicas, 20 sampled roots/s each (the cap), 20 spans per trace | 200 roots/s × 21 docs ≈ 4 200 docs/s; 200 × 6 200 B ≈ 1.24 MB/s; ≈ 320 GB over 72 h retention (before indexes). This is the **worst case** and is too much for a shared operational cluster. |
| 10 replicas, 500 msgs/s each, `sampleRate` 0.05 → 25/s each, capped at 20/s | same as the worst case; lower `sampleRate` or `maxRootsPerSecond` for this load |
| 10 replicas, 50 msgs/s each, `sampleRate` 0.05 → 2.5 roots/s each | 25 roots/s × 21 ≈ 525 docs/s; ≈ 155 KB/s; ≈ 40 GB over 72 h |

Guidance for the host: provision a separate database (ideally a separate cluster or at least separate credentials and an oplog budget), start with `sampleRate` 0.01-0.05 and `retention.tracesHours` 24 in production, watch `/health` drop counters and the `metric_rollups` write rate, and lower `maxRootsPerSecond` before raising retention. These are estimates, not measurements; Mission 04 measures actual document sizes and write rates (T20/T22).

---

## 10. Recursion and self-instrumentation exclusions

1. Every Tracelet class registered with Nest DI carries `static [TRACELET_INTERNAL] = true`; the skip predicate checks it first.
2. Nest internals skipped (section 3.6 list), plus the registry/ALS objects (upstream `observe.module.ts:364-366`).
3. Writer, heartbeat, sweeper, profiler, metrics collector and deferred completion arm their timers inside `runOutsideTrace`, so none of their async work ever sees a trace store.
4. Dashboard/API requests are raw adapter routes (no controller instance to decorate) and the dispatcher runs inside `runOutsideTrace`. HTTP requests are not auto-rooted in v1 at all.
5. No `outgoing/*` patches are vendored, so Tracelet's own Mongo traffic cannot create spans even if a stale store leaked.
6. Diagnostics run outside traces and are rate limited; the registry never calls a host logger provider (upstream used Nest `Logger`, which a host can back with an instrumented provider).
7. Tests: T14 (1000 dashboard requests produce zero traces), T23 (storage/query failures produce diagnostics, zero traces, no recursion).

---

## 11. Scrubbers and data minimisation

- Never captured: payloads, message bodies/headers, request/response bodies, URLs, Mongo queries, arguments or return values of traced methods, environment, source code.
- Captured text: operation names (developer-chosen), class/method names, attribute values passed explicitly to `trace()`, error name, redacted error message, redacted frame lines.
- Redactor: upstream `LogRedactor` defaults (key=value secrets, bearer/basic tokens, JWTs, AWS keys, PEM private keys, Luhn-valid card numbers) plus URI userinfo and e-mail rules; user `redaction.patterns/keys`. `errorMessages` defaults to **`'omit'` outside dev/test** (R12): production stores the error name, fingerprint and redacted frame lines but no message text; `'redacted'` is the dev/test default and an explicit production opt-in. Attributes with sensitive key names are replaced by `[REDACTED]`.
- Paths: frames made relative to `process.cwd()`; no absolute paths stored (Stage 00 review L9). No source code frames (upstream `sourceContext` default `true` is not vendored).
- **Operation names: cardinality and PII (optional).** `trace(name, ...)` names and `kind` become index keys, rollup keys and UI rows. They must be **static, low-cardinality labels** such as `rabbitmq.consume` or `orders.reindex`, never built from message content, ids, user names, e-mail addresses or queue payload fields. Put variable but non-sensitive context in `attributes` (bounded at 16 keys and 256 characters, redacted, and not indexed). Tracelet does not redact `name`. Rollups cap operations at 500 per instance-minute (overflow to `(other)`), and diagnostics log once when the cap is hit, so high-cardinality names surface as a warning rather than unbounded growth. The README repeats this rule next to the `trace()` signature.
- `storage.uri` is never logged, never returned by `/health`, and never included in error messages (T16 asserts with a URI containing a password).

---

## 12. Authentication adapter and HTTP mounting (Express and Fastify)

- **Environment rule (R10):** only `NODE_ENV=development` or `NODE_ENV=test` counts as non-production (`shared/env.ts`). Unset, empty, `staging`, `prod` and anything else are production: Tracelet disabled unless enabled explicitly, loopback-without-auth off, `sampleRate` 0.05, `maxRootsPerSecond` 20, `errorMessages: 'omit'`.
- `Tracelet.setup(app, { path = '/observe', authorize?, allowLoopbackWithoutAuth = isDevOrTest(), publicBasePath? })` must be called before `app.init()`/`listen()`; it throws if the app is already initialised. Type detection uses `app.getHttpAdapter().getType()` (`'express' | 'fastify'`, abstract method in `@nestjs/core` 11.1.4 `adapters/http-adapter.d.ts:78`); anything else throws "unsupported adapter; use Tracelet.listen()".
- **Decision order per request (before any storage access):** (1) method not GET/HEAD gives 405; (2) if `authorize` is set: `await authorize(req)` with a 2 s timeout; `true` allows; `false`, throw, reject or timeout gives 403; (3) else if `allowLoopbackWithoutAuth` and the socket peer is `127.0.0.1`, `::1` or `::ffff:127.0.0.1` it is allowed; (4) else 403. `X-Forwarded-For` is never consulted, so behind the OpenShift router the default is deny.
- **Sidecar caveat (R10):** in a pod with a proxy sidecar (Istio/Envoy, oauth-proxy, a service-mesh injector), external requests reach the app from `127.0.0.1`, so the loopback rule would admit them. `allowLoopbackWithoutAuth` must stay off in such pods (it is off by default in production) and `authorize()` is mandatory there. The README states this next to the option.
- The same gate covers `index.html`, hashed assets, the SPA fallback and `/api/v1/*` (T15).
- **Peer address source (L9):** Express `req.socket.remoteAddress`; Fastify `request.raw.socket.remoteAddress`. Never `req.ip`/`request.ip`/`req.ips`, which follow `X-Forwarded-For` once the host enables Express `trust proxy` or Fastify `trustProxy`. T15 runs with Express `app.set('trust proxy', true)` and Fastify `new FastifyAdapter({ trustProxy: true })`, sending `X-Forwarded-For: 127.0.0.1` from a non-loopback peer, and expects 403.
- Express (Nest 11 uses Express 5): `expressApp.use(path, handler)` prefix mount, handled before Nest's router because it is registered before init; Fastify: `instance.route()` for `path` and `path + '/*'` with **all methods** (`['DELETE','GET','HEAD','PATCH','POST','PUT','OPTIONS']`) and a route-level `onRequest` hook that answers 405 `METHOD_NOT_ALLOWED` for anything but GET/HEAD **before** Fastify's content-type parsing (L10). Without this, a non-GET request falls through to Nest's 404 on Fastify while Express returns Tracelet's 405. Both adapters then return the same 405 envelope, and T15 asserts it. Caveat: if the host enables Nest CORS, a preflight `OPTIONS` may be answered by the CORS layer first on either adapter. The dispatcher returns `TraceletHttpResponse`; each mount writes status, headers and body natively. Both adapters get identical integration tests (supertest against a real `NestFactory.create` app with `@nestjs/platform-express` and with `@nestjs/platform-fastify`).
- Global prefix is not applied (like Swagger's default); `publicBasePath` handles proxies that rewrite paths.
- Headers: HTML `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`, `Cache-Control: no-store`; hashed assets `Cache-Control: private, max-age=86400, immutable`; all responses `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`. The runtime config is injected as `<script id="tracelet-config" type="application/json">` (a data block, not executed, compatible with the CSP). The JSON is escaped after `JSON.stringify` (L8): `<` becomes `<`, `>` becomes `>`, `&` becomes `&`, and U+2028/U+2029 become ` `/` `, so a configured `publicBasePath` containing `</script>` or `<!--` cannot break out of the element. Unit test in `tests/unit/http/static-assets.spec.ts`.
- Worker-only: `Tracelet.listen({ host: '127.0.0.1', port, authorize? })` uses `node:http`; binding a non-loopback host without `authorize` throws.

---

## 13. Startup and shutdown

| Phase | What happens | Failure handling |
|---|---|---|
| import | global slot `Symbol.for('tracelet.runtime')` created or reused (`traceletAls`, `BOOT_ID`, runtime with defaults; tracing enabled only after `configureTracing`; before that `trace()` is a pass-through), queue not yet attached | none can fail |
| `NestFactory.*(AppModule, { instrument: createTraceletInstrument({ enabled?, skipInstrumentation? }) })` | each instance: enable decision evaluated (R11); proxied when on, returned untouched when off | decorator never throws (outer guard) |
| `TraceletModule.forRoot` provider factory | `resolveOptions` (env, defaults, validation) | **invalid config throws** (the only bootstrap failure Tracelet may cause) |
| `onModuleInit` (TraceletLifecycle) | build queue, rollups, identity; `configureTracing`; `setTelemetryQueue` | errors leave tracing disabled + diagnostics |
| `onApplicationBootstrap` | in `runOutsideTrace`: start storage (connect async, not awaited), `ensureIndexes` async, writer loop, heartbeat, sweeper, profiler (`start()` not awaited by bootstrap), metrics collector | all async failures go to health/diagnostics; bootstrap is never blocked by Mongo or the inspector |
| `Tracelet.setup(app)` (before listen) | mount routes | throws on misuse (after init / unsupported adapter): developer error at startup |
| running | | |
| `onModuleDestroy` | nothing (business still running) | |
| `beforeApplicationShutdown` | stop profiler (final window offered), stop metrics, stop sweeper | bounded by 2 s |
| (Nest disposes the HTTP server) | | |
| `onApplicationShutdown` | `closeAllOpenRoots('shutdown')` (status `incomplete`), flush rollups, writer flush with `shutdownFlushTimeoutMs`, close Mongo client | bounded; remaining items counted as dropped |

Nest 11.1.4 calls these in order destroy, beforeShutdown, dispose, shutdown, each over modules in reverse distance order (`nest-application-context.js:126-131,249-275`), and awaits each hook, so Tracelet's flush adds at most `shutdownFlushTimeoutMs` to shutdown.

---

## 14. Multi-instance behaviour

- Identity: `instanceId = ${sanitizedHostName}-${last 12 hex of BOOT_ID}`; `sanitizedHostName` replaces characters outside `[A-Za-z0-9._-]` with `-` and is truncated to 115 characters (L11), so `instanceId` is at most 128 characters even for a 253-character host name; `hostName` is stored untruncated in the heartbeat. A restarted pod gets a new `instanceId`, the same `hostName`. Heartbeat every 30 s; `isLive` = `lastSeenAt` within 90 s.
- Every pod writes only its own documents (natural `_id`s; rollups and heartbeats keyed by `instanceId`), so there are no cross-pod write conflicts and no coordination. Index creation is idempotent and safe when run by several pods at once.
- Every pod serves the same UI and queries the same database; no sticky routing; the UI shows flush lag (`flushLagHintMs` = flush interval + writer backlog estimate).
- Clock skew: `startedAt` is each pod's wall clock; durations use the monotonic clock. Cross-pod ordering in lists is approximate; no cross-service trace correlation in v1.
- Mixed versions: section 10 of the freeze doc.

---

## 15. Query index caps and guards

Index set and count caps: freeze doc section 4 (traces 6, spans 2, profiles 3, each rollup 3 or fewer, instances 2). Every list query must be served by one of these indexes; Mission 04 records `explain('executionStats')` for `/traces` (with and without `service`, `status`, `search`), `/profiles`, `/errors` and `/overview` and attaches `totalDocsExamined/nReturned`. Guards: window caps, limit 100, `maxTimeMS` 5000, 4 heavy-query slots, projection on every read, no `$regex` except the anchored escaped prefix, no `$where/$function/$accumulator/$expr` from user input, unknown parameters rejected.

---

## 16. Mission 02 POC definition (the gate before any parallel work)

**Precondition:** this plan approved, contracts frozen, **G0 passed** (section 2).

**Scope:** final-location minimal versions of the INS files (`src/shared/*`, `src/context/*`, `src/instrumentation/*`, `src/buffer/{self-time,record-mapper,error-sanitizer,telemetry-queue}.ts`) and the PRO sampler files (`src/profiling/vendor/{cpu-sampler,fold-profile}.ts`, `inspector-probe.ts`, `profile-mapper.ts`), the LEAD scaffold (3.2, 3.3), `third_party/nestjs-observe/*`, and the tests below. No Mongo, no HTTP, no UI. The sink is `BoundedTelemetryQueue` drained by the test (`tests/support/instrumentation/memory-queue.ts`).

**Fixture app:** `tests/support/instrumentation/orders-app.ts`: `OrdersConsumer.process -> Validator.validate -> Transformer.execute`, `OrdersService.handle -> Promise.all([Repo.find, Repo.find])`, a provider that throws on a flagged message, created with `NestFactory.createApplicationContext(AppModule, { instrument: createTraceletInstrument({ enabled: true }) })` (explicit, so the result does not depend on the runner's `NODE_ENV`). `tests/support/instrumentation/fake-amqp-channel.ts`: an `EventEmitter`-based channel whose `consume(queue, cb)` delivers messages from a timer, records `ack(msg)`/`nack(msg, false, false)` calls in order, no Nest transport decorators, no HTTP.

| Test file (`packages/tracelet/tests/integration/poc/`) | Proves | Key assertions |
|---|---|---|
| `t01-direct-root.int-spec.ts` | T01 | Root recorded for a callback with no provider calls (bare root, the upstream gap `registry:294-309`) and for one with providers; operation, kind, attributes, root span present, `spanCount` matches |
| `t02-concurrency.int-spec.ts` | T02 | n = 25 and n = 100 concurrent deliveries: distinct `traceId`s; every span's ancestor chain ends at its own trace's root; no span of message A under message B; no store leaks into the next message (`currentTraceId()` after settle is the outer value) |
| `t03-nesting.int-spec.ts` | T03 | Sync and async nesting gives the exact expected tree; offsets ordered |
| `t04-promise-all-self-time.int-spec.ts` | T04 | Overlapping siblings both under `handle`; `selfDurationMs >= 0`; with a 30 ms parent, two overlapping 20 ms children and 5 ms of sync work, self is in [3, 12] ms (union, not double subtraction) |
| `t05-errors-ack-parity.int-spec.ts` | T05, L4 | Same scenario with Tracelet disabled vs enabled: identical ordered ack/nack log and identical per-message outcomes; `rejected === thrown` and sync `caught === thrown` (reference identity); origin span has `sanitizedError`, ancestors `status:'error'` without payload, `errorCount === 1`, trace `status:'error'` |
| `h6-stale-context.int-spec.ts` | H6, R2, R3 | (a) a message source created inside `trace('setup')` (captures the store via `AsyncResource` and, separately, a real `net` socket pair) delivers after `setup` closed: each message gets a fresh root with its full span tree; `setup` gains no spans; (b) nested `trace()` (kind `custom`) inside an open trace becomes a `manual` child span; (c) `forceRoot: true` inside an open trace starts a separate root; (d) the same with an unsampled outer root (`sampleRate: 0` then 1); **(e)** an outer sampled root force-closed by the sweeper (`maxTraceDurationMs: 50`) while its callback source lives on, and an unsampled outer root past its `deadline`: later nested `trace()` calls start fresh roots (token closed / registry no longer `has` the key / deadline passed); **(f)** inside `trace('setup', ...)` a fake channel delivers messages **synchronously before `setup` settles**: with `kind: 'rabbitmq'` each delivery is its own root (default forceRoot), with `kind: 'rabbitmq', join: true` it becomes a child span of `setup`; **(g) L-a:** a provider called from a stale store **within** the pluck window (an un-awaited child keeps the snapshot alive up to 1000 ms) and from a force-closed root whose snapshot is still held produces no span in the closed trace. **Behaviour change vs upstream:** legitimate un-awaited work (fire-and-forget) that calls providers **after its root settles** is now untraced. Upstream attached such late spans for up to 1000 ms (`registry:770-798`). Spans that **started** before the root settled still end normally within the 1000 ms pluck wait. The test asserts both halves, and the README documents it next to `trace()` |
| `r1-joined-span-settle.int-spec.ts` | R1 | Inside an open sampled trace, a joined `trace()` whose `fn`: returns a sync value (`===` the returned value, and no promise is introduced), throws synchronously (`caught === thrown`), returns a plain promise that rejects (`rejected === thrown`), returns a `Promise` subclass (the **same object** is returned); with `startManualSpan` throwing and, separately, `endManualSpan` throwing, `fn` is called **exactly once** (call counter) and results are identical |
| `m7-fail-open.int-spec.ts` | M7 | Using `createRuntimeForTesting` with a registry whose `startRoot`, `endRoot`, `internalStartTraceStep`, `internalEndTraceStep`, `startManualSpan`, `endManualSpan` and `pluckSnapshot` each throw (parameterised, one at a time), and a counter sink whose `count` throws: business return values, thrown/rejected references and ack logs are identical to the disabled run; the active flag is not left stuck (a second call is traced normally once the registry recovers); a throwing `skipInstrumentation` and a provider whose prototype getter throws still let `createApplicationContext` boot |
| `r11-instrument-enable.int-spec.ts` | R10, R11 | `createTraceletInstrument()` with `NODE_ENV` unset, `TRACELET_DISABLED=1`, `enabled: false`: every instance is returned untouched (`=== original`); `NODE_ENV=test` or `enabled: true`: proxied; `skipInstrumentation` from the instrument options is honoured |
| `egress-none.int-spec.ts` | brief exit 8 seed | During the full T01-T05 scenario, spies on `net.Socket.prototype.connect`, `tls.connect`, `http.request`, `https.request`, `globalThis.fetch`, `dns.lookup` record zero calls |
| `edge-providers.int-spec.ts` | T06-T08 (recorded, not gating) | `forwardRef` pair, request-scoped and transient providers, `#private` class, symbol-keyed and getter properties, Observable and async-iterable returns: record actual behaviour for `artifacts/02_POC_RESULTS.md` |
| `t09-profiler-cpu-contiguity.int-spec.ts` (PRO) | T09, H1, M8, R5 | Loads the **code-heavy fixture** (>= 10 000 generated functions, `tests/support/profiling/generate-code-heavy.ts`) and calls into it; 30 s CPU-bound loop plus a concurrent allocation-heavy loop, `windowMs: 5000`, 99 Hz: at least 5 of 6 windows contiguous, meaning `gapBeforeMs` (sample-based, R5 revision 4) `<= 250` ms; aggregate coverage `sum(sampledSpanMs) / (lastSample(last) - firstSample(first)) >= 0.95`, from each window's first-to-last sample span; every window has `sampleCount > 0` and a frame matching `burnCpu`; state never `disabled`/`error` (and `backoff` only with the stall reason recorded); records `startStallMs`, `stopStallMs`, `foldMs` per window (p50/max of each reported). The H1 defect would show as about 50% coverage, far outside the bound. Note: under the old `startTime`/`endTime` definition the measured gap is about 10 ms even when the first sample is about 100 ms late, so a 250 ms bound could not detect a scheduling regression of up to about 240 ms; with sample-based gaps the bound measures the real unsampled interval (about 100 ms on the code-heavy fixture, which leaves 2.5x headroom; D7 stays open). |
| `t10-profiler-idle-contiguity.int-spec.ts` (PRO) | T10 | 30 s idle: windows still produced and contiguous by the same sample-based rule (idle samples carry timestamps, so the gap is measurable while idle); `idleSampleCount > 0`; `sampleCount` small; state `running` |
| `t18-profiler-unavailable.int-spec.ts` (PRO) | T18 | Injected session factory that throws on `connect` (and a probe returning `v8_enable_inspector: false`): state `unavailable` with reason, zero profile items, no throw |
| `bench/instrumentation/overhead.int-spec.ts` | T20 seed | Off / on-untraced / on-traced: p50 and p95 per provider call and per message over 20 000 iterations after 2 000 warm-up; writes `artifacts/02_bench_overhead.json` (in the M02 worktree); no pass/fail threshold, compared to Stage 00's indicative 0.17 / 0.80 / 19.8 µs |
| `bench/profiling/sampler-overhead.int-spec.ts` | T20 seed, R5 | On the code-heavy fixture (or the orders Nest app plus the generated module): fixed CPU work units with the sampler off vs on; throughput delta, ELU, event-loop delay p99 and max (to expose the per-window block), and the three stall series; written to `artifacts/02_bench_profiler.json` |

**Commands (PowerShell, from the M02 worktree root):**

```powershell
npm ci
npm run -w packages/tracelet typecheck          # tsc -p tsconfig.json --noEmit
npm run -w packages/tracelet lint               # eslint src tests bench
cd packages/tracelet
npx vitest run --config vitest.config.mts                                        # unit + ported upstream specs
npx vitest run --config vitest.int.config.mts tests/integration/poc --reporter=verbose
npx vitest run --config vitest.int.config.mts tests/contract
# flakiness: 10 repetitions of the concurrency, H6, R1 and M7 files
for ($i = 1; $i -le 10; $i++) { npx vitest run --config vitest.int.config.mts tests/integration/poc/t02-concurrency.int-spec.ts tests/integration/poc/h6-stale-context.int-spec.ts tests/integration/poc/r1-joined-span-settle.int-spec.ts tests/integration/poc/m7-fail-open.int-spec.ts; if (-not $?) { "FAILED on run $i"; break } }
npx vitest run --config vitest.int.config.mts bench
# Node floor and Node 24 (AsyncContextFrame). npm workspaces hoist vitest to the repo root, so from packages/tracelet
# the entry point is ../../node_modules/vitest/vitest.mjs (check with: Test-Path ../../node_modules/vitest/vitest.mjs)
npx -y -p node@20.19.5 -- node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts tests/integration/poc
npx -y -p node@24 -- node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts tests/integration/poc
node -p "process.config.variables.v8_enable_inspector"
```

Fallback if `npx -p node@x` cannot install the binary (offline, proxy, or the `node` npm package rejected on this platform): download the official zip (`https://nodejs.org/dist/v20.19.5/node-v20.19.5-win-x64.zip`, and the matching 24.x zip) into a fresh directory outside the repo, verify it against that release's `SHASUMS256.txt`, then run `& <dir>\node.exe ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts tests/integration/poc` from `packages/tracelet`. If neither route works, record "Node 20.19 / 24: NOT RUN" with the exact error in `artifacts/02_POC_RESULTS.md`; do not mark the multi-version gate as passed.

**Exit criteria (all with saved logs in `artifacts/02_POC_RESULTS.md`):** T01-T05, H6 (a-g), R1, M7, R11, egress, T09, T10, T18 pass on Node 22 and on 20.19.x (24.x run or recorded NOT RUN with reason); 10/10 repetitions green; benches recorded; edge-provider behaviour recorded; fork delta and LICENSE committed with the first vendored file; no unbounded buffer (queue caps asserted in a unit test). If T09 contiguity or M7 cannot pass after one scoped diagnosis, escalate to `tracelet-investigator` with the failing log; do not weaken assertions.

---

## 17. Test matrix map (T01-T24)

| ID | Mission / owner | Where | Command or fixture plan |
|---|---|---|---|
| T01-T05 | 02 seed, 03 hardening / INS | `tests/integration/poc`, then `tests/integration/instrumentation` | section 16 |
| T06-T08 | 02 record, 03 decide / INS | `tests/integration/instrumentation/edge-providers.int-spec.ts` | supported or documented unsupported (Observables/async iterables: unsupported) |
| T09, T10, T18 | 02 seed, 06 / PRO | `tests/integration/profiling` | section 16; M06 adds restart, malformed profile JSON, max stacks, `maxProfileBytes` trimming (R7), no network |
| T11 | 04 / STO (queue part: INS unit test) | `tests/integration/storage/mongo-outage.int-spec.ts`, `tests/unit/buffer/telemetry-queue.spec.ts` | stop/restart `mongodb-memory-server` (or a docker Mongo) during writes; queue bounded, drops counted, producer never blocked; **R9:** while a trace flood keeps the trace pool full, rollup and metric items are still accepted (zero control-pool `queueFull` drops) and after reconnect the rollup documents of buckets still in memory are present; writer batches never exceed `maxBatchBytes` (R7). **R9 long-outage case** (`tests/unit/buffer/control-pool.spec.ts` with an injected clock and flush seam, plus the Mongo integration run): Mongo is down for longer than **64 rollup flush intervals** and more than 3 bucket minutes, with metrics items arriving throughout. Assertions: the control pool never exceeds 64 items or 4 MiB; each bucket has at most one queued `RollupItem`; after reconnect the stored documents of every bucket that closed in the last minutes of the outage (at least the final closing bucket) equal the accumulator's final aggregates; evictions are oldest-metrics-first and counted in `rollupsDropped`. **Counter preservation (rev 5):** after reconnect, the sum of each `telemetry` counter over all stored `metric_rollups` documents of the instance equals the queue's cumulative counter increase over the test, minus at most the not-yet-collected last interval. In particular, every `rollupsDropped` increment caused by evictions during the outage is present in storage. |
| T12 | 07 / LEAD | `tests/e2e/two-instances.e2e-spec.ts` | two OS processes, one Mongo; both instance ids in `/instances` and `/traces` from either process |
| T13 | 04 / STO | `tests/integration/storage/ttl-indexes.int-spec.ts` | indexes exist exactly as frozen; `expireAt` set; TTL removal observed or reported eventual |
| T14 | 07 / LEAD | `tests/integration/http/no-self-trace.int-spec.ts` | 1000 dashboard/API requests: zero traces written |
| T15 | 07 / LEAD | `tests/integration/http/auth-{express,fastify}.int-spec.ts` | unauthorized `index.html`, asset, SPA route and API all 403; loopback rule; XFF ignored **with Express `trust proxy` and Fastify `trustProxy: true` enabled** (L9); non-GET gives the same 405 envelope on both adapters (L10); **R10:** with `NODE_ENV` unset and no `authorize`, a loopback request gets 403 (production default) |
| T16 | 03 INS + 04 STO | `tests/integration/instrumentation/redaction.int-spec.ts`, `tests/integration/storage/no-secrets.int-spec.ts` | errors containing a Mongo URI with password, bearer token, e-mail; stored docs scanned |
| T17 | 03 INS + 07 LEAD | `tests/integration/instrumentation/shutdown.int-spec.ts`, e2e restart | open roots closed `incomplete` on graceful shutdown; hard kill documented |
| T19 | 07 / LEAD | `tests/e2e/pack-install.e2e-spec.ts` | `npm pack`, install tarball into a temp CJS app and a temp ESM app, boot both |
| T20 | 02 seed, 03/06/09 | `bench/**` | off/on p50/p95, CPU and RSS deltas, per environment |
| T21 | 04 STO + 05 DSH | API tests + Playwright | real API data only; no fixture fallback in the production bundle |
| T22 | 03 INS + 04 STO + 05 DSH | 5000-span trace end to end; `tests/integration/instrumentation/span-budgets.int-spec.ts` | `droppedSpanCount` visible, UI virtualized; **R6:** with `maxOpenSpans` set low (for example 500) and 20 concurrent traces holding open spans, starts beyond the budget are refused, `spansDropped` and each affected trace's `droppedSpanCount` increase, the budget is released when spans end, business results unchanged |
| T23 | 04 STO + 07 LEAD | storage/query failure injection | diagnostics visible in `/health`, zero traces, no recursion |
| T24 | 04 STO | `tests/integration/storage/schema-versions.int-spec.ts` | v1 reader with a synthetic `schemaVersion: 2` document: skipped and counted |

---

## 18. Plan audit: fake-feasibility risks

| Claim that could be fake | Reality / guard |
|---|---|
| "Continuous profiling" | Contiguous windows with a measured unsampled gap (sample timestamps; V8 `startTime`/`endTime` would hide the about 100 ms start stall), not zero-gap sampling; asserted (N-1 contiguous, gap <= 250 ms, coverage >= 95% at 5 s windows) only after M02 runs it. Stage 00's `dutyMs == windowMs` claim was wrong (H1). Each window boundary blocks the event loop for start + stop + fold (start measured 28-161 ms by the review). Achieved sample rate is reported, not assumed. |
| Profiler overhead is small | Unknown until T20. The upstream budget measured whole-process CPU and misfired 3/3 under GC load. v1 measures stop/fold stall per window and runs an A/B bench; no fixed overhead number is promised. |
| Per-trace CPU attribution | Not provided. UI labels flame graphs "CPU samples (instance, time range)". |
| "Works on Node 20.19-24" | Only Node 22.22.0 has been run so far; M02 must run 20.19 and 24 (AsyncContextFrame) or record NOT RUN. |
| "Works with the host" | G0 UNVERIFIED. Nest < 11.1.4 has no instrument hook; no fallback is planned. Nest 12 untested. |
| "Every provider method is traced" | Only DI-created instances, and only when a trace context exists. Not traced: `new`-ed objects, static methods, free functions, nested `this.x()` in `#private` classes, calls whose context was captured before the trace (pooled callbacks, library-internal queues), Observable/async-iterable lifetimes, `worker_threads`. |
| Deep nested promise boundaries | Native promises and `await` propagate ALS on Node 20-24. Breaks: user-land thenables resolved from another context, callback pools created outside the trace, `EventEmitter` listeners fire in the emitter's emit-time context (fine) but a long-lived emitter created inside a trace carries a stale store (handled for `trace()` by JOIN-IF-OPEN; provider calls outside `trace()` from such a callback run untraced because the decorator checks `token.open` (L-a), including during the up-to-1000 ms pluck window and while a force-closed snapshot is still held; once the snapshot is plucked the registry also no longer has the key). |
| Exact durations / self time | Monotonic clock, but proxy overhead (about 20 µs per traced call indicative) inflates short spans; self time omitted when not computable; collapsed spans carry sums. |
| Counts are totals | Operation counts are all settled roots (exact for the instance; lost if the rollup write fails or the rollup item is evicted from the control pool, and such losses are counted in `rollupsDropped`); trace lists and method stats are samples and labelled so. |
| Error capture always works | Failed sampled-out roots are kept as `rootOnly` only within the admission bucket; errors inside unsampled traces have no span detail. |
| Mongo outage is harmless | True for business code by construction (no awaits); telemetry is lost beyond the queue caps and counted. |
| TTL deletes data | Eventually (TTL monitor); not a compliance deadline. |
| Fastify and Express both work | Designed for both; only proven by M07's dual-adapter tests. |
| Startup is never blocked | Except invalid configuration (deliberate). |

---

## 19. Change-request protocol

1. Any change to a frozen file (kit `resources/contracts/**`, `src/contracts/**`) or to this plan's ownership, file list, caps or semantics needs a CR. Implementers must not "fix" a contract in place.
2. File: `docs/tracelet-handoff/change-requests/CR-NNN-<slug>.md` using the structure of kit `prompts/11_CHANGE_REQUEST.md` (contract name/version and exact fields/routes; evidence the current contract fails; minimal old-to-new diff; why an adapter is not enough; impacted owners and files; migration/defaults/back-compat; new tests and fixtures; whether parallel agents must stop).
3. Classification: **additive** (optional field, new route, looser bound): OpenAPI minor bump, no `schemaVersion` change. **Breaking**: `schemaVersion` bump plus the migration rules of freeze doc section 10. **Plan-only** (ownership, file move, default value): no version change.
4. Approval: orchestrator plus an independent `tracelet-reviewer` for anything touching contracts, auth, privacy or async semantics. The requester never approves its own CR.
5. Application: one dedicated commit that updates the kit contract files, `src/contracts/` copies, v1 fixtures, `01_CONTRACT_FREEZE.md` (changelog line + new hashes) and re-runs V1-V4; dependent code changes come in later commits.
6. If the CR is marked blocking, agents whose files are impacted stop at a consistent commit until it is approved or rejected.
7. Deviation from this plan without a CR is a review finding of severity High.

---

## 20. Open decisions (need the orchestrator / user)

| ID | Decision | Proposal |
|---|---|---|
| D1 | G0 host data | Blocks Stage 02. Provide host path or the command outputs in section 2. **DEFERRED 2026-10-29 (user: no host yet): M02 proves the POC on the stated baseline in a fixture app; G0 stays an unverified gate before integration (M07).** |
| D2 | HTTP auto-roots in v1 | Out of v1 (compromise 1). **RESOLVED 2026-10-29 (user): no auto HTTP roots in v1.** |
| D3 | `mongodb` driver major | 6.21.x unless G0 shows a Mongo server that 7.x supports and the host prefers 7. **RESOLVED 2026-10-29 (user): 6.21.x.** |
| D4 | Default `profiling.enabled` | `false` (opt-in) everywhere until T20 numbers exist. **RESOLVED 2026-10-29 (user): off until measured.** |
| D5 | Host already passes `instrument` (for example `@nestjs/observe`) | Then a composition helper is needed (CR); otherwise not built. **RESOLVED 2026-10-29 (user): defer to a CR; v1 supports one instrument and documents it.** |
| D6 | Dashboard build output committed vs built at pack time | Committed (no UI toolchain needed to build the Nest package). **RESOLVED 2026-10-29 (user): commit built assets.** |
| D7 | Default `windowMs` | 30 000 provisional; set from M02 stall measurements. **RESOLVED 2026-10-29 (user): 30 000 ms, tune after M02.** |
| D8 | Package license for Tracelet itself (internal) | Lead decides; third-party MIT notice is mandatory either way. **RESOLVED 2026-10-29: MIT (user delegated the choice; picked for compatibility with the vendored MIT code and safe for a public repo; not legal advice). LICENSE file with the copyright holder name is created at first package scaffold; the holder name is still to be supplied by the user.** |
| D9 | Initial commit anchoring the frozen contracts (R13) | **Not done**: committing needs the user's go-ahead (orchestrator is raising it). Until a commit exists, the freeze-doc hashes are unanchored, and M02 cannot branch its worktree from a known base. **RESOLVED 2026-10-29 (user approved): commit on a new branch `tracelet/stage-01-contracts` (not main); SHA recorded in the freeze doc section 13.** Original proposal: one commit of the kit, `artifacts/00_*`, `artifacts/01_*` and contracts on `main`, then M02 in `D:\codeShit\Tracelet-wt\m02` on `tracelet/m02-poc`. |

---

## 21. Routing checkpoint

- Work unit: complex contract/architecture design (Opus High, as configured). No parent model/effort change is claimed. Quota signal: UNKNOWN.
- Next: independent **re-review** of revision 2 by `tracelet-reviewer` (Opus High). After approval, G0 and D9: Mission 02 at Opus High per `MISSION_ROUTING.json` (ALS/root semantics, sampler contiguity), or start M02's scaffold and queue/mapper pieces with `tracelet-implementer` (Sonnet Medium) and keep H6/M7/T09 diagnosis for `tracelet-investigator` if a test fails twice.
- `MISSION_STATUS.md` and `MISSION_REPORT.md` were not written (orchestrator-owned).

---

## 22. Revision 2: resolution of the Stage 01 review (APPROVE-WITH-CHANGES)

The review text was relayed by the orchestrator as a summary. R1-R14 were specific enough to apply exactly. The low-severity items L1-L11 and the optionals arrived as short labels only (for example "L1 path fix", "L3 file name"), and the full review is not on disk, so only the ones whose content could be identified are applied below. The rest are listed as **not applied: content not available**.

| Item | Resolution | Where |
|---|---|---|
| R1 (High) | `createManualSpan` (async at the pin, `registry:946`) is removed. The registry gets synchronous `startManualSpan`/`endManualSpan`. The runner calls `fn` itself through the shared `runAndSettle` (`context/settle.ts`), with every telemetry step in `ignoreFailure`. New test `r1-joined-span-settle` covers sync value and throw identity, plain-promise rejection identity, a Promise subclass returned as-is, and `fn` called exactly once when start or end throws. M7 is extended to the new methods. | 3.5, 4 row 2, 6.2, 16 |
| R2 (High) | The registry stores each sampled root's `RootToken`; `forceClose` and `closeAllOpenRoots` flip `open = false`. A sampled join also requires `registry.has(key)`. An unsampled token carries a `deadline` checked at join time. Test H6(e) added. | 3.5, 4 row 2, 6.2, 16; contracts `TraceFn` doc |
| R3 | Effective `forceRoot` = `opts.forceRoot ?? (kind === 'rabbitmq' && join !== true)`; `TraceOptions.join` added; examples use `kind: 'rabbitmq'`. Test H6(f) delivers synchronously before `setup` settles. | 6.2, 16; contracts `TraceOptions` |
| R4 | `/traces` search: uuidv7 shape gives `_id` equality only, anything else an anchored escaped prefix on `operation`. `/methods` search: case-insensitive literal substring, applied in process to the aggregated rows and never sent to Mongo. | OpenAPI `/traces`, `/methods`; freeze doc 6 |
| R5 | `gapBeforeMs` comes from V8 profile timestamps. `startStallMs`, `stopStallMs` and `foldMs` are reported separately. `maxStallMs` covers their sum (default raised from 100 to 250, because start alone was measured at 28-161 ms). T09 and the profiler bench use a code-heavy fixture (at least 10 000 functions). The per-window event-loop block is documented. The T09 contiguity bound changes from 50 ms to 250 ms, plus coverage of at least 95%. | 7, 9, 16, 18; contracts `profiling.maxStallMs` |
| R6 | Global `maxOpenSpans` (default 50 000) counts into `spansDropped` and the trace's `droppedSpanCount`; tested under T22. | 4 row 2, 9, 17; contracts |
| R7 | `profiling.maxProfileBytes` (1 MiB; trims the lowest-sample stacks into the dropped counts) and `buffer.maxBatchBytes` (4 MiB); `TelemetryQueue.drain(maxItems, maxBytes)`. | 3.8, 3.9, 9; both contract files |
| R8 | `TelemetryCounterSink.count(name, n)` and `TelemetryCounterName` in the internal contracts; `TelemetryQueue extends TelemetryCounterSink`; context counts through it. | 3.5, 9; internal contracts |
| R9 | A reserved `control` pool for rollup and metric items (`maxQueuedControlItems` 64, `maxQueuedControlBytes` 4 MiB); a closed rollup bucket is offered twice (idempotent replace). Asserted in T11. Chosen over dirty-until-ack because ack would need a storage-to-buffer callback contract. | 3.7, 9, 17; contracts |
| R10 | Only `NODE_ENV` `development`/`test` counts as non-production (`shared/env.ts`); unset means production (loopback-without-auth off, conservative sampling). A T15 case with `NODE_ENV` unset is added, and the sidecar caveat is documented. | 3.4, 12, 17; contracts |
| R11 | `createTraceletInstrument({ enabled?, skipInstrumentation? })` is frozen (`TraceletInstrumentOptions`) and `tracing.skipInstrumentation` is removed. The instrument evaluates the disable flags at decoration time and returns instances untouched when disabled. Test `r11-instrument-enable` added. | 3.6, 13, 16; contracts |
| R12 | `errorMessages` defaults to `'omit'` outside dev/test. | 11; contracts |
| R13 | **Not committed.** The freeze doc states that the hashes stay unanchored until a commit and that M02 must use worktrees. Added as D9. | freeze doc 1; 20 |
| R14 | Shared-Mongo sizing (9.1); production `maxRootsPerSecond` lowered to 20 and `sampleRate` to 0.05; writer cap `maxWriteDocsPerSecond` 2000. | 9, 9.1; contracts |
| (rev 2 dashboard import) | Changed the dashboard's contract import to the `@tracelet/contracts` alias. This was a guess at L1; L1 turned out to be about the POC commands (see revision 3). The alias is kept on its own merits: a relative `../src/...` import is correct only from `ui/` itself, not from files under `ui/src/**`, and the imports are type-only, so nothing is bundled. | 3.11 |
| globalThis singleton | ALS, runtime and `BOOT_ID` live in `globalThis[Symbol.for('tracelet.runtime')]`; duplicate package copies with the same contract major share them, and a different major makes itself a pass-through. | 3.4, 3.5, 13 |
| L2-L11, optionals | Content not available in revision 2; applied in revision 3 (table below). | — |

### 22.1 Revision 3: low-severity items and optionals (wording relayed by the orchestrator)

| Item | Resolution | Where |
|---|---|---|
| L1 | POC commands now use `../../node_modules/vitest/vitest.mjs` (npm workspaces hoist vitest to the repo root) with a `Test-Path` check. Fallback if `npx -p node@x` cannot install: the official Node zip, verified against `SHASUMS256.txt`, run from a separate directory; otherwise record NOT RUN with the error. | 16 |
| L2 | The closure table now separates **reached-but-skipped** (new table 4.1: 50 files reached from the starting set, each with its first edge and the edit that cuts it) from files reached only through the reference-only `observe.module.ts` (row 35; 83 files including those). The Stage 00 copy proposals for `redact-url-query`, `fit-to-length` and `skip-spans` are explicitly reversed, with reasons. Dropping `propagateTraceIdThrough` (`observe.module.ts:425,445-469`) is recorded for the fork delta. Row 30 removes fold-profile's `SpanSlice` import. Closure computed by `scratchpad/cv-src/closure-nomodule.cjs` and `closure.cjs`. | 4, 4.1 |
| L3 | One name, `src/contracts/tracelet-internal-contracts.ts`, a byte-identical copy; the contract header now says so. | internal contracts header, 3.3 |
| L4 | Field added: `InstanceHeartbeat.profiler.achievedSampleRateHz` (schema, TS, internal `ProfilerHealthSource`, OpenAPI `/health` description, v1 heartbeat fixture). | 7; contracts |
| L5 | `recordRoot` runs exactly once per root: the first of settle or force-close, guarded by the token. Force-closed roots count once with duration to close; a late settle is ignored; never-settling unsampled roots are not counted (documented). Unit test named. | 6.2 |
| L6 | `currentTraceId()` returns `undefined` unless the token is sampled, open and still in the registry (`CurrentTraceIdFn` in TS contracts). | 6.2; contracts; freeze doc 7 |
| L7 | `artifacts/02_bench_overhead.json` assigned to INS and `artifacts/02_bench_profiler.json` to PRO. | 8 |
| L8 | Injected JSON is escaped: `<`, `>`, `&`, U+2028 and U+2029 become `\u` escapes. Specified in `DashboardRuntimeConfig`; unit test named. | 12; internal contracts |
| L9 | The auth peer address comes only from the socket; T15 runs with Express `trust proxy` and Fastify `trustProxy: true` and a spoofed `X-Forwarded-For`. | 12, 17 |
| L10 | Harmonised: Fastify routes register all methods, and a route-level `onRequest` hook returns Tracelet's 405 before body parsing. T15 asserts the same 405 on both adapters. CORS preflight caveat documented. | 12, 17 |
| L11 | `sanitizedHostName` is truncated to 115 characters, so `instanceId` is at most 128; `hostName` is kept whole. | 14; internal contracts `InstanceIdentity` |
| Opt: lib ES2023 | `target`/`lib` ES2023 (upstream parity). | 3.2 |
| Opt: hash separators | NUL separators in `sha1(operation + "\u0000" + kind)` (rollup `_id`) and in the error fingerprint. | freeze doc 4; 3.7 |
| Opt: non-native thenables | Settle at return time; documented in `TraceFn` and 6.2. | 6.2; contracts |
| Opt: stack relabel | `relabelProxyFrame` documented as an observable change (same reference, different `stack` text). | 6.3 |
| Opt: operation names | Cardinality and PII guidance; rollup cap warning. | 11 |
| Accepted | The T09 250 ms bound and `maxStallMs` 250 (revision 2) are accepted by the orchestrator. | — |

### 22.2 Revision 4: re-review (APPROVE-WITH-CHANGES), two Medium and two Low items

| Item | Resolution | Where |
|---|---|---|
| R5 (Medium) | `gapBeforeMs` = first sample of this window minus last sample of the previous one, with sample times = `profile.startTime` + cumulative `timeDeltas`. It is no longer V8 `startTime` - previous `endTime`, which the re-review measured at 9.6-9.8 ms while the first sample arrived 91-116 ms after `startTime`. T09/T10 coverage = sum of each window's first-to-last sample span over the overall sampled interval. `achievedSampleRateHz` uses the sampled span, not `durationMs`. `durationMs` is documented as not a coverage measure. v1 profile fixture: `gapBeforeMs` 0.4 to 104.6 (realistic), `idleSampleCount` 2458 to 2448, heartbeat `achievedSampleRateHz` 98.99 to 98.96 (= 2959 / about 29.9 s). T09 note added: under the old definition a 250 ms bound could not detect scheduling regressions. The 250 ms bound, 95% coverage and `maxStallMs` 250 are kept (justified in section 7); D7 stays open. | 7, 16, 18; `observe-contracts.ts`; schema description; v1 fixtures |
| R9 (Medium) | One `RollupItem` per dirty bucket; flush cadence 10 s, plus at bucket close and at shutdown. Control-pool items are coalesced per bucket (replace in place, idempotent). The control pool evicts oldest-first (metrics, then rollups), so the newest closing-bucket aggregates survive. Item size is about 0.75 MB at full cardinality and about 1.5 MB worst case. A single item over `maxQueuedControlBytes` is rejected and counted; config validation requires `maxQueuedControlBytes >= 2 MiB`. New T11 case: outage longer than 64 rollup flush intervals; the final closing-bucket rollups are stored after reconnect. Plan only; no contract change. | 3.7, 9, 17 |
| L-a | The decorator also checks `token.open` and runs untraced on a closed token, so a stale store cannot attach spans during the pluck window or to a held force-closed snapshot. Audit wording corrected. Test H6(g). | 4 row 1 (e), 16, 18 |
| L-b | The global slot is gated on `TRACELET_RUNTIME_ABI` (an internal integer, bumped on any change to the slot's shape or behaviour), not on the contract major. On a mismatch the copy becomes a pass-through and logs once. | 3.4 |

### 22.3 Revision 5: follow-ups from the approval of revision 4 (low)

| Item | Resolution | Where |
|---|---|---|
| Metric eviction erases drop records | The counter deltas of an evicted `MetricItem` are folded into the newest queued `MetricItem`, or into a carry-over for the next one. New T11 assertion: stored counter sums equal the queue's cumulative increase, including eviction-caused `rollupsDropped`. | 9 (control pool), 17 (T11) |
| Un-awaited work after root settle | Documented next to H6(g) as a behaviour change vs upstream (late provider calls after settle are untraced; spans started before settle still end within the pluck wait); the test asserts both halves. | 16 |
| Flame-graph fixture arithmetic | `api-responses.json` Flamegraph `sampleCount` 1010 to 609 (= 600 + 9 dropped). New freeze section 5 invariant 9; the validator now checks it, with a negative control. | freeze doc 5; v1 fixtures; validator |
| Section 18 wording | "lost if the rollup write fails **or the rollup item is evicted from the control pool**", plus counted in `rollupsDropped`. | 18 |
