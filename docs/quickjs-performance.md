# QuickJS performance checks

Pocket RPG Kit's desktop host runs game code in QuickJS, so runtime changes are
measured in that guest rather than in Bun. `tools/pr1-quickjs-bench.sh` builds
the same workload bundle at two commits and runs both in one pinned desktop
host. Each measurement window is interleaved baseline, candidate, candidate,
baseline (ABBA) to reduce the effect of host drift.

## Report a comparison

Pass an explicit baseline commit. For a branch based on `origin/main`, a normal
three-window run is:

```sh
base=$(git merge-base HEAD origin/main)
PR1_QJS_CPU=2 PR1_QJS_ROUNDS=3 tools/pr1-quickjs-bench.sh "$base"
```

Choose an otherwise idle physical CPU. Check `uptime` and `ps` before the run;
the script also records `uptime` around every window and records the granted
CPU affinity. Avoid running builds, tests, or other benchmarks at the same
time. `PR1_QJS_ITERS` controls the iterations in each slot and defaults to
2,000.

For diagnosis, `PR1_BENCH_CASE=streamedRoam` selects one workload. A final
performance review should omit it and measure all workloads. Report-only mode
has no limit by default; setting `PR1_QJS_MAX_REGRESSION_PCT` turns that one
comparison into a gate.

The analyzer computes two directional deltas per window: candidate slot 2
against baseline slot 1, and candidate slot 3 against baseline slot 4. Its
headline is the median of all paired deltas. It fails closed if any requested
round, slot, or case is missing, duplicated, mislabeled, non-numeric, or not
positive.

## Check a change and cumulative drift

Guard mode runs two independent comparisons:

```sh
base=$(git merge-base HEAD origin/main)
PR1_QJS_CPU=2 PR1_QJS_ROUNDS=3 tools/pr1-quickjs-bench.sh --guard "$base"
```

| Comparison | Baseline | Purpose |
| --- | --- | --- |
| `single` | The command-line change base | Detect a regression introduced by this branch |
| `cumulative` | `baseline_sha` in `tools/pr1-quickjs-baseline.conf` | Detect small regressions accumulated across branches |

Guard mode requires a clean candidate worktree, including submodules, and at
least three windows. The fixed configuration contains full commit identity and
separate percentage limits for the two comparisons. Each case must stay at or
below its applicable limit; equality passes. The final machine-readable line
is `PR1_QJS_GUARD_RESULT`.

Guard mode's exit codes are stable for automation:

| Code | Meaning |
| --- | --- |
| 0 | Every measured case passed, or a report-only run completed |
| 1 | At least one measured case exceeded its limit |
| 2 | Usage or preflight error, such as a bad ref, config, or dirty guard worktree |
| 3 | Benchmark execution failed or its transcript was malformed or incomplete |

The two comparison transcripts are retained as `guard-single.log` and
`guard-cumulative.log` in `PR1_QJS_SCRATCH` (by default, the user cache). Each
also contains `PR1_QJS_RESULT` records for per-case ingestion.

## Move the fixed baseline deliberately

The historical baseline is a release-cadence checkpoint, not a moving branch.
Update `tools/pr1-quickjs-baseline.conf` only in a reviewed performance change:

1. Run the full workload table against both the old fixed baseline and the
   proposed checkpoint under the same low-load conditions.
2. Record why the old comparison is no longer the useful cumulative window and
   account for every accepted regression.
3. Put the proposed checkpoint's full lowercase 40-character commit SHA in
   `baseline_sha`; it must remain reachable and must be an ancestor of future
   change bases.
4. Change a limit only as an explicit policy decision, never merely to make a
   failing run pass.

Keeping the baseline fixed across many merges is what lets the cumulative
comparison catch chronic drift that no individual branch exceeds by itself.
