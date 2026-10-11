# RPG Maker text, follower, and vehicle polish

Candidate: `00dd29a864c10ce1ec0e51cc50a3ef80810794ff`
Base: `8c342c7048f4a595a1d5c737f07fcf3adad18bc9`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

All ten review leftovers are closed. The text importer and UI now preserve
RPG Maker choice colours and custom windowskin palettes; Studio keeps its last
layer control usable at laptop width; follower and vehicle timing now follows
MV/MZ; parked watercraft collide; airships have a ground shadow; vehicle music
imports, switches and restores; and save validation covers the full airship
altitude domain. Every targeted regression was killed by an isolated mutation.

| Item | Result | Focused evidence |
| --- | --- | --- |
| Choice `\C[n]` colour | PASS | Runtime, text-choice and icon-choice tests; two-resolution visual |
| Custom `Window.png` palette | PASS | Exact 32-colour fixture and malformed-input tests |
| 1024-wide Studio toolbar | PASS | Browser geometry/hit-test assertions and screenshots |
| Same-colour span merge | PASS | Exact span-array test |
| Follower step phase | PASS | Pure reducer and Session same-phase tests |
| Airship shadow | PASS | Projection, renderer and visual tests |
| Gather before airship lift | PASS | Pending-boarding lifecycle test |
| Parked vehicle collision | PASS | Boat/ship blocking and airship-entry test |
| Vehicle BGM | PASS | System import, command 140, lifecycle, save and editor tests |
| `airshipAltitude` validation | PASS | Finite/range/phase/tick correlation tests |

## Upstream semantics

The comparison used fixed upstream revisions, not current moving heads:

- RPG Maker MV: `rpgtkoolmv/corescript` at
  `182e31449707ba7e406db0485c44c2a9d11e2dcd`.
- RPG Maker MZ: `stak/rmmz-corescript` at
  `5ecc09ae5170c6aee71c7d9513e553e3dbea116b`.

The relevant stock behavior is:

- Choice rows call `drawTextEx`, so escape-driven colours apply to choices as
  well as messages: MV `Window_ChoiceList.js:110-113`; MZ
  `rmmz_windows.js:4431-4434`.
- Text colour `n` comes from the 8 by 4 grid in the lower-right windowskin,
  sampled at each 12-pixel cell's centre: MV `Window_Base.js:169-172`; MZ
  `rmmz_managers.js:1706-1709`.
- The player asks followers to chase in reverse order when its step begins, so
  the spaced chain starts interpolation in the same update: MV
  `Game_Player.js:584-589` and `Game_Followers.js:65-69`; MZ
  `rmmz_objects.js:8638-8642,8806-8810`.
- Get-on starts a gather and `updateVehicleGetOn` waits for both player motion
  and follower gathering before completing: MV `Game_Player.js:333-355,531-551`;
  MZ `rmmz_objects.js:8394-8416,8589-8610`.
- Vehicle collision checks parked boats and ships, but not an airship; the
  latter must remain enterable on the player's current cell: MV
  `Game_CharacterBase.js:191-204`; MZ `rmmz_objects.js:7091-7093`.
- The airship shadow remains on the ground and scales opacity with altitude:
  MV `Game_Vehicle.js:149-162`; MZ `rmmz_objects.js:9010-9016`.
- A vehicle plays its configured BGM on get-on, restores saved walking BGM on
  get-off, and command 140 replaces the configured track: MV
  `Game_Vehicle.js:120-141` and `Game_Interpreter.js:966-972`; MZ
  `rmmz_objects.js:8973-9002,10433-10438`.

## Text and Studio corrections

### Choice colour runs

`boxText` now returns both expanded text and parser colour spans. Choice
construction stores prompt and option spans in the modal; save validation
checks them; and both text-only and icon choice renderers retain the mapping
through wrapping, Unicode code-point offsets, selection, disabled rows,
marquee fallback and reactive modal replacement. An uncoloured run continues
to inherit the live theme/selection colour, while an explicit `\C[n]` run wins.

The focused tests cover prompt and option colours, cursor movement, modal
cloning, extension choices, wrapping and icon choices. The visual suite renders
independent 480x272 and 960x544 frames and asserts the expected coloured pixel
regions as well as the RGBA golden.

### Windowskin palette

The importer now finds `img/system/Window.png` case-insensitively, requires the
stock 192x192 layout, decodes it once, and samples the exact 32 centre pixels
`(102 + 12 * column, 150 + 12 * row)`. A missing windowskin keeps the stock
runtime palette implicit. A present but undecodable, malformed or wrongly sized
file fails import instead of silently claiming native fidelity.

The imported palette is stored in optional `system.rpgMakerText.colours`; no
schema break was needed because that field was already optional. Importer docs
now describe the native custom-palette behavior.

### Studio laptop breakpoint

