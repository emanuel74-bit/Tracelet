# Stage05 executed evidence —2026-10-30

Worktree D:/codeShit/Tracelet-wt/m04, branch tracelet/m04-storage-query. Accepted stage04 cursor checkpoint d26c5a5; stage05 final source SHA is recorded in canonical MISSION_STATUS.md after the owned commit. Parent has not changed model/effort; actual configured worker Sol Medium and reviewer Sol High used. Worker model capacity was exhausted only during the final packaging follow-up; parent completed that bounded metadata fix and the reviewer independently verified it.

## Final checks actually run

From packages/tracelet/ui unless noted, Node22.22.0/npm10.9.4; React19.2.0, TypeScript5.9.3, Vite7.2.2, Playwright1.56.1, Chromium141.0.7390.37. Direct UI dependencies are pinned; transitive UI dependencies are NOT locked yet (LEAD CR-DSH-001).

| Command/check | Actual result |
|---|---|
| npm install --workspaces=false --package-lock=false --ignore-scripts --no-audit --no-fund --legacy-peer-deps --cache D:/codeShit/Tracelet-wt/m04/.npm-cache --prefer-offline --fetch-retries=0 --fetch-timeout=20000 | Worker exit0,100packages. Isolated UI directory; root files unchanged. Earlier default optional-peer install failed npm Arborist null.edgesOut; no ACL/dependency workaround. |
| npm run typecheck | Worker exit0; final npm run build also runs tsc --noEmit over source/tests. |
| npm run lint | Worker exit0 after one Set-mutation expression was rewritten as if/else. ESLint9.39.5 and typescript-eslint8.72.1 resolved from existing root install and declared in UI-owned manifest. |
| npm test | Final worker13/13 exit0; reviewer independently13/13 exit0,2files,2.42s. API URL confinement, cancellation, safe errors, query cache behavior and URL/window state covered. |
| PLAYWRIGHT_BROWSERS_PATH=ui/node_modules/.cache/ms-playwright; node node_modules/playwright/cli.js test | Worker8/8 exit0,58.2s. Reviewer independent8/8 exit0,1.1min after port release. No CSP console violations; test host closed normally. |
| npm run build (also npm --prefix packages/tracelet/ui run build from root) | Final parent exit0 after packaging metadata fix; Vite32modules,3servedfiles247977bytes. No runtime JS/CSS change from independently tested bundle. |
| Manifest JSON/path/size/SHA256 and fixture marker checks | Worker and reviewer exit0. Actual entry/JS/CSS sizes and hashes verified. Built assets contain no fixture marker fallback and no source maps. |
| git check-attr text on HTML/manifest/hashedJS/hashedCSS | Parent+reviewer: text unset for all four. Generated owned assets/dashboard/.gitattributes preserves literal bytes under core.autocrlf=true and is excluded from served manifest. Raw staged-byte verification follows before commit. |
| git diff --check | Parent/worker/reviewer exit0 on tracked snapshot; staged check is the final check for new UI files. |

## Browser coverage and visual evidence

Eight tests cover filter requests, opaque cursor paging, default fixed-window URL persistence, deep links/history/reload, keyboard span/frame inspection, parent collapse and zoom/offset, compressed-call semantics, method-to-service-root navigation, loading/empty/403/storage failure/retry/schema warnings,5000-span virtualization with late keyboard selection,5000 distinct128-frame stacks/display limits, default and custom public mounts, missing runtime config, filtered health emptiness and responsive overflow.

Actual screenshots independently regenerated and visually inspected against all three supplied reference views:
- ui/tests/screenshots/dashboard-1440.png (1440x900 viewport, full page)
- ui/tests/screenshots/dashboard-1920.png (1920x1080 viewport)
- ui/tests/screenshots/dashboard-390.png (390x844 viewport)
- ui/tests/screenshots/trace-1440.png
- ui/tests/screenshots/trace-390.png
- ui/tests/screenshots/profiler-1440.png

Flame-label contrast calculation:5.35,5.81,5.78,6.21,7.27. This targeted calculation and browser testing are not a complete WCAG audit. Fixtures are explicitly test-only network responses through the actual API client; these screenshots are NOT live operational data.

## Failed/intermediate checks retained honestly

Initial browser4/8 and next6/8 failed before final repairs. Causes/evidence included mojibake selectors from ANSI reads, a stale-bundle health test, incorrect header roles repaired with scope=col, a nondeterministic350ms loading assertion replaced with a controlled response gate, and a disclosure-copy expectation corrected to the actual continuous-interval semantics. A focused rerun verified filter/paging requests; the earlier request-wait failure's root cause was not proven. No test timeout or data correctness requirement was weakened. Initial Windows subprocess test-host teardown hung; only its confirmed own server PID was stopped. The final in-process test host teardown exited cleanly in worker and independent runs.

Normal apply_patch and an alternate harmless JS stat timed out during automatic approval review; normal PowerShell writes recovered. Explicit UTF8 reads/writes and a source scan repaired punctuation; no unsafe rejection or host compatibility inference was made. No root manifest/lock, frozen contract or Claude implementation file was edited.

## Not run / next stage

Live Mongo writes/TTL deletion/query plans/disconnect behavior, real Nest auth/static mounting, Express/Fastify, proxy deployment, target host compatibility and release tests NOT RUN here. Stage04 exact prior failures remain in its artifacts; new INS test fix c9fc638 and profiler follow-up bce50e1 are LEAD-owned stage07 merges, not merged or rerun here. G0 is waived only for fixture integration, still unverified for release. Stage08 requires accepted Claude07 integration.

Final parent precommit verification: exit0, raw Buffer reads of staged Git blobs (no PowerShell text pipe) matched the staged manifest against all3 asset lengths/SHA256 hashes, total247977bytes. Staged manifest bytes exactly matched working bytes and staged .gitattributes was exactly '* -text\n'. Staged diff check exit0; no MISSION_REPORT, root/package manifests/lock, frozen contracts or Claude source staged. This closes the remaining checkout-byte verification step.
