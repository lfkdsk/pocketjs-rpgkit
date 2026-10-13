# RPG Maker screen capability lifecycle

Implementation candidate: `083636dcc149befa6bb01be537d55c7e10be482e`
Performance baseline: `a4dc4e72341ae6aa7373623f83dbd07124316a6d`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

The optional RPG Maker screen lifecycle now fails visibly when authored
content is missing its reducer or rendering capability, and it follows the
pinned MV/MZ battle-entry clear boundary after a battle is actually accepted.
Inline, common-event, staged and lazy map programs are covered; both live and
attract `GameView` sessions supply an explicit presentation policy. A deliberate
headless reducer remains able to omit only the rendering policy.

The strict QuickJS decision run puts unused-feature `streamedRoam` cost at
**+2.922%**, with a block-bootstrap 95% interval of **[+2.560%, +3.342%]**.
The point estimate is below the +3% acceptance boundary and the interval
straddles it, so these data do not confirm a regression greater than 3%.

## Capability admission

Session admission recursively scans every nested result branch for the
optional screen features it actually uses. `screenTone` and `weather` require
the `rpgMakerText` reducer runtime. Tone, weather, numbered pictures, the
timer and map-name display additionally require the rendering host's
`screenPresentation` capability. The same validation runs before an inline or
common-event world is compiled, during staged acquisition, and before a lazy
map is cached.

Presentation has an intentional three-state policy:

- `true` means a rendering host registered presentation;
- `false` means a rendering host explicitly lacks presentation, so authored
  visible commands are rejected with the command names in the error;
- omitted/`null` identifies a deliberate reducer-only caller that may inspect
  or save state without painting it.

`GameView` now passes the boolean policy to both its live session and its
attract controller. An integration test constructs each real host path and
proves validation runs before any JSX or PocketJS host work. The importer
coverage report separately names the required application capability, the
source command codes and counts, and the registration point; it no longer
implies that a natively converted command is a complete host integration.

Ordinary projects contain none of these command dependencies and continue
through the same nullable capability path. The project schema, map schema hash
and save format did not change.

## Pinned battle-entry semantics

The reference boundary is official MV core
`rpgtkoolmv/corescript@182e31449707ba7e406db0485c44c2a9d11e2dcd`,
`js/rpg_objects/Game_Screen.js:25-31`, and MZ v1.1.0 mirror
`stak/rmmz-corescript@5ecc09ae5170c6aee71c7d9513e553e3dbea116b`,
`js/rmmz_objects.js:782-788`. Both clear fade, flash, shake, zoom and the stale
battle-picture bank while retaining tone and weather.

The kit clears exactly the stock banks it models: `fade`, `flash` and `shake`.
It has no RPG Maker zoom bank; `camera` is a map-owned kit feature. It also has
one live numbered-picture bank rather than stock map/battle namespaces, so it
does not erase valid map pictures. Tone, weather, named tint, camera, backdrop,
backdrop history and pictures survive.

Cleanup is capability-owned and occurs only after `BattleRules.start()` returns
a valid battle start. A reducer that declines entry with `null` resumes its
fiber without cleanup. A project that did not register the RPG Maker runtime
does not enter this lifecycle and retains all native screen state byte-for-field.

## Determinism, saves and rewind

The battle fixture seeds every relevant screen bank, enters a real capable
battle, and checks the exact removed and surviving fields. Its negative controls
cover a declined battle and an ordinary project. The same scenario is folded at
60, 30, 20 and 4 Hz, saved and restored, then compared byte-for-byte. Screen
copy-on-write also keeps the published predecessor unchanged.

An attract timeline enters across the cleanup boundary, captures keyframes,
rewinds and replays at 60, 30 and 20 Hz. Each replay reaches the exact
uninterrupted bytes, including the surviving clocks and map-owned presentation.

## Mutation strength

Each mutation ran in a separate detached worktree with real dependencies and
an unchanged lockfile. All three were removed afterwards.

