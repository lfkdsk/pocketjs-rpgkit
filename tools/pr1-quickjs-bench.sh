#!/bin/bash
# pr1-quickjs-bench.sh — build pre-PR main and this checkout's engine workloads
# and run both inside the pinned PocketJS desktop host's QuickJS guest, in
# interleaved main → candidate → candidate → main windows.
#
# Usage:
#   tools/pr1-quickjs-bench.sh <baseline_ref>
#
# The baseline is a REQUIRED explicit argument: name the commit the candidate
# is compared against (e.g. the PR base, or $(git merge-base HEAD main)). There
# is intentionally no built-in default: a stale hard-coded baseline hides
# regressions behind an irrelevant comparison. The run header and the opening
# line both record the resolved baseline commit.
#
# Environment options:
#   PR1_QJS_ROUNDS=N   run N interleaved windows (default 1). With N>1 the
#                      summary reports the median of the 2N paired deltas per
#                      case — forward slot2/slot1-1 and reverse slot3/slot4-1
#                      per window — the same pairing review rounds use.
#   PR1_QJS_CPU=N      pin every timed process to CPU N with taskset(1)
#                      (e.g. PR1_QJS_CPU=2). Recommended for stable numbers;
#                      the run header records the affinity actually granted.
#   PR1_QJS_ITERS=N    iterations per case per slot (default 2000).
#   PR1_BENCH_CASE=NAME  run one focused workload instead of the full table.
#   PR1_QJS_SCRATCH=DIR  scratch worktree/build directory.
#
# Each round records `uptime` before and after its window, and the run header
# records candidate/baseline/PocketJS SHAs, CPU affinity and the sha256 of
# both built bundles, so a pasted log is enough to replay the run. The summary
# stage checks every slot against the selected workload count (8 or 1).
#
# Extraction note: with --nocapture libtest attaches a slot's first benchmark
# line to its `test ...` line, so PR1_QJS rows are extracted with an
# unanchored match. An anchored grep (^PR1_QJS) silently drops every slot's
# first sunstoneIdle sample.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "usage: tools/pr1-quickjs-bench.sh <baseline_ref>" >&2
  echo "  baseline_ref: commit the candidate is compared against, e.g." >&2
  echo "    \$(git -C \"$root\" merge-base HEAD main)   # the PR base" >&2
  echo "    a0857e097c9a68880f28ace2c13e2253be886d1c   # a pinned release" >&2
  exit 2
fi
baseline_ref="$1"
if ! git -C "$root" rev-parse --verify "${baseline_ref}^{commit}" >/dev/null 2>&1; then
  echo "pr1-quickjs-bench: baseline_ref '$baseline_ref' is not a commit" >&2
  exit 2
fi
baseline_sha="$(git -C "$root" rev-parse "${baseline_ref}^{commit}")"
baseline_subject="$(git -C "$root" log -1 --format=%s "$baseline_sha")"
echo "PR1_QJS baseline=$baseline_sha subject=\"$baseline_subject\""
scratch="${PR1_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/pr1-quickjs}"
baseline="$scratch/main"
host="$scratch/host"
target="$scratch/target"
rounds="${PR1_QJS_ROUNDS:-1}"
cpu="${PR1_QJS_CPU:-}"
iters="${PR1_QJS_ITERS:-2000}"
rows="$scratch/rows.log"
cases=( \
  sunstoneIdle sunstoneWalk sunstoneControlWalk streamedRoam battleScene \
  sunstoneIdleImmutable sunstoneControlWalkImmutable battleSceneImmutable
)
selected_case="${PR1_BENCH_CASE:-}"
if [ -n "$selected_case" ]; then
  case " ${cases[*]} " in
    *" $selected_case "*) cases=("$selected_case") ;;
    *) echo "pr1-quickjs-bench: unknown PR1_BENCH_CASE '$selected_case'" >&2; exit 2 ;;
  esac
fi
expected_rows="${#cases[@]}"

