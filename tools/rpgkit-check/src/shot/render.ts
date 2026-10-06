// tools/rpgkit-check/src/shot/render.ts — the screenshot driver. Boots the
// rpgkit-shot sim fixture (tests/fixtures/rpgkit-shot) on the deterministic
// wasm sim host with the project injected as a global, renders the
// schematic at each requested resolution, and writes PNGs. The fixture does
// the engine work (passage table with live bodies, active-page selection);
// this module only owns boot/encode/write.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { bootWorld } from "../../../../vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../../../../vendor/pocketjs/tests/png.ts";
import type { SessionOptions } from "../../../../src/engine/session.ts";
import type { Dir, Project } from "../../../../src/engine/types.ts";
import type { ShotConfig, ShotSwitchBank } from "../../../../tests/fixtures/rpgkit-shot/rpgkit-shot.tsx";

export interface ShotResolution {
  width: number;
  height: number;
}

/** PSP (480x272) and desktop (960x544). */
export const DEFAULT_RESOLUTIONS: readonly ShotResolution[] = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
];

export interface RenderShotsOptions {
  map: string;
  x: number;
  y: number;
  dir?: Dir;
  sw?: ShotSwitchBank;
  /** "map@x,y" node keys to tint as reachable (e.g. from the reach check). */
  reach?: readonly string[];
  resolutions?: readonly ShotResolution[];
  /** Game-owned registrations loaded by the CLI's --session module. */
  sessionOptions?: SessionOptions;
}

export interface ShotOutput {
  resolution: ShotResolution;
  file: string;
  bytes: number;
  sha256: string;
}

function repoRoot(): string {
  // tools/rpgkit-check/src/shot -> repo root is four levels up.
  return resolve(import.meta.dir, "../../../..");
}

const SHOT_APP = "rpgkit-shot";
const shotBuilds = new Map<string, Promise<string>>();

interface ShotBundleLayout {
  root: string;
  entry: string;
  builder: string;
  cacheDir: string;
  bundle: string;
  inputs: string;
}

function shotBundleLayout(root: string): ShotBundleLayout {
  const absoluteRoot = resolve(root);
  const cacheDir = join(absoluteRoot, ".cache", "rpgkit-check", "shot");
  return {
    root: absoluteRoot,
    entry: join(absoluteRoot, "tests", "fixtures", SHOT_APP, `${SHOT_APP}.tsx`),
    builder: join(absoluteRoot, "vendor", "pocketjs", "tools", "build.ts"),
    cacheDir,
    bundle: join(cacheDir, SHOT_APP),
    inputs: join(cacheDir, `${SHOT_APP}.inputs.json`),
  };
}

function canBuildShot(layout: ShotBundleLayout): boolean {
  return existsSync(layout.entry) && existsSync(layout.builder);
}

/** The cache is fresh only when it came from this checkout and every input
 *  reported by PocketJS is no newer than both published bundle files. */
function freshShotBundle(layout: ShotBundleLayout): boolean {
  const js = `${layout.bundle}.js`;
  const pak = `${layout.bundle}.pak`;
  if (!existsSync(js) || !existsSync(pak) || !existsSync(layout.inputs)) return false;
  let inputs: unknown;
  try {
    inputs = JSON.parse(readFileSync(layout.inputs, "utf8"));
  } catch {
    return false;
  }
  if (!Array.isArray(inputs) || inputs.some((input) => typeof input !== "string")) return false;
  // A copied cache can contain valid files and mtimes from another checkout.
  // Requiring these two checkout-owned paths makes that cache stale without
  // rejecting legitimate external inputs such as the Bun executable.
  const paths = new Set(inputs as string[]);
  if (!paths.has(layout.entry) || !paths.has(layout.builder)) return false;
  const outputTime = Math.min(statSync(js).mtimeMs, statSync(pak).mtimeMs);
  return (inputs as string[]).every((input) => {
    try {
      return statSync(input).mtimeMs <= outputTime;
    } catch {
      return false;
    }
  });
}

