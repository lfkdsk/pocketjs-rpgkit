# RPG Maker Battle Processing

Candidate: `75f82af1ab14b2084888524c5a68dea4a54b8629`
Base: `de66edabbbd4ffcfc13805dea862eec2cdbd962f`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

RPG Maker MV/MZ Battle Processing is now a runnable, deterministic opt-in
module rather than a result picker. The importer builds a normalized battle
database, command 301 resolves fixed, variable and random troop sources, and
commands 601/602/603 run only after a real win, escape or allowed defeat.
The front-view reducer covers the stock data needed for ordinary database
battles, including rewards, levels, drops, states and common troop pages.

The implementation is deliberately Partial, not advertised as a complete
RPG Maker battle emulator. MV side-view projects degrade to front view;
battle backgrounds and configured battle audio are not presented; troop pages
accept only messages, switches and constant-variable changes; and battle-only
commands such as Force Action and Enemy Transform remain unsupported. These
limits are visible in generated coverage and in the public status table.

| Item | Result | Focused evidence |
| --- | --- | --- |
| Front-view battle database and reducer | PASS | Actor/class/enemy/troop/skill/item/state importer tests and pure reducer tests |
| Safe damage formulas | PASS | Bounded no-`eval` parser, evaluator, deterministic fallback and two-fixture coverage |
| 301 and 601/602/603 flow | PASS | Imported win, escape, allowed-loss and disallowed-loss end-to-end paths |
| Rewards and progression | PASS | EXP curve, learned skills, gold and deterministic drops through the imported fixture |
| Random encounters | PASS | Weighted region-aware troop selection driven by successful player steps |
| Determinism and persistence | PASS | 60/30/20 Hz outcome equality, active save/load and battle-boundary rewind |
| Presentation | PASS | English and Chinese at 480x272 and 960x544, manual 3x review and semantic pixels |
| Optionality | PASS | Separate package entries; zero RPG Maker battle modules in Meadow and Sunstone source graphs |

## Fixed upstream semantics

The comparison used fixed source revisions rather than moving repository
heads:

- RPG Maker MV official core: `rpgtkoolmv/corescript` at
  `182e31449707ba7e406db0485c44c2a9d11e2dcd`.
- RPG Maker MZ public v1.1.0 mirror: `stak/rmmz-corescript` at
  `5ecc09ae5170c6aee71c7d9513e553e3dbea116b`. The mirror corroborates MV and
  is not represented as an official repository.

The relevant stock behavior at those revisions is:

- Battle Processing selects a fixed troop, a variable troop, or the current
  random encounter; propagates `canEscape` and `canLose`; and records the
  result for 601/602/603 (`Game_Interpreter.js:1400-1417`,
  `rmmz_objects.js:10885-10905`).
- Hit, evasion and critical checks consume ordered random draws before damage
  and effects; damage evaluates the authored formula then applies element,
  physical/magical, recovery, critical, variance and guard modifiers
  (`Game_Action.js:442-534`, `rmmz_objects.js:1869-1965`).
- Victory creates and grants EXP, gold and drops, while actor progression uses
  the class curve and learns level-gated skills (`BattleManager.js:507-515,
  582-646`, `Game_Actor.js:138-163,491-542`,
  `rmmz_managers.js:2865-2873,2953-3018`,
  `rmmz_objects.js:4141-4169,4490-4542`).
- Random encounter distance and troop selection advance from player movement
  (`Game_Player.js:180-218,469-488`, `rmmz_objects.js:8223-8263`).
- Troop pages test turn, enemy/actor HP and switch conditions in source order;
  the first eligible page is reserved according to its span
  (`Game_Troop.js:110-180`, `BattleManager.js:284-291`,
  `rmmz_objects.js:5934-6008`, `rmmz_managers.js:2594-2603`).
