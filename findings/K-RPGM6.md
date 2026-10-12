# Real RPG Maker Projects and Studio Import

Implementation tip before this report: `98c41bbf`
Base: `06e0fd1e6032c2ad8f58ce91d98204b1dc72e8d6`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

The RPG Maker importer has now been exercised against three pinned public
games rather than only the two generated fixtures. All three import without a
crash and run through the real cooker and PocketJS host far enough to inspect
their opening map, dialogue and a front-view battle. The trials exposed four
general defects: standard encrypted deployment media was refused,
non-power-of-two imported art could not enter a pak, decoded dialogue did not
contribute to the baked glyph set, and a partial run-time tileset variant
discarded inherited terrain. Each now has a synthetic regression fixture and
focused test; no third-party game file, asset or dialogue is in this
repository.

This is not a claim that arbitrary RPG Maker games are reproduced perfectly.
Two small games have recognizable maps, readable dialogue and playable battle
presentation. The plugin-heavy GameDev game reaches battle, but its opening
controls scene is mostly black and a dialogue frame visibly contains the
importer's script-condition placeholder. Those outcomes agree with its
coverage report: JavaScript and plugin behavior remains visible but is not
executed.

Studio now exposes the import in both hosts. Chrome/Edge select a source
directory read-only, perform a browser-safe maps-and-images conversion, show
bilingual coverage and reasons, and open a self-contained pack only after an
explicit confirmation. The desktop app uses native source and destination
dialogs; its helper imports into a cancellable hidden sibling, refuses an
existing target, publishes by atomic rename, and returns only an opaque folder
token to the sandboxed page. Browser audio remains explicitly Dropped because
the page has no Ogg/M4A-to-QOA conversion host; desktop import includes audio.

The requested remaining limits are closed where the host can represent them:
MZ `\PX`, `\PY` and `\FS` now affect text layout through a deterministic
portable approximation; Encounter Half and boat/ship/airship encounter rules
feed the saved deterministic countdown; and tile-image events repaint when
Change Tileset selects another imported variant. Text layout controls remain
Degraded because font sizes are quantized and choice-list layout controls are
not supported. Bush encounter acceleration is still not modelled.

| Acceptance area | Result | Evidence |
| --- | --- | --- |
| K-RPGM5 review leftovers | PASS | three-channel tone, dangling tileset, inherited planes, tone persistence/rewind and formation-to-battle focused tests |
| Three real-project trials | PASS with disclosed fidelity limits | pinned sources, deterministic imports, coverage tables and nine manually inspected play frames |
| Trial defect regressions | PASS | synthetic encrypted-media, pak fitting, font-inventory and partial-variant tests |
| Remaining importer limits | PASS / Degraded where documented | multi-Hz text and encounter rules; imported tile-event journey |
| Browser Studio import | PASS | host/import unit tests, automated Chromium flow and two manually inspected screenshots |
| Desktop Studio import | PASS | helper tests and real Electron end-to-end test with native-dialog stubs |
| Schema and deterministic output | PASS | schema is byte-identical to base; both import passes match for all three public trials |
| Consumer size and unused-feature cost | PASS | all three consumer paks are byte-identical; JS deltas are attributed and inactive QuickJS medians are at most +0.27% |
| Isolated mutations | PASS | all five independent reversions make their focused synthetic tests fail |
| Cold build and complete test suite | PASS | Wasm, examples, TypeScript, web, desktop and all 4,453 tests pass with zero skips |

## Pinned upstream semantics

The behavioral comparison remains pinned to the official RPG Maker MV core
`rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`.
The public RPG Maker MZ v1.1.0 mirror
`stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`
is corroborating source only.

- Stock MV Change Window Color passes the editor parameter directly to
  `setWindowTone` (`js/rpg_objects/Game_Interpreter.js:954-958`). The MZ
  equivalent does the same (`rmmz_objects.js:10421-10425`). Project data uses
  three RGB entries; the kit accepts those and defaults gray to zero while
  retaining compatible four-entry inputs.
- MZ applies `PX`, `PY` and `FS` by changing the text state's x/y position and
  the current font size (`rmmz_windows.js:368-384`). The kit retains these
  controls as reducer-owned, saved layout spans rather than flattening them
  into spaces.
