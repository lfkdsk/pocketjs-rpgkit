# NET-INT-A integration report

## Result

The repository split, endless-realm phase A, and shared budget breaker are integrated across the component, Wander, and server repositories. The three working trees are clean, no branch was pushed, and nothing was deployed.

## Revisions and dependency chain

| Repository | Branch | Validated code revision | Relationship |
| --- | --- | --- | --- |
| Pocket RPG Kit | `split-wander-2` | `18c2f4f685f5a3a590f5d4543651a6aed56bd690` | five split commits replayed on `origin/main` `e8c058eb3f76e47f6077e21fedb7be18bf3422e8` |
| PocketJS Wander | `net-int` | `1bf6d07348e0cbb1058bc6669210bcacabb6f190` | based on `net-world-a` `09978b4092cbe26efd7b8e1e21d5f71b362f0e67`; component submodule at `18c2f4f6` |
| Pocket Online Server | `net-int` | `dfe36d71e713bbbde9a7b0a17d2922e8d1f6c0f8` | based on `origin/main` `52b1931c14ba0626a86a23be0b11a68b795e3cc6`; merges server `net-world-a` `e96325345cd1a189b05415026dbb89a1a6703137`; Wander submodule at `1bf6d07` |

These are the revisions on which the gates ran. The final handoff tips add only this report and transitive submodule-pin commits: component `split-wander-2` contains this file, Wander `net-int` pins that component tip, and server `net-int` pins that Wander tip. Their final hashes are emitted with the handoff so every submodule points at the delivered upstream branch HEAD without pretending that self-referential commit hashes can be embedded here.

The server integration merge is `389392da1a0521cdfe4d140b16b120c6d803367a`, with parents `52b1931c` and `e9632534`. The latter already contains `split-wander-v3` `5d2bbe9`, so that branch was not merged a second time. All committed `.gitmodules` entries retain their GitHub URLs; local repository URL rewriting was configuration only.

## Component replay and conflict resolutions

`6709c69a` was already in the new mainline. The exclusive range `6709c69a..d1ee2df6` replayed as:

| Original | Rebased |
| --- | --- |
| `ca32b269` | `fabd53da` |
| `4c236112` | `251b4e7f` |
| `94a7576c` | `48f6b3ec` |
| `59563f81` | `a9484274` |
| `d1ee2df6` | `18c2f4f6` |

`git range-diff 6709c69a..d1ee2df6 origin/main..18c2f4f6` reports all five patches as `=` at the validated code tip. The manual resolutions were:

1. `docs/status.md`: retained the three newer NPC-movement capabilities from main while replacing the in-tree Wander entries with the standalone Wander repository link.
2. `tests/battle-ui-bundle-isolation.test.ts`: retained main's measured exact bundle pin of `984_012` bytes while applying the split's repository-neutral checks.
3. `tests/sunstone-game-sim.test.ts`: retained main's `<985_000` bundle ceiling while applying the split changes.

`bun.lock` is unchanged.

## Wander integration

The Wander branch pins the rebased component and adds the two requested review follow-ups:

- A reconstructed Durable Object gets a deterministic new epoch. The client reconnect test verifies that the new epoch replaces the old one and that prediction state is rebuilt rather than carried across the restart.
- Realm admission has a hard safe bound of 32 players. `tryAdd()` refuses before allocating an id or mutating players, focus state, caches, or plans; the server closes a full join with code `1008` and reason `full`. Unit and real-WebSocket tests cover both the invariant and the client-visible refusal.

Wander validation:

| Gate | Result |
| --- | --- |
| focused online tests | 23 pass, 0 fail |
| `bun run tsc` | exit 0 |
| `bun run build:wasm` | exit 0 |
| `bun run build` | exit 0 |
| `bun run test` | 316 pass, 0 fail across 25 files (59.08 s) |
| Pages smoke | `/`, `/wander/`, `/wander-online/`, and `/pocketjs.wasm` returned 200; the game index contains both apps |

