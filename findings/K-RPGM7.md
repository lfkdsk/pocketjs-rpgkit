# Safe RPG Maker Script subset

Base: `8c05304d0a2e1a167a3dc8582533f7e67b84cb82`  
Pinned PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

PASS. RPG Maker Script remains untrusted data: the importer now tokenizes it
into a bounded import-only AST and lowers only exact allowlisted shapes into
existing commands and conditions. It never calls `eval`, `Function`, or
project code, and it adds no runtime Script interpreter. An unsupported
statement rejects the complete 355/655 block or Conditional Branch expression
and preserves the existing visible Placeholder behavior.

The survey covered eight pinned public projects and found 540 logical Script
units. The conservative observed-safe population is 195 units (36.1%): 184
exact map refreshes, six direct item-presence conditions, and five direct
inventory-count comparisons. The three K-RPGM6 touchstones reimport
deterministically. Combined command coverage moves from
`1946 / 1554 / 169 / 167 / 56` to
`1946 / 1566 / 163 / 161 / 56`
(total / Native / Degraded / Placeholder / Dropped), or 79.856% to 80.473%
Native.

All acceptance gates pass: schema bytes are unchanged; the base and candidate
QuickJS consumer bundles are byte-identical; all eight interleaved QuickJS
median deltas are below +3%; the cold build succeeds; and the complete suite is
4,523 pass / 0 fail / 0 skip.

## Corpus and shape distribution

The survey read data only and executed no Script. One logical action unit is a
355 head plus its consecutive 655 lines; one condition unit is command 111
subtype 12. Shapes were normalized, and neither Script source nor third-party
project content was added to this repository.

| Project | Engine | Revision | 355 heads | 655 lines | Script conditions | Logical units |
|---|---|---|---:|---:|---:|---:|
| GameDev: The Beginning | MV | `a3c3ec739071ca285045025f9b619d17877a7193` | 100 | 5 | 24 | 124 |
| The Basement | MV | `0aea82564bf84299441c6b285e04977f5f11a68a` | 0 | 0 | 0 | 0 |
| Strange Sea: Before | MZ | `103d87c00c8903db841b9aad23dea30e26d6b1a8` | 0 | 0 | 0 | 0 |
| Pokémon Essentials MV implementation | MV | `99836e294e588411d44131e4ae878466d5fbbd3a` | 0 | 0 | 0 | 0 |
| Chef Adventure | MZ | `1f82eb3ec3d5e74a5858391d25cdc21e7e5cb27c` | 261 | 244 | 81 | 342 |
| RpgMaker-is-you | MV | `a710f9ce4ea8b35c17c8b0d105be9386fb136b22` | 57 | 137 | 17 | 74 |
| RPG Maker Demo Blocklet | MV | `58220856b4555ba1aa37f33963846b96795a20ee` | 0 | 0 | 0 | 0 |
| Pokémon MZ | MZ | `d2f0e3aa5d34aa64d4cc11c392391f53d950bbac` | 0 | 0 | 0 | 0 |
| **Total (551 JSON files, 68,728 command-shaped objects)** | | | **418** | **386** | **122** | **540** |

License evidence was checked at each pin. The GameDev repository splits MIT
code and CC BY-SA 4.0 assets; The Basement, Pokémon Essentials, Chef
Adventure, RpgMaker-is-you, Blocklet, and Pokémon MZ carry MIT files. Strange
Sea carries an Apache-2.0 file but its README adds study-only and
no-republication terms, so it was analyzed and imported only in local scratch.
No trial file is committed.

Observed action-unit groups were: 184 exact refresh calls, 91 custom picture
API blocks, 40 custom battle/boss API blocks, 22 logging blocks, 17 screen
zoom blocks, 18 custom event-control blocks, ten dynamic cross-event
self-switch blocks, eight input/scene mutations, six item loops, six custom
text-pop blocks, four quest blocks, four custom party blocks, three equipment
blocks, two derived variable-write blocks, and three other custom blocks.
Allowlisted calls nested inside declarations, callbacks, loops, or another
unsupported statement do not make that unit safe.

