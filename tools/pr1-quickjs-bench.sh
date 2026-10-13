#!/bin/bash
# pr1-quickjs-bench.sh — build pre-PR main and this checkout's engine workloads
# and run both inside the pinned PocketJS desktop host's QuickJS guest, in
# interleaved main → candidate → candidate → main windows.
#
# Usage:
#   tools/pr1-quickjs-bench.sh <baseline_ref>
#   tools/pr1-quickjs-bench.sh --guard <change_base_ref>
#
# The explicit baseline is REQUIRED in report-only mode: name the commit the candidate
# is compared against (e.g. the PR base, or $(git merge-base HEAD main)). There
# is intentionally no built-in default: a stale hard-coded baseline hides
# regressions behind an irrelevant comparison. Guard mode checks both the
# change base and the fixed release baseline in pr1-quickjs-baseline.conf.
# The run header and the opening line both record the resolved baseline commit.
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
guard_config="$root/tools/pr1-quickjs-baseline.conf"

usage() {
  echo "usage: tools/pr1-quickjs-bench.sh <baseline_ref>" >&2
  echo "       tools/pr1-quickjs-bench.sh --guard <change_base_ref>" >&2
}

read_guard_config() {
  local key value extra
  local seen_format=0 seen_baseline=0 seen_single=0 seen_cumulative=0
  while read -r key value extra; do
    case "${key:-}" in
      ""|\#*) continue ;;
    esac
    if [ -n "${extra:-}" ] || [ -z "${value:-}" ]; then
      echo "pr1-quickjs-bench: malformed guard config line for '$key'" >&2
      return 2
    fi
    case "$key" in
      format)
        [ "$seen_format" -eq 0 ] || { echo "pr1-quickjs-bench: duplicate config key '$key'" >&2; return 2; }
        guard_format="$value"; seen_format=1 ;;
      baseline_sha)
        [ "$seen_baseline" -eq 0 ] || { echo "pr1-quickjs-bench: duplicate config key '$key'" >&2; return 2; }
        guard_baseline_sha="$value"; seen_baseline=1 ;;
      single_limit_pct)
        [ "$seen_single" -eq 0 ] || { echo "pr1-quickjs-bench: duplicate config key '$key'" >&2; return 2; }
        guard_single_limit="$value"; seen_single=1 ;;
      cumulative_limit_pct)
        [ "$seen_cumulative" -eq 0 ] || { echo "pr1-quickjs-bench: duplicate config key '$key'" >&2; return 2; }
        guard_cumulative_limit="$value"; seen_cumulative=1 ;;
      *) echo "pr1-quickjs-bench: unknown guard config key '$key'" >&2; return 2 ;;
    esac
  done < "$guard_config"
  if [ "$seen_format" -ne 1 ] || [ "$guard_format" != 1 ]; then
    echo "pr1-quickjs-bench: guard config requires 'format 1'" >&2
    return 2
  fi
  if [ "$seen_baseline" -ne 1 ] || [[ ! "$guard_baseline_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "pr1-quickjs-bench: guard baseline_sha must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [ "$seen_single" -ne 1 ] || [[ ! "$guard_single_limit" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
      [ "$seen_cumulative" -ne 1 ] || [[ ! "$guard_cumulative_limit" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    echo "pr1-quickjs-bench: guard limits must be non-negative decimal percentages" >&2
    return 2
  fi
}

if [ "${1:-}" = "--guard" ]; then
  if [ "$#" -ne 2 ] || [ -z "${2:-}" ]; then
    usage
    exit 2
  fi
  change_base_ref="$2"
  if [ ! -f "$guard_config" ]; then
    echo "pr1-quickjs-bench: missing guard config $guard_config" >&2
    exit 2
  fi
  read_guard_config
  if ! git -C "$root" rev-parse --verify "${change_base_ref}^{commit}" >/dev/null 2>&1; then
    echo "pr1-quickjs-bench: change base '$change_base_ref' is not a commit" >&2
    exit 2
  fi
  change_base_sha="$(git -C "$root" rev-parse "${change_base_ref}^{commit}")"
  if ! git -C "$root" rev-parse --verify "${guard_baseline_sha}^{commit}" >/dev/null 2>&1; then
    echo "pr1-quickjs-bench: configured historical baseline $guard_baseline_sha is unavailable; fetch full history" >&2
    exit 2
  fi
  if ! git -C "$root" merge-base --is-ancestor "$change_base_sha" HEAD; then
    echo "pr1-quickjs-bench: change base $change_base_sha is not an ancestor of HEAD" >&2
    exit 2
  fi
  if ! git -C "$root" merge-base --is-ancestor "$guard_baseline_sha" "$change_base_sha"; then
    echo "pr1-quickjs-bench: historical baseline $guard_baseline_sha is not an ancestor of change base $change_base_sha" >&2
    exit 2
  fi
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=normal --ignore-submodules=none)" ]; then
    echo "pr1-quickjs-bench: guard mode requires a clean candidate worktree and submodules" >&2
    exit 2
  fi
  guard_rounds="${PR1_QJS_ROUNDS:-3}"
  if [[ ! "$guard_rounds" =~ ^[1-9][0-9]*$ ]] || [ "$guard_rounds" -lt 3 ]; then
    echo "pr1-quickjs-bench: guard mode requires PR1_QJS_ROUNDS >= 3" >&2
    exit 2
  fi
  guard_scratch="${PR1_QJS_SCRATCH:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/pr1-quickjs}"
  mkdir -p "$guard_scratch"
  single_log="$guard_scratch/guard-single.log"
  cumulative_log="$guard_scratch/guard-cumulative.log"
  echo "PR1_QJS_GUARD change_base=$change_base_sha historical_baseline=$guard_baseline_sha rounds=$guard_rounds"

  set +e
  PR1_QJS_ROUNDS="$guard_rounds" PR1_QJS_COMPARISON=single \
    PR1_QJS_MAX_REGRESSION_PCT="$guard_single_limit" \
    "$0" "$change_base_sha" 2>&1 | tee "$single_log"
  single_status=${PIPESTATUS[0]}
  PR1_QJS_ROUNDS="$guard_rounds" PR1_QJS_COMPARISON=cumulative \
    PR1_QJS_MAX_REGRESSION_PCT="$guard_cumulative_limit" \
    "$0" "$guard_baseline_sha" 2>&1 | tee "$cumulative_log"
  cumulative_status=${PIPESTATUS[0]}
  set -e

  regressions=0
  errors=0
  for result_spec in "single:$single_status:$single_log" "cumulative:$cumulative_status:$cumulative_log"; do
    comparison_name="${result_spec%%:*}"
    remainder="${result_spec#*:}"
    comparison_status="${remainder%%:*}"
    comparison_log="${remainder#*:}"
    result_line="$(grep -E "^PR1_QJS_COMPARISON_RESULT comparison=$comparison_name " "$comparison_log" | tail -1)"
    if [[ "$result_line" == *" verdict=fail "* ]] && [ "$comparison_status" -eq 1 ]; then
      regressions=$((regressions + 1))
    elif [[ "$result_line" == *" verdict=pass "* ]] && [ "$comparison_status" -eq 0 ]; then
      :
    else
      errors=$((errors + 1))
    fi
  done
  verdict=pass
  status=0
  if [ "$errors" -gt 0 ]; then verdict=error; status=3
  elif [ "$regressions" -gt 0 ]; then verdict=fail; status=1
  fi
  echo "PR1_QJS_GUARD_RESULT verdict=$verdict regressions=$regressions errors=$errors"
  exit "$status"
fi

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
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
baseline=""
host="$scratch/host"
target="$scratch/target"
rounds="${PR1_QJS_ROUNDS:-1}"
cpu="${PR1_QJS_CPU:-}"
iters="${PR1_QJS_ITERS:-2000}"
comparison="${PR1_QJS_COMPARISON:-manual}"
limit_pct="${PR1_QJS_MAX_REGRESSION_PCT:-}"
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
if [[ ! "$rounds" =~ ^[1-9][0-9]*$ ]] || [[ ! "$iters" =~ ^[1-9][0-9]*$ ]]; then
  echo "pr1-quickjs-bench: rounds and iterations must be positive integers" >&2
  exit 2
fi
if [[ ! "$comparison" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "pr1-quickjs-bench: invalid comparison label '$comparison'" >&2
  exit 2
fi
if [ -n "$limit_pct" ] && [[ ! "$limit_pct" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "pr1-quickjs-bench: PR1_QJS_MAX_REGRESSION_PCT must be a non-negative decimal" >&2
  exit 2
fi

mkdir -p "$scratch"
baseline="$(mktemp -d "$scratch/baseline-worktree.XXXXXX")"
rmdir "$baseline"
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
  echo "PR1_QJS meta=key comparison value=$comparison"
  echo "PR1_QJS meta=key limit_pct value=${limit_pct:-none}"
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

# Pair each window's candidate slots against their neighboring baseline slots
# and fail closed on missing/duplicate/malformed rows. A configured limit
# turns the report into a performance gate; report-only mode keeps exit 0.
awk \
  -v expected_rounds="$rounds" \
  -v expected_cases="${cases[*]}" \
  -v comparison="$comparison" \
  -v baseline_sha="$baseline_sha" \
  -v candidate_sha="$(git -C "$root" rev-parse HEAD)" \
  -v limit_pct="$limit_pct" \
  -f "$root/tools/pr1-quickjs-analyze.awk" \
  "$rows"
