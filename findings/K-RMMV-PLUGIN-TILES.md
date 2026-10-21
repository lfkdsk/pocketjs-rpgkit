# RPG Maker plugin commands and special tile traits

- Intended publish branch: `feat/rpgmaker-plugin-tiles`
- Rebased component baseline: `74802bf0`
- Implementation HEAD before this report: `e31aed1e`
- PocketJS revision: `4855f47b`

## Outcome

The RPG Maker MV/MZ importer now preserves plugin calls and plugin registry
data without executing source code. The runtime exposes registered calls to
the existing extension API, gives unregistered calls a visible resumable
fallback, and the static checker identifies calls that still need handlers.

Imported ladder, bush, and counter flags now remain sparse sheet traits rather
than degrading to passage alone. The session, battle rules, and renderer use
those traits for ladder facing, bush encounter progress, counter interaction,
and four-row bush depth. Transfer placement still does not increment Steps.

All changes are additive at the project/schema boundary. The implementation is
ready for integration after the gates and deviations recorded below.

## Plugin command bridge

- MV command 356 becomes `rpgmaker.pluginCommand` with the original command
  line under `{source:"MV", line}`.
- MZ command 357 becomes the same typed extension call with plugin name,
  command name, display name, the original nested argument object, and its
  annotations. A nested object/array fixture prevents flattening or
  stringifying one argument level.
- `js/plugins.js` declarations become inert `Project.plugins` data. The loader
  accepts the declaration array and JSON values but neither imports nor
  evaluates plugin implementation code.
- A game registers the normal extension command handler and routes on
  `args.source`, `args.plugin`, and `args.command`. Registered calls receive a
  deep-cloned payload and show no fallback.
- An unregistered call shows `[Plugin command not ported: ...]`, then resumes
  the owning fiber exactly once. Its live modal survives reducer autosave,
  restore, and rewind/refold at 60, 30, and 20 Hz.
- `rpgkit-check` emits `plugin-command-unregistered` for each imported call.
  Handler registration is game code and cannot be proven from project JSON,
  so the check is deliberately conservative; ordinary extension calls are
  not mistaken for imported plugin commands.
- Studio import, command preservation, Explain/Problems data, coverage totals,
  generated play fixtures, and importer documentation now agree with the live
  converter.

## Special tile behavior

### Ladder

The importer emits the tile IDs carrying RPG Maker's ladder flag. Passage
cooking reduces those sparse IDs to a one-bit per-cell feature mask. At the end
of every reference tick, the player and live map characters on ladder cells
face up. Turn and blocked-move attempts are normalized back to up at 60, 30,
and 20 Hz.

This is a deliberate strictness beyond stock MV/MZ. Stock corescript forces an
upward turn after a successful ladder movement, but a later standalone turn is
allowed. The kit keeps the task contract's persistent face-up lock for the
whole time a character occupies a ladder cell. The difference is documented
for game authors.

### Bush

The importer emits sparse bush IDs. A landed player-step hook receives the
destination cell's bush membership. RPG Maker encounter rules multiply step
progress by two in a bush, then compose that value with Encounter Half
(`×0.5`), ship travel (`×0.5`), and the airship freeze. Focused tables cover
every combination.

The asset cooker derives an optional bush-depth texture without mutating the
source pixels. Only the bottom four logical rows use relative alpha 128/255;
RGB and all upper rows remain unchanged. GameView selects that texture for one
actor node, so it does not duplicate or seam the sprite.

### Counter and Steps

Action interaction keeps the ordinary occupied-cell and front-cell priority.
Only when neither handles the action and the front cell has the counter trait
does the interpreter inspect exactly one additional cell in the same facing
direction. Tests cover all four directions and all three host rates.

Steps increment only on a committed player landing. A transfer is placement,
so its destination is not counted; forced successful movement still is. The
step/region state remains stable through save and restore.

## Upstream semantic anchors

The implementation notes pin exact upstream revisions and source lines in
`docs/rpgmaker-import.md`:

- MV: `rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`
- MZ: `stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`

The cited methods cover ladder detection/turning, bush depth, counter reach,
encounter progress, Encounter Half, vehicle encounter modifiers, and transfer
placement versus walking Steps.

## Schema and compatibility

- `Sheet.ladder`, `Sheet.bush`, and `Sheet.counter` are optional arrays. Root
  required fields and all predecessor meanings are unchanged.
