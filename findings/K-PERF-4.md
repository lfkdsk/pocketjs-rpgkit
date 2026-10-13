# K-PERF-4 — restoring `battleSceneImmutable` cumulative performance

Runtime candidate: `b8070cbb`, based on `origin/main` `802a30e2`. The fixed
historical baseline is `a4dc4e72341ae6aa7373623f83dbd07124316a6d`; the pinned
PocketJS revision is `862040bd`.

## Verdict

**PASS.** The old main's cumulative drift is real under a counterbalanced,
same-guest measurement: **+3.758%**, with a 95% complete-window bootstrap
interval of **[+3.024%, +5.514%]**. The optimized runtime is **5.085% faster**
than the fixed baseline in the 12-window focused run, with a 95% interval of
**[-5.469%, -4.539%]**. The final six-window full guard passes every single and
cumulative case, and all component and consumer correctness gates pass.

## 1. Diagnosing the small-case benchmark

`battleSceneImmutable` originally took about 11 microseconds per iteration.
That made process startup, heap layout and stable timing-slot effects large
relative to the work being measured. Two byte-identical-bundle controls
separated those effects:

| Control | Windows | Slot order | Median | 95% window-bootstrap interval |
| --- | ---: | --- | ---: | ---: |
| Same bundle, fixed slots | 3 | ABBA only | **+3.188%** | **[+2.042%, +5.862%]** |
| Same bundle, counterbalanced | 6 | alternating ABBA / BAAB | -0.441% | [-4.429%, +0.935%] |

The first control incorrectly excluded zero even though both bundle hashes
were `816e8a05…`. Running both bundles in one QuickJS guest removed
process-to-process noise, but fixed ABBA ownership still gave one label a
systematic inner-slot advantage. Reversing label ownership in every even
window cancels that advantage. The second control includes zero despite a
single +36.26% directional outlier, showing why a per-slot median and
complete-window resampling are both necessary.

The accepted measurement method therefore:

- loads both bundles into one QuickJS guest in one desktop-host process;
- runs odd windows as baseline/candidate/candidate/baseline and even windows
  with label ownership reversed;
- probes with 2,000 iterations, then calibrates each timed batch near 100,000
  microseconds (about 8,900–10,000 iterations for this case);
- takes five timed batches per slot and uses the slot median;
- reports the median of the two directional ratios from every window; and
- computes a deterministic 20,000-sample 95% percentile interval by
  resampling complete windows, keeping each window's two directions together.

Formal timings used the desktop host's QuickJS guest rather than Bun/JSC.
Focused runs were pinned with `taskset`; the 12-window optimized run used CPU
7 and recorded load averages from 4.47/5.93/6.07 to 4.28/5.77/6.01. The final
full guard used CPU 15; its accepted cumulative phase recorded 4.91/5.39/4.81
before and 3.42/4.74/4.63 after. `ps` snapshots, affinity, bundle hashes,
iteration counts, PocketJS identity and `uptime` are retained in the raw
transcripts. No subagent ran commands during timed measurements.

## 2. Confirming and locating cumulative drift

Re-analyzing the old-main 12-window ABBA/BAAB transcript with the final
analyzer confirms a real regression:

| Runtime versus `a4dc4e72` | Windows / directional pairs | Median | 95% interval |
| --- | ---: | ---: | ---: |
| Old main `310934f9` | 12 / 24 | **+3.758%** | **[+3.024%, +5.514%]** |
| Optimized runtime `dad994bc` | 12 / 24 | **-5.085%** | **[-5.469%, -4.539%]** |

Both runs exceed the required three-window minimum, and their confidence
intervals do not approach the +1% recovery target. A direct six-window
optimization comparison measured the first allocation patch at -7.101%
against old main, with a 95% interval of [-9.639%, -4.919%].

A six-window merge-boundary sweep was also run across the fixed-baseline-to-
main history. It was diagnostic rather than additive:

| Boundary | Median | 95% interval |
| --- | ---: | ---: |
| `a4dc4e72 → 56996733` | -0.871% | [-1.734%, -0.727%] |
| `56996733 → 8c342c70` | +0.905% | [-0.036%, +1.085%] |
| `8c342c70 → de66edab` | +0.696% | [+0.561%, +1.425%] |
| `de66edab → 0aecc05a` | -0.193% | [-1.531%, +0.013%] |
| `0aecc05a → 49b19d5a` | +0.586% | [-0.484%, +2.652%] |
| `49b19d5a → 2a37b9aa` | -0.807% | [-1.681%, +0.247%] |
| `2a37b9aa → 4929290c` | +0.079% | [-0.051%, +0.642%] |
| `4929290c → a50f2ca4` | +3.852% | [+2.240%, +5.651%] |
| `a50f2ca4 → d6e7e709` | -5.501% | [-6.780%, -4.099%] |
| `d6e7e709 → 7722952d` | +1.095% | [+1.030%, +1.765%] |
| `7722952d → 310934f9` | -0.009% | [-0.137%, +0.314%] |

The large positive step, immediate reversal and non-additive nested results
show that emitted-bundle layout and fixture interactions materially affect
this very small case. The sweep does not support assigning the cumulative
regression to one source commit. It does identify repeated immutable battle
frame allocation as the stable optimization target; the fixed-baseline
comparison, rather than a sum of adjacent ratios, is the acceptance result.

## 3. Behavior-preserving runtime recovery

Three hot paths now avoid work that does not change observable state:

- `cloneScene` builds battle and non-battle results explicitly, clones
  `returnAudio` only when present, and no longer allocates a conditional
  spread object on every immutable battle frame.
