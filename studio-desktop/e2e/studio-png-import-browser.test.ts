import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildStudio } from "../../tools/studio-build.ts";
import { writePngBytes } from "../../tools/rpgmaker-import/png.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SITE = join(ROOT, "dist", "png-import-playwright");
const STATIC = join(SITE, "studio");
let browser: Browser;

async function studio(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname).replace(/^\/studio\/?/, "") || "index.html";
    const path = resolve(STATIC, relative);
    if (!path.startsWith(`${STATIC}${sep}`)) return route.fulfill({ status: 403, body: "forbidden" });
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
    try { await route.fulfill({ status: 200, body: readFileSync(path), contentType: mime[extname(path)] ?? "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404, body: "not found" }); }
  });
  await page.goto("http://studio.test/studio/?example=sunstone");
  await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
  return page;
}

function image(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    data.set([x % 255, y % 255, 183, 255], at);
  }
  return writePngBytes({ width, height, data });
}

async function openImport(page: Page): Promise<void> {
  await page.locator("#studio-art").click();
  await page.getByRole("button", { name: "Import PNG into project…" }).click();
}

async function choose(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose PNG…" }).last().click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: Buffer.from(bytes) });
}

beforeAll(async () => {
  await buildStudio({ outdir: SITE });
  const executablePath = process.env.CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chromium-browser");
  if (!executablePath) throw new Error("Studio PNG browser test needs Google Chrome or Chromium on PATH (or CHROME)");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
}, 120_000);
afterAll(async () => { await browser?.close(); });

describe("Studio interactive PNG import (Playwright, offline route)", () => {
  test("picker, adjustable grid, atomic history, painting, save/reopen and walker selection", async () => {
    const page = await studio();
    try {
      const source = image(36, 18);
      await openImport(page);
      await choose(page, "sample.png", source);
      const importDialog = page.getByRole("dialog", { name: "Import PNG" });
      await importDialog.getByRole("status").filter({ hasText: "2 × 1 cells" }).waitFor();
      await importDialog.getByRole("spinbutton", { name: "offsetX" }).fill("2");
      await importDialog.getByRole("spinbutton", { name: "spacingX" }).fill("2");
      await importDialog.getByRole("status").filter({ hasText: "2 × 1 cells" }).waitFor();
      await importDialog.screenshot({ path: join(SITE, "png-import-grid.png") });
      await importDialog.getByRole("textbox", { name: "Asset id" }).fill("pw_tiles");
      await importDialog.getByRole("button", { name: "Import into project" }).click();
      await importDialog.waitFor({ state: "detached" });
      let state = await page.evaluate(() => {
        const s = (window as any).__studio.app.session;
        return { sheet: s.sheets().find((v: any) => v.id === "pw_tiles"), attached: s.map("village")?.sheets.includes("pw_tiles"), png: s.assets().has("art/sheets/pw_tiles.png") };
      });
      expect(state.sheet).toMatchObject({ id: "pw_tiles", cols: 2, rows: 1 });
      expect(state.attached).toBe(true);
      expect(state.png).toBe(true);
      await page.getByRole("dialog", { name: "Art", exact: true }).getByRole("button", { name: "Close" }).click();
      await page.locator("#studio-undo").click();
      state = await page.evaluate(() => {
        const s = (window as any).__studio.app.session;
        return { sheet: s.sheets().find((v: any) => v.id === "pw_tiles"), attached: s.map("village")?.sheets.includes("pw_tiles"), png: s.assets().has("art/sheets/pw_tiles.png") };
      });
      expect(state.sheet).toBeUndefined();
      expect(state.attached).toBe(false);
      expect(state.png).toBe(false);
      await page.locator("#studio-redo").click();
      await page.getByRole("tab", { name: "pw_tiles" }).click();
      const atlas = page.locator('.palette-canvas[data-sheet="pw_tiles"]');
      await atlas.waitFor({ state: "attached" });
      expect(await atlas.count()).toBe(1);
      await atlas.click({ position: { x: 8, y: 8 } });
      await page.waitForFunction(() => (window as any).__studio.app.brush === "pw_tiles.0");
      expect(await page.evaluate(() => (window as any).__studio.app.brush)).toBe("pw_tiles.0");
      await page.waitForFunction(() => (window as any).__studio.canvas.settled);
      const cell = await page.evaluate(() => (window as any).__studio.cellToClient(1, 1));
      await page.mouse.click(cell.x, cell.y);
      await page.waitForFunction(() => (window as any).__studio.tileAt(1, 1) === "pw_tiles.0");
      expect(await page.evaluate(() => (window as any).__studio.tileAt(1, 1))).toBe("pw_tiles.0");

      await openImport(page);
      await choose(page, "walker.png", image(48, 64));
      const walkerDialog = page.getByRole("dialog", { name: "Import PNG" });
      await walkerDialog.getByRole("combobox", { name: "Import kind" }).selectOption("walker");
      await walkerDialog.getByRole("status").filter({ hasText: "3 × 4 cells" }).waitFor();
      await walkerDialog.getByRole("textbox", { name: "Asset id" }).fill("pw_walker");
      await walkerDialog.getByRole("button", { name: "Import into project" }).click();
      await walkerDialog.waitFor({ state: "detached" });
      await page.getByRole("dialog", { name: "Art", exact: true }).getByRole("button", { name: "Close" }).click();
      const before = await page.evaluate(() => (window as any).__studio.app.session.exportText());
      expect(JSON.parse(before).kind).toBe("rpgkit-edit/sharded-pack-v1");
      await page.locator("#studio-save").click();
      await page.waitForFunction(() => !!localStorage.getItem("pocket-rpgkit:studio:document:v1"));
      await page.goto("http://studio.test/studio/");
      await page.waitForFunction(() => document.documentElement.dataset.ready === "1");
      const reopened = await page.evaluate(() => {
        const s = (window as any).__studio.app.session;
        return { sheet: s.sheets().find((v: any) => v.id === "pw_tiles"), walker: s.sprites().pw_walker, art: [...s.assets().keys()], painted: s.map("village").ground[1 + s.map("village").width] };
      });
      expect(reopened.sheet?.cols).toBe(2);
      expect(reopened.walker?.kind).toBe("walker");
      expect(reopened.art).toContain("art/sheets/pw_tiles.png");
      expect(reopened.art).toContain("art/sprites/pw_walker.png");
      expect(reopened.painted).toBe("pw_tiles.0");
      await page.evaluate(() => (window as any).__studio.app.select({ kind: "event", eventId: "merchant", page: 0 }));
      await page.locator('[data-field="page.sprite"]').fill("pw_walker");
      await page.locator('[data-field="page.sprite"]').press("Tab");
      expect(await page.evaluate(() => (window as any).__studio.app.currentMap().events.find((v: any) => v.id === "merchant").pages[0].sprite)).toBe("pw_walker");
    } finally { await page.close(); }
  }, 120_000);
});
