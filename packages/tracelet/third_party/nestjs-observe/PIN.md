# Upstream pin: nestjs/observe

| Item | Value |
|---|---|
| Repository | https://github.com/nestjs/observe |
| Commit (vendored from) | `7500fba7f61f4d0e177e415b291ec6d4d366b052` (short `7500fba`, v0.3.19 release commit) |
| npm package / version | `@nestjs/observe@0.3.19` |
| npm `gitHead` | `319a3d016ba47ad0856ef18b85f1495270a8b6d6` (`319a3d0`, parent of the commit above) |
| npm tarball integrity | `sha512-tGw1Mp5JgZmeTeR9uJnYCA9KEwJsGy+bhpuKx4QqerO56GEGdnYqjnouGxVOcUXT83VVJF74ksu9c5LVqlB8Vw==` |
| License | MIT, Copyright (c) 2017-present Kamil Mysliwiec (verbatim text in `LICENSE`, copied from the pinned checkout) |
| Local read-only checkout used | `D:\codeShit\Tracelet-refs\observe` |
| Date vendored | 2026-10-29 (Mission 02 slice A); ported upstream specs added in Mission 03 (same pin) |

No runtime dependency on `@nestjs/observe` is taken; the files listed in `FORK_DELTA.instrumentation.md` are copied or adapted into
`packages/tracelet/src`, each with the header
`// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.*.md`.

Source references for the plan's closure table: `artifacts/01_IMPLEMENTATION_PLAN.md` sections 4 and 4.1.

Runtime ABI policy (not an upstream item, kept here with the fork rules): bump `TRACELET_RUNTIME_ABI` in `src/shared/als.ts` on any change to the global slot shape or behaviour. Current value 2.
