# RPG Maker battle presentation delivery

## Result and revision

- Verdict: **PASS**.
- Intended published branch: `feat/rpgmaker-battle-presentation`.
- Final base: `origin/main` at `0ecb045ddf9a124284e0127c11c623c966078f84`.
- Validated implementation tip: `868c0faff53e4609b6b714474e57bf10e7f0ef59`.
- The final fetch left `origin/main` at the recorded base, so no additional
  rebase was necessary. The history contains no merge commit.
- `bun.lock` is unchanged. No PocketJS change was needed; the component and
  consumer checks used the repository's pinned PocketJS revision
  `7c9d1a10f8f232a639846c0b3c950a17f39921e5`.

The branch completes the retained-but-unpresented RPG Maker battle data path:
the importer now packages referenced battlebacks, battle audio and legacy
animation media; the opt-in battle reducer applies the corresponding map,
system and troop-page rules; and the opt-in UI paints the result. All fixture
JSON, PNG and audio media in this change are generated in-repository and contain
no third-party game content.

## Pinned upstream semantics

The implementation was checked against these fixed corescript revisions:

- RPG Maker MV: `rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`.
- RPG Maker MZ mirror: `stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`.

| Area | MV evidence | MZ evidence | Applied behavior |
|---|---|---|---|
| Battleback construction, map names and stock terrain fallback | `Spriteset_Battle.js:95-210`; `Game_Map.js:37-49,200-208,697-700` | `rmmz_sprites.js:1817-1949`; `rmmz_objects.js:6071-6084,6237-6245,6736-6742` | Explicit map names win. An unspecified overworld map uses the current vehicle or upper/lower autotile kind, with `Grassland` as the final fallback. `battleback1` is below `battleback2`. |
| Change Battle Back | `Game_Interpreter.js:1356-1359` | `rmmz_objects.js:10831-10834` | The override affects later battles during the current map visit and is replaced by the next map setup. |
| Battle BGM, result ME and restoration | `BattleManager.js:81-108,507-550`; `Game_System.js:132-153`; `Game_Vehicle.js:120-141` | `rmmz_managers.js:2301-2328,2865-2919`; `rmmz_objects.js:307-329,378-386,8973-8995` | Battle BGM replaces the active walking/vehicle mix. Victory or defeat ME starts with the result message over the restored map BGM/BGS; escape restores without ME. Dynamic system audio changes have the same later/current-battle scope as upstream. |
| Legacy numbered animation frame and timing model | `Sprite_Animation.js:62-67,180-230,243-307` | `rmmz_sprites.js:1189-1769,3270-3309` | Legacy frames advance every four 60 Hz reference ticks, use head/center/feet/screen origins, and apply timing SE, screen/target flash and hide from their leading edge. MZ legacy-compatible records use the same path. |
| Change Actor Images and front-view status | `Game_Interpreter.js:1589-1598`; `Game_Actor.js:595-610`; `Window_BattleStatus.js:44-89` | `rmmz_objects.js:4591-4610,11077-11086`; `rmmz_windows.js:6077-6109`; `rmmz_sprites.js:799-805,3662-3670` | The live actor owns changed character, face and battler identities. MZ battle status may paint the face; MV's stock front-view battle status remains text-only. |

## Delivered behavior

### Battlebacks

- Map `battleback1Name` and `battleback2Name`, stock overworld autotile kinds,
  map dimensions and only referenced battleback media are imported. Missing or
  corrupt images continue through the existing coverage/reporting path.
- Explicit map settings and Change Battle Back take priority. On an
  unspecified overworld map, a current vehicle selects the stock `Ship` pair;
  otherwise each layer independently checks the upper then lower autotile kind
  and finally `Grassland`. Independent fallback matters when only one layer's
  upper kind has a stock mapping.
- Change Battle Back is stored in map-local runtime state, so it affects later
  battles on the same visit without becoming a global project mutation.