- Empty battle input reuses one read-only zero object. Frozen interpreter
  state now assigns optional audio and screen clones only when needed instead
  of creating conditional spread objects.
- State-metadata scopes allocate tracking arrays only after their first
  tracked entry. The tracked-entry update remains one lookup plus a single
  fast-path branch, avoiding a regression in workloads which do use metadata.

The state, clone boundaries, input normalization, rewind behavior and cache
eviction semantics are unchanged. No golden, recording, fixture or tape file
changed. The shared engine graph grows by 732 bytes, recorded in all three
affected bundle-isolation pins; their source/module needles retain the same
optional-capability boundaries.

## 4. Stable guard and documented verdicts

The guard now defaults to six counterbalanced windows, five batches per slot,
a 2,000-iteration probe, a 100,000-microsecond target batch and 20,000
complete-window bootstrap samples. It requires an even window count of at
least four and validates the alternating labels as well as every requested
round, slot and case.

Every result prints the case, point median, confidence bounds, limit and
verdict. The decision rule keeps the established point-estimate budget while
making uncertainty explicit:

- pass when the point median is at or below the limit;
- fail when the confidence interval's lower bound is above the limit; and
- inconclusive when the point median exceeds the limit but the interval
  crosses it.

The wrapper propagates pass/fail/inconclusive/error separately and always
prints `PR1_QJS_GUARD_RESULT` once comparisons begin. Eleven analyzer tests
cover counterbalanced labels, medians rather than noisy means, equality,
pass/fail/inconclusive thresholds, and missing, duplicate, mislabeled or
non-positive rows. The operational guide and feature-status table document
the new protocol and exit contract.

## 5. Final full-table QuickJS guard

The post-rebase guard compares runtime candidate `b8070cbb` with both change
base `802a30e2` and fixed baseline `a4dc4e72`. Every row uses six windows and
12 directional pairs; the configured limit is +3.0%.

| Case | Single median (95% interval) | Cumulative median (95% interval) |
| --- | ---: | ---: |
| `sunstoneIdle` | +0.668% ([+0.462%, +3.085%]) | -2.255% ([-4.586%, -2.088%]) |
| `sunstoneWalk` | -0.131% ([-1.523%, +0.380%]) | -0.342% ([-1.227%, +0.131%]) |
| `sunstoneControlWalk` | +0.016% ([-0.803%, +0.419%]) | -1.626% ([-1.966%, -1.276%]) |
| `streamedRoam` | +0.164% ([-0.164%, +0.858%]) | -2.053% ([-3.744%, -1.642%]) |
| `battleScene` | -0.410% ([-0.550%, -0.234%]) | -0.684% ([-1.017%, -0.579%]) |
| `sunstoneIdleImmutable` | -2.461% ([-3.660%, -1.560%]) | -2.649% ([-2.783%, -2.385%]) |
| `sunstoneControlWalkImmutable` | -0.887% ([-1.477%, -0.684%]) | +0.363% ([-2.033%, +2.114%]) |
| `battleSceneImmutable` | **-6.751%** (**[-8.223%, -5.986%]**) | **-4.567%** (**[-4.684%, -4.050%]**) |

The transcript ends with
`PR1_QJS_GUARD_RESULT verdict=pass regressions=0 inconclusive=0 errors=0`.
No other cumulative case regresses; the largest positive cumulative point is
+0.363%.

## 6. Component correctness gates

The final component run started after deleting `dist/`:

- `bun run build:wasm`: exit 0, web wasm rebuilt at 359,675 bytes.
- `bun run build:example`: exit 0; both density variants completed.
- `bunx tsc --noEmit`: exit 0.
- `bun test tests/pr1-quickjs-guard.test.ts`: 11 pass, 0 fail.
- `bun run test`: **4,580 pass, 0 fail, 0 skip**, 730,593 assertions across
  298 files in 485.16 seconds.

The complete suite covers the existing battle goldens, recordings, rewind and
cross-rate determinism as well as the updated bundle-isolation pins. The final
suite marker is `FLEET_TEST_EXIT=0`.

## 7. Consumer validation

Consumers were tested in detached worktrees with real submodules, with only
their Pocket RPG Kit submodule checkout moved to runtime candidate `b8070cbb`.
No consumer commit was made.

- Pocket Tuxemon main `3bcba886`: import, wasm build and game build all exit
  0; `bun tools/psp-mainline.ts snapshots` generated all eight intermediate
  snapshots before the complete suite; the suite reports **1,463 pass, 6
  explicit browser-condition skip, 0 fail**, 258,745 assertions across 173
  files in 449.50 seconds. The six skips are the repository's existing Bag and
  START-menu browser visual tests.
- PocketJS Wander main `b827e9ae`: wasm build, both-app build and TypeScript
  check exit 0; the complete suite reports **523 pass, 0 fail**, 501,127
  assertions across 45 files in 97.26 seconds.

## 8. Repository hygiene

The branch was rebased, never merged, onto `origin/main` `802a30e2`. Its six
implementation/test commits are authored by `lfkdsk <lfkdsk@gmail.com>` and
contain no co-author or generator footer. `bun.lock`, schemas, PocketJS and
golden/recording files have no branch diff. The consumer worktrees have no
tracked change other than the intentional component-submodule checkout.

subagent 使用：4 / 基准方法与统计审查、文档和测试辨识力审查、历史归因边界梳理、热路径逐行审查 / 四项只读工作并行缩短了方法校准和定位时间；计时期间均未运行命令，所有进入报告的数字和结论由主代理复核

PASS
