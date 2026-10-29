# CR-001 (DRAFT, not applied): profiler rotation keep-alive, and correcting the stall cause in plan section 7

Status: APPROVED by the orchestrator 2026-10-29 (reviewer: approve once amended; amendments applied in review round 2). Applies to the profiling owner (PRO) only; no contract change. Final confirmation rides on the whole-POC review.
Classification: **plan-only** (mechanism detail and explanatory text in plan section 7). No contract, schema, OpenAPI, fixture, cap or default changes.
Blocking: no. Only the profiling owner's files are touched; no parallel agent has to stop.

## Contract name/version and exact fields/routes changing

None. `ProfileItem`/`CpuProfile` v1, `profiling.maxStallMs` (250), `profiling.windowMs` (default 30 000, D7), T09/T10/T18 bounds: all unchanged.
Plan text changing: section 7 (sampler loop, H1 fix bullet, M8/R5 bullet), section 16 T09 note, section 18 claim row "Continuous profiling".

## Evidence demonstrating that the current plan text fails

The plan says `Profiler.stop` immediately followed by `Profiler.start` costs a start stall of "28-161 ms", which it attributes to "V8 logging existing code objects ... grows with code size". M02 measured this (host i5-7400, Windows 10, 12 000-function fixture, T09 load):

- T09 as implemented failed on Node 20.19.5 (3/5 windows contiguous, coverage 0.826) and Node 24.22.2 (0/4, coverage 0.812). Node 22.22.0 passed only narrowly (max gap 248 ms). The start stall was 158-396 ms, and it grew from window to window within a run.
- Root cause, from the V8 12.4.254.21 source:
  - `V8ProfilerAgentImpl::stopProfiling` calls `m_profiler->Dispose()` when `m_startedProfilesCount` reaches 0.
  - `startProfiling` then calls `CpuProfiler::New` again. Its `ProfilingScope` runs `LogCodeObjects` (`CombinedHeapObjectIterator` over the whole heap), `LogCompiledFunctions` (`HeapObjectIterator` plus a script/SFI walk) and `LogAccessorCallbacks` (`HeapObjectIterator`).
  - The stall is therefore about three full heap walks, so it is proportional to **live heap size** as well as code count. The within-run growth is the heap growing under the allocation-heavy loop.
- Raw `node:inspector` measurements of `Profiler.start` on Node 22, idle, 5 rotations each:

  | Code | Heap used | `Profiler.start` |
  |---|---|---|
  | 0 functions | 5 MB | 15-20 ms |
  | 12 000 functions | 17 MB | 70-82 ms |
  | 24 000 functions | 34 MB | 129-148 ms |
  | 0 functions | 347 MB | 657-669 ms |
  | 12 000 functions | 369 MB | 713-741 ms |
  | 12 000 functions | 1 047 MB | 2 011-2 049 ms |

- Consequence: at any `windowMs`, a production heap of a few hundred MB blocks the event loop for 0.7-2 s per rotation. It would also trip `maxStallMs` backoff permanently. Longer windows (D7 30 s) only dilute coverage; they do not bound the gap or the event-loop block.

## Change (implemented in the M02 worktree, uncommitted, pending this CR)

Bracket each rotation with a keep-alive profile. Just before `Profiler.stop`, open `node:inspector`'s V8 `console.profile('tracelet:rotation-keepalive')`; just after `Profiler.start`, call `console.profileEnd(...)`, in a `finally`. The agent's started-profile count stays above 0, so the CpuProfiler is never disposed and nothing is re-logged.

- The plan's mechanism stays as written: one persistent session, `Profiler.stop` immediately followed by `Profiler.start`, window data still from the `Profiler.stop` result, sample-based `gapBeforeMs`.
- The keep-alive is skipped if the inspector console is missing or `begin()` throws, and it is disabled after a throwing `end()`.
- It is only defaulted together with the default session.
- The initial start, `resume()` after backoff, and the final `stop()` are not bracketed.

Files: `src/profiling/vendor/cpu-sampler.ts`, `src/profiling/profiler.service.ts` (an optional `createKeepAlive` dependency), `tests/support/profiling/fake-session.ts`, `tests/unit/profiling/profiler-service.spec.ts` (+7 tests, plus the review-round files listed under "New tests"), `third_party/nestjs-observe/FORK_DELTA.profiling.md`.

Measured after the change (T09, unchanged test, 12 000 functions, 5 s windows, 99 Hz):

