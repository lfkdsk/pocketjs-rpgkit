// tools/web.ts — build a static site that plays PocketJS apps in the
// browser: dist/web/index.html with one card per game, and one player page
// per game. Every URL is relative, so the site works from any subpath
// (GitHub Pages serves this repository at /pocket-rpgkit/), and nothing is
// loaded from a CDN or a dev server.
//
//   bun tools/web.ts                  # every app in APPS (examples + editor)
//   bun tools/web.ts grow meadow      # just these
//   bun tools/web.ts --outdir /srv/x  # somewhere other than dist/web
//
// A project that vendors this kit (pocket-alpine-post keeps it at
// vendor/pocket-rpgkit) builds its own game the same way:
//
//   bun vendor/pocket-rpgkit/tools/web.ts --project-root . alpine-post
//
// Without names, this repository builds APPS from
// tools/build-example.ts. Another project builds every
// examples/<name>/pocket.json it has, or else its own pocket.json. A name
// resolves to examples/<name>/pocket.json, <name>/pocket.json, or the
// project's pocket.json when its app.output (or name) matches.
//
// Per game, this resolves the game's pocket.json against the web-app target
// with the vendored manifest resolver, as tools/desktop.ts does for the
// desktop targets, and builds the bundle from that plan into
// <outdir>/<id>/. It then writes the player page and the AudioWorklet module
// next to the bundle. Shared by all games: pocketjs.wasm (the core
// `bun run build:wasm` builds into vendor/pocketjs/hosts/web), player.js
// (tools/web/player.js bundled for the browser), site.css, the landing page
// and games.json.
//
// Card text comes from the metadata table in <project-root>/web.json, keyed
// by game id: title, one-line description, preview image, controls, chapter
// links, and what the pointer does. Every field is optional. A game with no
// entry still
// gets a card: its pocket.json title, the GameView controls, and a preview
// rendered from its own bundle (tools/web/preview.ts). If that render
// fails, the card simply has no picture.
//
// Viewport: the page follows the resolved plan. A "fixed" app runs its
// logical viewport and the page scales it by a whole number of device
// pixels. A "dynamic" app (display.viewport.live) runs a live viewport sized
// to the page: the largest whole-number pixel scale that keeps the
// viewport at or above the manifest's minimum, resized as the window
// changes. A web.json entry may pin "viewport": "fixed" or "dynamic" when
// the manifest declares both.
//
// Keys: tools/web/keys.ts. An entry's "keys" rebinds keys for a game whose
// own prompts name other keys; the page's controls follow.
//
// Studio: a "studio" entry in web.json ({ title, description, preview? })
// also builds Studio, the browser-native editor, into <outdir>/studio
// (tools/studio-build.ts: static files, no wasm) and adds its landing card.
// Without the entry nothing of it is built.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import type { ResolvedBuildPlan } from "../vendor/pocketjs/framework/src/manifest/plan.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  POCKET_TARGETS,
  type PlatformContractRegistry,
} from "../vendor/pocketjs/contracts/spec/platforms.ts";
import { APPS } from "./build-example.ts";
import { appDirOf, fontLicenseFiles } from "./lib/font-licenses.ts";
import type { Size, ViewportConfig } from "./web/fit.ts";
import {
  BUTTON_GLYPHS,
  BUTTON_NAMES,
  isControlButton,
  keyMasks,
  keysFor,
  withKeys,
  type ButtonName,
  type ControlButton,
  type Keymap,
} from "./web/keys.ts";

/** This kit's checkout: tools/web/*, vendor/pocketjs. */
export const KIT_ROOT = resolve(import.meta.dir, "..");
const POCKETJS = join(KIT_ROOT, "vendor", "pocketjs");
export const WASM_PATH = join(POCKETJS, "hosts", "web", "pocketjs.wasm");
export const AUDIO_WORKLET_PATH = join(POCKETJS, "hosts", "web", "audio-worklet.js");
const TARGET = "web-app";
const PREVIEW_FRAMES = 60;
/** Two raster samples per logical pixel gives browser text a crisp native
 *  strike on ordinary HiDPI displays while keeping the wasm framebuffer and
 *  font-pak cost well below 3x. A web.json game may opt down to 1 or up to 4. */
export const DEFAULT_WEB_RASTER_DENSITY = 2;
export const MAX_WEB_RASTER_DENSITY = 4;

export interface WebControl {
  /** One button, or "DPAD" for all four directions. */
  button?: ControlButton;
  /** Several buttons that share one line ("← →"). */
  buttons?: ControlButton[];
  /** Literal browser/UI keys for tools that are not Pocket buttons. */
  keys?: string[];
  action: string;
}

export interface WebDocumentExample {
  /** Stable URL/file stem. */
  id: string;
  /** Label shown beside Open and Download. */
  title: string;
  /** rpgkit-project/v1 JSON, relative to the project root. */
  document: string;
}

export interface WebChapter {
  /** Stable id handed to the game as ?chapter=<id>. */
  id: string;
  title: string;
  /** Optional supporting text shown on the chapter card. */
  description?: string;
  /** Preview PNG, relative to the project root. */
  preview?: string;
  /** Whether this chapter has a tape that can start from the web player. */
  autoplay?: boolean;
}

export interface WebDocumentExample {
  /** Stable URL/file stem. */
  id: string;
  /** Label shown beside Open and Download. */
  title: string;
  /** rpgkit-project/v1 JSON, relative to the project root. */
  document: string;
}

/** One row of the metadata table. Every field is optional. */
export interface WebGameEntry {
  /** pocket.json, relative to the project root, when it is not found by id. */
  manifest?: string;
  title?: string;
  description?: string;
  /** Preview image (PNG), relative to the project root. */
  preview?: string;
  controls?: WebControl[];
  /** Named entry points into this game, shown as links on its card. */
  chapters?: WebChapter[];
  /** What the mouse or a finger does, if anything. */
  pointer?: string;
  /** Longer plain-text points shown only on the player page. */
  features?: string[];
  /** Put this local game's card before externally hosted showcase cards. */
  featured?: boolean;
  /** Pin the viewport policy when the manifest declares both. */
  viewport?: "fixed" | "dynamic";
  /** Raster samples per logical pixel for this web build (1..4). */
  rasterDensity?: number;
  /** Key changes over tools/web/keys.ts KEYMAP: {"KeyA": "SQUARE"} binds,
   *  {"KeyY": null} unbinds. */
  keys?: Record<string, string | null>;
  /** Enable the browser document host and copy these built-in projects. */
  documents?: WebDocumentExample[];
}

