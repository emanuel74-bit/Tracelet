# Mission 04 — storage/query repair checkpoint

Date: 2026-10-30. Owner: Codex.
Worktree: `D:\codeShit\Tracelet-wt\m04`, branch `tracelet/m04-storage-query`.
Implementation commit: `dd6a96bac67cd823d2779b7dced43d883917c0eb`.
Accepted instrumentation base: `8b800cb649a1470dba5667172f18bda22764f18e`.
Consumed LEAD dependency commit: `8d35b55c5de377b3c04777db8a3c450ac4e2cc76`.

## Current gate

Stage04 is **incomplete / NOT APPROVED**, pending LEAD disposition of canonical `docs/tracelet-handoff/change-requests/CR-STO-002-stable-cursor-window.md`. Stage05 has not started; stage08 requires Claude07. The dependency and file-layout prerequisites are resolved. G0 is waived for fixture integration per the latest canonical user decision and remains an unverified release gate. No host compatibility claim.

Contracts: accepted frozen v1 revision5, with accepted stage02/03 evidence read from m02/m03. No schema/API changes were approved or made. MongoDB6.21.0 implements approved D3 through LEAD's CR-003; Codex did not edit manifests/lockfile. CR-STO-001 is superseded, not a second approval.

## Owned implementation and repairs

Only `packages/tracelet/src/{storage,query,api}/**` and approved storage/query tests were committed (31 files). The checkpoint now conforms to approved plan §3.9: dedicated bounded client, collections/documents/indexes, retry/writer/heartbeat/facade, separated repositories/cursor/filter/percentiles, and adapter-neutral authorized API.

Repairs cover recursive nested DTO stripping, newer-schema skip counts/header, deadline accounting of drained in-flight items, detached writer/lifecycle work, per-document pacing, HEAD denial, safe errors, process-wide heavy-query admission, and bounded queries. Added rate-limited fixed-text diagnostics for startup/heartbeat/write/shutdown failures. Actual Mongo driver generic typing was repaired. Query Name max128 and opaque TraceId min8 now match the frozen schema.

Tests cover failure/timeout/auth boundaries, complete fixture DTO projection, empty route schemas, schema diagnostics, calendar validation, cursor binding, profile/stack caps with sample conservation, bounded shutdown/retry/pacing, safe detached diagnostics, lifecycle stop/reconnect, TTL/index definitions and natural keys. Production paths read/write Mongo; fixtures occur only in tests.

## Actual validation

Environment: Node22.22.0, npm10.9.4, TypeScript5.9.3, mongodb6.21.0. Locked dependencies recovered by copying from LEAD node_modules with an identical lockfile hash `53217906076E6D00BA717D9DB23B436A3502A7B5C6CB71B42D4C6818058B4E1F`; source worktrees were read-only.

- `npm run -w packages/tracelet typecheck`: exit0 (parent).
- `npm run -w packages/tracelet lint`: exit0 (worker).
- `npm run -w packages/tracelet build`: exit0 (worker).
- `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/unit/query/vitest.config.mts`: exit0, 2 files,37/37 (parent and independently reviewer).
- `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/support/storage/vitest.config.mts`: exit0,3 files,15/15 (worker and independently reviewer).
- `git diff --cached --check`: exit0 before implementation commit, after removing trailing blank lines. No semantic edits followed the reviewed snapshot.
- Full default unit: exit1,26 files,405 passed/2 failed of407. Failures: Claude-owned bearer redaction timing157.724ms vs50ms, and ALS ABI test5000ms timeout. No thresholds/source were changed. Isolated follow-up and integration results are recorded below when completed.

Default SWC tests first failed sandbox native-cache ownership checks. A workspace cache and temporary mode also failed. Configured investigator proved native transform success under narrow elevated execution using the existing user-owned cache with SWC_NATIVE_BINDING_CACHE unset; no ACL/package edits. Full suites use that verified path. A first parent CLI attempt with unsupported --include failed before testing; the correct scoped commands above passed.

