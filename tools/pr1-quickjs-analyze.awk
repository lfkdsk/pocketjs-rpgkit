# Validate and summarize one complete PR1 QuickJS ABBA transcript.
# Required -v inputs: expected_rounds, expected_cases, comparison,
# baseline_sha, candidate_sha. limit_pct is optional (empty = report only).
# bootstrap_samples is optional and defaults to 20000 deterministic resamples.

function warn(message) {
  print "PR1_QJS_WARN " message > "/dev/stderr"
  bad = 1
}

function wanted_case(name,    i) {
  for (i = 1; i <= case_count; i++) if (case_order[i] == name) return 1
  return 0
}

function sort_values(values, left, right,    i, j, pivot, tmp) {
  if (left >= right) return
  i = left
  j = right
  pivot = values[int((left + right) / 2)]
  while (i <= j) {
    while (values[i] < pivot) i++
    while (values[j] > pivot) j--
    if (i <= j) {
      tmp = values[i]
      values[i] = values[j]
      values[j] = tmp
      i++
      j--
    }
  }
  if (left < j) sort_values(values, left, j)
  if (i < right) sort_values(values, i, right)
}

function median(values, count) {
  sort_values(values, 1, count)
  return count % 2 \
    ? values[(count + 1) / 2] \
    : (values[count / 2] + values[count / 2 + 1]) / 2
}

# Resample complete ABBA windows rather than treating the two directions as
# independent. Park-Miller's small multiplier stays exact in awk's doubles,
# making the interval repeatable across runs and common awk implementations.
function bootstrap_ci(case_index, window_count, reps,    b, draw, picked, count, lower_index, upper_index) {
  rng_state = 104729 + case_index * 1009 + window_count * 9176
  delete bootstrap_values
  for (b = 1; b <= reps; b++) {
    delete bootstrap_pairs
    count = 0
    for (draw = 1; draw <= window_count; draw++) {
      rng_state = (rng_state * 16807) % 2147483647
      picked = 1 + int((rng_state / 2147483647) * window_count)
      bootstrap_pairs[++count] = block_forward[case_index SUBSEP picked]
      bootstrap_pairs[++count] = block_reverse[case_index SUBSEP picked]
    }
    bootstrap_values[b] = median(bootstrap_pairs, count)
  }
  sort_values(bootstrap_values, 1, reps)
  lower_index = int(0.025 * (reps - 1)) + 1
  upper_index = int(0.975 * (reps - 1)) + 1
  ci_low = bootstrap_values[lower_index]
  ci_high = bootstrap_values[upper_index]
}

function parse_line(    i, pair) {
  round = ""; slot = ""; label = ""; bench_case = ""; median_us = ""
  for (i = 1; i <= NF; i++) {
    if (split($i, pair, "=") == 2) {
      if (pair[1] == "round") round = pair[2]
      else if (pair[1] == "slot") slot = pair[2]
      else if (pair[1] == "label") label = pair[2]
      else if (pair[1] == "case") bench_case = pair[2]
      else if (pair[1] == "median_us") median_us = pair[2]
    }
  }
}

BEGIN {
  case_count = split(expected_cases, case_order, " ")
  if (expected_rounds !~ /^[1-9][0-9]*$/) warn("invalid expected_rounds=" expected_rounds)
  if (case_count < 1 || expected_cases == "") warn("expected_cases is empty")
  if (limit_pct != "" && limit_pct !~ /^[0-9]+([.][0-9]+)?$/) {
    warn("invalid limit_pct=" limit_pct)
  }
  if (bootstrap_samples == "") bootstrap_samples = 20000
  if (bootstrap_samples !~ /^[1-9][0-9]*$/ || bootstrap_samples + 0 < 1000) {
    warn("bootstrap_samples must be an integer >= 1000")
  }
}

/PR1_QJS round=[0-9]+ slot=[0-9]+ label=/ {
  parse_line()
  if (round !~ /^[1-9][0-9]*$/ || round + 0 > expected_rounds + 0) {
    warn("unexpected round=" round)
    next
  }
  if (slot !~ /^[1-4]$/) {
    warn("unexpected slot=" slot " round=" round)
    next
  }
  if (round % 2 == 1) {
    expected_label = (slot == 1 || slot == 4) ? "main" : "candidate"
  } else {
    expected_label = (slot == 1 || slot == 4) ? "candidate" : "main"
  }
  if (label != expected_label) {
    warn("round=" round " slot=" slot " label=" label " expected=" expected_label)
  }
  if (!wanted_case(bench_case)) {
    warn("unexpected case=" bench_case " round=" round " slot=" slot)
    next
  }
  if (median_us !~ /^[0-9]+([.][0-9]+)?$/ || median_us + 0 <= 0) {
    warn("invalid median_us=" median_us " case=" bench_case " round=" round " slot=" slot)
    next
  }
  key = round SUBSEP slot SUBSEP bench_case
  seen[key]++
  if (seen[key] > 1) warn("duplicate row case=" bench_case " round=" round " slot=" slot)
  measurements[key] = median_us + 0
}