export interface WebSiteConfig {
  title?: string;
  intro?: string;
  /** Source repository URL, linked from every page. */
  source?: string;
  /** The metadata table, keyed by game id. */
  games?: Record<string, WebGameEntry>;
  /** Projects built with the kit that live on their own sites: linked from
   *  the landing page, not built or hosted here. */
  showcase?: ShowcaseEntry[];
  /** Studio, the browser-native editor (editor/studio): built into
   *  <outdir>/studio by tools/studio-build.ts and given a landing card. */
  studio?: WebStudioConfig;
}

export interface WebStudioConfig {
  title: string;
  description: string;
  /** Preview image (PNG), relative to the project root. A missing file
   *  leaves the card without a picture. */
  preview?: string;
}

export interface ShowcaseEntry {
  title: string;
  /** An absolute https:// URL of the project's own page. */
  url: string;
  description?: string;
  /** An absolute https:// URL of a 480x272 preview on the project's own site
   *  (hotlinked, so no third-party art is copied into this repository). */
  preview?: string;
  controls?: WebControl[];
}

/** Controls of the kit's GameView, for games the table does not describe. */
export const DEFAULT_CONTROLS: readonly WebControl[] = [
  { button: "DPAD", action: "Walk, pick an answer" },
  { button: "CIRCLE", action: "Talk, confirm" },
  { button: "CROSS", action: "Cancel" },
];

export interface WebGame {
  id: string;
  manifestPath: string;
  title: string;
  description: string;
  controls: WebControl[];
  chapters: WebChapter[];
  pointer?: string;
  features?: string[];
  featured?: boolean;
  /** Absolute path of the configured preview image, if any. */
  preview?: string;
  plan: ResolvedBuildPlan;
  viewport: ViewportConfig;
  keymap: Keymap;
  documents?: Array<WebDocumentExample & { path: string }>;
}

/** The settings a player page hands tools/web/player.js. */
export interface PlayerConfig {
  id: string;
  app: string;
  bundle: string;
  pak: string | null;
  wasm: string;
  viewport: ViewportConfig;
  rasterDensity: number;
  companions: string[];
  simHz: number;
  /** Dedicated browser-storage key for the game's read-only autosave slot. */
  autosaveStorageKey: string;
  /** KeyboardEvent.code -> button mask. */
  keys: Record<string, number>;
  /** Browser implementation of the rpgkit-editor companion. */
  editor?: {
    storageKey: string;
    examples: Array<{ id: string; title: string; url: string }>;
  };
}

// ---- configuration ---------------------------------------------------------

const ID = /^[a-z0-9][a-z0-9._-]*$/i;