At 901-1100 px the toolbar compacts spacing, hides nonessential text labels
and preserves the normal desktop three-column workspace. The existing
single-column breakpoint still begins below 901 px, and the 1440 px layout is
unchanged. The browser verifier's 1024x768 capture asserts that the Edges
button has nonzero geometry, is entirely within the toolbar, is the hit-test
target at its centre, and needs no horizontal scrolling.

### Same-colour normalization

The already-correct parser merge now has a direct regression test. Repeated
`\C[1]` and a zero-width reset/reselect sequence each produce one canonical
span, including an astral Unicode character whose parser offsets count code
points.

## Follower and vehicle corrections

### Same-phase followers

On a successful player-step start, every follower snapshots its predecessor's
current cell before any follower advances. The complete spaced chain therefore
starts interpolation in the player's phase while retaining deterministic trail
replay around corners. Gathering remains the separate converge-to-predecessor
path.

### Gather-gated boarding and airship shadow

Get-on first records a sparse `boarding` id and starts follower gathering. The
vehicle stays parked, the party stays visible and airship altitude remains zero
until the player is at rest and visible followers have converged. Only then is
`boarding` promoted to `riding`; an airship enters its 48-tick ascent.

The UI projects a small oval at ground position below the airship. It is absent
outside a ridden airship, stays below the raised sprite, and uses
`altitude / 16` opacity. The implementation adds no image asset or state field.

### Parked collision

The Session stamps same-map parked boats and ships into the passage table used
by ordinary movement, forced routes and path checks. It excludes the active
ride, off-map vehicles and airships. This is the stock MV/MZ distinction: an
airship is boarded from the current cell, while watercraft are boarded from an
adjacent faced cell.

### Vehicle BGM

The importer reads each vehicle's `System.json` BGM and maps event command 140
to additive `setVehicleBgm`. Empty track names mean an explicitly silent ride;
volume is clamped to 0-100, pitch to 50-150, and nonzero pan is honestly marked
Degraded because the host track model has no pan.

The runtime captures the exact walking track and position only after boarding
and gathering finish, starts the vehicle track (or silence), and restores the
captured track as soon as get-off is accepted. Command 140 changes the next
boarding without interrupting a current ride. Omitted vehicle BGM preserves the
legacy no-audio-change path, so projects that do not use it allocate neither the
saved walking slot nor any per-tick work.

The command is preserved across the schema, compiler, save validator,
world-preview/checker and exhaustive editor consumers. README, importer docs,
engine docs and the status matrix describe the final behavior.

### Altitude and transition validation

Save validation now rejects non-finite altitude, values outside 0-16, and
state combinations inconsistent with the 48-tick transition:

- ascending/descending altitude must equal `16 * phaseTick / 48`;
- cruising must be tick 48 at altitude 16;
- a non-airship ride (or no ride) must be grounded at tick 0 and altitude 0;
- simultaneous `boarding` and `riding` is invalid.

Legacy travel snapshots may omit `boarding`, and snapshots from projects that
omit vehicle BGM continue to use the old sparse audio shape.

## Schema compatibility

The schema change is additive: vehicle `bgm` and the `setVehicleBgm` command
are optional additions. The canonical identity is
`4f6e1e734edff23e4fbf0fb1bd18708fb56c7ce4d8fca99c01773b65d60efab8`;
the immediately preceding follower/vehicle identity
`6c9b447c5ded9beabeaf9a6814edf76ed3c9d742c1d21cc7f3cd267b67fd3010`
is first in the compatibility list.

`tests/fixtures/schema-compat/gen-6c9b447c/` contains a genuinely generated
predecessor sharded project and mid-game save, not a current fixture with its
hash edited. Compatibility tests open the project, restore the save, continue
play, verify the CHANGELOG/runtime identity table, and require a real fixture
for every compatible generation.

## Mutation testing

All mutations ran in isolated disposable worktrees and were restored between
runs. The reviewed checkout was never mutated.

| Deliberate regression | Focused result |
| --- | --- |
| Drop choice colour spans after parsing | `4 pass, 3 fail` |
| Skip `Window.png` extraction | `0 pass, 1 fail` |
| Stop merging adjacent same-colour spans | `0 pass, 1 fail` |
| Restore one-step-staggered follower propagation | `0 pass, 2 fail` |
| Hide the airship shadow | `0 pass, 1 fail` |
| Activate an airship immediately instead of pending gather | `0 pass, 1 fail` |
| Stop stamping parked watercraft into collision | `0 pass, 1 fail` |
| Remove altitude/phase correlation | `0 pass, 1 fail` |
| Remove the 901-1100 px Studio compaction | exactly two browser-verifier failures |
| Break System vehicle-BGM import | focused importer failure |
| Map command 140 to the wrong vehicle | focused event-import failure |
| Start vehicle music before gather completes | focused lifecycle failure |
| Omit boat/ship or airship walking-BGM restoration | both lifecycle paths failed |
| Corrupt predecessor compatibility identity | identity-table and real-fixture tests failed |
| Bypass compiled vehicle-BGM validation | malformed-audio test failed |

