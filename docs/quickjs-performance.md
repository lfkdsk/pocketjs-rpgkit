# QuickJS performance checks

Pocket RPG Kit's desktop host runs game code in QuickJS, so runtime changes are
measured in that guest rather than in Bun. `tools/pr1-quickjs-bench.sh` builds
the same workload bundle at two commits and loads both into one QuickJS guest
in one pinned desktop-host process. Odd measurement windows use baseline,
candidate, candidate, baseline (ABBA); even windows reverse ownership to
candidate, baseline, baseline, candidate (BAAB). Reversing the slots cancels
systematic inner/outer-slot bias as well as monotonic host drift.

## Prepare the host

The benchmark is Linux-oriented. It requires a full Git history, the PocketJS
submodule, Bun, stable Rust/Cargo, Bash and GNU/Linux tools including `taskset`,
`sha256sum` and `find -printf`. Prepare a fresh checkout with:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
command -v bash git bun cargo awk taskset sha256sum
test -f vendor/pocketjs/hosts/desktop/Cargo.toml
```

Choose an allowed, otherwise idle **logical CPU** and check its SMT sibling;
pinning one sibling does not stop a busy sibling from adding noise. Check load
before and after the run, and do not run builds, tests, subagents or another
benchmark concurrently:

```sh
taskset -pc "$$"
lscpu -e=CPU,CORE,SOCKET,ONLINE
uptime
ps -eLo pid,psr,pcpu,comm --sort=-pcpu | head -20
```

`PR1_QJS_SCRATCH` defaults to the user cache. Concurrent runs must use
different scratch directories; otherwise they share host sources, Cargo
output, bundles and logs.

## Report a comparison

Pass an explicit baseline commit. For a branch based on `origin/main`, a normal
six-window run is:

```sh
base=$(git merge-base HEAD origin/main)
env -u PR1_BENCH_CASE \
  -u PR1_QJS_MAX_REGRESSION_PCT \
  -u PR1_QJS_COMPARISON \
  PR1_QJS_CPU=2 \
  PR1_QJS_ROUNDS=6 \
  tools/pr1-quickjs-bench.sh "$base"
