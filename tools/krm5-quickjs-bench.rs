// Real desktop-guest frame benchmark for the imported power-9 weather scene.
// Included by tools/krm5-quickjs-bench.sh in a scratch desktop-host crate.
#[cfg(test)]
mod krm5_quickjs_bench {
    use super::*;
    use std::time::Instant;

    #[derive(Clone, Copy)]
    struct Sample {
        js_ms: f64,
        core_ms: f64,
    }

    struct Bench {
        rt: Runtime,
        temp: PathBuf,
    }

    impl Drop for Bench {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }

    impl Bench {
        fn boot(dist: &std::path::Path, viewport: (u32, u32), rep: usize) -> Self {
            let scratch_root = std::env::var("KRM5_QJS_RUNS").unwrap_or_else(|_| {
                std::env::temp_dir()
                    .join("pocket-rpgkit-krm5-bench")
                    .display()
                    .to_string()
            });
            let temp = PathBuf::from(format!(
                "{scratch_root}/qjs-weather-{}-{}x{}-{rep}",
                std::process::id(),
                viewport.0,
                viewport.1,
            ));
            let _ = std::fs::remove_dir_all(&temp);
            std::fs::create_dir_all(&temp).unwrap();
            let source = std::fs::read_to_string(dist.join("rmi-play.js")).unwrap();
            let js = temp.join("rmi-play.js");
            std::fs::write(
                &js,
                format!(
                    "globalThis.__rmiGame='hollow';globalThis.__rmiScreenPreview='weather';globalThis.__rmiWeatherPower=9;\n{source}",
                ),
            )
            .unwrap();

            let args = Args {
                app: "rmi-play".into(),
                js: Some(js),
                pak: Some(dist.join("rmi-play.pak")),
                file: None,
                data_root: Some(temp.join("data")),
                app_id: Some("dev.lfkdsk.pocket-rpgkit-krm5-weather-bench".into()),
                title: "RPG Maker weather QuickJS benchmark".into(),
                viewport,
                fixed: false,
                native_text: false,
                editor: false,
                companions: Vec::new(),
                system: None,
                svc_connect: None,
                density: 2,
                script: Vec::new(),
                quit_after_ticks: None,
                storm: None,
                announce_ready: false,
                trace_frames: false,
            };
            let rt = Runtime::boot(args).unwrap();
            rt.guest.with(|ctx| {
                ctx.eval::<(), _>(
                    r#"
                    globalThis.__krm5Ops={createNode:0,destroyNode:0,insertBefore:0,removeChild:0};
                    for(const name of Object.keys(globalThis.__krm5Ops)){
                      const original=globalThis.ui[name];
                      globalThis.ui[name]=function(a,b,c,d,e){
                        globalThis.__krm5Ops[name]++;
                        return original(a,b,c,d,e);
                      };
                    }
                    "#,
                )
                .unwrap();
            });
            Self { rt, temp }
        }

        fn frame(&mut self) -> Sample {
            self.rt.offload.begin_frame();
            let started = Instant::now();
            self.rt.guest.frame(0).unwrap();
            let guest_done = Instant::now();
            self.rt.surface.tick();
            let core_done = Instant::now();
            for (id, error) in self
                .rt
                .supervisor
                .sync(&self.rt.surface)
                .into_iter()
                .chain(self.rt.supervisor.tick())
            {
                eprintln!("AppInstance {id}: {error}");
            }
            let _ = self.rt.surface.svc_drain();
            self.rt.ticks += 1;
            Sample {
                js_ms: (guest_done - started).as_secs_f64() * 1_000.0,
                core_ms: (core_done - guest_done).as_secs_f64() * 1_000.0,
            }
        }

