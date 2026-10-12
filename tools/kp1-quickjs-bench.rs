// Included into a scratch copy of PocketJS's desktop host by
// kp1-quickjs-bench.sh. It measures boot and GameView construction in the
// shipping rquickjs Guest, with a native monotonic clock exposed only to the
// optional startup-profile hook.
#[cfg(test)]
mod kp1_quickjs_bench {
    use super::*;
    use pocket_mod::qjs::Function;
    use serde::Deserialize;
    use std::path::PathBuf;
    use std::time::Instant;

    const BENCH_APP_ID: &str = "dev.lfkdsk.rpgkit-kp1-bench";

    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Ops {
        create_node: u64,
        destroy_node: u64,
        insert_before: u64,
        remove_child: u64,
        set_style: u64,
        set_image: u64,
        set_text: u64,
        set_debug_name: u64,
        set_prop_batch: u64,
    }

    #[derive(Debug, Clone, Deserialize)]
    struct Mark {
        name: String,
        at: f64,
        ops: Ops,
    }

    #[derive(Debug, Clone)]
    struct BootPhases {
        read_ms: f64,
        surface_ms: f64,
        guest_ms: f64,
        mounts_ms: f64,
        eval_ms: f64,
        total_ms: f64,
    }

    struct Sample {
        phases: BootPhases,
        marks: Vec<Mark>,
        ops: Ops,
        first_qjs_ms: f64,
        first_core_ms: f64,
        first_commit_ms: f64,
        startup_to_first_ms: f64,
    }

    fn elapsed_ms(start: Instant) -> f64 {
        start.elapsed().as_secs_f64() * 1_000.0
    }

    fn install_profile(guest: &Guest, origin: Instant) -> Result<()> {
        guest.mount("kp1Profile", move |ctx, ns| {
            ns.set(
                "now",
                Function::new(ctx.clone(), move || elapsed_ms(origin))?,
            )?;
            Ok(())
        })?;
        guest.eval(
            "kp1-profile",
            r#"
            globalThis.__kp1Ops = {
              createNode: 0, destroyNode: 0, insertBefore: 0, removeChild: 0,
              setStyle: 0, setImage: 0, setText: 0, setDebugName: 0,
              setPropBatch: 0
            };
            for (const name of Object.keys(globalThis.__kp1Ops)) {
              const original = globalThis.ui[name];
              if (typeof original !== "function") continue;
              globalThis.ui[name] = function(...args) {
                globalThis.__kp1Ops[name]++;
                return original.apply(globalThis.ui, args);
              };
            }
            globalThis.__kp1Marks = [];
            globalThis.__rpgkitStartupProfileMark = function(name) {
              globalThis.__kp1Marks.push({
                name,
                at: globalThis.kp1Profile.now(),
                ops: {...globalThis.__kp1Ops}
              });
            };
            "#,
        )?;
        Ok(())
    }

    fn profiled_boot(args: Args) -> Result<(Runtime, BootPhases)> {
        let total = Instant::now();
        let stage = Instant::now();
        let pak = std::fs::read(resolve_asset(args.pak.clone(), &args.app, "pak")?)?;
        let source = std::fs::read_to_string(resolve_asset(args.js.clone(), &args.app, "js")?)?;
        let read_ms = elapsed_ms(stage);

        let stage = Instant::now();
        let surface = UiSurface::new_with_density(
            (args.viewport.0 as f32, args.viewport.1 as f32),
            args.density,
        );
        surface.set_identity(HOST_ID, HOST_ABI);
        surface.set_tick_rate(60);
        surface.set_svc_allowlist(args.companions.clone());
        surface.feed_pak(&pak);
        let audio_host = audio::AudioHost::new(
            1 + args
                .system
                .as_ref()
                .map_or(0, |system| system.applications.len()),
        );
        let supervisor = AppSupervisor::new(
            args.system.as_ref(),
            &surface,
            args.data_root.clone(),
            &audio_host,
        )?;
        let surface_ms = elapsed_ms(stage);

        let stage = Instant::now();
        let guest = Guest::new_with_idle_gc(IdleGcConfig::default())?;
        let guest_ms = elapsed_ms(stage);

        let stage = Instant::now();
        surface.mount(&guest)?;
        let offload = text_worker(pak);
        offload.mount(&guest)?;
        let app_id = args.app_id.clone().unwrap_or_else(|| args.app.clone());
        let fs_roots = fs::data_roots(args.data_root.as_deref(), &app_id)?;
        let fs_mount = fs::mount_fs(&guest, &fs_roots)?;
        let audio = audio::AudioSurface::new(audio_host.client(0));
        audio.mount(&guest)?;
        let network = network::Network::mount(&guest)?;
        install_profile(&guest, total)?;
        let mounts_ms = elapsed_ms(stage);

        let stage = Instant::now();
        guest.eval(&args.app, &source)?;
        let eval_ms = elapsed_ms(stage);
        if !guest.has_frame() {
            return Err(anyhow!("bundle installed no frame handler"));
        }
        guest.arm_idle_gc();
        surface.svc_push(
            json!({"t":"hello","w":args.viewport.0,"h":args.viewport.1,"epoch":epoch_ms()})
                .to_string(),
        );
        let wire = args
            .svc_connect
            .clone()
            .map(|addr| net::SvcWire::spawn(addr, args.app.clone()));
        let phases = BootPhases {
            read_ms,
            surface_ms,
            guest_ms,
            mounts_ms,
            eval_ms,
            total_ms: elapsed_ms(total),
        };
        Ok((
            Runtime {
                viewport: args.viewport,
                script: args.script.clone(),
                args,
                surface,
                guest,
                supervisor,
                offload,
                audio,
                _audio_host: audio_host,
                _fs: fs_mount,
                network,
                ticks: 0,
                buttons: 0,
                script_buttons: 0,
                script_mouse: false,
                click_edge: false,
                mouse_down: false,
                wire,
            },
            phases,
        ))
    }

