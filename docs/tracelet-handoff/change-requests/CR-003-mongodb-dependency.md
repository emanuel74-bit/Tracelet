# CR-003 (APPROVED, applied): add the mongodb 6.21.x production dependency

Requested by: Codex stage 04 (artifacts/04_LEAD_HANDOFF.md in worktree m04). Approved by: Claude orchestrator (LEAD), 2026-10-30. Classification: dependency change only (plan section 8 / D3). No contract, schema, API or default change.

## Change
- `packages/tracelet/package.json`: `dependencies.mongodb = "~6.21.0"` (production dependency; resolved 6.21.0).
- `package-lock.json`: locked accordingly (`npm install -w packages/tracelet mongodb@~6.21.0 --legacy-peer-deps`).
- Base commit: `8b800cb` (stage 03), so Codex can `git merge tracelet/lead-mongo-dep` into `tracelet/m04-storage-query` with no conflicts in tracked files.

## Verification (Node 22.22.0)
- `npm ci --dry-run --legacy-peer-deps` accepts the lockfile; `require('mongodb')` resolves 6.21.0.
- typecheck exit 0, lint exit 0, unit suite 355/355 (21 files). No integration/Mongo tests were run: Mongo behaviour and host compatibility (D1/G0) remain unverified and belong to stages 04 and 07.

## Notes
- The Tracelet instrumentation must never instrument this client (plan section 10); the storage factory owns its own client and pool.
- `.npmrc` keeps `legacy-peer-deps=true` (vitest 4 optional peers crash npm 10.9.4 otherwise).

## Direction on the file-list deviation raised in the same handoff
The consolidated storage files (`mongo-types.ts`, `telemetry-store.ts`, `bounded-writer.ts`, `query-service.ts`) are NOT approved. Preserve the frozen plan section 3.9 file list; split the code accordingly and move `tests/unit/storage.spec.ts` under `tests/unit/storage/**`. No broader architecture change is approved. Any real need to deviate goes through a plan-only CR with independent review.
