# Studio Windows build: Bun plugin path portability

Publication branch: `feat/studio-common-events-passage-windows`
Component candidate: `b9abb6b5216f02f57f9940807ae4ca963dbcf47a`
Pinned PocketJS candidate: `af1b5251f9fb7a5a0ba486bd9177f6a4295621f0`
Upstream-ready PocketJS commit: `93f2e6074fee04b540eb11462eec93a11cb27b5b`

## Verdict

The Studio desktop build now completes on native Windows with the repository's
existing Bun 1.3 line. The release-candidate workflow built and checked the
Linux package, the unsigned x64 NSIS Windows installer and unpacked app, and
the unsigned universal macOS package. Linux and Windows both passed the same
11-test desktop Playwright flow. No repository-wide Bun upgrade was needed.

The fix is deliberately at the build-plugin boundary: filesystem operations
keep native paths, while every file identity returned to Bun's plugin API uses
forward slashes. A Windows-only explicit fallback also keeps Bun 1.3.14 from
performing the affected workspace resolution itself. Linux output stayed
byte-identical.

## Root cause

The failing path was not read from the build plan and was not created by
Electron or NSIS. The call chain was:

1. `studio-desktop/build.ts:99` starts the preview web build.
2. `tools/web.ts:1459-1468` writes the preview plan and invokes PocketJS's
   builder with the plan, project root and output directory.
3. `vendor/pocketjs/tools/build.ts:588-592` installs PocketJS's JSX plugin in
   Bun's second bundle pass.
4. `tools/preview/opentype.ts:11` has an ordinary relative import of the
   vendored `opentype.min.mjs`.
5. PocketJS's broad Solid relative-import resolver at
   `vendor/pocketjs/framework/compiler/jsx-plugin.ts:717-728` sees that import.
   It is not an AOT model, so the old callback returned `undefined` and let Bun
   perform normal resolution.
6. On Windows, Bun 1.3.14's workspace fallback resolved the file to a native
   drive path with backslashes, then passed that path to its own `path.pretty`
   code, which requires forward slashes and panicked.

The baseline Windows job records Bun 1.3.14 and the exact resolved file:

```text
panic(thread 5192): Expected pretty file path to have only forward slashes,
got 'D:\a\pocketjs-rpgkit\pocketjs-rpgkit\vendor\pocketjs\node_modules\opentype.js\dist\opentype.min.mjs'
web: building preview failed (exit 3)
```

This isolates the producer: repository code supplied a forward-slash relative
specifier, PocketJS's plugin returned no result for it, and Bun's affected
Windows fallback produced the backslash absolute path. The plan and kit
arguments only lead to the builder; they do not contain the crashing module
identity.

## Bun upstream status

