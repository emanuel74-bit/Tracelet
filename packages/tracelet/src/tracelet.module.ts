import { createRequire } from 'node:module';
import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, DynamicModule, InjectionToken, ModuleMetadata, OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit, OptionalFactoryDependency } from '@nestjs/common';
import { createQueryApiHandler } from './api';
import { error as apiError } from './api/errors';
import { QueryService } from './api/routes';
import { BoundedTelemetryQueue, createBufferHooks, RollupAccumulator } from './buffer';
import { resolveOptions, TraceletConfigError } from './config';
import type { ResolvedTraceletConfig } from './config';
import { closeAllOpenRoots, configureTracing, LogRedactor, setTelemetryQueue, startSweeper, stopSweeper, tracingHealth, whenCompletionsIdle } from './context';
import type { InstanceHeartbeat, TelemetryCounters, TraceletModuleOptions } from './contracts';
import type { ApiHandler } from './contracts/tracelet-internal-contracts';
import type { StandaloneServer } from './http';
import { ContinuousProfiler, MetricsCollector } from './profiling';
import { runOutsideTrace } from './shared/als';
import { markInternal } from './shared/brand';
import { createDiagnostics } from './shared/diagnostics';
import type { Diagnostics } from './shared/diagnostics';
import { createInstanceIdentity } from './shared/instance-identity';
import { TRACELET_DEPS } from './internal/test-seams';
import { createStorage } from './storage';
import { TRACELET_VERSION } from './version';

/*
 * TraceletModule and its lifecycle (plan 3.10, 13; INS report section 9 + 9a; PRO report section 5).
 *
 * Rules kept here:
 *  - The host application ALWAYS boots: an invalid configuration, a failing options factory or any wiring error leaves tracing
 *    DISABLED and logs ONE sanitized diagnostic (option paths and ranges only; the storage URI and every configured string value
 *    are never logged).
 *  - Disabled (TRACELET_DISABLED=1, enabled=false, production default) is a no-op: no queue, no timers, no Mongo client.
 *  - Mongo is only ever touched by the detached storage layer. Nothing in the lifecycle awaits a connection.
 *  - Every hook is idempotent, never throws and is bounded.
 *  - The class is branded internal so the instrument never proxies it (and it holds no Nest provider dependencies).
 */

export const TRACELET_OPTIONS = 'TRACELET_MODULE_OPTIONS';

/** Constructor seams (tests). Production uses the defaults. */
export interface LifecycleDeps {
  createStorage?: typeof createStorage;
  diagnostics?: Diagnostics;
  env?: Readonly<Record<string, string | undefined>>;
  /** Default 2000. */
  beforeShutdownBoundMs?: number;
  /** Default 1500. */
  completionWaitMs?: number;
}

/** Returned by the async options provider when the host's factory threw (the app must still boot). */
class FactoryFailure {
  constructor(readonly errorName: string, readonly message?: string) {}
}

/** Longest the host waits for a forRootAsync factory before Tracelet gives up (tracing disabled, host boots). */
export const DEFAULT_FACTORY_TIMEOUT_MS = 5000;

export type LifecycleState = 'inactive' | 'disabled' | 'config-error' | 'failed' | 'active' | 'stopped';

type Storage = ReturnType<typeof createStorage>;

const bounded = async (work: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const clamp = (v: number, min: number, max: number): number => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);

function nestCoreVersion(): string | undefined {
  try {
    const v = (createRequire(__filename)('@nestjs/core/package.json') as { version?: unknown }).version;
    return typeof v === 'string' ? v.slice(0, 32) : undefined;
  } catch {
    return undefined;
  }
}

const live = new Set<TraceletLifecycle>();
const register = (lifecycle: TraceletLifecycle): void => {
  live.add(lifecycle);
};

/** Lifecycles of this process whose application has not started shutting down (oldest first). Used by Tracelet.listen without an app. */
export function getLiveLifecycles(): TraceletLifecycle[] {
  return [...live].filter(l => !l.closing);
}

