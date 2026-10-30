# CR-002 (APPROVED option A, applied): Node 20 on Windows, V8 sampler thread busy-waits a core; gate the profiler, fix the A/B bench

Status: APPROVED (option A) by the orchestrator, applied in this tree. Drafted by tracelet-investigator 2026-10-29; implemented by tracelet-implementer (gate in ContinuousProfiler.start(), tests, bench fix).
Classification: **behaviour/default change** (option A or B below) plus a **bench method change**. No schema, OpenAPI, fixture or cap change. `ProfilerHealth.state`/`reason` are reused as they are.
Blocking: no. Profiling is off by default (D4). The warn-only part (section "Already applied") needs no contract change.

## Root cause (source-pinned)

`deps/v8/src/profiler/cpu-profiler.cc`, `SamplingEventsProcessor::Run`, as shipped in Node **v20.19.5** (V8 11.3.244.8):

```cpp
#if V8_OS_WIN
      if (use_precise_sampling_ &&
          nextSampleTime - now < base::TimeDelta::FromMilliseconds(100)) {
        // Do not use Sleep on Windows as it is very imprecise, with up to 16ms
        // jitter, which is unacceptable for short profile intervals.
        while (base::TimeTicks::Now() < nextSampleTime) {
        }
      } else
#endif
      { ... running_cond_.WaitFor(&running_mutex_, nextSampleTime - now) ... }
```