[oven-sh/bun#26798](https://github.com/oven-sh/bun/issues/26798), "Bun.build
crashes with Windows + workspaces + build.onResolve plugin", is the same
failure shape. The maintainer reproduced it on Bun 1.3.9 and verified it fixed
on current main on 2026-08-07, saying the fix would be in the next release.
Bun 1.4.0 was published on 2026-08-20, but its release notes do not explicitly
associate that issue with the release. Therefore this delivery does not claim
a tagged upstream fix version. Keeping the repository on Bun 1.3.x and using a
small compatible workaround was both sufficient and lower risk.

## Fix

### PocketJS plugin boundary

`vendor/pocketjs/framework/compiler/jsx-plugin.ts:480-500` adds two narrow
helpers:

- `bunPluginPath()` converts backslashes to forward slashes only for identities
  returned to Bun's plugin API.
- `windowsPluginFallback()` explicitly calls `Bun.resolveSync()` for an
  otherwise-unhandled relative Solid import on Windows and normalizes the
  result. Other hosts retain Bun's normal fallback path.

Every existing PocketJS `onResolve` branch that returns a real file identity
now applies the same boundary normalization. Native paths remain native for
`Bun.file`, cache files and existence checks. The core change and portability
test are isolated in `93f2e607`; the fork integration is `af1b5251`. The
component pins that result in `b9abb6b5`.

`vendor/pocketjs/tests/compiler-portability.test.ts:61-68` simulates a Windows
drive path, a UNC path and a POSIX path on Linux. It requires respectively
`D:/...`, `//server/...` and an unchanged POSIX identity.

### Windows-only issues exposed after the panic

Once PocketJS pass 2 could finish, native Windows reached two later portability
assumptions that the baseline had never exercised:

- `tools/web.ts:1127-1143` now normalizes separators before taking a font
  license basename, preventing an absolute drive path from escaping the game
  output directory. `tests/cjk-font.test.ts:240-244` covers drive, UNC and POSIX
  spellings.
- `studio-desktop/e2e/path.mjs:1-4` provides slash-stable relative snapshot
  keys. The E2E uses it when comparing imported project files, and
  `tests/studio-desktop-windows.test.ts:14-18` proves Windows and POSIX inputs
  match.

These are data-path and test portability fixes, not runtime behavior changes.

## Upstreamability

The PocketJS core commit `93f2e607` cleanly cherry-picked onto upstream
`pocket-nexus/pocketjs` main at
`3d0983769f62ac75bacd62b723c15202425b2dd1`, producing the test commit
`b819812f`. The focused compiler suites passed in both the fork and the clean
upstream worktree: 20 pass, 0 fail in each.

The upstream worktree's repository-wide TypeScript check still reports two
pre-existing errors in `tests/pocket3d-icon.test.ts` and
`tests/runtime-glyphs.test.ts`; no upstream-wide TypeScript result is claimed.
The clean cherry-pick and focused tests are the portability evidence.

## Mutation strength

Each mutation ran in an isolated disposable worktree rather than the candidate
checkout.

| Mutation | Discriminating result |
| --- | --- |
| Remove PocketJS plugin-path normalization | 9 pass, 1 expected failure in the portability coverage |
| Remove desktop snapshot-key normalization | 3 pass, 1 expected failure in the Windows contract coverage |

Both mutations failed on the separator behavior they removed, so the new tests
do not pass accidentally on Linux.

## Local validation

The final component sequence started from a deleted `dist/` directory:

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | pass; `pocketjs.wasm` is 445,622 bytes |
| `bun run build:example` | pass |
| `bunx tsc --noEmit` | pass |
| `bun run test` | 4,648 pass, 0 fail, 0 skip; 731,965 assertions across 306 files |
| Focused CJK/font-license suite | 25 pass, 0 fail |
| Focused Studio Windows contract suite | 4 pass, 0 fail |

The browser production build and Studio verifier completed with no failed
checks or console errors. The packaged Linux desktop E2E completed 11 pass,
0 fail, 0 skip. Its screenshots and the browser verification screenshots were
opened and inspected; the editor, imported project, passage overlay and
play-test frames contained the expected content rather than blank or stale
captures.

The deterministic Linux Studio application-tree hash was identical before and
after the PocketJS fix:

```text
before  eee0086ea7ed92a084235cbdd614961266743b1c4ff730740d981007a6bbb151
after   eee0086ea7ed92a084235cbdd614961266743b1c4ff730740d981007a6bbb151
```

Thus the Windows workaround does not change Linux build bytes.

## Native hosted validation

Final workflow run:
[39181687629](https://github.com/lfkdsk/pocketjs-rpgkit/actions/runs/39181687629),
head `b9abb6b5216f02f57f9940807ae4ca963dbcf47a`.

| Job | Result |
| --- | --- |
| [Desktop smoke (Linux)](https://github.com/lfkdsk/pocketjs-rpgkit/actions/runs/39181687629/job/117835590297) | success; real package and structure check, E2E 11 pass / 0 fail / 0 skip |
| [Desktop smoke (Windows)](https://github.com/lfkdsk/pocketjs-rpgkit/actions/runs/39181687629/job/117835590574) | success; native x64 NSIS package and unpacked structure check, E2E 11 pass / 0 fail / 0 skip, installer artifact uploaded |
| [macOS universal package](https://github.com/lfkdsk/pocketjs-rpgkit/actions/runs/39181687629/job/117835590602) | success; unsigned universal package and artifact upload |

The Windows leg used the workflow's unchanged Bun 1.3.x selection. The original
panic is gone, PocketJS pass 2 completes, and packaging proceeds through NSIS,
the structure assertions and Playwright.

## Compatibility and hygiene

The component history is linear above the reviewed Studio branch, with no merge
commit. Neither root nor desktop `bun.lock` changed. Generated packages remain
untracked and are not part of the candidate. `git diff --check` passes. The
PocketJS change is build-time only and adds no guest or per-frame runtime path.

Subagent use: 3 / Newton checked Bun upstream, Pasteur audited the path flow, and Heisenberg audited tests and CI / parallel read-only checks saved investigation time.

PASS