- The UI stretches `battleback1` and then `battleback2` across the viewport in
  stock order, before battlers, animation overlays, tone/weather and windows.

Implementation anchors:
`src/rpgmaker-battle/battleback.ts:3-70`,
`src/rpgmaker-battle/rules.ts:963-986,2349-2370`,
`src/ui/rpgmaker-battle/index.tsx:174-248,306-325`, and
`tools/rpgmaker-import/project.ts:805-923`.

### Battle audio and result ME

- Battle entry suspends the complete active map-side BGM/BGS state and starts
  the imported/current system battle BGM. A vehicle does not select a second
  battle track; its currently playing mix is simply the mix that is suspended.
- Change Battle BGM changes subsequent battles and does not restart the current
  track. Change Victory ME and Change Defeat ME affect the current battle's
  later result, matching the system setting scope used by the corescripts.
- Victory and defeat atomically restore the suspended map mix and start the
  selected ME when the result message opens. The ME therefore overlays the
  restored BGM/BGS, which resumes automatically when the authored,
  media-derived ME duration expires. Escape restores the map mix without ME.
- Animation SE carries imported volume, pitch and pan. A target animation
  repeats timing SE for each non-screen target as the stock per-target sprite
  does; a screen animation plays it once.
- The generic engine boundary is an optional, type-only battle-effects
  contract. Validation and projection live in a cold module attached by the RPG
  Maker rules, leaving a project that does not opt into these battles on its
  previous engine and bundle path.

Implementation anchors:
`src/engine/battle-effects.ts:9-114`,
`src/engine/session.ts:2464-2510`,
`src/rpgmaker-battle/rules.ts:193-237,1408-1419,2185-2210,2752-2807`,
`tools/rpgmaker-import/battle-data.ts:323-340,665-667`, and
`tools/rpgmaker-import/project.ts:216-247`.

### Legacy numeric battle animations

- MV `Animations.json` cell timelines are cooked to immutable per-frame images;
  only referenced sheets and SE are packaged. Skill/item animations and Show
  Battle Animation use the same reducer marker and presentation path.
- Imported frames use the stock four-reference-tick cadence. Position 0/1/2
  anchors at the target's head/center/feet; position 3 anchors to the screen.
  Multi-target, actor-target and request-level mirroring are retained.
- SE, target flash, screen flash and target-hide windows are reducer-owned
  timeline data. Their first update is consumed on the timing's leading edge,
  as upstream does. The saved animation start tick is sufficient to reproduce
  the exact frame, flash and hide state after save/load, rewind or a different
  host frame rate.
- Hosts at 60, 30 and 20 Hz converge on the same reference-tick animation and
  audio states. Focused tests also exercise the engine's supported 4 Hz
  coalescing boundary.
- MZ records that still contain the legacy MV-shaped frame/cell timeline are
  accepted. Effekseer-only records have no equivalent cell timeline and remain
  explicitly dropped.

Implementation anchors:
`src/ui/rpgmaker-battle/animation-presentation.ts:8-145`,
`src/rpgmaker-battle/rules.ts:110-181,1394-1406,2089-2103`,
`tools/rpgmaker-import/animation.ts:1-244`, and
`tests/rpgmaker-battle-animation-ui.test.ts:21-145`.

### Changed actor images

- Change Actor Images imports and applies character name/index, face name/index
  and battler name to the saved live actor. The original database remains
  immutable.
- The optional formation/menu UI reads the current actor face for both MV and
  MZ. The MZ front-view battle-status HUD also reads the changed face. MV battle
  status deliberately remains text-only because that is the pinned MV
  front-view behavior.
- Face lookup preserves the full `faceName:faceIndex` identity; it does not
  collapse a changed index to cell zero.

Implementation anchors:
`src/ui/rpgmaker-face.ts:1-41`,
`src/ui/rpgmaker-formation/index.tsx:105-116`,
`src/ui/rpgmaker-battle/index.tsx:245-248,441-482`, and
`tests/rpgmaker-face-ui.test.ts:15-42`.