- MV decrements the encounter counter only when encounters are allowed and
  computes progress from bush, Encounter Half and ship state
  (`js/rpg_objects/Game_Player.js:469-488`). MZ has the same ordering and also
  excludes the airship (`rmmz_objects.js:8518-8542`). The kit implements
  Encounter Half, ship half rate and airship suppression; boat uses the
  ordinary rate, matching stock. Bush doubling remains documented as absent.
- An RPG Maker tile-image event retains a tile id rather than an independent
  character bitmap (`rmmz_objects.js:7303-7328`), and map passage includes
  those tile events (`rmmz_objects.js:6575-6586`). Imported event sprites now
  resolve that id through the active tileset's precomposed variant.
- Enemy visibility is authored per troop member and is separate from HP. The
  battle reducer therefore keeps an HP-positive hidden enemy untargetable
  until an Appear command reveals it; the implementation does not treat
  positive HP as visibility.

## K-RPGM5 review closure

Change Window Color command 138 now accepts the stock three-channel array and
normalizes it to `{r, g, b, gray: 0}`. The Stage MV fixture itself uses three
entries, so a converter that silently returns to the previous four-channel
requirement fails the ordinary generated-fixture path.

Change Tileset command 282 is validated against the imported database while
events are converted. A non-positive, malformed or missing id is Dropped with
its reason and emits no dangling reducer command. Valid commands are now
reported Native: the variant changes ground, upper art, ordinary and vehicle
passage, terrain, animation cells and tile-image event art as one active
selection. Partial hand-authored variants inherit every omitted base plane
rather than substituting empty arrays.

The in-progress screen-tone test now crosses both a save/load boundary and an
L-trigger rewind boundary before advancing again. The imported
formation-to-battle test changes party order on the map and asserts the next
battle's actual slots, rather than testing formation and battle setup in
isolation. The earlier K-RPGM5 report wording was also corrected: stock snow
travels on a linear down-left path, and the compatibility text no longer
implies unsupported tile-event or three-channel behavior.

## Real-project trials

Each checkout was pinned before inspection. The projects and all generated
trial outputs stayed in an external scratch directory. Only generic fixtures
written for this repository enter source control.

