// tools/cjk-font.ts — give one language app a regional CJK fallback font
// holding only the characters its text uses.
//
//   bun tools/cjk-font.ts --app=examples/foo
//   bun tools/cjk-font.ts --app=examples/foo --variant=jp
//   bun tools/cjk-font.ts --app=examples/foo --scan=project.json --scan=strings.po --chars=“”
//   bun tools/cjk-font.ts --app=examples/foo --scan=project.json --check
//
// The text is the app's decoded display strings (tools/lib/text-inventory.ts):
//
// - the string literals, template chunks and JSX text of every module the
//   app entry imports, transitively (the app, the kit's fixed UI strings,
//   the framework), with escapes such as "\u{20BB7}" decoded. The entry is
//   `app.entry` of <app>/pocket.json (resolved from the working directory),
//   or each --entry=<file>; --no-entry skips the module scan;
// - every --scan file: a module is read the same way, a .json document by
//   its parsed keys and string values, any other file as text (with
//   \uXXXX escapes also decoded);
// - --chars.
//
// The characters Inter does not map are subset from the selected pinned
// regional Noto Sans CJK source (SC by default; TC, JP and KR are opt-in;
// downloaded once, SHA-256 verified, cached in .cache/fonts/ or
// $RPGKIT_FONT_CACHE; --source=<otf> subsets a local font file instead) into
// <app>/fonts/NotoSansCJKsc-subset.otf, listed in <app>/fonts/cjk-charset.txt,
// and wired into the build by <app>/fonts.json and <app>/pak.json (the
// license travels inside the app's pak). tools/lib/cjk-font.ts holds the
// implementation.
//
// --check reads only the committed files (no network) and exits 1 when the
// subset or charset does not cover the text.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CJK_FONT_VARIANTS,
  DEFAULT_CJK_FONT_VARIANT,
  checkAppCjkFont,
  cjkAppFontFiles,
  fallbackCharacters,
  writeAppCjkFont,
  type CjkFontVariant,
} from "./lib/cjk-font.ts";
import { appTextInventory } from "./lib/text-inventory.ts";

const args = process.argv.slice(2);
let app: string | undefined;
const scans: string[] = [];
const entries: string[] = [];
let chars = "";
let check = false;
let scanEntry = true;
let source: string | undefined;
let variant: CjkFontVariant = DEFAULT_CJK_FONT_VARIANT;
for (const arg of args) {
  if (arg.startsWith("--app=")) app = arg.slice("--app=".length);
  else if (arg.startsWith("--scan=")) scans.push(arg.slice("--scan=".length));
  else if (arg.startsWith("--entry=")) entries.push(arg.slice("--entry=".length));
  else if (arg.startsWith("--chars=")) chars += arg.slice("--chars=".length);
  else if (arg.startsWith("--source=")) source = resolve(arg.slice("--source=".length));
  else if (arg.startsWith("--variant=")) {
    const value = arg.slice("--variant=".length);
    if (!(CJK_FONT_VARIANTS as readonly string[]).includes(value)) {
      console.error(`cjk-font: unknown variant ${JSON.stringify(value)} (expected ${CJK_FONT_VARIANTS.join("|")})`);
      process.exit(2);
    }
    variant = value as CjkFontVariant;
  }
  else if (arg === "--no-entry") scanEntry = false;
  else if (arg === "--check") check = true;
  else {
    console.error(`cjk-font: unknown argument ${arg}`);
    process.exit(2);
  }
}
if (!app) {
  console.error(
    "usage: bun tools/cjk-font.ts --app=<appDir> [--entry=<file>...] [--no-entry] [--scan=<file>...] [--chars=<str>] [--variant=sc|tc|jp|kr] [--source=<otf>] [--check]",
  );
  process.exit(2);
}

const appDir = resolve(app);
if (scanEntry && entries.length === 0) {
  const manifest = join(appDir, "pocket.json");
  const entry = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8"))?.app?.entry : undefined;
  if (typeof entry !== "string" || !existsSync(resolve(entry))) {
    console.error(`cjk-font: no app entry found (${manifest} app.entry, resolved from the working directory); pass --entry=<file> or --no-entry`);
    process.exit(2);
  }
  entries.push(entry);
}
const texts = appTextInventory({ entries: scanEntry ? entries : [], files: scans, chars });

if (check) {
  const problems = checkAppCjkFont(appDir, texts, variant);
  if (problems.length) {
    for (const problem of problems) console.error(`cjk-font: ${problem}`);
    process.exit(1);
  }
  console.log(`cjk-font: ${fallbackCharacters(texts).length} fallback character(s) covered`);
} else {
  const started = performance.now();
  const { characters, fontBytes } = await writeAppCjkFont({ appDir, texts, source, variant });
  const ms = Math.round(performance.now() - started);
  if (characters === 0) console.log("cjk-font: the text needs no fallback characters; nothing written");
  else {
    const files = cjkAppFontFiles(variant);
    console.log(
      `cjk-font: ${characters} character(s), fonts/${files.font} ${fontBytes} bytes ` +
        `(${(fontBytes / characters).toFixed(1)} bytes/char), ${ms} ms`,
    );
  }
}