@Injectable()
export class TraceletLifecycle implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly diagnostics: Diagnostics;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly makeStorage: typeof createStorage;
  private readonly deps: LifecycleDeps;

  private _state: LifecycleState = 'inactive';
  private _config: ResolvedTraceletConfig | undefined;
  private failure: { kind: 'config'; issues: readonly string[] } | { kind: 'other'; name: string; message?: string } | undefined;

  private identityId: string | undefined;
  private queue: BoundedTelemetryQueue | undefined;
  private rollups: RollupAccumulator | undefined;
  private storage: Storage | undefined;
  private profiler: ContinuousProfiler | undefined;
  private metrics: MetricsCollector | undefined;
  private queryApi: ApiHandler | undefined;
  private readonly servers = new Set<StandaloneServer>();

  private beforeShutdownPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private bootstrapped = false;
  private _closing = false;

  constructor(
    @Inject(TRACELET_OPTIONS) options: unknown,
    @Optional() @Inject(TRACELET_DEPS) deps?: LifecycleDeps,
  ) {
    this.deps = deps ?? {};
    this.diagnostics = this.deps.diagnostics ?? createDiagnostics('Tracelet');
    this.env = this.deps.env ?? process.env;
    this.makeStorage = this.deps.createStorage ?? createStorage;
    register(this);
    // Pure and side-effect free: lets Tracelet.setup (which runs before app.init()) see the decision.
    try {
      if (options instanceof FactoryFailure) {
        this.failure = { kind: 'other', name: options.errorName, ...(options.message !== undefined ? { message: options.message } : {}) };
        this._state = 'failed';
      } else {
        this._config = resolveOptions(options as TraceletModuleOptions, this.env);
        this._state = this._config.enabled ? 'inactive' : 'disabled';
      }
    } catch (e) {
      this.failure = e instanceof TraceletConfigError ? { kind: 'config', issues: e.issues } : { kind: 'other', name: errorName(e), message: safeMessage(e) };
      this._state = e instanceof TraceletConfigError ? 'config-error' : 'failed';
    }
  }

  /** True once this application started shutting down (or has shut down). */
  get closing(): boolean {
    return this._closing;
  }

  get state(): LifecycleState {
    return this._state;
  }

  /** The resolved configuration; undefined when the options were invalid. */
  get config(): ResolvedTraceletConfig | undefined {
    return this._config;
  }

  /** True when tracing is (or will be, before onModuleInit has run) switched on. Tracelet.setup mounts only then. */
  get enabled(): boolean {
    return this._state === 'inactive' || this._state === 'active';
  }

  /** The /api/v1 handler handed to the dispatcher. Answers 503 STORAGE_UNAVAILABLE until (and after) the storage exists. */
  readonly apiHandler: ApiHandler = async request => {
    const handler = this.queryApi;
    if (handler === undefined) return apiError('STORAGE_UNAVAILABLE', 'Observe storage is unavailable', 503);
    return handler(request);
  };

  /** Standalone servers started by Tracelet.listen are closed with the application. */
  trackServer(server: StandaloneServer): boolean {
    if (this._closing) {
      // registration after shutdown started (the hooks already closed and cleared the set): close the late server right away
      void server.close().catch(() => undefined);
      return false;
    }
    this.servers.add(server);
    return true;
  }

  /** Exposed for health tests. */
  debug(): { state: LifecycleState; instanceId: string | undefined; queueDepth: number | undefined; traceQueueDepth: number | undefined; counters: Readonly<TelemetryCounters> | undefined } {
    return { state: this._state, instanceId: this.identityId, queueDepth: this.queue?.depth(), traceQueueDepth: this.queue?.depth('trace'), counters: this.queue?.counters() };
  }

  onModuleInit(): void {
    runOutsideTrace(() => {
      try {
        if (this._state === 'config-error' || this._state === 'failed') {
          this.reportFailure();
          return;
        }
        if (this._state !== 'inactive' || this._config === undefined) return; // disabled: nothing at all
        this.wire(this._config);
        this._state = 'active';
      } catch (e) {
        this.failure = { kind: 'other', name: errorName(e), message: safeMessage(e) };
        this._state = 'failed';
        this.teardownAfterFailedWiring();
        this.reportFailure();
      }
    });
  }

  onApplicationBootstrap(): void {
    runOutsideTrace(() => {
      if (this._state !== 'active' || this._config === undefined || this.bootstrapped) return;
      this.bootstrapped = true;
      const c = this._config;
      const step = (name: string, fn: () => void): void => {
        try {
          fn();
        } catch {
          this.diagnostics.warn(`bootstrap-${name}`, `Tracelet could not start ${name}; continuing without it.`);
        }
      };
      step('storage', () => this.storage?.start());
      step('rollups', () => this.rollups?.start());
      if (c.tracing.enabled) step('sweeper', () => startSweeper());
      step('profiler', () => {
        // NOT awaited: the first start builds a fresh V8 CpuProfiler and is heap-proportional.
        void this.profiler?.start().catch(() => undefined);
      });
      step('metrics', () => this.metrics?.start());
      if (c.tracing.enabled && !tracingHealth().instrumentInstalled) {
        this.diagnostics.warn('instrument-missing', 'TraceletInstrument is not installed on this application; only trace() roots will be recorded, providers are not traced.');
      }
    });
  }

  beforeApplicationShutdown(): Promise<void> {
    this._closing = true;
    if (this._state !== 'active') return Promise.resolve();
    return (this.beforeShutdownPromise ??= runOutsideTrace(async () => {
      const bound = this.deps.beforeShutdownBoundMs ?? 2000;
      try {
        stopSweeper();
      } catch {}
      const work: Array<Promise<unknown>> = [];
      try {
        if (this.profiler) work.push(this.profiler.stop());
      } catch {}
      try {
        this.metrics?.stop();
      } catch {}
      for (const server of this.servers) work.push(server.close());
      this.servers.clear();
      await bounded(Promise.all(work), bound);
    }));
  }

  onApplicationShutdown(): Promise<void> {
    this._closing = true;
    live.delete(this);
    if (this._state !== 'active') return Promise.resolve();
    return (this.shutdownPromise ??= runOutsideTrace(async () => {
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch {}
      };
      // INS report 9a order: stop new roots first, close open ones, wait for deferred completions, flush rollups and the last
      // metric deltas, then the writer's final bounded flush, which also closes the Mongo client.
      guard(() => configureTracing({ enabled: false }));
      guard(() => closeAllOpenRoots('shutdown'));
      await bounded(whenCompletionsIdle(this.deps.completionWaitMs ?? 1500), (this.deps.completionWaitMs ?? 1500) + 500);
      guard(() => stopSweeper());
      guard(() => void this.rollups?.shutdown());
      guard(() => void this.metrics?.flush());
      this._state = 'stopped';
      // storage.stop() is bounded by buffer.shutdownFlushTimeoutMs (plus a small margin for the client close).
      const storageBound = (this._config?.buffer.shutdownFlushTimeoutMs ?? 5000) + 1000;
      try {
        if (this.storage) await bounded(this.storage.stop(), storageBound);
      } catch {}
      this.queryApi = undefined;
    }));
  }

  /* ------------------------------------------------------------------------------------------------ */

  private wire(c: ResolvedTraceletConfig): void {
    const identity = createInstanceIdentity({ serviceName: c.serviceName, hostName: c.hostName, ...(c.serviceVersion !== undefined ? { serviceVersion: c.serviceVersion } : {}) });
    const queue = new BoundedTelemetryQueue(
      {
        maxQueuedTraces: c.buffer.maxQueuedTraces,
        maxQueuedBytes: c.buffer.maxQueuedBytes,
        maxQueuedProfiles: c.buffer.maxQueuedProfiles,
        maxQueuedControlItems: c.buffer.maxQueuedControlItems,
        maxQueuedControlBytes: c.buffer.maxQueuedControlBytes,
      },
      m => this.diagnostics.warn('queue', m),
    );
    const rollups = new RollupAccumulator({
      serviceName: identity.serviceName,
      instanceId: identity.instanceId,
      offer: item => queue.offer(item),
      warn: m => this.diagnostics.warn('rollup-cap', m),
    });
    const hooks = createBufferHooks({
      queue,
      rollups,
      mapper: {
        serviceName: identity.serviceName,
        ...(identity.serviceVersion !== undefined ? { serviceVersion: identity.serviceVersion } : {}),
        instanceId: identity.instanceId,
        errorMessages: c.tracing.errorMessages,
        redactor: new LogRedactor(c.tracing.redaction),
        spanCollapse: c.tracing.spanCollapse,
        maxSpansPerTrace: c.tracing.maxSpansPerTrace,
      },
    });

    const ref: { storage?: Storage } = {};
    const profiler = new ContinuousProfiler(c.profiling, { queue, serviceName: identity.serviceName, ...(identity.serviceVersion !== undefined ? { serviceVersion: identity.serviceVersion } : {}), instanceId: identity.instanceId });
    const metrics = new MetricsCollector(c.runtimeMetrics, { queue, serviceName: identity.serviceName, instanceId: identity.instanceId });
    const nestCore = nestCoreVersion();

    const heartbeat = (): InstanceHeartbeat => {
      const t = tracingHealth();
      const p = profiler.profilerHealth();
      const s = ref.storage?.health() ?? { connected: false };
      const counters = queue.counters();
      return {
        schemaVersion: 1,
        instanceId: identity.instanceId,
        serviceName: identity.serviceName,
        ...(identity.serviceVersion !== undefined ? { serviceVersion: identity.serviceVersion.slice(0, 64) } : {}),
        hostName: identity.hostName.slice(0, 253) || 'unknown',
        pid: identity.pid,
        bootId: identity.bootId,
        startedAt: identity.startedAt,
        lastSeenAt: new Date().toISOString(),
        versions: { node: process.versions.node.slice(0, 32), ...(nestCore !== undefined ? { nestCore } : {}), tracelet: TRACELET_VERSION },
        tracing: { enabled: t.enabled, sampleRate: clamp(t.sampleRate, 0, 1), instrumentInstalled: t.instrumentInstalled },
        profiler: {
          state: p.state,
          ...(p.reason !== undefined ? { reason: p.reason.slice(0, 256) } : {}),
          ...(p.sampleRateHz !== undefined ? { sampleRateHz: clamp(p.sampleRateHz, 0, 1000) } : {}),
          ...(p.achievedSampleRateHz !== undefined ? { achievedSampleRateHz: clamp(p.achievedSampleRateHz, 0, 1000) } : {}),
          ...(p.windowMs !== undefined ? { windowMs: p.windowMs } : {}),
          ...(p.lastWindowAt !== undefined ? { lastWindowAt: p.lastWindowAt } : {}),
        },
        buffer: {
          queueDepth: queue.depth(),
          droppedTraces: counters.tracesDroppedAdmission + counters.tracesDroppedQueueFull + counters.tracesDroppedStorage,
          droppedProfiles: counters.profilesDropped,
          ...(s.lastFlushAt !== undefined ? { lastFlushAt: s.lastFlushAt } : {}),
          ...(s.lastFlushErrorCode !== undefined ? { lastFlushErrorCode: String(s.lastFlushErrorCode).slice(0, 64) } : {}),
        },
        storage: { connected: s.connected === true },
      };
    };

    // The client is constructed here but not connected; start() connects detached in onApplicationBootstrap.
    const storage = (ref.storage = this.makeStorage(
      { serviceName: c.serviceName, storage: c.storage, tracing: c.tracing, buffer: c.buffer, retention: c.retention } as TraceletModuleOptions,
      queue,
      identity,
      heartbeat,
    ));
    const query = new QueryService(storage.collections, {
      servedBy: () => ({ instanceId: identity.instanceId, serviceName: identity.serviceName, mongoConnected: ref.storage?.health().connected === true, schemaVersion: 1 }),
    });

    // Everything that can throw is done: attach the queue and the hooks in the SAME call as the configuration (before traffic).
    this.identityId = identity.instanceId;
    this.queue = queue;
    this.rollups = rollups;
    this.storage = storage;
    this.profiler = profiler;
    this.metrics = metrics;
    this.queryApi = createQueryApiHandler(query, { authorize: () => true });
    setTelemetryQueue(queue);
    configureTracing({
      enabled: c.tracing.enabled,
      sampleRate: c.tracing.sampleRate,
      keepFailedRoots: c.tracing.keepFailedRoots,
      maxRootsPerSecond: c.tracing.maxRootsPerSecond,
      maxOpenTraces: c.tracing.maxOpenTraces,
      maxSpansPerTrace: c.tracing.maxSpansPerTrace,
      maxOpenSpans: c.tracing.maxOpenSpans,
      maxTraceDurationMs: c.tracing.maxTraceDurationMs,
      ...hooks,
    });
  }

  private teardownAfterFailedWiring(): void {
    try {
      configureTracing({ enabled: false });
    } catch {}
    this.queryApi = undefined;
    this.queue = undefined;
    this.rollups = undefined;
    this.storage = undefined;
    this.profiler = undefined;
    this.metrics = undefined;
  }

  private reportFailure(): void {
    const f = this.failure;
    if (f === undefined) return;
    // One line. Config issues name option paths and ranges only (resolveOptions never echoes configured values).
    const message =
      f.kind === 'config'
        ? `Tracelet is DISABLED because its configuration is invalid: ${f.issues.join('; ').slice(0, 1000)}`
        : `Tracelet is DISABLED because it could not be initialised (${f.name}${f.message ? `: ${f.message}` : ''}).`;
    this.diagnostics.error('init', message);
  }
}
markInternal(TraceletLifecycle);

