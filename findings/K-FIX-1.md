# Frozen-scene screen advancement regression

Implementation tip before this report: `9ee7cce86fccb7c645f7e5be824ead56030079d2`
Base: `4929290c40bcd6625b6c8466482b5a57041f78f9`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

The regression is fixed. A frozen foreground advances `Game_Screen` only when
the active scene is a battle and the project registered the RPG Maker runtime
capability. The advancing subset is the stock behavior the kit implements:
fade, flash, shake, numbered pictures, and capability-owned tone/weather.
Kit-native named tints, camera/scroll, balloons, map-name banners, backdrops,
and the backdrop stack remain parked with the map. Ordinary projects therefore
recover their pre-regression byte behavior.

Frozen advancement is now copy-on-write. A live fold cannot mutate the
published predecessor or an attract keyframe, and a rewind into the middle of
the battle followed by replay is byte-identical to uninterrupted execution.
The two reported Tuxemon regressions pass, as do the complete component,
Tuxemon, and Wander suites. All eight interleaved QuickJS medians satisfy the
+3% gate.

## Root cause

`c2900879` added a generic `advanceScreenEffects` call to `tickFrozenWorld`.
That call had two independent faults:

1. It applied RPG Maker's battle-scene rule to every frozen scene and every
   project. It advanced kit-native map presentation as well as stock
   `Game_Screen` state. The accompanying removal of `screenWait` pause
   compensation was equally broad.
2. `foldSession` had only shallow-copied `interp`. The advancing helper mutates
   its `screen` argument, so the new frozen path also changed `s0.interp.screen`
   in place. That corrupted the predecessor/keyframe used by rewind and made
   replay depend on whether the state came from a live fold or a restored
   keyframe.

The spill audit found one further, presentation-side issue: the ordinary
`ScreenEffectsLayer` statically imported the concrete RPG Maker tone/weather
renderer. A project could omit the engine capability and still pay for those
nodes and helpers in its pass-1 module graph.

## Pinned upstream semantics

The behavioral comparison uses official RPG Maker MV core
`rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd` and the
public MZ v1.1.0 mirror
`stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`.

- MV `js/rpg_scenes/Scene_Battle.js:29-39` updates `$gameScreen` from the
  battle scene. `js/rpg_scenes/Scene_MenuBase.js:10-22` does not update it from
  a menu scene.
- MV `js/rpg_objects/Game_Screen.js:187-196` advances fade, tone, flash,
  shake, zoom, weather, and pictures. `js/rpg_objects/Game_Picture.js:138-170`
  owns picture movement, tone, and rotation clocks.
- MZ has the same scene distinction in `js/rmmz_scenes.js:1090-1093` and
  `js/rmmz_scenes.js:2959-2968`, and the corresponding screen/picture updates
  in `js/rmmz_objects.js:944-953` and `js/rmmz_objects.js:1225-1229`.

The kit implements stock fade/brightness, flash, shake, pictures, tone, and
weather. It has no RPG Maker zoom state; its camera is a separate map-owned
feature and is deliberately not treated as zoom. Menus and generic game
scenes retain the ordinary frozen-map rule.

## Implementation

### Capability and scene boundary

`rpgMakerGameScreenRuntime` accepts only a battle scene paired with the
project-bound RPG Maker runtime. `tickFrozenWorld` calls the selective updater,
which becomes a sparse no-op for ordinary projects, non-battle scenes, or a
missing screen record.

`screenWait` handling now follows the command that installed the wait. Stock
`screenFade`, `screenTone`, `weather`, `screenFlash`, `screenShake`,
`movePicture`, and `tintPicture` keep their original `since` while their clock
advances in a capable frozen battle. Named tint, camera, scroll, and balloon
waits receive `scene.pausedTicks` compensation because those clocks remained
parked.

### Selective and immutable advancement

`advanceRpgMakerGameScreen` factors the stock clocks out of the full generic
updater. It advances fade, flash, shake, pictures, and the optional
tone/weather hook, but never touches named tints, camera, balloons, the map
name, backdrop, or backdrop history.

Before a capable frozen fold, `foldSession` clones the sparse screen bank once.
The clone includes picture tween endpoints and the backdrop stack, so multiple
reference ticks in a low-host-rate fold mutate only the working copy. The
published predecessor, keyframe, backdrop entries, and hidden stack remain
unchanged.

### Presentation isolation

The base `ScreenEffectsLayer` now renders only the kit's backdrop, optional
injected child, named tint, and flash. `Krm2ScreenEffectsLayer` owns the
concrete tone/weather and numbered-picture layers, and
`krm2ScreenPresentation` injects it through the explicit `pocket-rpgkit/ui/krm2`
entry. The ordinary UI entry no longer exports or imports those concrete
implementations.

## Determinism and mutation strength

`tests/attract-keyframe.test.ts` contains two minimal byte-level timelines:

- an ordinary scene parks a waited native tint, rewinds into the open scene,
  replays, applies pause compensation, and finishes byte-identically;
- a declared RPG Maker battle advances a waited fade, rewinds into the open
  battle, replays, keeps the live wait clock, and finishes byte-identically.

A combined adversarial case covers the rebased immediate-route and bounded
backdrop work at the same boundary. During the battle, the stock fade reaches
zero while a kit-native tint remains at five; immediate player movement and
both backdrop frames stay frozen; the predecessor bytes do not change; rewind
rebuilds exactly the same mid-battle bytes; and movement resumes only after
the battle closes.

Two isolated mutations were discriminating:

- removing the frozen-screen copy-on-write made the RPG Maker replay mutate
  its keyframe/predecessor and fail the byte comparison;