- Party combatants come from current party membership and order, not only the
  database initial list (`Game_Party.js:128-135,179-193,365-370`,
  `rmmz_objects.js:5484-5491,5533-5559,5723-5728`). Initial equipment changes
  parameters and traits (`Game_Actor.js:46-60,175-215,287-306,421-431,
  457-470`, `Game_BattlerBase.js:285-329,358-371,430-432`,
  `rmmz_objects.js:2796-2936,4049-4063,4182-4220,4291-4310,4417-4469`).
- Confusion changes action targets according to restriction and unit targeting
  (`Game_BattlerBase.js:581-623`, `Game_Action.js:235-298`,
  `Game_Unit.js:57-72`, `rmmz_objects.js:1623-1687,3087-3133,5268-5282`).
- Death, state turn expiration and removal by damage follow the battler state
  lifecycle (`Game_BattlerBase.js:124-153,235-245,626-635`,
  `Game_Battler.js:165-205`, `rmmz_objects.js:2640-2666,2748-2757,
  3135-3145,3623-3666`).
- A failed escape advances battle time; an allowed defeat revives the party
  before returning to the event instead of entering Game Over
  (`BattleManager.js:519-580`, `Game_Party.js:50-79`,
  `rmmz_managers.js:2877-2950`, `rmmz_objects.js:4904-4909,5412-5447,
  5812-5815`).

Pinned links for both revisions are published in `docs/rpgmaker-import.md`.

## Optional architecture and imported database

The generic engine still owns only the battle lifecycle: it parks an event,
passes a JSON setup to registered rules, and resumes the selected result
branch. RPG Maker rules and UI are exported separately as
`pocket-rpgkit/rpgmaker-battle` and
`pocket-rpgkit/ui/rpgmaker-battle`. Neither is re-exported from a root barrel.
The imported fixture explicitly composes both; ordinary games do not.

The importer reads the stock database into a separately packaged
`battle.json`, whose content hash is copied into every Battle Processing
setup and active save. It normalizes:

- actor level bounds, initial class/equipment and traits;
- class parameter and experience curves plus level-gated learnings;
- enemy parameters, traits, weighted action patterns, rewards and drops;
- troop membership, screen positions and common page conditions;
- skill/item scope, hit type, damage, element and effects for HP/MP recovery,
  states, buffs and debuffs;
- state restrictions, parameter rates, minimum/maximum turns and removal by
  turn end or damage;
- map encounter weights, region sets and encounter-step timing; and
- localized RPG Maker terms used by battle narration and menus.

The front-view rules project the live party switches at battle start, retain
the authored order, and apply valid initial equipment rather than assuming a
single hard-coded actor. Every menu cursor, battler, action, effect clock,
state turn, troop-page flag and RNG cursor lives in JSON reducer state.
Extension composition preserves another game's existing extension handlers.

## Safe damage formulas

Authored formulas are never passed to `eval`, `Function` or a JavaScript VM.
The importer tokenizes and parses an allowlist into a JSON AST. The accepted
subset contains finite numeric literals, `a.` and `b.` basic parameters,
literal `v[n]`, grouping, unary `+`/`-`/`!`, arithmetic, exponentiation,
comparisons, equality, boolean operators, right-associative ternaries,
`Math.E`, `Math.PI`, and common deterministic `Math` functions.

The parser caps source at 2,048 characters, tokens at 512, AST depth at 64
and function arguments at 32. Identifiers, property access, assignments,
calls and syntax outside the allowlist fail at import time. Rejected formulas
are marked Degraded with the parser reason and receive the stored deterministic
fallback `Math.max(0, a.atk * 4 - b.def * 2)`. Evaluation clamps non-finite
results through the battle damage path.

Formula/database coverage in both authored fixtures is complete for their
contents:

| Fixture | Native battle/formula records | Total | Coverage |
| --- | ---: | ---: | ---: |
| Hollow | 14 | 14 | 100% |
| Stage | 8 | 8 | 100% |

Tests additionally reject member injection, calls to unlisted functions,
malformed numbers, over-budget source/tokens/depth/arguments, dynamic variable
indices and serialized ASTs outside the validator. Precedence and JavaScript's
unary/exponentiation corner are asserted directly.