async function buildShotBundle(layout: ShotBundleLayout): Promise<string> {
  mkdirSync(layout.cacheDir, { recursive: true });
  const temp = mkdtempSync(join(layout.cacheDir, `.build-${process.pid}-`));
  const tempInputs = join(temp, `${SHOT_APP}.inputs.json`);
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        layout.builder,
        layout.entry,
        `--project-root=${layout.root}`,
        `--outdir=${temp}`,
        `--inputs-file=${tempInputs}`,
      ],
      cwd: layout.root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      throw new Error(`source build exited ${exit}${detail ? `:\n${detail}` : ""}`);
    }
    const tempBundle = join(temp, SHOT_APP);
    for (const file of [`${tempBundle}.js`, `${tempBundle}.pak`, tempInputs]) {
      if (!existsSync(file)) throw new Error(`source build did not produce ${file}`);
    }
    // The manifest is the commit marker: readers never consider a pair fresh
    // until both bundle files have been published.
    rmSync(layout.inputs, { force: true });
    renameSync(`${tempBundle}.js`, `${layout.bundle}.js`);
    renameSync(`${tempBundle}.pak`, `${layout.bundle}.pak`);
    renameSync(tempInputs, layout.inputs);
    return layout.bundle;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Resolve a screenshot fixture bundle. A normal source checkout builds into
 *  an ignored cache on demand; custom legacy roots without source may still
 *  provide dist/rpgkit-shot.js. Concurrent callers share one source build. */
export async function ensureShotBundle(root: string = repoRoot()): Promise<string> {
  const layout = shotBundleLayout(root);
  if (canBuildShot(layout)) {
    if (freshShotBundle(layout)) return layout.bundle;
    const key = layout.root;
    const active = shotBuilds.get(key);
    if (active) return active;
    const build = buildShotBundle(layout).finally(() => shotBuilds.delete(key));
    shotBuilds.set(key, build);
    return build;
  }
  const legacy = join(layout.root, "dist", SHOT_APP);
  if (existsSync(`${legacy}.js`)) return legacy;
  throw new Error(
    `missing screenshot fixture source ${layout.entry} and legacy bundle ${legacy}.js`,
  );
}

/** Whether screenshots can be taken. The wasm core must already exist; the
 *  fixture itself may be built from source and cached by renderShots. */
export function shotPreflight(root: string = repoRoot()): { ok: true } | { ok: false; reason: string } {
  const layout = shotBundleLayout(root);
  const legacy = join(layout.root, "dist", `${SHOT_APP}.js`);
  if (!canBuildShot(layout) && !existsSync(legacy)) {
    return {
      ok: false,
      reason: `missing screenshot fixture source ${layout.entry} and legacy bundle ${legacy}`,
    };
  }
  const wasm = join(layout.root, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm");
  if (!existsSync(wasm)) return { ok: false, reason: `missing ${wasm} — run \`bun run build:wasm\`` };
  return { ok: true };
}

/** Render one PNG per resolution into outDir. Filenames are
 *  `<map>-<x>-<y>.<width>x<height>.png`. Deterministic: the same project +
 *  options produce byte-identical PNGs. */
export async function renderShots(
  project: Project,
  options: RenderShotsOptions,
  outDir: string,
  root: string = repoRoot(),
): Promise<ShotOutput[]> {
  const preflight = shotPreflight(root);
  if (!preflight.ok) throw new Error(`rpgkit-check shot: ${preflight.reason}`);
  mkdirSync(outDir, { recursive: true });
  const resolutions = options.resolutions ?? DEFAULT_RESOLUTIONS;
  const bundle = await ensureShotBundle(root);
  const outputs: ShotOutput[] = [];
  for (const resolution of resolutions) {
    const cfg: ShotConfig = {
      project,
      map: options.map,
      x: options.x,
      y: options.y,
      dir: options.dir,
      sw: options.sw,
      reach: options.reach,
      sessionOptions: options.sessionOptions,
      resolution,
    };
    const world = await bootWorld(
      bundle,
      60,
      { __rpgkitShot: cfg },
      undefined,
      { width: resolution.width, height: resolution.height },
    );
    world.frame(0);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    const fb = world.render();
    const file = join(outDir, `${options.map}-${options.x}-${options.y}.${resolution.width}x${resolution.height}.png`);
    const png = encodePNG(fb, resolution.width, resolution.height);
    writeFileSync(file, png);
    outputs.push({
      resolution,
      file,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
    });
  }
  return outputs;
}
