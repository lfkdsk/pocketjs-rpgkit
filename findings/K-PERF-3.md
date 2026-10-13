# K-PERF-3 — recovering cumulative `streamedRoam` drift

Candidate: `fleet/task-4505`, based on `origin/main` `7722952d`. The runtime
bundle measured below is `a007b610…`; the later benchmark-guard and bundle-pin
commits do not change it.

## Verdict

**PASS.** The performance target and every component/consumer gate pass. The
candidate is **1.486% faster** than fixed historical baseline
`a4dc4e72` on the six-window focused run (95% block-bootstrap interval
[-1.696%, -1.029%]), well below the required +1% ceiling.

## 1. Measurement method and host state

Every reported timing is from the PocketJS desktop host's QuickJS guest, not
Bun/JSC. Timed processes were pinned with `taskset` to CPU 7; its SMT sibling
is CPU 23. Before formal runs neither CPU had a high-CPU resident process. The
formal attribution windows recorded one-minute load mostly between 3.4 and
5.3 on this 32-core host; the final fixed-baseline windows recorded 4.35–6.26,
and the final pre-optimization comparison recorded 4.96–6.49. No subagent ran
commands during timing.

Each window is baseline → candidate → candidate → baseline (ABBA). A window
contributes two directional ratios, slot 2 / slot 1 and slot 3 / slot 4. Tables
report the median of those ratios. Confidence intervals resample whole ABBA
windows, preserving the paired directions. Full-table commands that could not
fit the command runner's five-minute limit were split only at complete window
boundaries; bundle, host, CPU and iteration hashes were checked before their
complete blocks were combined.

## 2. Where the drift accumulated

The original head `7722952d` measured **+3.14%** against `a4dc4e72` in a
three-window focused ABBA (six directional pairs, +2.65% to +3.79%). A broader
four-window palindrome then compared eight history checkpoints in one warm
host:

| History interval | Contents at the boundary | Median | 95% block interval |
| --- | --- | ---: | ---: |
| `a4dc4e72 → 8c342c70` | K-RPGM1 + K-FOLLOW | **+1.448%** | [+0.969%, +1.995%] |
| `8c342c70 → de66edab` | polish + early RPG Maker follow-ons | +0.488% | [+0.241%, +0.747%] |
| `de66edab → 0aecc05a` | battle/audio sequence through G13 | +0.175% | [-0.901%, +0.712%] |
| `0aecc05a → 49b19d5a` | K-RPGM5–7 | **+1.040%** | [-0.637%, +1.931%] |
| `49b19d5a → 2a37b9aa` | K-PERF-1 | -0.144% | [-1.723%, +0.814%] |
| `2a37b9aa → 4929290c` | K-TUX-1 | **+0.881%** | [+0.218%, +1.463%] |
| `4929290c → 7722952d` | later fixes, audio and Tuxemon support | +0.373% | [+0.209%, +1.636%] |

The medians are not additive—the measurements share neither denominators nor
noise—but they identify the three durable steps. Two six-window nested
palindromes narrowed the first two:

- K-RPGM1 itself: +0.667%, 95% [+0.277%, +1.414%]; K-FOLLOW on top:
  +0.809%, 95% [+0.598%, +1.418%].
- K-RPGM5–7 as a group: +1.003%, 95% [+0.724%, +1.079%]. K-RPGM5's
  `c2900879` screen/system engine commit contributes +1.048%, 95%
  [+0.839%, +1.750%]; the remaining tileset/runtime tail is statistically
  flat (-0.305%, interval crossing zero). K-RPGM6/7 also produce the same
  benchmark bundle at their outer boundary.

The per-merge three-window traces are intentionally retained as diagnostic
evidence, but several contain opposite-direction outliers. The longer shared-
host palindromes above are the attribution result; no single change had crossed
the old 3% gate even though the fixed-baseline total did.

## 3. Behavior-preserving hot-path changes

### Optional step counting

