# Stage 08 independent integrated review — 2026-10-30

**Audit delivered; NO SHIP.** No new Critical/High defect found. Two reproduced Medium shutdown defects require Claude fixes in stage09; the full runtime overhead and target-host/release gates remain open. Completing this audit does not approve a release or its contracts.

Target: `tracelet/m07-integration@8659ca9dc59d001d649a03ccf972b20e774bf90e`, read-only. Tests ran in `.review08` inside m04, exported from that commit, with copied dependencies. Claude's m07 stayed clean. Owned storage repairs are committed separately as `c54635ae01857929995a27af484aa8b3f251ad18` on `tracelet/m04-storage-query`. Frozen revision6 retained; accepted stages04/05 and G0 deferral respected.

Roles: configured `tracelet_reviewer` (gpt-6.1-sol/high) independently examined the integration and reproduced M1/M2, then independently approved the storage diff and ran 21/21 scoped tests. Configured `tracelet_worker` (gpt-6.1-sol/medium) implemented the six-file storage repair and deterministic regressions. Parent verified integrated execution and screenshots. Parent model settings/effort/quota UNKNOWN; no setting change claimed.

## Ordered open findings

### M1 — profiler initial startup can publish a running sampler after shutdown

- Owner: Claude/PRO, stage09. Source at target: `packages/tracelet/src/profiling/profiler.service.ts:237`, `:249`, `:295`.
- Reproduce: build the review snapshot, then `node artifacts/08_shutdown_repros.cjs` from m04. Uses an injected synchronous InspectorSession, not fabricated production telemetry.
- Sequence: `const starting = profiler.start(); await profiler.stop(); await starting;`.
- Expected: stopped state; sampler disconnected; no later sampler/timer publication.
- Observed: `state:"running", disconnected:false`, calls enable/setSamplingInterval/start. Both reviewer and parent reproduced, exit0; a second explicit stop cleaned up.
- Cause: initial `startSampler()` publishes `this.sampler` after awaiting startup; stop saw no published sampler. Initial path lacks retry path's stopping guard.
- Minimal fix: coordinate initial-start ownership with stop; if stop wins, stop/disconnect the local sampler before publication and retain stopped state. Handle delayed success and failure without reviving stopped health.
- Acceptance: a deterministic deferred-start regression must assert final state stopped, disconnected session, no scheduled rotation or profile offer after shutdown; repeat existing profiler suites. Codex did not edit Claude profiler files.

### M2 — standalone listener can register after the application has shut down

- Owner: Claude/LEAD, stage09. Source: `packages/tracelet/src/tracelet.ts:98`, `:104`; `src/tracelet.module.ts:174`, `:243`.
- Reproduce: same diagnostic command. The isolated lifecycle-state seam sets active state without constructing Mongo, calls listen, runs both shutdown hooks before awaiting listen, then inspects the returned socket.
- Expected: late-starting listener closed/rejected; no listener survives application shutdown.
- Observed: `closing:true, state:"stopped", listening:true`. Both reviewer and parent reproduced, exit0. Diagnostic explicitly closed the server afterward. This is an isolated race proof, not a full Nest startup test.
- Cause: pre-await closing check becomes stale; `trackServer()` accepts registration after shutdown has closed/cleared the set.
- Minimal fix: recheck closing after listener startup, close/reject the late server; make late registration safe too.
- Acceptance: deterministic stop-during-listen regression plus full Nest app-close test verifies port closure, no leaked server, and deterministic rejection/result. No LEAD implementation edited.

### L3 — README sample test assumes LF-only input

- Owner: Claude/LEAD tests, stage09. `packages/tracelet/tests/unit/module/readme-sample.spec.ts:10`.
- Git archive under this machine's text conversion produced a CRLF README; the regex requires an LF immediately after the TypeScript fence. Test collection fails before its two tests. Isolated failure repeated. Accepted m07 working README has LF; copying its exact bytes into the snapshot makes 2/2 pass.
- This is a test portability issue, not an authorization failure. Normalize line endings while parsing or accept `\r?\n`; preserve sample behavior assertions. Retest both LF and CRLF. No root attributes/test source changed by Codex.