## Server integration and budget coverage

The Worker uses one fail-closed budget gate and positive cache for both `/ws` and `/ws/v4`. It reserves the Meter request before scanning either legacy or `v4:` rooms, and an open soft breaker refuses before waking a target Room. `/stats` and `/stats/v4` also charge before their Room fetch.

The Room Durable Object now applies the hard breaker to both arena types: it stops the ticker, closes joined and pending sockets with `1008/rest`, and forces the final usage flush. Realm JOIN and INPUT messages increment inbound-message usage, realm occupancy contributes duration, and internal requests and wakes reach the same ledger. `ROOM_CAP` is normalized to an integer in the safe 1–32 range, passed into `RealmArena`, and enforced with atomic `tryAdd()`; a real RoomDO test proves that a second v4 player at capacity receives `1008/full` while both server and arena rosters remain at one.

Server validation after the capacity change:

| Gate | Result |
| --- | --- |
| `bun run typecheck` | exit 0 |
| focused config and RoomDO tests | 74 pass, 0 fail |
| `bun test ./tests/` | 158 pass, 0 fail, 983 expectations across 8 files (15.23 s) |

Five mutations were run only in isolated disposable worktrees/copies and then removed:

| Mutation | Test response |
| --- | --- |
| remove `/ws/v4` from the Worker budget gate | 2 Worker tests failed |
| step only a legacy arena, omitting realm duration | 1 realm-ledger test failed |
| stop counting v4 inbound messages | exact ledger assertion failed (`0` instead of `2`) |
| bypass realm hard-cutoff handling | hard-stop test failed with a live ticker |
| raise the normalized realm cap from 32 to 64 | config test failed (`33` received instead of `32`; 8 pass, 1 fail) |

## Component gate

The component gate was run from a deleted `dist/` directory:

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | exit 0; WebAssembly output 359,675 bytes |
| `bun run build:example` | exit 0 |
| `bunx tsc --noEmit` | exit 0 |
| `bun run test` | 4,037 pass, 0 fail, 725,138 expectations across 247 files (438.52 s) |

## Dual-protocol local acceptance

`scripts/demo-cf.sh` ran a pinned pre-split component client (`e8c058eb`) on legacy `/ws` beside the `net-int` Wander client on `/ws/v4` against one local Worker:

- Restart changed the realm epoch from `2159954106` to `3305431520`; the v4 web and both desktop clients reconnected with no console errors.
- The legacy and realm browser views each reached `ROOM 1 / ALL 2`, proving cross-protocol account-wide visibility while room populations stayed isolated.
- Before cutoff, the ledger showed 316.6 requests with hard false. After 4,637 health requests plus concurrent room activity, it showed 5,003.1 requests against the deliberately low 5,000-request hard plan.
- New upgrades on both `/ws` and `/ws/v4` received `1008/rest`; both already-connected browser rooms entered the retrying/closed-for-the-month state.
- Eight captured PNGs were opened and checked visually. Joined frames show the expected map and `ROOM 1 / ALL 2`; cutoff frames show `CLOSED FOR THE MONTH · RETRY 15s`. The automated image checks also found full-frame coverage and the expected HUD/map color classes at both 480×272 and 960×544 logical sizes.

## Handoff order

1. Push component `split-wander-2` to a remote branch only; do not merge it into component main yet.
2. Once that submodule commit is remotely resolvable, merge/push Wander `net-int` to Wander main.
3. Once the Wander commit is remotely resolvable, merge/push server `net-int` to server main and deploy the server.
4. Changes to `lfkdsk-auth` and merging the component split into component main remain deferred until explicit user confirmation.

subagent 使用：3 个 / 分别审计组件重放、Wander 补测和服务器预算集成；主代理复核并执行全部重型门禁、变异与端到端演示 / 是，并行审计缩短了集成核对时间

PASS
