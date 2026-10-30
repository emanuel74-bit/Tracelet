// Isolated diagnostic seams; no actual V8 sampling or Mongo server required.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const req = createRequire(resolve(__dirname, '../.review08/packages/tracelet/package.json'));
req('reflect-metadata');
const assert = require('node:assert/strict');
const { ContinuousProfiler } = req('./dist/profiling/profiler.service.js');
const { TraceletLifecycle } = req('./dist/tracelet.module.js');
const { Tracelet } = req('./dist/tracelet.js');
(async () => {
  const session = {
    disconnected: false, calls: [], connect() {},
    disconnect() { this.disconnected = true; },
    post(method, params, callback) {
      this.calls.push(method);
      if (typeof params === 'function') callback = params;
      callback(null, method === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 } } : {});
    },
  };
  const profiler = new ContinuousProfiler({ enabled: true }, {
    queue: { offer: () => true, increment() {} }, serviceName: 'review', instanceId: 'review-instance',
    probe: () => ({ available: true }), createSession: () => session, createKeepAlive: null,
  });
  try {
    const starting = profiler.start(); await profiler.stop(); await starting;
    const observed = { state: profiler.profilerHealth().state, disconnected: session.disconnected, calls: session.calls.slice() };
    console.log('M1 profiler stop during initial start:', JSON.stringify(observed));
    assert.equal(observed.state, 'running'); assert.equal(observed.disconnected, false);
  } finally { await profiler.stop(); }
  const lifecycle = new TraceletLifecycle({ enabled: true, serviceName: 'review', storage: { uri: 'mongodb://127.0.0.1:1' } }, { env: { NODE_ENV: 'test' } });
  // Isolated active-state seam: intentionally avoid creating storage or instrumentation.
  lifecycle._state = 'active';
  let server;
  try {
    const listening = Tracelet.listen({ port: 0, authorize: () => true }, { get: () => lifecycle });
    await lifecycle.beforeApplicationShutdown(); await lifecycle.onApplicationShutdown();
    server = await listening;
    const observed = { closing: lifecycle.closing, state: lifecycle.state, listening: server.server.listening };
    console.log('M2 listener startup during shutdown:', JSON.stringify(observed));
    assert.equal(observed.closing, true); assert.equal(observed.state, 'stopped'); assert.equal(observed.listening, true);
  } finally { await server?.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
