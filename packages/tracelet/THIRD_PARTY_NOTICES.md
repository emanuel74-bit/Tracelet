# Third-party notices

## nestjs/observe (MIT)

Parts of `src/shared`, `src/context`, `src/instrumentation`, `src/buffer` and (later) `src/profiling` are
adapted from `nestjs/observe` at commit `7500fba7f61f4d0e177e415b291ec6d4d366b052` (v0.3.19).

Copyright (c) 2017-present Kamil Mysliwiec <https://kamilmysliwiec.com>

The verbatim upstream license text is in `third_party/nestjs-observe/LICENSE`. Pin details are in
`third_party/nestjs-observe/PIN.md` and every change is listed in `third_party/nestjs-observe/FORK_DELTA.*.md`.
Every vendored source file carries a header naming the upstream commit.

### Vendored file headers in `dist`

Every vendored source file carries the header comment naming the upstream commit (`nestjs/observe@7500fba`). `tsc` drops a
leading comment that is attached to an elided type-only import; the six affected files now have a blank line after the header
so that tsc keeps it as a detached top-of-file comment, and `tests/e2e/pack-install.e2e-spec.ts` asserts that all 13 vendored files
in the installed package still contain the header. In any case the packaged `third_party/nestjs-observe/LICENSE` is the licence
text for all of them.

## Dashboard bundle (`assets/dashboard/assets/index-*.js`)

The prebuilt dashboard is a Vite production build of `ui/src`. Its minified bundle (licence comments stripped by the minifier)
contains the following third-party packages (derived from `ui/package.json` `dependencies`: `react` 19.2.0 and
`react-dom` 19.2.0, plus the transitive runtime dependency `scheduler` 0.27.0 of `react-dom`; their `package.json`/`LICENSE`
files were read from the published npm tarballs). Everything else in `ui/package.json` is a development tool and is not shipped.
Vite's own tiny build helper (modulepreload polyfill) is also inlined; Vite is MIT, Copyright (c) 2019-present Yuxi (Evan) You and Vite contributors.

| Package | Version | Licence | Copyright |
|---|---|---|---|
| react | 19.2.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-dom | 19.2.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| scheduler | 0.27.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |

The licence text of all three (identical) is:

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tracelet itself

`package.json` declares `MIT` (decision D8) and `LICENSE` is shipped in the package.

**TODO(user):** the copyright holder in `LICENSE` is the placeholder `Tracelet contributors`; replace it with the real holder.
