# Stage 04 remaining LEAD handoff — 2026-10-30

Worktree: `D:\codeShit\Tracelet-wt\m04`, branch `tracelet/m04-storage-query`.

The MongoDB prerequisite is resolved by LEAD commit `8d35b55c5de377b3c04777db8a3c450ac4e2cc76`, consumed in m04. MongoDB 6.21.0 is installed and actual driver types compile. CR-STO-001 is superseded by LEAD's CR-003. Codex restored approved plan §3.9's file list; no layout exception is requested.

## Required LEAD decision

Canonical request: `D:\codeShit\Tracelet\docs\tracelet-handoff\change-requests\CR-STO-002-stable-cursor-window.md`, **DRAFT / PENDING LEAD APPROVAL**.

Frozen query defaults resolve omitted to to now and omitted from to one hour earlier. The frozen cursor contains exactly `{v:1,s,t,f}`; its eight-hex filter hash cannot recover the first page's resolved time bounds across pods. Recomputing bounds changes the queried population; pod-local cursor state breaks shared-pod continuation. Current code binds resolved bounds and returns INVALID_CURSOR on drift. A fixed explicit to supports stable continuation, but successful omitted-bound continuation is unresolved.

LEAD must approve/freeze either the proposed versioned cursor carrying resolved bounds or a fixed-bound continuation requirement. Codex has not changed frozen contracts or treated the draft as approval. Regression coverage verifies fixed bounds across clock advances and rejects implicit-window drift and changed filters for traces, profiles and errors.

## Codex checkpoint

Owned lifecycle/facade, nested DTO projection, newer-schema diagnostics, shutdown in-flight accounting, trace isolation, document pacing, HEAD semantics and sanitized rate-limited diagnostics are implemented. See 04_INDEPENDENT_REVIEW.md, 04_VALIDATION_RUNBOOK.md and MISSION_REPORT.md for current review and exact checks.

Real Mongo behavior remains NOT RUN: no disposable test URI was supplied and the Docker probe did not establish a usable daemon. An opt-in two-client/index/idempotency/explain test is provided. G0 is separately waived for fixture integration and remains an unverified release gate, per the latest user decision.

Stage04 remains unaccepted pending CR-STO-002; stage05 follows acceptance; stage08 requires Claude07. Next owner: Claude/LEAD for contract disposition, then Codex to implement the approved decision and obtain fresh review. No Claude launch, publication, deployment or schedule change; reuse Tracelet Codex Progress.

## Additional LEAD/INS validation handoff

Default full integration failed the existing Claude-owned shutdown test at tests/integration/instrumentation/shutdown.int-spec.ts:40. Full run: 123 passed / 1 failed / 1 skipped, elapsed 799.987 ms vs <700 ms. Isolated command `npm run -w packages/tracelet test:int -- tests/integration/instrumentation/shutdown.int-spec.ts`: 13 passed / 1 failed, elapsed 819.577 ms. This reproduced in this environment and is not a proven contention flake. Do not weaken thresholds without INS investigation. Evidence: artifacts/04_FULL_INTEGRATION_OUTPUT.txt and 04_ISOLATED_SHUTDOWN_OUTPUT.txt.

Full unit had 405 passed / 2 failed; those two files passed isolated 22/22. Stage 04 scoped tests independently pass 52/52; typecheck/lint/build pass. Initial full suites are not claimed green. No Claude-owned source/test was edited. All test-generated stage02 artifact bytes were restored and test processes exited. LEAD/INS owns this failure disposition; LEAD/contracts separately owns CR-STO-002.
## Superseding disposition — cursor v2 accepted,2026-10-30

Historical pending-contract paragraphs above are resolved: explicit LEAD revision6 at961b35c consumed asd44511f; owned implementation and fresh independent review committed asd26c5a5. Parent accepts stage04 implementation checkpoint. Cursorv2 preserves resolved bounds across clocks/pods; v1 requires both explicit bounds; malformed/filter/cap/boundary rejections and allthree pagedroutes tested. Final scopedquery42/42, storage15/15, typecheck/build0; independentfinalquery42/42. See04_CURSOR_V2_REVIEW.md for exact failed/rerun evidence and limits. MongoNOTRUN and existingINS shutdown disposition remain, no release/host/integrated claim. No further cursor contract decision or dependency/layout approval requested. Stage05 proceeded in this user-authorized same m04 branch; LEAD should consume this branch once, not assume a separatem05 branch.
