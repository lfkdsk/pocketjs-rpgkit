# K-TUX-2: immediate routes use the installed route speed

## Verdict

The blocking event-route defect is fixed. A forced event route that is installed and started in the same reference tick now derives its first-step movement configuration from the newly installed route, including its route-scoped grade or exact `tilesPerSecond`, instead of using the session's raw base configuration.

At a 16 px tile size, 9 tiles/s advances `16 * 9 / 60 = 2.4` px per reference tick. The component reproduction therefore advances an event from 96 px to exactly 98.4 px at 60 Hz; the real Christie consumer case advances from 160 px to 162.4 px.

## Root cause and implementation

Route installation already consumed a pending event `routeSpeed` and stored its grade and optional exact rate on the new route. Ordinary event stepping already called `routeSpeedConfig`, and the symmetric player-immediate path already entered `stepPlayerRoute`, which does the same. Only the event-immediate tick-tail helper passed the raw session movement configuration directly to `stepRoute`, so its first step ignored the route fields that had just been latched.

`startForcedRouteInPlace` now captures the installed route and resolves the movement configuration with `routeSpeedConfig(cfg, settings, route.speed, route.tilesPerSecond)` before calling `stepRoute`. This is deliberately local to the event-immediate helper; delayed routes continue through the ordinary fold.

No schema or saved-state shape changed. The engine contract and feature status now explicitly say that immediate player and event routes use the effective newly installed speed.

## Combination audit

The focused matrix covers both actors and both forced-route velocity forms:

| Actor | Route velocity | 60/30/20 Hz first frame | Result |
| --- | --- | --- | --- |
| Player | exact 9 tiles/s | 1/2/3 reference ticks | pass |
| Player | grade 6 | 1/2/3 reference ticks | pass |
| Event | exact 9 tiles/s | 1/2/3 reference ticks | pass |
| Event | grade 6 | 1/2/3 reference ticks | pass |

`moveFrequency` is not a third forced-route velocity form. It is the cadence between autonomous wander/approach decisions; route interpolation is controlled by the speed grade or exact tiles/second value. Accordingly, there is no player/event “frequency-speed immediate route” combination to add. The type contract keeps `frequency` with autonomous controls, while `routeSpeed` alone owns the forced-route grade and exact-rate fields.

The exact event route also has explicit equal-reference-budget settlement at 60/30/20 Hz, save/load continuation with complete state equality, and rewind to the complete pre-route session state.

## Discrimination

The final focused suite reports:

```text
12 pass
0 fail
71 expect() calls
```

In an isolated disposable worktree, restoring the old `stepRoute(..., cfg, ...)` call produced `10 pass / 2 fail`:

- exact event route: expected 98.4 px, received 98 px;
- grade-6 event route: expected 100 px, received 98 px.

The player cases stayed green under that event-only mutation, so the failures identify the repaired path rather than a general timing assertion.

The pre-existing omitted-field assertion also remains green: without `moveRoute.start:"immediate"`, the route stays at `pc:0`, phase zero, and does not move in the publishing tick. Projects that never enter the event-immediate helper therefore retain their previous reducer behavior. Bundle growth is measured separately below.

## Component gates

The cold acceptance sequence started after deleting `dist/`:

```text
bun run build:wasm       PASS (359675-byte wasm)
bun run build:example    PASS
bunx tsc --noEmit        PASS
bun run test             4554 pass, 0 fail, 0 skip
                         730468 assertions, 296 files, 577.73 s
```

The three bundle-isolation suites passed all 13 tests. Resolving the installed route adds 161 bytes to shared session graphs, with pins updated and optional-module isolation retained:

| Bundle | Bytes |
| --- | ---: |
| Meadow | 678,110 |
| Sunstone | 1,102,076 |
| audio fixture | 864,442 |
| rmi-play | 1,291,191 |

## QuickJS performance

The benchmark used three fixed-CPU ABBA windows (`main -> candidate -> candidate -> main`), 2,000 iterations per slot, and six paired deltas per workload. Baseline was `189a6f0d`; the measured implementation candidate was `8a863149`.

| Workload | Paired-delta median |
| --- | ---: |
| battleScene | -0.62% |
| battleSceneImmutable | +0.48% |
| streamedRoam | +0.00% |
| sunstoneControlWalk | +0.39% |
| sunstoneControlWalkImmutable | -0.17% |
| sunstoneIdle | -0.07% |
| sunstoneIdleImmutable | +0.49% |
| sunstoneWalk | +0.06% |

The worst median regression is +0.49%, below the +3% ceiling.

## Consumer gates

All consumer checks used disposable worktrees with real submodule checkouts and real frozen dependency installs. No consumer commit was created.

### pocket-tuxemon main (`4520e7f8`)

```text
BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install --frozen-lockfile
bun run import
bun run build
bun run build:wasm
bun run test

1387 pass
6 skip
0 fail
245711 assertions across 162 files
```

The pinned Tuxemon source was supplied through `TUXEMON_SRC`. The only worktree status entry after the gate was the intentionally changed component gitlink; `bun.lock` and generated tracked files were unchanged. The six consumer-owned conditional UI/pixel skips are pre-existing; the required consumer result is zero failures.

### G17 fidelity branch (`95e6ab09`)

After import and build with the candidate component:

```text
bun test tests/npc-movement-real-map.test.ts

8 pass
0 fail
922 assertions
```

This is the previously blocked file and includes the real `npc_christie` 9 tiles/s immediate route in its exact-reference-tick case.

### pocketjs-wander main (`b827e9ae`)

```text
BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install --frozen-lockfile
bun run build:wasm
bun run build
git status --porcelain --untracked-files=all
bunx tsc --noEmit
bun run test

generated tree: only the intentional component gitlink change
TypeScript: exit 0
523 pass
0 fail
501127 assertions across 45 files
```

`bun.lock` and generated tracked files were unchanged.

## Rebase and repository hygiene

The final fetch left `origin/main` at `189a6f0d`; `git rebase origin/main` reported that the branch was already up to date. There are no merge commits. All implementation commits use `lfkdsk <lfkdsk@gmail.com>`, have no co-author footer, and `bun.lock` is unchanged. After the rebase check, the focused 12-test suite, TypeScript, and `git diff --check` all passed again.

subagent 使用：3 个 / 分别审计玩家与事件路线及 frequency 语义、设计辨识性与变异测试、核对三个消费者门禁流程 / 节省了并行只读调研时间；主 agent 亲自集成并复跑全部门禁

PASS