| Node | Contiguous | Max gap ms | Coverage | startStallMs p50/max | stopStallMs p50/max | Backoffs |
|---|---|---|---|---|---|---|
| 20.19.5 | 6/6 | 24.0 | 0.9977 | 0.18 / 0.30 | 1.35 / 1.63 | 0 |
| 22.22.0 | 6/6 | 7.4 | 0.9994 | 0.13 / 0.20 | 1.26 / 1.54 | 0 |
| 24.22.2 (4 runs) | 6/6 each | 7.6-33.2 | 0.9980-0.9990 | max 0.22-0.65 | max 1.57-1.82 | 0 |

With a 200 MB retained heap (raw scratch harness, Node 22), the keep-alive gives a max gap of 8 ms and coverage 0.9988. Plain stop/start in the same harness gives 869 ms and 0.870.

## Impacted owners and files

Owner: PRO only (`src/profiling/**`, `third_party/nestjs-observe/FORK_DELTA.profiling.md`, profiling tests, bench). No other owner's files change; INS, STO, DSH and LEAD are not impacted. Plan section 7/16/18 text changes are applied by the orchestrator after approval.

## Migration, defaults and backward compatibility

None. No stored data, schema field, config key or default changes. The keep-alive is an internal mechanism: default on for the real in-process inspector only, default off under `NODE_V8_COVERAGE` / `--cpu-prof`, off for injected sessions; `maxStallMs`, `windowMs` and all T09/T10/T18 bounds are unchanged.

## Why an adapter (or a threshold change) is not enough

Relaxing T09 to fit the stall would hide a heap-proportional event-loop block that would be unacceptable in production. A larger `windowMs` does not bound the per-rotation gap or block. The fix removes the cause.

## Side effects the orchestrator should accept explicitly

1. **Other inspector sessions with the Profiler enabled (review M1).** V8's console profile is broadcast to EVERY inspector session whose Profiler domain is enabled, not only Tracelet's. Reviewer measurements:
   - `NODE_V8_COVERAGE` (c8, `node --test --experimental-test-coverage`): Node prints `Cannot retrieve id from coverage profile response: {...keep-alive profile JSON with absolute file:// URLs...}` to stderr twice per rotation, and the stall returns (182-230 ms stop/begin).
   - `--cpu-prof`: the same stderr lines appear on every rotation.
   - A second in-process session with `Profiler.enable` (DevTools, a Jest v8 coverage provider, a second Tracelet instance in backoff): `begin()` costs 178 ms at 24 MB heap and 1.06-1.09 s at 589 MB; that time lands in `stopStallMs`, so a backoff reason that only names stop/start would mislead.
   Mitigation (implemented, this review round): the keep-alive is **not defaulted on** when `NODE_V8_COVERAGE` is set, when `--cpu-prof` or any `--cpu-prof-*` flag is in `process.execArgv` or in `NODE_OPTIONS` (`keepAliveDisabledReason()`), or with an injected session. A non-contract opt-out exists (`createKeepAlive: null`, internal/debug-only dependency; the frozen `profiling.*` config has no such field and was not changed). The keep-alive's own begin+end cost is recorded per window (`WindowRecord.keepAliveMs`, already included in stop/start stall) and, when it dominates a backoff, the reason says "another inspector session has the Profiler enabled". `ProfilerDebug.keepAlive` reports `active` / `off` / `failed`. Without the keep-alive the sampler is correct but pays the heap-proportional re-creation stall (see the 150 MB contrast below). A DevTools session attached by a developer still sees the keep-alive start/finish each window and pays its own re-creation; production impact none (`/observe` never attaches a debugger).
2. **Long-lived CpuProfiler: memory behaviour (corrected, review M4).** The profiler's code map now lives as long as sampling does (previously it was rebuilt every window).
   - The earlier statement "RSS plateaued at 154-162 MB under extreme churn" is **withdrawn as stated**: that plateau was measured with `global.gc()` forced every window and therefore does not describe natural-GC behaviour.
   - Without forced GC, in bracket (keep-alive) mode RSS grew from 206 to 1295 MB over 150 s in the investigator's harness; after a final full GC, bracket mode kept heapUsed 53 MB and non-heap 208 MB, against 28 MB and 105 MB for plain stop/start (the profiler, and its code map, stay alive). This is retained profiler state, **not a proven leak**.
   - Natural-GC soak run for this review (5 min each, run concurrently on the same host, Node 22.22.0, windowMs 1000, no forced GC during the run, rolling ~100 MB retained set, 20 `new Function` per tick; raw data `artifacts/02_soak_keepalive.json`, `artifacts/02_soak_plain.json`): keep-alive RSS 470.2 MB (30-90 s mean) to 473.2 MB (last 90 s), heapUsed 221.3 to 214.6 MB; plain stop/start RSS 428.9 to 455.1 MB, heapUsed 179.2 to 229.8 MB. After one forced full GC at the end: keep-alive heapUsed 68.4 MB, non-heap 362.4 MB, RSS 465.7 MB; plain heapUsed 66.8 MB, non-heap 349.1 MB, RSS 453.4 MB. Within 5 minutes there is no growth trend in keep-alive mode and the end-state difference is about 12-13 MB non-heap. Caveats: the two modes did different amounts of work (keep-alive 297 rotations, plain 180, because plain stalls ~630 ms p50 per rotation), 5 min cannot exclude slower growth, and the 150 s growth seen by the investigator under heavier churn is not contradicted. A longer soak under the real workload remains advisable before enabling profiling by default.