        fn weather(&self) -> Option<(String, i64, i64, i64, i64)> {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>(
                    r#"JSON.stringify((()=>{const w=globalThis.__rpgSessionState?.interp?.screen?.weather;return w?[w.kind,w.fromPower,w.targetPower,w.left,w.clock]:null})())"#,
                )
                .unwrap()
            });
            let value: Value = serde_json::from_str(&text).unwrap();
            if value.is_null() {
                return None;
            }
            Some((
                value[0].as_str().unwrap().to_string(),
                value[1].as_i64().unwrap(),
                value[2].as_i64().unwrap(),
                value[3].as_i64().unwrap(),
                value[4].as_i64().unwrap(),
            ))
        }

        fn wait_ready(&mut self) {
            for _ in 0..1_200 {
                if self.weather().is_some_and(|(kind, from, target, left, _)| {
                    kind == "rain" && from == 9 && target == 9 && left == 0
                }) {
                    return;
                }
                self.frame();
            }
            panic!("power-9 imported weather scene did not settle");
        }

        fn reset_ops(&self) {
            self.rt.guest.with(|ctx| {
                ctx.eval::<(), _>(
                    "for(const key of Object.keys(globalThis.__krm5Ops))globalThis.__krm5Ops[key]=0",
                )
                .unwrap();
            });
        }

        fn ops(&self) -> [u64; 4] {
            let text: String = self.rt.guest.with(|ctx| {
                ctx.eval::<String, _>("JSON.stringify(globalThis.__krm5Ops)")
                    .unwrap()
            });
            let value: Value = serde_json::from_str(&text).unwrap();
            [
                value["createNode"].as_u64().unwrap(),
                value["destroyNode"].as_u64().unwrap(),
                value["insertBefore"].as_u64().unwrap(),
                value["removeChild"].as_u64().unwrap(),
            ]
        }
    }

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn print_stats(viewport: (u32, u32), rep: usize, samples: &[Sample], ops: [u64; 4]) {
        let mut js: Vec<f64> = samples.iter().map(|sample| sample.js_ms).collect();
        let mut core: Vec<f64> = samples.iter().map(|sample| sample.core_ms).collect();
        let mut total: Vec<f64> = samples
            .iter()
            .map(|sample| sample.js_ms + sample.core_ms)
            .collect();
        js.sort_by(|a, b| a.partial_cmp(b).unwrap());
        core.sort_by(|a, b| a.partial_cmp(b).unwrap());
        total.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
        println!(
            "KRM5_QJS viewport={}x{} rep={} power=9 particles=90 frames={} js_mean_ms={:.3} js_p95_ms={:.3} core_mean_ms={:.3} core_p95_ms={:.3} total_mean_ms={:.3} total_p95_ms={:.3} total_max_ms={:.3} create={} destroy={} insert={} remove={}",
            viewport.0,
            viewport.1,
            rep,
            samples.len(),
            mean(&js),
            percentile(&js, 0.95),
            mean(&core),
            percentile(&core, 0.95),
            mean(&total),
            percentile(&total, 0.95),
            total[total.len() - 1],
            ops[0],
            ops[1],
            ops[2],
            ops[3],
        );
    }

    fn run(dist: &std::path::Path, viewport: (u32, u32), rep: usize, frames: usize) {
        let mut bench = Bench::boot(dist, viewport, rep);
        bench.wait_ready();
        for _ in 0..180 {
            bench.frame();
        }
        let start_clock = bench.weather().unwrap().4;
        bench.reset_ops();
        let samples: Vec<Sample> = (0..frames).map(|_| bench.frame()).collect();
        let end_clock = bench.weather().unwrap().4;
        let ops = bench.ops();
        assert!(
            end_clock - start_clock >= frames as i64,
            "weather clock did not advance every frame"
        );
        assert_eq!(
            ops, [0; 4],
            "steady weather must update nodes without structural churn"
        );
        print_stats(viewport, rep, &samples, ops);
    }

    #[test]
    #[ignore]
    fn power_nine_weather_frames() {
        let dist = PathBuf::from(std::env::var("POCKETJS_DIST").expect("POCKETJS_DIST"));
        let reps = std::env::var("KRM5_QJS_REPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3);
        let frames = std::env::var("KRM5_QJS_FRAMES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(600);
        for viewport in [(480, 272), (960, 544)] {
            for rep in 1..=reps {
                run(&dist, viewport, rep, frames);
            }
        }
    }
}
