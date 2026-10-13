# QuickJS performance checks

Pocket RPG Kit's desktop host runs game code in QuickJS, so runtime changes
are measured in that guest rather than in Bun. `tools/pr1-quickjs-bench.sh`
builds the same workload bundle at two commits and runs both with the current
checkout's pinned desktop host.

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

Pass an explicit baseline commit. For a branch based on `origin/main`, this
runs the complete table in three interleaved windows:

```sh
base=$(git merge-base HEAD origin/main)
env -u PR1_BENCH_CASE \
  -u PR1_QJS_MAX_REGRESSION_PCT \
  -u PR1_QJS_COMPARISON \
  PR1_QJS_CPU=2 \
  PR1_QJS_ROUNDS=3 \
  PR1_QJS_ITERS=2000 \
  PR1_BENCH_ROUNDS=9 \
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

There are two different round controls:

- `PR1_QJS_ROUNDS` is the number of outer ABBA windows. Report mode defaults
  to 1; guard mode defaults to and requires at least 3.
- `PR1_BENCH_ROUNDS` is the number of timing samples inside each host slot and
  defaults to 9. Each case first runs 400 warmups; each sample folds
  `PR1_QJS_ITERS` iterations, which defaults to 2,000.

The Rust driver prints mean, median and p95, but the gate reads `mean_us`.

## Read an ABBA result

Each window starts a new host/guest process in this order:

```text
baseline -> candidate -> candidate -> baseline
```

For each workload, the analyzer computes two directional deltas:

```text
(candidate slot 2 / baseline slot 1 - 1) * 100
(candidate slot 3 / baseline slot 4 - 1) * 100
```

The reported/gated value is the median of all `2 × PR1_QJS_ROUNDS` paired
deltas, not a ratio of raw medians. A positive value is a regression; a
negative value is an improvement. Each workload is gated independently,
equality passes, and malformed, missing, duplicate, non-positive or mislabeled
samples fail closed.

The log records the candidate, baseline and PocketJS commits, both bundle
hashes, requested iterations/windows, granted affinity and load around every
window. Keep those lines with any reviewed number.

## Check one change and cumulative drift

Guard mode runs two independent comparisons:

```sh
base=$(git merge-base HEAD origin/main)
git status --porcelain --untracked-files=normal --ignore-submodules=none
env -u PR1_BENCH_CASE \
  PR1_QJS_CPU=2 \
  PR1_QJS_ROUNDS=3 \
  PR1_QJS_ITERS=2000 \
  PR1_BENCH_ROUNDS=9 \
  tools/pr1-quickjs-bench.sh --guard "$base"
```

Guard mode requires a clean candidate worktree, including submodules.

| Comparison | Baseline | Current limit | Purpose |
| --- | --- | ---: | --- |
| `single` | Command-line change base | 3.0% | Detect a regression introduced by this branch. |
| `cumulative` | `baseline_sha` in `tools/pr1-quickjs-baseline.conf` | 3.0% | Detect small regressions accumulated across branches. |

The config file is the source of truth for the baseline and limits. At this
revision its historical checkpoint is
`a4dc4e72341ae6aa7373623f83dbd07124316a6d`. The two transcripts are retained
as `guard-single.log` and `guard-cumulative.log` under `PR1_QJS_SCRATCH`.

When both comparisons reach the analyzer, the final line is
`PR1_QJS_GUARD_RESULT`; exit 0 means pass, 1 means a measured regression, 2
means a usage/preflight error, and 3 means an incomplete or malformed
comparison. There is one current orchestration limitation: an earlier
`bun`/`cargo`/copy/`taskset` failure can make the shell exit 1 before it emits
that final line. Automation must therefore treat a missing guard-result line
as an infrastructure error and inspect both transcripts, not interpret the
raw 1 as a measured regression.

The analyzer itself has a focused synthetic regression suite:

```sh
bun test tests/pr1-quickjs-guard.test.ts
```

That suite covers pairing, thresholds and malformed rows. It does not launch
QuickJS or exercise the shell's worktree, submodule, Cargo and dual-comparison
orchestration.

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
   report against both `old` and `checkpoint`, with at least three windows.
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