mkdir -p "$scratch"
if git -C "$root" worktree list --porcelain | grep -Fqx "worktree $baseline"; then
  git -C "$root" worktree remove --force "$baseline"
fi
# Check out the resolved SHA, not the movable ref: a branch named as the
# baseline could move between the rev-parse above and this checkout.
git -C "$root" worktree add --detach "$baseline" "$baseline_sha" >/dev/null
cleanup() {
  git -C "$root" worktree remove --force "$baseline" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$root/tools/pr1-quickjs-entry.ts" "$baseline/tools/pr1-quickjs-entry.ts"
cp "$root/tools/pr1-streamed-roam.ts" "$baseline/tools/pr1-streamed-roam.ts"
bun build "$baseline/tools/pr1-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/main.js" >/dev/null
bun build "$root/tools/pr1-quickjs-entry.ts" --target=browser --format=iife --minify --outfile="$scratch/candidate.js" >/dev/null

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
if [ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ]; then
  cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
fi
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/pr1-quickjs-bench.rs" "$host/src/pr1_quickjs_bench.rs"
echo 'include!("pr1_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "pr1-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

pin=()
if [ -n "$cpu" ]; then
  if ! command -v taskset >/dev/null; then
    echo "pr1-quickjs-bench: taskset(1) not found but PR1_QJS_CPU=$cpu" >&2
    exit 1
  fi
  pin=(taskset -c "$cpu")
fi

run_slot() {
  local js="$1"
  local label="$2"
  if [ -n "$selected_case" ]; then
    PR1_BENCH_JS="$js" PR1_BENCH_LABEL="$label" PR1_BENCH_ITERS="$iters" \
      PR1_BENCH_CASE="$selected_case" "${pin[@]}" "$bin" \
      pr1_quickjs_bench::tick_fold --ignored --exact --nocapture 2>&1
  else
    PR1_BENCH_JS="$js" PR1_BENCH_LABEL="$label" PR1_BENCH_ITERS="$iters" \
      "${pin[@]}" "$bin" \
      pr1_quickjs_bench::tick_fold --ignored --exact --nocapture 2>&1
  fi
}

{
  echo "PR1_QJS meta=key candidate value=$(git -C "$root" rev-parse HEAD)"
  echo "PR1_QJS meta=key baseline value=$baseline_sha"
  echo "PR1_QJS meta=key pocketjs value=$(git -C "$root/vendor/pocketjs" rev-parse HEAD)"
  echo "PR1_QJS meta=key bundle_main value=$(sha256sum "$scratch/main.js" | cut -d' ' -f1)"
  echo "PR1_QJS meta=key bundle_candidate value=$(sha256sum "$scratch/candidate.js" | cut -d' ' -f1)"
  echo "PR1_QJS meta=key rounds value=$rounds"
  echo "PR1_QJS meta=key iters value=$iters"
  echo "PR1_QJS meta=key cases value=${cases[*]}"
  if [ -n "$cpu" ]; then
    # Query the pinned process itself: taskset -cp $$ would report the
    # parent shell's affinity, not the child's granted affinity.
    echo "PR1_QJS meta=key affinity value=$("${pin[@]}" bash -c 'taskset -cp $BASHPID' | sed 's/^.*: //')"
  else
    echo "PR1_QJS meta=key affinity value=none"
  fi

  for round in $(seq 1 "$rounds"); do
    echo "PR1_QJS round=$round phase=uptime_before value=\"$(uptime)\""
    slot=0
    for label in main candidate candidate main; do
      slot=$((slot + 1))
      js="$scratch/$label.js"
      # Unanchored extraction: the first benchmark line of each slot is
      # attached to libtest's `test ...` line, so ^PR1_QJS would drop it.
      run_slot "$js" "$label" \
        | grep -E 'PR1_QJS|^test result' \
        | sed -E "s/PR1_QJS label=/PR1_QJS round=$round slot=$slot label=/"
    done
    echo "PR1_QJS round=$round phase=uptime_after value=\"$(uptime)\""
  done
} | tee "$rows"

# Pair each window's candidate slots against their neighboring main slots
# (forward: slot2/slot1-1, reverse: slot3/slot4-1) and summarize the 2*rounds
# paired deltas per case with their median.
awk -v expected_rows="$expected_rows" '
function parse_line(   i, a) {
  r = ""; s = ""; cs = ""; mu = ""
  for (i = 1; i <= NF; i++) {
    if (split($i, a, "=") == 2) {
      if (a[1] == "round") r = a[2]
      else if (a[1] == "slot") s = a[2]
      else if (a[1] == "case") cs = a[2]
      else if (a[1] == "mean_us") mu = a[2]
    }
  }
}
/PR1_QJS round=[0-9]+ slot=[0-9]+ label=/ {
  parse_line()
  if (r != "" && s != "" && cs != "" && mu != "") {
    m[r SUBSEP s SUBSEP cs] = mu + 0
    slotrows[r SUBSEP s] += 1
    rounds[r] = 1
    cases[cs] = 1
  }
}
END {
  for (k in slotrows) {
    if (slotrows[k] != expected_rows) {
      split(k, parts, SUBSEP)
      printf "PR1_QJS_WARN round=%s slot=%s has %d rows (expected %d)\n", parts[1], parts[2], slotrows[k], expected_rows > "/dev/stderr"
      bad = 1
    }
  }
  nc = 0
  for (c in cases) { nc++; cl[nc] = c }
  for (i = 1; i <= nc; i++) for (j = i + 1; j <= nc; j++) if (cl[i] > cl[j]) { t = cl[i]; cl[i] = cl[j]; cl[j] = t }
  nr = 0
  for (r in rounds) { nr++; rl[nr] = r + 0 }
  for (i = 1; i <= nr; i++) for (j = i + 1; j <= nr; j++) if (rl[i] > rl[j]) { t = rl[i]; rl[i] = rl[j]; rl[j] = t }

  printf "PR1_QJS_SUMMARY rounds=%d pairs_per_case=%d\n", nr, 2 * nr
  for (ci = 1; ci <= nc; ci++) {
    c = cl[ci]
    np = 0
    delete pairs
    delete wins
    for (ri = 1; ri <= nr; ri++) {
      r = rl[ri]
      if ((r SUBSEP 1 SUBSEP c) in m && (r SUBSEP 2 SUBSEP c) in m) {
        np++; pairs[np] = (m[r SUBSEP 2 SUBSEP c] / m[r SUBSEP 1 SUBSEP c] - 1) * 100
        wins[ri] = wins[ri] sprintf("%+.2f ", pairs[np])
      }
      if ((r SUBSEP 3 SUBSEP c) in m && (r SUBSEP 4 SUBSEP c) in m) {
        np++; pairs[np] = (m[r SUBSEP 3 SUBSEP c] / m[r SUBSEP 4 SUBSEP c] - 1) * 100
        wins[ri] = wins[ri] sprintf("%+.2f ", pairs[np])
      }
    }
    if (np == 0) continue
    for (i = 1; i <= np; i++) for (j = i + 1; j <= np; j++) if (pairs[i] > pairs[j]) { t = pairs[i]; pairs[i] = pairs[j]; pairs[j] = t }
    sum = 0
    for (i = 1; i <= np; i++) sum += pairs[i]
    med = (np % 2) ? pairs[(np + 1) / 2] : (pairs[np / 2] + pairs[np / 2 + 1]) / 2
    line = sprintf("  %-20s", c)
    for (ri = 1; ri <= nr; ri++) line = line sprintf(" W%d[%s]", rl[ri], (ri in wins) ? wins[ri] : "n/a ")
    line = line sprintf(" median=%+.2f%% mean=%+.2f%% min=%+.2f%% max=%+.2f%%", med, sum / np, pairs[1], pairs[np])
    print line
  }
  if (bad) exit 1
}
' "$rows"