    fn args(dist: &PathBuf, app: &str, data: PathBuf, width: u32, height: u32) -> Args {
        Args {
            app: app.into(),
            js: Some(dist.join(format!("{app}.js"))),
            pak: Some(dist.join(format!("{app}.pak"))),
            file: None,
            data_root: Some(data),
            app_id: Some(BENCH_APP_ID.into()),
            title: "KP1 QuickJS mount bench".into(),
            viewport: (width, height),
            fixed: false,
            native_text: false,
            editor: false,
            companions: Vec::new(),
            system: None,
            svc_connect: None,
            density: 1,
            script: Vec::new(),
            quit_after_ticks: None,
            storm: None,
            announce_ready: false,
            trace_frames: false,
        }
    }

    fn json<T: for<'de> Deserialize<'de>>(runtime: &Runtime, source: &str) -> T {
        let text = runtime
            .guest
            .with(|ctx| ctx.eval::<String, _>(source).expect("QuickJS JSON probe"));
        serde_json::from_str(&text).expect("decode QuickJS JSON probe")
    }

    fn run_once(dist: &PathBuf, app: &str, data: PathBuf, width: u32, height: u32) -> Sample {
        let started = Instant::now();
        let (mut runtime, phases) = profiled_boot(args(dist, app, data, width, height)).unwrap();
        let marks: Vec<Mark> = json(&runtime, "JSON.stringify(globalThis.__kp1Marks)");
        let ops: Ops = json(&runtime, "JSON.stringify(globalThis.__kp1Ops)");

        runtime._audio_host.begin_tick();
        runtime.audio.begin_tick();
        runtime.offload.begin_frame();
        runtime.network.begin_tick();
        let stage = Instant::now();
        runtime.guest.frame(0).expect("QuickJS first frame");
        let first_qjs_ms = elapsed_ms(stage);
        let stage = Instant::now();
        runtime.surface.tick();
        let first_core_ms = elapsed_ms(stage);
        let stage = Instant::now();
        for (id, error) in runtime
            .supervisor
            .sync(&runtime.surface)
            .into_iter()
            .chain(runtime.supervisor.tick())
        {
            panic!("AppInstance {id}: {error}");
        }
        let _ = runtime.surface.svc_drain();
        runtime.ticks += 1;
        let _ = runtime.hash();
        let first_commit_ms = elapsed_ms(stage);
        Sample {
            phases,
            marks,
            ops,
            first_qjs_ms,
            first_core_ms,
            first_commit_ms,
            startup_to_first_ms: elapsed_ms(started),
        }
    }

    fn percentile(values: &[f64], fraction: f64) -> f64 {
        let mut sorted = values.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sorted[((sorted.len() as f64 - 1.0) * fraction).ceil() as usize]
    }

    fn value(samples: &[Sample], get: impl Fn(&Sample) -> f64) -> Vec<f64> {
        samples.iter().map(get).collect()
    }

    fn mark_delta(sample: &Sample, start: &str, end: &str) -> Option<(f64, i64)> {
        let a = sample.marks.iter().find(|mark| mark.name == start)?;
        let b = sample.marks.iter().find(|mark| mark.name == end)?;
        Some((
            b.at - a.at,
            b.ops.create_node as i64 - a.ops.create_node as i64,
        ))
    }

    fn report_metric(label: &str, values: &[f64]) {
        println!(
            "KP1_METRIC name={label} n={} min_ms={:.3} median_ms={:.3} p90_ms={:.3} max_ms={:.3}",
            values.len(),
            percentile(values, 0.0),
            percentile(values, 0.5),
            percentile(values, 0.9),
            percentile(values, 1.0),
        );
    }

