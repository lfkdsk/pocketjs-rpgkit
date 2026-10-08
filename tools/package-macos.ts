// tools/package-macos.ts — package an app as a double-clickable macOS .app.
//
//   bun tools/package-macos.ts sunstone                  # examples/sunstone
//   bun tools/package-macos.ts --project-root ../my-game # a game that vendors this kit
//   bun tools/package-macos.ts grow --name Grow --icon shot.png --icon-crop 8,56,128,128
//
// The bundle is the PocketJS desktop host plus the app's bundle and pak:
//
//   dist/macos/<Name>.app/Contents/Info.plist
//                         Contents/MacOS/<app>                launcher (CFBundleExecutable)
//                         Contents/MacOS/pocket-desktop-host  release host from vendor/pocketjs
//                         Contents/Resources/<app>.js, <app>.pak, AppIcon.icns, licenses
//   dist/macos/<Name>-macos-<arch>.zip
//
// The launcher starts the host with the same plan-derived flags as
// tools/desktop.ts, pointing --js/--pak into the bundle, so saves still land
// in the per-app data.fs root keyed by the app id. The host is built for the
// machine's own architecture. The bundle is ad-hoc signed, not notarized: a
// downloaded copy needs right-click > Open (or System Settings > Privacy &
// Security > Open Anyway) the first time.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tools/png.ts";
import { appDirOf, fontLicenseFiles } from "./lib/font-licenses.ts";

if (process.platform !== "darwin") {
  console.error("package-macos: run this on a Mac (the host is built for the local architecture)");
  process.exit(2);
}

const kit = resolve(import.meta.dir, "..");
const pocketjs = join(kit, "vendor", "pocketjs");

// --- arguments ----------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`package-macos: ${flag} needs a value`);
  args.splice(i, 2);
  return v;
};
const projectRoot = opt("--project-root");
let name = opt("--name");
let icon = opt("--icon");
let iconCrop = opt("--icon-crop");
const example = args.find((a) => !a.startsWith("--"));

// Kit examples: a short bundle name and an icon cropped from a pixel golden.
const EXAMPLE_DEFAULTS: Record<string, { name: string; icon?: string; crop?: string }> = {
  sunstone: { name: "Sunstone", icon: "tests/goldens/sunstone-game.40.png", crop: "224,96,48,48" },
  grow: { name: "Grow", icon: "tests/goldens/grow.2028.png", crop: "8,56,128,128" },
  meadow: { name: "Meadow" },
};

let root: string;
let manifestPath: string;
let licenses: [string, string][]; // [source, name inside Resources]
if (projectRoot) {
  root = resolve(projectRoot);
  manifestPath = join(root, "pocket.json");
  licenses = [["LICENSE", "LICENSE"], ["ATTRIBUTION.md", "ATTRIBUTION.md"]]
    .map(([src, dst]) => [join(root, src!), dst!] as [string, string])
    .filter(([src]) => existsSync(src));
} else {
  const ex = example ?? "sunstone";
  // Imported only here: a game that vendors an older kit may pin a
  // build-example.ts that builds on import.
  const { EXAMPLES } = await import("./build-example.ts");
  if (!(EXAMPLES as readonly string[]).includes(ex)) {
    throw new Error(`package-macos: unknown example "${ex}" (have: ${EXAMPLES.join(", ")})`);
  }
  root = kit;
  manifestPath = join(kit, "examples", ex, "pocket.json");
  licenses = [[join(kit, "LICENSE"), "LICENSE"], [join(kit, "examples", ex, "ATTRIBUTION.md"), "ATTRIBUTION.md"]];
  const d = EXAMPLE_DEFAULTS[ex]!;
  name ??= d.name;
  if (!icon && d.icon) { icon = join(kit, d.icon); iconCrop ??= d.crop; }
}
licenses.push([join(pocketjs, "LICENSE"), "PocketJS-LICENSE"]);

// --- plan, bundle, host -------------------------------------------------------------

const target = "macos-app";
const manifest = await Bun.file(manifestPath).json();
const resolution = validateAndResolveBuildPlan(manifest, { target });
if (!resolution.ok) {
  throw new Error(
    `package-macos: ${manifestPath} did not resolve against ${target}: ` +
      resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; "),
  );
}
const plan = resolution.plan;
const app = plan.app.output;
// Glyphs baked from a fallback font are a derivative of it: its license
// ships in Resources (the pak carries it too, through pak.json).
for (const file of fontLicenseFiles(appDirOf(root, plan.app.entry))) licenses.push([file, basename(file)]);
// "Pocket RPG Kit — The Sunstone of Bramble Hollow" -> "The Sunstone of Bramble Hollow"
name ??= plan.app.title.split(" — ").pop()!;
const version: string = manifest.version ?? "0.0.0";

