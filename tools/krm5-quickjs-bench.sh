#!/bin/bash
# Build a scratch desktop host and measure the imported power-9 weather scene
# inside the shipping QuickJS guest. The repository and submodule stay clean.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="${1:-$root/dist}"
scratch="${KRM5_QJS_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/krm5-quickjs}"
host="$scratch/host"
target="${KRM5_QJS_TARGET:-$scratch/target}"

if [ ! -f "$dist/rmi-play.js" ] || [ ! -f "$dist/rmi-play.pak" ]; then
  echo "krm5-quickjs-bench: missing $dist/rmi-play.{js,pak} -- run 'bun run build:example rmi-play' first" >&2
  exit 1
fi

rm -rf "$host"
mkdir -p "$host"
cp -r "$root/vendor/pocketjs/hosts/desktop/src" "$host/src"
cp "$root/vendor/pocketjs/hosts/desktop/Cargo.toml" "$host/Cargo.toml"
[ -f "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" ] && cp "$root/vendor/pocketjs/hosts/desktop/Cargo.lock" "$host/Cargo.lock"
sed -i -E "s#path = \"\.\./\.\./([^\"]+)\"#path = \"$root/vendor/pocketjs/\1\"#g" "$host/Cargo.toml"
cp "$root/tools/krm5-quickjs-bench.rs" "$host/src/krm5_quickjs_bench.rs"
echo 'include!("krm5_quickjs_bench.rs");' >> "$host/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --no-default-features --release --no-run --manifest-path "$host/Cargo.toml" >/dev/null
bin="$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' ! -name '*.d' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [ -z "$bin" ]; then
  echo "krm5-quickjs-bench: desktop host test binary was not produced" >&2
  exit 1
fi

pin=()
if [ -n "${KRM5_QJS_CPU:-}" ]; then
  pin=(taskset -c "$KRM5_QJS_CPU")
fi
{
  echo "KRM5_QJS meta=kit value=$(git -C "$root" rev-parse HEAD)"
  echo "KRM5_QJS meta=pocketjs value=$(git -C "$root/vendor/pocketjs" rev-parse HEAD)"
  echo "KRM5_QJS meta=bundle value=$(sha256sum "$dist/rmi-play.js" | cut -d' ' -f1)"
  echo "KRM5_QJS meta=uptime_before value=\"$(uptime)\""
  POCKETJS_DIST="$dist" KRM5_QJS_RUNS="$scratch/runs" \
    KRM5_QJS_REPS="${KRM5_QJS_REPS:-3}" KRM5_QJS_FRAMES="${KRM5_QJS_FRAMES:-600}" \
    "${pin[@]}" "$bin" krm5_quickjs_bench::power_nine_weather_frames --ignored --exact --nocapture 2>&1 \
    | grep -E 'KRM5_QJS|^test result'
  echo "KRM5_QJS meta=uptime_after value=\"$(uptime)\""
} | tee "$scratch/results.log"
