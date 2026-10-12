// studio-desktop/src/main.ts — the Electron main process of Studio's desktop
// app. Studio itself is the web build (tools/studio-build.ts) with a desktop
// host (editor/studio/host-desktop.ts); this process gives it what a web page
// cannot have:
//
//   files     project files and project folders opened from native dialogs
//             and saved in place (folders through editor/api/file.ts: staged,
//             rechecked, shards first and the shell last, rolled back on a
//             failed rename, under the lock rpgkit-edit takes)
//   agent     a local agent process (the kit's agent launcher, in the helper)
//             whose edits come back as proposals for review
//   checks    rpgkit-check's engine checks (locks, freeze, reach), in the helper
//   import    native source/destination pickers; the Bun helper converts into
//             a staged sibling which is atomically published and then opened
//   window    menus, shortcuts, recent projects, a prompt before closing with
//             unsaved changes
//
// The page is served from app://studio/ (studio/ and the play-test's preview/
// player side by side, so the preview keeps working same-origin) with a
// strict Content Security Policy. It runs sandboxed with context isolation
// and no Node; preload.ts gives it a fixed set of IPC calls, and every IPC
// handler here checks the sender is Studio's own top-level page. The page
// never sees a real path: opened files and folders are named by random
// tokens, and folder access is confined to the folder the user picked
// (fs-directory.ts).

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { atomicWriteProjectFile, withProjectFileLock } from "../../editor/api/file.ts";
import { openFileProblem, PNG_HEADER_BYTES, pngProblem } from "../../editor/api/limits.ts";
import type { BootReply, DesktopRpgMakerImportOutcome, MenuCommand, OpenReply, RecentEntry, SaveRequest } from "../../editor/studio/desktop-bridge.ts";
import type { AgentOutcome, CheckOutcome, HostCapabilities, RpgMakerImportProgress, RpgMakerImportRequest, SaveOutcome, SaveTarget, StoredProject } from "../../editor/studio/host.ts";
import { openDirectoryProject, saveDirectoryTarget } from "../../editor/studio/project-directory.ts";
import type { StudioProblem } from "../../editor/studio/problems.ts";
import { FsDirectory } from "./fs-directory.ts";
import { HelperClient, locateHelper } from "./helper-client.ts";
import type { ImportResult as HelperImportResult } from "./helper-protocol.ts";

const SCHEME = "app";
const ORIGIN = `${SCHEME}://studio`;
const STUDIO_PAGE = `${ORIGIN}/studio/index.html`;
const DOCS_URL = "https://github.com/lfkdsk/pocketjs-rpgkit/blob/main/docs/studio-desktop.md";
const HELPER_NAME = process.platform === "win32" ? "rpgkit-studio-helper.exe" : "rpgkit-studio-helper";
const RECENT_LIMIT = 10;
const CHECK_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

// ---- command line --------------------------------------------------------------------

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** Paths given on the command line (or by "Open with"): not flags, not the
 * executable, and not the app itself (`electron app/main.cjs` in a checkout,
 * where Chromium flags may come before it). */
function pathArguments(argv: readonly string[]): string[] {
  const own = new Set([process.execPath, APP_DIR, join(APP_DIR, "main.cjs")].map((path) => resolve(path)));
  return argv.slice(1).filter((arg) => !arg.startsWith("-") && arg !== "." && !own.has(resolve(arg)));
}

// A separate profile (tests, side-by-side builds) must be chosen before ready.
const userDataFlag = flag("studio-user-data");
if (userDataFlag) app.setPath("userData", userDataFlag);

// ---- the app:// scheme -----------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** app/ in a checkout (next to main.cjs), app.asar when packaged. The
 * bundler fixes __dirname at build time, so it is not used. */
const APP_DIR = app.getAppPath();
const SITE = join(APP_DIR, "site");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".pak": "application/octet-stream",
};

/** Studio: its own scripts only (no inline script), the play-test page in a
 * same-origin frame, local images and blob: art the user picked. Inline style
 * attributes are allowed; Studio's DOM helpers set them. */
const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The play-test player: the same, plus WebAssembly and eval (the web
 * player starts the bundled game script with Function), and it may only be
 * framed by Studio. It runs only the app's own bundled scripts; a project
 * document is data the engine reads, never evaluated. */
const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Serve app://studio/<path> from the bundled site, refusing anything that
 * resolves outside it. */
