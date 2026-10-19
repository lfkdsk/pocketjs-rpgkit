// studio-desktop/e2e/studio-desktop.test.mjs — the desktop app end to end,
// driven by Playwright's Electron support. Run it through e2e/run.ts, which
// prepares the fixtures and a display.
//
// Native dialogs cannot be clicked by a test, so each test replaces
// dialog.showOpenDialog / showMessageBox in the main process with an answer;
// everything after the dialog (reading, confinement, saving, the helper, the
// agent, the checks, the preview) is the real app.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { snapshotPath } from "./path.mjs";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ELECTRON = require("electron");
const WORK = process.env.STUDIO_E2E_WORK;
const FOLDER = process.env.STUDIO_E2E_FOLDER;
const ART_FOLDER = process.env.STUDIO_E2E_ART_FOLDER;
const BROKEN = process.env.STUDIO_E2E_BROKEN;
const AGENT_CONFIG = process.env.STUDIO_E2E_AGENT_CONFIG;
const RPG_MAKER = process.env.STUDIO_E2E_RPG_MAKER;
const IMPORT_PARENT = process.env.STUDIO_E2E_IMPORT_PARENT;
const SHOTS = process.env.STUDIO_E2E_SHOTS;
if (!WORK || !FOLDER || !ART_FOLDER || !BROKEN || !AGENT_CONFIG || !RPG_MAKER || !IMPORT_PARENT || !SHOTS) throw new Error("run this through e2e/run.ts");
const PROFILE = join(WORK, "profile");
mkdirSync(SHOTS, { recursive: true });

/** Every file under `dir`: relative path → bytes and modification time. */
function snapshot(dir) {
  const out = new Map();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const key = snapshotPath(relative(dir, full));
        out.set(key, { text: readFileSync(full, "utf8"), mtime: statSync(full).mtimeMs });
      }
    }
  };
  walk(dir);
  return out;
}

let electronApp;
let page;

async function answerDialogs(answers) {
  await electronApp.evaluate(({ dialog }, answers) => {
    globalThis.__dialogCalls ??= [];
    if (answers.open !== undefined || answers.opens !== undefined) {
      const queue = answers.opens ? [...answers.opens] : [answers.open];
      dialog.showOpenDialog = async (...args) => {
        globalThis.__dialogCalls.push(["open", args.at(-1)?.title]);
        const answer = queue.shift() ?? null;
        return { canceled: answer === null, filePaths: answer === null ? [] : [answer] };
      };
    }
    if (answers.box !== undefined) dialog.showMessageBox = async (...args) => {
      globalThis.__dialogCalls.push(["box", args.at(-1)?.message]);
      return { response: answers.box, checkboxChecked: false };
    };
    if (answers.boxSync !== undefined) dialog.showMessageBoxSync = (...args) => {
      globalThis.__dialogCalls.push(["boxSync", args.at(-1)?.message]);
      return answers.boxSync;
    };
  }, answers);
}

const dialogCalls = () => electronApp.evaluate(() => globalThis.__dialogCalls ?? []);
const studio = (fn, arg) => page.evaluate(fn, arg);

async function clickCell(x, y) {
  const point = await studio(([x, y]) => window.__studio.cellToClient(x, y), [x, y]);
  await page.mouse.click(point.x, point.y);
}

/** A cell of the open map whose ground is not the brush, from row `from` down. */
function cellToPaint(from = 2) {
  return studio((from) => {
    const app = window.__studio.app;
    const map = app.currentMap();
    for (let y = from; y < map.height - 2; y++) {
      for (let x = 2; x < map.width - 2; x++) {
        if (map.ground[y * map.width + x] !== app.brush) return { x, y, brush: app.brush, before: map.ground[y * map.width + x], width: map.width };
      }
    }
    return null;
  }, from);
}

async function openMenuItem(label) {
  await page.click("#studio-open");
  await page.locator(".menu button, .menu [role=menuitem]").filter({ hasText: label }).first().click();
}