The 122 conditions break down into 68 plugin/custom predicates, 15 leader-id
tests, eight actor-stat tests, seven input-edge tests, six direct item-presence
tests, five inventory-count comparisons, five collision queries, four
movement-result queries, two item-presence OR expressions, and two party-size
tests. Only the eleven exact item/count forms in that measured corpus enter
the narrow native subset.

## Pinned upstream semantics

The comparison uses MV v1.3b
`rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`
and MZ v1.1.0
`stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`.
MV joins 355/655 with newlines and evaluates once at
`js/rpg_objects/Game_Interpreter.js:1764-1780`; MZ does the same at
`rmmz_objects.js:11250-11257`. Conditional Script is evaluated and
boolean-coerced at MV `Game_Interpreter.js:560-568` and MZ
`rmmz_objects.js:10014-10015`. The importer mirrors only the joining rule,
never the evaluation.

| Accepted or classified shape | MV v1.3b | MZ v1.1.0 | Import consequence |
|---|---|---|---|
| map refresh | `Game_Map.js:93-95` | `rmmz_objects.js:6127-6129` | Exact zero-argument call is a Native no-op because kit page guards are live |
| variable read/write | `Game_Variables.js:18-33` | `rmmz_objects.js:706-721` | Validate the literal id against the imported database; lower the safe numeric AST |
| switch read/write | `Game_Switches.js:18-30` | `rmmz_objects.js:674-686` | Literal existing id and boolean value only |
| self-switch write | `Game_SelfSwitches.js:18-32` | `rmmz_objects.js:741-755` | Only the issuing event's literal map/event/A-D key is representable |
| item gain/loss | `Game_Party.js:219-243,251-278` | `rmmz_objects.js:5586-5607,5613-5640` | Inventory cap/equipped-copy/flooring differences are Degraded |
| gold gain/loss | `Game_Party.js:195-208` | `rmmz_objects.js:5562-5575` | Existing native gold commands; clamp differences are classified |
| player locate | `Game_CharacterBase.js:206-225; Game_Player.js:163-171` | `rmmz_objects.js:7095-7114,8206-8214` | Degraded: stock also recenters, rerolls encounters, and synchronizes followers/vehicle |
| reserve transfer | `Game_Player.js:63-70` | `rmmz_objects.js:8100-8107` | Native only for representable safe operands/direction/fade |
| event position | `Game_Map.js:169-171; Game_CharacterBase.js:206-211` | `rmmz_objects.js:6200-6202,7095-7100` | Literal event plus safe coordinates |
| event direction | `Game_Map.js:169-171; Game_CharacterBase.js:227-236` | `rmmz_objects.js:6200-6202,7116-7125` | Degraded where direction-fix/stop-count details differ |
| play BGM | `js/rpg_managers/AudioManager.js:81-100` | `rmmz_managers.js:1116-1129` | Literal bounded audio object |
| play SE | `AudioManager.js:270-280,384-389` | `rmmz_managers.js:1293-1307,1410-1415` | Omitted volume/pitch/pan are zero, matching the Script API |
| add message | `Game_Message.js:100-102` | `rmmz_objects.js:556-558` | Literal bounded string becomes native text |
| variable comparison | `Game_Interpreter.js:443-470; Game_Variables.js:18-20` | `rmmz_objects.js:9888-9914,706-708` | Preserve comparison direction and integer boundaries |
| switch condition | `Game_Switches.js:18-20` | `rmmz_objects.js:674-676` | Exact value or negation |
| item presence | `Game_Party.js:232-249; Game_Interpreter.js:548-556` | `rmmz_objects.js:5599-5611,9992-10000` | Inventory native; include-equipment is Degraded |
| inventory count | `Game_Party.js:219-222` | `rmmz_objects.js:5586-5589` | Native count comparison, with exact branch inversion where needed |
| player x/y | `Game_CharacterBase.js:11-14` | `rmmz_objects.js:6889-6902` | Recognized but Placeholder: no exact live-coordinate condition exists |
| player direction | `Game_CharacterBase.js:227-229` | `rmmz_objects.js:7116-7118` | Cardinal equality/inequality only |
| party steps | `Game_Party.js:211-217` | `rmmz_objects.js:5578-5584` | Native integer comparison |

