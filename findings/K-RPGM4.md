# RPG Maker Actor Changes and Battle Commands

Implementation tip before this report: `6b9d067a6e7a2c05b13ac3d121dcace4b039ee12`
Base: `7391af94c7aa1a14f82274d96a58562213c9d6f9`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

The RPG Maker importer and front-view battle module now execute the stock
actor-change command family, the common enemy/troop command family and the
battle-setting commands that previously disappeared. Actor mutations live in
the session extension state, feed the next battle, save and rewind with the
world, and preserve RPG Maker targeting, death-floor, progression and
equipment-inventory rules. Troop commands run in page order inside the active
battle, including authored targets for Force Action and an Abort Battle that
returns through the escape result.

The K-RPGM3 review findings are also closed: escape compares agility averages,
REC affects recovery, Guard is the special-flag trait, Attack Speed and Attack
Times+ participate in execution, a disallowed defeat reaches Game Over,
level-gated skills are asserted, and the compact target window no longer
covers the rightmost enemy.

The result remains Partial rather than a claim of complete RPG Maker
emulation. Level-up messages and changed actor images are retained but not
presented; battle BGM/ME and per-map battleback changes are retained but not
played or painted; numeric Show Battle Animation ids cannot paint without a
cooked animation id; and the normalized traits listed under limitations do
not yet affect the reducer.

| Acceptance area | Result | Focused evidence |
| --- | --- | --- |
| K-RPGM3 semantic corrections | PASS | reducer tests for escape, REC, Guard, Attack Speed and Attack Times+ |
| Actor commands 311–319, 321–322 and 324–326 | PASS | fixed, variable and all-actor unit tests plus imported map-to-battle flow |
| Troop commands 331–337, 339 and 340 | PASS | imported troop pages exercise appear, transform, force action and abort |
| Settings 132, 133, 136, 139 and 283 | PASS | persistent setup/settings tests and encounter-disable assertion |
| Save, load, rewind and cadence | PASS | imported fixture tests at 60/30/20 Hz and active-battle rewind |
| Compact battle presentation | PASS | two 3x manual reviews and semantic anti-overlap pixels |
| Mutations | PASS | all four required regressions fail focused tests |
| Unused-feature cost | PASS | consumer outputs byte-identical; all QuickJS medians below +3% |
| Cold gates | PASS | wasm, example build, TypeScript and all 280 test files pass |

## Pinned upstream semantics

The comparison uses the same fixed sources as the earlier RPG Maker work:

- RPG Maker MV official core `rpgtkoolmv/corescript` at
  `182e31449707ba7e406db0485c44c2a9d11e2dcd`.
- RPG Maker MZ public v1.1.0 mirror `stak/rmmz-corescript` at
  `5ecc09ae5170c6aee71c7d9513e553e3dbea116b`, used only as corroboration.

At the pinned MV revision:

- `iterateActorEx` distinguishes a fixed actor from an actor id read through
  a variable, while index `-1` iterates the whole party
  (`Game_Interpreter.js:231-247,294-309`). Commands 311–326 implement HP,
  MP, state, recovery, EXP, level, parameter, skill, equipment, class, images,
  nickname, profile and TP changes; Change HP floors a non-lethal result at
  one HP (`Game_Interpreter.js:1471-1625`).
- Enemy HP/MP/state/recovery/appear/transform/animation/force-action/abort and
  TP commands operate on the live troop (`Game_Interpreter.js:1628-1731`).
  Forced actions are consumed before the ordinary subject/action loop, and
  abort resolves the battle lifecycle (`BattleManager.js:457-481`).
- Battle BGM, victory ME, encounter-disable, defeat ME and per-map battleback
  commands update the corresponding system/map state
  (`Game_Interpreter.js:901-963,1355-1359`).
- Unit agility is the arithmetic mean of `members()`, and initial escape
  chance compares party and troop agility (`Game_Unit.js:46-55`,
  `BattleManager.js:110-112`).
