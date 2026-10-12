# RPG Maker Screen and System Commands

Implementation tip before this report: `371835ba7c94e07ae65e7b78dcd51f5df5152c55`
Base: `0aecc05a6f911208cc5df8041fd00e76a6f35a1b`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

Tint Screen, Set Weather Effect, Change Tileset, Change Window Color and
Change Formation Access now import into reducer-owned commands and execute on
maps and, where applicable, in battle. Their authoritative state is sparse,
saved, rewound and advanced by the fixed reference clock, so authored waits
and transitions produce the same result at 60, 30 and 20 Hz. The importer
precomposes alternate tileset planes, the shared presentation layer paints
tone and deterministic weather on every supported host, and the optional
formation overlay changes both follower and battle order.

The open battle-review items are also closed. Force Action consumes the
subject's queued ordinary action, Transform rebuilds its pending action,
zero encounter weights stay zero, state removal uses message 4, unrestricted
scope-0 skills have no target, and the victory path directly proves the
expected learned skill. Two earlier review requests that contradicted the
pinned MV source were not applied: explicit unavailable targets use stock
smooth retargeting, and encounter disabling freezes the countdown.

The result is intentionally Partial rather than a claim of pixel-identical
RPG Maker presentation. PocketJS has no portable colour-matrix primitive, so
screen tone uses a documented deterministic source-over approximation;
runtime tileset changes cannot replace tile-image event art; window colour is
projected onto flat kit chrome rather than a windowskin shader; and swapping
the party leader does not change the project-level walking sprite.

| Acceptance area | Result | Focused evidence |
| --- | --- | --- |
| K-RPGM4/K-RPGM3 review closure | PASS | adversarial turn-one Force Action, Transform, encounter-weight, state-message, scope-0 and victory-skill tests |
| Tint Screen (223) | PASS / Degraded presentation | exact signed reducer state, reference-clock tween, map/battle projection, save/load/rewind/cadence tests |
| Set Weather Effect (236) | PASS | rain/storm/snow, stock particle count and motion, deterministic seed/clock, waits and persistence |
| Change Tileset (282) | PASS / Degraded tile-event art | art and all collision/terrain planes switch atomically and persist |
| Window Color (138) | PASS / Degraded projection | stock three-channel RGB imports with neutral gray; RGB changes message, choice, menu and battle chrome |
| Formation Access (137) | PASS / Degraded player art | access gate and two-selection swap feed followers and battle order |
| Fixtures, coverage and compatibility | PASS | both real imports, additive schema identity and genuine predecessor shell/save fixtures |
| Visual review and mutations | PASS | ten two-tier goldens, two 3x review sheets, semantic pixels and all required mutants red |
| Consumers and QuickJS | PASS | deltas attributed; inactive ABBA medians below +3%; power-nine weather measured separately |
| Cold gates | PASS | cold wasm/example/typecheck and exact 284-file test manifest, 4,416 pass / 0 fail |

## Pinned upstream semantics

The comparison uses RPG Maker MV official core
`rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`.
The public MZ v1.1.0 mirror
`stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`
is corroborating source only.

At the pinned MV revision:

- Formation and window colour are `Game_Interpreter.command137/138`
  (`Game_Interpreter.js:944-958`); formation uses the two-confirm
  `Scene_Menu.swapOrder` flow (`Scene_Menu.js:106-127`), and windows consume
  only RGB from the saved tone (`Window_Base.js:85-88`).
- Tint and weather start their transitions and optionally install a wait
  (`Game_Interpreter.js:1149-1156,1236-1245`). `Game_Screen` uses weighted
  per-frame interpolation (`Game_Screen.js:214-220`), while `Weather` owns
  the `power * 10` population and stock shape/movement/respawn rules
  (`Weather.js:64-70,95-108`).
- Change Tileset waits until the target tileset images are ready and then
  refreshes the map (`Game_Interpreter.js:1333-1352`;
  `Game_Map.js:692-695`).
- Force Action clears the battler's actions before creating the forced one,
  and BattleManager removes the subject from the remaining action battlers
  (`Game_Battler.js:328-340`; `BattleManager.js:461-467`). Transform calls
  `makeActions` when the enemy already has actions
  (`Game_Enemy.js:180-190`).