## Implementation and security boundary

`tools/rpgmaker-import/script-subset.ts` is an importer-only tokenizer,
bounded expression parser, normalized safe AST, and allowlist classifier.
Budgets are 2,048 source characters, 512 tokens, 512 AST nodes, 64 nesting
levels, 32 statements, bounded argument lists, and bounded strings. The
numeric expression projection reuses the K-RPGM3 formula AST for finite
literals, variable reads, arithmetic, selected `Math` functions/constants,
and constant folding. Live operations that cannot be expressed by native
variable commands remain Placeholder; live division/modulo is Degraded
because native intermediates floor.

`tools/rpgmaker-import/events.ts` joins 355/655 with `"\n"`, lowers an
accepted unit atomically, validates variable/switch/item ids against the
actual imported databases, and records one command disposition. Dedicated
source-free Script-shape rows are emitted by
`tools/rpgmaker-import/coverage.ts` and rendered in both reports by
`tools/rpgmaker-import/report.ts`. Project Script text is never copied into
the shape section.

The rejection suite covers prototype access, `constructor`,
`globalThis`, `require`, dynamic import, arrow calls, unknown identifiers,
computed/property tricks, unsafe values inside legal calls, a side-effect call
next to a legal statement, invalid ids, overlong input, too many tokens,
statements, arguments, and nesting. It also installs a sentinel global and
proves a rejected call is not executed and its secret argument is absent from
the rejection object. A source scan asserts that the recognizer contains
neither `eval(` nor `Function(`.

Every accepted action and condition shape has a self-authored parser fixture,
native-lowering fixture, and real-interpreter assertion. The synthetic project
end-to-end suite injects 355/655 blocks and Script conditions, imports the
project, and runs the resulting session at 60/30/20 Hz. It crosses modal and
terminal save/restore boundaries and L-trigger rewind/refold; gameplay
snapshots, cues, and final state agree at all three rates.

## K-RPGM6 review closure

- The hidden-target test is now named “kit deliberately retargets an explicit
  hidden-but-living opponent unlike stock.” Public documentation states the
  deliberate divergence: stock can hit that explicitly indexed living member,
  while the kit redirects until Appear makes it visible.
- A complete imported random-encounter session test now runs at 60, 30, and
  20 Hz. For each rate it saves/restores a pinned countdown and compares the
  eventual battle snapshot; it separately rewinds with L and deterministically
  refolds the exact suffix. This makes the earlier encounter coverage statement
  true rather than merely correcting its wording.
- The MZ `PX`/`PY`/`FS` DialogBox branch now has render-level tests at
  480×272 and 960×544. Tree assertions reject the fallback row path; semantic
  pixels prove horizontal/vertical positioning, visibly larger `FS` glyphs,
  frame growth, and nonblank output. The committed PNGs were opened and
  inspected; SHA-256 values are
  `25447f0cbfd5e15749bf83cfc561ab3173eaea7b506c6b60244d666182487a6e`
  and
  `6361d15fc183694b1be64a276f40e9a293fa43d405900aa46ca9c0fd05810fc3`.
- The Electron app builds successfully. This host has neither `DISPLAY` nor
  Xvfb, so the packaged e2e runner exits 1 with
  “no DISPLAY and no Xvfb; install xvfb or set XVFB to its path.” On a Linux
  CI host, run `bun run build && XVFB=/usr/bin/Xvfb bun run e2e` from
  `studio-desktop/`; the runner starts the virtual display itself.

