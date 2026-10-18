// tools/lib/cjk-font.ts — per-language-app regional CJK fallback font.
//
// PocketJS bakes text from Inter. A codepoint Inter does not map comes from
// the fallback faces an app lists in its `fonts.json` (vendor/pocketjs/
// framework/compiler/font-config.ts). This module derives that fallback from
// one pinned regional Noto Sans CJK source: it collects the characters an
// app's text needs that Inter lacks, subsets the source down to exactly those
// glyphs, and writes the subset, its charset file, the license notice
// (copyright line + OFL), a provenance note, the `fonts.json` that wires them
// into the build and a `pak.json` row that ships the notice inside the pak.
//
// The subset keeps every glyph's ORIGINAL advance width and outline at the
// source unitsPerEm, and the source ascender/descender, so the baked atlas
// advances equal the ones the full source font would produce.
// (vendor/pocketjs/tools/font-subset.ts normalises advances to ink width,
// which suits icon fonts and is wrong for running text.)
//
// The source download is cached in `.cache/fonts/` at the repository root,
// or in the directory named by RPGKIT_FONT_CACHE, and verified by size and
// SHA-256 on every use.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../..");

/** opentype.js is installed only under the vendored PocketJS. */
export const opentype: any = createRequire(join(REPO_ROOT, "vendor/pocketjs/package.json"))("opentype.js");

export type CjkFontVariant = "sc" | "tc" | "jp" | "kr";

export const CJK_FONT_VARIANTS = ["sc", "tc", "jp", "kr"] as const satisfies readonly CjkFontVariant[];
export const DEFAULT_CJK_FONT_VARIANT: CjkFontVariant = "sc";

const NOTO_CJK_REVISION = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const NOTO_CJK_RAW = `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_CJK_REVISION}/Sans/OTF`;

export interface CjkFontSource {
  readonly url: string;
  readonly revision: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly file: string;
  readonly directory: "SimplifiedChinese" | "TraditionalChinese" | "Japanese" | "Korean";
  readonly family: string;
  readonly suffix: CjkFontVariant;
}

/** Regional faces from one immutable noto-cjk revision. Each download is
 * checked by both length and SHA-256 before it can enter the cache. */
export const CJK_FONT_SOURCES: Readonly<Record<CjkFontVariant, CjkFontSource>> = {
  sc: {
    url: `${NOTO_CJK_RAW}/SimplifiedChinese/NotoSansCJKsc-Regular.otf`,
    revision: NOTO_CJK_REVISION,
    sha256: "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
    bytes: 16437364,
    file: "NotoSansCJKsc-Regular.otf",
    directory: "SimplifiedChinese",
    family: "Noto Sans CJK SC",
    suffix: "sc",
  },
  tc: {
    url: `${NOTO_CJK_RAW}/TraditionalChinese/NotoSansCJKtc-Regular.otf`,
    revision: NOTO_CJK_REVISION,
    sha256: "dce08bd4fd91aa8aa76ed8fea4b694c2dfb8550f67871e326843212ddbeb88b4",
    bytes: 16435884,
    file: "NotoSansCJKtc-Regular.otf",
    directory: "TraditionalChinese",
    family: "Noto Sans CJK TC",
    suffix: "tc",
  },
  jp: {
    url: `${NOTO_CJK_RAW}/Japanese/NotoSansCJKjp-Regular.otf`,
    revision: NOTO_CJK_REVISION,
    sha256: "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5",
    bytes: 16467736,
    file: "NotoSansCJKjp-Regular.otf",
    directory: "Japanese",
    family: "Noto Sans CJK JP",
    suffix: "jp",
  },
  kr: {
    url: `${NOTO_CJK_RAW}/Korean/NotoSansCJKkr-Regular.otf`,
    revision: NOTO_CJK_REVISION,
    sha256: "6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a",
    bytes: 16433112,
    file: "NotoSansCJKkr-Regular.otf",
    directory: "Korean",
    family: "Noto Sans CJK KR",
    suffix: "kr",
  },
};

/** Backward-compatible name for the original Simplified Chinese source. */
export const CJK_FONT_SOURCE = CJK_FONT_SOURCES.sc;

export interface CjkAppFontFiles {
  readonly font: string;
  readonly charset: string;
  readonly license: string;
  readonly provenance: string;
  readonly subsetFamily: string;
}

