# Stage 04 validation runbook

Stage 04 remains unaccepted. These are reproduction commands, not passing evidence. Use only a disposable test Mongo database/credentials. No host compatibility or integration is asserted.

From D:\codeShit\Tracelet-wt\m04, using consumed LEAD dependency commit 8d35b55 (MongoDB 6.21.0) and the locked toolchain:

```powershell
npm ci --ignore-scripts
npm run -w packages/tracelet typecheck
npm run -w packages/tracelet lint
npm run -w packages/tracelet build
npm run -w packages/tracelet test
node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/support/storage/vitest.config.mts
node node_modules/vitest/vitest.mjs run --root packages/tracelet --config tests/unit/query/vitest.config.mts
$env:TRACELET_TEST_MONGO_URI = '<disposable test Mongo URI>'
npm run -w packages/tracelet test:int -- tests/integration/storage/mongo.int-spec.ts
Remove-Item Env:\TRACELET_TEST_MONGO_URI
```

The integration spec creates a unique disposable test database and drops that database in cleanup. It checks two client identities, idempotent retry, BSON dates, seven single-field TTL definitions, 22 expected index definitions, and an indexed trace query plan. Mongo TTL deletion is eventual; index presence alone does not prove elapsed-time deletion. Real Mongo tests have NOT RUN in this checkpoint.

In this Windows sandbox the packaged SWC native carrier rejects the user cache owner and workspace cache ancestry. The investigator verified a native transform and default suite startup under narrowly escalated execution using the existing user-owned cache, with SWC_NATIVE_BINDING_CACHE unset. No ACL or package changes were needed. Ordinary user execution should use its trusted cache; custom workspace caches and temporary mode did not solve the sandbox ownership restriction. Scoped storage/query configs above avoid decorator transforms. See MISSION_REPORT.md and artifacts/04_*OUTPUT.txt for actual results; reproduction commands here are not passing evidence.

Once stage 07 LEAD actually mounts the authenticated API, examples (substitute the host's approved authorization mechanism):

```text
GET /observe/api/v1/traces?service=worker&from=2026-10-29T12:00:00.000Z&to=2026-10-29T13:00:00.000Z&limit=50
GET /observe/api/v1/profiles?service=worker&from=2026-10-29T12:00:00.000Z&to=2026-10-29T13:00:00.000Z
GET /observe/api/v1/health
```

Continue pagination with the same fixed bounds and filters plus the returned opaque cursor. Transparent continuation with omitted time bounds remains pending CR-STO-002; current code rejects a changed resolved-window hash instead of silently changing the effective filter. Inspect X-Tracelet-Skipped for newer schema documents. No public ingestion endpoint exists.
