# direct-callback example

A plain Nest application context (no HTTP, no MongoDB, no network) plus an amqplib-style channel whose consume callback is
wrapped in `trace()`. Providers are traced automatically through `createTraceletInstrument()`. The captured spans are drained
from an in-memory `BoundedTelemetryQueue` and printed; nothing is simulated.

It also shows the wiring the `TraceletModule` lifecycle performs (the module is integrated in a later mission):
`setTelemetryQueue`, `configureTracing` with `createBufferHooks`, and the graceful shutdown order
`configureTracing({ enabled: false })` -> `closeAllOpenRoots` -> `whenCompletionsIdle` -> `RollupAccumulator.shutdown()` -> drain/flush.

## Run it

From `packages/tracelet` (after `npm ci` at the repository root):

```sh
# compile (type-checks the example and src; output goes under node_modules/.cache, which is git-ignored)
npx tsc -p examples/direct-callback/tsconfig.json
# run
node ../../node_modules/.cache/tracelet-example/examples/direct-callback/main.js
```

Expected output: an ack log (`ack:m-1, nack:m-2, ack:m-3`), one trace per message with its provider spans
(`OrderConsumer.handle` > `OrderService.total` > `PriceRepository.lookup`), the failing message's span carrying a redacted error
(`mongodb://[REDACTED]@db.internal:27017`) and a per-operation rollup line. Durations vary per run.

## Run it as a test

```sh
npx vitest run --config vitest.int.config.mts tests/integration/instrumentation/example.int-spec.ts
```

## What to copy into your own consumer

```ts
channel.consume('orders', (msg) =>
  trace('rabbitmq.consume', () => handle(msg), { kind: 'rabbitmq', attributes: { queue: 'orders' } }));
```

Use a static, low-cardinality operation name (never message content or ids); put variable context in `attributes`
(at most 16 keys, redacted and bounded). The root settles when the callback's returned promise settles, so return (or await) the work inside the callback.
