# Validate and summarize one complete PR1 QuickJS ABBA transcript.
# Required -v inputs: expected_rounds, expected_cases, comparison,
# baseline_sha, candidate_sha. limit_pct is optional (empty = report only).

function warn(message) {
  print "PR1_QJS_WARN " message > "/dev/stderr"
  bad = 1
}

function wanted_case(name,    i) {
  for (i = 1; i <= case_count; i++) if (case_order[i] == name) return 1
  return 0
}

function parse_line(    i, pair) {
  round = ""; slot = ""; label = ""; bench_case = ""; mean_us = ""
  for (i = 1; i <= NF; i++) {
    if (split($i, pair, "=") == 2) {
      if (pair[1] == "round") round = pair[2]
      else if (pair[1] == "slot") slot = pair[2]
      else if (pair[1] == "label") label = pair[2]
      else if (pair[1] == "case") bench_case = pair[2]
      else if (pair[1] == "mean_us") mean_us = pair[2]
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
  expected_label = (slot == 1 || slot == 4) ? "main" : "candidate"
  if (label != expected_label) {
    warn("round=" round " slot=" slot " label=" label " expected=" expected_label)
  }
  if (!wanted_case(bench_case)) {
    warn("unexpected case=" bench_case " round=" round " slot=" slot)
    next
  }
  if (mean_us !~ /^[0-9]+([.][0-9]+)?$/ || mean_us + 0 <= 0) {
    warn("invalid mean_us=" mean_us " case=" bench_case " round=" round " slot=" slot)
    next
  }
  key = round SUBSEP slot SUBSEP bench_case
  seen[key]++
  if (seen[key] > 1) warn("duplicate row case=" bench_case " round=" round " slot=" slot)
  measurements[key] = mean_us + 0
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
    printf "PR1_QJS_COMPARISON_RESULT comparison=%s verdict=error failed_cases=0 errors=1\n", comparison
    exit 3
  }

  printf "PR1_QJS_SUMMARY comparison=%s rounds=%d pairs_per_case=%d\n", \
    comparison, expected_rounds, 2 * expected_rounds
  failed_cases = 0
  for (ci = 1; ci <= case_count; ci++) {
    bench_case = case_order[ci]
    pair_count = 0
    delete pairs
    delete windows
    for (r = 1; r <= expected_rounds; r++) {
      forward = (measurements[r SUBSEP 2 SUBSEP bench_case] / \
        measurements[r SUBSEP 1 SUBSEP bench_case] - 1) * 100
      reverse = (measurements[r SUBSEP 3 SUBSEP bench_case] / \
        measurements[r SUBSEP 4 SUBSEP bench_case] - 1) * 100
      pairs[++pair_count] = forward
      pairs[++pair_count] = reverse
      windows[r] = sprintf("%+.2f %+.2f", forward, reverse)
    }
    for (i = 1; i <= pair_count; i++) {
      for (j = i + 1; j <= pair_count; j++) {
        if (pairs[i] > pairs[j]) {
          tmp = pairs[i]; pairs[i] = pairs[j]; pairs[j] = tmp
        }
      }
    }
    total = 0
    for (i = 1; i <= pair_count; i++) total += pairs[i]
    median = pair_count % 2 \
      ? pairs[(pair_count + 1) / 2] \
      : (pairs[pair_count / 2] + pairs[pair_count / 2 + 1]) / 2
    line = sprintf("  %-30s", bench_case)
    for (r = 1; r <= expected_rounds; r++) line = line sprintf(" W%d[%s]", r, windows[r])
    line = line sprintf(" median=%+.2f%% mean=%+.2f%% min=%+.2f%% max=%+.2f%%", \
      median, total / pair_count, pairs[1], pairs[pair_count])
    print line

    if (limit_pct == "") {
      verdict = "info"
      shown_limit = "none"
    # Ratios that are mathematically equal to the limit can land a few ULPs
    # above it (for example, 103 / 100 - 1 at a 3% limit). Treat equality as
    # passing while keeping changes visible at the six-decimal output scale.
    } else if (median - (limit_pct + 0) > 0.0000005) {
      verdict = "fail"
      shown_limit = sprintf("%.6f", limit_pct + 0)
      failed_cases++
    } else {
      verdict = "pass"
      shown_limit = sprintf("%.6f", limit_pct + 0)
    }
    printf "PR1_QJS_RESULT comparison=%s baseline=%s candidate=%s case=%s pairs=%d median_pct=%+.6f limit_pct=%s verdict=%s\n", \
      comparison, baseline_sha, candidate_sha, bench_case, pair_count, median, shown_limit, verdict
  }

  overall = limit_pct == "" ? "info" : (failed_cases > 0 ? "fail" : "pass")
  printf "PR1_QJS_COMPARISON_RESULT comparison=%s verdict=%s failed_cases=%d errors=0\n", \
    comparison, overall, failed_cases
  if (failed_cases > 0) exit 1
}
