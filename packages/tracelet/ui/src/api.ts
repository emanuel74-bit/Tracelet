import type { ErrorGroupPage, Flamegraph, Health, InstanceList, MethodStatsList, ObserveTrace, Overview, Page, ProfileSummaryPage, ServiceList, TraceDetail } from '@tracelet/contracts';
export type { ErrorGroupPage, Flamegraph, Health, InstanceList, MethodStatsList, ObserveTrace, Overview, Page, ProfileSummaryPage, ServiceList, TraceDetail } from '@tracelet/contracts';
export type Query = Readonly<Record<string, string | number | undefined>>;
export interface RuntimeConfig { basePath: string; apiBase: string; contractVersion: string; schemaVersion: 1 }
const messages: Record<string, string> = {
  INVALID_QUERY: 'The requested filters or time range are invalid.',
  INVALID_CURSOR: 'This page token no longer matches the filters. Return to the first page.',
  NOT_FOUND: 'This record is unavailable or has expired.',
  FORBIDDEN: 'You do not have permission to view this dashboard.',
  METHOD_NOT_ALLOWED: 'This request method is unavailable.',
  RATE_LIMITED: 'Too many queries are running. Try again shortly.',
  STORAGE_UNAVAILABLE: 'Telemetry storage is temporarily unavailable.',
  QUERY_TIMEOUT: 'The telemetry query timed out. Try a smaller time range.',
  INTERNAL: 'The telemetry request could not be completed.',
};
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = messages[code] ?? messages.INTERNAL) { super(message); this.name = 'ApiError'; }
}
export function loadRuntimeConfig(doc: Pick<Document, 'getElementById'> = document, origin = location.origin): RuntimeConfig {
  try {
    const config = JSON.parse(doc.getElementById('tracelet-config')?.textContent ?? '');
    if (config.schemaVersion !== 1 || typeof config.contractVersion !== 'string' || typeof config.basePath !== 'string' || !config.basePath.startsWith('/') || config.basePath.startsWith('//') || typeof config.apiBase !== 'string') throw new Error();
    const api = new URL(config.apiBase, origin);
    if (api.origin !== origin || api.search || api.hash || api.username || api.password || !/^https?:$/.test(api.protocol)) throw new Error();
    return { basePath: config.basePath, apiBase: api.pathname.replace(/\/$/, ''), contractVersion: config.contractVersion, schemaVersion: 1 };
  } catch { throw new ApiError(500, 'INTERNAL', 'Dashboard configuration is unavailable. Contact the application owner.'); }
}
export interface ApiClientOptions { apiBase: string; onSkipped?: (count: number) => void; fetch?: typeof fetch; origin?: string; timeoutMs?: number; cacheMs?: number }
export class ApiClient {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly cache = new Map<string, { value: unknown; skipped: number; expires: number }>();
  public skippedNewerSchema = 0;
  constructor(private readonly options: ApiClientOptions) {
    const origin = options.origin ?? location.origin;
    this.base = new URL(options.apiBase.replace(/\/$/, '') + '/', origin);
    if (this.base.origin !== origin || !/^https?:$/.test(this.base.protocol) || this.base.search || this.base.hash || this.base.username || this.base.password) throw new ApiError(500, 'INTERNAL', 'Dashboard configuration is unavailable.');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  invalidate(): void { this.cache.clear(); }
  private skipped(count: number): void { this.skippedNewerSchema = count; this.options.onSkipped?.(count); }
  async request<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (!/^\/[A-Za-z0-9/_%.:-]+$/.test(path) || path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) throw new ApiError(400, 'INVALID_QUERY');
    const url = new URL(path.slice(1), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new ApiError(400, 'INVALID_QUERY');
    for (const key of Object.keys(query).sort()) if (query[key] !== undefined) url.searchParams.set(key, String(query[key]));
    const key = url.toString();
    const now = Date.now();
    for (const [storedKey, entry] of this.cache) if (entry.expires <= now) this.cache.delete(storedKey);
    const cacheable = path !== '/flamegraph' && !/^\/traces\/[^/]+$/.test(path) && !/^\/profiles\/[^/]+\/flamegraph$/.test(path);
    const cached = cacheable ? this.cache.get(key) : undefined;
    if (cached && cached.expires > Date.now()) { this.skipped(cached.skipped); return cached.value as T; }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? 10000);
    try {
      const response = await this.fetcher(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const body: unknown = await response.json().catch(() => { throw new ApiError(response.status, 'INTERNAL'); });
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (timedOut) throw new ApiError(503, 'QUERY_TIMEOUT');
      if (!response.ok) {
        const code = (body as { error?: { code?: unknown } })?.error?.code;
        throw new ApiError(response.status, typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'INTERNAL');
      }
      const header = response.headers.get('X-Tracelet-Skipped');
      const skipped = header !== null && /^\d+$/.test(header) && Number.isSafeInteger(Number(header)) ? Number(header) : 0;
      this.skipped(skipped);
      if (cacheable && (this.options.cacheMs ?? 10000) > 0) {
        if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { value: body, skipped, expires: Date.now() + (this.options.cacheMs ?? 10000) });
      }
      return body as T;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (timedOut) throw new ApiError(503, 'QUERY_TIMEOUT');
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'STORAGE_UNAVAILABLE');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> { return this.request<T>(path, query, signal); }
  services(signal?: AbortSignal): Promise<ServiceList> { return this.request('/services', {}, signal); }
  instances(query: Query = {}, signal?: AbortSignal): Promise<InstanceList> { return this.request('/instances', query, signal); }
  overview(query: Query = {}, signal?: AbortSignal): Promise<Overview> { return this.request('/overview', query, signal); }
  methods(query: Query = {}, signal?: AbortSignal): Promise<MethodStatsList> { return this.request('/methods', query, signal); }
  traces(query: Query = {}, signal?: AbortSignal): Promise<Page<ObserveTrace>> { return this.request('/traces', query, signal); }
  trace(id: string, signal?: AbortSignal): Promise<TraceDetail> { return this.request('/traces/' + encodeURIComponent(id), {}, signal); }
  profiles(query: Query = {}, signal?: AbortSignal): Promise<ProfileSummaryPage> { return this.request('/profiles', query, signal); }
  flamegraph(id: string, signal?: AbortSignal): Promise<Flamegraph> { return this.request('/profiles/' + encodeURIComponent(id) + '/flamegraph', {}, signal); }
  mergedFlamegraph(query: Query = {}, signal?: AbortSignal): Promise<Flamegraph> { return this.request('/flamegraph', query, signal); }
  errors(query: Query = {}, signal?: AbortSignal): Promise<ErrorGroupPage> { return this.request('/errors', query, signal); }
  health(query: Query = {}, signal?: AbortSignal): Promise<Health> { return this.request('/health', query, signal); }
}