```

Replace CPU 2 when it is not an allowed idle logical CPU. Report-only mode has
no regression limit by default. `PR1_BENCH_CASE=<name>` selects one diagnostic
workload; clear it for a final review. Setting
`PR1_QJS_MAX_REGRESSION_PCT=<percent>` turns a single report comparison into a
gate.

The complete table is:

- `sunstoneIdle`, `sunstoneWalk`, `sunstoneControlWalk`;
- `streamedRoam`, `battleScene`;
- `sunstoneIdleImmutable`, `sunstoneControlWalkImmutable`,
  `battleSceneImmutable`.

Each case starts with `PR1_QJS_ITERS` probe iterations (2,000 by default), then
calibrates the real batch near `PR1_QJS_TARGET_SAMPLE_US` (100,000 microseconds
by default). This lengthens small cases such as `battleSceneImmutable` and
shortens already-expensive cases. Every slot reports the median of
`PR1_QJS_SAMPLES` timed batches (five by default), and the transcript records
the actual chosen iteration count.

## Read a counterbalanced result

One timed host/guest process performs all requested windows. Odd windows use:

```text
baseline -> candidate -> candidate -> baseline
```

Even windows reverse the labels:

```text
candidate -> baseline -> baseline -> candidate
```

The analyzer computes two candidate/baseline deltas per window, following the
reversed labels in even windows. Its headline is the median of the per-slot
`median_us` ratios. A deterministic percentile bootstrap resamples complete
windows (both directions together) 20,000 times and reports a 95% confidence
interval. A positive value is a regression and a negative value is an
improvement. It fails closed if any requested round, slot, or case is missing,
duplicated, mislabeled, non-numeric, or not positive.

The log records the candidate, baseline and PocketJS commits, both bundle
hashes, probe and calibrated iterations, requested windows and samples,
granted affinity, and load around the paired process. Keep those lines with
any reviewed number.

## Check one change and cumulative drift

Guard mode runs two independent comparisons:

```sh
base=$(git merge-base HEAD origin/main)
git status --porcelain --untracked-files=normal --ignore-submodules=none
PR1_QJS_CPU=2 tools/pr1-quickjs-bench.sh --guard "$base"
```

| Comparison | Baseline | Current limit | Purpose |
| --- | --- | ---: | --- |
| `single` | Command-line change base | 3.0% | Detect a regression introduced by this branch. |
| `cumulative` | `baseline_sha` in `tools/pr1-quickjs-baseline.conf` | 3.0% | Detect small regressions accumulated across branches. |

Guard mode requires a clean candidate worktree, including submodules, and an
even number of windows of at least four (the default is six). The fixed
configuration contains full commit identity and separate percentage limits
for the two comparisons. A case passes only when the upper confidence bound is
at or below its limit, fails when the lower bound is above the limit, and is
inconclusive when the interval crosses the limit. Equality passes. Every
`PR1_QJS_RESULT` names the case, point estimate, confidence bounds, limit, and
verdict; the final machine-readable line is `PR1_QJS_GUARD_RESULT`.

The config file is the source of truth for the baseline and limits. At this
revision its historical checkpoint is
`a4dc4e72341ae6aa7373623f83dbd07124316a6d`. The two transcripts are retained
as `guard-single.log` and `guard-cumulative.log` under `PR1_QJS_SCRATCH`.

Guard mode's exit codes are stable for automation:

| Code | Meaning |
| --- | --- |
| 0 | Every measured case passed, or a report-only run completed |
| 1 | At least one measured case exceeded its limit |
| 2 | Confidence interval crossed a limit, or a usage/preflight error before measurement |
| 3 | Benchmark execution failed or its transcript was malformed or incomplete |

Usage and guard-preflight failures exit 2 before comparisons start and do not
emit `PR1_QJS_GUARD_RESULT`. Once comparisons start, the wrapper runs both and
always emits that final line. Automation must therefore require the final line
before interpreting exit 1 or 2 as a measured verdict; a missing line is a
preflight or wrapper-level infrastructure failure.

The analyzer itself has a focused synthetic regression suite:

```sh
bun test tests/pr1-quickjs-guard.test.ts
```

That suite covers counterbalanced pairing, point and interval thresholds, and
malformed rows. It does not launch QuickJS or exercise the shell's worktree,
submodule, Cargo and dual-comparison orchestration.

## Move the fixed baseline deliberately

The historical baseline is a reviewed release-cadence checkpoint, not a
moving branch. Before proposing a new checkpoint, resolve both identities and
prove ancestry:

```sh
old=$(awk '$1 == "baseline_sha" { print $2 }' tools/pr1-quickjs-baseline.conf)
checkpoint=$(git rev-parse origin/main)
git rev-parse --verify "$old^{commit}"
git rev-parse --verify "$checkpoint^{commit}"
git merge-base --is-ancestor "$old" "$checkpoint"
```

Then:

1. Under the same low-load conditions, run the **complete eight-workload**
   report against both `old` and `checkpoint`, with at least six windows.
2. Record why the old comparison is no longer the useful cumulative window
   and account for every accepted regression. A Native/feature milestone is
   not itself a reason to erase history.
3. Put the proposed checkpoint's full lowercase 40-character commit SHA in
   `tools/pr1-quickjs-baseline.conf`. It must already be an ancestor of the
   change base used by future guarded branches; normally the checkpoint first
   enters `main`, then a later reviewed change moves the config.
4. Run guard mode from a clean checkout and the synthetic suite above.
5. Change a limit only as a separate policy decision, never merely to make a
   failing run pass.

Keeping the checkpoint fixed across many merges is what lets the cumulative
comparison catch chronic drift which no individual branch exceeds.
