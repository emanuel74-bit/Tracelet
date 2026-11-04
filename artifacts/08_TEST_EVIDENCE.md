# Stage08 executable evidence — 2026-10-30

Target `8659ca9dc59d001d649a03ccf972b20e774bf90e`; owned repair `c54635ae01857929995a27af484aa8b3f251ad18`. Windows, Node22.22.0, npm10.9.4. All commands below actually executed. No target-host compatibility claim. Copied installed dependencies, not a clean install/reproducible-lock proof.

## Isolation / reproduction

From m04, exported m07 target with `git -c safe.directory=D:/codeShit/Tracelet-wt/m07 -C D:/codeShit/Tracelet-wt/m07 archive --format=zip --output=D:/codeShit/Tracelet-wt/m04/.review08-source.zip 8659ca9`, expanded to `.review08`, copied root AND package-local node_modules with robocopy `/E /XJ /R:0 /W:0` (exit1 means files copied). Added snapshot-local tracelet junction for fixture child resolution; none points to Claude source. No installs/manifests changed. `.review08` and zip are untracked scratch, excluded from commits. m07 status remained clean at the same SHA.

Commands use package cwd `.review08/packages/tracelet` unless noted. Logs copied to m04/artifacts. Redirection logs preserve failures; PowerShell wraps some stderr as NativeCommandError even when diagnostic test cases intentionally log errors. Reported exits are process exits, not inferred from log text.

