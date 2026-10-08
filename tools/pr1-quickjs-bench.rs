// Included into a scratch copy of PocketJS's desktop host by
// pr1-quickjs-bench.sh. This times engine-only tick functions inside the
// same QuickJS Guest implementation used by the shipping desktop runtime.
#[cfg(test)]
mod pr1_quickjs_bench {
    use super::*;
    use std::time::Instant;

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn run_case(guest: &Guest, label: &str, name: &str, iterations: usize, rounds: usize) {
        let warm = format!("globalThis.__pr1Run({name:?}, 400)");
        guest.with(|ctx| ctx.eval::<i32, _>(warm.as_str()).unwrap());

        let source = format!("globalThis.__pr1Run({name:?}, {iterations})");
        let mut samples = Vec::with_capacity(rounds);
        for _ in 0..rounds {
            let started = Instant::now();
            guest.with(|ctx| ctx.eval::<i32, _>(source.as_str()).unwrap());
            samples.push(started.elapsed().as_secs_f64() * 1_000_000.0 / iterations as f64);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        println!(
            "PR1_QJS label={} case={} iterations={} rounds={} mean_us={:.3} median_us={:.3} p95_us={:.3} min_us={:.3} max_us={:.3}",
            label,
            name,
            iterations,
            rounds,
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
        let path = std::env::var("PR1_BENCH_JS").expect("PR1_BENCH_JS");
        let label = std::env::var("PR1_BENCH_LABEL").unwrap_or_else(|_| "unknown".into());
        let iterations = std::env::var("PR1_BENCH_ITERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(2_000);
        let rounds = std::env::var("PR1_BENCH_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(9);
        let requested = std::env::var("PR1_BENCH_CASE").ok();
        let source = std::fs::read_to_string(path).unwrap();
        let guest = Guest::new().unwrap();
        guest.eval("pr1-quickjs-entry", &source).unwrap();

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
            run_case(&guest, &label, name, iterations, rounds);
        }
    }
}
