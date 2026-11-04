# Post-stage-09 storage index repair — 2026-11-04

Scope: newly assigned Codex-owned defect in canonical `STAGE09_TO_CODEX_STORAGE_INDEX_DEFECT.md`, after completed stages 04/05/08 and acknowledged stage 09. Base: `tracelet/m04-storage-query` at `521a4575860c7f9297886f5380a082e4b31550bd`. Accepted frozen revision 6 and its 22 index definitions are unchanged. This is a scoped repair, not a new numbered mission or release approval.

## Change

`createStorage` starts the heartbeat after connection succeeds, independently of index DDL. Index setup waits for all independent attempts to settle and retains successes for this startup, retrying only failed definitions with bounded backoff. Shutdown cancels retries; pending connection or index completion cannot restart the heartbeat. The existing `ensureTelemetryIndexes` helper still rejects incomplete setup.

Sanitized, rate-limited diagnostics distinguish missing createIndex privilege (13), index conflicts (85/86), and other storage failures, as well as TTL failures versus query-only failures. No raw driver error, URI, user or password enters these diagnostics. TTL failure says automatic expiry is **unverified**: an existing administrator-provisioned TTL index may already work, while a missing one cannot be created without permission. No health DTO, schema, manifest, lockfile, queue policy or Claude-owned source was changed.

## Executed evidence

Environment: Windows, Node 22.22.0, Vitest 4.1.12; real authenticated mongod 8.2.6 reused from installed test tooling. Temporary Mongo files are on D: inside m04, avoiding the documented C: free-space constraint. No host compatibility claim.

| Command | Actual result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/support/storage/vitest.config.mts --maxWorkers=1` | Parent, worker and independent reviewer each exit 0, 4 files, 31/31. Parent's run follows the final test typing correction. |
| `node artifacts/09_INDEX_MONGO_RUNNER.cjs` | Parent exit 0, 2 files, 3/3, 22.41 s. Auth-enabled real Mongo, not a repository mock. |
| `npm run -w packages/tracelet typecheck` | Initially exit 1: TS7031, implicit-any tuple in the new test. Worker corrected test typing only; rerun exit 0. |
| `npm run -w packages/tracelet lint` | Worker and parent exit 0. |
| `npm run -w packages/tracelet build` | Parent exit 0. |

Real-Mongo cases: (1) restricted writer without createIndex persists its heartbeat; TTL is absent and an explicit safe retention/privilege warning is present; (2) conflicting trace TTL index does not prevent heartbeat or the other six TTL indexes, and repairing the conflict allows retry to install the failed TTL definition; (3) existing two-independent-pool storage test verifies idempotent trace/span writes, BSON dates, all seven TTL indexes, all 22 definitions and IXSCAN without COLLSCAN.

Unit cases cover codes 13/85/86, successful-index checkpointing, all-settled completion, synchronous DDL errors, fresh-session rechecks, hanging index setup, connection/shutdown races, bounded shutdown accounting, safe diagnostics and query-only failures. Fixtures are confined to tests. No fake live telemetry.

The runner uses existing `.review08` test dependencies and cached mongod read-only, plus disposable authenticated Mongo users/databases. It modifies no package metadata. For another environment, provision equivalent test tooling and set `TRACELET_INDEX_TEST_MONGO_URI` to a disposable auth-enabled administrator URI, then run the supplied config (never target a production database).

## Independent review

Configured `tracelet_reviewer` (`gpt-6.1-sol`, high), read-only diff review: **APPROVE for this scoped repair; no Critical/High/Medium findings**. Independently executed storage 31/31, exit 0. Re-inspected the final typing-only correction and confirmed approval unchanged. Reviewer did not rerun Mongo, typecheck, lint, Linux or host checks; parent/worker results above retain attribution. Bounded implementation used configured `tracelet_worker` (`gpt-6.1-sol`, medium). No parent model/effort change claimed.

## LEAD intake and remaining gate

Consume this isolated repair into m09; no Claude worktree was edited here. Update README's current defect description and split m09's `it.fails` known-defect case: heartbeat success is now required, but TTL creation on a fresh database **without createIndex privilege is impossible**. Assert absent TTL plus explicit retention diagnostic for that scenario; privileged/admin-provisioned TTL is a separate scenario. Do not simply convert the combined heartbeat-and-TTL assertion into a normal passing test. The new owned regression is already a normal test.

Integrated m09/full-suite/pack/Linux/SIGTERM tests were NOT RUN for this patch. LEAD owns intake and integrated acceptance. Admin permission or pre-provisioning/repair remains required to guarantee TTL retention. The user-deferred sampleRate-1 saturated shutdown policy and release limitations remain open; this repair does not resolve or approve them. Existing `Tracelet Codex Progress` schedule is unchanged, with no duplicate, polling, publication, deployment or Claude launch.
