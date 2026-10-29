# 01 — Contract freeze (Mission 01)

**Status: FROZEN v1 (revision 5), approved by the orchestrator on 2026-10-29 after independent review (APPROVE at revision 4; revision 5 applies its four low follow-ups). Anchored by the commit recorded in section 13. Any change now needs a change request (plan section 21).** The first review returned APPROVE-WITH-CHANGES; revision 2 applied R1-R14, revision 3 applied L1-L11 and the optionals, and revision 4 applies the re-review's R5/R9/L-a/L-b changes (changelog in section 11; plan section 22 maps every item). Nothing here is approved until the re-review signs off. After approval, changes go only through the change-request protocol (`01_IMPLEMENTATION_PLAN.md` section 19).

> **Hashes are unanchored (R13).** Nothing in this repository is committed (the user has not yet approved a commit). The SHA-256 values below identify file contents but cannot be tied to a commit until one exists. Mission 02 must start from that commit in its own git worktree (`D:\codeShit\Tracelet-wt\m02`, branch `tracelet/m02-poc`), never in the primary workspace.

Date: 2026-10-29. Upstream pin used for the SDK-shape mapping: `nestjs/observe@7500fba7f61f4d0e177e415b291ec6d4d366b052` (MIT), read-only at `D:\codeShit\Tracelet-refs\observe`.

## 1. Versions and files

| Item | Value |
|---|---|
| Telemetry record version | `schemaVersion: 1` (every record and Mongo document) |
| Contract version (TS constant `CONTRACT_VERSION`) | `1.0.0` |
| OpenAPI | `3.1.0` document, `info.version: 1.0.0` (was `3.0.3` / `1.0.0-draft`) |
| JSON Schema | draft 2020-12, `$id https://internal.invalid/tracelet/telemetry-v1.schema.json` |

Frozen files (kit `resources/contracts/`, SHA-256 at the time of writing):

| File | Role | SHA-256 |
|---|---|---|
| `observe-contracts.ts` | TS mirror of DTOs, API DTOs, public API types and defaults | `8c3722d7d9a29654442b6542020589f873dab3cbfc679e896878763aa9320cc9` |
| `tracelet-internal-contracts.ts` (new) | Module-boundary interfaces between owners | `9a8574c7251c370bb9bbb412c8b40fcd38538faa62890bc46c84c8253227e05f` |
| `telemetry.schema.json` | **Single source of truth** for record/DTO shapes (`$defs`) | `82fc0f3e7021addbf4941ede3549c702e701b2fc3223893407cfca98801fe905` |
| `query-api.openapi.yaml` | Routes, parameters, status codes; schemas `$ref` the JSON Schema | `d254344cc6ca7340b24054b242f532c5f8f86b9ffd48eda1ee94454676d57ae7` |
| `v1-fixtures/traces.json` (new) | Illustrative, schema-valid fixtures exercising every v1 field. **Fictional data, contract tests only.** | `5a5f530c6b98da36206f5e7035d27d5f476aa22e25c08d724e1a8c5f35990716` |
| `v1-fixtures/spans.json` (new) | same | `ebe84a3a96d31c7e8253ba2c314a109f870ddf0c398371062360ca501a19c0f3` |
| `v1-fixtures/profiles.json` (new) | same | `2e9ab832e64ab1fc6a78b1b19b0a963a4da0083050c236d1fa5280634c1d889c` |
| `v1-fixtures/rollups.json` (new) | same (OperationRollup, MethodRollup, MetricRollup, InstanceHeartbeat) | `9337f9a4339f44a336f424525a7c7a6f152825d8f99cad02a6f6673135cb0554` |
| `v1-fixtures/api-responses.json` (new) | one example per API DTO | `41ad497157d2bc6ffd675cda2481b2ad9f558a791fde7d1b7a2a28773fd3c0f9` |