### Schema and compatibility

The schema change is additive: optional animation `flash.scope` and
`hideTarget` timing data were added without changing the meaning of existing
documents or save fields. The current canonical schema hash is
`24945cdb48da82c863a7e5f4c467698699ced3ba85cdb4cbdb43f10b2948fc34`;
the immediate compatible predecessor
`a59ec3e0a1ee74fe08fb75dff938e56b01b8b6b66ccfd102cb9dbb2866d23444`
is in the accepted identity chain with generated shell/save fixtures. The full
compatibility suite restored that predecessor and every other listed compatible
generation, then continued play.

Implementation anchors: `src/data/schema.json`,
`src/engine/schema-identity.ts:24-68`, and
`tests/schema-compat.test.ts:104-213`.

## Portable presentation approximations and retained limits

- PocketJS has no portable colour-matrix primitive. Imported `add`, `multiply`
  and `screen` animation cells are therefore blended deterministically into the
  cooked frame PNG. Flash overlays use deterministic source-over alpha. Normal
  cell blending and the timing geometry/cadence are exact.
- Side-view projects still use the kit's front-view battle renderer. Changed
  side-view battlers and changed walking sheets are retained in actor state but
  are not painted live. MZ Effekseer animations remain dropped.
- These facts are now stated consistently in `docs/rpgmaker-import.md`,
  `docs/capabilities.md` and `docs/status.md`; the old “retained without full
  presentation” wording was removed.

## Test fixtures, visual inspection and mutation strength

The generated Hollow fixture supplies two transparent battleback layers, an
asymmetric two-frame legacy animation, changed face/battler sheets and short
Ogg BGM/BGS/ME/SE clips. This makes layer order, position, frame timing, face
index and audio restoration distinguishable rather than merely executable.

Semantic pixel checks prove that the lower floor remains visible through the
upper layer's transparency and that the cyan cell in animation frame 1 lands at
the selected target while only that target is hidden. Both required viewports
were captured and their nearest-neighbour 3× versions were opened and inspected:

| Golden | SHA-256 | Visual check |
|---|---|---|
| `tests/goldens/rpgmaker-battle.presentation.480x272.png` | `70b9d9d2e4ccc51fdf2d29870958f06dededc954b0eca8c09954dcfd96640bbb` | Distinct floor and wall layers; cyan frame-1 cell aligned over target 0; target 1 remains visible. |
| `tests/goldens/rpgmaker-battle.presentation.960x544.png` | `b3f13a9e99965a392a97fb40f1bb9733c587b26fcaea7d0d56db7b9c14bd454b` | Same composition and target-relative placement at 2× logical scale. |
| `tests/goldens/krm5-battle.480x272.png` | `564e12d8cce5bfec5f10ab2973a49ac09c9b214d813592608ee7bbf3fb27c00b` | Battleback is correctly beneath the existing tone/weather and battle chrome. |
| `tests/goldens/krm5-battle.960x544.png` | `b3aed48445940ab7f2965c6b74c24a7e69897a4be4bee543dd7f9b04086e5e21` | High-resolution presentation retains the same layer order and readable HUD. |

Four isolated mutations were applied outside the delivery checkout and each was
killed by a purpose-specific assertion:

| Mutation | Detecting test behavior |
|---|---|
| Reverse `battleback1`/`battleback2` paint order | The semantic floor/wall colour assertion and battle presentation golden fail. |
| Complete a result without restoring the suspended map mix | The completion-ME assertion no longer sees restored map BGM/BGS under the ME. |
| Advance a legacy animation one reference tick early | The exact 100/103/104 frame-boundary test and frame-1 target pixel assertion fail. |
| Force every changed face to index zero | The `faceName:faceIndex` identity and live formation face tests fail. |

## Component gates

All commands ran from a clean delivery checkout after removing `dist/` where
required:

| Gate | Result |
|---|---|
| `bun run build:wasm` | Passed. |
| `bun run build:example` | Passed for every example and fixture. |
| `bunx tsc --noEmit` | Passed. |
| `bun run test` | `4674 pass`, `0 fail`, `0 skip`; 732,125 assertions across 306 files in 512.03 s. |
| Run `bun tests/fixtures/rmi-play/gen-assets.ts` twice | Both runs reproduced the committed bytes; the second run had no diff. |

Final application bundle sizes were:

| Consumer fixture | Bytes | Isolation meaning |
|---|---:|---|
| Meadow | 684,525 | Existing negative control unchanged. |
| Sunstone | 1,110,662 | Existing negative control unchanged exactly. |
| rmi-play | 1,345,550 | Opt-in positive control; +45,162 bytes for imported battle presentation media/code. |

The Sunstone pin was not relaxed. A transient 2,288-byte ordinary-consumer
increase was removed by moving optional result validation into the cold
battle-effects module and sharing the completion bank; runtime validation
coverage remains intact.

## QuickJS zero-cost guard

`tools/pr1-quickjs-bench.sh --guard e72978932c27a0723cdc15ca60016bf55fa69cfc`
ran the prescribed interleaved six-round, twelve-pair medians with no concurrent
subagent work. “Single” compares the start-of-work parent; “cumulative” is the
guard's cumulative main baseline. Positive values are regressions.

| Case | Single-parent median | Cumulative median |
|---|---:|---:|
| sunstoneIdle | +0.222% | -1.903% |
| sunstoneWalk | -0.081% | -2.165% |
| sunstoneControlWalk | -0.437% | -1.848% |
| streamedRoam | +0.151% | -1.278% |
| battleScene | +0.556% | -0.447% |
| sunstoneIdleImmutable | -0.234% | -2.668% |
| sunstoneControlWalkImmutable | -0.685% | -2.053% |
| battleSceneImmutable | -0.257% | -4.651% |

Both comparisons reported `verdict=pass`, `failed_cases=0`,
`inconclusive_cases=0`, `errors=0`; the overall guard reported no regression.
Every positive median is below the 3% limit, while the larger negative values
are improvements rather than hidden regressions.

## Consumer regression checks

### Wander

An isolated consumer checkout pointed its component submodule at the validated
tip and its nested PocketJS submodule at the component's pin. The correct clean
order was used: component/consumer build first, then tests and web output.

- `bun run build`: passed.
- Test suite: `523 pass`, `0 fail`, `0 skip` across 45 files.
- `bunx tsc --noEmit`: passed.
- `bun run web`: passed for both `wander` and `wander-online`.

### Tuxemon

An isolated Tuxemon checkout pointed its component submodule at the validated
tip. Reimport changed only the expected generated schema identity; the content
manifest and deterministic mainline terminal state remained unchanged.

- `bun run import`: passed; 263 maps, 430 terrain entries, 407 monsters and 260
  techniques were generated.
- `bunx tsc --noEmit`, `bun run build:wasm`, `bun run build` and
  `bun run check:cjk`: passed; all 2,645 fallback characters were covered.
- The battle/terrain CI group passed `361 / 361`; the additional
  battle/audio/presentation group passed `91 / 91`.
- The mainline journey completed 116,107 frames and 111 frozen battle
  placeholders (22 trainer, 89 wild), ending at `spyder_route3@4,6` with
  terminal state SHA-256
  `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`,
  unchanged from its pin.

## Documentation and review

The capabilities guide now shows the opt-in imports and art wiring. The RPG
Maker import guide records the exact priority, command scope, animation cadence,
portable approximations and remaining limitations. The status matrix marks the
battle presentation, audio and importer rows with their current Partial/Done
facts rather than claiming the imported data is unconsumed.

Subagent use: 3 — independent upstream-semantics, audio/import-state, and UI/test/documentation audits; this reduced elapsed review time, and the primary agent verified and integrated every conclusion.

PASS