- An explicit live-target action's `targetsForOpponents` path calls
  `smoothTarget`, which falls back to the first living member when the indexed
  member is unavailable (`Game_Action.js:301-317`; the `smoothTarget`
  implementation is `Game_Unit.js:83-89`). The earlier request that
  an explicit dead/hidden target must whiff was therefore disproved and was
  not reintroduced.
- `Game_Player.updateEncounterCount` decrements only when `canEncounter` is
  true, and encounter-disabled makes that predicate false
  (`Game_Player.js:469-477`). The imported deterministic countdown therefore
  remains frozen while disabled. Its private counter is deliberately reseeded
  when the integration executes command 136; that existing integration
  contract is retained and is not presented as stock `makeEncounterCount`.
- Removed states always present `message4`
  (`Window_BattleLog.js:510-517`). `Game_Action.makeTargets` returns no
  ordinary target for scope 0 but lets confusion choose its own target first
  (`Game_Action.js:261-270`).

These anchors also appear beside the command documentation in
`docs/rpgmaker-import.md`; the implementation and tests below use them rather
than inferred behavior.

## Review-leftover closure

### Force Action and Transform

The forced-action reducer now removes every remaining queued ordinary action
for the subject before trying the forced skill. This also happens when the
forced skill id is invalid, matching stock `clearActions` rather than allowing
the old normal action to leak through. A turn-one page is the discriminating
case: the forced action occurs, and the subject does not act a second time
from the queue. An isolated mutation that retained the queued action makes
that test red.

Enemy Transform replaces parameters, traits, identity and the current-turn
action choice. If the transformed enemy still has a queued slot, the reducer
selects a legal action from the new enemy definition instead of executing the
old definition's skill.

The victory E2E now asserts the exact learned skill id at 60, 30 and 20 Hz,
not merely the resulting level. Stock smooth target fallback and the already
verified encounter integration described above remain locked by focused
tests instead of being changed back to disproved review suggestions.

### Remaining K-RPGM3 items

- Imported encounter entries retain an authored weight of zero. Selection
  ignores them naturally unless the table itself has no positive weight;
  import no longer rewrites zero to one.
- State removal uses `message4` for both actors and enemies.
- An unrestricted scope-0 action pays its resource cost and emits its use
  message but selects no target. Confusion restrictions still redirect the
  action because stock evaluates confusion before scope.

Focused tests cover all three behaviors, including variants that would pass
under the previous implementation, so they are not documentation-only fixes.

## Screen tone

The reducer stores exact signed red, green and blue channels in the authored
range plus gray, the current and target descriptors, remaining reference
ticks, and the wait relationship. A new command starts from the interpolated
current value; zero-duration commands land immediately. The shared session
clock advances this state on maps, in battle and while a scene freezes normal
map input. Save/load and rewind preserve an in-progress transition.

`ScreenToneWeatherLayer` is mounted below numbered pictures and below battle
windows. Because PocketJS exposes portable rectangles and opacity but not a
colour matrix, the renderer applies grayscale first, complementary darkening
second and positive-channel brightening last using source-over layers. The
exact signed descriptor remains authoritative in the save; only presentation
is approximate. Unit and visual tests sample both tint signs and gray-channel
behavior so the old single-colour overlay cannot satisfy the suite.

## Deterministic weather

Rain, storm and snow retain type, power, current/target power, remaining
transition ticks, a serialized seed and a serialized reference clock. Power
is clamped to the RPG Maker range and projects `floor(power * 10)` particles;
power 9 therefore projects 90. Particle position, phase, opacity and respawn
are pure functions of seed, clock, particle index and viewport. No particle
array enters the save and no per-frame structure is created or destroyed.

The shapes and motion follow the pinned stock rules: rain and storm move
down-left with distinct streak geometry and velocity; snow drifts more slowly
on a linear down-left path; each type fades and respawns through
the stock ranges. The same layer remains active when battle replaces the map.
Tests compare 60/30/20 Hz, save/load, rewind and battle entry, and the active
QuickJS benchmark confirms a stable 90-node population.

## Runtime tilesets

Import discovers every tileset referenced by Change Tileset on a map and
precomposes a named variant. The variant contains ground and upper art,
ordinary passage, boat/ship/airship passage, terrain tags and animated cells.
Command 282 switches the active variant in one reducer step, so collision and
rendering cannot observe different generations. The active visit selection
is saved, loaded and rewound.

