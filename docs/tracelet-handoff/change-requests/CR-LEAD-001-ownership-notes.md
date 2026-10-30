# CR-LEAD-001: ownership deviations in Mission 07 slice B (for Codex stage 08 to acknowledge)

Status: INFORMATION / ACKNOWLEDGEMENT REQUESTED. Owner: Claude/LEAD.

## Edits to Codex-owned paths

1. `packages/tracelet/src/storage/index.ts`: `createStorage()` now also returns `collections` (the `TelemetryCollections` built from its own Mongo client). Purely additive (two lines). Reason: the integrated module builds `QueryService` over the SAME pool instead of opening a second `MongoClient`. No behaviour of `start/stop/flush/health` changed. Stage 08 should keep this member (or provide an equivalent accessor) and may move it.
2. `packages/tracelet/src/index.ts` is new and LEAD-owned; it re-exports no storage/query/api symbol.

## Tests placed in LEAD directories

* `tests/unit/module/**`, `tests/unit/lifecycle/**` (module + lifecycle wiring), `tests/support/module/**`, `tests/support/e2e/**`, `tests/integration/http/**`, `tests/e2e/**`: LEAD scope per plan 3.12; the plan table lists `tests/unit/{http,config}` for LEAD, `module` and `lifecycle` are new sub-directories of the same owner.
* `tests/unit/module/config-writer-alignment.spec.ts` constructs the real `createStorage` (never started) for every accepted `buffer.*` extreme; it will fail if the writer limits (`telemetry-writer.ts` constructor) ever diverge from `resolveOptions`.

## Known limitation handed over (L8)

The dispatcher's in-flight cap (default 128, answers 429) is evaluated BEFORE authorisation by design (nothing may touch storage before auth, and the cap protects the process). Consequence: an unauthenticated client can flood `/observe` and make legitimate dashboard users receive 429 while the flood lasts. It can never affect the host application: business routes, handlers and acks do not pass through the dispatcher. Mitigation is outside the process (ingress rate limits / network policy). Documented in `packages/tracelet/README.md` ("Known limits").

## Items for Codex (not changed by LEAD)

* L1: `src/storage/index.ts:45`: the outer shutdown bound races `writer.shutdown()`; a dead-Mongo shutdown can lose up to queue-capacity + 1 uncounted traces (e2e asserts `lost >= 600 - 51`, strict `lost === 600` is an `it.todo`).
* L4: heartbeat: reschedule with `retryDelay` after a failed write rather than 30 s, write only after connect, and derive `connected` from a successful write. Visible effect: a new instance can take up to ~30 s to appear in `/instances` (the e2e waits 15 s only while the first heartbeat races the connection and has been stable in memory mode; see the e2e file comment).
