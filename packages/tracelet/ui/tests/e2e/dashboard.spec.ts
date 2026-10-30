import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { detail, errors, from, graph, health, instances, methods, overview, profile, services, to, trace } from './fixtures';
type MockOptions = { empty?: boolean; forbidden?: boolean; unavailable?: boolean; skipped?: number; large?: boolean; gate?: Promise<void>; delayed?: boolean; largeFlame?: boolean };
async function mockApi(page: Page, options: MockOptions = {}) {
  const requests: URL[] = []; requestLogs.set(page, requests);
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    const path = url.pathname.split('/api/v1')[1];
    if (options.gate && path === '/traces') await options.gate;
    if (options.delayed && path === '/traces') await new Promise(resolve => setTimeout(resolve, 350));
    if (options.forbidden || options.unavailable) {
      await route.fulfill({ status: options.forbidden ? 403 : 503, json: { error: { code: options.forbidden ? 'FORBIDDEN' : 'STORAGE_UNAVAILABLE', message: 'Unsafe backend details must not be displayed' } } }); return;
    }
    let value: unknown;
    if (path === '/services') value = services;
    else if (path === '/instances') value = instances;
    else if (path === '/health') value = health;
    else if (path === '/overview') value = options.empty ? { ...overview, series: [], slowestOperations: [], totals: { ...overview.totals, executions: 0, errors: 0, errorRate: 0 } } : overview;
    else if (path === '/methods') value = options.empty ? { ...methods, items: [] } : methods;
    else if (path === '/traces') {
      const later = Boolean(url.searchParams.get('cursor'));
      const row = later ? { ...trace, traceId: trace.traceId.slice(0, -1) + '2', operation: 'NextPage.handle' } : trace;
      value = { items: options.empty ? [] : [{ ...row, ...(url.searchParams.get('status') === 'error' ? { status: 'error', errorCount: 1 } : {}) }], nextCursor: options.empty || later ? null : 'opaque-page-two' };
    } else if (path.startsWith('/traces/')) {
      value = options.large ? { trace: { ...trace, spanCount: 5000 }, spans: [detail.spans[0], ...Array.from({ length: 4999 }, (_, i) => ({ spanId: 'span-' + String(i + 2).padStart(5, '0'), traceId: trace.traceId, parentSpanId: detail.spans[0].spanId, operation: 'BatchService.item' + String(i + 1).padStart(4, '0'), startOffsetMs: i / 10, durationMs: 0.1, status: 'ok' }))] } : detail;
    } else if (path === '/profiles') value = { items: options.empty ? [] : [profile], nextCursor: null };
    else if (path === '/flamegraph' || path.endsWith('/flamegraph')) value = options.largeFlame ? { ...graph, sampleCount: 5000, droppedSampleCount: 0, stacks: Array.from({ length: 5000 }, (_, i) => ({ stack: 'sharedCpuRoot;' + Array.from({ length: 127 }, (_, depth) => 'Frame' + i + '_' + depth).join(';'), samples: 1 })) } : options.empty ? { ...graph, stacks: [], sampleCount: 0, profileCount: 0, droppedSampleCount: 0 } : graph;
    else if (path === '/errors') value = options.empty ? { ...errors, items: [] } : errors;
    else throw new Error('Unexpected API route: ' + path);
    await route.fulfill({ status: 200, json: value, headers: { 'X-Tracelet-Skipped': String(options.skipped ?? 0) } });
  });
  return requests;
}
const requestLogs = new WeakMap<Page, URL[]>();
const cspErrors = new WeakMap<Page, string[]>();
test.beforeAll(async () => { await mkdir('tests/screenshots', { recursive: true }); });
test.beforeEach(async ({ page }) => {
  const messages: string[] = []; cspErrors.set(page, messages);
  page.on('console', message => { if (/Content Security Policy|violates.*style-src|Refused to apply.*style/i.test(message.text())) messages.push(message.text()); });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await info.attach('api-request-urls', { body: JSON.stringify((requestLogs.get(page) ?? []).map(url => url.toString()), null, 2), contentType: 'application/json' });
  expect(cspErrors.get(page) ?? []).toEqual([]);
});
const query = '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Dashboard pages' }).getByRole('button', { name, exact: true });
test('filters, cursor pages, deep links, keyboard trace inspection and reload use the real client', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(query + '&view=traces');
  await expect(page.getByRole('heading', { name: 'Executions', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Service', exact: true }).selectOption('event-worker');
  await page.getByRole('combobox', { name: 'Instance', exact: true }).selectOption('pod-a');
  await page.getByRole('combobox', { name: 'Execution status' }).selectOption('error');
  await expect.poll(() => calls.some(url => url.pathname.endsWith('/traces') && url.searchParams.get('service') === 'event-worker' && url.searchParams.get('instanceId') === 'pod-a' && url.searchParams.get('status') === 'error')).toBe(true);
  await page.getByRole('combobox', { name: 'Execution status' }).selectOption('');
  await page.getByRole('textbox').fill('MessageConsumer'); await page.getByRole('button', { name: 'Apply search' }).click();
  await expect(page).toHaveURL(/search=MessageConsumer/);
  await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Page 2 \u00b7 current filtered window')).toBeVisible();
  await expect(page.getByRole('button', { name: 'NextPage.handle', exact: true })).toBeVisible();
  await expect.poll(() => calls.some(url => url.searchParams.get('cursor') === 'opaque-page-two' && url.searchParams.get('search') === 'MessageConsumer')).toBe(true);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.getByRole('button', { name: 'MessageConsumer.handle', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Execution waterfall' })).toBeVisible();
  await expect(page).toHaveURL(/id=/);
  await expect(page.getByText('\u00d75 collapsed calls', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^TransformService\.execute/ }).click();
  await expect(page.locator('.inspector')).toContainText('Collapsed calls');
  await expect(page.locator('.inspector')).toContainText('does not represent one continuous interval');
  const child = page.getByRole('button', { name: 'MappingEngine.apply', exact: true });
  await child.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.inspector h3')).toHaveText('MappingEngine.apply');
  await page.getByRole('slider', { name: 'Waterfall zoom' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider', { name: 'Waterfall zoom' })).toHaveValue('2');
  await page.getByRole('slider', { name: 'Waterfall offset' }).focus(); await page.keyboard.press('End');
  await expect(page.getByRole('slider', { name: 'Waterfall offset' })).not.toHaveValue('0');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Collapse MessageConsumer.handle', exact: true }).click();
  await expect(child).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand MessageConsumer.handle', exact: true }).click();
  await expect(child).toBeVisible();
  await page.screenshot({ path: 'tests/screenshots/trace-1440.png', fullPage: true });
  await page.reload(); await expect(page.getByRole('heading', { name: 'Execution waterfall' })).toBeVisible();
  await page.getByRole('button', { name: 'All executions' }).click();
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Execution waterfall' })).toBeVisible();
  await page.keyboard.press('Control+k'); await expect(page.getByRole('textbox')).toBeFocused();
});
test('methods and CPU profiles preserve statistical labels and frame zoom interactions', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(query + '&view=methods');
  await expect(page.getByRole('columnheader', { name: 'CALLS ENDING IN ERROR' })).toBeVisible();
  await expect(page.getByText('Sampled calls only.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Browse service executions' }).click();
  await expect(page.getByRole('button', { name: 'MessageConsumer.handle', exact: true })).toBeVisible();
  await expect.poll(() => calls.some(url => url.pathname.endsWith('/traces') && url.searchParams.get('service') === 'event-worker' && !url.searchParams.has('search'))).toBe(true);
  await expect(page).not.toHaveURL(/search=/);
  await nav(page, 'CPU profiler').click();
  await expect(page.getByRole('heading', { name: 'Continuous CPU profile' })).toBeVisible();
  await expect(page.getByText('CPU SAMPLES', { exact: true })).toBeVisible();
  const frame = page.locator('.flame-frame').filter({ hasText: 'MappingEngine.apply' });
  await frame.hover(); await expect(frame).toHaveAttribute('title', /inclusive samples/);
  await frame.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.frame-inspector strong')).toHaveText('MappingEngine.apply');
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(page.locator('.frame-inspector strong')).toHaveText('Retained CPU samples');
  await page.screenshot({ path: 'tests/screenshots/profiler-1440.png', fullPage: true });
  await page.getByRole('button', { name: 'Inspect samples' }).click();
  await expect(page).toHaveURL(/id=/);
  await nav(page, 'Errors').click();
  await page.getByRole('button', { name: 'Inspect example trace' }).click();
  await expect(page.getByRole('heading', { name: 'Execution waterfall' })).toBeVisible();
});
test('empty, loading, authorization, storage recovery and schema skip states remain truthful', async ({ page }) => {
  let release!: () => void;
  const options: MockOptions = { empty: true, gate: new Promise<void>(done => { release = done; }) };
  await mockApi(page, options); await page.goto(query + '&view=traces');
  try { await expect(page.getByText('Loading recorded telemetry\u2026').first()).toBeVisible(); }
  finally { options.gate = undefined; release(); }
  await expect(page.getByText('No telemetry in this window', { exact: true })).toBeVisible();
  options.delayed = false; options.empty = false; options.forbidden = true;
  await page.getByRole('button', { name: 'Refresh recorded data' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Access denied' })).toBeVisible();
  await expect(page.getByText('Unsafe backend details', { exact: false })).toHaveCount(0);
  options.forbidden = false; options.unavailable = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).first().click();
  await expect(page.getByRole('alert').filter({ hasText: 'Telemetry storage is temporarily unavailable.' })).toBeVisible();
  options.unavailable = false; options.skipped = 4;
  await page.getByRole('button', { name: 'Try again', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'MessageConsumer.handle', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'newer telemetry schema' })).toBeVisible();
});
test('5000 spans stay virtualized and late rows remain inspectable by keyboard', async ({ page }) => {
  await mockApi(page, { large: true });
  await page.goto(query + '&view=traces&id=' + trace.traceId);
  await expect(page.getByRole('heading', { name: 'Execution waterfall' })).toBeVisible();
  expect(await page.locator('.waterfall-row').count()).toBeLessThan(40);
  const viewport = page.locator('.waterfall-viewport');
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const late = page.getByRole('button', { name: 'BatchService.item4999', exact: true });
  await expect(late).toBeVisible(); await late.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.inspector h3')).toHaveText('BatchService.item4999');
  expect(await page.locator('.waterfall-row').count()).toBeLessThan(40);
});
test('default and proxy mounts normalize the trailing slash and responsive layouts remain usable', async ({ page }) => {
  await mockApi(page);
  await page.goto('/observe' + query); await expect(page).toHaveURL(/\/observe\/\?/);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.goto('/test/observe' + query); await expect(page).toHaveURL(/\/test\/observe\/\?/);
  await mkdir('tests/screenshots', { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: 'tests/screenshots/dashboard-' + viewport.width + '.png', fullPage: true });
    if (viewport.width === 390) {
      await page.getByRole('button', { name: 'Pages', exact: true }).click();
      await nav(page, 'Executions').click();
      await expect(page.getByRole('heading', { name: 'Executions', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'MessageConsumer.handle', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Span inspector' })).toBeVisible();
      await page.screenshot({ path: 'tests/screenshots/trace-390.png', fullPage: true });
    }
  }
});
test('missing runtime configuration shows a startup error without requesting telemetry', async ({ page }) => {
  let apiCalls = 0;
  await page.route('**/api/v1/**', route => { apiCalls++; return route.abort(); });
  await page.route('**/test/observe/**', async route => {
    if (route.request().resourceType() !== 'document') { await route.fallback(); return; }
    const response = await route.fetch(); const html = await response.text();
    await route.fulfill({ response, body: html.replace(/<script id="tracelet-config" type="application\/json">[^<]*<\/script>/, '') });
  });
  await page.goto(query);
  await expect(page.getByRole('heading', { name: 'Dashboard configuration unavailable' })).toBeVisible();
  expect(apiCalls).toBe(0);
});

test('5000 distinct deep CPU stacks respect the render budget and disclose omitted detail', async ({ page }, info) => {
  test.setTimeout(60000);
  await mockApi(page, { largeFlame: true });
  const started = Date.now();
  await page.goto(query + '&view=profiler');
  await expect(page.getByRole('heading', { name: 'Continuous CPU profile' })).toBeVisible();
  await expect(page.getByText(/20,000|20000/)).toBeVisible();
  const count = await page.locator('.flame-frame').count();
  expect(count).toBeLessThanOrEqual(1500);
  await page.locator('.flame-frame').filter({ hasText: 'sharedCpuRoot' }).click();
  await expect(page.locator('.frame-inspector strong')).toHaveText('sharedCpuRoot');
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(page.locator('.frame-inspector strong')).toHaveText('Retained CPU samples');
  await info.attach('bounded-flame-render-observation', { body: JSON.stringify({ stackCount: 5000, framesPerStack: 128, renderedButtons: count, elapsedMs: Date.now() - started, note: 'Single-host observation, not a universal latency budget' }), contentType: 'application/json' });
});
test('health filters show an explicit empty state instead of an empty panel', async ({ page }) => {
  await mockApi(page);
  await page.goto(query + '&view=health&service=unknown-service');
  await expect(page.getByText('No process heartbeats for these filters', { exact: true })).toBeVisible();
});