Movement and vehicle checks resolve the active passage planes; `GameView`,
occlusion and animated-tile renderers resolve the same active art. Connected
world chunks scope variants to the current map instead of leaking a local
tileset choice into neighboring maps. Tile-image event sprites retain their
authored imported tileset image, which is the documented Degraded boundary.

## Window colour and formation

Change Window Color imports stock MV/MZ's three authored RGB channels and
stores a neutral gray channel; a fourth gray value on a hand-authored input is
retained for compatibility. Presentation uses RGB only, matching
`Window_Base.updateTone`, and derives message, choice, menu, formation and
battle-window palettes from the same themed chrome. Gray remains serialized
for lossless save round-tripping. This is a palette projection, not a
per-pixel windowskin filter, and is documented Degraded.

The formation overlay is opt-in: projects that do not register it import no
formation UI module. Command 137 controls access. When enabled, the overlay
uses stock's first-confirm/second-confirm flow and swaps any two saved party
indexes, including the leader. It reconciles stale ids against the current
party, then updates follower order and the next battle's front-view slots.
Order, selection-independent access and window tone survive save/load and
rewind. The project-level player sprite does not follow the new leader and is
documented Degraded.

## Schema, fixtures and coverage

The schema change is additive. The current identity is
`f3a5eb5da11bb5eed3fcad2f7e04409883b06f68addeeb48f64d2b3e6afd7db1`;
the genuine predecessor identity
`c394541ca7c28bd85899f944e3d57e506a66cd3d221d14cb5d3d56b4a21cdc13`
is in the compatibility list. A shell and save generated from that predecessor
are committed under `tests/fixtures/schema-compat/gen-c394541c` and load in
the compatibility suite.

Both self-authored RPG Maker fixtures now execute all five command families.
The static catalogue and generated coverage report are:

| Source | Total | Native | Degraded | Placeholder | Dropped |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static catalogue | 107 | 93 | 10 | 3 | 1 |
| Hollow MZ fixture | 124 | 110 | 12 | 2 | 0 |
| Stage MV fixture | 61 | 51 | 9 | 1 | 0 |
| Fixture combined | 185 | 161 | 21 | 3 | 0 |

The two fixtures regenerate deterministically and two independent imports
produce no byte diff. The Stage journey observes native `screen.tone`, not
the removed degraded tint list, and its semantic pixels distinguish the
authored green bias and post-tone sparkle. Editor command/explanation paths,
the canonical schema, embedded editor schema and status documentation all
preserve the new additive records.

## Visual verification

`krm5-visual.test.ts` drives the real importer, cooker, `GameView` and Wasm
renderer. Five states are captured at both 480x272 and 960x544: battle
weather/tone, formation, rain, snow with the changed tileset, and tone with
window colour. The focused visual suite passed 6 tests and 118 assertions.

Semantic assertions independently count and classify weather particles,
measure their direction, sample positive/negative tone and grayscale pixels,
distinguish old and new tileset passage/art, and sample window chrome. They
therefore reject a visually empty image even if a stale hash were accepted.

Both contact sheets were enlarged 3x with nearest-neighbour scaling and
opened for manual inspection. The compact and high-density sheets show
legible map and battle content, blue-green window chrome, signed tone changes,
down-left rain/storm streaks, drifting snow, the alternate frost tileset and
the two-step formation highlight without clipping or stale layers.

| Manual-review artifact | SHA-256 |
| --- | --- |
| `krm5-480-review-3x.png` | `0d89fa9ac2c2deececaa020781b91d5bab6bd33bc8a1afe94b60ebcadb7f8a1b` |
| `krm5-960-review-3x.png` | `09b49ac2adc4223367f691584d4a9919c2bab3ff1806014e565d9fb5e9e859a6` |

The preview-glyph threshold moved from four to five sampling phases after a
baseline/candidate diagnosis: the baseline passes its original suite, the
candidate Chinese frames contain real distinct glyphs, and the tofu control
still contains visibly repeated hollow boxes. This is an atlas-sampling
adjustment, not a suppression of missing glyphs.

## Mutation testing