export function cjkAppFontFiles(variant: CjkFontVariant = DEFAULT_CJK_FONT_VARIANT): CjkAppFontFiles {
  const upper = variant.toUpperCase();
  return {
    font: `NotoSansCJK${variant}-subset.otf`,
    charset: "cjk-charset.txt",
    license: "LICENSE-NotoSansCJK.txt",
    provenance: `NotoSansCJK${variant}-subset.md`,
    subsetFamily: `Noto Sans CJK ${upper} Subset`,
  };
}

/** Files written into `<appDir>/fonts/` and referenced from `<appDir>/fonts.json`. */
export const APP_FONT_FILE = cjkAppFontFiles().font;
export const APP_CHARSET_FILE = cjkAppFontFiles().charset;
export const APP_LICENSE_FILE = cjkAppFontFiles().license;
export const APP_PROVENANCE_FILE = cjkAppFontFiles().provenance;
export const SUBSET_FAMILY = cjkAppFontFiles().subsetFamily;
/** Pak entry that carries the license notice inside every build of the app
 *  (web, desktop and PSP all embed or load the same pak). */
export const LICENSE_PAK_KEY = "license:NotoSansCJK.txt";
/** Heading line of the OFL text; a notice without it is not the license. */
export const OFL_TITLE = "SIL OPEN FONT LICENSE Version 1.1";

/** `head.created` / `head.modified` of every subset, in Unix seconds
 *  (2024-01-01T00:00:00Z). A fixed stamp keeps the output byte-identical
 *  across runs. */
export const SUBSET_TIMESTAMP = 1704067200;

const INTER_REGULAR = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/Inter-Regular.ttf");
const INTER_BOLD = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/Inter-Bold.ttf");
const LICENSE_SOURCE = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/LICENSE-NotoSansCJK.txt");

// ---------------------------------------------------------------------------
// Font loading
// ---------------------------------------------------------------------------

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function parseFontFile(path: string): any {
  return opentype.parse(arrayBufferOf(readFileSync(path)));
}

let interFaces: any[] | null = null;
/** Inter Regular and Bold, parsed once on first use. */
function inter(): any[] {
  interFaces ??= [parseFontFile(INTER_REGULAR), parseFontFile(INTER_BOLD)];
  return interFaces;
}

// ---------------------------------------------------------------------------
// Source download
// ---------------------------------------------------------------------------

export function fontCacheDir(): string {
  return process.env.RPGKIT_FONT_CACHE || join(REPO_ROOT, ".cache/fonts");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verified(bytes: Uint8Array, source: CjkFontSource): boolean {
  return bytes.length === source.bytes && sha256(bytes) === source.sha256;
}

/** Path of the cached, checksum-verified source font. Downloads it when the
 *  cache has no valid copy. */
export async function cjkSourceFont(variant: CjkFontVariant = DEFAULT_CJK_FONT_VARIANT): Promise<string> {
  const source = CJK_FONT_SOURCES[variant];
  const dir = fontCacheDir();
  const path = join(dir, source.file);
  if (existsSync(path) && verified(readFileSync(path), source)) return path;
  let bytes: Uint8Array;
  try {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `cjk-font: could not download ${source.url} (${(error as Error).message}). ` +
        `Download it by hand and place it at ${path}, or point RPGKIT_FONT_CACHE at a directory holding ${source.file}.`,
    );
  }
  if (!verified(bytes, source)) {
    throw new Error(
      `cjk-font: ${source.url} returned ${bytes.length} bytes with SHA-256 ${sha256(bytes)}; ` +
        `expected ${source.bytes} bytes with SHA-256 ${source.sha256}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  const partial = `${path}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
  return path;
}

// ---------------------------------------------------------------------------
// Character selection
// ---------------------------------------------------------------------------

function isTextCodepoint(cp: number): boolean {
  if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) return false; // C0, DEL, C1 controls
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // lone surrogates
  return cp !== 0xfffd; // the atlas maps U+FFFD to the tofu glyph
}

/** Sorted unique codepoints in `texts` that Inter Regular or Inter Bold does
 *  not map, so a baked atlas takes them from the fallback face. (The two
 *  Inter faces ship identical cmaps; a codepoint missing from either one
 *  counts, since that slot would need the fallback.) */
export function fallbackCharacters(texts: Iterable<string>): number[] {
  const faces = inter();
  const out = new Set<number>();
  const seen = new Set<number>();
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (seen.has(cp)) continue;
      seen.add(cp);
      if (!isTextCodepoint(cp)) continue;
      if (faces.some(face => face.charToGlyphIndex(ch) <= 0)) out.add(cp);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Subsetting
// ---------------------------------------------------------------------------

function glyphName(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  return cp <= 0xffff ? `uni${hex.padStart(4, "0")}` : `u${hex.padStart(5, "0")}`;
}

function copyGlyph(source: any, name: string, unicode: number | undefined): any {
  const path = new opentype.Path();
  for (const cmd of source.path.commands) path.commands.push({ ...cmd });
  return new opentype.Glyph({
    name,
    ...(unicode === undefined ? {} : { unicode }),
    advanceWidth: source.advanceWidth ?? 0,
    leftSideBearing: source.leftSideBearing ?? 0,
    path,
  });
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value >>> 24;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}

function checksum(bytes: Uint8Array, from: number, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 4) {
    let word = 0;
    for (let k = 0; k < 4; k++) word = word * 256 + (i + k < length ? bytes[from + i + k]! : 0);
    sum = (sum + word) % 0x100000000;
  }
  return sum;
}

/** opentype.js writes `head.modified` from the wall clock (only `created` is
 *  an option). Overwrite it with `created`, then recompute the head table
 *  checksum and the whole-font checkSumAdjustment. */
function stampHead(bytes: Uint8Array): void {
  const numTables = (bytes[4]! << 8) | bytes[5]!;
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (tag !== "head") continue;
    const offset = readU32(bytes, record + 8);
    const length = readU32(bytes, record + 12);
    bytes.copyWithin(offset + 28, offset + 20, offset + 28); // modified := created
    writeU32(bytes, offset + 8, 0); // checkSumAdjustment is excluded from both sums
    writeU32(bytes, record + 4, checksum(bytes, offset, length));
    writeU32(bytes, offset + 8, (0xb1b0afba - checksum(bytes, 0, bytes.length) + 0x100000000) % 0x100000000);
    return;
  }
  throw new Error("cjk-font: subset has no head table");
}