## Closed Codex findings from stage07

- **L1 shutdown accounting:** removed facade's competing deadline race. Writer's own bounded shutdown resolves after it counts all pending/queued losses; client close remains bounded. New regression forces the facade deadline to precede the writer's and verifies exact-once accounting/empty queue, including late write completion. Strict integrated dead-Mongo assertion now passes `lost === 600` and trace queue depth0; two-process, mid-run outage and ack parity pass. The inherited named todo is still visible in the isolated e2e file; LEAD should promote strict assertions permanently when consuming this repair.
- **L4 heartbeat recovery:** first heartbeat follows connect/index readiness; failed writes retry with full jitter capped8s; success restores30s cadence. Repeated starts cannot overlap; late completion cannot reschedule after stop. Successful persisted heartbeat records connected:true without mutating factory input. Fake-timer recovery/stop tests and actual integrated instance visibility pass.
- Worker mutation checks made the old shutdown race and old30s retry fail the new regressions. Reviewer independently ran 21/21 and approved; did not repeat mutations. Parent integrated patched unit649/649, typecheck/lint/build0 and strict e2e3/3 pass. See evidence file for baseline failures and exact variants.

## Ownership and inspected boundaries

CR-LEAD-001 acknowledged: preserve `createStorage().collections` for the same query/writer pool; LEAD test directories, config/writer alignment and six detached vendored license headers are accepted integration changes. The repair commit is based on m04 and includes this already-integrated accessor; retain one accessor when applying it to m07. No manifests, lockfiles, frozen contracts, Claude instrumentation/profiler/public setup files or business code changed.

Inspected default-deny auth, socket-derived loopback, dispatcher paths, query bounds/projections, CSP/CORS, static manifest validation, profiler sample semantics and attribution. No new auth bypass, traversal or source-map leak was found. Actual Express setup rejected unauthenticated HTML, JS and API with403; real traces from `trace()` persisted in mongod and rendered through the actual API/client. Browser network blocked external requests; none attempted. Static observation is not exhaustive security proof.

Upstream pin/source-map and packaged MIT attribution reviewed at `7500fba7f61f4d0e177e415b291ec6d4d366b052`; real pack/install tests passed4/4. LICENSE still says Tracelet contributors, pending the user-supplied real holder. No legal/host compatibility approval inferred.

## Visual and operational limits

Actual mounted UI screenshots captured at1440x900,1920x1080,390x844 (six files under `08_screenshots`). Parent inspected desktop waterfall and narrow execution list: compact dark table/sidebar layout, truthful wall-time semantics and mixed-schema warning; mobile table scrolls within its container. Real trace selection/reload passes all three widths, no browser console/page errors. Browser used installed Chromium1243 via explicit executablePath because Playwright's requested1194 was absent. Original missing-browser failure retained.

Current real mount test uses two real spans. Accepted stage05 5000-span/deep-flame/keyboard/failure-state browser evidence is retained, not relabeled as rerun live. Full keyboard-only live mount audit, live CPU flame selection, high-span live browser load, Linux/OpenShift, real RabbitMQ, Node20/24 reruns, target Nest floors/host compatibility and integrated runtime CPU/RSS/event-loop overhead remain NOT RUN here. The off/on microbenchmark excludes deferred mapping/Mongo/profiling and cannot close T20.

## Next owner and gate

Claude stage09: consume reviewed storage repair, fix M1/M2/L3, replace tolerant e2e expectations with strict assertions, run affected integrated checks, close full T20 and release/host/license gaps. Do not start Claude from Codex. Stage08 has delivered its independent findings and all T01–T24 dispositions; release remains not approved. Existing parent-verified Tracelet Codex Progress15-minute task reused unchanged for accepted stage09 fixes/review evidence. No scheduling mutation, waiting for prerequisite changes, publication or deployment.