const outdir = join(root, "dist", target);
mkdirSync(outdir, { recursive: true });
const planPath = join(root, ".pocket", target, `${app}.plan.json`);
mkdirSync(resolve(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");
await $`bun ${join(pocketjs, "tools", "build.ts")} --plan=${planPath} --project-root=${root} --outdir=${outdir}`.cwd(root);
await $`cargo build --release`.cwd(join(pocketjs, "hosts", "desktop"));
const host = join(pocketjs, "hosts", "desktop", "target", "release", "pocket-desktop-host");

// --- the .app ------------------------------------------------------------------------

const dist = join(root, "dist", "macos");
const bundle = join(dist, `${name}.app`);
rmSync(bundle, { recursive: true, force: true });
const contents = join(bundle, "Contents");
const macos = join(contents, "MacOS");
const res = join(contents, "Resources");
mkdirSync(macos, { recursive: true });
mkdirSync(res, { recursive: true });

cpSync(host, join(macos, "pocket-desktop-host"));
cpSync(join(outdir, `${app}.js`), join(res, `${app}.js`));
cpSync(join(outdir, `${app}.pak`), join(res, `${app}.pak`));
for (const [src, dst] of licenses) cpSync(src, join(res, dst));

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const flags = [
  "--app", app,
  "--app-id", plan.app.id,
  "--title", plan.app.title,
  "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density", String(plan.viewport.rasterDensity),
  ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
  ...(plan.companions.length > 0 ? ["--companions", plan.companions.join(",")] : []),
];
const launcher = join(macos, app);
writeFileSync(
  launcher,
  `#!/bin/sh
# ${name}: start the PocketJS desktop host on this bundle's ${app}.js/.pak.
here=$(cd "$(dirname "$0")" && pwd)
res="$here/../Resources"
exec "$here/pocket-desktop-host" ${flags.map(sh).join(" ")} \\
  --js "$res/${app}.js" --pak "$res/${app}.pak" "$@"
`,
);
chmodSync(launcher, 0o755);

const hasIcon = icon !== undefined;
if (hasIcon) writeIcns(icon!, iconCrop, join(res, "AppIcon.icns"));

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plist: Record<string, string | boolean> = {
  CFBundleDevelopmentRegion: "en",
  CFBundleDisplayName: plan.app.title,
  CFBundleExecutable: app,
  CFBundleIdentifier: plan.app.id,
  CFBundleInfoDictionaryVersion: "6.0",
  CFBundleName: name,
  CFBundlePackageType: "APPL",
  CFBundleShortVersionString: version,
  CFBundleVersion: version,
  ...(hasIcon ? { CFBundleIconFile: "AppIcon" } : {}),
  LSApplicationCategoryType: "public.app-category.role-playing-games",
  LSMinimumSystemVersion: "12.0",
  NSHighResolutionCapable: true,
};
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(plist)
  .map(([k, v]) => `  <key>${k}</key>\n  ${typeof v === "boolean" ? `<${v}/>` : `<string>${xml(v)}</string>`}`)
  .join("\n")}
</dict>
</plist>
`,
);

await $`codesign --force --deep --sign - ${bundle}`.quiet();
await $`codesign --verify --deep --strict ${bundle}`;
const arch = (await $`uname -m`.text()).trim();
const zip = join(dist, `${name.replace(/\s+/g, "-")}-macos-${arch}.zip`);
rmSync(zip, { force: true });
await $`ditto -c -k --sequesterRsrc --keepParent ${bundle} ${zip}`;
console.log(`package-macos: ${bundle}\npackage-macos: ${zip}`);

// --- icon: a pixel-art crop, scaled without smoothing, on a rounded tile -------------

function writeIcns(png: string, crop: string | undefined, out: string): void {
  const img = decodePng(new Uint8Array(readFileSync(png)));
  const [cx, cy, cw, ch] = crop
    ? crop.split(",").map(Number)
    : (() => { const s = Math.min(img.width, img.height); return [(img.width - s) >> 1, (img.height - s) >> 1, s, s]; })();
  const set = join(dist, `${name}.iconset`);
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  // The ten names iconutil expects, by pixel size.
  const names: Record<number, string[]> = {
    16: ["icon_16x16.png"],
    32: ["icon_16x16@2x.png", "icon_32x32.png"],
    64: ["icon_32x32@2x.png"],
    128: ["icon_128x128.png"],
    256: ["icon_128x128@2x.png", "icon_256x256.png"],
    512: ["icon_256x256@2x.png", "icon_512x512.png"],
    1024: ["icon_512x512@2x.png"],
  };
  for (const [size, files] of Object.entries(names).map(([s, f]) => [Number(s), f] as const)) {
    const tile = encodePNG(iconTile(img, cx!, cy!, cw!, ch!, size), size, size);
    for (const f of files) writeFileSync(join(set, f), tile);
  }
  Bun.spawnSync(["iconutil", "-c", "icns", set, "-o", out], { stdout: "inherit", stderr: "inherit" });
  rmSync(set, { recursive: true, force: true });
  if (!existsSync(out)) throw new Error("package-macos: iconutil produced no .icns");
}

/** The crop scaled to fill a macOS-style rounded tile (824/1024 body, radius
 *  185/1024), nearest-neighbour when enlarging, box-averaged when shrinking. */
function iconTile(
  img: { width: number; height: number; rgba: Uint8Array },
  cx: number, cy: number, cw: number, ch: number, size: number,
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const inset = Math.round((size * 100) / 1024);
  const body = size - inset * 2;
  const radius = (body * 185) / 824;
  for (let y = 0; y < body; y++) {
    for (let x = 0; x < body; x++) {
      // source footprint of this output pixel
      const sx0 = cx + (x * cw) / body, sx1 = cx + ((x + 1) * cw) / body;
      const sy0 = cy + (y * ch) / body, sy1 = cy + ((y + 1) * ch) / body;
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.rgba[i]!; g += img.rgba[i + 1]!; b += img.rgba[i + 2]!; n++;
        }
      }
      // rounded-corner coverage, 4x4 supersampled
      let cover = 0;
      for (let k = 0; k < 16; k++) {
        const px = x + ((k & 3) + 0.5) / 4, py = y + ((k >> 2) + 0.5) / 4;
        const qx = Math.max(radius - px, px - (body - radius), 0);
        const qy = Math.max(radius - py, py - (body - radius), 0);
        if (qx * qx + qy * qy <= radius * radius) cover++;
      }
      const o = ((y + inset) * size + x + inset) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round((cover / 16) * 255);
    }
  }
  return out;
}
