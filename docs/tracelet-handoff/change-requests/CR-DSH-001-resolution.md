# CR-DSH-001 resolution: UI toolchain lock (LEAD, Mission 07 slice B)

Status: **NOT APPROVED as submitted (conditions not met); no root change made.** The committed `packages/tracelet/assets/dashboard` bytes remain the runtime truth.

Condition set by the orchestrator: add `packages/tracelet/ui` as a root npm workspace with the single root lockfile **only if** `npm install --legacy-peer-deps` plus the UI typecheck / lint / unit / build still pass **and** the committed `assets/dashboard` bytes do NOT change after a rebuild (asset-manifest hashes compared).

## What was run (worktree `D:\codeShit\Tracelet-wt\m07`, Windows, Node 22.22.0, npm 10.9.4, `core.autocrlf=true`)

1. Root `package.json` `workspaces` temporarily set to `["packages/tracelet", "packages/tracelet/ui"]`; `npm install --legacy-peer-deps` : `added 59 packages, removed 1 package` (exit 0, one root lockfile).
2. `npm run -w packages/tracelet/ui typecheck` : exit 0. `lint` : exit 0. `test` (vitest): 2 files, **13 passed / 13**. `build` (`tsc --noEmit && vite build && write-manifest`): exit 0, "Dashboard manifest: 3 files, 247992 bytes".
3. Rebuild comparison against the committed assets:
   * `assets/index-DZSRTth0.js` (232148 bytes) and `assets/index-8H8qAzKJ.css` (15338 bytes): **identical** (same names, same sha256).
   * `index.html`: **different**: committed 491 bytes (LF, `* -text` attribute in `assets/dashboard/.gitattributes`), rebuilt 506 bytes (CRLF). Therefore `asset-manifest.json` differs in the `index.html` entry only (size 491 -> 506, sha256 `3c4d17c7...` -> `d9b8649b...`).
   * Cause (observed, not fixed): `packages/tracelet/ui/index.html` is checked out with CRLF on this Windows machine (`git ls-files --eol`: `i/lf w/crlf attr/`, no `eol` attribute), Vite copies the line endings of its source HTML, and the committed output was produced with LF.

## Decision

The stated condition (bytes unchanged) is not met on this machine, so the workspace was **not** added: root `package.json` and `package-lock.json` workspace/UI entries were reverted, the rebuilt assets were discarded (`git checkout -- packages/tracelet/assets`) and `npm install --legacy-peer-deps` was run again to prune the UI packages. The only lockfile change in this worktree is the devDependency `mongodb-memory-server` for the opt-in e2e suites.

## Path to approval (small, for the owner of `ui/`)

* Add `packages/tracelet/ui/.gitattributes` with `* text eol=lf` (and renormalise `ui/index.html`) so the HTML source has LF on every checkout, then repeat steps 1-3. If `index.html` then rebuilds to the committed 491 bytes / `3c4d17c7...`, the workspace addition is approved as requested (root `workspaces` + single root lockfile, `npm install --legacy-peer-deps`; UI checks above all pass already).
* Until then the package consumes only the committed assets (no UI toolchain at runtime or in `npm pack`); `ui/` is excluded from the tarball (asserted by `tests/e2e/pack-install.e2e-spec.ts`).

Playwright browser tests (`test:e2e` in `ui/`) were NOT run for this CR.