## Battle flow, actions and rewards

Command 301 now emits the generic `battle` command with a database hash,
escape/defeat flags and exactly one troop source. Fixed ids resolve directly,
variable ids read the live event variable, and random processing consumes the
map extension's pending encounter. The flat 601/602/603 list is reconstructed
as `onWin`, `onEscape` and `onLose`; a disallowed loss with no source branch
uses the existing `gameOver` and `exit` path.

The pure reducer supports Fight/Escape, Attack/Skill/Guard/Item, legal target
selection, weighted enemy actions, speed order, hit/evasion/critical/variance
draws, physical/magical modifiers, element rates, guard, confusion, TP gain,
effect application and action restrictions. HP/MP/TP, states, buffs, inventory
and actor progression are folded back through the extension completion. A
failed escape advances the turn; an allowed defeat revives each party member
to one HP and removes states before the lose branch resumes.

On victory, rewards combine all defeated enemies. EXP follows the imported
class curve, levels may learn class skills, gold uses party reward traits and
drops use the same deterministic RNG stream. The imported end-to-end fixture
verifies branch switches/variables, 37 gold on top of an existing 100, a
guaranteed item drop and a multi-level reward. Losing or escaping grants none
of these rewards.

Troop pages choose the first eligible page in source order and implement the
common turn, turn-ending, enemy HP, actor HP and switch conditions. Span flags
prevent a battle- or turn-scoped page from repeating incorrectly. Page effects
are intentionally limited to messages, switches and constant-variable
operations; every other command is counted Degraded rather than guessed.

## Random encounters

The battle extension hooks successful completed-player-tile notifications. It
uses the map's imported encounter-step value to seed a deterministic distance,
decrements it on later steps, filters troop records by the current region and
selects by weight when due. The generated parallel map event consumes the due
flag and starts command 301 with random-encounter selection. Transfer placement
is not a step, and the current encounter cursor is sparse extension state, so
save and rewind reproduce the same due tile and selected troop.

Encounter Disable, vehicle suppression and Encounter Half are not modelled;
the importer documentation and status matrix name those limits.

## Saves, rewind and cadence

Active battle persistence is explicitly opt-in. `SaveSnapshot.battle` is an
optional additive field, and a battle can be saved only when its registered
rules supply a codec. The snapshot carries the exact battle state, result
branches and parked-fiber link. Restore validates the database hash and scene
shape before reattaching it. Generic scenes and battles without a codec retain
the previous unsaveable behavior.

The imported fixture saves in the command phase, restores an equal scene,
finishes both worldlines, and compares canonical final snapshots byte for byte.
A mutated database hash is rejected. Generic rewind coverage crosses battle
entry and exit and reproduces the same snapshot; RPG Maker reducer state uses
that same timeline mechanism while a battle is active.

Win flow, 601, experience, level, gold and drop assertions all pass at 60,
30 and 20 Hz. Input is edge-folded into reference ticks and action/effect
clocks are integer reference ticks, so host cadence does not choose extra RNG
draws or change outcome.

No `rpgkit-project/v1` schema identity changed: `battle.json` is an opt-in
sidecar and the save field is optional. Old saves omit it. The unchanged full
schema-compatibility suite continues to load the genuinely generated prior
fixtures; no synthetic compatibility identity was added for this module.

## Coverage and byte stability

Both authored projects were imported twice into empty independent output
directories. `diff -qr` was empty for both pairs.

| Fixture | Files | Bytes | Sorted aggregate SHA-256 |
| --- | ---: | ---: | --- |
| Hollow, each run | 21 | 236,263 | `b6751939f399bb03931f685b3c61488aa95a0847d9e96c0a7b1e35a6787aa48a` |
| Stage, each run | 25 | 240,906 | `68a975651708d6abc87e619f58be73c3acb4273eb7ea7b384cca90de2ebd5910` |

Generated command coverage is:

| Fixture | Total | Native | Degraded | Placeholder | Dropped |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hollow | 106 | 94 | 8 | 2 | 2 |
| Stage | 58 | 52 | 5 | 1 | 0 |

Coverage JSON and Markdown now include battle database/formula records as well
as command disposition. Side-view 301 is explicitly Degraded; unsupported
formula syntax carries its reason and fallback; omitted battle event commands
remain counted instead of disappearing.

## Visual review

The imported fixture was rendered independently in English and Simplified
Chinese at 480x272 and 960x544. Each accepted frame was enlarged with
nearest-neighbour scaling to 3x and opened for manual inspection. Enemy art,
two enemy name marquees and HP bars, the actor HUD, selected target, long menu
heading and repeated long target names were all visible. Neither language was
truncated, no replacement character appeared, and the Chinese frame used
distinct glyphs rather than repeated tofu boxes. The fixture carries a
licensed 87-character Noto Sans CJK subset and its license.

The visual test independently asserts the backdrop and arena colours, window
paper and frame, selected-target/actor-HP colour, enemy HP bars, both name
marquees, exact text-tree contents, absence of ellipsis/replacement characters
and distinct Chinese cell patterns. A consistently blank, clipped or tofu
golden therefore cannot pass only because its hash is stable.

| Golden | SHA-256 |
| --- | --- |
| `rpgmaker-battle.en.480x272.png` | `25a64da577692af17cf4bcb236d6ddc9c1d6886738cc79a6df8cb309fecb6457` |
| `rpgmaker-battle.en.960x544.png` | `9031a253773977fb413849fdd1fb57c5100c423b05ad766b7b27042b47d07f95` |
| `rpgmaker-battle.zh.480x272.png` | `0e0c262ec0023d50b8957f14bea98790093d4ced06edf4409c6b7e21a097ec8c` |
| `rpgmaker-battle.zh.960x544.png` | `388f8f287c19e2f534b0a978f1bd95a06bca47b48918fae85921abfd05c63974` |

## Mutation testing

Each mutation ran in its own detached disposable worktree. The implementation
checkout was never mutated, and each worktree was removed after its focused
run.

| Deliberate regression | Focused failure |
| --- | --- |
| Lower additive precedence below multiplication | expected `23`, received `31`; 2 failures |
| Remove the critical RNG draw | expected RNG cursor `809373172`, received `3272774655` |
| Route win completion to the lose branch | `s010` expected `true`, received `undefined` at 60/30/20 Hz |
| Round the class EXP curve down | expected `50`, received `49` |

All four requested mutation classes are therefore distinguished by tests:
formula precedence, hit/critical RNG cursor, victory branch selection and the
experience curve.

## Source and bundle isolation

Pass-1 build manifests show that the concrete RPG Maker reducer and UI stay
outside ordinary source graphs:

| Built app | RPG Maker battle modules admitted |
| --- | ---: |
| Meadow | 0 |
| Sunstone | 0 |
| RMI Play | 5 (`formula.ts`, `index.ts`, `rules.ts`, `types.ts`, UI `index.tsx`) |

The final component artifacts, including the updated narrow isolation pins,
are:

| App | JavaScript bytes | PAK bytes |
| --- | ---: | ---: |
| Meadow | 701,801 | 1,209,296 |
| Sunstone | 1,115,970 | 3,344,384 |
| RMI Play | 1,173,746 | 9,792,048 |
| Showcase | 1,332,320 | 1,659,088 |

The focused isolation/size set finished **12 pass, 0 fail** after all exact
pins were refreshed with attribution.

Tuxemon and Wander were each built from identical detached consumer commits,
changing only the kit revision. Both sides use the same PocketJS revision;
compressed values use `gzip -n -9`.