| Project | Engine and revision | Local-use terms | Import | Generated world | Command coverage (total / N / D / P / X) |
| --- | --- | --- | ---: | --- | ---: |
| [GameDev: The Beginning](https://github.com/yancharkin/game_jams/tree/a3c3ec739071ca285045025f9b619d17877a7193/%5Bigmc_2017%5D_gamedev_the_beginning) | MV 1.6.2, `a3c3ec739071ca285045025f9b619d17877a7193` | MIT code; CC BY-SA 4.0 assets | 4.06 s; 420,740 KiB max RSS | 8 maps, 6 sheets, 24 sprites | 1,718 / 1,383 / 112 / 167 / 56 |
| [The Basement](https://github.com/fluxrider/The_Basement/tree/0aea82564bf84299441c6b285e04977f5f11a68a) | MV 1.5.2, `0aea82564bf84299441c6b285e04977f5f11a68a` | MIT | 0.28 s; 158,784 KiB max RSS | 2 maps, 2 sheets, 6 sprites | 31 / 20 / 11 / 0 / 0 |
| [Strange Sea: Before](https://github.com/ShrLeeKNsword/strange_sea_before/tree/103d87c00c8903db841b9aad23dea30e26d6b1a8/ver_0.0.1) | MZ 1.0.0, `103d87c00c8903db841b9aad23dea30e26d6b1a8` | repository Apache-2.0 file; README additionally restricts use to study/education and forbids copying or republication, so validation was local only | 0.66 s; 309,456 KiB max RSS | 2 maps, 2 sheets, 24 sprites | 197 / 151 / 46 / 0 / 0 |
| **Combined** |  |  |  | 12 maps | **1,946 / 1,554 / 169 / 167 / 56** |

`N`, `D`, `P` and `X` mean Native, Degraded, Placeholder and Dropped. Native
uses are 79.9% of the combined commands, but this is a source-frequency
metric, not a fidelity score: one unsupported script can control an entire
scene.

The timed imports all exited zero. Their outputs were then wired through the
same real importer, asset cooker, RPG Maker battle integration, `GameView`
and Wasm renderer used by the generated fixture. Three frames per game were
opened manually: opening/first map, dialogue and battle.

| Project | Manual play result | Important limitation observed |
| --- | --- | --- |
| GameDev: The Beginning | Battle sprites, windows and actions render; dialogue reaches the kit message UI | The controls/opening map is mostly black and the dialogue frame shows a script-condition placeholder. The original presentation is picture-, plugin- and JavaScript-heavy, so the imported version is not a faithful play-through |
| The Basement | First map is recognizable, dialogue is readable, and the front-view battle is usable | Presentation is normalized to the kit's portable front-view UI |
| Strange Sea: Before | First map, Chinese dialogue and battle all render; Chinese glyphs are real rather than repeated tofu boxes | MZ positioning and font size are approximated, and Effekseer animation remains unsupported |

### Defects exposed and fixed

| Trial symptom | General fix | Synthetic discriminator |
| --- | --- | --- |
| Strange Sea deployment images/audio were rejected as encrypted | Recognize the standard RPG Maker header, validate the system key and XOR the first 16 payload bytes before decoding | generated encrypted PNG and Ogg fixtures in `rpgmaker-import.test.ts` and `rpgmaker-audio-media.test.ts` |
| Real pictures and battlers with non-power-of-two dimensions failed pak texture constraints | `fitPakTexture` nearest-neighbour resamples RGBA data to legal bounded power-of-two edges | exact output dimensions, corner pixels, source immutability and the 512-pixel cap in `pak-image.test.ts` |
| Imported Chinese dialogue rendered as missing glyphs | The cooker feeds decoded imported project/map/battle text files into `appTextInventory` before building the font | an explicit generated data file outside the entry module graph contributes an imported-only CJK character in `rmi-font-inventory.test.ts` |
| A sparse tileset variant lost base terrain and movement planes | Active variants inherit every omitted base visual, passage, terrain and animation plane | deliberately partial variant in `krm5-engine.test.ts` |

The fixes are generic and do not contain strings, keys or binary samples from
any of the trial games. Standard encrypted media support decrypts only with a
key already present in that project's `System.json`; it does not guess keys or
weaken missing/corrupt-media reporting.

## Remaining-feature closure

### MZ text layout controls

The text parser retains `PX`, `PY` and `FS` as positioned text runs. The
renderer scales MZ's source coordinates into the portable dialogue box and
maps authored font sizes onto the available font metrics. The run records are
inside the modal state, so 60/30/20 Hz, clone/change detection, save-derived
state and rewind/refold all see the same layout. Invalid arguments remain
literal or harmless instead of creating non-finite geometry.

This remains Degraded. Arbitrary raster font sizes cannot be reproduced by
the bitmap-font host, positions are scaled to the current kit window, and
choice-list uses of these controls are not laid out independently.

### Encounter Half and vehicles

The normalized battle extension stores encounter-rate factors in saved state.
Encounter Half and ship travel each contribute a one-half multiplier; together
they produce one quarter. Airship travel suppresses encounters and preserves
the pending countdown. Boat travel keeps the ordinary rate. The countdown and
vehicle/trait transitions are reducer-owned and covered at 60/30/20 Hz plus
save/load and rewind. Hidden living enemies remain excluded from target lists
until the stock Appear flow reveals them.

Bush doubling is still absent because the current imported passage data does
not expose a bush plane to the encounter reducer. It is called out in the
coverage reason and status documentation rather than silently counted Native.

### Tile-image event variants

Import precomposes the same tile id for every tileset variant reachable from a
map. `GameView` resolves an event's tile sprite against the current map-local
tileset selection and falls back only when that variant has no cooked event
art. An imported journey changes tileset, samples the event pixels, changes
back and verifies restoration. This is render-only lookup: event identity,
page selection and reducer state do not restart when its pixels change.

## Studio import

### Shared workflow and language

The `StudioHost` capability reports whether RPG Maker directory import is
available and why not. One shared modal owns progress, cancellation, readable
errors, exact four-way coverage totals, the Placeholder/Dropped reason list,
warnings and the explicit **Open result** transition. Its English and Chinese
strings are kept in one typed catalogue. A failed or cancelled conversion
leaves the current document open.

### Browser

Chrome/Edge's directory picker supplies a read-only virtual source. The
browser adapter implements path normalization, case-insensitive RPG Maker
media lookup and standard encrypted-image decoding without exposing a real
path. It uses the same importer core through a browser environment abstraction
and emits a sharded Studio pack containing maps and generated PNGs. Because
the browser has no ffmpeg/QOA process, referenced Ogg/M4A is listed as Dropped
with that exact reason. The result is checked against ordinary Studio pack and
image limits before it can open.

Automated Chromium coverage exercises success, the bilingual summary and
reasons, delayed Open result, cancellation and a readable malformed-project
error. The complete Studio verifier also passed with 287 requests and a clean
console.

Two checked-in screenshots were opened at their real sizes and again at three
times their dimensions for manual review. The wide English modal keeps the project behind it visible,
shows the four coverage cards and individual reasons without clipping. The
compact two-density Chinese modal wraps the same content without horizontal
overflow, and its Open result and Cancel actions remain visible.

| Screenshot | SHA-256 |
| --- | --- |
| `docs/screenshots/studio/studio-rpgmaker-import-wide.png` | `eb0e2c1d29dcdcf0c2c43fe6a8d8fefe9ea811553ff1860b89080d221da4ad2f` |
| `docs/screenshots/studio/studio-rpgmaker-import-compact-2x.png` | `6a219d517e0475582a9e94905a3dcd8616c4e5afbeb7a2f80488f04330356e82` |

### Desktop

The sandboxed renderer asks the preload bridge only for import actions and
opaque results. The main process owns both native dialogs and validates the
selected source and destination. The helper runs the existing CLI importer in
process, streams progress, and honors cancellation. It writes to a unique
hidden sibling, checks that the final child does not exist, and publishes with
one rename; cancellation or failure removes only that verified staging child.
The destination is never overwritten. Opening the result uses the same opaque
folder-token path as an ordinary desktop Open Folder action.

Helper tests distinguish success, cancellation, malformed input, existing
destinations and cleanup. The real packaged Electron end-to-end suite drives
the import flow with native-dialog stubs and confirms that the published
project opens. It passed 10 tests with zero failures and zero skips.

## Coverage and documentation

The static 107-command catalogue now contains 94 Native, 9 Degraded, 3
Placeholder and 1 Dropped entries. The two generated fixtures measure:

| Fixture | Uses | Native | Degraded | Placeholder | Dropped | Native rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hollow MZ | 124 | 112 | 10 | 2 | 0 | 90.3% |
| Stage MV | 61 | 51 | 9 | 1 | 0 | 83.6% |
| Combined | 185 | 163 | 19 | 3 | 0 | 88.1% |

Change Tileset is Native now that tile-image events follow active art. Change
Window Color, Tint Screen and the MZ text layout controls stay Degraded where
the portable visual projection is intentionally approximate. Documentation
describes standard encrypted media, browser audio's explicit drop, all three
real trials, both Studio hosts and the remaining bush/font/layout limits.

## Determinism, schema and compatibility

The post-rebase trial import was run twice into independent output roots. The
87 GameDev files, 19 Basement files and 39 Strange Sea files were byte-for-byte
identical between passes. The timed first pass exited zero for every project;
the table above records its wall time and maximum resident set.

Text-layout controls and encounter-rate behavior are tested at 60, 30 and 20
Hz. Their focused suites also cross save/load and L-trigger rewind/refold
boundaries. Screen tone persists through an in-progress save/load and rewind,
and the imported journey changes and restores tile-event art without changing
event identity. These tests all participate in the complete green manifest.

This branch adds no project-schema field. `src/data/schema.json` is
byte-identical to base with SHA-256
`37177b01a7825a112e0f9fc349f85a4280309e4a1b3b550e5af45c778c93c5f1`,
and `MAP_SCHEMA_HASH` remains
`f3a5eb5da11bb5eed3fcad2f7e04409883b06f68addeeb48f64d2b3e6afd7db1`.
The schema-compatibility test passes, so the schema condition is stronger than
additive-only: it is unchanged.

## Mutation testing

Each mutation ran in its own detached worktree. No mutation touched the
implementation checkout.

| Isolated mutation | Discriminating command | Red result |
| --- | --- | --- |
| Remove the 16-byte XOR-prefix loop | encrypted audio plus encrypted-window import tests | 0 pass, 2 fail: corrupt audio and bad PNG signature |
| Return non-power-of-two art unchanged | `pak-image.test.ts` | 1 pass, 3 fail: dimensions, cap and malformed-input validation |
| Omit explicit imported data files from the text inventory | `rmi-font-inventory.test.ts` | 2 pass, 1 fail: imported-only `七` disappears |
| Restore the old four-channel-only window tone parser | three-channel command 138 event test | 0 pass, 1 fail: the stock RGB command is missing |
| Return the base tile-event sprite for every tileset | active tile-event presentation test | 0 pass, 1 fail: `tile-3-4` stays `tile-1-4` |

The text-inventory mutation initially revealed useful redundancy: the committed
play fixture's generated module is also in the entry module graph. A second
self-authored case now places `七` in an explicit generated data file outside
that graph. The normal test passes and dropping explicit file collection makes
it fail, directly distinguishing the production contract.

## Consumer size and QuickJS

The same pinned consumer revisions were built once against base and once
against candidate. The candidate build used `18adbd73`; the later `98c41bbf`
commit changes only a test and cannot enter a consumer bundle.

| Consumer artifact | Raw JS base -> candidate | gzip base -> candidate | Pak |
| --- | ---: | ---: | ---: |
| Pocket Tuxemon `dd9cf21e` | 2,119,229 -> 2,126,720 B; +7,491 (+0.353%) | 483,793 -> 485,170 B; +1,377 (+0.285%) | 80,279,984 B, byte-identical |
| Wander `2d6768ec` | 936,607 -> 945,496 B; +8,889 (+0.949%) | 197,034 -> 198,690 B; +1,656 (+0.840%) | 1,132,768 B, byte-identical |
| Wander Online `2d6768ec` | 1,158,638 -> 1,159,748 B; +1,110 (+0.096%) | 247,427 -> 247,626 B; +199 (+0.080%) | 2,543,120 B, byte-identical |

The paks' matching SHA-256 values confirm that no consumer asset changed. The
small JS deltas come from shared `GameView`, text-flow and RPG runtime support;
they are not media or third-party-project payload. The kit's own Sunstone
example likewise moves from 1,150,034 to 1,161,185 raw bytes and 235,497 to
237,603 gzip bytes while its 3,344,384-byte pak stays fixed; its bundle-budget
test attributes the 11,151-byte raw delta.

QuickJS used the pinned PocketJS host, 2,000 iterations per case and three
main -> candidate -> candidate -> main windows. Timed guests were affinitized
to CPU 15 after a three-second preflight showed that physical core's two
threads 93.65% and 92.31% idle. No subagent or other task-owned build ran
during timing. All jitter, including isolated scheduling spikes, remains in
the six neighboring-pair samples; the median is the declared result.

| Inactive workload | Six-pair median | Pair range | Result |
| --- | ---: | ---: | --- |
| `sunstoneIdle` | -0.79% | -4.08% to +14.70% | PASS |
| `sunstoneWalk` | +0.27% | -4.84% to +15.70% | PASS |
| `streamedRoam` | -1.06% | -8.54% to +18.73% | PASS |

Every inactive median is below the +3% regression limit. The benchmark pins
candidate `98c41bbf`, base `06e0fd1e`, PocketJS `862040bd`, and bundle hashes
`2f252f0206a60aec8dcc9ce651c712fc6e77e7d1c583464f365b11c2399fe80d`
and `e610b267c68638b790e538f557f0088f915adbe917f89b85c94a1bc02492d5f6`.

## Final gates

After removing `dist/`, `bun run build:wasm` exited zero and produced a
359,675-byte Wasm core. `bun run build:example`, `bunx tsc --noEmit`,
`bun run web`, and the Studio desktop `bun run build` all exited zero.

The complete 288-file test manifest was run in twelve deterministic groups to
stay within the executor cap. Three stale size/coverage snapshots failed on
the first pass, were corrected to the actual post-rebase outputs, and their
two affected groups then exited zero. The subsequent explicit-file inventory
test adds one passing case. Final aggregate: **4,453 pass, 0 fail, 0 skip**.

The full Chromium Studio verifier served 287 requests with no verifier failure
and no console error; the browser RPG Maker import result reached the delayed
Open result state. The packaged Electron end-to-end flow passed 10 tests with
zero failures and zero skips. Both lockfiles are unchanged, staged-file checks
contain no lockfile, and the diff contains no public-project asset, dialogue,
encryption key, real-project screenshot or generated trial output.

Subagent usage: 7 agents — real-project licensing/play trials, remaining-limit semantics, Studio architecture, importer core, browser UI and desktop workflow — ran independent investigations and implementations; this saved time by overlapping source comparison, fixture design and host-specific work.

PASS