async function shot(name) {
  // Notices fade after a few seconds; the test is faster than that.
  await studio(() => { for (const notice of [...window.__studio.app.notices]) window.__studio.app.dismiss(notice.id); });
  await page.mouse.move(5, 500);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

before(async () => {
  electronApp = await _electron.launch({
    executablePath: ELECTRON,
    // The OS-level renderer sandbox needs a setuid helper or unprivileged
    // user namespaces, which CI containers and this test's Linux machines
    // may not allow; webPreferences.sandbox (no Node in the page, a
    // sandboxed preload) still applies and is checked below.
    args: [
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
      join(HERE, "app", "main.cjs"),
      `--studio-user-data=${PROFILE}`,
      `--agent-config=${AGENT_CONFIG}`,
    ],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.waitForSelector("html[data-ready='1']", { timeout: 30_000 });
});

after(async () => {
  if (!electronApp) return;
  // Whatever a failed test left behind, close without asking.
  const child = electronApp.process();
  const within = (promise, ms) => Promise.race([promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
  await within(answerDialogs({ boxSync: 0 }), 3_000);
  await within(electronApp.close(), 10_000);
  child.kill("SIGKILL");
});

describe("Studio desktop", () => {
  test("the page runs sandboxed, isolated and under a strict CSP", async () => {
    const prefs = await electronApp.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag };
    });
    assert.deepEqual(prefs, { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
    const page_ = await studio(async () => {
      const csp = (await fetch(location.href)).headers.get("content-security-policy");
      const inline = document.createElement("script");
      inline.textContent = "window.__inlineRan = true";
      document.head.append(inline);
      const traversal = await fetch("app://studio/%2e%2e/main.cjs").then((r) => r.status, () => "blocked");
      return {
        url: location.href,
        require: typeof globalThis.require,
        process: typeof globalThis.process,
        bridge: Object.keys(window.studioDesktop).sort(),
        bridgeHasIpc: "ipcRenderer" in window.studioDesktop,
        csp,
        inlineRan: window.__inlineRan === true,
        popup: window.open("https://example.com") === null,
        traversal,
        host: window.__studio.host.name,
      };
    });
    assert.equal(page_.url, "app://studio/studio/index.html");
    assert.equal(page_.require, "undefined");
    assert.equal(page_.process, "undefined");
    assert.equal(page_.bridgeHasIpc, false);
    assert.deepEqual(page_.bridge, ["agent", "boot", "cancelAgent", "cancelRpgMakerImport", "check", "confirm", "exportFile", "importRpgMaker", "onAgentState", "onMenu", "onOpened", "onRpgMakerImportProgress", "openRecent", "pickDirectory", "pickFile", "pickImage", "save", "setDirty"]);
    assert.match(page_.csp, /script-src 'self'(;|$)/);
    assert.match(page_.csp, /frame-ancestors 'none'/);
    assert.equal(page_.inlineRan, false, "an inline script ran despite the CSP");
    assert.equal(page_.popup, true, "window.open was not denied");
    assert.notEqual(page_.traversal, 200);
    assert.equal(page_.host, "desktop");
  });

  test("imports through native source/destination dialogs, publishes once, and opens through a directory token", async () => {
    await answerDialogs({ opens: [RPG_MAKER, IMPORT_PARENT] });
    const imported = await studio(async () => {
      const progress = [];
      const outcome = await window.__studio.files.importRpgMaker("visible", (event) => progress.push(event));
      const opened = outcome?.ok ? window.__studio.files.openRpgMakerResult(outcome) : false;
      return { outcome, progress, opened };
    });
    assert.equal(imported.outcome.ok, true, JSON.stringify(imported.outcome));
    assert.equal(imported.opened, true);
    assert.deepEqual(imported.progress.map((event) => event.phase), ["selecting", "selecting", "reading", "converting", "writing", "complete"]);
    assert.equal(imported.outcome.coverage.totals.total > 0, true);
    assert.equal(imported.outcome.coverage.rows.every((row) => row.counts.Placeholder > 0 || row.counts.Dropped > 0), true);
    assert.equal(await studio(() => window.__studio.files.target?.kind), "directory");
    assert.equal(await studio(() => window.__studio.app.session?.kind), "pack");

    const output = join(IMPORT_PARENT, "hollow-mz-rpgkit");
    assert.equal(existsSync(join(output, "project.json")), true);
    assert.equal(existsSync(join(output, "coverage.md")), true);
    assert.equal(readdirSync(IMPORT_PARENT).some((name) => name.includes(".import-")), false, "staging directory was left behind");
    const before = snapshot(output);

    await answerDialogs({ opens: [RPG_MAKER, IMPORT_PARENT] });
    const refused = await studio(() => window.__studio.files.importRpgMaker("silent", () => {}));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "IMPORT_FAILED");
    assert.match(refused.message, /already exists.*Nothing was overwritten|已存在.*未覆盖/);
    assert.deepEqual(snapshot(output), before);
    assert.equal(readdirSync(IMPORT_PARENT).some((name) => name.includes(".import-")), false, "refused import created staging output");

    const calls = await dialogCalls();
    assert.deepEqual(calls.slice(-4).map((call) => call[1]), [
      "Select RPG Maker project folder / 选择 RPG Maker 项目文件夹",
      "Select destination parent folder / 选择导入位置",
      "Select RPG Maker project folder / 选择 RPG Maker 项目文件夹",
      "Select destination parent folder / 选择导入位置",
    ]);
  }, 60_000);

  test("open the Sunstone folder, paint one cell, save: only that map file (and the shell) change on disk", async () => {
    await answerDialogs({ open: FOLDER, box: 0 });
    const before = snapshot(FOLDER);
    await openMenuItem("Open folder");
    await page.waitForFunction(() => window.__studio.files.target?.kind === "directory" && window.__studio.app.session?.kind === "pack", null, { timeout: 15_000 });
    await studio(() => window.__studio.app.openMap("village"));
    await page.keyboard.press("b");
    const plan = await cellToPaint();
    assert.ok(plan, "no village cell differs from the brush");
    await clickCell(plan.x, plan.y);
    assert.equal(await studio(([x, y]) => window.__studio.tileAt(x, y), [plan.x, plan.y]), plan.brush);
    assert.equal(await studio(() => window.__studio.app.session.isDirty()), true);
    await page.keyboard.press("Control+S");
    await page.waitForFunction(() => window.__studio.files.saving === 0 && window.__studio.files.lastSavedAt && !window.__studio.app.session.isDirty(), null, { timeout: 15_000 });
    const after = snapshot(FOLDER);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the save left extra files (staging or lock files) or removed some");
    const changed = [...after.keys()].filter((path) => after.get(path).text !== before.get(path).text).sort();
    assert.ok(changed.includes("maps/village.json"), `village shard not written: ${changed}`);
    assert.ok(changed.every((path) => path === "maps/village.json" || path === "project.json"), `unexpected files written: ${changed}`);
    for (const [path, entry] of before) {
      if (!changed.includes(path)) assert.equal(after.get(path).mtime, entry.mtime, `${path} was rewritten`);
    }
    const shard = JSON.parse(after.get("maps/village.json").text);
    assert.equal(shard.ground[plan.y * plan.width + plan.x], plan.brush);
    const mismatched = shard.ground.filter((tile, index) => index !== plan.y * plan.width + plan.x && tile !== JSON.parse(before.get("maps/village.json").text).ground[index]);
    assert.equal(mismatched.length, 0, "other cells changed");
    const saved = await studio(() => document.getElementById("statusbar").textContent);
    assert.match(saved, /saved to sunstone\//);
    await shot("folder-saved");
    console.log(`# folder save wrote: ${changed.join(", ")} (cell ${plan.x},${plan.y}: ${plan.before} -> ${plan.brush})`);
  });

  test("a map file changed on disk since opening blocks the save and nothing is written", async () => {
    const shardPath = join(FOLDER, "maps", "village.json");
    const external = `${readFileSync(shardPath, "utf8")}\n`;
    writeFileSync(shardPath, external);
    const before = snapshot(FOLDER);
    const plan = await cellToPaint(6);
    await clickCell(plan.x, plan.y);
    await page.keyboard.press("Control+S");
    await page.waitForFunction(() => window.__studio.files.saving === 0 && window.__studio.app.notices.some((n) => n.level === "error"), null, { timeout: 15_000 });
    const notice = await studio(() => window.__studio.app.notices.filter((n) => n.level === "error").at(-1).text);
    assert.match(notice, /changed on disk/);
    const after = snapshot(FOLDER);
    for (const [path, entry] of before) assert.equal(after.get(path).text, entry.text, `${path} was written`);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    assert.equal(await studio(() => window.__studio.app.session.isDirty()), true);
  });

  test("the folder is in Open Recent", async () => {
    const recent = JSON.parse(readFileSync(join(PROFILE, "recent.json"), "utf8"));
    assert.equal(recent[0].kind, "directory");
    assert.equal(recent[0].path, FOLDER);
    const labels = await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Open Recent").submenu.items.map((item) => item.label));
    assert.ok(labels.includes(FOLDER), JSON.stringify(labels));
  });

  test("a local agent (the offline fake) returns a proposal; accepting it is one undo step", async () => {
    await answerDialogs({ box: 0 });
    await openMenuItem("Example: The Sunstone of Bramble Hollow");
    await page.waitForFunction(() => window.__studio.app.session?.kind === "inline" && window.__studio.app.currentMap()?.id === "village", null, { timeout: 15_000 });
    await page.keyboard.press("v");
    await clickCell(8, 5);
    assert.deepEqual(await studio(() => window.__studio.app.selection), { kind: "cell", x: 8, y: 5 });
    const tileBefore = await studio(() => window.__studio.tileAt(8, 5));
    await page.click("#studio-agent");
    await page.fill("#studio-agent-prompt", "Brighten the selected tile");
    await page.click("#studio-agent-send");
    const item = page.locator("#studio-agent-proposals li.agent-proposal").first();
    await item.waitFor({ timeout: 90_000 });
    const id = await item.getAttribute("data-proposal-id");
    assert.match(id, /^fake-/);
    assert.equal(await page.getAttribute("#studio-agent-status", "data-status"), "done");
    await shot("agent-proposal");
    assert.equal(await studio(() => window.__studio.tileAt(8, 5)), tileBefore, "the proposal changed the document before review");
    await page.click(`[id="agent-accept-${id}"]`);
    await page.waitForSelector(`li.agent-proposal[data-proposal-id="${id}"][data-status="accepted"]`);
    const tileAfter = await studio(() => window.__studio.tileAt(8, 5));
    assert.notEqual(tileAfter, tileBefore);
    assert.match(await studio(() => window.__studio.app.session.history().at(-1).label), /^Accept proposal/);
    await studio(() => window.__studio.app.undo());
    assert.equal(await studio(() => window.__studio.tileAt(8, 5)), tileBefore);
    await page.click("#studio-agent-close");
    const runs = join(PROFILE, "agent-runs");
    assert.ok(!existsSync(runs) || readdirSync(runs).length === 0, "the agent's scratch folder was left behind");
    console.log(`# agent proposal ${id}: (8,5) ${tileBefore} -> ${tileAfter}, undone`);
  });

  test("common events and tile-sheet passage edit through the shared Studio UI", async () => {
    await answerDialogs({ box: 0 });
    await openMenuItem("Example: The Sunstone of Bramble Hollow");
    await page.waitForFunction(() => window.__studio.app.session?.kind === "inline" && window.__studio.app.currentMap()?.id === "village", null, { timeout: 15_000 });

    await page.click('[data-action="new-common-event"]');
    await page.waitForFunction(() => window.__studio.app.selection.kind === "common");
    await page.fill('[data-field="common.id"]', "desktop-common");
    await page.locator('[data-field="common.id"]').blur();
    await page.waitForFunction(() => window.__studio.app.selection.commonId === "desktop-common");
    await page.selectOption('[data-field="common.trigger"]', "parallel");
    await page.fill('[data-field="common.conditionSwitch"]', "desktop-enabled");
    await page.locator('[data-field="common.conditionSwitch"]').blur();
    await page.click('[data-action="add-command"]');
    await page.fill('[data-field="command-picker"]', "text");
    await page.click('button[data-op="text"]:not([data-action])');
    await page.fill('[data-field="command.lines"]', "Desktop shared line");
    await page.locator('[data-field="command.lines"]').blur();
    await page.waitForFunction(() => window.__studio.app.session.globals().commonEvents
      .find((item) => item.id === "desktop-common")?.commands[0]?.lines?.[0] === "Desktop shared line");
    const explain = await page.locator("#inspector .ins-section").filter({ has: page.locator("h2", { hasText: "Explain" }) }).textContent();
    assert.match(explain, /background/);
    assert.match(explain, /desktop-enabled/);
    assert.match(explain, /Desktop shared line/);

    await studio(() => window.__studio.app.run("insert-command", {
      map: "village", event: "elder", page: 0,
      address: { path: [], index: 0 }, command: { op: "common", id: "desktop-common" },
    }, "Call desktop common"));
    await page.click('[data-action="delete-common-event"]');
    const prompt = page.locator('[data-role="common-delete-confirm"]');
    await prompt.waitFor();
    assert.match(await prompt.textContent(), /map:village\/event:elder\/page:0/);
    assert.equal(await studio(() => window.__studio.app.session.globals().commonEvents.some((item) => item.id === "desktop-common")), true);
    await page.click('[data-action="cancel-common-delete"]');
    await prompt.waitFor({ state: "detached" });

    await page.click('[data-action="close-common-event"]');
    await page.click('[data-layer="passage"]');
    await page.selectOption('[data-testid="sheet-default-passage"]', "block");
    await page.click('[data-testid="sheet-dir-block-right"]');
    const passage = await studio(() => {
      const sheet = window.__studio.app.session.sheets().find((item) => item.id === "town");
      const last = window.__studio.app.session.history().slice(-2).map((step) => step.commands);
      return { defaultPassage: sheet.defaultPassage, dirBlock: sheet.dirBlock?.["0"], last };
    });
    assert.equal(passage.defaultPassage, "block");
    assert.deepEqual(passage.dirBlock, ["right"]);
    assert.deepEqual(passage.last, [["update-sheet"], ["update-sheet"]]);
    await studio(() => window.__studio.app.undo());
    assert.equal(await studio(() => window.__studio.app.session.sheets().find((item) => item.id === "town").dirBlock?.["0"]), undefined);
    await studio(() => window.__studio.app.redo());
    assert.deepEqual(await studio(() => window.__studio.app.session.sheets().find((item) => item.id === "town").dirBlock?.["0"]), ["right"]);
    await shot("common-and-sheet-passage");
  });

  test("engine checks run on this computer and their findings join the problems list", async () => {
    await answerDialogs({ open: BROKEN, box: 0 });
    await openMenuItem("Open file");
    await page.waitForFunction(() => window.__studio.files.target?.kind === "file", null, { timeout: 15_000 });
    // The lint pass that follows opening comes first (it replaces the list).
    await page.click("#status-problems");
    await page.waitForSelector("#problems button.problem[title^='lint/']", { timeout: 15_000 });
    // View > Run Engine Checks, as the menu sends it.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("studio:menu", "engine-checks"));
    await page.waitForSelector("#problems button.problem[title^='reach/']", { timeout: 60_000 });
    const codes = await studio(() => [...document.querySelectorAll("#problems button.problem")].map((button) => button.title));
    assert.ok(codes.includes("reach/transfer-target-missing"), JSON.stringify(codes));
    assert.ok(codes.some((code) => code.startsWith("lint/")), JSON.stringify(codes));
    await shot("engine-checks");
    console.log(`# problems after engine checks: ${codes.join(", ")}`);
  });

  test("a project folder's own art is drawn on the canvas and in the play-test", async () => {
    await answerDialogs({ open: ART_FOLDER, box: 0 });
    await openMenuItem("Open folder");
    await page.waitForFunction(() => window.__studio.files.target?.name === "sunstone-art/", null, { timeout: 15_000 });
    await page.waitForFunction(() => window.__studio.art.sheetStatus("town").source === "project" && window.__studio.art.spriteStatus("wiz").source === "project", null, { timeout: 15_000 });
    const status = await studio(() => ({ town: window.__studio.art.sheetStatus("town"), wiz: window.__studio.art.spriteStatus("wiz"), dun: window.__studio.art.sheetStatus("dun") }));
    assert.equal(status.town.from, "art/sheets/town.png");
    assert.equal(status.wiz.from, "assets/npc/wiz.png");
    assert.equal(status.dun.source, "bundled", "a sheet the folder has no art for keeps the bundled art");
    await studio(() => { window.__studio.app.openMap("village"); window.__studio.canvas.fit(); });
    await page.waitForTimeout(300);
    const wiz = await studio(() => {
      const event = window.__studio.app.currentMap().events.find((item) => item.pages.some((p) => p.sprite === "wiz"));
      const point = window.__studio.cellToClient(event.x, event.y);
      const canvas = document.querySelector(".map-canvas");
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      return [...canvas.getContext("2d").getImageData(Math.round((point.x - rect.left) * scale), Math.round((point.y - rect.top) * scale), 1, 1).data].slice(0, 3);
    });
    assert.ok(Math.abs(wiz[0] - 236) <= 3 && Math.abs(wiz[1] - 64) <= 3 && Math.abs(wiz[2] - 200) <= 3, `wiz pixel ${wiz}`);
    await shot("project-art");
    // The play-test gets the same images.
    await page.keyboard.press("v");
    await clickCell(9, 7);
    await page.click("#studio-play");
    await page.waitForFunction(() => (window.__studio.play.status === "running" && window.__studio.play.readings > 0) || window.__studio.play.status === "error", null, { timeout: 40_000 });
    const play = await studio(() => ({ status: window.__studio.play.status, error: window.__studio.play.error, art: window.__studio.play.art, note: window.__studio.play.artNote }));
    assert.equal(play.status, "running", JSON.stringify(play));
    assert.equal(play.art?.kind, "project", JSON.stringify(play));
    assert.equal(play.art.used, 2, JSON.stringify(play));
    assert.equal(play.note, null);
    await page.waitForTimeout(800);
    await shot("playtest-project-art");
    await page.click("#playtest-close");
    console.log(`# project art: town from ${status.town.from}, wiz from ${status.wiz.from}, wiz pixel ${wiz}; play-test used ${play.art.used} images`);
  });

  test("the play-test panel starts the game from the selected cell", async () => {
    await answerDialogs({ box: 0 });
    await openMenuItem("Example: The Sunstone of Bramble Hollow");
    await page.waitForFunction(() => window.__studio.app.session?.kind === "inline" && window.__studio.app.currentMap()?.id === "village", null, { timeout: 15_000 });
    await page.keyboard.press("v");
    await clickCell(9, 7);
    await page.click("#studio-play");
    await page.waitForFunction(() => (window.__studio.play.status === "running" && window.__studio.play.readings > 0) || window.__studio.play.status === "error", null, { timeout: 40_000 });
    const status = await studio(() => ({ status: window.__studio.play.status, error: window.__studio.play.error, state: window.__studio.play.state }));
    assert.equal(status.status, "running", JSON.stringify(status));
    assert.equal(status.state.map, "village");
    assert.equal(status.state.x, 9);
    assert.equal(status.state.y, 7);
    const frame = page.frames().find((candidate) => candidate.url().startsWith("app://studio/preview/"));
    assert.ok(frame, "no preview frame");
    assert.equal(new URL(frame.url()).search, "?embed");
    assert.equal(await frame.evaluate(() => typeof window.studioDesktop), "undefined", "the game frame can reach the bridge");
    const first = status.state.frame;
    await page.waitForTimeout(1200);
    const later = await studio(() => window.__studio.play.state.frame);
    assert.ok(later > first, `${first} -> ${later}`);
    await page.waitForTimeout(800);
    await shot("playtest");
  });

  test("closing with unsaved changes asks first; Cancel keeps the window", async () => {
    await page.click("#playtest-close", { timeout: 5_000 });
    await page.click("[data-tool='pencil']");
    const plan = await cellToPaint();
    await clickCell(plan.x, plan.y);
    assert.equal(await studio(() => window.__studio.app.session.isDirty()), true);
    await page.waitForTimeout(700); // the page reports dirtiness a few times a second
    await answerDialogs({ boxSync: 1 });
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(500);
    const calls = (await dialogCalls()).filter(([kind]) => kind === "boxSync");
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /unsaved changes/);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await answerDialogs({ boxSync: 0 });
    // The window closes; the process itself then lingers while Playwright's
    // inspector session is attached, so after() ends it.
    const closed = new Promise((resolve) => page.once("close", () => resolve(true)));
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 15_000))]), true, "the window did not close after Discard Changes");
  });
});
