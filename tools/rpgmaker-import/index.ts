// tools/rpgmaker-import/index.ts — RPG Maker MV/MZ project importer.
//
//   bun tools/rpgmaker-import <project-dir> --out <dir> [--shard] [--placeholders visible|silent]
//
// Reads <project-dir>/data/*.json (and img/ for art) and writes into <dir>:
//
//   project.json        rpgkit-project/v1 (inline; with --shard a
//                       ProjectShell plus maps/<id>.json entries)
//   tiles/ts<N>.png     generated 16 px tile sheets, one per RM tileset
//   sprites/*.png       character blocks and tile-image events
//   pictures/*.png      pictures used by Show Picture (copied verbatim)
//   audio/*.qoa         referenced BGM/BGS/ME/SE converted from Ogg/M4A
//   system/balloon.png  the balloon sheet, when Show Balloon Icon is used
//   assets.json         the render manifest a cooker bakes (ImportAssets)
//   battle.json         normalized data for the opt-in RPG Maker battle module
//   coverage.md/.json   per-construct dispositions and the full MV/MZ
//                       command table
//
// The output is byte-stable: importing the same project twice writes the
// same bytes. Nothing here is imported by the runtime.

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { splitProjectMaps } from "../lib/map-project.ts";
import { slug } from "./ids.ts";
import { loadRmProject } from "./load.ts";
import { writePngBytes } from "./png.ts";
import { importRmProject, type ImportOptions, type ImportResult } from "./project.ts";
import { coverageMarkdown } from "./report.ts";

export { importRmProject, loadRmProject };

export interface WriteOptions extends ImportOptions {
  shard?: boolean;
}

/** Import `projectDir` and write every output file into `outDir`. */
export async function importToDirectory(projectDir: string, outDir: string, options: WriteOptions = {}): Promise<ImportResult> {
  const rm = loadRmProject(projectDir);
  const result = await importRmProject(rm, options);
  const out = resolve(outDir);
  const write = (rel: string, bytes: Uint8Array | string): void => {
    const path = join(out, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  if (options.shard) {
    const split = splitProjectMaps(result.project, { entryEncoding: "json" });
    for (const file of split.files) write(file.path, file.bytes);
  } else {
    write("project.json", JSON.stringify(result.project, null, 2) + "\n");
  }
  write("battle.json", JSON.stringify(result.battle, null, 2) + "\n");
  for (const [rel, img] of [...result.images.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    write(rel, writePngBytes(img));
  }
  for (const [rel, bytes] of [...result.audioFiles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    write(rel, bytes);
  }
  for (const [variant, rel] of Object.entries(result.assets.pictures)) {
    // Pictures keep their source file (the screen layer scales them).
    const src = findPicture(rm.root, variant);
    if (src) {
      mkdirSync(dirname(join(out, rel)), { recursive: true });
      copyFileSync(src, join(out, rel));
    } else {
      result.warnings.push(`picture ${variant}: img/pictures file not found`);
    }
  }
  write("assets.json", JSON.stringify(result.assets, null, 2) + "\n");
  write("audio-media.json", JSON.stringify(result.audioMedia.map((record) => {
    if (record.status !== "success") return record;
    const { qoaBytes: _, ...facts } = record;
    return facts;
  }), null, 2) + "\n");
  write("coverage.json", JSON.stringify(result.cov.toJSON(), null, 2) + "\n");
  write("coverage.md", coverageMarkdown(`${result.project.title}: RPG Maker import coverage`, result.cov, {
    staticTable: true,
    audioMedia: result.audioMedia,
  }));
  return result;
}

/** Pictures are registered by slug; find the source file case-insensitively. */
function findPicture(root: string, variant: string): string | null {
  const dir = join(root, "img", "pictures");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith(".png")) continue;
    if (slug(f.slice(0, -4)) === variant) return join(dir, f);
  }
  return null;
}

function usage(): never {
  console.error("usage: bun tools/rpgmaker-import <project-dir> --out <dir> [--shard] [--placeholders visible|silent]");
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let projectDir: string | undefined;
  let outDir: string | undefined;
  const options: WriteOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") outDir = args[++i];
    else if (a === "--shard") options.shard = true;
    else if (a === "--placeholders") {
      const v = args[++i];
      if (v !== "visible" && v !== "silent") usage();
      options.placeholders = v;
    } else if (a.startsWith("--")) usage();
    else if (!projectDir) projectDir = a;
    else usage();
  }
  if (!projectDir || !outDir) usage();
  const result = await importToDirectory(projectDir, outDir, options);
  const t = result.cov.totals("command");
  console.log(
    `rpgmaker-import: ${result.project.maps.length} maps, ${result.project.sheets.length} tile sheets, ` +
      `${Object.keys(result.assets.sprites).length} sprites; commands ${t.total}: ` +
      `${t.Native} native, ${t.Degraded} degraded, ${t.Placeholder} placeholder, ${t.Dropped} dropped -> ${outDir}`,
  );
  for (const w of result.warnings) console.warn(`warning: ${w}`);
}