The kit's own `SHA256SUMS.txt` still lists the proposal hashes for the three edited contract files. That mismatch is expected and was not "fixed" (the kit file is outside this mission's write scope). Kit fixtures under `resources/fixtures/` were not edited.

## 2. What changed from the proposal (and why)

| Area | Proposal | Frozen v1 | Reason |
|---|---|---|---|
| Trace fields | 12 required | Same 12 required; added optional `rootSpanId`, `sampleRate`, `detail`, `droppedSpanCount`, `unfinishedSpanCount`, `attributes`, `error`, `errorFingerprint` ("v1 producer always emits") | Truthful sampling labels (T21), truncation warnings (T22), error grouping (`/errors`), without invalidating proposal fixtures |
| `errorCount` meaning | undefined | Number of **error-origin** spans (spans carrying `sanitizedError`) | One error propagating through 3 spans is 1 error; matches kit fixture trace 2 |
| Span fields | 7 required + optional | Same required set; added optional `origin`, `collapsedCount`; `sanitizedError` only on origin span | Upstream span collapse (`collapse-repeated-spans.util.ts`) and the synthetic root span |
| Self time | "derived carefully" | Union-of-child-intervals clipped to the parent; omitted when not computable | `TELEMETRY_DATA_MODEL.md`; sibling overlap (T04) |
| Profile | stacks only | Added optional `durationMs`, `idleSampleCount`, `droppedStackCount`, `droppedSampleCount`, `gapBeforeMs`; `sampleCount` = non-idle samples = sum(stacks) + dropped | Continuity evidence (H1), truthful idle/total split, cardinality caps |
| Metrics | one `metric_rollups` shape with request counts | Split: `operation_rollups` (all settled roots, not sampled), `method_rollups` (sampled spans), `metric_rollups` (runtime gauges + telemetry drop counters), `instances` (heartbeats) | Exact execution counts independent of trace sampling; method table needs p95; health of every replica must be readable from any pod |
| Health | per-process object | `Health { servedBy, items[InstanceHealth] }` from persisted heartbeats | Any pod's dashboard shows all replicas (product brief exit 5) |
| Profiler states | running/disabled/unavailable | + `starting`, `backoff`, `stopped`, `error` | Kill-switch replaced by backoff (Stage 00 Q3) |
| Routes | 9 | + `GET /methods` (dashboard page 2), + `GET /flamegraph` (time-range merge for the profiler page) | `DASHBOARD_DESIGN.md` pages 2 and 4 |
| `/services` | `items: string[]` | `items: ServiceSummary[]` | Instance counts and liveness in filters |
| OpenAPI | 3.0.3 draft, no response schemas | 3.1.0, every 200 has a schema, `4XX`/`5XX` use `ErrorEnvelope` | 3.1 can `$ref` JSON Schema 2020-12 directly: one source of truth |
| Options | `EmbeddedObserveOptions` | `TraceletModuleOptions`, `TraceletSetupOptions`, `TraceOptions` with frozen defaults | Distinct product name (licensing note), safe defaults |

## 3. Mapping: vendored SDK node shape to v1 records

Source shapes: `src/interfaces/trace-events.interfaces.ts:3-70` and `trace-span.interface.ts:1-43` at the pin. Mapping is implemented only in `src/buffer/record-mapper.ts` (instrumentation owner).

| Vendored node field | v1 span field | Rule |
|---|---|---|
| `spanId` (uuidv7, `operation-trace.registry.ts:452,473`) | `spanId` | as is |
| tree position (`children`) | `parentSpanId` | parent's `spanId`; the synthetic root has `null` |
| `origin: "auto" \| "manual"` (+ new `"root"`) | `origin` | as is |
| `className`, `methodKey` | `className`, `method`, `operation` | auto: `operation = className + "." + methodKey`; root/manual: `operation = name`, `className`/`method` omitted |
| `startOffset` (ms from root start, `registry:695-703`) | `startOffsetMs` | as is; root = 0 |
| `duration` | `durationMs` | as is |
| `error: true` | `status: "error"`, no payload | ancestor of the origin span |
| `error: {cls,message,stack}` | `status: "error"`, `sanitizedError {name,message?,stack?[]}` | only on the origin span; `stack` split into frame lines, message line removed, max 20 |
| `tags["observe.collapsed"]` (`collapse-repeated-spans.util.ts:27`) | `collapsedCount` | collapse happens **after** self-time is computed |
| node left open at pluck (`registry:850-876`) | not stored | counted in trace `unfinishedSpanCount`; parent `selfDurationMs` omitted |
| refused by `maxSpansPerTrace` (new) | not stored | counted in trace `droppedSpanCount` |