- REC is special parameter 2 and Guard is special flag 1. Recovery and damage
  pass through REC and the guarded predicate (`Game_BattlerBase.js:16,35,
  86-89,469-492`; `Game_Action.js:486-505,551-553,655-676`).
- Attack Speed contributes only to a normal attack's speed and Attack Times+
  adds repeats to a normal attack (`Game_BattlerBase.js:414-420`,
  `Game_Action.js:111-117,249-258`).
- A defeat with `canLose` false calls SceneManager's Game Over path; an
  allowed loss revives and returns to the event (`BattleManager.js:542-580`).
- EXP and explicit level changes learn class skills crossed on the way up and
  optionally display level-up information (`Game_Actor.js:491-538,557-569`).
  Equipment changes trade the old and new item through party inventory and
  obey slot validity (`Game_Actor.js:243-274`). Class, images, nickname and
  profile are actor runtime properties (`Game_Actor.js:586-607,70-92`).

These are the semantic anchors for the implementation below; the previously
verified exact-turn troop condition and unfiltered enemy-HP behaviors were not
changed.

## Actor runtime and map commands

The importer lowers commands 311–319, 321–322 and 324–326 to the extension
command `rpgmaker.actorChange`. Its normalized selector is one of a fixed
actor id, an actor id read from a live event variable, or every current party
member. Operand constants and variable operands are resolved at execution
time. RPG Maker's one-based equipment type is converted to the reducer's
zero-based slot exactly once at import.

The sparse `ext.rpgmakerBattle.actors` records carry HP, MP, TP, states, EXP,
level, parameter bonuses, learned skills, equipment, per-class EXP, class,
image names, nickname and profile. A battle setup overlays those records on
the imported actor database; battle completion folds the resulting live
values back into the same records. No project schema field or schema identity
changed.

Execution includes:

- HP/MP/TP clamping, including Change HP's allow-death switch and one-HP
  floor; state add/remove; and Recover All clearing state while restoring
  current maxima.
- EXP and level movement across class curves, with level-gated skill learning
  on upward crossings; parameter and skill add/remove; class changes with
  per-class EXP preservation.
- Equipment slot checks, type permissions and inventory exchange. Unequipping
  returns the old item, equipping consumes the new one, and an unavailable or
  illegal item leaves both actor and inventory unchanged.
- Persisted character/face/battler image names, nickname and profile.

The imported end-to-end fixture changes actor HP, state and equipment on the
map and then enters a battle. The battle sees the mutations, and the final
world state retains them. Unit tests separately distinguish all three selector
forms and assert that both members receive an all-party state change.

The `showLevelUp` intent is retained but no level-up message is drawn, and
changed actor image names do not refresh the map, face or front-view UI. Actor
event conditions for class/skill/equipment/state also still inspect imported
initial facts. Those presentation/query gaps are documented as Degraded.

## Troop commands and battle settings

The troop importer now converts the real page command list rather than a
static-report approximation. The reducer executes, in source order:

- Change Enemy HP/MP/TP, Change Enemy State and Enemy Recover All;
- Enemy Appear and Enemy Transform, including the transformed database
  parameters, traits, actions and sprite identity;
- Show Battle Animation as a deterministic numeric animation marker;
- Force Action for actor or enemy subjects with random, last-target and
  explicit target selection; and
- Abort Battle through the escape outcome and event continuation.

The authored fixture runs Enemy Appear, Enemy Transform, Force Action and
Abort Battle once each. A focused assertion proves that explicit Force Action
target index 1 does not silently become index 0. Disallowed defeat reaches the
host Game Over request rather than taking the loss branch.

Commands 132, 133 and 139 persist battle BGM, victory ME and defeat ME records;
283 stores a battleback pair per current map; and 136 controls the sparse
encounter-disabled flag used by random-encounter stepping. Battle setup copies
the current records, so save/load and rewind preserve the same intent.

The current presentation does not consume those BGM/ME or battleback records.
Show Battle Animation can drive the existing marker clock but the troop list
has only an RPG Maker database number, not a cooked kit animation id. These
four visual/audio cases are reported Degraded instead of being labelled
Native.