Ordinary projects used to derive `playerMoved` every reference tick even when
neither RPG Maker Steps nor a `playerStep` extension was present. The movement
comparison and sparse bank update now live under the existing compiled
`sess.stepCounter` capability; a separately registered `playerStep` hook still
does its comparison at the same point. A six-window nested A/B measured the
Steps-only change at **-0.743%**. Steps, region-edge, save/load and replay tests
retain their exact landing semantics.

### Optional `worldIdle` context

The compiler now records whether any page condition or nested command branch
reads `worldIdle`. Compiled worlds that do not read it skip both
`sessionWorldIdleBlockers` construction and the idle derivation in live
condition contexts. A hand-constructed `World` with no marker remains
conservative (`undefined !== false`), so this is an optimization only for
compiler-proven absence. A six-window A/B against the Steps-only candidate
measured **-3.930%**, 95% [-4.286%, -3.412%]. Tests cover absent use, a page
condition and a nested branch condition; the existing idle suite continues to
exercise true/false behavior.

The shared code costs 534 bundle bytes in Sunstone; the bundle pin records that
source explicitly and its isolation needles still exclude battle code.

### Candidates rejected rather than accumulated

Request draining, lazy motion synchronization and deletion of copied system
fields showed no stable benefit and were reverted. A backdrop-removal mutation
had an interval crossing zero. A real travel-capability gate then regressed the
focused median by +0.742% (95% [+0.431%, +1.335%]); it too was reverted. No
behavior-breaking mutant is present in the branch.

## 4. Final QuickJS results

### Fixed historical baseline

The primary target run is six focused windows, 4,000 iterations per slot, 9
internal host samples per slot:

| Case | Candidate vs `a4dc4e72` | 95% block interval | Pairs |
| --- | ---: | ---: | ---: |
| `streamedRoam` | **-1.486%** | **[-1.696%, -1.029%]** | 12 |

The full eight-case sensitivity table uses three complete windows at 4,000
iterations. The first command supplied rounds 1–2; an identical bundle/host
supplement supplied round 3.

| Case | Candidate vs `a4dc4e72` | 95% block interval |
| --- | ---: | ---: |
| `sunstoneIdle` | -3.118% | [-4.701%, -2.765%] |
| `sunstoneWalk` | -3.218% | [-4.251%, -2.627%] |
| `sunstoneControlWalk` | -2.427% | [-3.990%, -0.164%] |
| `streamedRoam` | -3.018% | [-4.290%, -1.114%] |
| `battleScene` | +0.710% | [-1.987%, +1.245%] |
| `sunstoneIdleImmutable` | -1.759% | [-3.979%, -1.293%] |
| `sunstoneControlWalkImmutable` | -1.211% | [-2.098%, +0.606%] |
| `battleSceneImmutable` | +1.161% | [-0.190%, +1.302%] |

Both battle intervals cross zero and remain far below 3%; every map/wander case
improves. The focused six-window result is the higher-confidence acceptance
number for `streamedRoam`.

### Optimization-only comparison

Three complete full-table windows compare the final runtime directly with the
pre-optimization `7722952d` runtime (2,000 iterations per slot):

| Case | Final vs pre-optimization | 95% block interval |
| --- | ---: | ---: |
| `sunstoneIdle` | -6.117% | [-6.223%, -5.096%] |
| `sunstoneWalk` | -7.796% | [-9.942%, -7.252%] |
| `sunstoneControlWalk` | -4.224% | [-5.067%, -3.498%] |
| `streamedRoam` | **-4.528%** | [-4.528%, -1.724%] |
| `battleScene` | -0.813% | [-1.264%, +0.911%] |
| `sunstoneIdleImmutable` | -7.470% | [-9.197%, -6.005%] |
| `sunstoneControlWalkImmutable` | -4.741% | [-6.381%, -1.685%] |
| `battleSceneImmutable` | -0.087% | [-2.307%, +0.446%] |

No case has a positive median. The two battle intervals cross zero, as expected
for paths that do not benefit from the idle-world gate.

