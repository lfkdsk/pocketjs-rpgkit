# RPG Maker bush follow-up

- Delivery branch: `main` (eight implementation commits above component baseline `318df0d0`); PocketJS `4855f47b`.
- Previous attempt was interrupted during its final full test run when machine memory exhaustion caused systemd-oomd to terminate the fleet unit. The eight committed changes were intact. This continuation reset to `be8c5c94`, initialized the pinned submodule, checked that `origin/main` remained the ancestor baseline, and reran the gates serially. No merge or push was made.

## Completion audit

1. Followers and vehicles: `src/ui/GameView.tsx:832-836` passes the current passage/bush texture map to `TravelActors`; `src/ui/TravelActors.tsx:60-75` updates on each active frame. `src/ui/travel-actors.ts:89-153` uses each actor's committed cell and source; parked boats/ships may fade, airships may not. The ridden vehicle is hidden and uses the player node; `src/ui/GameView.tsx:393-399` explicitly excludes the ridden airship. `tests/travel-render.test.ts:89-108` pins the actor kinds and positions.
2. Non-power-of-two static sprites: `tools/lib/pak-image.ts:18-45,81-96` preserves authored rows by transparent padding and masks relative to `drawnHeight`; `tests/fixtures/rmi-play/gen-assets.ts:237-252` uses the authored height for eligible static actors. `tests/pak-image.test.ts:38-49` uses a 3×5 actor padded to 4×8 and checks the actual foot rows, padding, and unchanged original bytes.
3. Journey: `tests/travel-session.test.ts:669-708` crosses two bush cells on a fixture map with imported battle data; checks encounter remaining 10→8→6, follower bush source, envelope restore, and rewind/replay at 60/30/20 Hz. The pre-existing encounter-composition table covers Encounter Half, boat, ship, and airship. `tests/krm5-visual.test.ts:290-324` renders the imported follower at both 480×272 and 960×544; checks one follower node, only the bottom four logical rows change, and each changed RGB pixel agrees with 128/255 actor-over-ground compositing. Goldens: `tests/goldens/krm5-bush-follower.480x272.png` SHA-256 `634ef4958cee241742ac6cde5ac3b21044a7dc4830ac0222effee85fc9a0619d`; `tests/goldens/krm5-bush-follower.960x544.png` SHA-256 `6dc70511226d0563b0215fe55843d0995983051a925db8a93d94257a89e8d3a1`. Their dimensions were checked with `file`; this continuation did not have a visual image viewer available, so it does not claim an additional manual 3× inspection. Pixel assertions and full-suite render goldens did pass.

The behavior and limitations are recorded in `docs/rpgmaker-import.md:342-362` and `docs/status.md:51`. Earlier work pinned MV/MZ corescript revisions and bush/encounter source lines in `docs/rpgmaker-import.md:352-380`; no upstream behavior beyond those documented anchors is asserted here. Bundle guards were repinned in the eight commits, with the shared-view size delta explained in their test comments. No schema, package manifest, or lockfile was modified.

## Isolated mutations

Each mutation was applied only to a detached worktree under ignored `dist/mut-bush` and tested, then restored before the next mutation. The detached worktree has been removed; delivery sources remained unchanged.

| Mutation | Focused result | Catch |
| --- | --- | --- |
| Omit follower `bushSrc` in travel projection | 21 pass, 2 fail | `travel-render` and journey source assertions |
| Mask padded texture rows instead of authored rows | 6 pass, 1 fail | 3×5 foot-row alpha assertion |
| Replace bush encounter ×2 with ×1 | 18 pass, 1 fail | journey expects 10→8 but observes 10→9 |
| Permit bush mask on airships | 3 pass, 1 fail | airship source expected `idle-up`, observed `airship-bush` |

## Gates

After `rm -rf dist`, the gates were executed one at a time: `bun run build:wasm` passed (455380-byte wasm); `bun run build:example` passed; `bunx tsc --noEmit` passed (exit 0); `bun run test` passed. The complete test log was stored at ignored `dist/bush-test.log` and scanned for `(skip)` and `(todo)` markers (both zero). Its verbatim terminal summary:

    4795 pass
    0 fail
    734795 expect() calls
    Ran 4795 tests across 311 files. [575.72s]

`git diff --check` passed and the tracked worktree was clean before this report. No background process was started. Subagent usage: 0; pioneer single-action protocol prevented parallel delegates; all audit and mutations were performed serially.

PASS