/** A short, credential-free description of an error: connection strings are replaced wholesale, then the default redactor runs. */
function safeMessage(e: unknown): string | undefined {
  try {
    const raw = (e as { message?: unknown } | null)?.message;
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const noUris = raw.slice(0, 500).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[REDACTED_URI]');
    return new LogRedactor().redactMessage(noUris).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return undefined;
  }
}

function errorName(e: unknown): string {
  try {
    const n = (e as { name?: unknown } | null)?.name;
    return typeof n === 'string' ? n.replace(/[^\w.-]/g, '?').slice(0, 64) : 'Error';
  } catch {
    return 'Error';
  }
}

export interface TraceletModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: any[]) => TraceletModuleOptions | Promise<TraceletModuleOptions>;
  /** How long the host waits for `useFactory` before Tracelet is disabled and the application boots without it. Default 5000, range 1..60000. */
  factoryTimeoutMs?: number;
}

@Module({})
export class TraceletModule {
  static forRoot(options: TraceletModuleOptions): DynamicModule {
    return {
      module: TraceletModule,
      global: true,
      providers: [{ provide: TRACELET_OPTIONS, useValue: options }, TraceletLifecycle],
      exports: [TraceletLifecycle],
    };
  }

  static forRootAsync(options: TraceletModuleAsyncOptions): DynamicModule {
    return {
      module: TraceletModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: TRACELET_OPTIONS,
          inject: options.inject ?? [],
          // A failing host factory must not stop the host application from booting: tracing stays disabled.
          useFactory: async (...args: unknown[]) => {
            const ms = Number.isSafeInteger(options.factoryTimeoutMs) && options.factoryTimeoutMs! >= 1 && options.factoryTimeoutMs! <= 60_000 ? options.factoryTimeoutMs! : DEFAULT_FACTORY_TIMEOUT_MS;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`options factory did not resolve within ${ms} ms`)), ms);
                timer.unref?.();
              });
              return await Promise.race([Promise.resolve().then(() => options.useFactory(...args)), timeout]);
            } catch (e) {
              return new FactoryFailure(errorName(e), safeMessage(e));
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
        },
        TraceletLifecycle,
      ],
      exports: [TraceletLifecycle],
    };
  }
}
markInternal(TraceletModule);