- `use_precise_sampling_` defaults to `true` (`cpu-profiler.h`). The inspector agent (`v8-profiler-agent-impl.cc`: `CpuProfiler::New(m_isolate)` + `SetSamplingInterval`) never calls `SetUsePreciseSampling(false)`, and the protocol has no way to do so. The V8 API doc for it says: "Disabling this can greatly reduce CPU usage".
- Result: on Windows, at any sampling interval under about 100 ms (10 Hz or more), the sampler thread spins between samples for the whole time a profile is running, whatever the application does.
- In Node **v21.0.0**, **v22.22.0** and **v24.22.2**, the same branch first tries `precise_sleep_timer_.Sleep(...)`. That is a `CreateWaitableTimerExW(..., CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, ...)` timer (`platform-win32.cc`, `PreciseSleepTimer::TryInit`). It falls back to the spin only when that timer cannot be created, which is the case before Windows 10 1803 (build 17134, e.g. Server 2016 = 14393).
- Node's `v20.x` branch head still has no `precise_sleep_timer_` (checked 2026-10-29), so every Node 20 release is affected on Windows.
- Linux and macOS take the `#else` path (condition-variable wait) on every version, so **Node 20 on Linux is not affected by this mechanism**. This was not measured: no Linux host or Docker daemon was available.
- History: the less-than-100 ms busy-wait is the result of V8 issue 7535 (Node PR #19333 backport), whose author already called the busy loop a blocker for production profiling on Windows.

## Measurements (raw `node:inspector`, no Tracelet; Windows 10 19045, i5-7400 4C/4T)

The host was saturated by a concurrent test run (CPU load 100 %), so absolute fractions are lower than on an idle host. The implementer's bench on a quieter host measured 0.98 core. Per-thread numbers come from `QueryThreadCycleTime` (TSC-based, not tick-sampled). The calibration was one spinning JS main thread under the same load: 1.78 Gcyc/s, 0.64 tick-CPU.

| Runtime | Configuration (app idle) | Hottest thread, Gcyc/s | process.cpuUsage user (core fraction) |
|---|---|---|---|
| 20.19.5 | off | 0 | 0.000 |
| 20.19.5 | Profiler.start, 99 Hz, no rotation | **1.64** (a single non-main thread) | 0.49-0.57 |
| 20.19.5 | 49 Hz / 19 Hz / 11 Hz | 1.11 / 1.64 / (spinning; cpuUsage 0.555) | 0.39 / 0.63 / 0.555 |
| 20.19.5 | **9 Hz / 5 Hz** | **0.001 / 0** | **0.000 / 0.000** |
| 20.19.5 | 99 Hz + 2 s rotation + keep-alive | 0.55 (contended) | 0.19 |
| 20.19.5 | 9 Hz + 2 s rotation + keep-alive | 0.001 | 0.001 |
| 22.22.0 | 99 Hz, with or without rotation + keep-alive | 0.003-0.004 | 0.000-0.001 |
| 24.22.2 | 99 Hz + rotation + keep-alive | 0.005 | 0.000 |

Conclusions:

- The burn is the V8 sampling thread spinning. It is the same with no rotation and no keep-alive. It disappears at 9 Hz or less (interval at least 111 ms, the condition-variable path), which matches the 100 ms threshold in the source.
- **Neither the CR-001 keep-alive nor the rotation causes it.** Without the keep-alive, the processor thread is re-created on each rotation, so the per-thread snapshot misses it, but `cpuUsage` still shows it.
- The cost does not depend on the application's load. It lasts for as long as a profile is open, which with continuous profiling means always.
- The Node 20 `codeheavy-cpu` throughput cost of -12 % plus or minus 8.8 is consistent with one core taken by the spinner on a 4-core host (less turbo headroom, more scheduler contention with the main thread and the vitest workers). That attribution was not isolated separately.

## Already applied (warn-only, no contract change, in this worktree)

- `src/profiling/vendor/cpu-sampler.ts`:
  - `samplingIntervalUs(hz)` (the existing formula, extracted).
  - `samplerBusyWaitReason(hz, platform?, v8Version?, osRelease?)`. It is pure and never throws. It returns a reason on `win32` when the interval is under 110 ms and either V8 is older than 11.8, or V8 is 11.8 or newer but the Windows build is older than 17134.
- `src/profiling/profiler.service.ts`: after a successful sampler start, one `diag.warn('sampler-busy-wait', ...)`, rate-limited per key. State, reason, health and config are unchanged.
- Test: `tests/unit/profiling/sampler-busy-wait.spec.ts` (7 tests).

## Proposed change (choose one; NOT applied)

- **A (recommended): truthful refusal, existing fields only.** In `ContinuousProfiler.start()`, after the probe, if `samplerBusyWaitReason(sampleRateHz)` is defined:
  - set `state = 'unavailable'`;
  - set `reason = '<that text>'`;
  - open no session.

  An operator who accepts low resolution sets `profiling.sampleRateHz` to 9 or less and gets a working profiler with no spin. No new config key is needed. This changes behaviour only for `enabled: true` on Windows with Node 20 (EOL 2026-04-30), or on Windows builds older than 17134.
- **B: automatic clamp.** Use an effective rate of 9 Hz on affected runtimes, and report the effective `sampleRateHz` in health together with a non-error note. This is cheaper for the user, but the configured rate is silently overridden, and 9 Hz gives about 270 samples per 30 s window.
- **C: document only** (keep the applied warning). Put a README caveat next to the existing Node 20 note.
- Independent of A/B/C: consider raising `engines.node` to `>=22`, since Node 20 is EOL. That is a support-matrix contract change and would also drop Node 20 from the T09/T10 matrix.

Tests for A:

- the existing `sampler-busy-wait.spec.ts` simulated Node 20 case flips to `state === 'unavailable'`, with no session created (the `createSession` spy is not called) and no timer;
- at 9 Hz on the simulated runtime, the state is `running`;
- on the real Node 20.19.5 + Windows host, T09/T10 must then run with `sampleRateHz: 9` or be skipped with the reason. T09/T10 thresholds are not weakened: the T09/T10 gaps are bounded by the sampling interval, so a 9 Hz run needs its own documented bound, which needs a review.

## A/B bench: the "on is faster" artefact on Windows (applies to `bench/profiling/ab-overhead.int-spec.ts`; owner: bench author)

Confirmed with raw scripts. On all three Node versions, a running sampler makes the main thread's timer waits much finer:

- **Node 22**, mean actual `setTimeout(10)`: off 22-47 ms, on 10.7-10.9 ms (6 of 7 runs).
- **Node 20.19.5**, mean actual `setTimeout(10)`: off 22-42 ms, on 14-15 ms (all 4 runs).
- **Node 20.19.5 at 5 Hz** (no spin): no gain, 18-33 ms. The effect scales with the sample rate. Node 20 has no high-resolution timer, so the likely mechanism is the 99 Hz `SuspendThread`/`ResumeThread` of the main thread (`libsampler/sampler.cc`), which re-checks its timed wait at each sample. Node 22/24 also run a high-resolution waitable timer.
- **No in-process control:** an unref'd `setInterval(() => {}, 1)` in the "off" arm did not change anything (24-41 ms), so holding a 1 ms JS timer does not equalise the arms.

Consequence: wall-clock throughput and event-loop-delay deltas of timer-paced scenarios (`*-idle`, `nest-*`) on Windows are invalid as overhead measures. They measure timer granularity, not profiler cost.

Bench fix:

1. Report profiler cost as CPU time per unit of work (`process.cpuUsage` delta divided by work units). Prefer per-thread cycle time on Windows (PowerShell `QueryThreadCycleTime`) and `/proc/self/task/*/stat` on Linux. Do not use wall throughput for timer-paced scenarios.
2. Drive throughput scenarios with `setImmediate`/IO-paced load, not `setTimeout(1..100)`.
3. Mark the timer-paced rows and event-loop-delay deltas as "not valid on win32" in the JSON, and re-run them on Linux.
4. Record host load; this investigation saw `LoadPercentage` 100 from a concurrent run.
5. Add idle-CPU as a first-class gate per Node version and platform. It would have caught Node 20 directly.