/** CFF OpenType subset of `sourcePath` holding `.notdef` plus one glyph per
 *  codepoint the source maps, each with its source advance and outline.
 *  `missing` lists the requested codepoints the source does not map. The
 *  bytes are deterministic for a given source and codepoint set. */
export function subsetFont(
  sourcePath: string,
  codepoints: number[],
  family: string = SUBSET_FAMILY,
): { bytes: Uint8Array; missing: number[] } {
  const source = parseFontFile(sourcePath);
  const glyphs = [copyGlyph(source.glyphs.get(0), ".notdef", undefined)];
  const missing: number[] = [];
  for (const cp of [...new Set(codepoints)].sort((a, b) => a - b)) {
    const gid = source.charToGlyphIndex(String.fromCodePoint(cp));
    if (gid <= 0) {
      missing.push(cp);
      continue;
    }
    glyphs.push(copyGlyph(source.glyphs.get(gid), glyphName(cp), cp));
  }
  const english = (key: string): string | undefined => source.getEnglishName(key) || undefined;
  const font = new opentype.Font({
    familyName: family,
    styleName: "Regular",
    unitsPerEm: source.unitsPerEm,
    ascender: source.ascender,
    descender: source.descender,
    weightClass: 400,
    copyright: english("copyright"),
    license: english("license"),
    licenseURL: english("licenseURL"),
    manufacturer: english("manufacturer"),
    designer: english("designer"),
    version: english("version"),
    description: `Subset of ${english("fullName") ?? "Noto Sans CJK SC"} for ${/^Noto Sans CJK (?:SC|TC|JP|KR) Subset$/.test(family) ? "one app's text" : family}`,
    createdTimestamp: SUBSET_TIMESTAMP,
    glyphs,
  });
  const bytes = new Uint8Array(font.toArrayBuffer());
  stampHead(bytes);
  return { bytes, missing };
}

// ---------------------------------------------------------------------------
// App integration
// ---------------------------------------------------------------------------

function charsOf(codepoints: number[]): string {
  return codepoints.map(cp => String.fromCodePoint(cp)).join("");
}

function describe(codepoints: number[]): string {
  const shown = codepoints.slice(0, 40).map(cp => `${String.fromCodePoint(cp)} (U+${cp.toString(16).toUpperCase().padStart(4, "0")})`);
  return shown.join(", ") + (codepoints.length > shown.length ? `, ... ${codepoints.length - shown.length} more` : "");
}

/** The notice shipped with the subset: what it is, where it comes from, the
 *  source font's copyright line (from its name table), then the OFL text as
 *  noto-cjk publishes it. */
