# tracelet

Embedded, self-hosted observability for NestJS (internal package). It mounts a Swagger-style dashboard at `/observe`, traces
provider methods automatically, lets you create **custom root traces** for direct-library callbacks (for example a raw `amqplib`
consumer), samples CPU continuously, and stores everything in a **shared MongoDB** so every replica shows the same data.

There is no outbound telemetry: Tracelet only talks to the MongoDB you configure. Nothing is sent to any third party.

> Status: internal package, version `0.1.0`. Compatibility with your real host application (G0) has **not** been verified yet; run
> it against a staging copy first (see "Rollback").

## Requirements

| | |
|---|---|
| Node.js | `>= 20.19.0` (tested on 20.19.5, 22, 24) |
| NestJS | `@nestjs/core` and `@nestjs/common` `>= 11.1.4 < 12` (the `instrument` option of `NestFactory` is required) |
| HTTP adapter | Express 5 (`@nestjs/platform-express`) or Fastify 5 (`@nestjs/platform-fastify`); other adapters and worker-only processes use `Tracelet.listen()` |
| MongoDB | any MongoDB reachable from every replica; a dedicated database and user are recommended |

## Install

```sh
npm install tracelet          # from your internal registry or a tarball: npm install ./tracelet-0.1.0.tgz
```

The package is CommonJS and works from CommonJS and ESM (`"type": "module"`) applications.

## Boot (HTTP application)

```ts
import { NestFactory } from '@nestjs/core';
import { Tracelet, TraceletInstrument } from 'tracelet';
import { AppModule } from './app.module';

async function bootstrap() {
  // 1. TraceletInstrument traces every provider method (this is what makes the dashboard show spans).
  const app = await NestFactory.create(AppModule, { instrument: TraceletInstrument });
  app.enableShutdownHooks(); // required so telemetry is flushed on SIGTERM

  // 2. Mount /observe BEFORE app.listen()/app.init().
  Tracelet.setup(app, {
    authorize: req => req.headers['x-internal-token'] === process.env.OBSERVE_TOKEN, // see "Access control"
  });
  await app.listen(3000);
}
bootstrap();
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { TraceletModule } from 'tracelet';

@Module({
  imports: [
    TraceletModule.forRoot({
      serviceName: 'orders-worker',
      serviceVersion: process.env.APP_VERSION,
      storage: { uri: process.env.TRACELET_STORAGE_URI! }, // never logged
    }),
    // or TraceletModule.forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c) => ({ ... }) })
  ],
})
export class AppModule {}
```

Public exports: `trace`, `currentTraceId`, `TraceletInstrument`, `createTraceletInstrument`, `TraceletModule`, `Tracelet`, `version`,
plus the types `TraceletModuleOptions`, `TraceletSetupOptions`, `TraceletStandaloneServerOptions`, `TraceletAuthRequest`,
`TraceOptions`, `TraceFn`, `CurrentTraceIdFn`, `TraceletInstrumentOptions`, `RedactionOptions`, `ExecutionKind`, `Attributes`,
`AttributeValue`, `StandaloneServer`, `TraceletModuleAsyncOptions`.

If the module options are invalid (or the async options factory throws) the application **still boots**: tracing stays disabled
and exactly one error line names the offending option path and its allowed range. Configured values (especially
`storage.uri`) are never printed.

### Custom roots for direct-library callbacks (RabbitMQ with raw `amqplib`)

Provider tracing starts at a root. HTTP-less callbacks have none, so wrap the callback body in `trace()`. Return values, thrown
errors and your `ack`/`nack` logic are unchanged:

```ts
import { trace } from 'tracelet';

channel.consume('orders', msg => {
  if (!msg) return;
  void trace('rabbitmq.consume', () => orders.handle(JSON.parse(msg.content.toString())), {
    kind: 'rabbitmq',
    attributes: { queue: 'orders' },
  }).then(
    () => channel.ack(msg),
    () => channel.nack(msg, false, false),
  );
});
```

A complete runnable example lives in `examples/nest-worker` of the repository (also with `docker-compose.yml` for RabbitMQ and MongoDB).

### Worker-only processes (no Nest HTTP server)

```ts
const app = await NestFactory.createApplicationContext(AppModule, { instrument: TraceletInstrument });
app.enableShutdownHooks();
await Tracelet.listen({ port: 3100, authorize: req => /* ... */ true }); // host defaults to 127.0.0.1
```

`Tracelet.listen()` needs the `TraceletModule` of the same process. Binding a non-loopback `host` without `authorize` throws.
It resolves `undefined` when Tracelet is disabled. The server is closed with the application.

## Access control (read this before deploying)

The dashboard and the API are **deny by default**. Every request (HTML, assets, API, redirects) goes through the same gate:

1. non-`GET`/`HEAD` requests get `405`;
2. if `authorize(req)` is configured it must return (or resolve) exactly `true` within 2 s; `false`, any exception or a timeout gives `403`;
3. otherwise the request is allowed only if `allowLoopbackWithoutAuth` is on **and** the TCP peer address is `127.0.0.1` / `::1`;
4. otherwise `403`.

`allowLoopbackWithoutAuth` defaults to `true` only when `NODE_ENV` is exactly `development` or `test`. An unset `NODE_ENV` is
**production**. `X-Forwarded-For` and `trust proxy` are never consulted. **Do not enable the loopback rule in a pod with a proxy
sidecar** (Istio/Envoy, oauth-proxy): forwarded external traffic arrives from `127.0.0.1`. Use `authorize` there.