## 5. Fixed-history regression guard

`tools/pr1-quickjs-bench.sh --guard <change-base>` now performs two independent
checks:

1. candidate versus the supplied change base (`single_limit_pct`);
2. candidate versus the fixed full SHA in
   `tools/pr1-quickjs-baseline.conf` (`cumulative_limit_pct`).

Both limits are currently 3.0%. Guard mode requires a clean worktree, at least
three ABBA windows, a reachable configured SHA, and the fixed baseline to be an
ancestor of the change base. It uses unique temporary worktrees rather than
force-removing a shared scratch checkout. The external AWK analyzer requires
exactly one positive row for every round × slot × requested case, checks the
ABBA labels, emits `PR1_QJS_RESULT` / `PR1_QJS_COMPARISON_RESULT`, and returns
0 (pass), 1 (measured regression) or 3 (malformed/incomplete execution); guard
preflight returns 2.

Seven synthetic tests cover focused and multi-case input, pass, fail, equality
at the threshold, missing, duplicate and non-positive rows without starting
QuickJS. An actual three-window focused guard completed both comparisons and
ended `PR1_QJS_GUARD_RESULT verdict=pass regressions=0 errors=0` (single
-4.832%, cumulative -2.319%). That run is an orchestration smoke, not the
formal low-load result above, because its initial host compile temporarily
raised system load.

`docs/quickjs-performance.md` documents measurement discipline, output and
exit-code contracts, focused diagnosis, and the reviewed release-cadence
procedure for moving the fixed baseline. `docs/status.md` marks the guard Done.

## 6. Correctness and consumers

The final component gate started from a deleted `dist/` directory:

- `bun run build:wasm`: exit 0; the web wasm was rebuilt (359,665 bytes).
- `bun run build:example`: exit 0.
- `bunx tsc --noEmit`: exit 0, rerun after the final bundle-pin commits.
- `bun run test`: **4,576 pass, 0 fail, 0 skip**, 730,583 assertions across
  298 files in 504.30 seconds.

That full suite includes all component goldens, recordings, replay/rate tests,
the new world-idle capability tests, the seven guard-analyzer tests and the
bundle-isolation pins. No committed golden or recording changed.

Both consumers were checked in detached clean worktrees with real submodules
and installs, with their `vendor/pocket-rpgkit` checkout moved to runtime
candidate `443c3d96` and PocketJS left at `862040bd`:

- Pocket Tuxemon main `afda0113`: import exit 0; all eight PSP mainline
  intermediate snapshots generated; wasm and game builds exit 0; the complete
  suite reports **1,424 pass, 6 browser-condition skip, 0 fail**, 258,153
  assertions across 168 files in 450.80 seconds. The six skips are the
  repository's explicitly browser-conditioned Bag and START-menu tests.
- PocketJS Wander main `b827e9ae`: wasm and both-app build exit 0; the complete
  suite reports **523 pass, 0 fail**, 501,127 assertions across 45 files in
  98.21 seconds.

The Tuxemon main branch advanced during the first consumer run. Its detached
worktree was rebuilt from the new main, including the new storage and outdoor-
seam tests, and the figures above are from that replacement run rather than
the superseded checkout. No consumer commit was made.

## 7. Repository hygiene

The final fetch still resolves `origin/main` and the branch merge-base to
`7722952d`, so no rebase was required. The branch contains no merge commit.
Every task commit is authored by `lfkdsk <lfkdsk@gmail.com>` and has no
co-author or generator footer. `bun.lock`, the data schemas and the PocketJS
submodule pointer have no diff from `origin/main`; only this report was
untracked before the final report commit. The two consumer main checkouts kept
their pre-existing untracked tool directories and otherwise remained
unchanged.

subagent 使用：3 / 历史边界梳理、热路径只读审计、累计 guard 设计；两个后续请求因 provider 排队被主代理中断，未产生新结论 / 前三项并行缩短了初期定位与设计时间，所有进入报告的数字和判断均由主代理复核

PASS
