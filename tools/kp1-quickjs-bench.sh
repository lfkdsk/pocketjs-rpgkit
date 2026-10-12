#!/usr/bin/env bash
# Build a scratch desktop host and profile one already-built PocketJS bundle.
# Usage: tools/kp1-quickjs-bench.sh DIST APP [DATA_SOURCE]
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dist=${1:-$root/dist}
app=${2:-sunstone}
seed=${3:-}
bench_root=${KP1_BENCH_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-rpgkit-bench/kp1-quickjs}
scratch="$bench_root/host"
target="$bench_root/target"
data="$bench_root/data-$app"
app_data="$data/dev.lfkdsk.rpgkit-kp1-bench/data"

test -f "$dist/$app.js"
test -f "$dist/$app.pak"

rm -rf "$scratch" "$data"
mkdir -p "$scratch" "$app_data"
cp -a "$root/vendor/pocketjs/hosts/desktop/." "$scratch/"
cp "$root/tools/kp1-quickjs-bench.rs" "$scratch/src/kp1-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$root/vendor/pocketjs/engine#g" "$scratch/Cargo.toml"
sed -i '$a include!("kp1-quickjs-bench.rs");' "$scratch/src/main.rs"

if [[ -n "$seed" ]]; then
  for name in maps battle animated npc-src terrain-stream; do
    if [[ -d "$seed/$name" ]]; then
      cp -a "$seed/$name" "$app_data/$name"
    fi
  done
fi

CARGO_TARGET_DIR="$target" cargo test --no-default-features --manifest-path "$scratch/Cargo.toml" --release --no-run
binary=$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$binary"

if [[ ${KP1_COMPILE_ONLY:-0} == 1 ]]; then
  printf 'KP1_COMPILE_OK binary=%s\n' "$binary"
  exit 0
fi

for viewport in "480 272" "960 544"; do
  read -r width height <<<"$viewport"
  KP1_DIST="$dist" KP1_APP="$app" KP1_DATA_ROOT="$data" \
    KP1_BENCH_W="$width" KP1_BENCH_H="$height" KP1_RUNS="${KP1_RUNS:-7}" \
    "$binary" kp1_quickjs_bench::mount_profile --ignored --exact --nocapture
done