- The normative schema, editor schema, changelog, identity hash, and
  compatibility chain were regenerated together. Two predecessor fixture
  generations prove old shells and saves still load.
- The compact-map codec retains byte identity for documents that omit the new
  arrays; explicit empty arrays remain distinct from absent fields.
- Generated importer output was run twice. The tracked files had no diff and
  the aggregate SHA-256 was
  `f809221e0f93b224622033e0cefe07cf034972548a0874bd2bcfbe96e0eb982d` both
  times.

Literal ordinary-app byte identity is not claimed. Shared interpreter/session
plumbing changed bundles even when a project does not author these traits. The
measured clean-build sizes versus the rebased baseline are:

| Bundle | Current bytes | Delta |
|---|---:|---:|
| Meadow | 692,566 | +4,522 |
| Sunstone | 1,120,900 | +6,525 |
| RPG Maker play fixture | 1,371,688 | +20,641 |
| Audio fixture | 883,205 | +6,464 |

The size pins name the shared additions. Reachability tests still prove that
ordinary bundles contain none of the optional RPG Maker presentation, battle,
or audio implementations. Runtime state stays sparse and the final QuickJS
guard below measures the required no-use hot paths directly.

## Visual verification

The committed bush-depth goldens are:

| Viewport | SHA-256 |
|---|---|
| 480×272 | `c2ceff880ab74571e90a0359be1f0898382665f249dd66cc72cbe4841a7a2e74` |
| 960×544 | `0fcd970ef3706c9d24509410f7be20c2cde399eb95a3aac35ddc893165fa3652` |

Both images were opened at exact 3× nearest-neighbour scale. The player is one
node, upper rows stay opaque, the bottom four logical rows show the underlying
grass through the actor, and neither resolution has a seam or duplicate image.
Semantic pixel assertions independently pin those rows to relative alpha
128/255 and the upper rows to 255/255.

## Mutation testing

Each mutation ran outside the delivery worktree:

| Mutation | Result |
|---|---|
| Stringify nested MZ argument values one level early | 252 pass, **2 fail** |
| Remove ladder-facing normalization | ladder behavior test fails |
| Remove bush encounter doubling | encounter composition test fails |
| Reverse counter reach direction | counter interaction test fails |
| Apply bush depth to one fewer row | semantic alpha-row test fails |

The first four are the specified mutations. The fifth independently proves the
golden hash is not the only visual oracle.

## Gates

| Gate | Result |
|---|---|
| Mandatory rebase | no merge commit; based on `74802bf0` |
| Clean PocketJS wasm build | pass; 455,380 bytes |
| Clean build of every example, editor, fixture, and preview | pass |
| `bunx tsc --noEmit` | pass, exit 0 |
| Focused plugin/tile/save suite | 229 pass, 0 fail |
| Bundle reachability and repin suite | 29 pass, 0 fail |
| Full component suite | 4,747 pass, 0 fail, 0 skip across 311 files |
| Import determinism | pass; identical aggregate hash on two runs |
| Schema drift/additive guard | pass |
| Mutation suite | all five mutations detected |
| QuickJS interleaved guard | FINAL_BENCH_PENDING |

The prior final interleaved QuickJS run, before the cold save-validator test
addition, passed with zero regressions, inconclusive cases, or errors. Its
branch-only medians were:

| Case | Median |
|---|---:|
| sunstoneIdle | +0.742899% |
| sunstoneWalk | -0.604988% |
| sunstoneControlWalk | +0.748229% |
| streamedRoam | -0.153878% |
| battleScene | -0.025173% |
| sunstoneIdleImmutable | +0.593589% |
| sunstoneControlWalkImmutable | -0.230135% |
| battleSceneImmutable | -0.734678% |

The largest positive median was +0.748229%, below the +3% limit. A final run
against the report HEAD will replace the pending row after system contention
clears.

## Commit hygiene

- All delivery commits use `lfkdsk <lfkdsk@gmail.com>` and Conventional
  Commits.
- There are no merge commits, AI/co-author trailers, machine paths, third-party
  game assets, or lockfile changes.
- Generated schema fixtures, importer fixtures, and visual goldens are tracked;
  build output and local caches are not.

Subagent usage: 4 read-only agents — Pauli reviewed movement/encounter architecture, McClintock reviewed plugin checker/tests, Noether reviewed tile rendering/goldens, and Euclid reviewed upstream semantics; parallel reading saved time, and the main agent verified their findings and ran every gate.

FINAL_VERDICT_PENDING
