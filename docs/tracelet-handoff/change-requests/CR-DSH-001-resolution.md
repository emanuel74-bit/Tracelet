# CR-DSH-001 resolution: UI toolchain lock (LEAD, Mission 07 slice B, revised after the Stage 07 review)

Status: **APPROVED and applied** (root workspace + single root lockfile + `packages/tracelet/ui/.gitattributes`). The committed `packages/tracelet/assets/dashboard` bytes remain the runtime truth and were proven reproducible.

Condition set by the orchestrator: add `packages/tracelet/ui` as a root npm workspace with the single root lockfile **only if** `npm install --legacy-peer-deps` plus the UI typecheck / lint / unit / build still pass **and** the committed `assets/dashboard` bytes do NOT change after a rebuild.

## History

First attempt (Windows checkout, `core.autocrlf=true`): typecheck, lint, unit (13/13) and build passed, JS and CSS rebuilt byte-identically, but `ui/index.html` was checked out with CRLF (`git ls-files --eol`: `i/lf w/crlf attr/`), Vite copied the CRLF into `assets/dashboard/index.html` (506 bytes vs the committed 491) and the manifest differed. The CR was held back.

The first proposed fix, `ui/.gitattributes` = `* text eol=lf`, was rejected in review (L6): it would force text conversion of the binary screenshots under `ui/tests/screenshots/*.png`.

## Fix and proof

`packages/tracelet/ui/.gitattributes`:

```
* text=auto eol=lf
*.png binary
```

Verification A (clean clone, as a fresh developer on Windows would get it): `git clone` of the worktree into the scratchpad, `core.autocrlf=true`, `.gitattributes` committed, `ui/index.html` re-checked out: `git ls-files --eol` says `i/lf w/lf attr/text=auto eol=lf`; `ui/tests/screenshots/dashboard-390.png` says `i/-text w/-text` (untouched binary). Workspace added, `npm install --legacy-peer-deps`, `npm run -w packages/tracelet/ui build` printed "Dashboard manifest: 3 files, 247977 bytes", and `git status packages/tracelet/assets` is **empty** (index.html, both hashed assets and `asset-manifest.json` are byte-identical to the committed ones).

Verification B (this worktree, `index.html` converted to LF the way the attribute does on checkout): `npm install --legacy-peer-deps` ("added 59 packages, removed 1 package"), UI `typecheck` exit 0, `lint` exit 0, `test` 13/13, `build` exit 0, `git diff --quiet -- packages/tracelet/assets` reports unchanged.

Lockfile: one root `package-lock.json`. Compared with HEAD: 0 existing packages changed version, 110 packages added (the UI toolchain), 1 duplicate nested `@types/node` removed (deduped); the rest of the diff is hoisting and formatting.

## What the committer must do

* Commit `packages/tracelet/ui/.gitattributes` first and renormalise the UI sources once: `git add --renormalize packages/tracelet/ui` (the Windows working copy of the other UI files is still CRLF until then; the repository index already holds LF).
* Playwright browser tests (`test:e2e` in `ui/`) were NOT run for this CR.

Runtime and `npm pack` are unaffected: `ui/` is not in the `files` list (asserted by `tests/e2e/pack-install.e2e-spec.ts`).
