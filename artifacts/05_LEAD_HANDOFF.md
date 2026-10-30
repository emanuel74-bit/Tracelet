# Codex04/05 handoff to Claude07

Consume tracelet/m04-storage-query in D:/codeShit/Tracelet-wt/m04 once. User explicitly kept04+05 in this worktree/branch; do not assume a separate m05 branch. Stage04 source/review checkpoint d26c5a5, earlier implementation dd6a96b, LEAD cursor revision6 consumed asd44511f. Final stage05 source commit is recorded in canonical D:/codeShit/Tracelet/docs/tracelet-handoff/MISSION_STATUS.md. No Claude process was started by Codex.

Delivered: approved storage/query/API layout and cursorv2 continuation, React source under packages/tracelet/ui, committed built assets under packages/tracelet/assets/dashboard, actual browser screenshots, UI regression suites and independent04/05 reviews. There is no production fixture fallback. No new endpoint/DTO/schema or instrumentation meaning was invented.

## LEAD-owned integration work

1. Merge accepted instrumentation03 (latest canonical c9fc638), profiling06 (bce50e1), contracts revision6 and this m04 branch according to the canonical live handoff. Current m04 intentionally remains on its accepted03 base plus authorized dependency/contracts and owned changes; Codex did not edit or cherry-pick Claude internals/test fixes.
2. Wire existing storage/query facade and authenticated HTTP adapter per frozen plan; protect HTML, assets and APIs, enforce HEAD/CSP/default deny, configure queue/client/runtime lifecycle outside business traces. Root integration/bootstrap remains LEAD-owned.
3. Read built asset-manifest.json; validate bytes/hashes and inject the escaped frozen JSON runtime config into the single placeholder. Keep strict CSP. Generated assets/.gitattributes preserves checkout bytes; it is metadata, excluded from served manifest. Source maps and test fixtures are absent from production assets.
4. Canonicalize the public mount to a trailing slash and preserve query state. Dashboard navigation is query-only. Default /observe and custom /test/observe were tested with canonical redirects; arbitrary nested fallback paths require redirect/base handling in LEAD's adapter. Do not claim /observe/a/b works by returning unchanged relative-assets HTML.
5. Dispose DRAFT CR-DSH-001 in canonical change-requests: UI own manifest/direct pins exist; single root workspace/lock intake is LEAD-owned and not self-approved. Runtime uses committed assets without requiring a UI toolchain. Root files unchanged by Codex. No competing UI lockfile exists.
6. Run actual Mongo/two-process/auth/static/Express/Fastify/pack-install integration and record stage07 evidence before Codex08. G0 fixture integration waiver applies; real host/release gate stays unverified.

Known semantics: method rows cannot correlate child calls to trace IDs in v1 and honestly browse service root executions; method errors mean calls ending in error. Collapsed spans show call counts and summed-duration warning. Flame graphs are retained CPU samples independent of trace time, with idle/dropped/backend/display limits explicit. Heavy graphs/details are not cached; small-query cache is bounded/expired-pruned. Large spans use virtualized accessible rows.

Final actual checks: query42/42+storage15/15; UI unit13/13, browser8/8 (worker AND independent), typecheck/build/UIlint0, manifest bytes validated, reference screenshots inspected. Historical failed/repaired checks and NOT RUN boundaries are explicit in04/05 evidence. Neither checkpoint is integrated/release approval. Stage08 is ineligible until Claude07 completion. Reuse existing Tracelet Codex Progress every15minutes; no duplicate scheduler, publication or deployment.