| Executed check | Result | Evidence |
|---|---|---|
| Initial workspace typecheck, before package-local deps copied | FAILED missing ajv/dist/2020 | Setup failure, recovered by copying existing package-local deps; not a product type error |
| `npm run typecheck`, `npm run lint`, `npm run build` baseline | PASS each exit0 | 08_BASELINE_TYPECHECK/LINT/BUILD.txt |
| `node ../../node_modules/vitest/vitest.mjs run --config vitest.config.mts --maxWorkers=1` sandbox | NOT RUN, startup exit1: SWC native cache ownership | 08_BASELINE_UNIT.txt; rerun with narrowly approved normal-user cache access |
| Same baseline unit command with native cache access | FAIL exit1:43 files pass,2 fail;640 tests pass,1 fails; README suite fails collection | 08_BASELINE_UNIT_ELEVATED.txt; module default5s timeout and CRLF README parser |
| Isolated `tests/unit/module/module.spec.ts tests/unit/module/readme-sample.spec.ts` | module5/5 pass; README collection still fails; exit1 | 08_UNIT_ISOLATED.txt; isolated pass does not prove timeout cause |
| Exact accepted working README LF bytes copied to snapshot; isolated readme test | PASS2/2, exit0 | 08_README_LF_RETEST.txt; no parser/threshold change |
| `node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts tests/integration tests/contract --maxWorkers=1` baseline | PASS exit0,36 files pass+1 skipped;220 tests pass+1 skipped | 08_BASELINE_INTEGRATION.txt; skipped is opt-in storage test, separately run below |
| `node tests/support/e2e/with-mongo.mjs` initial | FAIL exit1 overall; actual storage1/1 and pack/install4/4 pass, two child cases fail before ready (missing snapshot package link), outage skip and strict todo | 08_BASELINE_MONGO.txt; retained; not claimed full green |
| After local package link: `TRACELET_E2E_MONGO=memory node ../../node_modules/vitest/vitest.mjs run --config vitest.e2e.config.mts tests/e2e/two-instances.e2e-spec.ts` | PASS exit0,3 pass+1 inherited todo | 08_BASELINE_E2E_RERUN.txt; real mongod, two OS processes, mid-run outage, dead boot ack parity |
| Worker and independent reviewer scoped storage: `node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/support/storage/vitest.config.mts --maxWorkers=1` in m04 | PASS21/21 each; reviewer exit0,3files | Review recorded in 08_INDEPENDENT_REVIEW.md; worker typecheck/scopedlint0; two worker mutation controls fail originals as expected |
| Copy six repaired files to snapshot; `npm run build`, `npm run typecheck`, `npm run lint` | PASS each exit0 | 08_PATCH_BUILD/TYPECHECK/LINT.txt |
| Patched integrated unit command as above, exact accepted README LF bytes | PASS649/649,45files, exit0 | 08_PATCH_UNIT.txt; original full run failure retained |
| Patched two-instances e2e as above, with stricter diagnostic assertions | PASS3+1 inherited todo, exit0 | 08_PATCH_STRICT_E2E.txt; changed lower bound to lost===600 and depth<=50 to depth===0; exact diagnostic source08_two-instances_strict.e2e-spec.ts (copy back under snapshot tests/e2e to reproduce) |
| UI cwd `npm run typecheck`, `npm run lint`, `npm run test -- --maxWorkers=1` | PASS0/0/13 tests,2files | Parent terminal execution; unchanged committed UI source, existing assets served |
| `node artifacts/08_shutdown_repros.cjs` m04 | exit0; both defects reproduced; explicit cleanup | 08_SHUTDOWN_REPRO_OUTPUT.txt; no real profiler/Mongo in these isolated seams |
| Live diagnostic first run, m04 `node artifacts/08_live_review.cjs` | HTTP403, actual TTL and schema checks pass; browser NOT RUN, requested Chromium1194 missing, exit1 | 08_LIVE_OUTPUT.txt |
| `$env:TRACELET_REVIEW_CHROMIUM='C:\Users\User\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'; node artifacts/08_live_review.cjs` baseline | PASS exit0; all3 actual viewport navigation/reloads;6 screenshots; no errors/external requests | 08_LIVE_RERUN_OUTPUT.txt,08_LIVE_RESULT.json,08_screenshots/*; actual Nest setup, mongod, trace(), no API mocks |
| `node ../../node_modules/vitest/vitest.mjs run --config vitest.int.config.mts bench/instrumentation/overhead.int-spec.ts --maxWorkers=1` patched | PASS1/1, exit0 | 08_OVERHEAD_SEED.txt,08_OVERHEAD_SEED_RESULT.json |
| `git diff --check` and exact manifest/contract diff checks | PASS exit0; no manifest/lock/contract differences | m04 terminal; only owned source/tests and review artifacts committed |

Native SWC tests and disposable mongod/browser checks used narrowly authorized elevated execution because sandbox cache permissions blocked native startup. No ACLs or dependency versions changed. No auto-review rejection; first Git commit attempt hit sandbox index.lock access denial, exact six-file elevated commit then succeeded.

## T01–T24 disposition

PASS denotes executed proof in the stated fixture scope, not blanket release/host approval. EVIDENCE denotes accepted prior evidence plus stated current checks. Partial limits are explicit.

| Gate | Status / scope | Evidence |
|---|---|---|
| T01 direct root | PASS | current full integration poc/t01; live trace persisted/rendered |
| T02 concurrency | PASS25 callbacks | current poc/t02 and stale-context tests;100 concurrency NOT RUN |
| T03 nested sync/async | PASS | current poc/t03; live nested real span |
| T04 Promise.all/self time | PASS | current poc/t04 |
| T05 throw/ack parity | PASS | current poc/t05, real process dead/outage checks |
| T06 hostile provider/circular/getter | PASS supported cases | current edge/hostile-provider integration; documented unsupported limits retained |
| T07 scopes | PASS fixture scope | current edge-providers/request-scoping tests; real target host NOT RUN |
| T08 Observable/AsyncIterable | PASS semantics preservation with documented return-time span limit | current edge-provider tests, accepted03 limits; no completion-lifetime claim |
| T09 real V8 CPU stacks | PASS | full integration t09;08_T09_PROFILE_RESULT.json:7windows,6/6 gaps<=8.14ms,coverage0.99887 |
| T10 real idle sampler | PASS | t10;08_T10_PROFILE_RESULT.json:7windows,6/6 gaps<=11.91ms,coverage0.99882 |
| T11 disconnect/reconnect | PASS tested fail-open/outage/drop cases; retry recovery unit-tested | actual process outage/dead boot; strict patched accounting; owned fake-timer retry; long restored-Mongo recovery soak NOT RUN |
| T12 replicas | PASS two actual processes | baseline and patched real-Mongo e2e, plus two-pool storage test |
| T13 retention | PASS | actual seven single-field TTL indexes, BSON dates and IXSCAN check; live diagnostic actual expiry removed by TTL monitor (1s test-server interval) |
| T14 exclusions | PASS | current no-self-trace integration1000 hits, both adapters, open/stale ALS cases |
| T15 unauthorized | PASS tested cases | Express/Fastify auth suites; live actual HTML/JS/API403, CSP/CORS suites |
| T16 secrets | PASS tested sanitizer/projection cases | redaction integration, query unit suite; no broader PII compliance claim |
| T17 shutdown/restart | FAIL lifecycle races M1/M2; storage L1 CLOSED | deterministic repros; strict patched dead-Mongo and existing open-span shutdown tests pass |
| T18 disabled/unavailable profile | PASS server/semantics tests; EVIDENCE UI states | integration t18 and UI unit13; accepted05 browser empty/error evidence; live flame interaction NOT RUN |
| T19 package consumer | PASS4/4 | real tarball CJS/ESM/import/notice tests in08_BASELINE_MONGO.txt; no publication |
| T20 overhead | EVIDENCE PARTIAL; full gate NOT RUN | new latency microbenchmark below; realistic full CPU/RSS/event-loop/throughput A/B remains Claude09 |
| T21 UI search/paging/filter | PASS query/API regressions; live trace/reload; EVIDENCE prior browser8 | patched unit649 includes query42; real mounted browser all3 widths; full mocked browser8 not rerun |
| T22 5000 spans/deep flame | PASS current backend/span budget/unit checks; EVIDENCE prior05 browser stress | current full integration span-budgets + UI unit13; actual live5000-span browser NOT RUN |
| T23 storage/query failures | PASS tested cases | current failure-injection/query/storage/lifecycle tests; default-deny safe errors and drop diagnostics |
| T24 mixed schemas | PASS current reader policy | real inserted schema2 row skipped, header1, v1 retained; forward v2 reader/writer migration not implemented or claimed |

Off/on microbenchmark:20,000 measurements per mode after2,000 warmup; message root plus3 provider calls. Message p50/p95 microseconds: off0.6/1.3, installed-but-untraced5.7/8.3, traced63.3/79.9. Provider-call p50/p95:0.3/0.4,2.0/2.8,14.0/18.0. Deferred completion mapping, Mongo, profiler, realistic business work and full runtime CPU/RSS are outside this measurement. No universal overhead claim or release threshold inferred.

## Remaining release evidence

T20 full workload, M1/M2 fixes/retests, LF/CRLF test portability, real host G0, Linux/OpenShift, real RabbitMQ, Node20/24 reruns on this integrated patch, live CPU-flame/high-span/keyboard-only full browser flows and real LICENSE holder remain with Claude09/user where applicable. Existing scheduler remains unchanged. Fixture servers/mongod/browser and repro listeners closed in finally; test commands completed. No deployment or publication.