function isRelativePngPath(path: string): boolean {
  return path.length > 0 &&
    !isAbsolute(path) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    extname(path).toLowerCase() === ".png";
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSiteConfig(projectRoot: string, configPath?: string): WebSiteConfig {
  const path = configPath ? resolve(configPath) : join(projectRoot, "web.json");
  if (!existsSync(path)) {
    if (configPath) throw new Error(`web: config not found: ${path}`);
    return {};
  }
  return parseSiteConfig(readJson(path), path);
}

/** Check a parsed web.json; `source` names it in errors. */
export function parseSiteConfig(value: unknown, source: string): WebSiteConfig {
  const config = value as WebSiteConfig;
  if (!config || typeof config !== "object") throw new Error(`web: ${source} is not a JSON object`);
  if (config.games !== undefined && (typeof config.games !== "object" || config.games === null || Array.isArray(config.games))) {
    throw new Error(`web: ${source}: "games" is a table keyed by game id`);
  }
  for (const [id, entry] of Object.entries(config.games ?? {})) validateEntry(id, entry, source);
  if (config.showcase !== undefined) {
    if (!Array.isArray(config.showcase)) throw new Error(`web: ${source}: "showcase" is a list`);
    config.showcase.forEach((entry, i) => {
      if (!entry || typeof entry.title !== "string" || entry.title.length === 0) {
        throw new Error(`web: ${source}: showcase[${i}] needs a title`);
      }
      if (typeof entry.url !== "string" || !/^https:\/\/[^\s"<>]+$/.test(entry.url)) {
        throw new Error(`web: ${source}: showcase[${i}].url must be an absolute https:// URL`);
      }
      if (entry.description !== undefined && typeof entry.description !== "string") {
        throw new Error(`web: ${source}: showcase[${i}].description is text`);
      }
      if (entry.preview !== undefined && (typeof entry.preview !== "string" || !/^https:\/\/[^\s"<>]+$/.test(entry.preview))) {
        throw new Error(`web: ${source}: showcase[${i}].preview must be an absolute https:// URL`);
      }
      validateEntry(`showcase-${i}`, { controls: entry.controls }, source);
    });
  }
  if (config.studio !== undefined) {
    const studio = config.studio;
    if (!studio || typeof studio !== "object" || Array.isArray(studio)) {
      throw new Error(`web: ${source}: "studio" is an object`);
    }
    if (typeof studio.title !== "string" || studio.title.trim().length === 0) {
      throw new Error(`web: ${source}: studio.title must be non-empty text`);
    }
    if (typeof studio.description !== "string") throw new Error(`web: ${source}: studio.description is text`);
    if (studio.preview !== undefined && (typeof studio.preview !== "string" || !isRelativePngPath(studio.preview))) {
      throw new Error(`web: ${source}: studio.preview must be a relative PNG path`);
    }
  }
  return config;
}

function validateEntry(id: string, entry: WebGameEntry, source: string): void {
  if (!ID.test(id)) throw new Error(`web: ${source}: "${id}" is not a usable game id`);
  if (!entry || typeof entry !== "object") throw new Error(`web: ${source}: games.${id} is not an object`);
  if (entry.viewport !== undefined && entry.viewport !== "fixed" && entry.viewport !== "dynamic") {
    throw new Error(`web: ${source}: games.${id}.viewport is "fixed" or "dynamic"`);
  }
  if (
    entry.features !== undefined &&
    (!Array.isArray(entry.features) || entry.features.some((feature) => typeof feature !== "string"))
  ) {
    throw new Error(`web: ${source}: games.${id}.features is a list of text`);
  }
  if (entry.featured !== undefined && typeof entry.featured !== "boolean") {
    throw new Error(`web: ${source}: games.${id}.featured is a boolean`);
  }
  if (
    entry.rasterDensity !== undefined &&
    (!Number.isInteger(entry.rasterDensity) || entry.rasterDensity < 1 || entry.rasterDensity > MAX_WEB_RASTER_DENSITY)
  ) {
    throw new Error(`web: ${source}: games.${id}.rasterDensity is an integer from 1 through ${MAX_WEB_RASTER_DENSITY}`);
  }
  try {
    withKeys(entry.keys);
  } catch (error) {
    throw new Error(`web: ${source}: games.${id}.keys: ${error instanceof Error ? error.message : error}`);
  }
  if (entry.chapters !== undefined && !Array.isArray(entry.chapters)) {
    throw new Error(`web: ${source}: games.${id}.chapters is a list`);
  }
  const chapterIds = new Set<string>();
  for (const [index, chapter] of (entry.chapters ?? []).entries()) {
    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}] is an object`);
    }
    if (typeof chapter.id !== "string" || !ID.test(chapter.id)) {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}].id is not a usable chapter id`);
    }
    if (chapterIds.has(chapter.id)) {
      throw new Error(`web: ${source}: games.${id}.chapters has duplicate id "${chapter.id}"`);
    }
    chapterIds.add(chapter.id);
    if (typeof chapter.title !== "string" || chapter.title.trim().length === 0) {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}].title must be non-empty text`);
    }
    if (chapter.description !== undefined && typeof chapter.description !== "string") {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}].description is text`);
    }
    if (
      chapter.preview !== undefined &&
      (typeof chapter.preview !== "string" || !isRelativePngPath(chapter.preview))
    ) {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}].preview must be a relative PNG path`);
    }
    if (chapter.autoplay !== undefined && typeof chapter.autoplay !== "boolean") {
      throw new Error(`web: ${source}: games.${id}.chapters[${index}].autoplay is a boolean`);
    }
  }
  for (const control of entry.controls ?? []) {
    const buttons = control.buttons ?? (control.button ? [control.button] : []);
    const literalKeys = control.keys ?? [];
    if (
      (buttons.length === 0 && literalKeys.length === 0) ||
      (buttons.length > 0 && literalKeys.length > 0) ||
      !buttons.every(isControlButton) ||
      !literalKeys.every((key) => typeof key === "string" && key.length > 0) ||
      typeof control.action !== "string"
    ) {
      throw new Error(
        `web: ${source}: games.${id} has a control without either literal keys or a known button ` +
          `(${["DPAD", ...BUTTON_NAMES].join(", ")}) and an action`,
      );
    }
  }
  if (entry.documents !== undefined) {
    if (!Array.isArray(entry.documents) || entry.documents.length === 0) {
      throw new Error(`web: ${source}: games.${id}.documents is a non-empty list`);
    }
    const ids = new Set<string>();
    for (const [index, document] of entry.documents.entries()) {
      if (!document || typeof document !== "object" || !ID.test(document.id)) {
        throw new Error(`web: ${source}: games.${id}.documents[${index}] needs a usable id`);
      }
      if (ids.has(document.id)) throw new Error(`web: ${source}: games.${id}.documents repeats "${document.id}"`);
      ids.add(document.id);
      if (typeof document.title !== "string" || document.title.length === 0 || typeof document.document !== "string" || document.document.length === 0) {
        throw new Error(`web: ${source}: games.${id}.documents[${index}] needs a title and document path`);
      }
    }
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Where a game named on the command line keeps its pocket.json. */
export function findManifest(projectRoot: string, id: string): string | undefined {
  for (const candidate of [
    join(projectRoot, "examples", id, "pocket.json"),
    join(projectRoot, "tools", id, "pocket.json"),
    join(projectRoot, id, "pocket.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const rootManifest = join(projectRoot, "pocket.json");
  if (existsSync(rootManifest)) {
    const manifest = readJson(rootManifest);
    if (manifest?.app?.output === id || manifest?.name === id) return rootManifest;
  }
  return undefined;
}

/** The kit's own site also builds the postMessage preview host. */
export const PREVIEW_APP_ID = "preview";

/** The games to build when none are named. */
export function defaultGameIds(projectRoot: string): string[] {
  if (sameDir(projectRoot, KIT_ROOT)) return [...APPS, PREVIEW_APP_ID];
  const examples = join(projectRoot, "examples");
  if (existsSync(examples)) {
    const ids = readdirSync(examples)
      .filter((name) => ID.test(name) && existsSync(join(examples, name, "pocket.json")))
      .sort();
    if (ids.length > 0) return ids;
  }
  const rootManifest = join(projectRoot, "pocket.json");
  if (existsSync(rootManifest)) return [String(readJson(rootManifest).app?.output)];
  return [];
}

/** Cards follow the metadata table's order; games it does not list follow
 *  in build order. */
export function cardOrder(ids: readonly string[], config: WebSiteConfig): string[] {
  const listed = Object.keys(config.games ?? {}).filter((id) => ids.includes(id));
  return [...listed, ...ids.filter((id) => !listed.includes(id))];
}

const TARGET_RANGE = POCKET_TARGETS[TARGET].display.dynamicViewport!;

function size(value: unknown): Size | undefined {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n) && n > 0)
    ? [value[0], value[1]]
    : undefined;
}

/** The viewport the player page runs, from the plan and the manifest. */
export function viewportFor(manifest: any, plan: ResolvedBuildPlan, pin?: "fixed" | "dynamic"): ViewportConfig {
  const declared = manifest?.app?.viewport ?? {};
  const policy = pin ?? (plan.viewport.policy === "dynamic" ? "dynamic" : "fixed");
  if (policy === "dynamic") {
    const dynamic = declared.dynamic;
    if (!dynamic && pin) throw new Error(`web: ${plan.app.output} pins a dynamic viewport its manifest does not declare`);
    const fallback = size(plan.viewport.logical)!;
    const def = size(dynamic?.default) ?? fallback;
    return {
      policy: "dynamic",
      default: def,
      min: size(dynamic?.min) ?? [TARGET_RANGE.min[0], TARGET_RANGE.min[1]],
      max: size(dynamic?.max) ?? [TARGET_RANGE.max[0], TARGET_RANGE.max[1]],
    };
  }
  const fixed = size(declared.fixed?.logical);
  if (!fixed && pin) throw new Error(`web: ${plan.app.output} pins a fixed viewport its manifest does not declare`);
  return { policy: "fixed", logical: fixed ?? size(plan.viewport.logical)! };
}

/** The size a preview renders at: the fixed viewport, or the smallest live one. */
export function previewSize(viewport: ViewportConfig): Size {
  return viewport.policy === "fixed" ? viewport.logical : viewport.min;
}

/** "Pocket RPG Kit — Mini Meadow" -> "Mini Meadow" on a "Pocket RPG Kit" site. */
export function shortTitle(title: string, siteTitle?: string): string {
  if (!siteTitle) return title;
  const prefix = new RegExp(`^${siteTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[—–:-]\\s*`);
  return title.replace(prefix, "") || title;
}

export function resolveGame(projectRoot: string, config: WebSiteConfig, id: string): WebGame {
  if (!ID.test(id)) throw new Error(`web: "${id}" is not a usable game id`);
  const entry: WebGameEntry = config.games?.[id] ?? {};
  const manifestPath = entry.manifest ? resolve(projectRoot, entry.manifest) : findManifest(projectRoot, id);
  if (!manifestPath || !existsSync(manifestPath)) {
    throw new Error(
      `web: no pocket.json for "${id}" under ${projectRoot} (examples here: ${defaultGameIds(projectRoot).join(", ") || "none"})`,
    );
  }
  const manifest = readJson(manifestPath);
  const rasterDensity = entry.rasterDensity ?? DEFAULT_WEB_RASTER_DENSITY;
  const target = POCKET_PLATFORM_CONTRACTS.targets[TARGET];
  const physicalViewport = target.display.physicalViewport.map((n) => n * rasterDensity) as [number, number];
  const registry: PlatformContractRegistry = {
    capabilities: POCKET_PLATFORM_CONTRACTS.capabilities,
    targets: {
      ...POCKET_PLATFORM_CONTRACTS.targets,
      [TARGET]: { ...target, display: { ...target.display, physicalViewport, rasterDensity } },
    },
  };
  const resolution = validateAndResolveBuildPlan(manifest, { target: TARGET }, registry);
  if (!resolution.ok) {
    throw new Error(
      `web: ${relative(projectRoot, manifestPath)} did not resolve against ${TARGET}: ` +
        resolution.diagnostics.map((d) => `${d.path || "/"}: ${d.message}`).join("; "),
    );
  }
  const plan = resolution.plan;
  const preview = entry.preview ? resolve(projectRoot, entry.preview) : undefined;
  if (preview && !existsSync(preview)) throw new Error(`web: preview for "${id}" not found: ${preview}`);
  if (preview && extname(preview).toLowerCase() !== ".png") throw new Error(`web: preview for "${id}" must be a PNG`);
  const chapters = (entry.chapters ?? []).map(({ id: chapterId, title, description, preview, autoplay }) => {
    if (preview) {
      const source = resolve(projectRoot, preview);
      if (!isInside(projectRoot, source) || !existsSync(source) || !statSync(source).isFile()) {
        throw new Error(`web: chapter preview for "${id}/${chapterId}" not found: ${source}`);
      }
    }
    return {
      id: chapterId,
      title,
      ...(description !== undefined ? { description } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(autoplay !== undefined ? { autoplay } : {}),
    };
  });
  const documents = entry.documents?.map((document) => {
    const path = resolve(projectRoot, document.document);
    if (!isInside(projectRoot, path)) throw new Error(`web: document "${document.id}" for "${id}" leaves the project root`);
    if (!existsSync(path)) throw new Error(`web: document "${document.id}" for "${id}" not found: ${path}`);
    if (extname(path).toLowerCase() !== ".json") throw new Error(`web: document "${document.id}" for "${id}" must be JSON`);
    return { ...document, path };
  });
  if (documents && !plan.companions.includes("rpgkit-editor")) {
    throw new Error(`web: documents for "${id}" require the rpgkit-editor companion`);
  }
  if (plan.companions.includes("rpgkit-editor") && !documents) {
    throw new Error(`web: the rpgkit-editor companion for "${id}" requires browser documents`);
  }
  return {
    id,
    manifestPath,
    title: entry.title ?? shortTitle(plan.app.title, config.title),
    description: entry.description ?? "",
    controls: [...(entry.controls ?? DEFAULT_CONTROLS)],
    chapters,
    ...(entry.pointer ? { pointer: entry.pointer } : {}),
    ...(entry.features ? { features: [...entry.features] } : {}),
    ...(entry.featured !== undefined ? { featured: entry.featured } : {}),
    ...(preview ? { preview } : {}),
    plan,
    viewport: viewportFor(manifest, plan, entry.viewport),
    keymap: withKeys(entry.keys),
    ...(documents ? { documents } : {}),
  };
}

// ---- pages -----------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON inside <script type="application/json">: no "</script>" can close it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' shape-rendering='crispEdges'>" +
      "<rect width='8' height='8' rx='1' fill='#0d0f14'/><rect x='2' y='1' width='4' height='6' fill='#f4c35a'/>" +
      "<rect x='1' y='2' width='6' height='4' fill='#f4c35a'/><rect x='3' y='3' width='2' height='2' fill='#fff3c4'/></svg>",
  );

function head(title: string, description: string, css: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    ...(description ? [`<meta name="description" content="${escapeHtml(description)}">`] : []),
    '<meta name="color-scheme" content="dark">',
    `<link rel="icon" href="${ICON}">`,
    `<link rel="stylesheet" href="${css}">`,
    "</head>",
  ].join("\n");
}

function controlButtons(control: WebControl): ControlButton[] {
  return control.buttons ?? (control.button ? [control.button] : []);
}

export function controlsTable(controls: readonly WebControl[], pointer?: string, keymap?: Keymap): string {
  const rows = controls.map((control) => {
    const keys: string[] = [...(control.keys ?? [])];
    for (const button of controlButtons(control)) for (const key of keysFor(button, keymap)) if (!keys.includes(key)) keys.push(key);
    return `<tr><th scope="row">${keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join(" ")}</th><td>${escapeHtml(control.action)}</td></tr>`;
  });
  if (pointer) rows.push(`<tr><th scope="row"><span class="pointer-key">Mouse, touch</span></th><td>${escapeHtml(pointer)}</td></tr>`);
  return `<table class="controls">\n${rows.join("\n")}\n</table>`;
}

/** Face, shoulder and system buttons a game's controls mention. */
function padButtons(controls: readonly WebControl[]): ButtonName[] {
  const named = new Set(controls.flatMap(controlButtons));
  return BUTTON_NAMES.filter((b) => !["UP", "DOWN", "LEFT", "RIGHT"].includes(b) && named.has(b));
}

function editorTools(config: PlayerConfig): string[] {
  if (!config.editor) return [];
  const examples = config.editor.examples.map(
    (example) => `<button type="button" data-editor-example="${escapeHtml(example.id)}" disabled>${escapeHtml(example.title)}</button>`,
  );
  return [
    '<section class="editor-tools" aria-label="Project files">',
    '<div class="editor-actions">',
    '<button type="button" id="editor-open" disabled>Open…</button>',
    '<input type="file" id="editor-open-input" accept="application/json,.json" hidden disabled>',
    ...examples,
    '<button type="button" id="editor-download" disabled>Download</button>',
    '</div>',
    '<p class="editor-status" id="editor-status" role="status" aria-live="polite">Preparing the browser editor…</p>',
    '<p class="editor-privacy">Your project data stays in this browser; nothing is uploaded.</p>',
    '</section>',
  ];
}

/** A touch button's label: the letter key that presses it, so the pad, the
 *  controls and the game's own prompts agree; otherwise its glyph. */
function padLabel(name: ButtonName, keymap?: Keymap): string {
  return keysFor(name, keymap).find((key) => /^[A-Z]$/.test(key)) ?? BUTTON_GLYPHS[name];
}

function padHtml(controls: readonly WebControl[], keymap?: Keymap): string {
  const button = (name: ButtonName, cls: string) =>
    `<button type="button" tabindex="-1" class="${cls}" data-button="${name}">${escapeHtml(
      ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "START"].includes(name) ? BUTTON_GLYPHS[name] : padLabel(name, keymap),
    )}</button>`;
  return [
    '<div class="pad" aria-hidden="true">',
    `<div class="dpad">${button("UP", "up")}${button("LEFT", "left")}${button("RIGHT", "right")}${button("DOWN", "down")}</div>`,
    `<div class="actions">${padButtons(controls).map((name) => button(name, `pad-${name.toLowerCase()}`)).join("")}</div>`,
    "</div>",
  ].join("\n");
}

export interface SiteInfo {
  title: string;
  intro: string;
  source?: string;
  showcase?: readonly ShowcaseEntry[];
  /** Studio's landing card, when the site builds it. */
  studio?: StudioCard;
}

export interface StudioCard {
  title: string;
  description: string;
  /** Preview dimensions, when studio/preview.png exists. */
  preview?: Size;
}

/** Studio's landing card: the site-relative studio/ directory. */
function studioCard(studio: StudioCard): string {
  const href = "studio/";
  const shot = studio.preview
    ? `<img src="studio/preview.png" width="${studio.preview[0]}" height="${studio.preview[1]}" alt="" loading="lazy">`
    : `<span class="no-preview">${escapeHtml(studio.title)}</span>`;
  return [
    '<article class="game-card studio-card" id="studio">',
    `<a class="shot" href="${href}" tabindex="-1" aria-hidden="true">${shot}</a>`,
    '<div class="card-body">',
    `<h2><a href="${href}">${escapeHtml(studio.title)}</a></h2>`,
    ...(studio.description ? [`<p class="description">${escapeHtml(studio.description)}</p>`] : []),
    `<p><a class="play" href="${href}">Open Studio</a></p>`,
    "</div>",
    "</article>",
  ].join("\n");
}

export interface Card {
  game: WebGame;
  /** Preview dimensions, when the card has a picture. */
  preview?: Size;
}

function chaptersNav(game: WebGame): string | undefined {
  if (game.chapters.length === 0) return undefined;
  const links = game.chapters.map(({ id, title }) => {
    const query = new URLSearchParams({ chapter: id }).toString();
    const href = `${encodeURIComponent(game.id)}/?${query}`;
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></li>`;
  });
  return [
    `<nav class="chapters" aria-label="${escapeHtml(`${game.title} chapters`)}">`,
    "<span>Chapters:</span>",
    `<ul>${links.join("")}</ul>`,
    "</nav>",
  ].join("\n");
}