## K-RPGM3 semantic corrections

Escape now averages the agility of every member in each battle unit before
applying the stock ratio. The focused test deliberately uses unequal party
sizes, so a sum implementation chooses the wrong phase.

Recovery multiplies negative damage and recovery effects by the recipient's
REC trait (`code 23`, `dataId 2`). Guarding projects the temporary command bit
into the stock Guard special flag (`code 62`, `dataId 1`), and damage checks
that trait; an authored class, state or equipment Guard flag therefore uses
the same path. Normal attacks include Attack Speed (`code 33`) in action order
and Attack Times+ (`code 34`) in repeat count.

The existing trait engine also consumes parameter/element/state rates,
hit/evasion/critical rates, recovery/cost/damage/EXP special parameters,
target rate, attack element/state/skill, added skills and reward multipliers.
Normalized but currently non-executing traits are explicitly Degraded:
debuff rates; skill-type add/seal and skill seal; equipment lock and runtime
slot-type change; Action Times+; Auto Battle, Substitute and Preserve TP;
and collapse type. Their records remain in `battle.json` for later support.

Progression tests now assert the exact skill learned while crossing its
required level. The imported E2E test separately drives a defeat with
`canLose=false` and observes Game Over.

## Save, rewind and cadence

Actor and setting mutations use ordinary JSON extension state, so world saves
and rewind snapshots include them without a new schema field. The active
battle codec already serializes battle combatants, queued troop effects,
forced actions and animation clock. The end-to-end suite verifies a save/load
round trip after actor changes and an active-battle rewind across the new troop
effects.

The imported actor-change-to-battle outcome is byte-equivalent at 60, 30 and
20 Hz. Troop effects run on integer reducer ticks, Force Action owns an
explicit queued action, and no command consults wall time or host frame count.

No compatibility identity was added because `rpgkit-project/v1`, its schema
hash and the save envelope are unchanged. The full compatibility suite still
loads the repository's genuinely generated predecessor fixtures.

## Fixture coverage

The two self-authored RPG Maker fixtures now report:

| Fixture | Total uses | Native | Degraded | Placeholder | Dropped | Native |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hollow MZ | 120 | 107 | 9 | 2 | 2 | 89.2% |
| Stage MV | 58 | 52 | 5 | 1 | 0 | 89.7% |
| Combined | 178 | 159 | 14 | 3 | 2 | 89.3% |

The exact totals are asserted from the generated `coverage.json`, and the
static 107-command catalogue is generated through the same troop converter.
The remaining Dropped/Placeholder rows are unrelated unsupported constructs,
not any command requested here.

## Compact visual correction

At 480x272 the target window formerly covered about 19 pixels of the rightmost
enemy sprite. Compact layout now reserves 104 pixels above that window before
placing enemies. Both English reference frames were enlarged 3x with nearest
neighbour scaling and opened for manual inspection. At 480x272 and 960x544,
the two enemy bodies, names, HP bars, actor HUD and target rows are visible;
the rightmost non-background enemy pixel remains above the target window.

The visual test finds each enemy's non-background bounds and independently
asserts that its bottom is above the target-window paper. It also retains the
semantic arena, window, selection, HP-bar and text-tree checks, so an empty or
consistently obscured image cannot pass only by matching a hash.

| Golden | SHA-256 |
| --- | --- |
| `rpgmaker-battle.en.480x272.png` | `88e0546332d48efd6b64b28207e1be9f42d04be3b69fc6a2abc34540f38c31f5` |
| `rpgmaker-battle.en.960x544.png` | `977fe803fff6c2134d4504e0e29001885f9f5b9b12a1de417e62cd4a9bf9c9c6` |
| `rpgmaker-battle.zh.480x272.png` | `9925824c37c895eb7cd1722d90dc2796f48d1f921669a43229c177f5baf940e3` |
| `rpgmaker-battle.zh.960x544.png` | `54636beb17528452576b771a295b2268db2bed4046a3cc0ce8d98a708af0dadc` |

## Mutation testing

Each mutation ran alone in a detached disposable worktree and that worktree
was removed after its focused run. All four required regressions were rejected:

| Deliberate regression | Focused failure |
| --- | --- |
| Escape uses party/enemy agility sums | expected phase `turnStart`, received `escape` |
| Recovery omits the target REC multiplier | expected actor HP `150`, received `200` |
| All-party Change State touches only actor 1 | actor 2 expected state 99, received no states |
| Force Action routes explicit target 1 to target 0 | expected `lastTargetIndex` 1, received 0 |

The mutations did not touch the implementation checkout.

## Consumer size and QuickJS performance

Tuxemon and Wander were each built from a fixed consumer revision twice,
changing only `vendor/pocket-rpgkit` from base to candidate. Both builds use
the same PocketJS revision. Every measured output is byte-identical:

| Consumer output | Base bytes | Candidate bytes | Delta |
| --- | ---: | ---: | ---: |
| Tuxemon `main.js` | 2,056,414 | 2,056,414 | 0 |
| Tuxemon `main.js` gzip | 472,277 | 472,277 | 0 |
| Tuxemon `main.pak` | 79,975,760 | 79,975,760 | 0 |
| Tuxemon `main.pak` gzip | 27,511,419 | 27,511,419 | 0 |
| Wander `wander.js` | 924,371 | 924,371 | 0 |
| Wander `wander.js` gzip | 194,525 | 194,525 | 0 |
| Wander `wander.pak` | 1,132,768 | 1,132,768 | 0 |
| Wander `wander.pak` gzip | 73,952 | 73,952 | 0 |

The desktop QuickJS guest ran three 10,000-iteration ABBA windows per
workload: main, candidate, candidate, main. The table uses six
direction-balanced mean-time deltas and their median. Baseline and candidate
workload bundles both hash to
`1df9215004fd1b32560954e2c52321552c85f6512ef6ff3cc24778f5a92234a3`.

| Unused-feature workload | Six candidate deltas | Median | Limit | Result |
| --- | --- | ---: | ---: | --- |
| `sunstoneIdle` | -0.55, -0.27, +0.89, -1.09, +0.10, -0.78% | -0.41% | <= +3% | PASS |
| `sunstoneWalk` | -0.56, -0.10, +0.74, +1.14, +0.02, -0.54% | -0.04% | <= +3% | PASS |
| `streamedRoam` | -1.88, +0.56, -1.56, -2.41, -5.91, -3.09% | -2.14% | <= +3% | PASS |

An earlier streamed-roam window began at load average 19.63 and reported
+25.86%; it was retained as rejected noisy evidence. The accepted rerun used
a separate CPU and an ABBA window whose before/after load readings are in the
raw log. All accepted medians are within the +3% unused-feature limit.

## Cold gates and repository state

The final cold sequence started after deleting `dist/`:

1. `bun run build:wasm` — exit 0; web wasm 359,675 bytes.
2. `bun run build:example` — exit 0.
3. `bunx tsc --noEmit` — exit 0.
4. The exact sorted set of 280 test files was run by Bun in ten stable
   28-file partitions because the command executor terminates a single
   process at five minutes. The partitions passed respectively 346, 441,
   398, 431, 355, 600, 541, 546, 355 and 350 tests. Aggregate:
   **4,363 pass, 0 fail, 280 files**, with no omitted path.

The first seventh partition exposed a stale journey expectation after valid
initial equipment began entering inventory. The expected `weapon001: 1` was
added, its focused journey passed 5/5, and the complete seventh partition then
passed 541/541.

After the final fetch, `origin/main` remained
`7391af94c7aa1a14f82274d96a58562213c9d6f9` and is the exact merge base of
the branch; no rebase is outstanding. `bun.lock` and the PocketJS submodule
are unchanged. The branch has no merge commits or contribution trailers.

subagent 使用：6 个 / 分别核对架构边界、战斗数据库导入、事件降级、测试与性能表面、钉版上游语义、视觉回归；分波并行调查节省了时间，主代理完成并复核实现、集成、变异、视觉、消费者、QuickJS 与全部门禁。
PASS