`authorize(req)` receives `{ method, path, headers, remoteAddress, raw, adapter }` where `raw` is the Express/Fastify request, so you
can reuse your own session or SSO check.

Options of `Tracelet.setup(app, options)`: `path` (default `/observe`; absolute; the Nest global prefix is **not** applied),
`publicBasePath` (when a proxy rewrites the path), `authorize`, `allowLoopbackWithoutAuth`.
`Tracelet.setup` throws at startup when the app is already initialised, when the adapter is neither Express nor Fastify, or when
`TraceletModule` is not imported. When Tracelet is disabled, nothing is mounted.

## Environment variables and defaults

| Variable | Effect |
|---|---|
| `TRACELET_DISABLED=1` | Kill switch. Always wins. Nothing is wired: no timers, no Mongo client, no instrumentation, no routes. Options are not even validated. |
| `TRACELET_ENABLED=true\|false` | Enables or disables when the `enabled` option is not set. |
| `NODE_ENV` | `development` / `test` = non-production defaults; **unset or anything else = production**. |

Precedence for "enabled": `TRACELET_DISABLED=1` > module option `enabled` > `TRACELET_ENABLED` > default (on only in development/test).
Pass the same `enabled` to `createTraceletInstrument({ enabled })` if you use it; a mismatch is reported in health
(`instrumentInstalled`). The storage URI is **not** read from the environment by the library; pass `process.env.YOUR_VAR` in
`storage.uri`.

| Option | development / test | production (default) |
|---|---|---|
| enabled | on | **off** unless enabled explicitly |
| `tracing.sampleRate` | 1 | **0.05** (failed roots are still kept: `keepFailedRoots`) |
| `tracing.maxRootsPerSecond` | 200 | 20 |
| `tracing.errorMessages` | `redacted` | **`omit`** |
| `profiling.enabled` | off | **off** (opt-in) |
| `runtimeMetrics` | every 30 s | every 30 s |
| `buffer` | queue 2000 traces / 16 MiB, flush 1 s, batch 200, final flush <= 5 s | same |
| `retention` | traces 72 h, profiles 72 h, rollups 14 d, instances 24 h (MongoDB TTL indexes) | same |
| `storage` | database `observability`, collection prefix `tracelet_`, pool <= 5 | same |

Everything is bounded: the telemetry queue, open traces and spans, spans per trace, profile size and write rate. When a bound is
hit, telemetry is dropped and **counted** (visible in `/observe/api/v1/health`), never queued without limit and never allowed to
block business code. Mongo being down only loses telemetry: business handlers, return values, errors and message acks are unchanged.

## What is and is not captured

* Provider method calls inside an open root become spans. Roots come from `trace()` and from the framework entry points you wrap.
* Errors are sanitised: credentials in URIs, bearer tokens, e-mail addresses and common secret keys are redacted; in production the message is omitted entirely.
* Attributes you pass to `trace()` are capped and redacted too. Do not put payloads or secrets in them.
* The dashboard and the API are **never traced** and cannot recurse into themselves.
* Method rollup `errorCount` means **calls that ended in error**; one failure is counted once per frame it propagated through. Use trace-level error counts for "number of failures".
* Flame graphs are CPU samples of the process in a time window, **not** a per-trace profile.

## Known limits

* Providers that are `forwardRef`-injected, use `#private` fields, or return Observables / async iterables are not (fully) traced.
* Request-scoped and transient providers are traced only when created through `ModuleRef.resolve()` after the instrument is installed.
* CPU profiling (`profiling.enabled: true`) on **Node 20 on Windows** is refused unless `profiling.sampleRateHz <= 9` (a V8 11.3 sampler busy-wait). Node 22+ and Linux are not affected.
* If your application itself calls `console.profile()` / uses the inspector profiler, enable profiling only after checking the interaction; the continuous profiler uses the in-process inspector.
* Profiled frames are not source-mapped.
* Compatibility with the production host application (G0) is **not verified**; the example applications and the test-suite use fixtures.

## Rollback

Remove `TraceletModule` from the imports, remove `Tracelet.setup(...)`, and drop `instrument: TraceletInstrument` from
`NestFactory.create`. Or, without a deploy, set `TRACELET_DISABLED=1` and restart: Tracelet becomes a complete no-op. Stored data
expires by itself through the TTL indexes (or drop the `tracelet_*` collections).

## Development

```sh
npm install --legacy-peer-deps      # at the repository root
npm run typecheck && npm run lint   # from the root, runs in packages/tracelet
npm run build                       # CommonJS into packages/tracelet/dist
npm test                            # unit
npm run -w packages/tracelet test:int
npm run -w packages/tracelet test:e2e            # real-Mongo cases report NOT RUN unless a disposable mongod is provided
```

Running the real-Mongo suites (opt-in, they only ever touch uniquely named throwaway databases):

```sh
# self-contained: downloads a mongod binary once (mongodb-memory-server) and runs storage + e2e suites against it
npm run -w packages/tracelet test:mongo
# or against your own THROWAWAY mongod
TRACELET_E2E_MONGO_URI=mongodb://127.0.0.1:27017 TRACELET_TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run -w packages/tracelet test:e2e
```

Licence: MIT (see `LICENSE`). Vendored parts are listed in `THIRD_PARTY_NOTICES.md`.
