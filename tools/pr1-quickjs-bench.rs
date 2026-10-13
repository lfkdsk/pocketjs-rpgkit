// Included into a scratch copy of PocketJS's desktop host by
// pr1-quickjs-bench.sh. This times both engine bundles in one QuickJS Guest
// and one host process, matching the shipping desktop runtime while removing
// process-to-process startup and heap-layout noise from the comparison.
#[cfg(test)]
mod pr1_quickjs_bench {
    use super::*;
    use std::time::Instant;

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn invoke(guest: &Guest, binding: &str, name: &str, iterations: usize) {
        let source = format!("globalThis.{binding}({name:?}, {iterations})");
        guest.with(|ctx| ctx.eval::<i32, _>(source.as_str()).unwrap());
    }

    fn calibrated_iterations(
        guest: &Guest,
        name: &str,
        probe_iterations: usize,
        target_sample_us: u128,
    ) -> usize {
        let started = Instant::now();
        invoke(guest, "__pr1Main", name, probe_iterations);
        let elapsed_us = started.elapsed().as_micros().max(1);
        let scaled = (probe_iterations as u128)
            .saturating_mul(target_sample_us)
            .div_ceil(elapsed_us)
            .max(1);
        let chosen = usize::try_from(scaled).unwrap_or(usize::MAX);
        println!(
            "PR1_QJS_CALIBRATION case={} probe_iterations={} baseline_us={} target_us={} chosen_iterations={}",
            name, probe_iterations, elapsed_us, target_sample_us, chosen
        );
        chosen
    }

    fn run_slot(
        guest: &Guest,
        round: usize,
        slot: usize,
        label: &str,
        binding: &str,
        name: &str,
        iterations: usize,
        samples_per_slot: usize,
    ) {
        let mut samples = Vec::with_capacity(samples_per_slot);
        for _ in 0..samples_per_slot {
            let started = Instant::now();
            invoke(guest, binding, name, iterations);
            samples.push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        println!(
            "PR1_QJS round={} slot={} label={} case={} iterations={} samples={} mean_us={:.3} median_us={:.3} p95_us={:.3} min_us={:.3} max_us={:.3}",
            round,
            slot,
            label,
            name,
            iterations,
            samples_per_slot,
            mean,
            percentile(&samples, 0.5),
            percentile(&samples, 0.95),
            samples[0],
            samples[samples.len() - 1],
        );
    }

    #[test]
    #[ignore]
    fn tick_fold() {
        let main_path = std::env::var("PR1_BENCH_MAIN_JS").expect("PR1_BENCH_MAIN_JS");
        let candidate_path =
            std::env::var("PR1_BENCH_CANDIDATE_JS").expect("PR1_BENCH_CANDIDATE_JS");
        let iterations = std::env::var("PR1_BENCH_ITERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(2_000);
        let windows = std::env::var("PR1_BENCH_WINDOWS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);
        let samples_per_slot = std::env::var("PR1_BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(5);
        let target_sample_us = std::env::var("PR1_BENCH_TARGET_SAMPLE_US")
            .ok()
            .and_then(|value| value.parse::<u128>().ok())
            .unwrap_or(100_000);
        let requested = std::env::var("PR1_BENCH_CASE").ok();
        let main_source = std::fs::read_to_string(main_path).unwrap();
        let candidate_source = std::fs::read_to_string(candidate_path).unwrap();
        let guest = Guest::new().unwrap();
        guest.eval("pr1-quickjs-main", &main_source).unwrap();
        guest
            .eval(
                "pr1-quickjs-capture-main",
                "globalThis.__pr1Main = globalThis.__pr1Run; delete globalThis.__pr1Run;",
            )
            .unwrap();
        guest
            .eval("pr1-quickjs-candidate", &candidate_source)
            .unwrap();
        guest
            .eval(
                "pr1-quickjs-capture-candidate",
                "globalThis.__pr1Candidate = globalThis.__pr1Run; delete globalThis.__pr1Run;",
            )
            .unwrap();

        for name in [
            "sunstoneIdle",
            "sunstoneWalk",
            "sunstoneControlWalk",
            "streamedRoam",
            "battleScene",
            "sunstoneIdleImmutable",
            "sunstoneControlWalkImmutable",
            "battleSceneImmutable",
        ] {
            if requested.as_deref().is_some_and(|value| value != name) {
                continue;
            }
            invoke(&guest, "__pr1Main", name, 400);
            invoke(&guest, "__pr1Candidate", name, 400);
            let case_iterations = calibrated_iterations(&guest, name, iterations, target_sample_us);
            for round in 1..=windows {
                let order = if round % 2 == 1 {
                    [
                        ("main", "__pr1Main"),
                        ("candidate", "__pr1Candidate"),
                        ("candidate", "__pr1Candidate"),
                        ("main", "__pr1Main"),
                    ]
                } else {
                    [
                        ("candidate", "__pr1Candidate"),
                        ("main", "__pr1Main"),
                        ("main", "__pr1Main"),
                        ("candidate", "__pr1Candidate"),
                    ]
                };
                for (slot, (label, binding)) in order.iter().enumerate() {
                    run_slot(
                        &guest,
                        round,
                        slot + 1,
                        label,
                        binding,
                        name,
                        case_iterations,
                        samples_per_slot,
                    );
                }
            }
        }
    }
}