| Consumer / output | Base bytes | Candidate bytes | Delta | Delta % |
| --- | ---: | ---: | ---: | ---: |
| Tuxemon `main.js` | 2,052,146 | 2,056,414 | +4,268 | +0.2080% |
| Tuxemon `main.js` gzip | 471,417 | 472,277 | +860 | +0.1824% |
| Tuxemon `main.pak` | 79,975,760 | 79,975,760 | 0 | 0% |
| Tuxemon `main.pak` gzip | 27,511,419 | 27,511,419 | 0 | 0% |
| Wander `wander.js` | 923,702 | 924,371 | +669 | +0.0724% |
| Wander `wander.js` gzip | 194,370 | 194,525 | +155 | +0.0797% |
| Wander `wander.pak` | 1,132,768 | 1,132,768 | 0 | 0% |
| Wander `wander.pak` gzip | 73,952 | 73,952 | 0 | 0% |

The pinned consumer commits are Tuxemon
`35a2af17d0f1563a2fe53b019596efeab3db4a68` and Wander
`0a945c71a82af58aece84c4b8dc867532bf9464d`. Wander's baseline and candidate
input manifests both contain 608 byte-identical entries; both PAKs hash to
`583955c2b34b16b1c7f85f81faac2a6d89ba8a99aebd3d14c95e09b73ca472e8`.
The Tuxemon PAK is likewise byte-identical. The small JavaScript increases are
changes to already-reachable generic battle lifecycle and active-save support;
the concrete RPG Maker rules and UI remain absent from both consumers.

## QuickJS performance

The pinned desktop QuickJS guest ran each unused-feature workload in three
windows, 10,000 iterations per slot on CPU 3. Every window used
main -> candidate -> candidate -> main. The acceptance value is the median of
six direction-balanced paired deltas.

| Unused-feature workload | Six paired deltas | Median candidate delta | Limit | Result |
| --- | --- | ---: | ---: | --- |
| `sunstoneIdle` | -1.22, +3.34, +0.66, -0.74, +0.55, -4.49% | -0.10% | <= +3% | PASS |
| `sunstoneWalk` | +1.91, +1.28, -0.01, +4.53, +0.10, +0.78% | +1.03% | <= +3% | PASS |
| `streamedRoam` | -1.36, -1.04, +0.25, -2.06, +5.78, -1.68% | -1.20% | <= +3% | PASS |

The baseline bundle hash was
`cd9ddfbde83fa0092548dee62329743090cacbd76217195db877da5f6c7ee027`;
the candidate hash was
`1df9215004fd1b32560954e2c52321552c85f6512ef6ff3cc24778f5a92234a3`.
All three medians stay below the +3% unused-feature limit. The importer is
build-time only, RPG Maker rules/UI are source-isolated, extension state is
sparse and the generic active-battle save path is not visited outside a scene.

## Clean gates and repository state

The final cold gates started after deleting `dist/`:

1. `bun run build:wasm` — exit 0; web wasm 359,675 bytes.
2. `bun run build:example` — exit 0.
3. `bunx tsc --noEmit` — exit 0.
4. The exact sorted set of 280 test files was run through the real Bun test
   runner in four stable 70-file partitions because the command wrapper has a
   fixed five-minute ceiling. The partitions reported respectively
   `923 pass, 0 fail, 41,069 assertions`; `1,048 pass, 0 fail, 288,158
   assertions`; `1,524 pass, 0 fail, 250,339 assertions`; and
   `846 pass, 0 fail, 149,255 assertions`. Aggregate: **4,341 pass, 0 fail,
   728,821 assertions** with no omitted test file.

`origin/main` is the exact merge base of the candidate, so no rebase is
outstanding. `bun.lock` is unchanged, the PocketJS submodule remains at the
base revision, and no PocketJS ABI change was required. Implementation,
tests, fixtures, goldens, documentation and size-pin updates are committed
with the repository author identity and without merge commits or contribution
trailers.

subagent 使用：4 个 / 分别完成战斗架构与对抗审查、导入器与夹具边界调查、MV/MZ 上游语义核对、验证与视觉/隔离表面审查 / 并行只读核对节省了时间，主代理复核并完成实现、变异、视觉、冷门禁、消费者与性能测量。
PASS