/** Same-page controls for a running opt-in demo. Links remain functional
 * deep-link fallbacks when the game does not install the demo hook. */
function playerDemoControls(game: WebGame): string | undefined {
  if (game.chapters.length === 0) return undefined;
  const chapters = game.chapters.map(({ id, title, description, preview, autoplay }) => {
    const href = `?${new URLSearchParams({ chapter: id })}`;
    const titleId = `demo-chapter-title-${id}`;
    const descriptionId = `demo-chapter-description-${id}`;
    return [
      `<a class="demo-button demo-chapter-card" role="button" aria-pressed="false" data-demo-chapter="${escapeHtml(id)}" data-demo-autoplay="${autoplay === true}" href="${escapeHtml(href)}" aria-labelledby="${escapeHtml(titleId)}"${description === undefined ? "" : ` aria-describedby="${escapeHtml(descriptionId)}"`}>`,
      ...(preview
        ? [`<img class="demo-chapter-preview" src="${escapeHtml(chapterPreviewOutput(id))}" alt="" loading="lazy">`]
        : []),
      '<span class="demo-chapter-copy">',
      `<span class="demo-chapter-title" id="${escapeHtml(titleId)}">${escapeHtml(title)}</span>`,
      ...(description === undefined
        ? []
        : [`<span class="demo-chapter-description" id="${escapeHtml(descriptionId)}">${escapeHtml(description)}</span>`]),
      "</span>",
      "</a>",
    ].join("");
  });
  const firstAutoplay = game.chapters.find((chapter) => chapter.autoplay)?.id;
  const speeds = firstAutoplay ? ([1, 2, 4] as const).map((speed) => {
    const href = `?${new URLSearchParams({ autoplay: firstAutoplay, speed: String(speed) })}`;
    return `<a class="demo-button demo-speed" role="button" aria-pressed="false" data-demo-speed="${speed}" href="${escapeHtml(href)}">${speed}×</a>`;
  }) : [];
  return [
    '<section class="demo-controls" data-demo-controls aria-labelledby="demo-controls-heading">',
    '<h2 id="demo-controls-heading">Demo controls</h2>',
    '<div class="demo-control-row"><span>Chapter</span><div class="demo-buttons demo-chapter-cards">',
    ...chapters,
    "</div></div>",
    ...(speeds.length > 0
      ? ['<div class="demo-control-row"><span>Autoplay</span><div class="demo-buttons">', ...speeds, "</div></div>"]
      : []),
    `<p class="demo-help">Jump instantly without reloading.${speeds.length > 0 ? " Autoplay starts the selected chapter at the chosen speed." : ""}</p>`,
    "</section>",
  ].join("\n");
}

