# Stage 04 independent review — checkpoint, 2026-10-29

Reviewer: configured `tracelet_reviewer` (Sol High). Scope: Codex-owned storage/query/API checkpoint in `tracelet/m04-storage-query`, base `8b800cb`. This is stage 04 review, not stage 08 integrated acceptance. Verdict: **NOT APPROVED**.

Review method: static inspection of actual implementation, tests, accepted freeze and implementation plan. No compiler, lint, unit, integration, real MongoDB or query-plan test was executed by this reviewer; toolchain recovery is separate. Findings below are source-backed and require executable regression tests. No code was edited by the reviewer.

## Contract/ownership gate

The accepted plan §19 requires a CR for changes to its ownership, file list, caps or semantics. The current consolidated `query-service.ts`, `mongo-types.ts`, `telemetry-store.ts` and `bounded-writer.ts` layout differs from §3.9's specified file list. The scaffold also lacks the approved `mongodb` 6.21.x production dependency; package/dependency changes require LEAD coordination under §8. Required next owner: Claude/LEAD to accept a concrete file-layout/dependency CR or supply the planned scaffold. Codex must not self-approve the change or edit LEAD-owned package configuration. This gate is independent of G0, which remains deferred to stage 07.

## Blocking findings

1. **High — stage 04 has no concrete Mongo client/lifecycle or storage integration factory.** `src/storage/mongo-types.ts:26` accepts an externally supplied structural Db; current storage directory has no MongoClient factory, heartbeat scheduler or `createStorage` facade. Accepted plan §3.9 explicitly assigns `mongo-client.factory.ts`, `heartbeat-writer.ts` and `storage/index.ts` to STO. A caller cannot construct/start/stop the specified storage subsystem from frozen configuration, and the heartbeat write method alone does not provide its 30-second cadence. Implement the owned facade/client lifecycle with bounded Mongo options and prove actual-driver compatibility; keep public Nest wiring with stage 07 LEAD.

2. **High — nested unknown fields can escape API projections.** `src/query/query-service.ts:19-26` strips only top-level fields. A stored trace with `error: {name:'Error', payload:{password:'secret'}}` is returned intact under `error` by `/traces` and trace detail (`:86`, `:94`). Likewise nested heartbeat versions/tracing/profiler/buffer/storage objects are returned intact by health (`:158`). The freeze migration policy requires unknown storage fields to be stripped and DTOs have `additionalProperties:false`. Project/normalize nested DTOs against the frozen schema, and test that unknown nested fields never leave any API response.

3. **High — shutdown deadline loses accounting for drained in-flight telemetry.** `src/storage/bounded-writer.ts:16-22` races the loop against a timeout then drains only queued items. `:39-50` has already removed the current batch before awaiting Mongo. With `store.write()` returning a never-settling promise, shutdown resolves at its deadline but the current and remaining drained items are neither persisted nor reported dropped. Track the in-flight batch, account it exactly once at shutdown timeout, and ensure late completions cannot double-count or resume draining after closure. Regression: never-resolving store, queue containing multiple items, bounded shutdown time and complete per-pool drop counters.

4. **High — newer-schema skipping has no required diagnostics.** `src/query/query-service.ts:62` and individual reads hard-filter `schemaVersion:1`, while `src/api/query-api.handler.ts:7` never emits `X-Tracelet-Skipped`. Frozen compatibility §10 requires newer documents to be skipped **and counted** in that header. Current mixed-version data silently disappears. Implement bounded counting tied to the same read/window/filter and test newer-schema rows through actual handler responses.

## Further required fixes / verification

5. **Medium — default-window pagination changes the effective filter between pages.** `src/query/query-service.ts:56` recomputes `to=now`, but `:64-74` binds cursors only to explicitly supplied query text. An omitted `from/to` therefore accepts a cursor for a changing one-hour window, dropping eligible old rows as time advances. Preserve the resolved first-page bounds in pagination state or provide another contract-compliant stable-window strategy; test a clock advance between pages for traces/profiles/errors.

6. **Medium — writer work is not explicitly detached from trace context.** `src/storage/bounded-writer.ts:15`, `:24-25`, `:47-51` run loops, timers and Mongo work without `runOutsideTrace`. Accepted plan shared ALS/storage rules require internal asynchronous work outside business trace context. Start/flush/shutdown and retries must be detached (and internal providers branded by stage 07). Verify by starting/flushing inside a live root and asserting internal callbacks have no trace context and no recursive spans.

7. **Medium — document pacing permits large immediate bursts.** `src/storage/bounded-writer.ts:45-50` delays the next item based on the previous item's size, but writes all documents of the first item immediately. A 5000-span trace at a low `maxWriteDocsPerSecond` inserts 5001 documents immediately and then sleeps. Verify the accepted §9 rate-limit semantics and enforce document-granular bounded batches if the configured rate is intended as a per-second ceiling. Test high-span traces against measured write batches/timestamps.

8. **Medium — query/API and writer regression coverage is absent.** Only four new storage tests exist in `tests/unit/storage.spec.ts`; none covers query route schema conformance, filters/cursor stability, auth denial before storage, timeout/error mapping, merged profile caps, mixed schema diagnostics, writer retries/deadlines/rate limits or actual driver behavior. These are material acceptance gaps, not passed checks. Run typecheck/lint/build and meaningful unit tests; supply real Mongo two-instance writes, TTL/index existence and explain evidence, or explicitly record unavailable real-Mongo checks per the mission exception.

9. **Low — HEAD denial still includes a response body.** `src/api/query-api.handler.ts:13` returns before the HEAD body-stripping function is created (`:14-15`). Apply HEAD semantics consistently to authorization failures too.

No auth bypass was found in the inspected default-deny handler; authorization is evaluated before storage. Error mapping sanitizes unknown driver errors. These static observations do not constitute runtime proof or acceptance.


## Independent repair review — 2026-10-30

Configured tracelet_reviewer (Sol High), final read-only review of the repaired stage04 checkpoint: **NOT APPROVED pending CR-STO-002**. No new Critical or High findings.

The reviewer independently executed:
- `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/unit/query/vitest.config.mts`: exit0, 2 files, 37/37 tests.
- `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/support/storage/vitest.config.mts`: exit0, 3 files, 15/15 tests.

Reviewed repairs close the earlier approved-layout/lifecycle, nested DTO, newer-schema diagnostics, shutdown in-flight accounting, trace isolation, document pacing and HEAD findings. Fixed startup/heartbeat/write-drop/shutdown diagnostics use coarse safe text, shared rate limiting and detached logging; tests exercise secret suppression and deadline accounting. Driver generic compatibility is repaired. Parent additionally corrected Name max128 and opaque TraceId min8 validation and added schema/cap/concurrency regressions.

Remaining Medium: default-window continuation recomputes now and rejects the changed resolved-filter hash. Fixed explicit bounds work; successful implicit-window continuation requires LEAD disposition of canonical CR-STO-002. That draft is not approval and frozen cursor fields were not modified. Stage04 remains incomplete; stage05 has not started.

The reviewer did not independently verify full default suites, real Mongo or host compatibility. Parent/investigator validation is separately attributed in MISSION_REPORT.md. Earlier findings above are historical; this section is the current review disposition.