## Real-project reimport

| Project | Before total / N / D / P / X | After total / N / D / P / X | Change |
|---|---:|---:|---|
| GameDev: The Beginning | 1718 / 1383 / 112 / 167 / 56 | 1718 / 1395 / 106 / 161 / 56 | six grouped item conditions become Native; their six guarded item removals also become Native |
| The Basement | 31 / 20 / 11 / 0 / 0 | unchanged | no Script units |
| Strange Sea: Before | 197 / 151 / 46 / 0 / 0 | unchanged | no Script units |
| **Combined** | **1946 / 1554 / 169 / 167 / 56** | **1946 / 1566 / 163 / 161 / 56** | **Native 79.856% → 80.473%** |

The downstream six-command gain is intentional. Each accepted
item-presence guard establishes count ≥1 in the branch scope, so removing one
copy no longer needs the “unguarded loss could go below zero” Degraded
classification.

All three pins were imported twice into independent output roots. The two
trees contain 145 files and 17,951,775 bytes each; they are byte-identical and
share the relative-path/content manifest SHA-256
`5584ffdf7a9b355a71f8cc37f11f2867c911a7ea50d86b98ccf0b694301ce2b6`.

## Mutation tests

Each mutation ran in its own detached worktree, and all worktrees were removed
afterward.

| Isolated implementation mutation | Discriminating test | Red evidence |
|---|---|---|
| Ignore an unsupported statement beside an accepted call | all-or-nothing allowlist test | expected `ok:false`, received `ok:true` with the legal switch action |
| Write a recognized variable to `id + 1` | real interpreter state-write test | expected `v002 === 7`, received `undefined` |
| Reverse Script `>` lowering to `<=` | condition/lowering test | expected `>= 5`, received `<= 4` |

## Compatibility, bundles, performance, and gates

- The project schema is byte-identical to base:
  `37177b01a7825a112e0f9fc349f85a4280309e4a1b3b550e5af45c778c93c5f1`.
  No schema field or hash changed.
- Importer isolation tests prove Meadow and Sunstone do not reach
  `script-subset.ts` or its identifying parser strings. The QuickJS consumer
  bundles built from base and candidate are both 340,877 bytes, byte-identical,
  with SHA-256
  `2f252f0206a60aec8dcc9ce651c712fc6e77e7d1c583464f365b11c2399fe80d`.
- `bun.lock` is unchanged.

QuickJS was pinned to CPU 17, 2,000 iterations per slot, three ABBA windows
(main → candidate → candidate → main), against base `8c05304d`.

| Workload | Median candidate delta |
|---|---:|
| battleScene | −1.50% |
| battleSceneImmutable | −0.36% |
| streamedRoam | +0.06% |
| sunstoneControlWalk | −0.47% |
| sunstoneControlWalkImmutable | −0.73% |
| sunstoneIdle | −1.01% |
| sunstoneIdleImmutable | −1.53% |
| sunstoneWalk | −0.44% |

All medians are below the +3% regression limit. The window began at load
14.60/9.09/7.69 and ended at 6.30/7.63/7.36; the pinned guest itself was the
only task started for the measurement.

Cold gate, after deleting `dist/`:

| Command | Result |
|---|---|
| `bun run build:wasm` | exit 0; web Wasm 359,675 bytes |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0, no diagnostics |
| `bun run test` | 4,523 pass, 0 fail, 0 skip; 730,172 assertions in 293 files, 498.53 s |
| `bun run build` in `studio-desktop/` | exit 0; app, preload, helper and site produced |

## Subagents

subagent 使用：4 个 / 真实项目统计与钉版上游语义、解析器架构核对、遇敌与隐藏目标遗留审查、MZ 渲染与 Electron 环境核对 / 并行只读调查节省了时间，主 agent 随后亲自复核统计、实现、真实项目重导入、画面、变异、冷门禁与 QuickJS

PASS
