# nest-worker example

The smallest realistic consumer of the `tracelet` package: a **raw `amqplib` consumer** inside a plain Nest application context
(no HTTP server), with

* `TraceletModule.forRoot(...)` (shared MongoDB storage),
* `instrument: TraceletInstrument` so every provider method becomes a span,
* `trace('rabbitmq.consume', ...)` around the consumer callback to create the **root** trace, with `ack` / `nack` exactly as
  without Tracelet,
* `Tracelet.listen(...)` serving the dashboard at `http://127.0.0.1:3100/observe/` (worker-only processes have no Nest HTTP
  adapter; an HTTP application would use `Tracelet.setup(app, ...)` instead),
* an `authorize` example (`OBSERVE_TOKEN`: bearer check, constant-time compare).

Without `AMQP_URL` it runs against an **in-process fake channel** that produces demo messages (every 5th is poisoned and
nacked), so you can see real traces without RabbitMQ. Nothing is simulated in the telemetry itself: every trace goes through the
real instrumentation, queue and MongoDB writer.

## Run it

### 1. Start RabbitMQ and MongoDB (optional RabbitMQ)

```sh
cd packages/tracelet/examples/nest-worker
docker compose up -d        # RabbitMQ on 127.0.0.1:5672 (+ management 15672), MongoDB on 127.0.0.1:27017
```

You can run only MongoDB (`docker compose up -d mongo`) and use the fake channel.

### 2. Build the package and the example (inside this repository)

```sh
# from the repository root
npm install --legacy-peer-deps
npm run build                                                   # packages/tracelet/dist
cd packages/tracelet
npx tsc -p examples/nest-worker/tsconfig.json                   # output: ../../node_modules/.cache/tracelet-nest-worker
```

### 3. Start the worker

```sh
# from packages/tracelet; the compiled example resolves `tracelet` through the workspace link to dist/
export TRACELET_STORAGE_URI=mongodb://127.0.0.1:27017
export DEMO_MESSAGES=50 DEMO_INTERVAL_MS=200                    # fake channel only
node ../../node_modules/.cache/tracelet-nest-worker/examples/nest-worker/src/main.js
# real RabbitMQ: npm install amqplib (devDependency of the example), then
# export AMQP_URL=amqp://guest:guest@127.0.0.1:5672 AMQP_QUEUE=orders
```

Open `http://127.0.0.1:3100/observe/`. Stop with Ctrl+C: the worker flushes telemetry (bounded) before exiting.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TRACELET_STORAGE_URI` | `mongodb://127.0.0.1:27017` | shared observability MongoDB (never logged) |
| `TRACELET_DB` | `observability` | database name |
| `SERVICE_NAME` | `nest-worker-example` | service shown in the dashboard |
| `AMQP_URL`, `AMQP_QUEUE` | unset, `orders` | real RabbitMQ; unset = in-process fake channel |
| `OBSERVE_HOST`, `OBSERVE_PORT` | `127.0.0.1`, `3100` | dashboard listener (non-loopback host requires `OBSERVE_TOKEN`) |
| `OBSERVE_TOKEN` | unset | when set, `/observe` requires `Authorization: Bearer <token>`; when unset only loopback peers are allowed |
| `DEMO_MESSAGES`, `DEMO_INTERVAL_MS` | `0`, `200` | fake channel demo traffic |
| `SAMPLE_RATE`, `MAX_ROOTS_PER_SECOND`, `QUEUE_MAX_TRACES` | `1`, library default, library default | tuning |
| `TRACELET_DISABLED=1` | | kill switch: the same worker with Tracelet completely off |

## Tests

* `tests/integration/http/nest-worker-example.int-spec.ts` compiles this example with `tsc -p` and runs it with the in-process
  channel (ack/nack identical to the business outcome with Mongo unreachable, bearer authorize, kill switch).
* `tests/e2e/two-instances.e2e-spec.ts` starts it as two OS processes against one MongoDB.

To use it outside this repository: copy `src/`, add `tracelet` (tarball or registry) and `amqplib` to your package, and remove the
`paths` entry of the tsconfig that maps `tracelet` to this repository's sources.