Real Mongo **NOT RUN**: no disposable TRACELET_TEST_MONGO_URI; Docker probe did not establish an available daemon (exit1). The opt-in test creates/drops a unique test database and checks two pools, duplicate retry, BSON dates, seven TTL indexes,22 index definitions and an indexed trace explain. TTL deletion, live disconnect/reconnect and actual query plans remain unverified. See `artifacts/04_VALIDATION_RUNBOOK.md`.

## Independent review

Configured tracelet_reviewer (Sol High), read-only: independently52/52 scoped tests pass; no new Critical/High finding. Earlier layout/lifecycle, DTO, shutdown, diagnostics, isolation, pacing and HEAD findings are closed in the repaired snapshot.

Verdict **NOT APPROVED**: Medium omitted-bound pagination still fails after clock advance. Frozen cursor `{v:1,s,t,f}` cannot carry original resolved bounds; a pod-local cache would break continuation across pods. Code rejects drift and supports fixed explicit to/from. LEAD must freeze a versioned bound-carrying cursor or an explicit-bound continuation rule before Codex can implement that decision. No self-approval or contract workaround.

## Roles / effort checkpoint

Configured tracelet_worker (Sol Medium) owned storage/dependency recovery; parent owned query/API boundary repairs/tests. Configured tracelet_investigator (Sol High) handled two distinct SWC environment recovery failures and default-suite execution. Configured tracelet_reviewer (Sol High) independently reviewed final repairs. Parent setting and quota: UNKNOWN; no parent effort/model change claimed. Work classification: bounded implementation, complex environment diagnosis/review.

## Next owner and continuation

Claude/LEAD: decide canonical CR-STO-002 and supply approved frozen artifacts. Codex then implements the accepted cursor behavior, reruns affected checks, obtains independent review and continues immediately to05 once04 is accepted. Claude07 remains outside Codex scope;08 waits for07.

Existing Tracelet Codex Progress remains the authorized15-minute observer; no schedule creation/mutation/probe, polling for prerequisite changes, Claude launch, publication or deployment. No other people's changes were reset/stashed/staged/committed. An initial broad directory staging request was rejected by automatic review; exact inventoried Codex file staging was subsequently approved and succeeded. No unrelated docs/cache were included.

Historical early validation failures are retained in existing04 logs; the executed results above supersede historical dependency-blocker paragraphs. Canonical status is maintained in `D:\codeShit\Tracelet\docs\tracelet-handoff\MISSION_STATUS.md`.

## Final default-suite evidence and provider boundary

Configured investigator ran default suites via narrow elevated execution after proving SWC transform success:
- `npm run -w packages/tracelet test`: exit 1; 26 files; 405 passed, 2 failed (407 total).
- `npm run -w packages/tracelet test -- tests/unit/shared/als-abi.spec.ts tests/unit/buffer/redaction-cpu.spec.ts`: exit 0; 2 files; 22 passed. These isolated passes do not turn the initial full run green or prove a contention cause.
- `npm run -w packages/tracelet test:int`: exit 1; 27 files (25 passed / 1 failed / 1 skipped); 123 passed / 1 failed / 1 skipped tests. The skipped test is the opt-in real Mongo test.
- `npm run -w packages/tracelet test:int -- tests/integration/instrumentation/shutdown.int-spec.ts`: exit 1; 13 passed / 1 failed. `shutdown.int-spec.ts:40` measured 819.577 ms against <700 ms; full run measured 799.987 ms. This is reproduced in this environment, not a proven contention flake. Claude/INS owns the source and test; no threshold or instrumentation edits were made.

Logs: 04_FULL_UNIT_OUTPUT.txt, 04_ISOLATED_UNIT_OUTPUT.txt, 04_FULL_INTEGRATION_OUTPUT.txt, 04_ISOLATED_SHUTDOWN_OUTPUT.txt. Generated stage 02 artifact bytes were captured and restored exactly by the investigator; tracked Git status was verified clean afterwards. Current generated measurement evidence is retained under artifacts/04_current_02_*.json. All worker/investigator test processes have exited.

The remaining work crosses approved ownership: LEAD/contracts must dispose CR-STO-002, and LEAD/INS must investigate/dispose the reproducible existing shutdown failure. All useful identified repairs within the approved stage 04 ownership are checkpointed. Stage 04 is not accepted; stage 05 remains gated. No new schedule or polling loop was created.