export function licenseNotice(
  copyright: string,
  variant: CjkFontVariant = DEFAULT_CJK_FONT_VARIANT,
): string {
  const source = CJK_FONT_SOURCES[variant];
  const files = cjkAppFontFiles(variant);
  return (
    `${files.subsetFamily}: a subset (a Modified Version under the license below) of ${source.family},\n` +
    `from https://github.com/notofonts/noto-cjk at commit ${source.revision}.\n\n` +
    `Copyright notice: ${copyright}\n\n` +
    readFileSync(LICENSE_SOURCE, "utf8")
  );
}

/** `<appDir>/pak.json` rows with the license entry added (other rows kept,
 *  in order). `licensePath` is relative to `appDir`. */
export function pakManifestWithLicense(appDir: string, licensePath = `fonts/${APP_LICENSE_FILE}`): Array<{ key: string; file: string }> {
  const path = join(appDir, "pak.json");
  const rows: Array<{ key: string; file: string }> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const kept = rows.filter(row => row.key !== LICENSE_PAK_KEY);
  return [...kept, { key: LICENSE_PAK_KEY, file: licensePath }];
}

function fontsJson(variant: CjkFontVariant): { fallback: string[]; characterFiles: string[] } {
  const files = cjkAppFontFiles(variant);
  return {
    fallback: [`fonts/${files.font}`],
    characterFiles: [`fonts/${files.charset}`],
  };
}

function provenance(characters: number, fontBytes: number, variant: CjkFontVariant): string {
  const source = CJK_FONT_SOURCES[variant];
  const files = cjkAppFontFiles(variant);
  const textKind = variant === "sc" ? "Chinese" : variant === "tc" ? "Traditional Chinese" : variant === "jp" ? "Japanese" : "Korean";
  const flag = variant === DEFAULT_CJK_FONT_VARIANT ? "" : ` --variant=${variant}`;
  return `# ${source.family} subset

\`${files.font}\` is the fallback face for this app's ${textKind} text. The PocketJS build
reads \`../fonts.json\`, which lists this font as a fallback and \`${files.charset}\` as a
character file, so every listed character is baked into the app's font atlases from this face.

- Source: [${source.file}](https://github.com/notofonts/noto-cjk/blob/${source.revision}/Sans/OTF/${source.directory}/${source.file})
  at commit \`${source.revision}\`.
- Source SHA-256: \`${source.sha256}\` (${source.bytes} bytes).
- Characters: ${characters} (the characters of this app's text that Inter does not map).
- Subset size: ${fontBytes} bytes.

Each glyph keeps the source advance width and outline at the source units per em, and the
font keeps the source ascender and descender, so baked advances match the full font.
Hinting and OpenType layout tables are not carried over.

Regenerate after the app's text changes (the source font is downloaded once and cached):

\`\`\`sh
bun tools/cjk-font.ts --app=<app dir> [--scan=<project file> ...]${flag}
\`\`\`

Add \`--check\` to verify, without network access, that the committed subset covers the text.

The font is licensed under the SIL Open Font License 1.1; the copyright notice and the
license text are in \`${files.license}\`. \`../pak.json\` ships that file inside the app's pak
as \`${LICENSE_PAK_KEY}\`, and the web and desktop packaging tools copy it beside the build.
The subset is a Modified Version under that license and is renamed "${files.subsetFamily}".
`;
}

/** Write the app's fallback font files. With no fallback characters in
 *  `texts`, writes nothing and returns `characters: 0`. Throws when the
 *  source font cannot supply a character. */
