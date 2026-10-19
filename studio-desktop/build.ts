// studio-desktop/build.ts — build the desktop app into studio-desktop/app/,
// ready for `electron app/main.cjs` or electron-builder.
//
//   bun run build                                   # this machine's helper
//   HELPER_TARGETS=bun-darwin-arm64,bun-darwin-x64 bun run build
//                                                   # both Mac helpers, joined
//                                                   # into one universal binary
//
// Output:
//
//   app/package.json          name, version and entry for Electron
//   app/main.cjs              src/main.ts for Node (Electron's main process)
//   app/preload.cjs           src/preload.ts (sandboxed preloads are CommonJS)
//   app/site/studio/          Studio (tools/studio-build.ts) with the desktop
//                             entry (editor/studio/main-desktop.ts) and boot
//                             script instead of the browser's
//   app/site/preview/ …       the play-test player and what it shares with
//                             the web site (player.js, pocketjs.wasm,
//                             site.css), built by tools/web.ts
//   app/helper/rpgkit-studio-helper
//                             src/helper.ts compiled with `bun build
//                             --compile`: local agents and engine checks
//   app/helper/stb-vorbis-LICENSE.txt
//                             Apache-2.0 notice for the embedded Ogg decoder
//
// The PocketJS wasm core must exist (`bun run build:wasm` at the kit root).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildStudio } from "../tools/studio-build.ts";
import { DESKTOP_BOOT_FILE, desktopBootScript, desktopBootTag } from "../editor/studio/host-desktop-boot.ts";

const HERE = import.meta.dir;
const KIT = resolve(HERE, "..");
const APP = join(HERE, "app");
const SITE = join(APP, "site");
const HELPER = "rpgkit-studio-helper";

function run(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`studio-desktop: ${cmd.join(" ")} failed (exit ${result.exitCode})`);
}

async function bundleNode(entry: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "cjs",
    external: ["electron"],
    minify: false,
    throw: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    for (const log of result.logs) console.error(log);
    throw new Error(`studio-desktop: bundling ${entry} failed`);
  }
  writeFileSync(outfile, await result.outputs[0]!.text());
}

function helperTargets(): string[] {
  const raw = process.env.HELPER_TARGETS?.trim();
  return raw ? raw.split(",").map((target) => target.trim()).filter(Boolean) : [];
}

function buildHelper(): void {
  const dir = join(APP, "helper");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "stb-vorbis-LICENSE.txt"),
    readFileSync(join(KIT, "node_modules", "stb-vorbis", "LICENSE")),
  );
  const targets = helperTargets();
  const entry = join(HERE, "src", "helper.ts");
  if (targets.length === 0) {
    const out = join(dir, process.platform === "win32" ? `${HELPER}.exe` : HELPER);
    run(["bun", "build", "--compile", entry, "--outfile", out], KIT);
    return;
  }
  const outputs = targets.map((target) => {
    const out = join(dir, `${HELPER}-${target}${target.includes("windows") ? ".exe" : ""}`);
    run(["bun", "build", "--compile", `--target=${target}`, entry, "--outfile", out], KIT);
    return out;
  });
  if (outputs.length === 1) {
    renameSync(outputs[0]!, join(dir, targets[0]!.includes("windows") ? `${HELPER}.exe` : HELPER));
    return;
  }
  if (!targets.every((target) => target.startsWith("bun-darwin-"))) {
    throw new Error("studio-desktop: several HELPER_TARGETS are only supported for macOS (they are joined with lipo)");
  }
  run(["lipo", "-create", "-output", join(dir, HELPER), ...outputs], KIT);
  for (const out of outputs) rmSync(out, { force: true });
}

if (!existsSync(join(KIT, "vendor", "pocketjs", "hosts", "web", "pocketjs.wasm"))) {
  throw new Error("studio-desktop: the PocketJS wasm core is missing; run `bun run build:wasm` at the kit root first");
}

rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

// The play-test player and its shared files. tools/web.ts also builds the
// web Studio and a landing page; Studio is rebuilt for the desktop below and
// the landing page is not needed.
run(["bun", "tools/web.ts", "--outdir", SITE, "preview"], KIT);
for (const name of ["index.html", "games.json", "preview-demo.html"]) rmSync(join(SITE, name), { force: true });

const studio = await buildStudio({
  outdir: SITE,
  kitRoot: KIT,
  entry: join(KIT, "editor", "studio", "main-desktop.ts"),
  boot: { html: desktopBootTag(), files: { [DESKTOP_BOOT_FILE]: desktopBootScript() } },
});

await bundleNode(join(HERE, "src", "main.ts"), join(APP, "main.cjs"));
await bundleNode(join(HERE, "src", "preload.ts"), join(APP, "preload.cjs"));

const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as Record<string, string>;
writeFileSync(join(APP, "package.json"), `${JSON.stringify({
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: "main.cjs",
}, null, 2)}\n`);

buildHelper();
console.log(`studio-desktop: app/ ready (Studio ${studio.files.length} files, main, preload, helper)`);
