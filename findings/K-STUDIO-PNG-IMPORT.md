# K-STUDIO-PNG-IMPORT

## Decision

The Studio PNG import is complete and the prior review failures are resolved. Browser Studio, Linux desktop Studio and `rpgkit-edit` all import persistent tile-sheet and walker PNGs through the shared edit API. The final clean-build gate, both end-to-end flows, five isolated mutations, clean frozen installs and non-Studio byte comparison all pass. This finishing pass was completed with traecli.

## Prior review failures resolved

1. **No `Sheet.name` schema extension.** The unused optional field, its compatibility generation, changelog entry and fixture are absent. `package.json`, `bun.lock`, the engine type/schema/identity files, the schema changelog and compatibility fixtures are byte-identical to `origin/main`. The canonical schema and declared `MAP_SCHEMA_HASH` both remain `24945cdb48da82c863a7e5f4c467698699ced3ba85cdb4cbdb43f10b2948fc34`; a sheet's stable id is also its Studio label.
2. **No root Playwright dependency or lock drift.** The browser E2E lives with the desktop package and reuses its locked `playwright-core`. A clean root `bun install --frozen-lockfile` installed 528 packages and a clean desktop install installed 270 packages. Both lockfiles stayed unchanged, and the lock scan found no internal registry strings.
3. **Conventional, linear history.** The implementation is split into `feat(editor)`, `feat(studio)`, `test(studio)`, `docs(studio)` and `fix(studio)` commits. There are no merge commits; every commit is authored by `lfkdsk <lfkdsk@gmail.com>` and has no co-author footer.

## Delivered behavior

- `editor/api/png-import.ts` validates the source PNG and adjustable grid, crops offset/spacing pixels, enforces 16×16 tile sheets and existing 3×4 walker conventions, rejects silent replacement and unsafe smaller replacements, and attaches imported sheets to the selected map.
- `EditSession.importPngAsset` commits catalog edits and image bytes as one history entry. Undo and redo move both together; an inline project becomes a self-contained sharded pack once it carries art.
- Browser, desktop and memory hosts return the picked PNG bytes. Studio shows the grid preview and replacement confirmation, refreshes art after edit/history changes, and releases picker resources on close or project switch.
- `rpgkit-edit import-sheet` and `import-walker` use the same API and emit reopenable packs.
- Folder save safety distinguishes document dirtiness from asset dirtiness. Existing folder art no longer blocks a map-only save; newly imported/replaced art is still refused because a folder save cannot persist those bytes.
- README, Studio documentation, desktop instructions and the feature status table describe the implemented behavior and limits.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Delete generated build output, `bun run build:wasm` | exit 0; `pocketjs.wasm` 455,380 bytes |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0 |
| Final `bun run test` with normal tool PATH | **4,740 pass, 0 fail, 0 skip**, 732,837 assertions across 311 files, 629.63 s |
| Focused pack/API/CLI tests | **60 pass, 0 fail**, 459 assertions |
| Schema, pack and folder-save regression tests | **92 pass, 0 fail**, 1,204 assertions |
| Browser Studio offline-routed E2E | **1 pass, 0 fail**, 16 assertions |
| Linux Electron desktop E2E under Xvfb | **12 pass, 0 fail, 0 skip** |
| Clean frozen installs | root 528 packages; desktop 270 packages; lockfiles unchanged |
| Two independent CLI imports | exact byte match; 31,367 bytes, SHA-256 `1e5d44621ad974edf7ce1f335e74ade21ee3855e895ea9120840c10b178bfb04` |
| Diff and history hygiene | `git diff --check` passes; zero merge commits; no `bun.lock` change |

The first service-wrapped full-test attempt used a sanitized PATH without `ffmpeg`, so RPG Maker audio fixtures correctly took their built-in decoder fallback and five dependent expectations failed. That was an invalid harness environment, not a source failure: the two affected test files passed 42/42 after restoring the normal tool PATH, and the final complete suite above then passed 4,740/4,740.

## Non-Studio byte identity

After removing the test-only `preview-art` output, the fresh branch build and the `origin/main` build each contained 84 `.js`/`.pak` artifacts. Relative path sets were identical, with zero missing files, zero extra files and zero byte mismatches.

| Representative artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `meadow.js` | 688,044 | `22117f80659bea5f3a67a31aa7e04f0dc89cf1d53f960b72e91dcbcd4ff1bf08` |
| `sunstone.js` | 1,114,375 | `4b5c8575795bec8f14bc422a3403ff59902f8fc3c477e9f3de594a873776f525` |
| `kau1-audio.js` | 876,741 | `54ed953ac76f0ae460357a2b52a13de98a4bebbdc82138384e46cf0952e8db09` |
| `rmi-play.js` | 1,351,047 | `766e4c195b42e4ed4ac708cf71181ea778bb2869be285e49a0dd811972e7fd41` |

This closes the previous +72-byte regression without changing size pins: removing the unused schema generation keeps ordinary game bundles byte-identical.

## End-to-end and visual review

The browser test exercised the real file chooser, a 36×18 source with non-zero offset and spacing, the 2×1 grid preview, atomic undo/redo, palette selection, map painting, browser save/reopen and walker assignment. Its original-resolution dialog screenshot was opened manually: the labelled fields, grid borders, status line, preview and primary action were visible without clipping or overlap.

The Linux desktop test used the native picker bridge and verified cropped pixels, atomic history, painting, walker creation, export and pack reopen. Its broader suite also kept folder save, project art, play-test, engine checks and close-guard behavior green.

## Mutation strength

All five mutations ran in a disposable detached worktree and were restored before that worktree was deleted:

1. drop grid offset from crop coordinates — **CAUGHT**;
2. allow silent id overwrite — **CAUGHT**;
3. allow a smaller map-used replacement — **CAUGHT**;
4. fail to remove image bytes on undo — **CAUGHT**;
5. drop tile-sheet attachment to the selected map — **CAUGHT**.

Each targeted test exited nonzero with a failing assertion, while the mutation harness itself exited 0. The isolated worktree was clean afterward.

Subagent usage: 4 read-only agents audited schema compatibility, Playwright dependency placement, mutation strength and browser/desktop E2E coverage; their parallel checks saved review time and their conclusions were verified against the code and final gates.

PASS
