# Codex post-stage-09 acknowledgement

Reviewed target: `tracelet/m09-release@b9873d8d0f273b099bb12f049d94f5331d57dd9e`.
Date: 2026-11-02. This report is the requested Codex acknowledgement; it is not another unstarted stage or a release approval.

**Stage 09 M1/M2/L3 remediation is acknowledged as addressing the stage 08 findings. RELEASE NOT APPROVED.** No new Critical/High defect was found in this bounded follow-up. Claude may proceed with explicit project close-out or triage of the remaining limitations; its gate must no longer wait for Codex to start/post this review.

## Independent review and fresh execution

Configured `tracelet_reviewer` (`gpt-6.1-sol`, high) performed read-only review of the exact target, stage 09 diffs and regression tests, benchmark methodology/report, and independently parsed the final provider-enabled benchmark JSON. The reviewer did not rerun product suites. Parent model/effort was not changed or inferred.

Parent actually reran these checks on the target with Node 22.22.0, Windows, using D: for TEMP/TMP because C: has only about 344 MB free:

- Focused unit command: `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config vitest.config.mts tests/unit/profiling/profiler-stop-race.spec.ts tests/unit/module/readme-sample.spec.ts` — exit 0, **10/10**, two files. Log: `09_ACK_UNIT_OUTPUT.txt`.
- Focused listener command: same root with `--config vitest.int.config.mts tests/integration/http/listen-shutdown-race.int-spec.ts` — exit 0, **4/4**, one file, including full Nest application close/port checks. Log: `09_ACK_LISTENER_OUTPUT.txt`.
- Initial `npm run -w packages/tracelet test:mongo` — storage **1/1**, end-to-end **6 passed / 1 skipped**; overall exit **1** because npm's path workspace selector also selected the nested UI workspace, which has no `test:mongo` script. This wrapper failure is retained, not relabeled green. Log: `09_ACK_MONGO_OUTPUT.txt`.
- Corrected `node tests/support/e2e/with-mongo.mjs` from `packages/tracelet` — overall **exit 0**, real-Mongo storage **1/1**, end-to-end **6 passed / 1 skipped**, two e2e files. The script starts and stops its disposable mongod. Log: `09_ACK_MONGO_RERUN_OUTPUT.txt`.

No full default suite, benchmark, UI browser suite, Node 20/24 suite, real RabbitMQ, Linux/OpenShift or target-host check was rerun by this acknowledgement. Prior full-suite and overhead results remain attributed to Claude's recorded runs. Narrow elevated test execution was used for the established native-transform/cache environment; no ACL, dependency, source or threshold change was made.

## Stage 08 findings disposition

- **M1 closed for the reviewed sequence:** `profiler.service.ts` invalidates old startup/resume/retry work with a generation counter; a superseded local sampler is stopped before publication and late errors cannot revive stopped health. Focused deferred-start and related regressions passed.
- **M2 closed:** `trackServer()` rejects and closes late listener registrations, and `Tracelet.listen()` rejects the losing asynchronous startup. The deterministic and full Nest tests passed and checked port closure.
- **L3 closed:** README sample extraction handles LF/CRLF with executable equivalence coverage. The focused tests passed on this checkout.
- The previously reviewed storage accounting/heartbeat repair `c54635a`, consumed as `2877dad`, remains part of the target. No duplicate cherry-pick is requested.

## Remaining operational finding and explicit owner

**Medium: saturated full tracing can exhaust the shutdown budget before control telemetry is persisted.** All 12 sampleRate-1 C rows in the final provider-enabled dataset have zero operation, method and metric rollups. This is confirmed evidence, not an inferred default-mode failure.

Source: `buffer/telemetry-queue.ts:280` drains globally by sequence across its reserved pools; `storage/telemetry-writer.ts:49` serially persists/paces drained items, and its shutdown deadline at line 32 discards remaining telemetry. Reserved control admission capacity does not reserve persistence time. The writer only has the frozen `TelemetryQueue.drain(maxItems,maxBytes)` interface; it cannot choose the control pool without a cross-owner policy/interface decision.

**Ownership disposition:** LEAD owns the policy decision and any required plan/contract CR; INS owns queue selection/priority; STO owns writer coordination and regression verification once that policy is approved. Codex does not authorize bypassing pacing, silently extending shutdown deadlines, mutating the frozen queue interface, or editing Claude's queue. Before a release decision, LEAD must explicitly accept this bounded-loss limitation or approve a bounded control-drain policy and its overload/shutdown tests. This does not block acknowledging the completed M1/M2/L3 repairs.

## Evidence corrections and limits

- **Instance rows:** the final valid provider-enabled JSON has `instances=1` in **all 36 on-runs**. Two missing rows belong to an earlier root-only healthy-disk run. Their historical cause is unproven; do not describe them as reproduced by the final run or claim a new confirmed default heartbeat defect. A lifecycle-barrier regression can investigate the old observation without inventing a root cause.
- **Method rows:** default B/D rows in that final dataset have 4 or 8 method rollups. The earlier “method_rollups always zero” observation is superseded. Saturated C still loses rollups as stated above.
- **T20:** final provider-active data has six valid pairs per scenario and zero contended pairs; spans per trace exceed the activation guard. The stated cost is material: about +57–100 microseconds CPU per message at defaults for this synthetic workload. Earlier root-only runs, other-runtime overhead, a separate profiler cost and universal production estimates are not established. Missing source hashes and workload-specific results remain provenance/portability limitations.
- Real-host G0, platform/application compatibility, the actual LICENSE holder and broader release requirements remain open. The narrow acknowledgement does not supply user identity or waive those gates.

## Handoff and automation

Codex acknowledgement is DELIVERED with this report and executed evidence; the canonical mission handoff records its commit SHA. Keep the 15-minute gate task; update Claude's gate to read this report on the Codex branch/worktree rather than require it inside m09. Next owner is Claude/LEAD for close-out/disposition of the operational and release requirements. No other provider was launched or messaged; no source was modified, published or deployed by this review.
