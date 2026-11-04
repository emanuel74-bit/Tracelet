// Stage08 diagnostic fixture: real Nest mount, real disposable mongod, real trace().
// Run after building .review08/packages/tracelet: node artifacts/08_live_review.cjs
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(__dirname, '../.review08');
const req = createRequire(resolve(root, 'packages/tracelet/package.json'));
req('reflect-metadata');
const { Module } = req('@nestjs/common');
const { NestFactory } = req('@nestjs/core');
const { MongoMemoryServer } = req('mongodb-memory-server');
const { MongoClient } = req('mongodb');
const { chromium } = req('@playwright/test');
const pkg = req('./dist/index.js');
const { TraceletLifecycle } = req('./dist/tracelet.module.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw Error('condition timed out');
}
(async () => {
  let mongod, dbClient, app, browser;
  const result = { source: process.env.TRACELET_REVIEW_SOURCE || '8659ca9', node: process.version, requests: [], consoleErrors: [], externalRequests: [] };
  try {
    process.env.NODE_ENV = 'test';
    mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
    dbClient = await new MongoClient(mongod.getUri()).connect();
    result.mongo = (await dbClient.db('admin').command({ buildInfo: 1 })).version;
    const dbName = 'tracelet_review08_' + process.pid;
    const db = dbClient.db(dbName);
    class ReviewModule {}
    Module({ imports: [pkg.TraceletModule.forRoot({ enabled: true, serviceName: 'review-worker', storage: { uri: mongod.getUri(), database: dbName }, tracing: { sampleRate: 1 }, profiling: { enabled: false } })] })(ReviewModule);
    app = await NestFactory.create(ReviewModule, { logger: false });
    pkg.Tracelet.setup(app, { path: '/observe', allowLoopbackWithoutAuth: false, authorize: r => r.headers['x-review-auth'] === 'stage08' });
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const life = app.get(TraceletLifecycle);
    const from = new Date(Date.now() - 60000).toISOString();
    await pkg.trace('Stage08.realCallback', () => pkg.trace('Stage08.nested', async () => { await sleep(10); return 42; }), { kind: 'rabbitmq' });
    await life.storage.flush();
    await until(async () => (await db.collection('tracelet_traces').countDocuments()) === 1);
    const realTrace = await db.collection('tracelet_traces').findOne();
    result.traceId = realTrace.traceId;
    const headers = { 'x-review-auth': 'stage08' };
    const manifest = req('./assets/dashboard/asset-manifest.json');
    const jsAsset = Object.keys(manifest.files).find(p => p.endsWith('.js'));
    for (const path of ['/observe/', '/observe/api/v1/traces', '/observe/' + jsAsset]) {
      const response = await fetch(origin + path); assert.equal(response.status, 403); result.requests.push({ path, unauthenticated: response.status });
    }
    const traces = await (await fetch(origin + '/observe/api/v1/traces?from=' + encodeURIComponent(from), { headers })).json();
    assert.equal(traces.items[0].traceId, result.traceId);
    const foreign = { ...realTrace, _id: 'newer-schema-08', schemaVersion: 2, traceId: 'newer-schema-08' };
    await db.collection('tracelet_traces').insertOne(foreign);
    const mixed = await fetch(origin + '/observe/api/v1/traces?from=' + encodeURIComponent(from), { headers });
    assert.equal(mixed.headers.get('x-tracelet-skipped'), '1'); assert.equal((await mixed.json()).items.length, 1);
    result.mixedSchema = 'PASS: newer schema omitted and X-Tracelet-Skipped=1';
    // Exercise actual TTL monitor, with a one-second interval only on this disposable test server.
    await dbClient.db('admin').command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
    await db.collection('tracelet_traces').insertOne({ ...realTrace, _id: 'expired-08', traceId: 'expired-08', expireAt: new Date(Date.now() - 60000) });
    await until(async () => (await db.collection('tracelet_traces').countDocuments({ _id: 'expired-08' })) === 0, 15000);
    result.ttl = 'PASS: indexed expired BSON Date record removed by real TTL monitor';
    browser = await chromium.launch({ headless: true, ...(process.env.TRACELET_REVIEW_CHROMIUM ? { executablePath: process.env.TRACELET_REVIEW_CHROMIUM } : {}) });
    result.chromium = browser.version();
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
    page.on('pageerror', e => result.consoleErrors.push(e.message));
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(origin)) { result.externalRequests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    mkdirSync(resolve(__dirname, '08_screenshots'), { recursive: true });
    for (const [width, height] of [[1440, 900], [1920, 1080], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(origin + '/observe/?view=traces&from=' + encodeURIComponent(from));
      await page.getByRole('button', { name: 'Stage08.realCallback', exact: true }).waitFor();
      await page.screenshot({ path: resolve(__dirname, `08_screenshots/live-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Stage08.realCallback', exact: true }).click();
      await page.getByRole('heading', { name: 'Execution waterfall' }).waitFor();
      await page.screenshot({ path: resolve(__dirname, `08_screenshots/waterfall-${width}.png`), fullPage: true });
      await page.reload();
      await page.getByRole('heading', { name: 'Execution waterfall' }).waitFor();
      result.requests.push({ viewport: `${width}x${height}`, realTraceAndWaterfallReload: 'PASS' });
    }
    assert.deepEqual(result.externalRequests, []);
    assert.deepEqual(result.consoleErrors, []);
    result.browser = 'PASS: real authenticated Tracelet.setup mount; no API interception or response fixtures';
    console.log(JSON.stringify(result, null, 2));
  } finally {
    writeFileSync(resolve(__dirname, '08_LIVE_RESULT.json'), JSON.stringify(result, null, 2));
    await browser?.close(); await app?.close(); await dbClient?.close(); await mongod?.stop();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