| Isolated mutation | Discriminating result |
| --- | --- |
| Make capability validation a no-op | 63 pass, 6 fail across 69 tests; inline/common, staged, lazy, live `GameView` and attract `GameView` admission all failed as expected |
| Remove the accepted-battle cleanup hook | 47 pass, 4 fail across 51 tests; exact cleanup, multi-rate/save and both rewind boundaries failed |
| Clear fade/flash/shake for an ordinary project | 29 pass, 1 fail; the byte-for-field ordinary-battle negative control alone caught the spill while the capable positive case still passed |

## Bundle and startup cost boundary

Capability admission is load-time work, not a free bundle change. Relative to
the immediately preceding pins, recursive program scanning and the paired
ordinary-tileset passage fast path add the following raw minified bytes:

| Graph | Before | Candidate | Admission scan | Passage fast path | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Meadow | 678,110 B | 683,113 B | +4,205 B | +798 B | +5,003 B |
| Sunstone and audio-enabled controls | 1,102,076 B | 1,107,296 B | +4,422 B | +798 B | +5,220 B |
| Opted-in RPG Maker fixture | 1,291,191 B | 1,296,648 B | +4,659 B | +798 B | +5,457 B |

The latest base's immediate-route first-step fix adds the same 161 B to both
the before and candidate columns, so it does not change any branch delta.
The implementation still does not pull the optional RPG Maker reducer or
presentation modules into ordinary graphs; positive/negative module needles
guard that boundary. Session creation performs the recursive scan once. The
shared 798 B short-circuit avoids building a runtime-passage lookup when no
map overrides exist. The steady-state path retains sparse state and fast-path
exits, which the QuickJS table below measures separately from this disclosed
startup/bundle cost.

## QuickJS unused-feature cost

`streamedRoam` is the current benchmark name for the older `wanderAuto`
wording. The formal driver uses fixed CPU affinity and contiguous
main-candidate-candidate-main windows. Each full-table slot runs 2,000
iterations and nine internal timing rounds; paired deltas preserve both
directions inside their window.

The exact baseline was `a4dc4e72341ae6aa7373623f83dbd07124316a6d`;
the candidate and PocketJS revisions are listed at the top of this report.
The timed guest was pinned to CPU 7 and its SMT sibling CPU 23 was sampled
once per second. A 30-second preflight immediately before the final full-table
window recorded one-minute load `2.61 -> 2.57`: CPU 7 averaged 99.43% idle
(96.00% minimum) and CPU 23 averaged 99.87% idle (98.02% minimum). Process
snapshots showed a stable `corplink-uc` worker on CPU 8; competing project work
was paused or kept off the measured CPU pair.

Every accepted window has its own `uptime`, CPU and process timeline. A window
was accepted only when the complete main-candidate-candidate-main block had no
new external heavy process and no CPU 23 sample below 95% idle. Polluted blocks
were discarded whole. In the focused collection this rejected seven complete
blocks: three for new external `git status` scans, two for sibling minima of
87.76% and 94.00%, and two for a newly started `ranked.py` workload. No slot
from any rejected block contributes to the table or bootstrap.

The three accepted full-table blocks had the following measured environment:

| Block | 1-minute load | CPU 23 idle average | CPU 23 idle minimum | Clean samples |
| --- | ---: | ---: | ---: | ---: |
| W1 | 3.83 -> 3.52 | 99.64% | 98.00% | 53 |
| W2 | 2.59 -> 3.39 | 99.69% | 97.00% | 54 |
| W3 | 2.55 -> 2.78 | 99.59% | 95.10% | 54 |

The full-table result is the median of six directional paired deltas from
three independently accepted blocks. The range is included because this
shared host has visible between-block jitter; values above 3% in this screening
table are not by themselves a confirmed regression.

| Case | Median delta | Directional range |
| --- | ---: | ---: |
| `sunstoneIdle` | +3.567% | -0.284% to +4.325% |
| `sunstoneWalk` | +2.819% | +1.430% to +4.216% |
| `sunstoneControlWalk` | +1.640% | -1.626% to +5.100% |
| `streamedRoam` | +5.342% | -1.225% to +7.698% |
| `battleScene` | -2.722% | -6.332% to +7.740% |
| `sunstoneIdleImmutable` | +5.613% | -1.619% to +7.423% |
| `sunstoneControlWalkImmutable` | +3.488% | -0.005% to +5.202% |
| `battleSceneImmutable` | -1.215% | -5.403% to +12.430% |