END {
  for (r = 1; r <= expected_rounds; r++) {
    for (s = 1; s <= 4; s++) {
      for (ci = 1; ci <= case_count; ci++) {
        key = r SUBSEP s SUBSEP case_order[ci]
        if (seen[key] != 1) {
          warn("missing row case=" case_order[ci] " round=" r " slot=" s)
        }
      }
    }
  }

  if (bad) {
    printf "PR1_QJS_COMPARISON_RESULT comparison=%s verdict=error failed_cases=0 inconclusive_cases=0 errors=1\n", comparison
    exit 3
  }

  printf "PR1_QJS_SUMMARY comparison=%s rounds=%d pairs_per_case=%d statistic=median_us ci=window_bootstrap bootstrap_samples=%d\n", \
    comparison, expected_rounds, 2 * expected_rounds, bootstrap_samples
  failed_cases = 0
  inconclusive_cases = 0
  for (ci = 1; ci <= case_count; ci++) {
    bench_case = case_order[ci]
    pair_count = 0
    delete pairs
    delete windows
    for (r = 1; r <= expected_rounds; r++) {
      if (r % 2 == 1) {
        forward = (measurements[r SUBSEP 2 SUBSEP bench_case] / \
          measurements[r SUBSEP 1 SUBSEP bench_case] - 1) * 100
        reverse = (measurements[r SUBSEP 3 SUBSEP bench_case] / \
          measurements[r SUBSEP 4 SUBSEP bench_case] - 1) * 100
      } else {
        forward = (measurements[r SUBSEP 1 SUBSEP bench_case] / \
          measurements[r SUBSEP 2 SUBSEP bench_case] - 1) * 100
        reverse = (measurements[r SUBSEP 4 SUBSEP bench_case] / \
          measurements[r SUBSEP 3 SUBSEP bench_case] - 1) * 100
      }
      pairs[++pair_count] = forward
      pairs[++pair_count] = reverse
      block_forward[ci SUBSEP r] = forward
      block_reverse[ci SUBSEP r] = reverse
      windows[r] = sprintf("%+.2f %+.2f", forward, reverse)
    }
    total = 0
    for (i = 1; i <= pair_count; i++) total += pairs[i]
    point_median = median(pairs, pair_count)
    bootstrap_ci(ci, expected_rounds, bootstrap_samples)
    line = sprintf("  %-30s", bench_case)
    for (r = 1; r <= expected_rounds; r++) line = line sprintf(" W%d[%s]", r, windows[r])
    line = line sprintf(" median=%+.2f%% ci95=[%+.2f%%,%+.2f%%] mean=%+.2f%% min=%+.2f%% max=%+.2f%%", \
      point_median, ci_low, ci_high, total / pair_count, pairs[1], pairs[pair_count])
    print line

    if (limit_pct == "") {
      verdict = "info"
      shown_limit = "none"
    # Ratios that are mathematically equal to the limit can land a few ULPs
    # above it (for example, 103 / 100 - 1 at a 3% limit). Treat equality as
    # passing while keeping changes visible at the six-decimal output scale.
    } else if (ci_low - (limit_pct + 0) > 0.0000005) {
      verdict = "fail"
      shown_limit = sprintf("%.6f", limit_pct + 0)
      failed_cases++
    } else if (ci_high - (limit_pct + 0) <= 0.0000005) {
      verdict = "pass"
      shown_limit = sprintf("%.6f", limit_pct + 0)
    } else {
      verdict = "inconclusive"
      shown_limit = sprintf("%.6f", limit_pct + 0)
      inconclusive_cases++
    }
    printf "PR1_QJS_RESULT comparison=%s baseline=%s candidate=%s case=%s pairs=%d statistic=median_us median_pct=%+.6f ci95_low_pct=%+.6f ci95_high_pct=%+.6f limit_pct=%s verdict=%s\n", \
      comparison, baseline_sha, candidate_sha, bench_case, pair_count, point_median, ci_low, ci_high, shown_limit, verdict
  }

  overall = limit_pct == "" ? "info" \
    : (failed_cases > 0 ? "fail" : (inconclusive_cases > 0 ? "inconclusive" : "pass"))
  printf "PR1_QJS_COMPARISON_RESULT comparison=%s verdict=%s failed_cases=%d inconclusive_cases=%d errors=0\n", \
    comparison, overall, failed_cases, inconclusive_cases
  if (failed_cases > 0) exit 1
  if (inconclusive_cases > 0) exit 2
}
