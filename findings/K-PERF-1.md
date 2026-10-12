# K-PERF-1: consumer cold-start isolation

## Verdict

PASS. RPG Maker text, styled choices, tone/weather rules, followers and
vehicles are now explicit engine and presentation capabilities. Projects that
do not register them no longer bundle or evaluate their concrete modules. All
seven formal QuickJS cold-start profiles are at or below the +3% gate; the
worst result is Wander Online 480x272 at +2.742%.

The implementation was rebased onto `origin/main` `49b19d5a` without a merge
commit. The formal timing candidate was `41ceb721`; after the rebase and its
test-only integration fixes, the runtime/consumer tree at `969dc51b` rebuilt
the two Wander bundles to the exact same byte count and SHA-256, so the formal
samples still measure the delivered runtime.

## Diagnosis

The original `0aecc05a` upgrade admitted four concrete optional modules to
Wander's pass-1 input graph:

- `src/engine/rpgmaker-text.ts`
- `src/engine/travel.ts`
- `src/ui/ChoiceColourLine.tsx`
- `src/ui/choice-colour.ts`

Wander Online admitted the first two. PocketJS pass 1 follows the static
module graph, so a run-time `system.rpgMakerText` or follower/vehicle branch
could not remove their parsing, reducer and presentation code from the final
QuickJS program.

A deterministic Wander size walk over the component history located the main
admissions. This diagnostic used the desktop bundle, so its absolute byte
counts differ slightly from the formal web bundle; the per-commit deltas are
the relevant result.

| Component revision | Feature introduced | Wander JS (bytes) | Delta |
|---|---|---:|---:|
| `a4dc4e72` | consumer baseline | 850,082 | - |
| `56996733` | RPG Maker message escapes | 866,407 | +16,325 |
| `8c342c70` | followers and vehicles | 898,441 | +32,034 |
| `7323c5d7` | vehicle music | 914,686 | +16,245 |
| `161e76cf` | scrolling text | 917,983 | +3,297 |
| `0aecc05a` | upgraded component | 925,397 | +75,315 total |

The earlier cold-start failure tracked bundle evaluation, not map simulation
or a PocketJS change: both sides used nested PocketJS `862040bd`, while Wander
480x272 bundle evaluation regressed +14.193%. The dependency graph and commit
walk therefore identified static capability reach as the fix boundary.

## Implementation

The ordinary engine and UI now depend only on small contracts:

- `rpgmaker-text-contract.ts` describes text preparation and screen-rule hooks;
  `rpgmaker-text.ts` and `rpgmaker-screen.ts` are explicit implementations.
- `travel-contract.ts` and `travel-types.ts` keep shared types inert;
  `travel-session.ts` owns definitions, caches and reducer hooks, while
  `TravelActors.tsx` owns presentation.
- `choice-text-contract.ts` and `travel-presentation-contract.ts` keep
  `DialogBox`, `ChoiceIconBox`, `ScrollTextLayer` and `GameView` independent of
  the concrete styled-text and travel renderers.
- `session.ts`, `interpreter.ts`, save/restore and screen advancement delegate
  through a project-bound capability. A project without the feature retains a
  nullable runtime and sparse state rather than constructing a hidden
  implementation path.
- Package exports expose separate `./rpgmaker-text`, `./rpgmaker-screen`,
  `./travel`, `./ui/rpgmaker-text` and `./ui/travel` entries. The schema did not
  change.

An opted-in project that declares RPG Maker text or travel data without its
engine capability fails early with a content error. Headless sessions register
the engine capability; `GameView` additionally receives the presentation
capability. Usage and current limitations are documented in
`src/engine/README.md`, and `docs/status.md` marks the delivered isolation.

The component-owned QuickJS helper was also brought up to the pinned PocketJS
host API: it mounts audio and network hosts and uses the current idle-GC entry.
`tools/kp1-quickjs-bench.sh` gained `KP1_COMPILE_ONLY=1`, allowing the release
host to be compiled once and then reused by fresh benchmark processes. The
formal host SHA-256 is
`0ba9cb3ab7f99427146be401482136c8e81b452e22a5236d162a40feb697e9d5`.

## Bundle isolation and size

`tests/rpgmaker-capability-bundle-isolation.test.ts` checks both the pass-1
input manifests and final bundle text. Meadow and Sunstone contain none of the
eight concrete implementation modules; `rmi-play` is the positive control and
contains all eight. The test also pins all three byte counts.

| Bundle | Baseline (bytes) | Final (bytes) | Delta | Delta percent |
|---|---:|---:|---:|---:|
| Wander | 849,902 | 890,187 | +40,285 | +4.740% |
| Wander Online | 1,086,786 | 1,115,908 | +29,122 | +2.680% |
| Tuxemon | 2,089,032 | 2,086,828 | -2,204 | -0.106% |
| Meadow | 722,929 | 667,866 | -55,063 | -7.617% |
| Sunstone | 1,161,185 | 1,101,055 | -60,130 | -5.178% |

The opt-in `rmi-play` positive control is 1,278,531 bytes. Relative to the
broken `0aecc05a` upgrade, isolation recovered 35,030 bytes from Wander and
31,340 bytes from Wander Online. The remaining Wander growth is the ordinary
engine surface added since `a4dc4e72`, not the removed concrete capability
implementations.

The preserved formal-candidate bundles and a clean final rebuild agree exactly:

| Bundle | Candidate bytes / SHA-256 | Final bytes / SHA-256 |
|---|---|---|
| Wander | 890,187 / `0d98f0bd4097eae23112efd3b719676fdb1fd4e02368d3f3dadc456157a93409` | identical |
| Wander Online | 1,115,908 / `3f727901de36a1ac5a8d2be0379efc1305ef46971c43e280ce93c38b3961fbf0` | identical |

`git diff --quiet 41ceb721..969dc51b -- src package.json examples
vendor/pocketjs` also reports an identical runtime/consumer tree. Rebase-only
changes were tests, documentation and importer tooling, plus explicit runtime
registration in the newly landed RPG Maker fixtures.

## Mutation strength

The negative control was mutated only in a disposable worktree. Replacing the
contract import in `session.ts` with a static import from
`rpgmaker-text.ts` made Meadow admit `engine/rpgmaker-screen.ts` and
`engine/rpgmaker-text.ts`; its JS grew from 667,866 to 680,234 bytes. The
isolation suite then failed both the implementation-graph assertion and the
byte-size assertion (`2 pass, 2 fail`). The mutation worktree was removed after
the logs and patch were retained.

## Formal QuickJS cold start

Formal baselines were RPG Kit `a4dc4e72` for Wander and Wander Online,
`0aecc05a` for Tuxemon, and `8c05304d` for Meadow and Sunstone. The measured
candidate was `41ceb721`; the exact bundle equivalence above carries those
measurements to the rebased runtime.

The release host ran three rounds for each profile. Every profile used one
contiguous `A1-B1-B2-A2` block per round; every slot used one unmeasured fresh
process followed by seven measured fresh processes. The gate is the mean of
the six baseline or candidate slot medians. CPU/sibling idle checks and
heavy-process checks rejected whole blocks before publication rather than
filtering individual samples.

The dataset contains 588 accepted observations. Twelve contaminated or
insufficiently idle attempts were retained separately and contributed no rows
to the accepted table.

| Profile | Baseline startup (ms) | Final startup (ms) | Startup delta | Baseline eval (ms) | Final eval (ms) | Eval delta |
|---|---:|---:|---:|---:|---:|---:|
| Meadow 480x272 | 39.209 | 37.099 | -5.383% | 36.622 | 34.452 | -5.926% |
| Wander Online 480x272 | 59.095 | 60.716 | +2.742% | 54.452 | 56.018 | +2.876% |
| Wander Online 960x544 | 59.488 | 60.637 | +1.932% | 54.916 | 55.899 | +1.791% |
| Sunstone 480x272 | 67.464 | 66.120 | -1.992% | 61.712 | 60.132 | -2.562% |
| Tuxemon 480x272 | 250.279 | 248.527 | -0.700% | 162.199 | 160.139 | -1.270% |
| Wander 480x272 | 117.570 | 120.139 | +2.185% | 109.013 | 111.466 | +2.250% |
| Wander 960x544 | 147.128 | 147.097 | -0.021% | 126.981 | 127.086 | +0.083% |

All four Wander/Wander Online viewports satisfy the +3% cold-start gate.
Tuxemon, Meadow and Sunstone do not regress. The largest startup delta is
+2.742%, and the largest bundle-evaluation delta is +2.876%, both on Wander
Online 480x272.

Formal Fleet artifacts:

- `54603`: summary and calculated tables
- `54604`: revisions, host hash, machine and accepted-block provenance
- `54605`: 588 accepted sample rows
- `54606`: raw host output
- `54607`: 12 rejected attempts

## Behaviour and visual review

Opt-in RPG Maker projects continue to parse escapes, lay out coloured and
positioned text, advance tone/weather, and render followers/vehicles. Existing
framebuffer goldens remained byte-exact. The newly rebased MZ `PX`/`PY`/`FS`
fixture explicitly registers both capabilities and passes at 480x272 and
960x544.

Seven key frames were opened at original resolution. Tone was shared coherently
by map and window chrome; rain and snow remained visible without obscuring
actors or text; MZ coloured/positioned runs kept their authored relationships
at both viewports; follower and parked travel actors remained distinct and
unclipped. The visual suites also assert semantic pixels for tone, particle
placement, text colour, cursor displacement, font height and complete window
bounds. The manual review is Fleet artifact `54614`.

## Final gates

The final sequence started from a deleted `dist/` and completed on the rebased
branch:

| Gate | Result |
|---|---|
| `bun run build:wasm` | pass; `pocketjs.wasm` 359,675 bytes |
| `bun run build:example` | pass; every example and density variant rebuilt |
| `bunx tsc --noEmit` | pass |
| Targeted rebase integration suite | 23 pass, 0 fail |
| `bun run test` | 4,529 pass, 0 fail, 0 skip; 730,211 assertions across 294 files |
| Final `git fetch origin main` | runtime tree was 11 ahead / 0 behind before this report-only commit; base remains `49b19d5a` |
| Merge commits / `bun.lock` diff | none / none |

No Wander commit history was changed. The outdated adapter was component-owned
and is fixed here, so NET-BUMP-1 needs only to consume the merged component and
repeat its release integration; no separate Wander adapter patch is required.

subagent 使用：3 / deps 查依赖图、bench 查基准与 adapter、tests 查历史与测试辨识力 / 节省了时间
PASS