The required focused run increased `streamedRoam` to 4,000 iterations per
slot while retaining nine internal timing rounds. Twelve independently clean
ABBA blocks contributed 24 directional deltas:

| Block | 1-minute load | CPU 23 idle avg/min | Forward | Reverse |
| --- | ---: | ---: | ---: | ---: |
| W01 | 3.25 -> 3.03 | 98.81% / 96.00% | +4.593% | +2.774% |
| W02 | 3.03 -> 2.95 | 98.77% / 95.05% | +2.417% | +4.099% |
| W03 | 4.00 -> 3.77 | 99.00% / 97.03% | +3.140% | +3.228% |
| W04 | 3.42 -> 3.40 | 99.41% / 99.00% | +1.342% | +3.008% |
| W05 | 3.85 -> 4.15 | 99.42% / 97.06% | +2.016% | +3.462% |
| W06 | 4.06 -> 3.74 | 98.32% / 95.10% | +5.448% | +2.069% |
| W07 | 3.89 -> 3.80 | 99.59% / 97.06% | +2.117% | +3.899% |
| W08 | 2.38 -> 2.33 | 100.00% / 100.00% | +2.360% | +3.546% |
| W09 | 2.33 -> 2.38 | 99.00% / 96.04% | +2.836% | +3.684% |
| W10 | 2.38 -> 2.34 | 99.50% / 98.04% | +3.422% | +3.342% |
| W11 | 3.59 -> 3.40 | 98.69% / 97.03% | +2.230% | +2.560% |
| W12 | 3.77 -> 3.66 | 99.50% / 96.04% | +2.584% | +2.296% |

The decision point is the median of all 24 directional deltas: **+2.922%**.
A deterministic percentile bootstrap (1,000,000 resamples, seed `0x4b464958`)
resampled the 12 complete blocks, always retaining each block's forward and
reverse pair. Linear percentile interpolation gives the 95% interval
**[+2.560%, +3.342%]**. Because the estimate is below 3% and the interval
crosses rather than clears 3%, the run does not establish a greater-than-3%
regression and does not trigger a performance fix.

## Consumer validation

### Wander

A disposable worktree of Wander `dc7cb6127ea4c60ab0c30c028a373dac92d1ed94`
used component `083636dc` and PocketJS `862040bd`. Frozen-lockfile install,
wasm rebuild, both Wander builds and TypeScript passed. The complete suite
finished with 523 pass, 0 fail and 501,127 assertions across 45 files in
100.64 seconds.

### Tuxemon

A disposable worktree of Tuxemon
`4520e7f87c8514929609ce7162449159960f4253` used the same component and
PocketJS revisions. Frozen-lockfile install, wasm rebuild, the full source
import, production build and TypeScript passed. The complete suite finished
with 1,387 pass, 6 browser-condition skips, 0 fail and 245,711 assertions
across 162 files in 434.41 seconds. The skips are consumer-only browser UI
conditions, not component gate skips.

Neither consumer was committed. Their only tracked change is the disposable
component submodule pointer.

## Final component gates

After deleting `dist/`, the required order completed on the rebased candidate:

| Gate | Result |
| --- | --- |
| `bun run build:wasm` | pass; web wasm 359,675 B |
| `bun run build:example` | pass |
| `bunx tsc --noEmit` | pass |
| `bun run test` | 4,567 pass, 0 fail, 0 skip; 730,551 assertions across 297 files in 504.48 seconds |

## Compatibility and hygiene

The final branch is a linear, non-merge series directly above current
`origin/main` `afbde1c529f3f96ac4551f5f2a19da101f2d3a6c`; its merge base is the
same revision. The PocketJS submodule remains pinned to the expected revision.
There is no `bun.lock`, schema or generated-map change. `git diff --check`,
public-path scanning, commit-author scanning and merge-commit scanning pass.
The only final worktree change before delivery is this report.

subagent 使用：3 / capability paths and silent mutation; pinned battle semantics and no-cleanup mutation; verification mapping and ordinary-project spill mutation / saved parallel review time

PASS