export async function writeAppCjkFont(opts: {
  appDir: string;
  texts: string[];
  source?: string;
  variant?: CjkFontVariant;
}): Promise<{ characters: number; fontBytes: number }> {
  const variant = opts.variant ?? DEFAULT_CJK_FONT_VARIANT;
  const files = cjkAppFontFiles(variant);
  const codepoints = fallbackCharacters(opts.texts);
  if (codepoints.length === 0) return { characters: 0, fontBytes: 0 };
  const source = opts.source ?? (await cjkSourceFont(variant));
  const { bytes, missing } = subsetFont(source, codepoints, files.subsetFamily);
  if (missing.length) {
    throw new Error(`cjk-font: the source font does not map ${missing.length} character(s): ${describe(missing)}`);
  }
  const fontsDir = join(opts.appDir, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  writeFileSync(join(fontsDir, files.font), bytes);
  writeFileSync(join(fontsDir, files.charset), charsOf(codepoints));
  const copyright = parseFontFile(source).getEnglishName("copyright") || "see the license below";
  writeFileSync(join(fontsDir, files.license), licenseNotice(copyright, variant));
  writeFileSync(join(fontsDir, files.provenance), provenance(codepoints.length, bytes.length, variant));
  writeFileSync(join(opts.appDir, "fonts.json"), JSON.stringify(fontsJson(variant), null, 2) + "\n");
  writeFileSync(join(opts.appDir, "pak.json"), JSON.stringify(pakManifestWithLicense(opts.appDir), null, 2) + "\n");
  return { characters: codepoints.length, fontBytes: bytes.length };
}

/** Problems with the committed fallback font for `texts` (empty = covered).
 *  Reads only the app's files; no network. */
export function checkAppCjkFont(
  appDir: string,
  texts: string[],
  variant: CjkFontVariant = DEFAULT_CJK_FONT_VARIANT,
): string[] {
  const files = cjkAppFontFiles(variant);
  const expectedFonts = fontsJson(variant);
  const needed = fallbackCharacters(texts);
  if (needed.length === 0) return [];
  const problems: string[] = [];
  const manifestPath = join(appDir, "fonts.json");
  if (!existsSync(manifestPath)) {
    problems.push("fonts.json is missing");
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const lists = (key: string, entry: string) => Array.isArray(manifest?.[key]) && manifest[key].includes(entry);
      if (!lists("fallback", expectedFonts.fallback[0]!)) problems.push(`fonts.json does not list ${expectedFonts.fallback[0]} in "fallback"`);
      if (!lists("characterFiles", expectedFonts.characterFiles[0]!)) {
        problems.push(`fonts.json does not list ${expectedFonts.characterFiles[0]} in "characterFiles"`);
      }
    } catch (error) {
      problems.push(`fonts.json is not valid JSON: ${(error as Error).message}`);
    }
  }
  const licensePath = join(appDir, "fonts", files.license);
  if (!existsSync(licensePath)) {
    problems.push(`fonts/${files.license} is missing`);
  } else {
    const notice = readFileSync(licensePath, "utf8");
    if (!notice.includes(OFL_TITLE) || !notice.includes("Copyright notice: ") || !notice.includes(`${files.subsetFamily}:`)) {
      problems.push(`fonts/${files.license} lacks the ${variant.toUpperCase()} source, copyright notice or the OFL text`);
    }
  }
  const pakPath = join(appDir, "pak.json");
  let pakRows: Array<{ key: string; file: string }> = [];
  try {
    pakRows = existsSync(pakPath) ? JSON.parse(readFileSync(pakPath, "utf8")) : [];
  } catch (error) {
    problems.push(`pak.json is not valid JSON: ${(error as Error).message}`);
  }
  const licenseRow = Array.isArray(pakRows) ? pakRows.find(row => row?.key === LICENSE_PAK_KEY) : undefined;
  if (!licenseRow) problems.push(`pak.json does not ship the license (no "${LICENSE_PAK_KEY}" entry)`);
  else if (resolve(appDir, licenseRow.file) !== licensePath) {
    problems.push(`pak.json "${LICENSE_PAK_KEY}" points at ${licenseRow.file}, not fonts/${files.license}`);
  }
  const charsetPath = join(appDir, "fonts", files.charset);
  if (!existsSync(charsetPath)) {
    problems.push(`fonts/${files.charset} is missing`);
  } else {
    const listed = new Set<number>();
    for (const ch of readFileSync(charsetPath, "utf8")) listed.add(ch.codePointAt(0)!);
    const absent = needed.filter(cp => !listed.has(cp));
    if (absent.length) problems.push(`fonts/${files.charset} lacks ${absent.length} character(s): ${describe(absent)}`);
  }
  const fontPath = join(appDir, "fonts", files.font);
  if (!existsSync(fontPath)) {
    problems.push(`fonts/${files.font} is missing`);
  } else {
    let font;
    try {
      font = parseFontFile(fontPath);
    } catch (error) {
      problems.push(`fonts/${files.font} does not parse: ${(error as Error).message}`);
    }
    if (font) {
      if (font.getEnglishName("fontFamily") !== files.subsetFamily) {
        problems.push(`fonts/${files.font} is ${JSON.stringify(font.getEnglishName("fontFamily"))}, expected ${JSON.stringify(files.subsetFamily)}`);
      }
      const unmapped = needed.filter(cp => font.charToGlyphIndex(String.fromCodePoint(cp)) <= 0);
      if (unmapped.length) problems.push(`fonts/${files.font} does not map ${unmapped.length} character(s): ${describe(unmapped)}`);
    }
  }
  const flag = variant === DEFAULT_CJK_FONT_VARIANT ? "" : ` --variant=${variant}`;
  if (problems.length) problems.push(`regenerate with: bun tools/cjk-font.ts --app=<app dir> [--scan=<project file> ...]${flag}`);
  return problems;
}