- restoring the full generic updater made the ordinary timeline and the
  combined RPG Maker timeline advance the native tint, failing the pinned
  `left === 5` assertion.

## Semantic-spill audit

The audit covered the original screen/system series, the subsequent real-game
import work, the capability-isolation series, and the newly rebased immediate
movement/backdrop changes.

| Area | Result |
| --- | --- |
| `c2900879` session freeze and wait accounting | Leak found and fixed: both advancement and `screenWait` treatment now require a capable battle and distinguish stock from map-owned clocks |
| Screen reducer, save/restore, validation, preview, and interpreter state | Sparse/data-driven paths remain generic; tone/weather execution delegates through the registered runtime and no concrete RPG Maker module is statically imported |
| K-RPGM5 presentation | Additional leak found and fixed: tone/weather and picture presentation moved out of the base `GameView` graph into the KRM2 entry |
| K-RPGM6 importer/Studio additions | No further unconditional runtime semantics found; imported fixtures explicitly register capabilities and tileset/event data stays project-driven |
| K-PERF-1 text, choice, travel, followers, and vehicles | Existing engine/presentation contracts remain intact. The negative controls now check all eleven optional concrete modules, including the newly isolated screen layer |
| Rebased immediate routes and backdrop history | They remain map-owned and frozen; deep cloning and the combined rewind regression prevent predecessor or hidden-stack mutation |

`tests/rpgmaker-capability-bundle-isolation.test.ts` proves that Meadow and
Sunstone reach none of the eleven optional implementation modules while the
RPG Maker fixture reaches all eleven. The rebuilt bundle pins are 677,949 B
(Meadow), 1,101,603 B (Sunstone), and 1,290,718 B (rmi-play).
`tests/krm2-ui-bundle-isolation.test.ts` separately proves that tone, weather,
pictures, timer, map-name, and number-input presentation needles are absent
from Sunstone and present in the KRM2 fixture.

## Component gates

The final gate began after deleting `dist/` and ran on the rebased candidate:

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | pass; `pocketjs.wasm` 359,675 bytes |
| `bun run build:example` | pass; every example, fixture, editor, and density variant rebuilt; bundle-size pins matched |
| `bunx tsc --noEmit` | pass |
| `bun run test` | 4,552 pass, 0 fail, 0 skip; 730,416 assertions across 296 files in 578.93 s |

The existing screen, KRM2 HUD, and rain frames were also opened at original
resolution: `tests/goldens/ks1-screen-480x272.png`,
`tests/goldens/krm2-ui.hud.480x272.png`, and
`tests/goldens/krm5-rain.480x272.png`. The base screen composition, HUD,
tone/weather layering, particles, and text remained visually coherent. No
golden changed.

## QuickJS performance

The fixed-affinity benchmark ran three uncontended
main-candidate-candidate-main windows, 2,000 iterations and nine timing rounds
per slot. The table reports the median of the six paired deltas per case.

| Case | Median delta |
| --- | ---: |
| `battleScene` | +0.76% |
| `battleSceneImmutable` | +2.02% |
| `streamedRoam` | -0.98% |
| `sunstoneControlWalk` | +0.12% |
| `sunstoneControlWalkImmutable` | +1.59% |
| `sunstoneIdle` | -2.17% |
| `sunstoneIdleImmutable` | -0.90% |
| `sunstoneWalk` | -0.47% |

The worst median is +2.02%, below the +3% gate. Non-RPG Maker sessions retain
the sparse early exit; no screen bank means no clone or advancement work.

## Consumer validation

### Tuxemon

A detached worktree of game main `88347e8e` used component
`9ee7cce8` and PocketJS `862040bd`. With
`TUXEMON_SRC=/var/tmp/tuxemon-src`, frozen-lockfile install, wasm rebuild,
import, and the production build all passed. Import generated 263 maps, 430
TILESET entries, 160 NPC walkers plus the player, and 86 animated atlases.

The two reported regressions passed together: 30 pass, 0 fail, 198 assertions.
The complete built suite then passed with 1,343 pass, 4 optional Bag/START UI
skips, 0 fail, and 242,735 assertions across 158 files. In particular, the
Timber Cafe storage round-trip and the mid-locker rewind both pass.

An earlier preparatory run was started before the required production build.
It correctly stopped on a missing generated framework style module and eleven
battle fixtures that each said to run `bun run build` first. That run is not a
gate result; after the required build, the complete suite above passed.

### Wander

A detached worktree of Wander main `4245030` used the same component and
PocketJS revisions. Frozen-lockfile install, wasm rebuild, both application
bundles, and TypeScript passed. Its complete suite passed with 513 pass,
0 fail, and 500,937 assertions across 43 files.

Neither consumer worktree was committed; both disposable worktrees were
removed after validation.

## Compatibility and hygiene

- `src/data/schema.json`, `bun.lock`, and every committed golden are unchanged.
- The final remote check still resolves `origin/main` to `4929290c`; the
  candidate is rebased directly on that commit and contains no merge commit.
- Component commits use `lfkdsk <lfkdsk@gmail.com>` and contain no co-author
  footer.
- No PocketJS patch or submodule pointer change was needed.

## Follow-up boundary

Two stock-fidelity checks remain outside this regression:

1. validate a project that authors capability-owned `screenTone`/`weather`
   without registering the engine and presentation capabilities, instead of
   allowing an invisible waited effect;
2. compare and implement the relevant stock `Game_Screen.onBattleStart`
   clearing behavior before claiming full battle-entry parity.

These do not affect the reported frozen-clock regression or either consumer,
but should be handled together so authored stock screen state has one explicit
capability lifecycle.

subagent usage: 3 / rewind test design, semantic spill audit, upstream MV/MZ semantics / saved parallel review time
PASS