Every deliberate regression ran in an isolated copy and was removed after
the focused command. All required mutations were discriminated:

| Deliberate regression | Focused result |
| --- | --- |
| Reverse the signed tint channels | tone engine/visual assertion fails |
| Ignore weather power when choosing particle count | particle-count assertion fails |
| Keep old passage after Change Tileset | movement/passability assertion fails |
| Omit window tone from save state | save/load equality assertion fails |
| Keep the ordinary queued action after Force Action | turn-one double-action assertion fails |

No mutation touched the implementation worktree.

## Consumer size

Consumers were built from fixed revisions with only the component pointer
changed from base to candidate.

| Consumer output | Base | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Tuxemon JS | 2,058,920 B | 2,089,117 B | +30,197 B |
| Tuxemon JS gzip | 472,743 B | 478,748 B | +6,005 B |
| Tuxemon PAK raw | 79,975,760 B | 79,975,760 B | 0 B |
| Wander JS | 1,094,445 B | 1,105,835 B | +11,390 B |
| Wander JS gzip | 234,878 B | 237,242 B | +2,364 B |

Tuxemon was fixed at `35a2af17d0f1563a2fe53b019596efeab3db4a68`;
its PAK gzip changed by 10 bytes while raw content size remained unchanged.
Wander was fixed at `0a945c71a82af58aece84c4b8dc867532bf9464d`;
its PAK is byte-identical with SHA-256
`4b9a072aa0e42da692d227a01832b70bd013a964c9c7289671d00cab617c92bc`.
The JS increases come from the shared screen/system presentation admitted by
`GameView`; no consumer asset payload was added.

## QuickJS performance

The unused-feature path was measured in the desktop QuickJS host on a fixed
CPU using three 10,000-iteration ABBA windows per workload: main, candidate,
candidate, main. Direction-balanced medians remain within the +3% limit.

| Unused-feature workload | Median candidate delta | Limit | Result |
| --- | ---: | ---: | --- |
| `sunstoneIdle` | -1.13% | <= +3% | PASS |
| `sunstoneWalk` | -0.68% | <= +3% | PASS |
| `streamedRoam` | +1.13% | <= +3% | PASS |

Power-nine weather was measured separately with the real component bundle,
PocketJS `862040bd`, 600 frames per repetition and a stable 90-particle node
pool. The median repetition at 480x272 was 5.408 ms total mean / 6.008 ms p95;
at 960x544 it was 5.345 ms total mean / 5.935 ms p95. Both resolutions
reported zero create, destroy, insert or remove operations during the measured
frames.

## Cold gates and repository state

The final sequence began after deleting `dist/`:

1. `bun run build:wasm` — exit 0; web Wasm 359,675 bytes.
2. `bun run build:example` — exit 0.
3. `bunx tsc --noEmit` — exit 0.
4. One exact sorted manifest of 284 test files ran in ten bounded partitions
   because the command executor terminates a single process at five minutes.
   The partitions passed 352, 441, 398, 431, 353, 565, 598, 513, 335 and 430
   tests. Aggregate: **4,416 pass, 0 fail, 284 files**, with no omitted path.

The initially stale Sunstone budget was narrowed to `<1,152,000` after the
shared presentation added 30,611 bytes; its comment attributes that source.
The Stage fixture journey was updated from the removed `screen.tints` shape
to native `screen.tone` and then passed 5/5 before its complete partition
passed 598/598. The preview-glyph diagnosis described above retained a visible
tofu control and passed the full partition.

Immediately before this report, a fresh `git fetch origin main` left
`origin/main` and the merge base at
`0aecc05a6f911208cc5df8041fd00e76a6f35a1b`; no rebase is outstanding.
There are twelve implementation commits, all authored by
`lfkdsk <lfkdsk@gmail.com>`, plus this report commit. The history contains no
merge commit or contribution trailer. `bun.lock` is unchanged, and the
PocketJS submodule remains
`862040bd77edc49b1f815beff63952b6616a14c6`.

subagent 使用：4 个 / 分别核对钉版上游语义、K-RPGM4/K-RPGM3 遗留、schema/导入/图块切换、渲染架构；并行只读审查节省了时间，主代理重新核实了全部结论并亲自完成集成、变异、视觉、消费者、QuickJS 与冷门禁。
PASS
