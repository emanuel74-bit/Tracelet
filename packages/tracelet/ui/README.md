# Tracelet embedded dashboard

React + TypeScript UI for the frozen v1 query API, including revision6 opaque pagination cursors. Source uses type-only @tracelet/contracts imports. Production assets are committed under ../assets/dashboard; they contain no fixture fallback, remote fonts, CDN dependency or source maps. Local build tests use explicit test-only HTTP mocks.

## Development and checks

From this directory, the current isolated install is `npm install --workspaces=false --package-lock=false --legacy-peer-deps` (the repository single lockfile is LEAD-owned; see CR-DSH-001). Then run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. The build writes and validates the frozen asset manifest, including SHA-256, sizes, content types, the 8 MiB cap and exactly one runtime-config placeholder. `npm run test:e2e` uses Chromium and a loopback-only test host; screenshot evidence is in tests/screenshots. Test reports/results and node_modules are ignored.

The UI intentionally fails closed if the host has not injected the frozen non-executable JSON script #tracelet-config. A plain Vite dev server does not fabricate this configuration or telemetry. Use the test host for contract-mock development; actual authenticated host mounting is stage07.

## LEAD integration requirements

- Read asset-manifest.json and authenticate every HTML/asset/API request before serving it. Inject DashboardRuntimeConfig into the single <!--tracelet:config--> placeholder using the approved escaped JSON data block. API base must remain same-origin.
- Canonicalize the public mount to a trailing slash, preserving query parameters. The relative Vite asset URLs work at /observe/ and custom public prefixes. UI navigation/deep links use query parameters, not nested path routes. Unknown nested SPA paths need redirect/canonicalization or equivalent correct asset-base handling in the stage07 HTTP adapter; do not serve an unchanged relative-assets index at an arbitrary deep pathname.
- Preserve the frozen CSP (script-src self, style-src self); no unsafe-inline exception is needed. Graph positioning uses DOM style property assignments. The build serves external JavaScript/CSS only.
- Root package compilation consumes committed assets without a UI build. Integrate this branch once: the user explicitly authorized stages04+05 in m04 rather than a separate m05 worktree.

## Telemetry semantics and limits

Execution totals come from settled-root rollups; trace/method details are sampled. Method errors are calls ending in error, including rethrowing ancestors. Method rows browse service root executions; v1 cannot correlate a child method directly to trace IDs. Error groups scan at most a 24-hour window. Aggregated profiles use at most the last six hours of the chosen range; retained individual windows can be selected separately.

CPU flame widths reflect retained samples, not per-trace wall time. Idle/dropped samples and backend truncation are reported separately. Display construction is bounded to20,000 trie nodes and1,500 rendered frames/49 levels, with explicit inclusive-count/omitted-descendant warnings. Heavy flamegraph and trace-detail responses are not retained by query caches. Waterfall rows are virtualized for5000 spans; missing parents/cycles are handled, missing exclusive time stays unavailable. Collapsed call counts are shown: their duration is a sum, not one continuous observed interval.

No live Mongo/host integration, auth mounting, HTTP adapter compatibility or release acceptance is implied by UI mock/browser tests. Those remain stage07/08/09 evidence.
