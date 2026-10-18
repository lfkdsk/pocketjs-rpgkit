# Studio common events, tile-sheet passage, and Windows packaging

Publication branch: `feat/studio-common-events-passage-windows`
Implementation and test candidate: `63b0aa551ade56cba91aae8f7dc33127f55d30a4`
Opening and final `origin/main`: `0ecb045ddf9a124284e0127c11c623c966078f84`
Pinned PocketJS: `7c9d1a10f8f232a639846c0b3c950a17f39921e5`

## Verdict

Common events are now first-class Studio documents: they can be browsed,
created, renamed, duplicated, deleted with reference protection, edited with
the existing command tree, explained, checked in Problems, and changed through
the same undoable edit protocol as map events. The CLI and MCP-facing tool
catalog expose the same operations.

Tile-sheet `defaultPassage`, per-cell pass/block exceptions, and directional
`dirBlock` walls are editable with history, visible on the atlas and map, and
use the runtime's exact precedence and direction-bit mapping. Sharded packs
retain their fixed atlas-boundary limitation and say so in the UI.

The desktop project now emits an unsigned x64 NSIS Windows installer, and the
desktop workflow has Linux and `windows-latest` package-and-smoke legs. The
same Playwright scenario opens a project, imports, saves and playtests on both
legs. A local cross-package completed and the Linux desktop smoke passed. No
hosted Windows run or URL is claimed: this delivery was forbidden to push, so
`workflow_dispatch` could not execute the unpushed workflow revision. That is
the remaining difference from a native Windows-hosted validation.

The optional interactive PNG-to-tileset/character importer was not implemented.
The existing local-PNG preview path remains unchanged; a separate follow-up is
recommended for grid selection, dimension validation and authored asset
updates.

## Common-event editing

The edit API adds six commands:

- `list-common-events` and `get-common-event` provide stable global addresses;
- `add-common-event`, `update-common-event`, `duplicate-common-event` and
  `delete-common-event` are normal mutations and therefore enter undo/redo and
  History;
- rename rewrites nested `common` calls in map and common-event command trees
  atomically;
- deletion returns `RESOURCE_IN_USE` with concrete caller locations and does
  not mutate until Studio explicitly confirms a forced retry;
- command-tree targets use an exclusive common-event address instead of a
  synthetic map/page address, so insert/update/move/delete command operations
  share the existing editor without weakening target validation.

Inline and sharded edit sessions implement the same behavior. The CLI exposes
the six commands directly, and the registered tool catalog exposes list, get,
add, update, duplicate and protected delete helpers. Proposal application
accepts the new mutations as well.

Studio adds a searchable Common Events group, create/rename/duplicate/delete
controls, trigger metadata, and the normal command inspector. Problems retain
common-event locations when diagnostics merge, navigate back to the correct
command, and distinguish common scopes from maps. Explain renders the same
recursive command analysis for a common event as for a map page.

## Tile-sheet passage editing

The new pure passage helper centralizes canonical cell lists, `dirBlock`
normalization, update operations, overlay geometry, and runtime precedence:
explicit `pass` wins over explicit `block`, which wins over
`defaultPassage`; an omitted default remains pass for compatibility.

The direction mapping is deliberately explicit and test-pinned:

| Direction | Runtime bit | Overlay edge |
| --- | ---: | --- |
| down | 1 | bottom |
| left | 2 | left |
| up | 4 | top |
| right | 8 | right |

The palette can set or clear the sheet default, set selected atlas cells to
default/pass/block, toggle each directional wall, and clear all walls. Every
gesture emits the existing `update-sheet` operation, so undo/redo and sharded
writeback need no parallel state channel. The atlas and map use the same
resolution helper. Fully blocked cells retain the passage fill; symmetric
`dirBlock` edges are solid purple, while map-cell one-way `dirEdges` keep their
existing blue/orange treatment.

Direct sheet controls remain available for a sharded pack because they modify
the pack shell. Painting map-derived one-way edges remains disabled at fixed
shard boundaries, with the limitation shown beside the controls.

## Windows desktop package and workflow

`studio-desktop` adds `dist:win`, targeting unsigned x64 NSIS and retaining an
unpacked directory. The helper build recognizes Windows and emits
`rpgkit-studio-helper.exe`; the Playwright runner discovers the Windows
executable path.

`.github/workflows/studio-desktop.yml` now runs a Linux/Windows matrix. Each
leg installs from frozen public lockfiles, builds wasm, packages the actual
application, verifies platform-specific package structure, then runs the same
desktop E2E. The Windows leg additionally requires exactly one non-empty x64
installer and uploads it for 14 days. The existing manual/tagged universal
macOS signing flow is unchanged, and no workflow step names or uses a private
registry.

On the delivery host, `bun run dist:win` initially exposed the expected missing
Wine dependency (`spawn wine ENOENT`). Re-running the identical command with a
task-local portable Wine runtime exited zero and produced:

