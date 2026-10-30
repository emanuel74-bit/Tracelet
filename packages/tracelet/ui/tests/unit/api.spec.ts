import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, loadRuntimeConfig } from '../../src/api';
const origin = 'http://localhost:4173';
const body = (value: unknown, status = 200, skipped?: string) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...(skipped === undefined ? {} : { 'X-Tracelet-Skipped': skipped }) } });
const client = (fetcher: ReturnType<typeof vi.fn>, extras = {}) => new ApiClient({ apiBase: '/proxy/observe/api/v1', origin, fetch: fetcher as typeof fetch, ...extras });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('runtime API boundary', () => {
  it('reads only valid same-origin injected runtime config and rejects missing or external config', () => {
    const read = (value: unknown) => loadRuntimeConfig({ getElementById: () => ({ textContent: JSON.stringify(value) }) as HTMLElement }, origin);
    expect(read({ basePath: '/proxy/observe', apiBase: '/proxy/observe/api/v1', contractVersion: '1', schemaVersion: 1 }).apiBase).toBe('/proxy/observe/api/v1');
    for (const value of [null, {}, { basePath: '/observe', apiBase: 'https://external.invalid/api', contractVersion: '1', schemaVersion: 1 }, { basePath: '//external.invalid', apiBase: '/api', contractVersion: '1', schemaVersion: 1 }]) expect(() => read(value)).toThrow(ApiError);
    expect(() => loadRuntimeConfig({ getElementById: () => null }, origin)).toThrow(/configuration is unavailable/);
  });
  it('uses the injected proxy prefix, encoded literal queries, same-origin credentials and schema diagnostics', async () => {
    const fetcher = vi.fn().mockResolvedValue(body({ items: [], nextCursor: null }, 200, '3'));
    const onSkipped = vi.fn(); const api = client(fetcher, { onSkipped });
    await api.traces({ search: 'a.* & secret', service: 'worker', cursor: 'opaque+/=' });
    const [url, options] = fetcher.mock.calls[0];
    expect(url.pathname).toBe('/proxy/observe/api/v1/traces');
    expect(url.searchParams.get('search')).toBe('a.* & secret'); expect(url.searchParams.get('cursor')).toBe('opaque+/=');
    expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(onSkipped).toHaveBeenCalledWith(3); expect(api.skippedNewerSchema).toBe(3);
  });
  it('bounds cache by full filter/cursor key, supports invalidation and does not cache failures', async () => {
    const fetcher = vi.fn().mockImplementation(async () => body({ items: [], nextCursor: null }));
    const api = client(fetcher);
    await api.traces({ service: 'a', cursor: 'one' }); await api.traces({ cursor: 'one', service: 'a' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await api.traces({ service: 'b', cursor: 'one' }); await api.traces({ service: 'a', cursor: 'two' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    api.invalidate(); await api.traces({ service: 'a', cursor: 'one' }); expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockResolvedValue(body({ error: { code: 'FORBIDDEN', message: 'password-secret' } }, 403));
    await expect(api.health()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'You do not have permission to view this dashboard.' });
    await expect(api.health()).rejects.toBeInstanceOf(ApiError); expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('expires cached responses and keeps schema diagnostics attached to the cached request', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(async () => body({ items: [] }, 200, '2')); const onSkipped = vi.fn();
    const api = client(fetcher, { cacheMs: 100, onSkipped });
    await api.services(); await api.services(); expect(fetcher).toHaveBeenCalledTimes(1); expect(onSkipped).toHaveBeenLastCalledWith(2);
    vi.advanceTimersByTime(101); await api.services(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains at most 24 list queries and never retains span or folded-stack payloads', async () => {
    const fetcher = vi.fn().mockImplementation(async () => body({ items: [] })); const api = client(fetcher);
    for (let i = 0; i < 25; i++) await api.traces({ service: 'service-' + i });
    await api.traces({ service: 'service-0' }); expect(fetcher).toHaveBeenCalledTimes(26);
    for (const path of ['/flamegraph', '/profiles/profile-0001/flamegraph', '/traces/trace-0001']) {
      await api.get(path); await api.get(path);
    }
    expect(fetcher).toHaveBeenCalledTimes(32);
    await api.traces({ service: 'service-24' }); expect(fetcher).toHaveBeenCalledTimes(32);
  });
  it('releases expired list references even when the next request is an uncached heavy query', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(async () => body({ items: [] })); const api = client(fetcher, { cacheMs: 100 });
    await api.services(); await api.instances();
    // Retention is a memory bound: inspect the private store to prove expired values are released, not just bypassed.
    const retained = api as unknown as { cache: Map<string, unknown> };
    expect(retained.cache.size).toBe(2);
    vi.advanceTimersByTime(101); await api.mergedFlamegraph();
    expect(retained.cache.size).toBe(0);
  });
  it('preserves caller cancellation without a storage error or cached stale response', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))));
    const pending = client(fetcher).overview({}, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client(fetcher).overview({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('times out bounded requests and suppresses unsafe backend and transport messages', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('mongodb://password-secret')))));
    const pending = client(fetcher, { timeoutMs: 25 }).overview();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', status: 503 });
    await vi.advanceTimersByTimeAsync(25); await assertion;
    const broken = client(vi.fn().mockRejectedValue(new Error('password-secret')));
    await expect(broken.health()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const unsafe = client(vi.fn().mockResolvedValue(body({ error: { code: '__proto__', message: 'password-secret' } }, 500)));
    await expect(unsafe.health()).rejects.toMatchObject({ code: 'INTERNAL', message: 'The telemetry request could not be completed.' });
  });
  it('does not allow callers to change API origin or navigate out of the runtime prefix', async () => {
    expect(() => new ApiClient({ apiBase: 'https://external.invalid', origin })).toThrow(ApiError);
    const fetcher = vi.fn(); const api = client(fetcher);
    for (const path of ['https://external.invalid', '//external.invalid', '/../health', '/https://external.invalid/x', '/%2e%2e/health']) await expect(api.get(path)).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