    #[test]
    #[ignore]
    fn mount_profile() {
        let dist = PathBuf::from(std::env::var("KP1_DIST").expect("KP1_DIST"));
        let app = std::env::var("KP1_APP").expect("KP1_APP");
        let data = PathBuf::from(std::env::var("KP1_DATA_ROOT").expect("KP1_DATA_ROOT"));
        let width = std::env::var("KP1_BENCH_W")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let height = std::env::var("KP1_BENCH_H")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let runs = std::env::var("KP1_RUNS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(7);
        let samples: Vec<_> = (0..runs)
            .map(|_| run_once(&dist, &app, data.clone(), width, height))
            .collect();
        println!("KP1_CASE app={app} viewport={width}x{height}");
        report_metric("host-read", &value(&samples, |s| s.phases.read_ms));
        report_metric(
            "host-pak-surface",
            &value(&samples, |s| s.phases.surface_ms),
        );
        report_metric("host-guest", &value(&samples, |s| s.phases.guest_ms));
        report_metric("host-mounts", &value(&samples, |s| s.phases.mounts_ms));
        report_metric("bundle-eval", &value(&samples, |s| s.phases.eval_ms));
        report_metric("boot", &value(&samples, |s| s.phases.total_ms));
        report_metric("first-qjs", &value(&samples, |s| s.first_qjs_ms));
        report_metric("first-core", &value(&samples, |s| s.first_core_ms));
        report_metric("first-commit", &value(&samples, |s| s.first_commit_ms));
        report_metric(
            "startup-to-first",
            &value(&samples, |s| s.startup_to_first_ms),
        );

        for (label, start, end) in [
            ("game-view-mount", "game-view:start", "game-view:mounted"),
            ("item-names", "game-view:start", "game-view:item-names"),
            (
                "create-session",
                "session-create:start",
                "session-create:end",
            ),
            (
                "extension-registration",
                "session-create:start",
                "session-create:registrations",
            ),
            (
                "map-index-validation",
                "session-create:registrations",
                "session-create:index-validated",
            ),
            (
                "map-manifest-resolve",
                "session-create:index-validated",
                "session-create:manifest-resolved",
            ),
            (
                "map-manifest-canonical",
                "session-create:index-validated",
                "map-manifest:canonical",
            ),
            (
                "map-manifest-sha256",
                "map-manifest:canonical",
                "session-create:manifest-resolved",
            ),
            (
                "map-read-decode",
                "map-acquire:start",
                "map-acquire:decoded",
            ),
            (
                "map-validation",
                "map-acquire:decoded",
                "map-acquire:validated",
            ),
            (
                "compile-world",
                "map-acquire:validated",
                "map-acquire:world",
            ),
            (
                "compile-passage",
                "map-acquire:world",
                "map-acquire:passage",
            ),
            ("start-session", "session-start:start", "session-start:end"),
            ("view-model", "game-view:state", "game-view:model"),
            ("ui-ground", "ui-ground:start", "ui-ground:end"),
            (
                "ui-animated-below",
                "ui-animated-below:start",
                "ui-animated-below:end",
            ),
            ("ui-upper", "ui-upper:start", "ui-upper:end"),
            ("ui-actors", "ui-actors:start", "ui-actors:end"),
            ("ui-upper-pool", "ui-upper:selected", "ui-upper:pooled"),
            ("ui-dialog", "ui-dialog:start", "ui-dialog:end"),
            ("ui-tree", "game-view:model", "game-view:tree"),
            ("mount-effects", "game-view:tree", "game-view:mounted"),
        ] {
            let found: Vec<_> = samples
                .iter()
                .filter_map(|sample| mark_delta(sample, start, end))
                .collect();
            if found.is_empty() {
                continue;
            }
            let times: Vec<_> = found.iter().map(|v| v.0).collect();
            let nodes: Vec<_> = found.iter().map(|v| v.1).collect();
            println!(
                "KP1_STAGE name={label} n={} median_ms={:.3} p90_ms={:.3} median_nodes={} max_nodes={}",
                found.len(),
                percentile(&times, 0.5),
                percentile(&times, 0.9),
                percentile(&nodes.iter().map(|v| *v as f64).collect::<Vec<_>>(), 0.5) as i64,
                nodes.iter().max().unwrap(),
            );
        }
        let total_nodes: Vec<_> = samples.iter().map(|s| s.ops.create_node as f64).collect();
        println!(
            "KP1_NODES create_median={} create_max={} insert_median={} style_median={} image_median={} text_median={} debug_median={}",
            percentile(&total_nodes, 0.5) as u64,
            percentile(&total_nodes, 1.0) as u64,
            percentile(&samples.iter().map(|s| s.ops.insert_before as f64).collect::<Vec<_>>(), 0.5) as u64,
            percentile(&samples.iter().map(|s| s.ops.set_style as f64).collect::<Vec<_>>(), 0.5) as u64,
            percentile(&samples.iter().map(|s| s.ops.set_image as f64).collect::<Vec<_>>(), 0.5) as u64,
            percentile(&samples.iter().map(|s| s.ops.set_text as f64).collect::<Vec<_>>(), 0.5) as u64,
            percentile(&samples.iter().map(|s| s.ops.set_debug_name as f64).collect::<Vec<_>>(), 0.5) as u64,
        );
        if let Some(sample) = samples.first() {
            for mark in &sample.marks {
                println!(
                    "KP1_MARK name={} at_ms={:.3} create={} insert={} style={} image={} text={} debug={}",
                    mark.name,
                    mark.at,
                    mark.ops.create_node,
                    mark.ops.insert_before,
                    mark.ops.set_style,
                    mark.ops.set_image,
                    mark.ops.set_text,
                    mark.ops.set_debug_name,
                );
            }
        }
    }
}