3. **User code calling `console.profileEnd()` with no title** inside the microsecond bracket would end the keep-alive early. That rotation then pays one re-log; nothing breaks. Conversely a host `console.profile('x')` without `profileEnd` keeps a profile open for the process lifetime in every session with the Profiler enabled, including Tracelet's (documented in the fork delta; README note in M06).
4. **Unbudgeted fresh-CpuProfiler costs (review L2).** The initial start and `resume()` after a backoff are not bracketed (no profile is alive to keep) and cost a heap-proportional re-log (about 1.1 s at 550 MB). They are recorded in the debug counters (`lastInitialStartMs`, `lastResumeMs`) but are not part of the per-window `maxStallMs` budget.

## Recommended D7 / threshold decisions

- `windowMs` default stays at 30 000 (D7 as resolved). 5 000 ms in T09 is now comfortably feasible: coverage is about 0.998, so the test does not need the product window.
- `maxStallMs` stays at 250. Measured rotation block (start + stop + fold) is about 2-5 ms on the 12k fixture, so 250 now trips only on pathological fold or stop cost. The backoff reason text is unchanged.
- T09 definition and bounds stay unchanged (5/6 windows with sample gap <= 250 ms, coverage >= 0.95). Do not tighten them in v1. Optionally record the observed numbers as informational.

## Plan text replacement (proposed)

- Section 7, H1 bullet: add "Each rotation is bracketed by a keep-alive console profile so V8 keeps the CpuProfiler (and its code map) across the rotation; without it, `Profiler.start` re-creates the CpuProfiler and re-logs all code with full heap walks (cost proportional to heap size, measured 70 ms at 17 MB and 2 s at 1 GB)."
- Section 7, M8/R5 bullet: replace "start measured 28-161 ms ... grows with code size" with "start is about 0.1-0.7 ms with the keep-alive. Without it, it is proportional to heap plus code size (M02 investigation)". Replace "latency spike of that size" with "about 2-5 ms per rotation on the 12k fixture".
- Section 18, "Continuous profiling" row: "each window boundary blocks the event loop for start + stop + fold, about 2-5 ms measured in M02 (keep-alive); without the keep-alive the start alone is heap-proportional".

## New tests and fixtures that prove the change

- Unit (FakeSession): rotation order `keepAlive.begin, Profiler.stop, Profiler.start, keepAlive.end`, with no bracket on the first start or the final stop. `end` runs on a failing stop and on a failing start. A throwing `begin` degrades to plain stop/start. A throwing `end` disables the keep-alive after one failure. There is no default keep-alive with an injected session. `createInspectorKeepAlive` works on the real inspector.
- Integration: T09/T10/T18 unchanged and green on 20.19.5, 22.22.0 and 24.22.2. Logs: `artifacts/02_t09_run.keepalive.node{20,22,24}.json`, `02_t10_run.keepalive.node{20,22,24}.json`. The failing pre-fix logs are kept as `02_t09_run.node{20,22,24}.json`.
- Regression (review M3): `tests/integration/profiling/keepalive-heap.int-spec.ts`: real sampler, about 150 MB retained heap, 3 rotations at windowMs 1200: with the keep-alive `startStallMs` max < 20 ms (asserted; measured 0.13-0.20 ms), and a variant with the keep-alive opted out that only records the stall (measured 275-290 ms at 150 MB on this host; `artifacts/02_keepalive_heap.json`, `02_keepalive_heap_optout.json`). Also: T09/T10 assert `debug.keepAlive === 'active'` and that no stored frame contains an absolute path, drive letter, backslash or the OS user name.
- Unit (review round): `keepAliveDisabledReason` (NODE_V8_COVERAGE, `--cpu-prof*` in execArgv and NODE_OPTIONS), default decision of a real-session sampler, `keepAlive` debug state `off`/`active`/`failed`, `keepAliveMs` and the backoff hint, onWindow-throws teardown, orderly-stop without error, retry budget restored after 10 healthy windows, negative-gap counter, initial-start/resume cost counters, frame path sanitisation (other drive, outside cwd, UNC, file URL, posix absolute, node_modules).
- No fixture or contract changes.