/** The landing page at the site root. */
export function renderLanding(site: SiteInfo, cards: readonly Card[]): string {
  const showcase = (site.showcase ?? []).map(showcaseCard);
  const previewDemo = cards.some((card) => card.game.id === PREVIEW_APP_ID)
    ? 'Embed a project document from another page: <a href="preview-demo.html">the preview protocol demo</a>. '
    : "";
  const articles = cards.map(({ game, preview }) => {
    const href = `${game.id}/`;
    const chapterNav = chaptersNav(game);
    const shot = preview
      ? `<img src="${game.id}/preview.png" width="${preview[0]}" height="${preview[1]}" alt="" loading="lazy">`
      : `<span class="no-preview">${escapeHtml(game.title)}</span>`;
    const html = [
      `<article class="game-card" id="${game.id}">`,
      `<a class="shot" href="${href}" tabindex="-1" aria-hidden="true">${shot}</a>`,
      '<div class="card-body">',
      `<h2><a href="${href}">${escapeHtml(game.title)}</a></h2>`,
      ...(game.description ? [`<p class="description">${escapeHtml(game.description)}</p>`] : []),
      controlsTable(game.controls, game.pointer, game.keymap),
      ...(chapterNav ? [chapterNav] : []),
      `<p><a class="play" href="${href}">Play in the browser</a></p>`,
      "</div>",
      "</article>",
    ].join("\n");
    return { featured: game.featured === true, html };
  });
  const featured = articles.filter((article) => article.featured).map((article) => article.html);
  const regular = articles.filter((article) => !article.featured).map((article) => article.html);
  return [
    head(site.title, site.intro, "site.css"),
    '<body class="landing">',
    '<header class="site-header">',
    `<h1>${escapeHtml(site.title)}</h1>`,
    ...(site.intro ? [`<p class="intro">${escapeHtml(site.intro)}</p>`] : []),
    ...(site.source ? [`<p class="links"><a href="${escapeHtml(site.source)}">Source code</a></p>`] : []),
    "</header>",
    '<main class="games">',
    ...featured,
    ...showcase,
    ...regular,
    ...(site.studio ? [studioCard(site.studio)] : []),
    "</main>",
    '<footer class="site-footer">',
    `<p>${previewDemo}Runs on <a href="https://github.com/pocket-stack/pocketjs">PocketJS</a>, compiled to WebAssembly. ` +
      "Nothing to install; a keyboard works best. Art credits are on each game's page.</p>",
    "</footer>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A project on its own site, as a card like the examples'. Its cards follow
 *  featured local games and precede the remaining local games. Its link and
 *  preview point at that site; nothing is built or hosted here. */
function showcaseCard(entry: ShowcaseEntry): string {
  const href = escapeHtml(entry.url);
  const shot = entry.preview
    ? `<img src="${escapeHtml(entry.preview)}" width="480" height="272" alt="" loading="lazy">`
    : `<span class="no-preview">${escapeHtml(entry.title)}</span>`;
  return [
    '<article class="game-card showcase-card">',
    `<a class="shot" href="${href}" tabindex="-1" aria-hidden="true">${shot}</a>`,
    '<div class="card-body">',
    `<h2><a href="${href}">${escapeHtml(entry.title)}</a></h2>`,
    ...(entry.description ? [`<p class="description">${escapeHtml(entry.description)}</p>`] : []),
    ...(entry.controls && entry.controls.length > 0 ? [controlsTable(entry.controls)] : []),
    `<p><a class="play" href="${href}">Play in the browser</a> <span class="elsewhere">on its own site</span></p>`,
    "</div>",
    "</article>",
  ].join("\n");
}

/** Copy the license files of the fonts an app bakes (tools/lib/font-licenses.ts)
 *  into its site directory; returns their file names. */
export function copyFontLicenses(appDir: string, dir: string): string[] {
  const names: string[] = [];
  for (const file of fontLicenseFiles(appDir)) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    copyFileSync(file, join(dir, name));
    names.push(name);
  }
  return names;
}

/** One game's player page, <site>/<id>/index.html. */
export function renderPlayer(
  site: SiteInfo,
  game: WebGame,
  config: PlayerConfig,
  credits: boolean,
  fontLicenses: readonly string[] = [],
): string {
  const shape = config.viewport.policy === "fixed" ? config.viewport.logical : config.viewport.default;
  const demoControls = playerDemoControls(game);
  const footer = [
    ...(credits ? ['Art credits and licenses: <a href="ATTRIBUTION.txt">ATTRIBUTION.txt</a>.'] : []),
    ...(fontLicenses.length > 0
      ? [`Font license: ${fontLicenses.map((name) => `<a href="${escapeHtml(name)}">${escapeHtml(name)}</a>`).join(", ")}.`]
      : []),
    `Built with <a href="${escapeHtml(site.source ?? "https://github.com/lfkdsk/pocketjs-rpgkit")}">${escapeHtml(site.title)}</a> ` +
      'on <a href="https://github.com/pocket-stack/pocketjs">PocketJS</a>.',
  ].join(" ");
  return [
    head(`${game.title} · ${site.title}`, game.description, "../site.css"),
    '<body class="player-page">',
    '<header class="bar">',
    `<a class="back" href="../">← ${escapeHtml(site.title)}</a>`,
    `<h1>${escapeHtml(game.title)}</h1>`,
    '<div class="audio-controls" role="group" aria-label="Audio">',
    '<button type="button" id="audio-mute" aria-label="Mute audio" aria-pressed="false">Mute</button>',
    '<label for="audio-volume">Volume</label>',
    '<input type="range" id="audio-volume" min="0" max="100" step="5" value="100">',
    '<output id="audio-volume-value" for="audio-volume">100%</output>',
    "</div>",
    "</header>",
    "<main>",
    ...editorTools(config),
    '<div class="screen-area">',
    `<div class="stage" id="stage" tabindex="0" role="application" aria-label="${escapeHtml(game.title)}: game screen" ` +
      `aria-describedby="controls-heading" data-state="loading" data-viewport="${config.viewport.policy}" style="aspect-ratio: ${shape[0]} / ${shape[1]}">`,
    `<canvas id="screen" width="${shape[0]}" height="${shape[1]}"></canvas>`,
    '<div class="overlay" id="overlay"><p id="overlay-message">Loading…</p><button type="button" id="overlay-reload" hidden>Reload</button></div>',
    '<p class="focus-hint" id="focus-hint" hidden>Click the game to use the keyboard</p>',
    "</div>",
    "</div>",
    '<p class="caption">Keys reach the game while it has focus: it takes focus when the page loads and whenever you click it.</p>',
    ...(demoControls ? [demoControls] : []),
    padHtml(game.controls, game.keymap),
    '<section class="info">',
    ...(game.description ? [`<p class="description">${escapeHtml(game.description)}</p>`] : []),
    ...(game.features && game.features.length > 0
      ? [
          "<h2>Exhibition halls</h2>",
          '<ol class="features">',
          ...game.features.map((feature) => `<li>${escapeHtml(feature)}</li>`),
          "</ol>",
        ]
      : []),
    '<h2 id="controls-heading">Controls</h2>',
    controlsTable(game.controls, game.pointer, game.keymap),
    "</section>",
    "</main>",
    `<footer class="site-footer"><p>${footer}</p></footer>`,
    '<noscript><p class="noscript">This game needs JavaScript and WebAssembly.</p></noscript>',
    `<script type="application/json" id="pocket-game">${scriptJson(config)}</script>`,
    '<script type="module" src="../player.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(path: string): Size {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error(`web: ${path} is not a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

// ---- build -----------------------------------------------------------------

export interface BuildOptions {
  projectRoot: string;
  outdir: string;
  config?: string;
  games: string[];
}

async function run(cmd: string[], cwd: string): Promise<number> {
  const child = Bun.spawn({ cmd, cwd, stdio: ["inherit", "inherit", "inherit"] });
  return child.exited;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Relative URL/path used for one copied chapter-card preview. */
export function chapterPreviewOutput(id: string): string {
  return `chapter-previews/${id}.png`;
}

/** Copy configured chapter previews beside one built game's player page. */
export function copyChapterPreviews(projectRoot: string, game: WebGame, outputDir: string): void {
  for (const chapter of game.chapters) {
    if (!chapter.preview) continue;
    const target = join(outputDir, chapterPreviewOutput(chapter.id));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(projectRoot, chapter.preview), target);
  }
}

const STUDIO_ID = "studio";

/** Build Studio into <outdir>/studio and copy its configured preview. Loaded
 *  on demand: a site without a "studio" entry never touches editor/. */
async function buildStudioSite(projectRoot: string, outdir: string, config: WebStudioConfig): Promise<StudioCard> {
  const { buildStudio } = await import("./studio-build.ts");
  const { files } = await buildStudio({ outdir, kitRoot: KIT_ROOT });
  console.log(`web: ${STUDIO_ID}: ${files.length} file(s)`);
  let preview: Size | undefined;
  if (config.preview) {
    const source = resolve(projectRoot, config.preview);
    if (isInside(projectRoot, source) && existsSync(source) && statSync(source).isFile()) {
      const target = join(outdir, STUDIO_ID, "preview.png");
      copyFileSync(source, target);
      preview = pngSize(target);
    } else {
      console.warn(`web: ${STUDIO_ID}: preview ${config.preview} not found; the card has no picture`);
    }
  }
  return { title: config.title, description: config.description, ...(preview ? { preview } : {}) };
}

export async function buildWebSite(options: BuildOptions): Promise<WebGame[]> {
  const projectRoot = resolve(options.projectRoot);
  const outdir = resolve(options.outdir);
  if (isInside(outdir, projectRoot) || isInside(outdir, KIT_ROOT)) {
    throw new Error(`web: refusing to use ${outdir} as the output directory; it contains the project`);
  }
  if (!existsSync(WASM_PATH)) {
    throw new Error(`web: missing ${WASM_PATH}; build the core first (bun run build:wasm)`);
  }
  if (!existsSync(AUDIO_WORKLET_PATH)) {
    throw new Error(`web: missing ${AUDIO_WORKLET_PATH}; initialize the PocketJS vendor checkout`);
  }
  const config = loadSiteConfig(projectRoot, options.config);
  const ids = options.games.length > 0 ? [...new Set(options.games)] : defaultGameIds(projectRoot);
  if (ids.length === 0) throw new Error(`web: no games found under ${projectRoot}`);
  const games = cardOrder(ids, config).map((id) => resolveGame(projectRoot, config, id));
  if (config.studio && games.some((game) => game.id === STUDIO_ID)) {
    throw new Error(`web: a game named "${STUDIO_ID}" would share Studio's directory`);
  }
  const packageJson = join(projectRoot, "package.json");
  const site: SiteInfo = {
    title:
      config.title ??
      (games.length === 1 ? games[0]!.title : existsSync(packageJson) ? String(readJson(packageJson).name) : "PocketJS games"),
    intro: config.intro ?? "",
    ...(config.source ? { source: config.source } : {}),
    ...(config.showcase ? { showcase: config.showcase } : {}),
  };

  // Start clean so a removed game or renamed asset cannot linger, but only
  // wipe a directory this tool wrote (games.json marks it) or an empty one.
  if (existsSync(outdir) && readdirSync(outdir).length > 0 && !existsSync(join(outdir, "games.json"))) {
    throw new Error(`web: ${outdir} is not empty and holds no earlier web build; choose another --outdir`);
  }
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const cards: Card[] = [];
  for (const game of games) {
    const dir = join(outdir, game.id);
    mkdirSync(dir, { recursive: true });
    const output = game.plan.app.output;
    const planPath = join(projectRoot, ".pocket", TARGET, `${output}.plan.json`);
    mkdirSync(dirname(planPath), { recursive: true });
    await Bun.write(planPath, JSON.stringify(game.plan, null, 2) + "\n");
    console.log(
      `web: ${game.id}: ${relative(projectRoot, game.manifestPath)} -> ${TARGET} ` +
        `plan ${game.plan.planHash.slice(0, 16)}…, ${game.viewport.policy} viewport, ${game.plan.viewport.rasterDensity}x raster`,
    );
    const built = await run(
      [process.execPath, join(POCKETJS, "tools", "build.ts"), `--plan=${planPath}`, `--project-root=${projectRoot}`, `--outdir=${dir}`],
      projectRoot,
    );
    const bundle = join(dir, `${output}.js`);
    if (built !== 0 || !existsSync(bundle)) throw new Error(`web: building ${game.id} failed (exit ${built})`);
    const pak = join(dir, `${output}.pak`);
    const hasPak = existsSync(pak);
    // hosts/web/audio.js loads this document-relative URL in a separate
    // AudioWorklet realm, so every game page needs the standalone module.
    copyFileSync(AUDIO_WORKLET_PATH, join(dir, "audio-worklet.js"));
    copyChapterPreviews(projectRoot, game, dir);

    const preview = join(dir, "preview.png");
    if (game.preview) {
      copyFileSync(game.preview, preview);
    } else {
      const [w, h] = previewSize(game.viewport);
      const rendered = await run(
        [
          process.execPath, join(KIT_ROOT, "tools", "web", "preview.ts"), WASM_PATH, bundle,
          hasPak ? pak : "-", preview, String(w), String(h), String(PREVIEW_FRAMES), String(game.plan.viewport.rasterDensity),
        ],
        projectRoot,
      );
      // A preview is decoration: the card goes out without one rather than
      // failing the site.
      if (rendered !== 0) {
        console.warn(`web: ${game.id}: no preview (rendering exited ${rendered}); the card has no picture`);
        rmSync(preview, { force: true });
      }
    }
    cards.push({ game, ...(existsSync(preview) ? { preview: pngSize(preview) } : {}) });

    const attribution = join(dirname(game.manifestPath), "ATTRIBUTION.md");
    const credits = existsSync(attribution);
    if (credits) copyFileSync(attribution, join(dir, "ATTRIBUTION.txt"));
    // Glyphs baked from a fallback font are a derivative of it: its license
    // goes beside the game (the pak carries it too, through pak.json).
    const fontLicenses = copyFontLicenses(appDirOf(projectRoot, game.plan.app.entry), dir);

    const playerConfig: PlayerConfig = {
      id: game.id,
      app: output,
      bundle: `${output}.js`,
      pak: hasPak ? `${output}.pak` : null,
      wasm: "../pocketjs.wasm",
      viewport: game.viewport,
      rasterDensity: game.plan.viewport.rasterDensity,
      companions: [...game.plan.companions],
      simHz: 60,
      autosaveStorageKey: `pocket-rpgkit:${game.plan.app.id}:autosave:v1`,
      keys: keyMasks(game.keymap),
      ...(game.documents
        ? {
            editor: {
              storageKey: `pocket-rpgkit:${game.plan.app.id}:document:v1`,
              examples: game.documents.map((document) => ({
                id: document.id,
                title: document.title,
                url: `documents/${document.id}.json`,
              })),
            },
          }
        : {}),
    };
    if (game.documents) {
      const documentsDir = join(dir, "documents");
      mkdirSync(documentsDir, { recursive: true });
      for (const document of game.documents) copyFileSync(document.path, join(documentsDir, `${document.id}.json`));
    }
    await Bun.write(join(dir, "index.html"), renderPlayer(site, game, playerConfig, credits, fontLicenses));
  }

  copyFileSync(WASM_PATH, join(outdir, "pocketjs.wasm"));
  copyFileSync(join(KIT_ROOT, "tools", "web", "site.css"), join(outdir, "site.css"));
  if (games.some((game) => game.id === PREVIEW_APP_ID)) {
    copyFileSync(join(KIT_ROOT, "tools", "web", "preview-demo.html"), join(outdir, "preview-demo.html"));
  }
  const player = await Bun.build({
    entrypoints: [join(KIT_ROOT, "tools", "web", "player.js")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!player.success || player.outputs.length !== 1) {
    for (const log of player.logs) console.error(log);
    throw new Error("web: bundling tools/web/player.js failed");
  }
  await Bun.write(join(outdir, "player.js"), player.outputs[0]!);
  const studio = config.studio ? await buildStudioSite(projectRoot, outdir, config.studio) : undefined;
  await Bun.write(join(outdir, "index.html"), renderLanding({ ...site, ...(studio ? { studio } : {}) }, cards));
  await Bun.write(
    join(outdir, "games.json"),
    JSON.stringify(
      games.map((game) => ({
        id: game.id,
        title: game.title,
        app: game.plan.app.output,
        viewport: game.viewport,
        rasterDensity: game.plan.viewport.rasterDensity,
        planHash: game.plan.planHash,
      })),
      null,
      2,
    ) + "\n",
  );
  console.log(`web: ${games.length} game(s) in ${outdir} (${games.map((game) => game.id).join(", ")})`);
  return games;
}

// ---- CLI -------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): BuildOptions & { help: boolean } {
  let projectRoot: string | undefined;
  let outdir: string | undefined;
  let config: string | undefined;
  const games: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    const flag = /^--(project-root|outdir|config)(?:=(.*))?$/.exec(arg);
    if (flag) {
      const value = flag[2] ?? argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`web: ${arg} needs a value`);
      if (flag[1] === "project-root") projectRoot = value;
      else if (flag[1] === "outdir") outdir = value;
      else config = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`web: unknown option ${arg}`);
    games.push(arg);
  }
  const root = resolve(projectRoot ?? KIT_ROOT);
  return {
    projectRoot: root,
    outdir: resolve(outdir ?? join(root, "dist", "web")),
    ...(config ? { config } : {}),
    games,
    help,
  };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        "usage: bun tools/web.ts [game...] [--project-root <dir>] [--outdir <dir>] [--config <web.json>]\n" +
          "Builds <project-root>/dist/web: a landing page and one player page per game.",
      );
    } else {
      await buildWebSite(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