The restored travel mutation subset finished `43 pass, 0 fail, 226 expect()`;
the restored choice icon golden subset finished `19 pass, 0 fail`.

## Visual review

The game views were rendered independently at both target resolutions, then
nearest-neighbour enlarged 3x and opened for inspection:

- choice colour at 480x272 and 960x544: prompt and options retain distinct
  explicit runs; the selected row's uncoloured text still uses the live accent;
- text colour at both resolutions: the existing message palette remained
  unchanged;
- party walk at both resolutions: leader and two followers share the same
  interpolation phase while remaining one cell apart;
- airship at both resolutions: the craft is visibly raised and the oval shadow
  remains on the ground below it.

The 1024x768 and 1440x900 Studio captures were likewise enlarged 3x and opened.
At 1024 the complete Edges button is visible and clickable without horizontal
scroll; at 1440 the full labels and normal spacing remain. Tests also assert
semantic pixel regions and reducer state, so a uniformly wrong image cannot
pass on a pinned hash alone.

## Consumer bundle impact

Both consumers were built twice from the same detached checkout, changing only
the kit revision. `gzip` values use `gzip -n -9`.

| Consumer / output | Base bytes | Candidate bytes | Delta | Delta % |
| --- | ---: | ---: | ---: | ---: |
| Tuxemon `main.js` | 2,837,536 | 2,864,721 | +27,185 | +0.9580% |
| Tuxemon `main.js` gzip | 510,786 | 515,030 | +4,244 | +0.8309% |
| Tuxemon `main.pak` | 78,434,448 | 78,434,448 | 0 | 0% |
| Tuxemon `main.pak` gzip | 27,206,003 | 27,206,000 | -3 | -0.00001% |
| Wander `wander.js` | 898,261 | 914,506 | +16,245 | +1.8085% |
| Wander `wander.js` gzip | 190,114 | 192,419 | +2,305 | +1.2124% |
| Wander `wander.pak` | 1,132,768 | 1,132,768 | 0 | 0% |
| Wander `wander.pak` gzip | 73,952 | 73,952 | 0 | 0% |

The JavaScript manifests add only `ChoiceColourLine.tsx` and
`choice-colour.ts`; the remaining growth is in already bundled choice and
sparse travel modules. Tuxemon also uses the changed standard `GameView`,
travel projection, preview and schema data, while Wander supplies its own
renderer. Importer, Studio, tests and documentation are absent from both game
bundles.

Wander's 388-entry pak is byte-identical. Tuxemon's 5,825-entry pak has one
equal-length changed entry, the generated project shell, whose only recursive
JSON difference is the schema identity above.

## QuickJS performance

The pinned desktop QuickJS guest ran three windows per workload, 10,000
iterations per slot on one CPU. Every window used main -> candidate ->
candidate -> main; the acceptance value is the median of six direction-balanced
paired deltas.

| Unused-feature workload | Median candidate delta | Limit | Result |
| --- | ---: | ---: | --- |
| `sunstoneIdle` | +0.43% | <= +3% | PASS |
| `sunstoneWalk` | -1.88% | <= +3% | PASS |
| `streamedRoam` | +0.04% | <= +3% | PASS |

Projects that omit the new data therefore remain within the zero-cost feature
gate. Sparse state and early returns keep the new behavior off their frame path.

## Clean gates and determinism

The required sequence was run from a deleted `dist/` against the final
candidate:

1. `bun run build:wasm` — exit 0; web wasm 359,675 bytes.
2. `bun run build:example` — exit 0; 103 output files.
3. `bunx tsc --noEmit` — exit 0.
4. `bun run test` — **4,240 pass, 0 fail, 728,014 expect() calls, 269 files,
   592.73 s**.

Two complete `build:example` runs each produced 103 files and 127,267,101
bytes. Their sorted content manifests had the same tree SHA-256,
`62bb232d3cb57c5fcbd555548cd86e0431fcb23cbe891336917d3c3d2a098a1d`.

The ten implementation commits and this report commit all use
`lfkdsk <lfkdsk@gmail.com>`, contain no AI or Co-authored-by trailer, leave
`bun.lock` untouched, and retain the same PocketJS submodule revision.

subagent 使用：4 个 / 分别完成文本与 Studio 隔离变异、跟随与载具语义变异、载具 BGM 与 schema 变异、Studio breakpoint 实现核对；互相独立的核对并行完成，节省了时间，主代理复跑完整门禁、性能、消费者构建并汇总结论。
PASS
