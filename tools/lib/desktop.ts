// tools/lib/desktop.ts — build one of this repo's PocketJS apps for the
// portable desktop host (macos-app on a Mac, linux-app elsewhere) and
// start the host on it. Shared by tools/desktop.ts (the examples) and
// tools/editor.ts (the editor).
//
// PocketJS's own `bun run macos <app>` only knows apps inside its checkout,
// so this mirrors it for an external project: resolve the app's pocket.json
// against the desktop target with the vendored manifest resolver, build the
// bundle from that plan into dist/<target>/, build the portable Rust host,
// and start it with --js/--pak pointing at this repo's artifacts. Every
// host flag derives from the resolved plan.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/resolve.ts";
import type { ResolvedBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/plan.ts";
import { appDirOf, fontLicenseFiles } from "./font-licenses.ts";
import { packageNativeArtifacts } from "./native-package.ts";

const root = resolve(import.meta.dir, "..", "..");
const pocketjs = join(root, "vendor", "pocketjs");

export const DESKTOP_TARGET = process.platform === "darwin" ? "macos-app" : "linux-app";

export interface DesktopBuild {
  plan: ResolvedBuildPlan;
  /** dist/<target>/ — holds <output>.js and <output>.pak. */
  outdir: string;
  /** The release pocket-desktop-host binary. */
  bin: string;
  /** Source-preserving package used only by the explicit bytecode path. */
  pocket?: string;
}

export interface DesktopBuildOptions {
  /** Compile section-6 bytecode and launch the final package with --pocket. */
  bytecode?: boolean;
}

/** Resolve `manifestPath` (a pocket.json) for the desktop target, build the
 *  bundle from the plan, and `cargo build --release` the host. */
export async function buildForDesktop(
  manifestPath: string,
  options: DesktopBuildOptions = {},
): Promise<DesktopBuild> {
  const manifest = await Bun.file(manifestPath).json();
  const resolution = validateAndResolveBuildPlan(manifest, { target: DESKTOP_TARGET });
  if (!resolution.ok) {
    throw new Error(
      `desktop: ${relative(root, manifestPath)} did not resolve against ${DESKTOP_TARGET}: ` +
        resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; "),
    );
  }
  const plan = resolution.plan;

  const outdir = join(root, "dist", DESKTOP_TARGET);
  mkdirSync(outdir, { recursive: true });
  const planPath = join(root, ".pocket", DESKTOP_TARGET, `${plan.app.output}.plan.json`);
  mkdirSync(resolve(planPath, ".."), { recursive: true });
  await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
  await $`bun ${join(pocketjs, "tools", "build.ts")} --plan=${planPath} --project-root=${root} --outdir=${outdir}`.cwd(root);
  let pocket: string | undefined;
  if (options.bytecode) {
    pocket = join(outdir, `${plan.app.output}.pocket`);
    const packaged = await packageNativeArtifacts({
      manifest: new Uint8Array(readFileSync(manifestPath)),
      plan,
      javascript: new Uint8Array(readFileSync(join(outdir, `${plan.app.output}.js`))),
      pak: new Uint8Array(readFileSync(join(outdir, `${plan.app.output}.pak`))),
      bytecode: true,
      bytecodeBuildDirectory: join(root, ".pocket-build", "quickjs-bytecode"),
    });
    writeFileSync(pocket, packaged.bytes);
  }
  await $`cargo build --release ${desktopHostFeatures()}`.cwd(join(pocketjs, "hosts", "desktop"));

  // Glyphs baked from a fallback font are a derivative of it: its license
  // sits beside the pak (which also carries it, through pak.json).
  for (const file of fontLicenseFiles(appDirOf(root, plan.app.entry))) copyFileSync(file, join(outdir, basename(file)));

  const bin = join(pocketjs, "hosts", "desktop", "target", "release", "pocket-desktop-host");
  return { plan, outdir, bin, ...(pocket ? { pocket } : {}) };
}

/** Host flags for a built app, all derived from its resolved plan. */
export function desktopFlags({ plan, outdir, pocket }: DesktopBuild): string[] {
  if (pocket) return ["--pocket", pocket];
  return [
    "--app", plan.app.output,
    // The per-app data.fs root keys off the reverse-DNS app id.
    "--app-id", plan.app.id,
    "--title", plan.app.title,
    "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
    "--density", String(plan.viewport.rasterDensity),
    ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
    ...(plan.companions.length > 0 ? ["--companions", plan.companions.join(",")] : []),
    "--js", join(outdir, `${plan.app.output}.js`),
    "--pak", join(outdir, `${plan.app.output}.pak`),
  ];
}

/** Start the host window (stays attached to the terminal; Cmd+Q quits). */
export async function runDesktopHost(build: DesktopBuild, extra: readonly string[]): Promise<void> {
  const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };
  await $`${build.bin} ${desktopFlags(build)} ${extra}`.env(env);
}

/** The desktop host plays sound through CPAL, which on Linux links ALSA. When
 *  the ALSA development files are missing, build without the default
 *  `audio-output` feature: the guest still gets the PCM audio API on a
 *  clocked silent sink, so games run, just without sound. */
export function desktopHostFeatures(): string[] {
  if (process.platform !== "linux") return [];
  const probe = Bun.spawnSync(["pkg-config", "--exists", "alsa"], { stdout: "ignore", stderr: "ignore" });
  if (probe.exitCode === 0) return [];
  console.warn("desktop: ALSA development files not found (pkg-config alsa); building the host without audio output");
  return ["--no-default-features"];
}