| Output | Size | SHA-256 |
| --- | ---: | --- |
| `pocket-rpgkit-studio-0.2.0-x64-setup.exe` | 128,714,577 B | `85858c9aa1be9c87040262e4f764428babd08a08dc58115667727bb644a98b2b` |
| unpacked `Pocket RPG Kit Studio.exe` | 245,726,208 B | `4f76286e59c563254d2417303e83f67da373111e99f673167bbd11ded898affe` |

The cross-package proves electron-builder, the helper and NSIS inputs compose;
it is not represented as a native Windows execution. An additional Wine
silent-installer probe timed out after 120 seconds and is not acceptance
evidence. Native packaging, structure checks and the Playwright smoke will run
on the new `windows-latest` leg after publication.

## Automated and visual coverage

Focused unit coverage includes API history and reference protection, nested
rename rewriting, CLI round trips, sharded behavior, common-event Explain and
Problems navigation, passage precedence/normalization/direction geometry, and
Windows packaging/workflow contracts. The focused Windows contract suite is
3 pass, 0 fail.

Browser verification exercises common-event creation, rename, nested command
editing, reference-aware deletion, undo/redo, Problems navigation and Explain.
It also edits default/exception passage and all directional walls, undoes and
redoes the update, then samples semantic pixels. The isolated right-wall
fixture measured 28 purple pixels on the right edge and 0 on the left, making
an edge swap visible. The verifier ended `studio-verify: PASS`.

The Linux packaged desktop E2E ended 11 pass, 0 fail, 0 skip and includes
open-project, save, RPG Maker import, playtest, common-event editing and
tile-sheet passage editing. All regenerated desktop screenshots and the final
browser contact sheet were opened and inspected. The sheet-passage frame was
also inspected at original resolution; labels, selected cell, blocked fill and
purple directional edges were legible and aligned.

## Mutation strength

Each mutation ran in an isolated disposable worktree and was removed after the
discriminating test failed.

| Isolated mutation | Red result |
| --- | --- |
| Allow referenced common-event deletion without `RESOURCE_IN_USE` | protected-deletion API test failed |
| Swap a `dirBlock` direction bit/edge | direction-mask and geometry test failed |
| Bypass the edit session for a passage update | undo/redo history test failed |
| Rename a common event without rewriting callers | nested map/common caller test failed |

## Component gates

After removing `dist/`, the required final sequence completed against the
candidate:

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | pass |
| `bun run build:example` | pass |
| `bunx tsc --noEmit` | pass |
| `bun run test` | 4,646 pass, 0 fail, 0 skip; 731,960 assertions across 306 files |

No project schema, embedded schema, map schema identity, save format or
PocketJS pointer changed. Both repository lockfiles are unchanged.

## QuickJS unused-feature guard

The guard used interleaved main-candidate-candidate-main windows. The
single-parent comparison is against the opening main; the cumulative
comparison is against the performance-chain baseline. Negative percentages
are improvements. Both comparisons ended with zero regressions,
inconclusive cases or errors.

| Workload | Single-parent median | Cumulative median |
| --- | ---: | ---: |
| `sunstoneIdle` | +0.290% | -1.819% |
| `sunstoneWalk` | +0.135% | -2.175% |
| `sunstoneControlWalk` | -0.271% | -1.656% |
| `streamedRoam` | -0.095% | -0.520% |
| `battleScene` | +0.049% | -0.410% |
| `sunstoneIdleImmutable` | -0.126% | -1.735% |
| `sunstoneControlWalkImmutable` | -0.157% | -1.109% |
| `battleSceneImmutable` | -0.051% | -3.874% |

Both logs end with `PR1_QJS_COMPARISON_RESULT ... verdict=pass`; every
single-parent median regression is below the +3% limit.

## Consumer validation

### Wander

A disposable copy of Wander at
`311a01efeee9d6d2214dc49bc9354fa4253d3e0f` used the candidate component and
pinned PocketJS. Public frozen-lockfile install, component build, wasm rebuild,
TypeScript and the production web build passed. The post-build full suite
finished with 523 pass, 0 fail and 501,127 assertions across 45 files. The web
build produced both configured games.

### Tuxemon

A disposable copy of Tuxemon at
`4d69b549fa68656e6c0f4a1fbea43f45891a4ba9` used the same component and
PocketJS revisions. Public frozen-lockfile install, the full pinned-source
import, TypeScript, production build, wasm rebuild and CJK coverage check all
passed. The import regenerated 263 maps and 430 tileset entries without a
tracked-content diff. The affected CI importer group finished 55 pass, 0 fail
with 57,302 assertions.

The 60 Hz GB6 mainline replay passed 116,107 frames and preserved the committed
terminal state SHA-256
`748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`.

## Compatibility and hygiene

The candidate is a linear nine-commit series directly above final
`origin/main`; the merge base is exactly
`0ecb045ddf9a124284e0127c11c623c966078f84`, so no rebase was needed and there
is no merge commit. `git diff --check` passes. Neither lockfile is modified,
and generated desktop output remains ignored. No third-party game content or
restricted asset was added.

Subagent use: 3 — Maxwell implemented the common-event backend, Singer the
sheet-passage core, and Galileo the Windows packaging/workflow; parallelizing
the independent file groups saved integration time, while the primary agent
performed integration, visual review, mutation checks and every final gate.

PASS