async function serveSite(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== "studio" || request.method !== "GET") return new Response("not found", { status: 404 });
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (path.endsWith("/")) path += "index.html";
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === "." || part.includes("\\") || part.includes("\0"))) {
    return new Response("bad path", { status: 400 });
  }
  const file = join(SITE, ...parts);
  const fromSite = relative(SITE, file);
  if (fromSite.startsWith(`..${sep}`) || fromSite === "..") return new Response("not found", { status: 404 });
  try {
    if (!(await stat(file)).isFile()) return new Response("not found", { status: 404 });
    const body = await readFile(file);
    const headers: Record<string, string> = {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    if (extname(file) === ".html") headers["content-security-policy"] = parts[0] === "preview" ? PREVIEW_CSP : STUDIO_CSP;
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// ---- small file helpers -----------------------------------------------------------------

function userFile(name: string): string {
  return join(app.getPath("userData"), name);
}

/** Write through a temporary sibling and rename it into place. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- opened documents ----------------------------------------------------------------------

/** What a token stands for. Only the main process holds real paths. */
type Opened =
  | { kind: "directory"; path: string; dir: FsDirectory; target: SaveTarget }
  | { kind: "file"; path: string; baseline: string };

const opened = new Map<string, Opened>();

function token(): string {
  return randomBytes(16).toString("hex");
}

async function openDirectory(path: string): Promise<OpenReply> {
  let dir: FsDirectory;
  try {
    dir = new FsDirectory(path);
  } catch (error) {
    return { error: `Could not open ${basename(path)}: ${message(error)}` };
  }
  const result = await openDirectoryProject(dir);
  if ("error" in result) return { error: result.error };
  const target = result.target!;
  dir.shellPath = (target.ref as { baseline: { shellPath: string } }).baseline.shellPath;
  const id = token();
  opened.set(id, { kind: "directory", path: dir.root, dir, target });
  addRecent("directory", dir.root);
  return { text: result.text, label: result.label, fileName: result.fileName, target: { kind: "directory", name: target.name, token: id }, ...(result.notes?.length ? { notes: result.notes } : {}) };
}

async function openFile(path: string): Promise<OpenReply> {
  const name = basename(path);
  try {
    const real = realpathSync(path);
    const tooBig = openFileProblem(statSync(real).size, name);
    if (tooBig !== null) return { error: tooBig };
    const text = readFileSync(real, "utf8");
    const id = token();
    opened.set(id, { kind: "file", path: real, baseline: text });
    addRecent("file", real);
    return { text, label: name, fileName: name, target: { kind: "file", name, token: id } };
  } catch (error) {
    return { error: `Could not read ${name}: ${message(error)}` };
  }
}

async function openPath(path: string): Promise<OpenReply> {
  try {
    return statSync(path).isDirectory() ? openDirectory(path) : openFile(path);
  } catch (error) {
    return { error: `Could not open ${basename(path)}: ${message(error)}` };
  }
}

async function save(request: SaveRequest): Promise<SaveOutcome> {
  const savedAt = new Date().toISOString();
  if (request.target !== undefined) {
    const entry = opened.get(request.target);
    if (!entry) return { ok: false, message: "Not saved: Studio no longer knows where this document came from; use Export." };
    if (entry.kind === "directory") return saveDirectoryTarget(entry.target, request.text, savedAt);
    try {
      withProjectFileLock(entry.path, () => atomicWriteProjectFile(entry.path, request.text, entry.baseline));
      entry.baseline = request.text;
      return { ok: true, where: "file", written: [basename(entry.path)], savedAt };
    } catch (error) {
      return { ok: false, message: `Not saved to ${basename(entry.path)}: ${message(error)}` };
    }
  }
  const stored = { v: 1, label: request.label, fileName: request.fileName, text: request.text, savedAt };
  try {
    writeAtomic(userFile("document.json"), JSON.stringify(stored));
    return { ok: true, where: "storage", written: ["document.json"], savedAt };
  } catch (error) {
    return { ok: false, message: `Not saved: ${message(error)}. Export keeps working.` };
  }
}

function restore(): StoredProject | null {
  const stored = readJson<StoredProject & { v?: number }>(userFile("document.json"));
  if (!stored || stored.v !== 1 || typeof stored.text !== "string") return null;
  return { label: String(stored.label), fileName: String(stored.fileName), text: stored.text, savedAt: String(stored.savedAt) };
}

// ---- recent projects ---------------------------------------------------------------------

interface RecentRecord {
  kind: "file" | "directory";
  path: string;
}

function recentId(record: RecentRecord): string {
  return createHash("sha256").update(`${record.kind}\0${record.path}`).digest("hex").slice(0, 16);
}

function loadRecent(): RecentRecord[] {
  const list = readJson<RecentRecord[]>(userFile("recent.json"));
  return Array.isArray(list)
    ? list.filter((item) => item && (item.kind === "file" || item.kind === "directory") && typeof item.path === "string").slice(0, RECENT_LIMIT)
    : [];
}

function addRecent(kind: RecentRecord["kind"], path: string): void {
  const list = [{ kind, path }, ...loadRecent().filter((item) => item.kind !== kind || item.path !== path)].slice(0, RECENT_LIMIT);
  try {
    writeAtomic(userFile("recent.json"), `${JSON.stringify(list, null, 2)}\n`);
  } catch { /* the list is a convenience */ }
  buildMenu();
}

function recentEntries(): RecentEntry[] {
  return loadRecent().map((record) => ({ id: recentId(record), kind: record.kind, name: basename(record.path) + (record.kind === "directory" ? "/" : "") }));
}

// ---- helper: agent and engine checks ------------------------------------------------------

const helper = new HelperClient(locateHelper(
  [join(process.resourcesPath ?? "", "helper", HELPER_NAME), join(APP_DIR, "helper", HELPER_NAME)],
  join(APP_DIR, "..", "src", "helper.ts"),
));

/** The agent configuration: --agent-config=<file>, else agent.json in the
 * profile folder, else the launcher's default (traecli on PATH). */
function agentConfig(): string | undefined {
  const fromFlag = flag("agent-config");
  if (fromFlag) return fromFlag;
  const inProfile = userFile("agent.json");
  try {
    statSync(inProfile);
    return inProfile;
  } catch {
    return undefined;
  }
}

let probed: Promise<{ agent: { available: boolean; reason: string }; checks: { available: boolean; reason: string } }> | null = null;

function probe() {
  probed ??= helper.request("probe", agentConfig() ? { agentConfig: agentConfig() } : {}, PROBE_TIMEOUT_MS).then((reply) => {
    if (reply.ok) return reply.result as Awaited<NonNullable<typeof probed>>;
    probed = null;
    const reason = `The Studio helper did not start: ${reply.error.message}`;
    return { agent: { available: false, reason }, checks: { available: false, reason } };
  });
  return probed;
}

async function capabilities(): Promise<HostCapabilities> {
  const helperState = await probe();
  return {
    openFile: { available: true, reason: "Open a project JSON or a sharded pack; Save writes back to the same file." },
    openDirectory: { available: true, reason: "Open a folder holding project.json and its map files; Save writes the changed files back into it." },
    rpgMakerImport: helper.available
      ? { available: true, reason: "Imports an RPG Maker MV/MZ folder into a new Pocket RPG Kit project folder on this computer." }
      : { available: false, reason: "RPG Maker import needs the Studio helper, which is missing from this build." },
    saveInPlace: {
      available: true,
      reason: "Files and folders save where they came from. A folder save stages every changed file, checks nothing changed on disk, then replaces the map files and the shell last, putting back the replaced ones if a step fails.",
    },
    storage: { available: true, reason: "Save keeps a document that came from no file in Studio's profile folder and restores it next time." },
    export: { available: true, reason: "Export writes the exact export bytes to a file you choose." },
    localArt: { available: true, reason: "Chosen PNGs are used in this window only; they are not copied or saved." },
    checks: { available: true, reason: "Schema validation and rpgkit-check's static lint run in the window." },
    dynamicChecks: helperState.checks.available
      ? { available: true, reason: "Runs rpgkit-check's engine checks (locks, freeze, reach) on this computer." }
      : { available: false, reason: helperState.checks.reason },
    agent: helperState.agent.available
      ? { available: true, reason: `${helperState.agent.reason}. Agents propose edits to single-file projects; you review each proposal.` }
      : { available: false, reason: `Local agent unavailable: ${helperState.agent.reason}` },
    preview: { available: true, reason: "Plays the open document in the real game engine, inside Studio." },
  };
}

let checkRun = 0;

async function runChecks(request: { project: unknown; mode: string }): Promise<CheckOutcome> {
  if (request.mode !== "dynamic") return { ok: false, code: "UNAVAILABLE", message: "Lint runs in the window." };
  if (!request.project || typeof request.project !== "object") return { ok: false, code: "FAILED", message: "No project to check." };
  const runId = `check-${++checkRun}`;
  const reply = await helper.request("check", { runId, projectText: JSON.stringify(request.project) }, CHECK_TIMEOUT_MS);
  if (!reply.ok) {
    if (reply.error.code === "TIMED_OUT") void helper.request("cancel", { runId });
    return { ok: false, code: reply.error.code === "UNAVAILABLE" ? "UNAVAILABLE" : "FAILED", message: `Engine checks did not finish: ${reply.error.message}` };
  }
  return { ok: true, problems: (reply.result as { problems: StudioProblem[] }).problems };
}

// ---- RPG Maker import ----------------------------------------------------------------------

interface ActiveImport {
  token: string;
  runId: string | null;
  cancelled: boolean;
}

let activeImport: ActiveImport | null = null;

function importFailure(
  token: string,
  code: Extract<DesktopRpgMakerImportOutcome, { ok: false }>["code"],
  detail: string,
): DesktopRpgMakerImportOutcome {
  return { ok: false, token, code, message: detail };
}

function importProgress(sender: Electron.WebContents, progress: RpgMakerImportProgress): void {
  if (!sender.isDestroyed()) sender.send("studio:rpgmaker-import-progress", progress);
}

async function chooseDirectory(title: string, defaultPath?: string, create = false): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    properties: create ? ["openDirectory", "createDirectory"] : ["openDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!;
}

async function importRpgMaker(
  request: RpgMakerImportRequest,
  sender: Electron.WebContents,
): Promise<DesktopRpgMakerImportOutcome> {
  if (activeImport) {
    return importFailure(request.token, "BUSY", "Another RPG Maker import is already running. / 另一个 RPG Maker 导入正在进行中。");
  }
  const active: ActiveImport = { token: request.token, runId: null, cancelled: false };
  activeImport = active;
  let staging: string | null = null;
  try {
    importProgress(sender, {
      token: request.token,
      phase: "selecting",
      message: "Choose the RPG Maker project folder / 选择 RPG Maker 项目文件夹",
    });
    const pickedSource = await chooseDirectory("Select RPG Maker project folder / 选择 RPG Maker 项目文件夹");
    if (active.cancelled || !pickedSource) {
      return importFailure(request.token, "CANCELLED", "RPG Maker import cancelled. / 已取消 RPG Maker 导入。");
    }

    let sourceDir: string;
    try {
      sourceDir = realpathSync(pickedSource);
      if (!statSync(sourceDir).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      return importFailure(request.token, "INVALID_SOURCE", `The selected source folder cannot be read / 无法读取所选源文件夹: ${message(error)}`);
    }

    importProgress(sender, {
      token: request.token,
      phase: "selecting",
      message: "Choose where to create the imported project / 选择导入项目的创建位置",
    });
    const pickedParent = await chooseDirectory(
      "Select destination parent folder / 选择导入位置",
      dirname(sourceDir),
      true,
    );
    if (active.cancelled || !pickedParent) {
      return importFailure(request.token, "CANCELLED", "RPG Maker import cancelled. / 已取消 RPG Maker 导入。");
    }

    let parent: string;
    try {
      parent = realpathSync(pickedParent);
      if (!statSync(parent).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      return importFailure(request.token, "IMPORT_FAILED", `The selected destination folder cannot be used / 无法使用所选目标文件夹: ${message(error)}`);
    }
    const sourceName = basename(sourceDir) || "rpgmaker-project";
    const outputName = `${sourceName}-rpgkit`;
    const outputDir = join(parent, outputName);
    if (existsSync(outputDir)) {
      return importFailure(
        request.token,
        "IMPORT_FAILED",
        `A folder named ${outputName} already exists. Nothing was overwritten; choose another destination. / 已存在名为 ${outputName} 的文件夹。未覆盖任何内容，请选择其他位置。`,
      );
    }

    try {
      staging = mkdtempSync(join(parent, `.${outputName}.import-`));
    } catch (error) {
      return importFailure(request.token, "IMPORT_FAILED", `Could not create a staging folder / 无法创建暂存文件夹: ${message(error)}`);
    }

    importProgress(sender, {
      token: request.token,
      phase: "reading",
      message: "Reading the RPG Maker project / 正在读取 RPG Maker 项目",
    });
    const runId = randomUUID();
    active.runId = runId;
    const unsubscribe = helper.onEvent((event) => {
      if (event.event === "import-progress" && event.runId === runId && !active.cancelled) {
        importProgress(sender, { token: request.token, phase: "converting", message: String(event.message ?? "") });
      }
    });
    let reply;
    try {
      reply = await helper.request("import", {
        runId,
        sourceDir,
        outputDir: staging,
        placeholders: request.placeholders,
      });
    } finally {
      unsubscribe();
      active.runId = null;
    }
    if (active.cancelled || (!reply.ok && reply.error.code === "CANCELLED")) {
      return importFailure(request.token, "CANCELLED", "RPG Maker import cancelled. / 已取消 RPG Maker 导入。");
    }
    if (!reply.ok) {
      const code = reply.error.code === "BAD_REQUEST" ? "INVALID_SOURCE" : "IMPORT_FAILED";
      return importFailure(request.token, code, reply.error.message);
    }
    const summary = reply.result as HelperImportResult;

    importProgress(sender, {
      token: request.token,
      phase: "writing",
      message: `Publishing ${outputName} without overwriting files / 正在发布 ${outputName}（不会覆盖文件）`,
    });
    if (existsSync(outputDir)) {
      return importFailure(
        request.token,
        "IMPORT_FAILED",
        `A folder named ${outputName} appeared while importing. Nothing was overwritten. / 导入过程中出现了名为 ${outputName} 的文件夹，未覆盖任何内容。`,
      );
    }
    try {
      renameSync(staging, outputDir);
      staging = null;
    } catch (error) {
      return importFailure(request.token, "IMPORT_FAILED", `Could not publish ${outputName}; nothing was overwritten / 无法发布 ${outputName}，未覆盖任何内容: ${message(error)}`);
    }

    const opened = await openDirectory(outputDir);
    if ("error" in opened) {
      return importFailure(
        request.token,
        "IMPORT_FAILED",
        `Imported to ${outputName}, but Studio could not open it / 已导入到 ${outputName}，但 Studio 无法打开它: ${opened.error}`,
      );
    }
    importProgress(sender, {
      token: request.token,
      phase: "complete",
      message: `Imported ${outputName} / 已导入 ${outputName}`,
    });
    return { ok: true, token: request.token, opened, coverage: summary.coverage, warnings: summary.warnings };
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch (error) {
        console.error(`Could not remove RPG Maker import staging folder: ${message(error)}`);
      }
    }
    if (activeImport === active) activeImport = null;
  }
}

async function cancelRpgMakerImport(token: string): Promise<void> {
  const active = activeImport;
  if (!active || active.token !== token) return;
  active.cancelled = true;
  if (active.runId) await helper.request("cancel", { runId: active.runId });
}

let agentRun: string | null = null;

async function runAgent(request: { prompt: unknown; projectText: unknown; context?: unknown }, sender: Electron.WebContents): Promise<AgentOutcome> {
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") return { ok: false, code: "FAILED", message: "Tell the agent what to do first." };
  if (typeof request.projectText !== "string") return { ok: false, code: "FAILED", message: "No project to work on." };
  let kind: unknown;
  try {
    kind = (JSON.parse(request.projectText) as { kind?: unknown }).kind;
  } catch {
    return { ok: false, code: "FAILED", message: "The document is not valid JSON." };
  }
  if (typeof kind === "string") return { ok: false, code: "FAILED", message: "Agents work on single-file projects for now; this document is a sharded pack." };
  if (agentRun) return { ok: false, code: "FAILED", message: "An agent is already working; wait for it or cancel it." };
  const runId = randomUUID();
  const workDir = join(app.getPath("userData"), "agent-runs", runId);
  mkdirSync(workDir, { recursive: true });
  agentRun = runId;
  const unsubscribe = helper.onEvent((event) => {
    if (event.event === "agent-state" && event.runId === runId && !sender.isDestroyed()) {
      sender.send("studio:agent-state", { status: String(event.status), message: String(event.message) });
    }
  });
  try {
    const params: Record<string, unknown> = { runId, prompt: request.prompt, projectText: request.projectText, workDir };
    if (request.context && typeof request.context === "object") params.context = request.context;
    const config = agentConfig();
    if (config) params.agentConfig = config;
    const reply = await helper.request("agent", params);
    if (!reply.ok) return { ok: false, code: "FAILED", message: reply.error.message };
    return { ok: true, proposals: (reply.result as { proposals: string[] }).proposals };
  } finally {
    unsubscribe();
    agentRun = null;
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---- window ---------------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let dirty = false;
let closing = false;
/** Paths to open once the page has booted (command line, early open-file). */
const pendingOpens: string[] = [];
let booted = false;

function send(channel: string, value: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function command(name: MenuCommand): void {
  send("studio:menu", name);
}

async function pickAndOpen(kind: "file" | "directory"): Promise<OpenReply | null> {
  const options: Electron.OpenDialogOptions = kind === "file"
    ? { title: "Open project file", properties: ["openFile"], filters: [{ name: "Project JSON", extensions: ["json"] }] }
    : { title: "Open project folder", properties: ["openDirectory"] };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return kind === "file" ? openFile(picked.filePaths[0]!) : openDirectory(picked.filePaths[0]!);
}

async function openFromMenu(kind: "file" | "directory"): Promise<void> {
  const reply = await pickAndOpen(kind);
  if (reply) send("studio:opened", reply);
}

async function openRecent(id: string): Promise<OpenReply | null> {
  const record = loadRecent().find((item) => recentId(item) === id);
  if (!record) return { error: "That recent project is no longer in the list." };
  return record.kind === "directory" ? openDirectory(record.path) : openFile(record.path);
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const recent = loadRecent();
  // Shortcuts Studio's page already handles are shown but not registered, so
  // the key still reaches the page (and the text field that has focus).
  const pageKey = (accelerator: string) => ({ accelerator, registerAccelerator: false });
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open File…", ...pageKey("CmdOrCtrl+O"), click: () => void openFromMenu("file") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+Shift+O", click: () => void openFromMenu("directory") },
        {
          label: "Open Recent",
          submenu: recent.length === 0
            ? [{ label: "No recent projects", enabled: false }]
            : recent.map((record) => ({
                label: record.path,
                click: () => void openRecent(recentId(record)).then((reply) => { if (reply) send("studio:opened", reply); }),
              })),
        },
        { type: "separator" },
        { label: "Save", ...pageKey("CmdOrCtrl+S"), click: () => command("save") },
        { label: "Export…", ...pageKey("CmdOrCtrl+Shift+E"), click: () => command("export") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", ...pageKey("CmdOrCtrl+Z"), click: () => command("undo") },
        { label: "Redo", ...pageKey("CmdOrCtrl+Shift+Z"), click: () => command("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Problems", click: () => command("problems") },
        { label: "Run Engine Checks", click: () => command("engine-checks") },
        { label: "Agent", click: () => command("agent") },
        { label: "Play-test", ...pageKey("CmdOrCtrl+Enter"), click: () => command("playtest") },
        { type: "separator" },
        { label: "Toggle Light/Dark", click: () => command("theme") },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ type: "separator" as const }, { role: "reload" as const }, { role: "toggleDevTools" as const }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Keyboard Shortcuts", click: () => command("shortcuts") },
        { label: "Studio Desktop Documentation", click: () => void shell.openExternal(DOCS_URL) },
        ...(mac ? [] : [{ role: "about" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Pocket RPG Kit Studio",
    backgroundColor: "#0d0f14",
    show: false,
    webPreferences: {
      preload: join(APP_DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("close", (event) => {
    if (closing || !dirty || !win) return;
    event.preventDefault();
    const answer = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard Changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "This project has unsaved changes.",
      detail: "Close the window and discard them?",
    });
    if (answer === 0) {
      closing = true;
      setImmediate(() => win?.close());
    }
  });
  win.on("closed", () => { win = null; });
  void win.loadURL(STUDIO_PAGE);
}

// ---- IPC ------------------------------------------------------------------------------------

/** Only Studio's own top-level page may call the main process. */
function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return !!frame && frame.parent === null && frame.url.startsWith(`${ORIGIN}/studio/`) && event.sender === win?.webContents;
}

function handle(channel: string, run: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("refused: not Studio's page");
    return run(event, ...args);
  });
}

function text(value: unknown, label: string, max = 512 * 1024 * 1024): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`bad ${label}`);
  return value;
}

function registerIpc(): void {
  handle("studio:boot", async (): Promise<BootReply> => {
    booted = true;
    return {
      capabilities: await capabilities(),
      stored: restore(),
      recent: recentEntries(),
      opened: await Promise.all(pendingOpens.splice(0).map(openPath)),
      platform: process.platform,
      version: app.getVersion(),
    };
  });
  handle("studio:pick-file", () => pickAndOpen("file"));
  handle("studio:pick-directory", () => pickAndOpen("directory"));
  handle("studio:open-recent", (_event, id) => openRecent(text(id, "id", 64)));
  handle("studio:rpgmaker-import", (event, value) => {
    const raw = value as Partial<RpgMakerImportRequest> | null;
    const requestToken = text(raw?.token, "import token", 160);
    if (requestToken.length === 0) throw new Error("bad import token");
    if (raw?.placeholders !== "visible" && raw?.placeholders !== "silent") throw new Error("bad placeholder mode");
    return importRpgMaker({ token: requestToken, placeholders: raw.placeholders }, event.sender);
  });
  handle("studio:rpgmaker-import-cancel", (_event, value) => cancelRpgMakerImport(text(value, "import token", 160)));
  handle("studio:pick-image", async () => {
    const options: Electron.OpenDialogOptions = { title: "Choose a PNG", properties: ["openFile"], filters: [{ name: "PNG image", extensions: ["png"] }] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const path = picked.filePaths[0]!;
    const name = basename(path);
    try {
      const size = statSync(path).size;
      let problem = pngProblem(name, size);
      if (problem !== null) return { error: problem };
      const bytes = readFileSync(path);
      problem = pngProblem(name, size, new Uint8Array(bytes.subarray(0, PNG_HEADER_BYTES)));
      if (problem !== null) return { error: problem };
      return { name, bytes: new Uint8Array(bytes) };
    } catch (error) {
      return { error: `Could not read ${name}: ${message(error)}` };
    }
  });
  handle("studio:save", (_event, value) => {
    const request = value as Partial<SaveRequest> | null;
    return save({
      text: text(request?.text, "text"),
      label: text(request?.label, "label", 1024),
      fileName: text(request?.fileName, "file name", 1024),
      ...(request?.target === undefined ? {} : { target: text(request.target, "target", 64) }),
    });
  });
  handle("studio:export", async (_event, fileName, body) => {
    const name = basename(text(fileName, "file name", 1024)) || "project.json";
    const content = text(body, "text");
    const options: Electron.SaveDialogOptions = {
      title: "Export project",
      defaultPath: join(app.getPath("documents"), name),
      filters: [{ name: "Project JSON", extensions: ["json"] }],
    };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, message: "Export cancelled." };
    try {
      writeAtomic(picked.filePath, content);
      return { ok: true, message: `Exported ${basename(picked.filePath)}.` };
    } catch (error) {
      return { ok: false, message: `Not exported: ${message(error)}` };
    }
  });
  handle("studio:check", (_event, value) => runChecks((value ?? {}) as { project: unknown; mode: string }));
  handle("studio:agent", (event, value) => runAgent((value ?? {}) as { prompt: unknown; projectText: unknown }, event.sender));
  handle("studio:agent-cancel", async () => {
    if (agentRun) await helper.request("cancel", { runId: agentRun });
  });
  handle("studio:confirm", async (_event, value) => {
    if (!win) return false;
    const answer = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Continue", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: text(value, "message", 4096),
    });
    return answer.response === 0;
  });
  ipcMain.on("studio:dirty", (event, value) => {
    if (trusted(event)) dirty = value === true;
  });
}

// ---- lifecycle -------------------------------------------------------------------------------

/** macOS: files dropped on the Dock icon or opened with "Open With". It can
 * arrive before the window exists. */
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (booted) void openPath(path).then((reply) => send("studio:opened", reply));
  else pendingOpens.push(path);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    for (const path of pathArguments(argv)) void openPath(path).then((reply) => send("studio:opened", reply));
  });

  app.on("web-contents-created", (_event, contents) => {
    // Studio never navigates away or opens windows; links to the docs open
    // in the system browser.
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle(SCHEME, serveSite);
    registerIpc();
    buildMenu();
    pendingOpens.push(...pathArguments(process.argv));
    void probe();
    createWindow();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => void helper.stop());
}
