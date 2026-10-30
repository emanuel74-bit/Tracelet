import type { INestApplication } from '@nestjs/common';
import type { TraceletSetupOptions, TraceletStandaloneServerOptions } from './contracts/observe-contracts';
import { createAuthGate, createDispatcher, createStaticAssets, mountExpress, mountFastify, normalizeBasePath, startStandaloneServer } from './http';
import type { Dispatcher, StandaloneServer } from './http';
import { createDiagnostics } from './shared/diagnostics';
import { getActiveLifecycle, TraceletLifecycle } from './tracelet.module';

const diagnostics = createDiagnostics('Tracelet');

function buildDispatcher(lifecycle: TraceletLifecycle, options: TraceletSetupOptions): Dispatcher {
  const basePath = normalizeBasePath(options.path ?? '/observe');
  const publicBasePath = normalizeBasePath(options.publicBasePath ?? basePath);
  return createDispatcher({
    basePath,
    publicBasePath,
    auth: createAuthGate({
      ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
      ...(options.allowLoopbackWithoutAuth !== undefined ? { allowLoopbackWithoutAuth: options.allowLoopbackWithoutAuth } : {}),
    }),
    // The dispatcher's auth gate has already decided; the handler must never be exposed on any other route.
    api: lifecycle.apiHandler,
    assets: createStaticAssets(publicBasePath),
  });
}

/**
 * Mounts the dashboard and the read API (Swagger-style, call before `app.init()` / `app.listen()`), or starts a standalone
 * listener for worker-only processes. Both need `TraceletModule.forRoot/forRootAsync` to be imported: the configuration and the
 * query service come from its lifecycle provider.
 */
export class Tracelet {
  /**
   * Throws (developer error at startup) when: the app is already initialised, the HTTP adapter is neither Express nor Fastify
   * (use `Tracelet.listen`), `TraceletModule` is not imported, or `path` / `publicBasePath` is invalid. When Tracelet is
   * disabled (TRACELET_DISABLED=1, `enabled: false`, production default, invalid configuration) nothing is mounted.
   * The Nest global prefix is NOT applied: `path` is absolute.
   */
  static setup(app: INestApplication, options: TraceletSetupOptions = {}): void {
    if ((app as unknown as { isInitialized?: boolean }).isInitialized === true) {
      throw new Error('Tracelet.setup() must be called before app.init() / app.listen(): the application is already initialised.');
    }
    const adapter = app.getHttpAdapter();
    const type = adapter.getType();
    if (type !== 'express' && type !== 'fastify') {
      throw new Error(`Tracelet.setup(): unsupported HTTP adapter "${String(type).slice(0, 32)}"; use Tracelet.listen() instead.`);
    }
    let lifecycle: TraceletLifecycle;
    try {
      lifecycle = app.get(TraceletLifecycle, { strict: false });
    } catch {
      throw new Error('Tracelet.setup(): TraceletModule is not imported by this application. Add TraceletModule.forRoot({...}) to the root module first.');
    }
    // Validate the path before deciding anything else, so a bad path fails the same way whether or not Tracelet is enabled.
    normalizeBasePath(options.path ?? '/observe');
    normalizeBasePath(options.publicBasePath ?? options.path ?? '/observe');
    if (!lifecycle.enabled) {
      diagnostics.warn('setup-disabled', 'Tracelet is disabled; the dashboard and API are not mounted.');
      return;
    }
    const dispatch = buildDispatcher(lifecycle, options);
    const basePath = normalizeBasePath(options.path ?? '/observe');
    const instance = adapter.getInstance();
    if (type === 'express') mountExpress(instance, basePath, dispatch);
    else mountFastify(instance, basePath, dispatch);
  }

  /**
   * Worker-only processes (no Nest HTTP server): a bounded node:http listener on `host` (default 127.0.0.1; a non-loopback
   * host requires `authorize`). Needs TraceletModule imported in a Nest application (context) of this process, created before
   * this call. Resolves `undefined` when Tracelet is disabled. The server is closed with the application.
   */
  static async listen(options: TraceletStandaloneServerOptions): Promise<StandaloneServer | undefined> {
    const lifecycle = getActiveLifecycle();
    if (lifecycle === undefined) {
      throw new Error('Tracelet.listen(): TraceletModule is not imported or the application has not been created yet.');
    }
    normalizeBasePath(options.path ?? '/observe');
    normalizeBasePath(options.publicBasePath ?? options.path ?? '/observe');
    if (!lifecycle.enabled) {
      diagnostics.warn('listen-disabled', 'Tracelet is disabled; the standalone dashboard server is not started.');
      return undefined;
    }
    const dispatch = buildDispatcher(lifecycle, options);
    const server = await startStandaloneServer({
      dispatch,
      ...(options.host !== undefined ? { host: options.host } : {}),
      port: options.port,
      hasAuthorize: options.authorize !== undefined,
    });
    lifecycle.trackServer(server);
    return server;
  }
}