Snapshot to trace: registry key is internal; `traceId` = uuidv7 minted at root start; `startedAt` = `Date.now()` captured at root start; `durationMs` = root span `durationMs`; `status` from root settle (`ok`/`error`) or `incomplete` when force-closed by the sweeper or shutdown.

## 4. Storage documents (MongoDB)

Database default `observability`; collection prefix default `tracelet_`. Every document = the v1 DTO plus `_id`, `schemaVersion`, BSON `Date` for every date field, and `expireAt: Date`. Spans additionally carry denormalized `serviceName`, `instanceId`, `startedAt` (the trace's) and `schemaVersion`; the API strips them.

| Collection | `_id` | Write mode | TTL source |
|---|---|---|---|
| `tracelet_traces` | `traceId` | `insertMany(ordered:false)`; E11000 duplicates ignored (idempotent retry) | `startedAt + retention.tracesHours` |
| `tracelet_spans` | `spanId` | same | same as its trace |
| `tracelet_profiles` | `profileId` | same | `periodStart + retention.profilesHours` |
| `tracelet_operation_rollups` | `${instanceId}|${bucketStartMs}|${sha1(operation + "\u0000" + kind)[0:16]}` | `replaceOne(upsert)` with the full in-memory aggregate (idempotent) | `bucketStart + rollupsDays` |
| `tracelet_method_rollups` | `${instanceId}|${bucketStartMs}|${sha1(operation)[0:16]}` | same | same |
| `tracelet_metric_rollups` | `${instanceId}|${intervalStartMs}` | `replaceOne(upsert)` | same |
| `tracelet_instances` | `instanceId` | `replaceOne(upsert)` every 30 s | `lastSeenAt + instancesHours` |

**Index set (hard cap, created idempotently by the writer; no other indexes may be added without a CR):**

| Collection | Indexes (besides `_id`) | Count |
|---|---|---|
| traces | `{serviceName:1,startedAt:-1,_id:-1}`, `{instanceId:1,startedAt:-1,_id:-1}`, `{serviceName:1,status:1,startedAt:-1,_id:-1}`, `{serviceName:1,operation:1,startedAt:-1,_id:-1}`, `{startedAt:-1,_id:-1}`, `{expireAt:1} expireAfterSeconds:0` | 6 |
| spans | `{traceId:1,startOffsetMs:1,_id:1}`, `{expireAt:1}` TTL | 2 |
| profiles | `{serviceName:1,periodStart:-1,_id:-1}`, `{instanceId:1,periodStart:-1,_id:-1}`, `{expireAt:1}` TTL | 3 |
| operation_rollups | `{serviceName:1,bucketStart:-1}`, `{instanceId:1,bucketStart:-1}`, `{expireAt:1}` TTL | 3 |
| method_rollups | `{serviceName:1,bucketStart:-1}`, `{instanceId:1,bucketStart:-1}`, `{expireAt:1}` TTL | 3 |
| metric_rollups | `{instanceId:1,intervalStart:-1}`, `{serviceName:1,intervalStart:-1}`, `{expireAt:1}` TTL | 3 |
| instances | `{serviceName:1,lastSeenAt:-1}`, `{expireAt:1}` TTL | 2 |

TTL is single-field `{expireAt:1}` with `expireAfterSeconds: 0` (no TTL on compound indexes). Deletion is eventual (Mongo TTL monitor, about 60 s cadence); nothing depends on it for correctness. Retention changes affect new documents only.

## 5. Semantic invariants (checked by the validator, section 9)

1. Exactly one span per trace has `parentSpanId: null`; its `spanId` = trace `rootSpanId`, `operation` = trace `operation`, `durationMs` = trace `durationMs`, `startOffsetMs` = 0.
2. Every non-null `parentSpanId` refers to a stored span of the same trace (orphans can still occur after partial storage failure; readers must render them as orphans with a warning, never crash).
3. `spanCount` = number of stored spans; `errorCount` = number of spans with `sanitizedError`.
4. `error` present iff `errorFingerprint` present; `status: "error"` implies the root span's status is `error`.
5. `detail: "rootOnly"` implies exactly one span.
6. `selfDurationMs`, when present and the span has no collapsed or left-out children, equals `durationMs` minus the union of child intervals clipped to the span, floored at 0 (tolerance 0.05 ms for rounding).
7. Profiles: `sampleCount = sum(stacks[].samples) + droppedSampleCount`; `periodStart < periodEnd`. Flame graphs are CPU samples per instance; no per-trace attribution in v1.
8. Rollup histograms have 16 buckets with frozen bounds `HISTOGRAM_BOUNDS_MS`, and their sum equals `count`.
9. Flame graphs (single-window and merged): `sampleCount = sum(stacks[].samples) + droppedSampleCount`. Stacks cut by the merge's 5000-stack cap are added to `droppedSampleCount` (and set `truncated: true`). Profiles not merged because of the 120-profile cap are excluded from every count and also set `truncated: true`.

## 6. Query API rules (normative; OpenAPI holds the per-route detail)

- Base: `{basePath}/api/v1`, default basePath `/observe`. GET/HEAD only. Unknown parameters: 400 `INVALID_QUERY`.
- Time: ISO 8601 UTC; default `to = now`, `from = to - 1h`. Caps: `/traces`, `/profiles`, `/overview`, `/methods` 7 days; `/errors` 24 h; `/flamegraph` 6 h. Exceeding a cap: 400 `INVALID_QUERY` (never silently clamped).
- `limit` default 50, max 100. `/traces/:id` returns at most 5000 spans (the producer cap).
- Cursor: opaque `base64url(JSON {v:1, s:<sort key ms>, t:<tie-break id>, f:<first 8 hex of sha256(canonical filter string)>})`, seek on `(startedAt desc, _id desc)` (`periodStart` for profiles; `(count desc, fingerprint asc)` offset within the capped aggregate for `/errors`). Malformed, wrong version or filter mismatch: 400 `INVALID_CURSOR`.
- `search` (1-128 chars), `/traces`: if the value has the **uuidv7 shape** (`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`) the filter is `_id` equality only; otherwise a case-sensitive anchored prefix on `operation` built from the escaped literal. `/methods`: case-insensitive literal substring on `operation`, applied in process to the aggregated rows of the capped window, never sent to Mongo. No user-provided regex, no `$` operators, no `$where`/`$function`/`$accumulator`.
- Every Mongo read uses `maxTimeMS: 5000` and a projection; timeout gives 503 `QUERY_TIMEOUT`; driver/network failure gives 503 `STORAGE_UNAVAILABLE`. At most 4 concurrent heavy queries (`/errors`, `/flamegraph`, `/overview`, `/methods`) per process; excess gets 429 `RATE_LIMITED`.
- Headers on every API response: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Error messages never contain connection strings, raw driver errors or stacks.
- Unauthorized: 403 `FORBIDDEN` for API **and** static assets, decided before any storage access.

## 7. Public API (frozen signatures; implementation owners in the plan)

- `trace<T>(name: string, fn: () => T, options?: TraceOptions): T` — semantics in `observe-contracts.ts` (`TraceFn` doc comment). Nested policy **JOIN-IF-OPEN** (H6, R2): join only when effective `forceRoot` is false, the store's root token is open, and (sampled) the registry still has the key or (unsampled) the token's deadline has not passed; otherwise a new root with a fresh store. Effective `forceRoot` defaults to true for `kind: 'rabbitmq'` unless `join: true` (R3). Joined spans use the same settle code as roots (R1).
- `currentTraceId(): string | undefined` (`CurrentTraceIdFn`): the traceId only while the store holds a sampled, open root token whose key the registry still has; `undefined` otherwise, including stale or closed stores (L6).
- `createTraceletInstrument(options?: TraceletInstrumentOptions): NestApplicationOptions['instrument']` and `TraceletInstrument = createTraceletInstrument()` — pass to `NestFactory.create/createMicroservice/createApplicationContext`. The enable decision is evaluated at decoration time (R11).
- **Environment rule (R10):** only `NODE_ENV` `development` or `test` is non-production. Unset or any other value means production defaults: disabled unless enabled explicitly, `allowLoopbackWithoutAuth` false, `sampleRate` 0.05, `maxRootsPerSecond` 20, `errorMessages: 'omit'` (R12).
- `TraceletModule.forRoot(options: TraceletModuleOptions)` / `forRootAsync({ useFactory, inject, imports })`.
- `Tracelet.setup(app: INestApplication, options?: TraceletSetupOptions): void` — must be called before `app.init()`/`app.listen()`; throws a clear error after init.
- `Tracelet.listen(options: TraceletStandaloneServerOptions): Promise<{ close(): Promise<void>; port: number }>` — worker-only processes.
- Defaults are frozen in the doc comments of `TraceletModuleOptions`; validation rejects out-of-range values at `forRoot` time with a descriptive error (configuration errors are the only Tracelet errors allowed to fail bootstrap; runtime failures never do).

## 8. Internal contracts

`tracelet-internal-contracts.ts`: `TelemetryItem` union, `QueuePool` (`trace`/`profile`/`control`, R9), `TelemetryCounterSink.count(name, n)` and `TelemetryCounterName` (R8), `TelemetryQueue` (extends the sink; non-blocking `offer`, `drain(maxItems, maxBytes)` (R7), `reportDropped`, per-pool depth/bytes, counters), health sources, `InstanceIdentity`, adapter-neutral `TraceletHttpRequest/Response`, `ApiHandler`, `DashboardAssetManifest`, `DashboardRuntimeConfig`. These are the only cross-owner coupling points; the plan's dependency graph enforces them by lint.

## 9. Validation evidence (actually run, 2026-10-29, Windows 10, Node v22.22.0)

**Revision 5 re-run (after the four follow-ups):** V1 exit 0: 48 validations, 0 failures, 0 invariant issues, **9/9** negatives rejected. The new ninth control is the flame-graph invariant (`sampleCount` off by 401). A copy of the contracts with the old `sampleCount: 1010` makes V1 exit 1 with `v1 api-responses.Flamegraph: sum(stacks)+droppedSampleCount != sampleCount`, so V1 now catches the defect. V2 exit 0; V2-neg exit 2 (`TS2322 '"per-trace"' is not assignable to type '"cpu-samples"'`); V3 valid, 0 warnings; V4 bundle created. The hashes in section 1 are from this state.

**Revision 4 re-run (after R5/R9/L-a/L-b):** V1 exit 0 (48 validations, 0 failures, 0 invariant issues, 8/8 negatives rejected, with the updated profile and heartbeat fixtures); V2 exit 0; V2-neg exit 2 (`TS2322` for a string `gapBeforeMs`); V3 valid with 0 warnings; V4 bundle created, and it carries the new `achievedSampleRateHz` description.

**Revision 3 re-run (after applying L1-L11 and the optionals):** V1 exit 0 (48 validations, 0 failures, 0 invariant issues, 8/8 negatives rejected; the v1 heartbeat fixture now carries `achievedSampleRateHz`); V2 exit 0 (the generator also checks `CurrentTraceIdFn`); V2-neg exit 2 (`TS2322` for a string `achievedSampleRateHz`); V3 valid with 0 warnings; V4 bundle created, and the bundled document contains `achievedSampleRateHz` through the `$ref`. 

**Revision 2 re-run (after applying R1-R14):** V1 exit 0 (48 validations, 0 failures, 0 invariant issues, 8/8 negatives rejected); V2 exit 0 with the generator extended to type-check the revision-2 surface (`TraceletInstrumentOptions`, `TraceOptions.join`, `TelemetryCounterSink`, `QueuePool`, two-argument `drain`); V2-neg exit 2 (`TS2353 'skipInstrumentation' does not exist` in `tracing` options, proving its removal; `TS2322` for a counter sink with an unknown counter name); V3 valid with 0 warnings; V4 bundle created. Earlier revision-1 runs are kept below for history. Tooling was installed only in the scratchpad (`...\scratchpad\cv-deps`, `...\scratchpad\oa-deps`); scripts live in `...\scratchpad\cv-src`; nothing was installed in the repo.

| # | Command (abbreviated; `$S` = scratchpad, `$K` = kit `resources`) | Result |
|---|---|---|
| V1 | `node $S/cv-src/validate.cjs $S/cv-deps $K/contracts $K/fixtures` (Ajv 8.20.0 `Ajv2020` with `strict: true, allErrors: true`, ajv-formats 3.0.1) | **exit 0.** Schema compiled in strict mode. 48 validations: kit `traces.json` (3, also via the root `$ref`), kit `spans.json` (10), kit `profiles.json` (1), v1 traces (4), spans (14), profiles (1), rollups (4 types), api-responses (11 DTOs): **0 schema failures, 0 invariant issues** (section 5 rules plus kit `cpu-samples.folded` sum = 100). 8 negative controls (schemaVersion 2, unknown status, extra `payload` property, missing `parentSpanId`, bad date-time, unknown profile format, short histogram, bad attribute key): **all rejected**. |
| V2 | `node $S/cv-src/gen-ts-parity.cjs ...` then `tsc --strict --noEmit --target ES2023 --module node16 --moduleResolution node16 observe-contracts.ts tracelet-internal-contracts.ts parity.ts` (TypeScript 5.9.3, @types/node 22) | **exit 0.** Both contract files compile; every kit and v1 fixture literal type-checks against the TS interfaces with excess-property checks. |
| V2-neg | Same, with an appended span `status: 'failed'` and a trace with `payload` | **exit 2** with `TS2322 '"failed"' is not assignable to type 'ExecutionStatus'` and `TS2353 ... 'payload' does not exist in type 'ObserveTrace'` (the parity check is real). |
| V3 | `redocly lint $K/contracts/query-api.openapi.yaml` (@redocly/cli 2.72.0, built-in recommended ruleset) | **valid, 0 warnings** (first run: valid with 16 warnings: 11 `operation-4xx-response`, 5 `tag-description`; fixed by explicit `4XX`/`5XX` responses and tag descriptions). |
| V4 | `redocly bundle ... -o $S/cv-gen/openapi.bundled.json` | **succeeded**; all external `./telemetry.schema.json#/$defs/*` references resolve. |
| V5 | `python resources/scripts/validate_kit.py` | **NOT RUN**: no Python interpreter on this machine (`python` is the Microsoft Store alias; `py` points at a missing `C:\Python312`). V1 covers the same fixture checks (spanCount, parent refs, sample sums). |

### Honest conformance notes

- **Kit fixtures conform only because every new field is optional.** They lack `origin`, `rootSpanId`, `sampleRate`, `detail`, `droppedSpanCount`, `unfinishedSpanCount` and the profile counters. Readers must apply the documented defaults (`origin` from `parentSpanId`; absent counts mean 0; absent `detail` means `full`). A v1 **producer** must emit those fields; Mission 03/06 tests assert this on real output, not on fixtures.
- Kit fixture frames (`node;MessageConsumer.handle;...`) do not use the v1 frame format (`fn relpath:line`). The schema cannot express that convention (a stack is a string), so this is a documentation nonconformance; use `v1-fixtures/profiles.json` for UI work.
- Kit span `span-h` (`ErrorTracker.record`) and `span-j` have no `className`/`method`; valid in v1 (optional), but a v1 auto span would carry both.
- Schema/TS parity is checked one way (fixtures against both). There is no automatic proof that every TS type equals its `$def`; Mission 02 adds `tests/contract/` checks (plan section 17) and the reviewer should diff them by hand.

## 10. Compatibility and migration (rolling deployments, T24)

- Additive optional field: no `schemaVersion` bump; OpenAPI minor bump (`1.1.0`); old readers ignore it (the API strips unknown storage fields; DTO `additionalProperties: false` applies to what the API emits, so the API version and the DTO schema move together).
- Breaking change (rename, type change, meaning change, new required field): `schemaVersion: 2`. Writers write only their own version. For one release, readers (query layer) accept `schemaVersion ∈ {1,2}` and map v1 documents to v2 DTOs; documents with a **newer** version than the reader knows are skipped and counted (`skippedNewerSchema` in the response diagnostics header `X-Tracelet-Skipped`), never shown half-parsed. The API path moves to `/api/v2` only if the DTO changes incompatibly; `/api/v1` stays for one release.
- Index changes: add new indexes before deploying readers that need them; never drop an index in the same release that stops using it.
- Mixed versions writing the same collections are safe because `_id`s are natural keys and rollups are per-instance documents.

## 11. Changelog

- **Revision 5 (2026-10-29, follow-ups to the approval of revision 4).**
  - `v1-fixtures/api-responses.json`: Flamegraph `sampleCount` 1010 to 609 (= 600 stack samples + 9 dropped; `truncated: false`).
  - Section 5: new invariant 9 (flame-graph sample arithmetic, including how merge caps are counted), now checked by `validate.cjs`.
  - Plan only, no contract file change: counter folding on control-pool metric eviction (plus a T11 assertion); un-awaited work after root settle documented as untraced (behaviour change vs upstream); section 18 wording now covers eviction losses.
- **Revision 4 (2026-10-29, re-review APPROVE-WITH-CHANGES).**
  - `observe-contracts.ts`: `gapBeforeMs` is redefined from **sample timestamps**: first sample of this window minus last sample of the previous one, sample time = `startTime` + cumulative `timeDeltas`. The re-review measured V8 `startTime - prev.endTime` at 9.6-9.8 ms while the first sample came 91-116 ms after `startTime`. `durationMs` is documented as not a coverage measure. `achievedSampleRateHz` uses the first-to-last sample span. This is a meaning change to optional fields of an unreleased candidate (no data exists yet), so `schemaVersion` stays 1.
  - `telemetry.schema.json`: the `achievedSampleRateHz` description uses the same formula.
  - v1 fixtures: profile `gapBeforeMs` 0.4 to 104.6 and `idleSampleCount` 2458 to 2448 (in `profiles.json` and `api-responses.json`); heartbeat `achievedSampleRateHz` 98.99 to 98.96 (= (512 + 2448 - 1) / about 29.9 s sampled span).
  - Plan-only changes (no contract file change): R9 rollup coalescing and the control-pool eviction rule; L-a `token.open` check in the decorator; L-b runtime-ABI-gated global slot.
- **Revision 3 (2026-10-29, low-severity items and optionals).**
  - `telemetry.schema.json`: optional `InstanceHeartbeat.profiler.achievedSampleRateHz` (L4). This is an additive optional field, so `schemaVersion` stays 1.
  - `observe-contracts.ts`: `achievedSampleRateHz` (L4); `CurrentTraceIdFn` returns undefined for closed or unsampled tokens (L6); non-native thenables settle at return (optional).
  - `tracelet-internal-contracts.ts`: the header names the copy `src/contracts/tracelet-internal-contracts.ts` (L3); `achievedSampleRateHz` in `ProfilerHealthSource` (L4); `instanceId` length rule with host truncation to 115 characters (L11); escaping rule for the injected JSON block (L8).
  - `query-api.openapi.yaml`: `/health` description of the achieved rate (L4).
  - `v1-fixtures/rollups.json`: heartbeat gains `achievedSampleRateHz: 98.99` (= (512 + 2458) / 30.0042 s from the v1 profile fixture).
  - This document: NUL separator in the rollup `_id` hash (optional); `currentTraceId` rule (L6).
- **Revision 2 (2026-10-29, after APPROVE-WITH-CHANGES).** No JSON Schema change; v1 fixtures unchanged.
  - `observe-contracts.ts`:
    - `TraceOptions.join`; `forceRoot` defaults to true for `kind: 'rabbitmq'` (R3).
    - `TraceFn` doc now states the joined-span settle rule (R1) and the token/registry/deadline join rule (R2).
    - New `TraceletInstrumentOptions`; `tracing.skipInstrumentation` removed (R11).
    - dev/test rule for every environment-dependent default (R10). Production defaults: `sampleRate` 0.05 and `maxRootsPerSecond` 20 (R14); `errorMessages` defaults to `'omit'` (R12).
    - New `tracing.maxOpenSpans` (R6); `profiling.maxProfileBytes` (R7); `profiling.maxStallMs` now budgets start + stop + fold, default 250 (R5).
    - New `buffer` options: `maxQueuedControlItems`/`maxQueuedControlBytes` (R9), `maxBatchBytes` (R7), `maxWriteDocsPerSecond` (R14).
    - Sidecar caveat on `allowLoopbackWithoutAuth` (R10).
  - `tracelet-internal-contracts.ts`: `TelemetryCounterName`, `TelemetryCounterSink` (R8), `QueuePool` (R9), `TelemetryQueue extends TelemetryCounterSink`, `drain(maxItems, maxBytes)` (R7), per-pool `depth`/`estimatedBytes`.
  - `query-api.openapi.yaml`: `/traces` search uses the uuidv7 shape for `_id` equality; `/methods` search semantics (R4).
- **Revision 1 (2026-10-29).** Initial frozen-v1 candidate.

## 12. Freeze checklist for the reviewer

- [x] Field set and semantics in sections 2-5 accepted (especially `errorCount` = error-origin spans, and the four new collections).
- [x] JOIN-IF-OPEN nested-root policy with registry-held tokens, deadlines, `forceRoot`/`join` and the rabbitmq default accepted (H6, R2, R3).
- [x] Revision-2 defaults accepted (production `sampleRate` 0.05, `maxRootsPerSecond` 20, `errorMessages: 'omit'`, `maxStallMs` 250; T09 contiguity bound 250 ms plus 95% coverage).
- [x] Index caps and query window caps accepted.
- [x] Default-deny dashboard policy and `authorize()` signature accepted.
- [x] V1-V4 re-run by the reviewer (commands above) or the evidence accepted.
- [x] Open decisions D1-D9 (plan section 20) resolved or explicitly deferred.

## 13. Anchoring commit and decisions

- Branch: `tracelet/stage-01-contracts`. Commit SHA: see the commit following the freeze-record commit (filled in below).
- Frozen file hashes: section 1 (unchanged by the commit; verify with `sha256sum`).
- D1 deferred (no host yet; G0 unverified, blocks Stage 02 integration gate). D2 no auto HTTP roots. D3 driver 6.21. D4 profiling off until measured. D5 deferred to a CR. D6 commit built assets. D7 30 000 ms. D8 MIT (LICENSE file with holder name added at first scaffold). D9 done.
- SHA: PENDING
