/**
 * Test-only simulation of an affected runtime (CR-002): with TRACELET_SIMULATE_NODE20_WIN=1 this makes process.versions.v8 look
 * like Node 20's V8 11.3. Combined with a real win32 host, samplerBusyWaitReason() then returns its reason, so every gated test
 * skips and the profiler reports 'unavailable'. It is imported for its side effect by tests/support/profiling/runtime-gate.ts
 * (which every real-sampler test must import, see tests/unit/profiling/real-sampler-gate-guard.spec.ts), so no setup-file
 * change in the scaffold vitest configs is needed:
 *
 *   TRACELET_SIMULATE_NODE20_WIN=1 npx vitest run --config vitest.int.config.mts
 *
 * Only meaningful on win32 (the gate is platform specific); on other platforms it changes nothing observable.
 */
if (process.env.TRACELET_SIMULATE_NODE20_WIN === '1') {
  Object.defineProperty(process, 'versions', {
    value: { ...process.versions, v8: '11.3.244.8-node.33' },
    configurable: true,
  });
}

export {};
