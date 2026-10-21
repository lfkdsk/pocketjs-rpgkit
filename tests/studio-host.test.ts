// Studio's host boundary (editor/studio/host.ts): the UI reaches storage,
// files, downloads, processes and preferences only through a StudioHost.
// These tests (1) scan editor/studio/ (every script and page, recursively)
// so browser APIs stay inside the browser host, (2) check that the page shell
// gets its pre-paint boot script from that host at build time, and (3) run Studio's document flow — open, edit, save, restore,
// export, folders saved in place — on the in-memory host, with no DOM.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShardedPack } from "../editor/api/pack.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import type { HostFeature } from "../editor/studio/host.ts";
import { browserBootScript, THEME_KEY } from "../editor/studio/host-browser-boot.ts";
import { MemoryDirectory, MemoryHost } from "../editor/studio/host-memory.ts";
import { openProjectDirectory, saveProjectDirectory } from "../editor/studio/project-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { buildStudio, HOST_BOOT_PLACEHOLDER } from "../tools/studio-build.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const STUDIO = join(ROOT, "editor", "studio");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

// ---- the boundary ---------------------------------------------------------------

/** Browser APIs that belong to a host: storage, files, downloads, network,
 * dialogs, OS preferences and page lifecycle. */
const HOST_ONLY: [string, RegExp][] = [
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["navigator.storage", /\bnavigator\.storage\b/],
  ["URL.createObjectURL", /\bURL\.createObjectURL\b/],
  ["URL.revokeObjectURL", /\bURL\.revokeObjectURL\b/],
  ["new Blob", /\bnew Blob\(/],
  ["FileReader", /\bFileReader\b/],
  ["fetch()", /(?<![.\w])fetch\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["file input", /type:\s*["']file["']|\.type\s*=\s*["']file["']|<input\b[^>]*\btype\s*=\s*["']?file\b/i],
  ["download link", /\.download\s*=|\bdownload:\s*[^,}]*\.json/],
  ["File System Access pickers", /\bshow(?:Directory|OpenFile|SaveFile)Picker\b/],
  // Bare calls only: a host method *declaration* `confirm(text: string)` is fine.
  ["window.confirm / confirm()", /\bwindow\.confirm\b|^(?!\s*(?:async\s+)?confirm\([^)]*\)\s*:).*(?<![.\w])confirm\(/m],
  ["window.alert / prompt", /\bwindow\.(?:alert|prompt)\b|^(?!\s*(?:async\s+)?(?:alert|prompt)\([^)]*\)\s*:).*(?<![.\w])(?:alert|prompt)\(/m],
  ["matchMedia", /\bmatchMedia\b/],
  ["beforeunload", /["']beforeunload["']|\bonbeforeunload\b/i],
  // The play-test's game page: embedding it and talking to it is the host's.
  ["postMessage", /\bpostMessage\s*\(/],
  ["message events", /addEventListener\(\s*["']message["']|\bonmessage\b/],
  ["iframe", /\biframe\b|\bHTMLIFrameElement\b|\bcontentWindow\b|\bcontentDocument\b/i],
  ["embedded documents", /<(?:embed|object|frame)\s|(?:\bh|createElement)\(\s*["'](?:embed|object|frame)["']/i],
  ["other windows", /\bwindow\.(?:parent|top|opener|open)\b|\bwindow\.frames\b/],
  ["message channels", /\b(?:MessageChannel|BroadcastChannel)\b/],
];

/** The hosts: the only files that may use HOST_ONLY APIs. The desktop host
 * runs in the desktop app's page and reuses the browser's preview iframe. */
const HOST_IMPLEMENTATIONS = new Set([
  "host-browser.ts",
  "host-browser-boot.ts",
  "host-desktop.ts",
  "host-desktop-boot.ts",
  "rpgmaker-import-browser.ts",
  "rpgmaker-import-browser-io.ts",
  "rpgmaker-import-browser-pack.ts",
  "rpgmaker-import-browser-source.ts",
]);
const SCANNED = /\.(?:ts|tsx|js|html)$/;

/** Source without comments, so prose may name the APIs it avoids. An .html
 *  page is scanned whole (inline scripts, on* attributes, markup) minus its
 *  HTML comments. */
function code(source: string, html = false): string {
  const text = html ? source.replace(/<!--[\s\S]*?-->/g, "") : source;
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function violations(source: string, html = false): string[] {
  const body = code(source, html);
  return HOST_ONLY.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
}

/** Every scanned file under editor/studio/, as a path relative to it. */
function studioFiles(dir = STUDIO, prefix = ""): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return studioFiles(path, `${prefix}${name}/`);
    return SCANNED.test(name) ? [`${prefix}${name}`] : [];
  });
}

const isHost = (path: string): boolean => HOST_IMPLEMENTATIONS.has(path.split("/").at(-1)!);
const scan = (path: string): string[] => violations(readFileSync(join(STUDIO, path), "utf8"), path.endsWith(".html"));
const count = (text: string, part: string): number => text.split(part).length - 1;

describe("Studio host boundary", () => {
  const files = studioFiles();
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  test("no Studio file outside the hosts calls host-only browser APIs", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
    expect(files).toContain("index.html");
    expect(files.filter(isHost).sort()).toEqual([
      "host-browser-boot.ts",
      "host-browser.ts",
      "host-desktop-boot.ts",
      "host-desktop.ts",
      "rpgmaker-import-browser-io.ts",
      "rpgmaker-import-browser-pack.ts",
      "rpgmaker-import-browser-source.ts",
      "rpgmaker-import-browser.ts",
    ]);
    const found = Object.fromEntries(files
      .filter((path) => !isHost(path))
      .map((path) => [path, scan(path)])
      .filter(([, hits]) => hits.length > 0));
    expect(found).toEqual({});
  });

  test("the scan recognises each API (the browser host uses them; planted calls are caught)", () => {
    const browser = violations(readFileSync(join(STUDIO, "host-browser.ts"), "utf8"));
    for (const name of ["localStorage", "URL.createObjectURL", "new Blob", "fetch()", "file input", "download link", "File System Access pickers", "window.confirm / confirm()", "matchMedia", "beforeunload", "postMessage", "message events", "iframe"]) {
      expect(browser).toContain(name);
    }
    const planted: [string, string][] = [
      ["localStorage", `const x = localStorage.getItem("k");`],
      ["fetch()", `await fetch("examples.json");`],
      ["window.confirm / confirm()", `if (confirm("sure?")) go();`],
      ["file input", `h("input", { type: "file" })`],
      ["download link", `link.download = name;`],
      ["URL.createObjectURL", `image.src = URL.createObjectURL(file);`],
      ["postMessage", `frame.contentWindow.postMessage(message, origin);`],
      ["message events", `window.addEventListener("message", onMessage);`],
      ["iframe", `const frame = document.createElement("iframe");`],
      ["iframe", `h("iframe", { src: "../preview/" })`],
      ["embedded documents", `h("object", { data: "../preview/" })`],
      ["embedded documents", `document.createElement("embed")`],
      ["other windows", `window.parent.postMessage(x, "*")`],
      ["other windows", `const w = window.open("../preview/");`],
      ["message channels", `const channel = new MessageChannel();`],
      ["message channels", `new BroadcastChannel("studio")`],
    ];
    for (const [name, line] of planted) expect(violations(line)).toContain(name);
    // The boot snippet is host code too.
    expect(scan("host-browser-boot.ts")).toEqual(["localStorage", "matchMedia"]);
    // Host calls of the same names are fine, and comments are ignored.
    expect(violations(`await this.host.confirm("x"); // localStorage is the host's business`)).toEqual([]);
    expect(violations(`  async confirm(text: string): Promise<boolean> {`)).toEqual([]);
    expect(violations(`  const ok = await confirm(text);`)).toContain("window.confirm / confirm()");
  });

  test("the page shell marks the host boot slot once and calls no browser APIs", () => {
    const html = readFileSync(join(STUDIO, "index.html"), "utf8");
    expect(HOST_BOOT_PLACEHOLDER).toBe("<!-- studio:host-boot -->");
    expect(count(html, HOST_BOOT_PLACEHOLDER)).toBe(1);
    expect(violations(html, true)).toEqual([]);
    // Only the module script; no inline script of its own.
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script type="module" src="studio.js">']);
  });

  test("the built page carries the browser host's boot script once, reading its theme key", async () => {
    const temp = mkdtempSync(join(tmpdir(), "rpgkit-studio-host-"));
    tempDirs.push(temp);
    const entry = join(temp, "entry.ts");
    writeFileSync(entry, 'document.body.textContent = "studio";\n');
    await buildStudio({ outdir: join(temp, "site"), entry });
    const built = readFileSync(join(temp, "site", "studio", "index.html"), "utf8");
    const boot = browserBootScript();
    expect(THEME_KEY).toBe("pocket-rpgkit:studio:theme");
    expect(boot).toContain(`localStorage.getItem(${JSON.stringify(THEME_KEY)})`);
    expect(count(built, boot)).toBe(1);
    expect(count(built, "<script>")).toBe(1);
    expect(built).not.toContain(HOST_BOOT_PLACEHOLDER);
    expect(built).toBe(readFileSync(join(STUDIO, "index.html"), "utf8").replace(HOST_BOOT_PLACEHOLDER, () => boot));
    expect(violations(built, true)).toEqual(["localStorage", "matchMedia"]);
  });

  test("the page scan has teeth: planted browser calls in HTML are caught, commented ones are not", () => {
    const page = (body: string): string => `<!doctype html>\n<head>\n${body}\n</head>\n<body></body>\n`;
    expect(violations(page(`<script>var t = localStorage.getItem("k");</script>`), true)).toContain("localStorage");
    expect(violations(page(`<script>if (matchMedia("(prefers-color-scheme: dark)").matches) go();</script>`), true)).toContain("matchMedia");
    expect(violations(page(`<button onclick="localStorage.clear()">x</button>`), true)).toContain("localStorage");
    expect(violations(page(`<body onbeforeunload="return 1">`), true)).toContain("beforeunload");
    expect(violations(page(`<input type="file" id="open">`), true)).toContain("file input");
    expect(violations(page(`<object data="../preview/"></object>`), true)).toContain("embedded documents");
    expect(violations(page(`<iframe src="../preview/"></iframe>`), true)).toContain("iframe");
    expect(violations(page(`<!-- localStorage and matchMedia belong to the host -->`), true)).toEqual([]);
  });

  test("the UI builds its host in one place and is typed against the interface", () => {
    const main = readFileSync(join(STUDIO, "main.ts"), "utf8");
    // The web page builds the browser host; the desktop entry builds its host
    // first and leaves it for main.ts.
    expect(main).toContain("const host: StudioHost = (globalThis as { studioHost?: StudioHost }).studioHost ?? new BrowserHost();");
    const constructing = files.filter((path) => /new BrowserHost\(/.test(code(readFileSync(join(STUDIO, path), "utf8"), path.endsWith(".html"))));
    expect(constructing).toEqual(["main.ts"]);
    const desktop = files.filter((path) => /createDesktopHost\(|new DesktopHost\(/.test(code(readFileSync(join(STUDIO, path), "utf8"), path.endsWith(".html"))));
    expect(desktop.sort()).toEqual(["host-desktop.ts", "main-desktop.ts"]);
    const files_ts = readFileSync(join(STUDIO, "files.ts"), "utf8");
    expect(files_ts).not.toMatch(/host-browser/);
  });
});

// ---- the document flow on the memory host -------------------------------------------

class HeadlessArtRegistry extends ArtRegistry {
  override loadProjectSheet(_id: string, _path: string, _url: string): Promise<void> {
    return Promise.resolve();
  }
}

function studio(host = new MemoryHost(), art: ArtRegistry = new ArtRegistry()): { host: MemoryHost; app: StudioApp; files: StudioFiles } {
  const app = new StudioApp();
  return { host, app, files: new StudioFiles(app, art, host) };
}

async function pick(host: MemoryHost, name: string, text: string): Promise<void> {
  host.filePicks.push({ name, text });
  host.pickProjectFile();
  await Bun.sleep(0);
}

function looseSunstone(): MemoryDirectory {
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  const files = new Map<string, string>([["project.json", split.shellText], ["README.txt", "not a project"]]);
  for (const entry of split.entries) files.set(entry.path, entry.text);
  return new MemoryDirectory("sunstone/", files);
}

describe("Studio on the memory host", () => {
  test("capabilities cover every feature, each with a reason", () => {
    const features: HostFeature[] = ["openFile", "openDirectory", "rpgMakerImport", "saveInPlace", "storage", "export", "localArt", "checks", "dynamicChecks", "agent", "preview"];
    const caps = new MemoryHost().capabilities();
    expect(Object.keys(caps).sort()).toEqual([...features].sort());
    for (const feature of features) expect(caps[feature].reason.length).toBeGreaterThan(5);
    expect(caps.agent.available).toBe(false);
  });

  test("open, edit, save to storage, restore in a fresh Studio", async () => {
    const { host, app, files } = studio();
    await pick(host, "sunstone.json", SUNSTONE);
    expect(app.session?.kind).toBe("inline");
    expect(app.origin).toEqual({ label: "sunstone.json", savesTo: "storage" });
    app.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
    expect(app.session!.isDirty()).toBe(true);
    expect(await files.save()).toBe(true);
    expect(app.session!.isDirty()).toBe(false);
    expect(files.lastSavedWhere).toBe("storage");
    expect(host.stored?.text).toBe(app.session!.exportText());
    expect(host.stored?.fileName).toBe("sunstone.json");

    const second = studio(host);
    expect(second.files.restore()).toBe(true);
    expect(second.app.session!.exportText()).toBe(host.stored!.text);
    expect(second.app.session!.isDirty()).toBe(false);
    expect(second.app.notices.at(-1)?.text).toBe("Restored “sunstone.json” saved earlier.");
  });

  test("a failed save keeps the document dirty and says why", async () => {
    const { host, app, files } = studio();
    host.storageFails = true;
    await pick(host, "sunstone.json", SUNSTONE);
    app.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
    expect(await files.save()).toBe(false);
    expect(app.session!.isDirty()).toBe(true);
    expect(app.notices.at(-1)).toMatchObject({ level: "error", text: "Not saved: storage is switched off." });
    expect(host.stored).toBeNull();
  });

  test("download hands the exact export bytes to the host", async () => {
    const { host, app, files } = studio();
    await pick(host, "village", SUNSTONE);
    await files.download();
    expect(host.exports).toEqual([{ fileName: "village.json", text: app.session!.exportText() }]);
    expect(app.notices.at(-1)?.text).toBe("Exported village.json.");
  });

  test("opening over unsaved edits asks the host, and a no keeps the edits", async () => {
    const { host, app } = studio();
    await pick(host, "a.json", SUNSTONE);
    app.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
    const edited = app.session!.exportText();
    host.confirmAnswer = false;
    await pick(host, "b.json", SUNSTONE);
    expect(host.questions).toEqual(["The open document has unsaved changes. Discard them?"]);
    expect(app.origin?.label).toBe("a.json");
    expect(app.session!.exportText()).toBe(edited);
    host.confirmAnswer = true;
    await pick(host, "b.json", SUNSTONE);
    expect(app.origin?.label).toBe("b.json");
  });

  test("examples come from the host", async () => {
    const { host, app, files } = studio();
    host.examples = [{ id: "sunstone", title: "Sunstone", document: "examples/sunstone.json", sheets: {}, sprites: {} }];
    host.exampleTexts.set("sunstone", SUNSTONE);
    await files.loadExamples();
    expect(await files.openExample("sunstone")).toBe(true);
    expect(app.session!.exportText()).toBe(SUNSTONE);
    expect(files.fileName).toBe("sunstone.json");
    expect(await files.openExample("missing")).toBe(false);
  });

  test("checks run through the host; the agent says it needs the desktop app", async () => {
    const host = new MemoryHost();
    const checks = await host.runChecks({ project: JSON.parse(SUNSTONE) as Project, mode: "lint" });
    expect(checks.ok).toBe(true);
    const dynamic = await host.runChecks({ project: JSON.parse(SUNSTONE) as Project, mode: "dynamic" });
    expect(dynamic).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    const agent = await host.runAgent();
    expect(agent).toMatchObject({ ok: false, code: "NEEDS_DESKTOP" });
    if (!agent.ok) expect(agent.message).toMatch(/desktop app/);
  });

  test("theme preference and system theme changes go through the host", () => {
    const host = new MemoryHost();
    let changes = 0;
    host.onSystemThemeChange(() => changes++);
    host.setTheme("dark");
    expect(host.theme()).toBe("dark");
    host.setSystemDark(true);
    expect(host.systemPrefersDark()).toBe(true);
    expect(changes).toBe(1);

    let motionChanges = 0;
    host.onSystemMotionChange(() => motionChanges++);
    host.setPreferences({ motion: "reduced", favoriteTiles: ["town.4"], recentCommands: ["view:fit"] });
    expect(host.preferences()).toEqual({ motion: "reduced", favoriteTiles: ["town.4"], recentCommands: ["view:fit"] });
    host.setSystemReducedMotion(true);
    expect(host.systemPrefersReducedMotion()).toBe(true);
    expect(motionChanges).toBe(1);
  });
});

// ---- loose sharded folders --------------------------------------------------------

describe("Studio folders (loose sharded projects) on the memory host", () => {
  test("a folder opens as a pack and Save writes back only the edited shard and the shell", async () => {
    const { host, app, files } = studio();
    const dir = looseSunstone();
    const before = new Map(dir.files);
    host.directoryPicks.push(dir);
    await files.openDirectory();
    await Bun.sleep(0);
    expect(app.session?.kind).toBe("pack");
    expect(files.target?.name).toBe("sunstone/");
    expect(app.origin).toEqual({ label: "sunstone/", savesTo: "sunstone/" });
    expect(files.fileName).toBe("sunstone-pack.json");
    expect(app.notices.at(-1)?.text).toBe("Opened sharded pack sunstone/. Save writes back into sunstone/.");

    app.run("paint-cells", { map: "forest", layer: "ground", cells: [[1, 1], [2, 1]], value: "town.37" });
    expect(await files.save()).toBe(true);
    expect(dir.writes).toEqual(["maps/forest.json", "project.json"]);
    expect(app.notices.at(-1)?.text).toBe("Saved to sunstone/: 2 files written.");
    expect(app.session!.isDirty()).toBe(false);
    const pack = parseShardedPack(app.session!.exportText());
    expect(dir.files.get("project.json")).toBe(pack.shellText);
    for (const [entry, text] of pack.shards) expect(dir.files.get(entry)).toBe(text);
    const changed = [...dir.files.keys()].filter((path) => dir.files.get(path) !== before.get(path)).sort();
    expect(changed).toEqual(["maps/forest.json", "project.json"]);

    // A second save with nothing new writes nothing; reopening reads the edit.
    dir.writes = [];
    expect(await files.save()).toBe(true);
    expect(dir.writes).toEqual([]);
    const again = await openProjectDirectory(dir);
    expect(again.packText).toBe(app.session!.exportText());
  });

  test("existing folder art does not block map-only saves", async () => {
    const { host, app, files } = studio(new MemoryHost(), new HeadlessArtRegistry());
    const dir = looseSunstone();
    const art = readFileSync(join(ROOT, "examples", "sunstone", "assets", "player-dir1.png"));
    dir.binary.set("art/sheets/town.png", art);
    host.directoryPicks.push(dir);
    await files.openDirectory();
    await Bun.sleep(0);
    expect(app.session!.assets().has("art/sheets/town.png")).toBe(true);
    expect(app.session!.assetsDirty()).toBe(false);

    app.run("paint-cells", { map: "forest", layer: "ground", cells: [[1, 1]], value: "town.37" });
    expect(app.session!.isDirty()).toBe(true);
    expect(app.session!.assetsDirty()).toBe(false);
    expect(await files.save()).toBe(true);
    expect(dir.writes).toEqual(["maps/forest.json", "project.json"]);
    expect(dir.binary.get("art/sheets/town.png")).toEqual(art);
    expect(app.session!.isDirty()).toBe(false);
  });

  test("newly imported art is not acknowledged by a folder save that cannot write it", async () => {
    const { host, app, files } = studio(new MemoryHost(), new HeadlessArtRegistry());
    const dir = looseSunstone();
    host.directoryPicks.push(dir);
    await files.openDirectory();
    await Bun.sleep(0);
    const art = readFileSync(join(ROOT, "examples", "sunstone", "assets", "player-dir1.png"));
    const grid = { cellWidth: 16, cellHeight: 16, offsetX: 0, offsetY: 0, spacingX: 0, spacingY: 0 };
    expect(app.importPng({ kind: "sheet", id: "local", bytes: art, grid, map: "forest" }, art).ok).toBe(true);
    expect(app.session!.assetsDirty()).toBe(true);

    expect(await files.save()).toBe(false);
    expect(dir.writes).toEqual([]);
    expect(app.session!.isDirty()).toBe(true);
    expect(app.notices.at(-1)?.text).toBe("Not saved: folder saves cannot write imported PNG art. Export a self-contained project pack instead.");
  });

  test("a file changed on disk since opening blocks the save and nothing is written", async () => {
    const { host, app, files } = studio();
    const dir = looseSunstone();
    host.directoryPicks.push(dir);
    await files.openDirectory();
    await Bun.sleep(0);
    app.run("paint-cells", { map: "forest", layer: "ground", cells: [[1, 1]], value: "town.37" });
    dir.files.set("project.json", `${dir.files.get("project.json")} `);
    expect(await files.save()).toBe(false);
    expect(dir.writes).toEqual([]);
    expect(app.notices.at(-1)?.text).toBe("Not saved to sunstone/: project.json changed on disk since it was opened; nothing was written");
    expect(app.session!.isDirty()).toBe(true);
  });

  test("the shell is project.json, else game.json, else the only top-level JSON; anything else is refused with a reason", async () => {
    const { host, app, files } = studio();
    host.directoryPicks.push(new MemoryDirectory("empty/", { "notes.json": "{}" }));
    await files.openDirectory();
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)?.text).toBe("Could not open empty/: empty/: notes.json is not a project shell (a JSON file with a mapIndex). Use Open file for single-file projects and packs.");
    await expect(openProjectDirectory(new MemoryDirectory("none/", { "README.txt": "hi" }))).rejects.toThrow("none/ has no JSON file at its top level");

    const many = looseSunstone();
    const shell = many.files.get("project.json")!;
    many.files.set("other.json", shell);
    many.files.set("alt.json", shell);
    // project.json wins and is the only top-level file read.
    expect((await openProjectDirectory(many)).baseline.shellPath).toBe("project.json");
    expect(many.reads.filter((path) => !path.includes("/"))).toEqual(["project.json"]);
    many.files.delete("project.json");
    many.files.set("game.json", shell);
    expect((await openProjectDirectory(many)).baseline.shellPath).toBe("game.json");
    many.files.delete("game.json");
    many.reads = [];
    await expect(openProjectDirectory(many)).rejects.toThrow("sunstone/ has 2 JSON files at its top level (alt.json, other.json) and none is named project.json or game.json");
    expect(many.reads).toEqual([]);
    // A lone top-level JSON shell may have any name.
    many.files.delete("other.json");
    expect((await openProjectDirectory(many)).baseline.shellPath).toBe("alt.json");
  });

  test("shards resolve relative to the shell, and unsafe entries are refused", async () => {
    const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
    const nested = new MemoryDirectory("nested/", new Map([["project.json", split.shellText], ...split.entries.map((entry): [string, string] => [entry.path, entry.text])]));
    const opened = await openProjectDirectory(nested);
    expect(opened.shardCount).toBe(3);
    const wrong = new Map(opened.baseline.shards);
    wrong.delete("maps/cave.json");
    await expect(saveProjectDirectory(nested, { ...opened.baseline, shards: wrong }, opened.packText)).rejects.toThrow(/adds, removes or renames shard files/);
    nested.files.delete("maps/cave.json");
    await expect(openProjectDirectory(nested)).rejects.toThrow(/cannot read shard maps\/cave\.json/);
  });
});
