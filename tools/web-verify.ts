// tools/web-verify.ts — play the built web site (dist/web) in headless
// Chrome and check that every game really runs and answers input.
//
//   bun run web && bun tools/web-verify.ts
//   bun tools/web-verify.ts --chrome /usr/bin/google-chrome --out dist/web-verify
//
// It serves the site twice from an in-process static server: at "/" and
// under "/pocket-rpgkit/" (the GitHub Pages project path), where anything
// outside the prefix is a 404, so an absolute URL shows up as a failed
// request. Chrome runs over the DevTools protocol; nothing is installed.
//
// Checks, with screenshots in --out (the page, and the canvas at its native
// raster size). Games other than the three examples get the generic ones.
//   landing   every card, and its preview image, loads
//   showcase  enters two feature halls, triggers both demonstrations, and
//             returns to the lobby after each one
//   sunstone  idles into attract mode (the player moves on its own), a key
//             takes over, and held arrows then walk the player
//   audio     globalThis.audio exposes the host contract; a real pointer
//             gesture starts a WebAudio context/worklet; mute and volume UI
//             update without console errors
//   grow      the settlement grows on its own; a mouse drag and a touch
//             drag on the timeline strip seek it; ← steps one tick back; a
//             smaller window shrinks the live viewport
//   meadow    held arrows walk the player
//   editor    selects a tile, drag-paints and undoes it with Ctrl+Z; creates
//             a text event, play-tests it, downloads it, reloads it from
//             browser storage, and opens a live AI proposal preview
//   focus     the game has keyboard focus after load; clicking elsewhere
//             shows the hint and keys stop; a click on the game restores;
//             editor Tab traversal and browser reload keys stay native
//   sizing    every raster sample occupies whole device pixels, the backing
//             canvas matches logical size × configured density, at 1x, 2x
//             and 1.25x, fixed and dynamic; touch buttons appear on a phone
//   subpath   the landing page and every game run under /pocket-rpgkit/;
//             Studio opens its default example there (tools/studio-verify.ts
//             drives Studio itself)
//   preview   the preview-demo page loads a pasted document into the host
//             over postMessage, starts at a tile, reads state, injects
//             walking input, refuses bad JSON, and ignores a non-allowlisted
//             origin; the host is then driven same-origin and its native
//             canvas captured (only when the site includes the preview app)
// Any console error, uncaught exception or failed request fails the run.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HALL_DEMO, HALL_ENTRY, HALL_EXIT, hallDoorPosition } from "../examples/showcase/hall-kit.ts";
import { SHOWCASE_HALLS } from "../examples/showcase/showcase-data.ts";
import { createProposalFromOperations } from "../editor/api/proposals.ts";
import { loadProject } from "../editor/engine/document.ts";
import { commandInspectorRows } from "../editor/engine/event-fields.ts";
import { createEventInspectorLayout, type InspectorControl } from "../editor/engine/event-layout.ts";
import {
  eventToolButtons,
  fittedView,
  headerButtons,
  mapOffset,
  paletteSlotOrigin,
  HEADER_H,
  TILE,
} from "../editor/engine/layout.ts";
import { playtestStopRect } from "../editor/engine/playtest-layout.ts";
import { Cdp, launchChrome as launchChromeWith } from "./lib/cdp.ts";
import { PREVIEW_LIMITS, previewMessageBytes } from "./preview/protocol.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { createSessionSnapshot } from "../src/engine/save.ts";
import { proposalRowRect } from "../editor/engine/proposal-layout.ts";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "/pocket-rpgkit/";

function option(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "web-verify")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");

/** Decide whether this built site contains both ends of the preview demo. */
export function previewProtocolCheck(
  site: string,
  gameIds: readonly string[],
  output: (line: string) => void = console.log,
): boolean {
  const missing = [
    ...(!gameIds.includes("preview") ? ["the preview app is not listed in games.json"] : []),
    ...(!existsSync(join(site, "preview", "index.html")) ? ["preview/index.html is absent"] : []),
    ...(!existsSync(join(site, "preview-demo.html")) ? ["preview-demo.html is absent"] : []),
  ];
  if (missing.length === 0) return true;
  output(`  SKIP preview protocol: ${missing.join("; ")}`);
  return false;
}

// ---- static server -----------------------------------------------------------

interface RequestLog { url: string; status: number }
const requests: RequestLog[] = [];

function serveStatic(prefix: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      let status = 404;
      let response: Response;
      if (!url.pathname.startsWith(prefix) && url.pathname !== prefix.slice(0, -1)) {
        response = new Response("not found", { status: 404 });
      } else {
        const rel = decodeURIComponent(url.pathname.slice(prefix.length - 1));
        const path = resolve(SITE, `.${rel}`);
        if (!path.startsWith(SITE)) {
          response = new Response("forbidden", { status: 403 });
          status = 403;
        } else if (existsSync(path) && statSync(path).isDirectory()) {
          if (!url.pathname.endsWith("/")) {
            // What GitHub Pages does for a directory without its slash.
            response = Response.redirect(`${url.pathname}/`, 301);
            status = 301;
          } else if (existsSync(join(path, "index.html"))) {
            response = new Response(Bun.file(join(path, "index.html")));
            status = 200;
          } else response = new Response("not found", { status: 404 });
        } else if (existsSync(path)) {
          response = new Response(Bun.file(path));
          status = 200;
        } else response = new Response("not found", { status: 404 });
      }
      requests.push({ url: url.pathname, status });
      return response;
    },
  });
}

// ---- Chrome over CDP -----------------------------------------------------------

const launchChrome = (profile: string) => launchChromeWith(CHROME, profile);

// ---- checks ----------------------------------------------------------------------

interface Failure { check: string; message: string }
const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const audioContexts = new Map<string, Record<string, any>>();
const audioNodes = new Map<string, Record<string, any>>();

function expect(check: string, ok: boolean, message: string): void {
  if (!ok) failures.push({ check, message });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${check}: ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const rootServer = serveStatic("/");
  const subServer = serveStatic(PREFIX);
  const rootBase = `http://127.0.0.1:${rootServer.port}/`;
  const subBase = `http://127.0.0.1:${subServer.port}${PREFIX}`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChrome(profile);
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";
  let loadEvents = 0;

  cdp.on("Page.loadEventFired", () => { loadEvents++; });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") {
      consoleErrors.push(`[${phase}] console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(`[${phase}] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    if (p.entry.level === "error") consoleErrors.push(`[${phase}] log: ${p.entry.text} ${p.entry.url ?? ""}`);
  });
  cdp.on("Network.loadingFailed", (p) => {
    if (!p.canceled) consoleErrors.push(`[${phase}] request failed: ${p.errorText} ${p.requestId}`);
  });
  cdp.on("WebAudio.contextCreated", (p) => {
    audioContexts.set(p.context.contextId, p.context);
  });
  cdp.on("WebAudio.contextChanged", (p) => {
    const previous = audioContexts.get(p.context.contextId) ?? {};
    audioContexts.set(p.context.contextId, { ...previous, ...p.context });
  });
  cdp.on("WebAudio.contextWillBeDestroyed", (p) => {
    audioContexts.delete(p.contextId);
  });
  cdp.on("WebAudio.audioNodeCreated", (p) => {
    audioNodes.set(p.node.nodeId, p.node);
  });
  cdp.on("WebAudio.audioNodeWillBeDestroyed", (p) => {
    audioNodes.delete(p.nodeId);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("WebAudio.enable");

  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value as T;
  };
  const waitFor = async <T>(label: string, expression: string, timeout = 20_000): Promise<T> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForObserved = async <T>(label: string, read: () => T | undefined, timeout = 10_000): Promise<T> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = read();
      if (value !== undefined) return value;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const navigate = async (url: string) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url });
    await loaded;
  };
  const screenshot = async (name: string, fullPage = false) => {
    const metrics = fullPage ? await cdp.send("Page.getLayoutMetrics") : undefined;
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(size ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}),
    });
    await Bun.write(join(OUT, `${name}.page.png`), Buffer.from(shot.data, "base64"));
  };
  const canvasShot = async (name: string) => {
    const data = await evaluate<string>(`document.getElementById("screen").toDataURL("image/png")`);
    await Bun.write(join(OUT, `${name}.canvas.png`), Buffer.from(data.split(",")[1]!, "base64"));
  };
  const canvasStats = () =>
    evaluate<{ nonBlack: number; colors: number; hash: string }>(`(() => {
      const c = document.getElementById("screen");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0, h = 0x811c9dc5;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (v !== 0) nonBlack++;
        colors.add(v);
        h = Math.imul(h ^ v, 0x01000193);
      }
      return { nonBlack: nonBlack / (d.length / 4), colors: colors.size, hash: (h >>> 0).toString(16) };
    })()`);
  /** Whether the physical backing canvas and CSS presentation agree on one
   * whole number of device pixels per native-density raster sample. */
  const wholePixels = async (dpr: number) => {
    const fit = await evaluate<{
      k: number; raster: number; cssW: number; cssH: number;
      logicalW: number; logicalH: number; backingW: number; backingH: number; density: number;
    }>(`(() => {
      const c = document.getElementById("screen");
      const r = c.getBoundingClientRect();
      return {
        k: __pocketPlayer.scale.device,
        raster: __pocketPlayer.scale.raster,
        cssW: r.width,
        cssH: r.height,
        logicalW: __pocketPlayer.width,
        logicalH: __pocketPlayer.height,
        backingW: c.width,
        backingH: c.height,
        density: __pocketPlayer.config.rasterDensity,
      };
    })()`);
    // Layout snaps to 1/64 CSS px, so allow a few hundredths of a device pixel.
    const ok =
      fit.density >= 1 &&
      fit.k >= fit.density &&
      fit.k % fit.density === 0 &&
      fit.raster === fit.k / fit.density &&
      fit.backingW === fit.logicalW * fit.density &&
      fit.backingH === fit.logicalH * fit.density &&
      Math.abs(fit.cssW * dpr - fit.backingW * fit.raster) < 0.05 &&
      Math.abs(fit.cssH * dpr - fit.backingH * fit.raster) < 0.05;
    return {
      ok,
      text:
        `${fit.logicalW}x${fit.logicalH} logical, ${fit.backingW}x${fit.backingH} backing at ${fit.density}x; ` +
        `${fit.raster} device px/raster sample (${fit.cssW.toFixed(2)}x${fit.cssH.toFixed(2)} CSS px at ${dpr}x)`,
    };
  };
  const frames = () => evaluate<number>("__pocketPlayer.frames");
  const waitFrames = async (count: number) => {
    const target = (await frames()) + count;
    await waitFor(`frame ${target}`, `__pocketPlayer.frames >= ${target}`, count * 50 + 5_000);
  };
  const VK: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, KeyZ: 90, KeyL: 76, ShiftLeft: 16 };
  const key = (type: "keyDown" | "keyUp", code: string) =>
    cdp.send("Input.dispatchKeyEvent", { type, code, key: code.replace(/^Key/, "").toLowerCase().replace(/^arrow/, "Arrow"), windowsVirtualKeyCode: VK[code] ?? 0 });
  const holdKey = async (code: string, count: number) => {
    await key("keyDown", code);
    await waitFrames(count);
    await key("keyUp", code);
  };
  const clickElement = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
    await sleep(50);
    const point = await toClientOf(selector);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  };
  /** The demo menu collapses itself after a pick (and starts collapsed on
   *  touch screens); reopen it before driving another demo control. */
  const openDemoMenu = async () => {
    const expanded = await evaluate<string | null>(`document.querySelector("[data-demo-toggle]")?.getAttribute("aria-expanded") ?? null`);
    if (expanded === "false") await clickElement('[data-demo-toggle]');
  };
  const installNoReloadSentinel = () => evaluate(`globalThis.__demoClickSentinel = {
    player: globalThis.__pocketPlayer,
    canvas: document.getElementById("screen"),
    frames: globalThis.__pocketPlayer.frames,
  }`);
  const noReloadSentinel = () => evaluate<{ stable: boolean; advanced: boolean }>(`({
    stable: globalThis.__demoClickSentinel?.player === globalThis.__pocketPlayer &&
      globalThis.__demoClickSentinel?.canvas === document.getElementById("screen"),
    advanced: globalThis.__pocketPlayer.frames > globalThis.__demoClickSentinel?.frames,
  })`);
  /** Logical game pixel -> page CSS pixel, from the canvas rectangle. */
  const toClient = async (x: number, y: number) =>
    evaluate<{ x: number; y: number }>(`(() => {
      const r = document.getElementById("screen").getBoundingClientRect();
      const w = __pocketPlayer.width, h = __pocketPlayer.height;
      return { x: r.left + (${x} + 0.5) * r.width / w, y: r.top + (${y} + 0.5) * r.height / h };
    })()`);
  type Point = { x: number; y: number };
  const center = (rect: { x: number; y: number; w: number; h: number }): Point => ({
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
  });
  const clickClient = async (point: Point) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  };
  const clickLogical = async (point: Point) => {
    await clickClient(await toClient(point.x, point.y));
    await waitFrames(2);
  };
  const clickLogicalControl = (control: InspectorControl<unknown>, yOffset = 0) => {
    const point = center(control.rect);
    return clickLogical({ x: point.x, y: point.y + yOffset });
  };
  const dragLogical = async (from: Point, to: Point) => {
    const a = await toClient(from.x, from.y);
    const b = await toClient(to.x, to.y);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y, button: "none", buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: a.x + ((b.x - a.x) * i) / 4,
        y: a.y + ((b.y - a.y) * i) / 4,
        button: "left",
        buttons: 1,
      });
      await waitFrames(1);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
    await waitFrames(2);
  };
  const dispatchKey = (type: "keyDown" | "keyUp", code: string, keyName: string, modifiers = 0, text?: string) =>
    cdp.send("Input.dispatchKeyEvent", {
      type,
      code,
      key: keyName,
      modifiers,
      windowsVirtualKeyCode: code === "Enter" ? 13
        : code === "Backspace" ? 8
          : code === "Tab" ? 9
            : code === "ControlLeft" ? 17
              : code === "F5" ? 116
                : keyName.toUpperCase().charCodeAt(0),
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    });
  const pressNamedKey = async (code: "Enter" | "Backspace" | "Escape") => {
    await dispatchKey("keyDown", code, code);
    await dispatchKey("keyUp", code, code);
    await waitFrames(1);
  };
  const typeText = async (text: string) => {
    for (const character of text) {
      const upper = /^[A-Z]$/.test(character);
      const code = /^[A-Za-z]$/.test(character)
        ? `Key${character.toUpperCase()}`
        : character === " "
          ? "Space"
          : character === "."
            ? "Period"
            : "Unidentified";
      await dispatchKey("keyDown", code, character, upper ? 8 : 0, character);
      await dispatchKey("keyUp", code, character, upper ? 8 : 0);
    }
    await waitFrames(2);
  };
  const pressCommandZ = async () => {
    await dispatchKey("keyDown", "ControlLeft", "Control", 2);
    await dispatchKey("keyDown", "KeyZ", "z", 2);
    await dispatchKey("keyUp", "KeyZ", "z", 2);
    await dispatchKey("keyUp", "ControlLeft", "Control");
    await waitFrames(2);
  };
  const pressCommandS = async () => {
    await dispatchKey("keyDown", "ControlLeft", "Control", 2);
    await dispatchKey("keyDown", "KeyS", "s", 2);
    await dispatchKey("keyUp", "KeyS", "s", 2);
    await dispatchKey("keyUp", "ControlLeft", "Control");
    await waitFrames(2);
  };
  const openGame = async (base: string, id: string) => {
    phase = id;
    await navigate(`${base}${id}/`);
    await waitFor(`${id} running`, `globalThis.__pocketPlayer?.state === "running" && __pocketPlayer.frames > 30`);
  };
  const checkRuns = async (id: string) => {
    const stats = await canvasStats();
    expect(`${id}: renders`, stats.nonBlack > 0.3 && stats.colors > 20, `${(stats.nonBlack * 100).toFixed(1)}% non-black, ${stats.colors} colors`);
    const fit = await wholePixels(1);
    expect(`${id}: whole device pixels at 1x`, fit.ok, fit.text);
    const focused = await evaluate<boolean>(`document.activeElement === document.getElementById("stage")`);
    expect(`${id}: keyboard focus on load`, focused, focused ? "the game screen has focus" : "focus is elsewhere");
    return stats;
  };
  const loadCardPreviews = async (label: string) => {
    const selector = ".game-card:not(.showcase-card) img";
    const count = await evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    for (let index = 0; index < count; index++) {
      await evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.scrollIntoView({ block: "center" })`);
      await waitFor(
        `${label} preview ${index + 1}`,
        `(() => { const image = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; return image?.complete && image.naturalWidth > 0; })()`,
      );
    }
    await evaluate(`window.scrollTo(0, 0)`);
  };

  try {
    // ---- landing ----
    phase = "landing";
    await navigate(rootBase);
    // Local cards use lazy previews. Visit each one so this remains reliable
    // when a featured card or a narrow viewport makes the page much taller.
    await loadCardPreviews("landing");
    const landing = await evaluate<{ cards: string[]; studio: boolean; previews: number[]; links: string[] }>(`({
      // Showcase cards link projects hosted elsewhere; only this site's games count.
      cards: [...document.querySelectorAll(".game-card:not(.showcase-card):not(.studio-card) h2")].map((h) => h.textContent),
      studio: document.querySelector(".studio-card a[href='studio/']") !== null,
      previews: [...document.querySelectorAll(".game-card:not(.showcase-card) img")].map((i) => i.naturalWidth),
      links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
    })`);
    const games = (await Bun.file(join(SITE, "games.json")).json()) as {
      id: string; title: string; viewport: { policy: string }; rasterDensity: number;
    }[];
    expect(
      "landing: every game records a valid raster density",
      games.every((game) => Number.isInteger(game.rasterDensity) && game.rasterDensity >= 1 && game.rasterDensity <= 4),
      games.map((game) => `${game.id}=${game.rasterDensity}x`).join(", "),
    );
    expect("landing: one card per game", landing.cards.length === games.length, landing.cards.join(" | "));
    if (existsSync(join(SITE, "studio", "index.html"))) {
      expect("landing: the Studio card links to studio/", landing.studio, String(landing.studio));
    }
    expect("landing: previews load", landing.previews.every((w) => w > 0), `widths ${landing.previews.join(", ")}`);
    const absolute = landing.links.filter((h) => h.startsWith("/"));
    expect("landing: relative links", absolute.length === 0, absolute.length ? absolute.join(", ") : `${landing.links.length} links`);

    // The chapter list is a collapsed disclosure whose chips keep the deep
    // links, not a long vertical link list.
    const chapterLists = await evaluate<number>(`document.querySelectorAll("details.chapters").length`);
    if (chapterLists > 0) {
      const collapsed = await evaluate<boolean>(
        `[...document.querySelectorAll("details.chapters")].every((d) => !d.open)`,
      );
      expect("landing: the chapter list starts collapsed", collapsed, "every <details class=chapters> is closed");
      const chipLinks = await evaluate<string[]>(
        `[...document.querySelectorAll(".chapter-chips a")].map((a) => a.getAttribute("href"))`,
      );
      expect(
        "landing: chapter chips keep their deep links",
        chipLinks.length > 0 && chipLinks.every((href) => /\?chapter=[^&]+$/.test(href)),
        `${chipLinks.length} chips, e.g. ${chipLinks[0] ?? "none"}`,
      );
      await clickElement("details.chapters summary");
      const expanded = await evaluate<boolean>(`document.querySelector("details.chapters").open === true`);
      const chipsVisible = await evaluate<boolean>(
        `(() => { const el = document.querySelector(".chapter-chips a"); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; })()`,
      );
      expect(
        "landing: the disclosure opens to visible chips",
        expanded && chipsVisible,
        `details.open=${expanded}, chips visible=${chipsVisible}`,
      );
      await evaluate(`document.querySelector("details.chapters").open = false`);
    }
    const landingOverflow = await evaluate<number>(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
    );
    expect("landing: no horizontal overflow", landingOverflow <= 0, `${landingOverflow}px`);
    await screenshot("landing", true);
    results.landing = landing;

    // ---- editor: paint/undo, event text, play, download, persistence ----
    if (games.some((g) => g.id === "editor")) {
      phase = "editor";
      await openGame(rootBase, "editor");
      await waitFor(
        "editor browser document",
        `globalThis.__rpgkitEditorState?.().hasSvc === true
          && __rpgkitEditorState().hostFile === true
          && __pocketPlayer.editorHost?.ready === true
          && !document.querySelector("#editor-open")?.disabled`,
      );
      await checkRuns("editor");

      // The canvas is one stop after the file toolbar. Native backward Tab
      // must reach Download, and forward Tab must return to the canvas.
      await dispatchKey("keyDown", "Tab", "Tab", 8);
      await dispatchKey("keyUp", "Tab", "Tab");
      const backwardTabFocus = await evaluate<string>("document.activeElement?.id || ''");
      await dispatchKey("keyDown", "Tab", "Tab");
      await dispatchKey("keyUp", "Tab", "Tab");
      const forwardTabFocus = await evaluate<string>("document.activeElement?.id || ''");
      expect(
        "editor: native Tab traversal reaches the file toolbar and returns",
        backwardTabFocus === "editor-download" && forwardTabFocus === "stage",
        `Shift+Tab -> ${backwardTabFocus || "none"}; Tab -> ${forwardTabFocus || "none"}`,
      );

      const nativeReloadKeys = await evaluate<Array<{ key: string; prevented: boolean; queued: number }>>(`(() => {
        const stage = document.getElementById("stage");
        const cases = [
          { key: "F5", code: "F5" },
          { key: "r", code: "KeyR", ctrlKey: true },
          { key: "r", code: "KeyR", metaKey: true },
        ];
        return cases.map((init) => {
          const before = __pocketPlayer.svc.length;
          const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
          stage.dispatchEvent(event);
          return { key: init.key + (init.ctrlKey ? "+ctrl" : init.metaKey ? "+meta" : ""), prevented: event.defaultPrevented, queued: __pocketPlayer.svc.length - before };
        });
      })()`);
      expect(
        "editor: F5 and Ctrl/Cmd+R remain native browser shortcuts",
        nativeReloadKeys.every((entry) => !entry.prevented && entry.queued === 0),
        nativeReloadKeys.map((entry) => `${entry.key}: prevented=${entry.prevented}, queued=${entry.queued}`).join("; "),
      );

      const editorState = () => evaluate<any>("__rpgkitEditorState()");
      const initial = await editorState();
      const vp = await evaluate<{ w: number; h: number }>("({ w: __pocketPlayer.width, h: __pocketPlayer.height })");
      const fit = fittedView(vp.w, vp.h, false);
      const activeMap = initial.editor.project.maps[initial.editor.mapIndex];
      const cellPoint = (tx: number, ty: number): Point => ({
        x: fit.frame.x + (mapOffset(activeMap.width, fit.cols) + tx - initial.cam.x) * TILE + TILE / 2,
        y: fit.frame.y + (mapOffset(activeMap.height, fit.rows) + ty - initial.cam.y) * TILE + TILE / 2,
      });

      // Slot 0 is the eraser and slot 1 the sheet's first tile, so slot 2 is
      // a visible, non-null brush in both bundled editor documents.
      const palette = paletteSlotOrigin(2);
      await clickLogical({ x: palette.x + 6, y: HEADER_H + palette.y + 6 });
      const selected = await editorState();
      const brush = selected.editor.tile as string | null;
      expect("editor: real pointer selects a tile", typeof brush === "string", `selected ${brush ?? "eraser"}`);

      const minX = initial.cam.x;
      const maxX = Math.min(activeMap.width, initial.cam.x + fit.cols);
      const minY = initial.cam.y;
      const maxY = Math.min(activeMap.height, initial.cam.y + fit.rows);
      let paintCells: [{ x: number; y: number }, { x: number; y: number }] | null = null;
      for (let y = minY; y < maxY && paintCells === null; y++) {
        for (let x = minX; x + 1 < maxX; x++) {
          const index = y * activeMap.width + x;
          if (activeMap.ground[index] !== brush && activeMap.ground[index + 1] !== brush) {
            paintCells = [{ x, y }, { x: x + 1, y }];
            break;
          }
        }
      }
      if (!paintCells || brush === null) throw new Error("editor has no visible two-cell target for the selected tile");
      const [paintA, paintB] = paintCells;
      const paintBefore = [
        activeMap.ground[paintA.y * activeMap.width + paintA.x],
        activeMap.ground[paintB.y * activeMap.width + paintB.x],
      ];
      const historyBefore = initial.editor.past.length;
      await dragLogical(cellPoint(paintA.x, paintA.y), cellPoint(paintB.x, paintB.y));
      const painted = await editorState();
      const paintedMap = painted.editor.project.maps[painted.editor.mapIndex];
      const paintedValues = [
        paintedMap.ground[paintA.y * paintedMap.width + paintA.x],
        paintedMap.ground[paintB.y * paintedMap.width + paintB.x],
      ];
      expect(
        "editor: real pointer drag paints at least two cells",
        paintedValues.every((tile) => tile === brush) && painted.editor.past.length === historyBefore + 1,
        `${paintA.x},${paintA.y} and ${paintB.x},${paintB.y} -> ${paintedValues.join(", ")}; history ${historyBefore} -> ${painted.editor.past.length}`,
      );
      await canvasShot("editor-painted");

      await pressCommandZ();
      const undone = await editorState();
      const undoneMap = undone.editor.project.maps[undone.editor.mapIndex];
      const undoneValues = [
        undoneMap.ground[paintA.y * undoneMap.width + paintA.x],
        undoneMap.ground[paintB.y * undoneMap.width + paintB.x],
      ];
      expect(
        "editor: real Ctrl+Z undoes the drag stroke",
        undoneValues[0] === paintBefore[0] && undoneValues[1] === paintBefore[1] && undone.editor.past.length === historyBefore,
        `${paintedValues.join(", ")} -> ${undoneValues.join(", ")}; history ${painted.editor.past.length} -> ${undone.editor.past.length}`,
      );

      const layer = headerButtons(vp.w).find((button) => button.id === "layer")!;
      for (let i = 0; i < 3; i++) await clickLogical(center(layer));
      const eventsMode = await editorState();
      expect("editor: EVENT mode is reached by real clicks", eventsMode.eventMode === true, eventsMode.notice.text);

      const occupied = (activeMap.events ?? []).flatMap((event: any) => {
        const cells: string[] = [];
        for (let y = event.y; y < event.y + (event.h ?? 1); y++) {
          for (let x = event.x; x < event.x + (event.w ?? 1); x++) cells.push(`${x},${y}`);
        }
        return cells;
      });
      const occupiedCells = new Set(occupied);
      let eventCell: { x: number; y: number } | null = null;
      for (let y = minY; y < maxY && eventCell === null; y++) {
        for (let x = minX; x < maxX; x++) {
          if (!occupiedCells.has(`${x},${y}`)) {
            eventCell = { x, y };
            break;
          }
        }
      }
      if (!eventCell) throw new Error("editor has no visible empty cell for a new event");
      await clickLogical(cellPoint(eventCell.x, eventCell.y));
      const newTool = eventToolButtons().find((button) => button.id === "new")!;
      await clickLogical({ x: newTool.x + newTool.w / 2, y: HEADER_H + newTool.y + newTool.h / 2 });
      const created = await editorState();
      const eventId = created.editor.selectedEventId as string;
      expect(
        "editor: EVENT New creates and opens an event",
        created.inspectorOpen === true && typeof eventId === "string",
        `event ${eventId ?? "none"} at ${eventCell.x},${eventCell.y}`,
      );

      const inspectorFor = (state: any) => {
        const map = state.editor.project.maps[state.editor.mapIndex];
        const event = map.events.find((candidate: any) => candidate.id === state.editor.selectedEventId);
        const page = event.pages[state.editor.selectedPageIndex];
        const commands = commandInspectorRows(page.commands);
        return {
          commands,
          layout: createEventInspectorLayout({
            width: vp.w,
            height: vp.h - HEADER_H,
            pageCount: event.pages.length,
            activePage: state.editor.selectedPageIndex,
            conditions: [],
            commands,
            scroll: { pagesX: 0, conditionsY: 0, commandsY: 0 },
          }),
        };
      };
      let inspector = inspectorFor(created);
      const addCommand = inspector.layout.commandActions.find(
        (control) => control.action.kind === "command-action" && control.action.action === "add",
      )!;
      await clickLogicalControl(addCommand, HEADER_H);
      await typeText("text");
      await pressNamedKey("Enter");
      const commandAdded = await editorState();
      inspector = inspectorFor(commandAdded);
      const textRow = inspector.commands.findIndex((row) => row.command.op === "text");
      const lines = inspector.layout.commandRows[textRow]?.fields.find(
        (control) => control.action.kind === "command-field" && control.action.field === "lines",
      );
      if (!lines) throw new Error("new text command has no editable LINES field");
      await clickLogicalControl(lines, HEADER_H);
      const dialogue = "Hello from web editor.";
      await typeText(dialogue);
      await pressNamedKey("Enter");
      const authored = await editorState();
      const authoredMap = authored.editor.project.maps[authored.editor.mapIndex];
      const authoredEvent = authoredMap.events.find((event: any) => event.id === eventId);
      expect(
        "editor: command prompt and dialogue accept real keyboard input",
        authoredEvent?.pages[0]?.commands.some((command: any) => command.op === "text" && command.lines?.[0] === dialogue) === true,
        `${eventId}: ${authoredEvent?.pages[0]?.commands.map((command: any) => `${command.op}:${command.lines?.join("|") ?? ""}`).join(", ")}`,
      );
      await canvasShot("editor-event");
      await screenshot("editor-event");

      await pressNamedKey("Escape");
      expect(
        "editor: real Escape closes the event inspector",
        (await editorState()).inspectorOpen === false,
        "event inspector closed",
      );

      await pressCommandS();
      const recoveryText = await waitFor<string>(
        "editor browser Save",
        `localStorage.getItem(__pocketPlayer.editorHost.config.storageKey)?.includes(${JSON.stringify(dialogue)})
          ? localStorage.getItem(__pocketPlayer.editorHost.config.storageKey)
          : ""`,
      );
      expect(
        "editor: real Ctrl+S writes the browser recovery copy",
        recoveryText.includes(dialogue),
        `${recoveryText.length} saved bytes`,
      );

      const play = headerButtons(vp.w).find((button) => button.id === "play")!;
      await clickLogical(center(play));
      await waitFor("editor playtest", "__rpgkitEditorState().playtest === true && globalThis.__rpgSessionState");
      expect("editor: PLAY starts the edited project", (await editorState()).playtest === true, "playtest is running");
      await canvasShot("editor-playtest");
      await screenshot("editor-playtest");

      // The page toolbar remains useful during PLAY. This correlated export
      // used to be consumed and lost by the playtest service pump.
      await clickClient(await toClientOf("#editor-download"));
      const downloadFocus = await evaluate<string>("document.activeElement?.id || ''");
      expect(
        "editor: Download restores keyboard focus to the canvas",
        downloadFocus === "stage",
        `active element is #${downloadFocus || "none"}`,
      );
      const downloadText = await waitFor<string>(
        "editor download during playtest",
        `globalThis.__pocketPlayer?.editorHost?.lastDownload || ""`,
      );
      expect(
        "editor: Download remains live during PLAY",
        (await editorState()).playtest === true,
        `${downloadText.length} bytes while playtest keeps running`,
      );

      await clickLogical(center(playtestStopRect()));
      await waitFor("editor stop", "__rpgkitEditorState().playtest === false");
      const stopped = await editorState();
      const stoppedMap = stopped.editor.project.maps[stopped.editor.mapIndex];
      const stoppedEvent = stoppedMap.events.find((event: any) => event.id === eventId);
      expect("editor: STOP returns to the editor", stopped.playtest === false, "playtest stopped");
      expect(
        "editor: STOP preserves authored content and undo history",
        stoppedEvent?.pages[0]?.commands.some(
          (command: any) => command.op === "text" && command.lines?.[0] === dialogue,
        ) === true && stopped.editor.past.length === authored.editor.past.length,
        `event ${stoppedEvent?.id ?? "missing"}; history ${authored.editor.past.length} -> ${stopped.editor.past.length}`,
      );

      const downloaded = loadProject(downloadText);
      const downloadedEvent = downloaded.errors.length === 0
        ? downloaded.project.maps.flatMap((map) => map.events ?? []).find((event) => event.id === eventId)
        : undefined;
      const downloadedTextCommand = downloadedEvent?.pages.flatMap((page) => page.commands)
        .find((command) => command.op === "text");
      expect(
        "editor: real Download click returns valid edited JSON",
        downloaded.errors.length === 0 && downloadedEvent?.x === eventCell.x && downloadedEvent.y === eventCell.y
          && downloadedTextCommand?.op === "text" && downloadedTextCommand.lines[0] === dialogue,
        downloaded.errors.length > 0
          ? downloaded.errors.map((error) => `${error.path} ${error.msg}`).join("; ")
          : `${downloadText.length} bytes; ${downloadedEvent?.id ?? "event missing"}`,
      );
      const storedText = await evaluate<string | null>(
        "localStorage.getItem(__pocketPlayer.editorHost.config.storageKey)",
      );
      expect("editor: Download also saves to localStorage", storedText === downloadText, `${storedText?.length ?? 0} stored bytes`);
      await screenshot("editor-downloaded");

      await clickClient(await toClientOf('[data-editor-example="meadow"]'));
      await waitFor(
        "editor example switch",
        `__pocketPlayer.editorHost?.currentText?.includes("Pocket RPG Kit — Mini Meadow")
          && __rpgkitEditorState().editor.project.title === "Pocket RPG Kit — Mini Meadow"`,
      );
      const storageAfterOpen = await evaluate<string | null>(
        "localStorage.getItem(__pocketPlayer.editorHost.config.storageKey)",
      );
      expect(
        "editor: opening an example does not overwrite the saved recovery copy",
        storageAfterOpen === downloadText,
        `${storageAfterOpen?.length ?? 0} bytes remain saved while Meadow is open`,
      );
      await screenshot("editor-example-opened");

      // Exercise the browser's actual file-input path, not a probe injection.
      await clickClient(await toClientOf("#editor-open"));
      const dom = await cdp.send("DOM.getDocument", { depth: 1, pierce: true });
      const fileInput = await cdp.send("DOM.querySelector", {
        nodeId: dom.root.nodeId,
        selector: "#editor-open-input",
      });
      await cdp.send("DOM.setFileInputFiles", {
        nodeId: fileInput.nodeId,
        files: [join(ROOT, "examples/sunstone/data/sunstone.json")],
      });
      await waitFor(
        "editor local file import",
        `__pocketPlayer.editorHost?.currentName === "sunstone.json"
          && __rpgkitEditorState().editor.project.title === "The Sunstone of Bramble Hollow"
          && !__pocketPlayer.editorHost.currentText.includes(${JSON.stringify(dialogue)})`,
      );
      const storageAfterFile = await evaluate<string | null>(
        "localStorage.getItem(__pocketPlayer.editorHost.config.storageKey)",
      );
      expect(
        "editor: Open… imports a local JSON file without overwriting recovery",
        storageAfterFile === downloadText,
        `sunstone.json open; ${storageAfterFile?.length ?? 0} recovery bytes retained`,
      );
      await screenshot("editor-file-opened");

      phase = "editor-refresh";
      const reloaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
      await cdp.send("Page.reload", { ignoreCache: false });
      await reloaded;
      await waitFor(
        "editor localStorage restore",
        `globalThis.__pocketPlayer?.state === "running"
          && __pocketPlayer.frames > 30
          && globalThis.__rpgkitEditorState?.().hostFile === true
          && __pocketPlayer.editorHost?.currentText?.includes(${JSON.stringify(dialogue)})`,
      );
      const restoredHostText = await evaluate<string>("__pocketPlayer.editorHost.currentText");
      const restoredExport = await evaluate<{ ok: boolean; text: string }>("__rpgkitEditorExport()");
      const restored = loadProject(restoredExport.text);
      const restoredEvent = restored.errors.length === 0
        ? restored.project.maps.flatMap((map) => map.events ?? []).find((event) => event.id === eventId)
        : undefined;
      expect(
        "editor: refresh restores the localStorage project",
        restoredHostText === downloadText && restoredExport.ok === true
          && restoredEvent?.pages.some((page) => page.commands.some(
            (command) => command.op === "text" && command.lines[0] === dialogue,
          )) === true,
        `${restoredHostText.length} restored bytes; event ${restoredEvent?.id ?? "missing"}`,
      );
      await canvasShot("editor-restored");
      await screenshot("editor-restored");

      const proposalPast = (await editorState()).editor.past.length;
      const proposal = createProposalFromOperations(restoredExport.text, {
        id: "browser-preview",
        title: "Preview the village path",
        rationale: "Verify that browser-hosted proposals can be inspected without changing the project.",
        author: "web-verifier",
        createdAt: "2026-10-01T12:00:00.000Z",
        hunks: [{
          id: "path-tile",
          summary: "Brighten one path tile",
          operations: [{
            command: "paint-tile",
            args: { map: "village", layer: "ground", x: 8, y: 5, tile: "town.1" },
          }],
        }],
      });
      await evaluate(`__pocketPlayer.sendService(${JSON.stringify({ t: "proposals", proposals: [proposal] })})`);
      await waitFor("editor proposal queue", `__rpgkitEditorState().proposals?.some((proposal) => proposal.id === "browser-preview")`);
      const proposalsButton = headerButtons(vp.w).find((button) => button.id === "proposals")!;
      await clickLogical(center(proposalsButton));
      await waitFor("editor proposal panel", "__rpgkitEditorState().proposalOpen === true");
      const proposalRow = proposalRowRect(0, false, true);
      await clickLogical({ x: center(proposalRow).x, y: HEADER_H + center(proposalRow).y });
      const proposalState = await editorState();
      const proposalExport = await evaluate<{ ok: boolean; text: string }>("__rpgkitEditorExport()");
      const proposalPreviewVisible = proposalState.proposalPreview.tiles?.some(
        (tile: any) => tile.mapId === "village" && tile.x === 8 && tile.y === 5 && tile.tile === "town.1",
      ) === true;
      expect(
        "editor: PROPOSALS opens a non-mutating browser preview",
        proposalState.proposalOpen === true && proposalState.selectedProposal === 0
          && proposalPreviewVisible && proposalState.editor.past.length === proposalPast
          && proposalExport.ok === true && proposalExport.text === restoredExport.text,
        `open=${proposalState.proposalOpen}, selected=${proposalState.selectedProposal}, preview=${proposalPreviewVisible}, ` +
          `history ${proposalPast} -> ${proposalState.editor.past.length}, unchanged=${proposalExport.text === restoredExport.text}`,
      );
      await canvasShot("editor-proposal");
      await screenshot("editor-proposal");
      await clickLogical(center(proposalsButton));
      await waitFor("editor proposal panel close", "__rpgkitEditorState().proposalOpen === false");

      await evaluate(`(() => {
        globalThis.__originalStorageSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function () { throw new DOMException("blocked write", "SecurityError"); };
      })()`);
      await pressCommandS();
      const writeFailure = await waitFor<string>(
        "editor localStorage write failure",
        `document.querySelector("#editor-status.error")?.textContent?.includes("Save failed")
          ? document.querySelector("#editor-status").textContent
          : ""`,
      );
      expect(
        "editor: localStorage write failure is visible",
        writeFailure.includes("blocked write"),
        writeFailure,
      );
      await evaluate("Storage.prototype.setItem = globalThis.__originalStorageSetItem");

      const readFailureScript = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `Storage.prototype.getItem = function () {
          throw new DOMException("blocked read", "SecurityError");
        };`,
      });
      phase = "editor-storage-read-error";
      const errorReload = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
      await cdp.send("Page.reload", { ignoreCache: false });
      await errorReload;
      const readFailure = await waitFor<string>(
        "editor localStorage read failure",
        `globalThis.__pocketPlayer?.editorHost?.ready === true
          && document.querySelector("#editor-status.error")?.textContent?.includes("blocked read")
          ? document.querySelector("#editor-status").textContent
          : ""`,
      );
      expect("editor: localStorage read failure is visible", readFailure.includes("unavailable"), readFailure);
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: readFailureScript.identifier });
      await screenshot("editor-storage-error");
      results.editor = {
        brush,
        painted: [paintA, paintB],
        event: { id: eventId, ...eventCell, dialogue },
        downloadBytes: downloadText.length,
        openPreservedStorage: storageAfterOpen === downloadText && storageAfterFile === downloadText,
        restored: restoredHostText === downloadText,
        proposalPreview: proposalPreviewVisible,
      };
    }

    // ---- showcase: lobby -> two live halls -> lobby -----------------------
    if (games.some((g) => g.id === "showcase")) {
      await openGame(rootBase, "showcase");
      await checkRuns("showcase");
      const chapterPreviewCount = await evaluate<number>(`document.querySelectorAll('[data-demo-chapter] img').length`);
      if (chapterPreviewCount > 0) {
        await evaluate(`document.querySelector('[data-demo-chapter]:last-of-type')?.scrollIntoView({ block: "center" })`);
        await waitFor(
          "showcase chapter previews",
          `[...document.querySelectorAll('[data-demo-chapter] img')].every((image) => image.complete && image.naturalWidth > 0)`,
        );
      }
      const loadedChapterPreviews = await evaluate<number>(
        `[...document.querySelectorAll('[data-demo-chapter] img')].filter((image) => image.complete && image.naturalWidth > 0).length`,
      );
      expect(
        "showcase: chapter preview images load",
        loadedChapterPreviews === chapterPreviewCount,
        `${loadedChapterPreviews}/${chapterPreviewCount} loaded`,
      );
      const showcaseLoads = loadEvents;
      const showcaseErrors = consoleErrors.length;
      await installNoReloadSentinel();
      await clickElement('[data-demo-chapter="hall-streaming"]');
      await waitFor("showcase HTML chapter jump", `__rpgSessionState.mapId === "hall-streaming" &&
        __rpgSessionState.move.tx === ${HALL_ENTRY.x} && __rpgSessionState.move.ty === ${HALL_ENTRY.y} &&
        document.querySelector('[data-demo-chapter="hall-streaming"]').getAttribute("aria-current") === "true"`);
      const showcaseStable = await noReloadSentinel();
      const showcaseCurrent = await evaluate<string[]>(`[...document.querySelectorAll('[data-demo-chapter][aria-current="true"]')].map((button) => button.dataset.demoChapter)`);
      expect(
        "showcase: page chapter button jumps without reload",
        showcaseStable.stable && showcaseStable.advanced && loadEvents === showcaseLoads && showcaseCurrent.join() === "hall-streaming",
        `stable ${showcaseStable.stable}, frames advanced ${showcaseStable.advanced}, loads ${showcaseLoads} -> ${loadEvents}, current ${showcaseCurrent.join()}`,
      );
      expect(
        "showcase: page chapter jump has no console error",
        consoleErrors.length === showcaseErrors,
        `${consoleErrors.length - showcaseErrors} new error(s)`,
      );
      await screenshot("showcase-page-controls", true);

      // Reload once after the no-navigation assertion so the pre-existing
      // walk-through still starts in the authored lobby.
      await openGame(rootBase, "showcase");
      type ShowcasePosition = { mapId: string; tx: number; ty: number; moving: boolean; modal: string | null };
      const showcasePosition = () => evaluate<ShowcasePosition>(`(({ mapId, move, interp }) => ({
        mapId, tx: move.tx, ty: move.ty, moving: move.moving, modal: interp.modal?.kind ?? null,
      }))(__rpgSessionState)`);
      const walkShowcaseAxis = async (axis: "x" | "y", target: number, expectedMap: string) => {
        let state = await showcasePosition();
        const cell = axis === "x" ? "tx" : "ty";
        for (let guard = 0; guard < 40; guard++) {
          if (state.mapId !== expectedMap || (state[cell] === target && !state.moving)) return;
          const code = axis === "x"
            ? target > state.tx ? "ArrowRight" : "ArrowLeft"
            : target > state.ty ? "ArrowDown" : "ArrowUp";
          // Tap for one rendered frame, release, then let the committed tile
          // step finish. Holding while CDP polls can begin the next tile and
          // overshoot a one-cell portal on fast machines.
          await key("keyDown", code);
          await waitFrames(1);
          await key("keyUp", code);
          await waitFor("showcase tile boundary", `!__rpgSessionState.move.moving`, 3_000);
          state = await showcasePosition();
        }
        throw new Error(`showcase walk missed ${axis}=${target} on ${expectedMap}; at ${state.mapId}(${state.tx},${state.ty})`);
      };
      const walkShowcase = async (mapId: string, x: number, y: number, verticalFirst = false) => {
        if (verticalFirst) {
          await walkShowcaseAxis("y", y, mapId);
          if ((await showcasePosition()).mapId === mapId) await walkShowcaseAxis("x", x, mapId);
        } else {
          await walkShowcaseAxis("x", x, mapId);
          if ((await showcasePosition()).mapId === mapId) await walkShowcaseAxis("y", y, mapId);
        }
      };
      const pressShowcaseA = async () => {
        await holdKey("KeyA", 2);
        await waitFrames(2);
      };
      const finishShowcaseDemo = async () => {
        for (let guard = 0; guard < 80; guard++) {
          const status = await evaluate<{ idle: boolean; modal: string | null }>(`(({ interp, scene, fade, playerRoute }) => ({
            idle: interp.main === null && interp.modal === null && scene === null && fade === null && playerRoute === null,
            modal: interp.modal?.kind ?? null,
          }))(__rpgSessionState)`);
          if (status.idle) return;
          if (status.modal === "text") await pressShowcaseA();
          else await waitFrames(10);
        }
        throw new Error("showcase demonstration did not settle");
      };
      const showcaseDoor = (mapId: string) => {
        const index = SHOWCASE_HALLS.findIndex((hall) => hall.id === mapId);
        if (index < 0) throw new Error(`showcase: unknown hall ${mapId}`);
        return hallDoorPosition(index, SHOWCASE_HALLS.length);
      };

      // Hall 1: top-left portal, then action at the centre curator. Wait for
      // the named tint so this proves the command ran, not merely the map.
      const hall1Door = showcaseDoor("showcase-screen-effects");
      await walkShowcase("showcase-lobby", hall1Door.x, hall1Door.y);
      await waitFor("showcase hall 1", `__rpgSessionState.mapId === "showcase-screen-effects"`);
      await walkShowcase("showcase-screen-effects", HALL_DEMO.x, HALL_DEMO.y + 1);
      await pressShowcaseA();
      for (let guard = 0; guard < 30; guard++) {
        if (await evaluate<boolean>(`!!__rpgSessionState.interp.screen?.tints?.["time-of-day"]`)) break;
        if ((await showcasePosition()).modal === "text") await pressShowcaseA();
        else await waitFrames(10);
      }
      const tint = await evaluate<boolean>(`!!__rpgSessionState.interp.screen?.tints?.["time-of-day"]`);
      expect("showcase: hall 1 demonstration runs", tint, `named time-of-day tint present: ${tint}`);
      await canvasShot("showcase-hall-1");
      await finishShowcaseDemo();
      await walkShowcase("showcase-screen-effects", HALL_EXIT.x, HALL_EXIT.y - 1, true);
      await walkShowcaseAxis("y", HALL_EXIT.y, "showcase-screen-effects");
      await waitFor("showcase first return", `__rpgSessionState.mapId === "showcase-lobby"`);

      // Hall 8's demo walks the player across the streamed map and sets a
      // completion switch after the live route.
      const hall8Door = showcaseDoor("hall-streaming");
      await walkShowcase("showcase-lobby", hall8Door.x, hall8Door.y);
      await waitFor("showcase hall 8", `__rpgSessionState.mapId === "hall-streaming"`);
      await walkShowcase("hall-streaming", HALL_DEMO.x, HALL_DEMO.y + 1);
      await pressShowcaseA();
      await finishShowcaseDemo();
      const streamed = await evaluate<boolean>(`__rpgSessionState.sw.switches["showcase.streaming.complete"] === true`);
      expect("showcase: hall 8 demonstration runs", streamed, `streamed route completion switch: ${streamed}`);
      await canvasShot("showcase-hall-8");
      await walkShowcase("hall-streaming", HALL_EXIT.x, HALL_EXIT.y - 1, true);
      await walkShowcaseAxis("y", HALL_EXIT.y, "hall-streaming");
      await waitFor("showcase second return", `__rpgSessionState.mapId === "showcase-lobby"`);
      const returned = await showcasePosition();
      expect(
        "showcase: both hall exits return to the lobby",
        returned.mapId === "showcase-lobby",
        `returned to ${returned.mapId}(${returned.tx},${returned.ty})`,
      );
      await canvasShot("showcase-returned");
      await screenshot("showcase-returned");
      results.showcase = { tint, streamed, returned };
    }

    // ---- sunstone: attract, takeover, walk ----
    if (games.some((g) => g.id === "sunstone")) {
      await openGame(rootBase, "sunstone");
      await checkRuns("sunstone");
      const sunstoneLoads = loadEvents;
      const sunstoneErrors = consoleErrors.length;
      await installNoReloadSentinel();
      await clickElement('[data-demo-chapter="cave"]');
      await waitFor("sunstone HTML chapter jump", `__rpgSessionState.mapId === "cave" &&
        __rpgSessionState.move.tx === 9 && __rpgSessionState.move.ty === 11 &&
        __rpgSessionState.sw.switches["rune-lit"] === true &&
        __rpgSessionState.sw.items["thorn-key"] === 1 &&
        document.querySelector('[data-demo-chapter="cave"]').getAttribute("aria-current") === "true"`);

      // The in-game menu shares the same runtime. The HTML highlight must
      // follow a menu-driven Cave -> Forest jump, not just its own click.
      await evaluate(`document.getElementById("stage").focus()`);
      await holdKey("ShiftLeft", 2);
      await holdKey("ArrowUp", 2);
      await holdKey("KeyZ", 2);
      await waitFor("in-game chapter highlight", `__rpgSessionState.mapId === "forest" &&
        document.querySelector('[data-demo-chapter="forest"]').getAttribute("aria-current") === "true"`);

      const beforeFastFrame = await evaluate<number>("__rpgSessionState.frame");
      await openDemoMenu();
      await clickElement('[data-demo-speed="4"]');
      await waitFor("4x page autoplay", `globalThis.__rpgkitDemo?.current().chapter === "forest" &&
        globalThis.__rpgkitDemo?.current().autoplay === true &&
        globalThis.__rpgkitDemo?.current().speed === 4 &&
        document.querySelector('[data-demo-speed="4"]').getAttribute("aria-pressed") === "true"`);
      await waitFrames(2);
      const afterFastFrame = await evaluate<number>("__rpgSessionState.frame");
      const sunstoneStable = await noReloadSentinel();
      const sunstoneCurrent = await evaluate<string[]>(`[...document.querySelectorAll('[data-demo-chapter][aria-current="true"]')].map((button) => button.dataset.demoChapter)`);
      expect(
        "sunstone: page controls and in-game menu stay synchronized without reload",
        sunstoneStable.stable && sunstoneStable.advanced && loadEvents === sunstoneLoads && sunstoneCurrent.join() === "forest",
        `stable ${sunstoneStable.stable}, frames advanced ${sunstoneStable.advanced}, loads ${sunstoneLoads} -> ${loadEvents}, current ${sunstoneCurrent.join()}`,
      );
      expect(
        "sunstone: 4x page autoplay advances the chapter tape",
        afterFastFrame - beforeFastFrame >= 4,
        `reducer frame ${beforeFastFrame} -> ${afterFastFrame}`,
      );
      expect(
        "sunstone: page demo controls have no console error",
        consoleErrors.length === sunstoneErrors,
        `${consoleErrors.length - sunstoneErrors} new error(s)`,
      );
      await screenshot("sunstone-page-controls", true);

      // Progressive enhancement: without a guest hook, the same anchor
      // performs its documented query reload and the new game consumes it.
      const fallbackLoads = loadEvents;
      await evaluate(`globalThis.__rpgkitDemo = undefined`);
      await openDemoMenu();
      await clickElement('[data-demo-chapter="village"]');
      await waitFor("chapter link reload fallback", `location.search === "?chapter=village" &&
        globalThis.__pocketPlayer?.state === "running" && __rpgSessionState?.mapId === "village" &&
        globalThis.__rpgkitDemo?.current().chapter === "village"`);
      const fallbackHref = await evaluate<string>("location.href");
      expect(
        "sunstone: missing hook falls back to a chapter reload",
        loadEvents > fallbackLoads,
        `loads ${fallbackLoads} -> ${loadEvents}, ${fallbackHref}`,
      );

      // Start the original attract/takeover checks from a fresh default URL.
      await openGame(rootBase, "sunstone");
      const audioNamespace = await evaluate<{ exists: boolean; methods: string[] }>(`(() => {
        const host = globalThis.audio;
        const names = ["createStream", "destroyStream", "writePcm", "play", "pause", "stop", "setVolume", "endStream", "poll"];
        return { exists: !!host, methods: names.filter((name) => typeof host?.[name] === "function") };
      })()`);
      expect(
        "audio: host namespace is mounted before the game runs",
        audioNamespace.exists && audioNamespace.methods.length === 9,
        audioNamespace.exists ? `${audioNamespace.methods.length}/9 methods` : "globalThis.audio is absent",
      );
      const context = await waitForObserved(
        "Sunstone realtime AudioContext",
        () => [...audioContexts.values()].find((candidate) => candidate.contextType === "realtime"),
      );
      const mute = await toClientOf("#audio-mute");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: mute.x, y: mute.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mute.x, y: mute.y, button: "left", buttons: 0, clickCount: 1 });
      const runningContext = await waitForObserved(
        "running AudioContext after pointer gesture",
        () => [...audioContexts.values()].find((candidate) => candidate.contextState === "running"),
      );
      const workletNode = await waitForObserved(
        "Pocket AudioWorkletNode",
        () => [...audioNodes.values()].find(
          (candidate) => candidate.contextId === context.contextId && /worklet/i.test(String(candidate.nodeType)),
        ),
      );
      const muted = await evaluate<{ pressed: string | null; text: string; value: string }>(`({
        pressed: document.getElementById("audio-mute").getAttribute("aria-pressed"),
        text: document.getElementById("audio-mute").textContent,
        value: document.getElementById("audio-volume-value").textContent,
      })`);
      expect(
        "audio: pointer gesture starts the WebAudio worklet",
        runningContext.contextId === context.contextId && workletNode.contextId === context.contextId,
        `${context.contextState} -> ${runningContext.contextState}; ${workletNode.nodeType}`,
      );
      expect(
        "audio: mute control reflects its state",
        muted.pressed === "true" && muted.text === "Unmute" && muted.value === "100%",
        `${muted.text}, aria-pressed=${muted.pressed}, volume=${muted.value}`,
      );
      const volume = await evaluate<{ slider: string; text: string; master: number }>(`(() => {
        const slider = document.getElementById("audio-volume");
        slider.value = "35";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          slider: slider.value,
          text: document.getElementById("audio-volume-value").textContent,
          master: __pocketPlayer.audio.masterVolume,
        };
      })()`);
      expect(
        "audio: master volume control updates the host",
        volume.slider === "35" && volume.text === "35%" && volume.master === 0.35,
        `slider=${volume.slider}, output=${volume.text}, host=${volume.master}`,
      );
      // Restore audible output and keyboard focus for the interaction checks.
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: mute.x, y: mute.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mute.x, y: mute.y, button: "left", buttons: 0, clickCount: 1 });
      await evaluate(`document.getElementById("stage").focus()`);
      await screenshot("sunstone-audio");
      await canvasShot("sunstone-start");
      const pos = () =>
        evaluate<{ px: number; py: number; mapId: string; modal: boolean }>(
          `(({ move, mapId, interp }) => ({ px: move.px, py: move.py, mapId, modal: !!interp.modal }))(__rpgSessionState)`);
      // 10 idle seconds (600 frames) start the demo from a clean world.
      await waitFor("10 idle seconds", "__pocketPlayer.frames > 610", 30_000);
      const a0 = await pos();
      const trail: string[] = [];
      let demoWalks = false;
      for (let i = 0; i < 15 && !demoWalks; i++) {
        await waitFrames(10);
        const a = await pos();
        trail.push(`${a.px},${a.py}`);
        demoWalks = a.px !== a0.px || a.py !== a0.py || a.mapId !== a0.mapId;
      }
      await canvasShot("sunstone-attract");
      await screenshot("sunstone-attract");
      expect("sunstone: attract mode after 10 idle seconds", demoWalks, `no input; the player walks ${a0.px},${a0.py} -> ${trail.join(" -> ")}`);
      // Any key takes over on the current frame.
      await holdKey("KeyZ", 2);
      await waitFrames(10);
      await canvasShot("sunstone-takeover");
      await screenshot("sunstone-takeover");
      // Close a dialog the demo may have left open with the A key: the
      // game prompts "A next" (CIRCLE in the web-app glyph set).
      let presses = 0;
      while ((await pos()).modal && presses < 12) {
        await holdKey("KeyA", 2);
        await waitFrames(40);
        presses++;
      }
      const t0 = await pos();
      await waitFrames(60);
      const t1 = await pos();
      expect(
        "sunstone: a key takes over (the demo stops)",
        !t1.modal && t0.px === t1.px && t0.py === t1.py,
        `after ${presses} A press(es) the dialog is ${t1.modal ? "open" : "closed"}; idle: ${t0.px},${t0.py} -> ${t1.px},${t1.py}`,
      );
      const moves: string[] = [];
      let right = 0;
      let wrong = 0;
      for (const dir of ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"]) {
        const before = await pos();
        await holdKey(dir, 40);
        await waitFrames(20);
        const after = await pos();
        moves.push(`${dir}: ${before.px},${before.py} -> ${after.px},${after.py}`);
        const dx = after.px - before.px;
        const dy = after.py - before.py;
        const want = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[dir]!;
        if (Math.sign(dx) === want[0] && Math.sign(dy) === want[1]) right++;
        else if (dx !== 0 || dy !== 0) wrong++;
      }
      expect("sunstone: arrows walk the player", right >= 2 && wrong === 0, moves.join("; "));
      await canvasShot("sunstone-walk");
      await screenshot("sunstone-walk");
      results.sunstone = {
        moves,
        audio: {
          namespace: audioNamespace.methods,
          context: { state: runningContext.contextState, sampleRate: runningContext.sampleRate },
          node: workletNode.nodeType,
          volume,
        },
      };

      // ---- focus ----
      phase = "focus";
      const hint = async () => evaluate<boolean>(`!document.getElementById("focus-hint").hidden`);
      const heading = await toClientOf("#controls-heading");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: heading.x, y: heading.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: heading.x, y: heading.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      const blurred = await evaluate<boolean>(`document.activeElement !== document.getElementById("stage")`);
      expect("focus: clicking outside the game shows the hint", blurred && (await hint()), `hint visible: ${await hint()}`);
      await key("keyDown", "ArrowRight");
      await waitFrames(5);
      const maskUnfocused = await evaluate<number>("__pocketPlayer.buttons()");
      await key("keyUp", "ArrowRight");
      expect("focus: keys do not reach an unfocused game", maskUnfocused === 0, `button mask while → is down: ${maskUnfocused}`);
      await screenshot("focus-hint");
      const center = await toClient(240, 136);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(100);
      const refocused = await evaluate<boolean>(`document.activeElement === document.getElementById("stage")`);
      await key("keyDown", "ArrowRight");
      await waitFrames(2);
      const maskFocused = await evaluate<number>("__pocketPlayer.buttons()");
      await key("keyUp", "ArrowRight");
      expect(
        "focus: clicking the game gives it the keys again",
        refocused && !(await hint()) && maskFocused === 0x0020,
        `stage focused: ${refocused}; button mask while → is down: 0x${maskFocused.toString(16)}`,
      );
    }

    // ---- grow: growth, mouse drag, touch drag, keys ----
    if (games.some((g) => g.id === "grow")) {
      await openGame(rootBase, "grow");
      await checkRuns("grow");
      const grow = () => evaluate<{ tick: number; total: number; auto: boolean; mode: string }>(`(({ tick, total, auto, mode }) => ({ tick, total, auto, mode }))(__rpgGrowState)`);
      const g0 = await grow();
      await waitFrames(150);
      const g1 = await grow();
      expect("grow: grows on its own", g1.tick > g0.tick, `tick ${g0.tick} -> ${g1.tick} of ${g1.total}`);
      await canvasShot("grow-growing");
      await screenshot("grow-growing");
      // Mouse: press on the strip at 10%, drag to 60%, release.
      const view = await evaluate<{ w: number; h: number }>("({ w: __pocketPlayer.width, h: __pocketPlayer.height })");
      const stripY = view.h - 8;
      const at = (f: number) => Math.round(view.w * f);
      const from = await toClient(at(0.1), stripY);
      const to = await toClient(at(0.6), stripY);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      await waitFrames(3);
      const m0 = await grow();
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 10, y: from.y, button: "left", buttons: 1 });
        await waitFrames(1);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
      await waitFrames(3);
      const m1 = await grow();
      const gw = await evaluate<number>("__pocketPlayer.width");
      const want = (x: number, total: number) => Math.round((x / gw) * total);
      expect("grow: mouse press on the timeline seeks", Math.abs(m0.tick - want(at(0.1), m0.total)) <= 1, `tick ${m0.tick}, expected ~${want(at(0.1), m0.total)}`);
      expect("grow: mouse drag scrubs the timeline", Math.abs(m1.tick - want(at(0.6), m1.total)) <= 1, `tick ${m1.tick}, expected ~${want(at(0.6), m1.total)}`);
      await canvasShot("grow-mouse-scrub");
      await screenshot("grow-mouse-scrub");
      // Touch: a finger on the strip at 25%, sliding to 40%.
      const t0 = await toClient(at(0.25), stripY);
      const t1 = await toClient(at(0.4), stripY);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t0.x, y: t0.y, id: 1 }] });
      await waitFrames(3);
      const f0 = await grow();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t1.x, y: t1.y, id: 1 }] });
      await waitFrames(3);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitFrames(3);
      const f1 = await grow();
      expect("grow: touch on the timeline seeks", Math.abs(f0.tick - want(at(0.25), f0.total)) <= 1, `tick ${f0.tick}, expected ~${want(at(0.25), f0.total)}`);
      expect("grow: touch drag scrubs the timeline", Math.abs(f1.tick - want(at(0.4), f1.total)) <= 1, `tick ${f1.tick}, expected ~${want(at(0.4), f1.total)}`);
      await holdKey("ArrowLeft", 2);
      await waitFrames(3);
      const k1 = await grow();
      expect("grow: ← steps one tick back", k1.tick === f1.tick - 1, `tick ${f1.tick} -> ${k1.tick}`);
      await canvasShot("grow-touch-scrub");
      // Live viewport: a smaller window runs a smaller logical viewport, and
      // the core's viewport fact follows the canvas.
      const viewNow = () => evaluate<{ w: number; h: number; vw: number; vh: number }>(
        `({ w: __pocketPlayer.width, h: __pocketPlayer.height, vw: ui.__viewport.w, vh: ui.__viewport.h })`);
      const v0 = await viewNow();
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
      await waitFor("grow resize", `__pocketPlayer.width !== ${v0.w}`, 5_000);
      await waitFrames(30);
      const v1 = await viewNow();
      const resized = await canvasStats();
      expect(
        "grow: the dynamic viewport follows the window",
        v1.w !== v0.w && v1.vw === v1.w && v1.vh === v1.h && resized.nonBlack > 0.3,
        `${v0.w}x${v0.h} -> ${v1.w}x${v1.h} (core ${v1.vw}x${v1.vh}), ${(resized.nonBlack * 100).toFixed(1)}% non-black`,
      );
      await canvasShot("grow-resized");
      await screenshot("grow-resized");
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      results.grow = { g0, g1, m0, m1, f0, f1, k1, v0, v1 };
    }

    // ---- meadow: walk ----
    if (games.some((g) => g.id === "meadow")) {
      await openGame(rootBase, "meadow");
      await checkRuns("meadow");
      const pos = () => evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgkitExample.state())`);
      const p0 = await pos();
      await holdKey("ArrowUp", 30);
      await waitFrames(20);
      const p1 = await pos();
      await holdKey("ArrowRight", 40);
      await waitFrames(20);
      const p2 = await pos();
      expect("meadow: ↑ walks up", p1.py < p0.py && p1.px === p0.px, `${p0.px},${p0.py} -> ${p1.px},${p1.py}`);
      expect("meadow: → walks right", p2.px > p1.px && p2.py === p1.py, `${p1.px},${p1.py} -> ${p2.px},${p2.py}`);
      await canvasShot("meadow-walk");
      await screenshot("meadow-walk");
      results.meadow = { p0, p1, p2 };
    }

    // ---- sizing at 2x and on a phone ----
    phase = "sizing";
    const first = games[0]!.id;
    const byPolicy = new Map<string, string>();
    for (const game of games) if (!byPolicy.has(game.viewport.policy)) byPolicy.set(game.viewport.policy, game.id);
    for (const [policy, id] of byPolicy) {
      for (const dpr of [2, 1.25]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false });
        await openGame(rootBase, id);
        const fit = await wholePixels(dpr);
        expect(`sizing: ${policy} ${id} at ${dpr}x uses whole device pixels`, fit.ok, fit.text);
      }
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await openGame(rootBase, first);
    await sleep(300);
    const phone = await evaluate<{ pad: boolean; width: number }>(`({ pad: getComputedStyle(document.querySelector(".pad")).display !== "none", width: document.getElementById("stage").getBoundingClientRect().width })`);
    expect("sizing: the phone layout fits and shows touch buttons", phone.pad && phone.width <= 390, `pad ${phone.pad}, screen ${phone.width.toFixed(1)}px wide`);
    const phoneMenu = await evaluate<{ collapsed: boolean; chapters: number }>(`(() => {
      const toggle = document.querySelector("[data-demo-toggle]");
      const body = document.querySelector(".demo-body");
      return {
        collapsed: toggle?.getAttribute("aria-expanded") === "false" && body?.hidden === true,
        chapters: document.querySelectorAll("[data-demo-chapter]").length,
      };
    })()`);
    expect(
      "sizing: the demo menu starts collapsed on a touch screen",
      phoneMenu.collapsed && phoneMenu.chapters > 0,
      `collapsed ${phoneMenu.collapsed}, ${phoneMenu.chapters} chapter(s)`,
    );
    if (phoneMenu.chapters > 0) {
      await clickElement('[data-demo-toggle]');
      const opened = await evaluate<string>(`document.querySelector("[data-demo-toggle]").getAttribute("aria-expanded")`);
      const firstChapter = await evaluate<string>(`document.querySelector("[data-demo-chapter]").dataset.demoChapter`);
      expect("sizing: the demo menu toggle opens the panel", opened === "true", `aria-expanded=${opened}`);
      await clickElement(`[data-demo-chapter="${firstChapter}"]`);
      const picked = await evaluate<{ collapsed: boolean; current: string | null }>(`({
        collapsed: document.querySelector("[data-demo-toggle]").getAttribute("aria-expanded") === "false",
        current: document.querySelector("[data-demo-chapter][aria-current='true']")?.dataset.demoChapter ?? null,
      })`);
      expect(
        "sizing: picking a chapter jumps and collapses the menu again",
        picked.collapsed && picked.current === firstChapter,
        `collapsed ${picked.collapsed}, current ${picked.current}, wanted ${firstChapter}`,
      );
    }
    await screenshot("phone");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // ---- subpath ----
    phase = "subpath";
    const before = requests.length;
    await navigate(subBase);
    await loadCardPreviews("subpath");
    for (const game of games) {
      await openGame(subBase, game.id);
      const f0 = await frames();
      await sleep(500);
      const f1 = await frames();
      const stats = await canvasStats();
      const state = await evaluate<string>("__pocketPlayer.state");
      expect(
        `subpath: ${game.id} runs under ${PREFIX}`,
        state === "running" && f1 > f0,
        `${state}, frames ${f0} -> ${f1}, ${(stats.nonBlack * 100).toFixed(1)}% non-black`,
      );
    }
    // Studio is static pages, not a game: it must open its default example
    // under the sub-path too, with every request staying under the prefix.
    if (existsSync(join(SITE, "studio", "index.html"))) {
      await navigate(`${subBase}studio/`);
      const studio = await waitFor<{ maps: number; kind: string } | null>(
        "Studio ready",
        `document.documentElement.dataset.ready === "1" && __studio.app.session ? { maps: __studio.app.session.maps().length, kind: __studio.app.session.kind } : null`,
      );
      expect(`subpath: Studio opens an example under ${PREFIX}`, !!studio && studio.maps > 0, JSON.stringify(studio));
      await screenshot("subpath-studio");
    }
    await screenshot("subpath-last-game");
    const outside = requests.slice(before).filter((r) => r.status === 404);
    expect("subpath: every request stays under the prefix", outside.length === 0, outside.length ? outside.map((r) => r.url).join(", ") : `${requests.length - before} requests`);

    // ---- preview protocol demo ----
    // Only a site built with the preview app has preview-demo.html and
    // preview/ (tools/web.ts adds both for the kit site); a game site
    // that never opts in has nothing to check here.
    if (previewProtocolCheck(SITE, games.map((game) => game.id))) {
      // The demo page on the root server embeds the preview host from the
      // subpath server (a different origin) and allowlists its own origin.
      phase = "preview";
      const rootOrigin = new URL(rootBase).origin;
      const previewHost = `${subBase}preview/`;
      await navigate(`${rootBase}preview-demo.html`);
      await waitFor("preview demo page", "window.__previewDemo");
      await evaluate(`__previewDemo.connect(${JSON.stringify(previewHost)}, ${JSON.stringify([rootOrigin])})`);
      await waitFor("preview host ready", "__previewDemo.ready()");

      // A notification sent before any project is loaded must stay contained:
      // the host's backend throws not-loaded, but the dispatcher swallows it
      // instead of letting it escape into the host page's event loop.
      const errorsBeforeInput = consoleErrors.length;
      await evaluate(`__previewDemo.post({ protocol: "rpgkit-preview/v1", type: "input", buttons: 1 })`);
      await sleep(300);
      expect(
        "preview: an input notification before load produces no console error",
        consoleErrors.length === errorsBeforeInput,
        consoleErrors.length === errorsBeforeInput ? "clean" : consoleErrors.slice(errorsBeforeInput).join("\n"),
      );

      const load = await evaluate<any>(`__previewDemo.loadSample()`);
      expect(
        "preview: load sample document",
        load?.maps?.[0]?.id === "yard" && load?.start?.map === "yard",
        JSON.stringify(load),
      );

      const start = await evaluate<any>(`__previewDemo.startAt("yard", 2, 2, "down")`);
      expect(
        "preview: start at a tile",
        start?.map === "yard" && start?.x === 2 && start?.y === 2,
        JSON.stringify(start),
      );

      const stateBefore = await evaluate<any>(`__previewDemo.readState()`);
      expect(
        "preview: state summary",
        stateBefore?.map === "yard" && typeof stateBefore?.switches === "object" && stateBefore?.gold === 10,
        JSON.stringify(stateBefore),
      );

      await evaluate(`__previewDemo.press("RIGHT", 30)`);
      await sleep(700); // let the injected 31-frame tape play out
      const after = await evaluate<any>(`__previewDemo.readState()`);
      expect(
        "preview: injected input walks",
        after?.px !== stateBefore?.px || after?.x !== stateBefore?.x,
        `px ${stateBefore?.px} -> ${after?.px}`,
      );
      await screenshot("preview-demo-running");

      const bad = await evaluate<any>(
        `__previewDemo.loadText("{not json").catch((e) => ({ ok: false, error: { code: String(e.message).split(":")[0] } }))`,
      );
      expect("preview: bad JSON is refused", bad?.ok === false && bad.error?.code === "bad-document", JSON.stringify(bad));

      // Re-embed without allowlisting the page's origin: requests are dropped,
      // so the demo's send times out. The reconnect reloads the host page.
      await evaluate(`__previewDemo.connect(${JSON.stringify(previewHost)}, [])`);
      await waitFor("preview host ready again", "__previewDemo.ready()");
      let rejected = false;
      try {
        await evaluate(`__previewDemo.send("state", {}, 2500)`);
      } catch {
        rejected = true;
      }
      expect("preview: a non-allowlisted origin gets no reply", rejected, "the state request was answered");

      // Re-allow the origin, load again (the reconnect reloaded the host), then
      // drive the host same-origin and capture its native canvas.
      await evaluate(`__previewDemo.connect(${JSON.stringify(previewHost)}, ${JSON.stringify([rootOrigin])})`);
      await waitFor("preview host ready a third time", "__previewDemo.ready()");
      const again = await evaluate<any>(`__previewDemo.loadSample()`);
      expect("preview: channel works after re-allow", again?.maps?.[0]?.id === "yard", JSON.stringify(again));
      const sample = await evaluate<string>(`document.getElementById("sample-project").textContent.trim()`);
      {
        // Over postMessage from another origin: a Chinese document reports
        // its baked characters (the drawing is checked same-origin below).
        const doc = JSON.parse(sample);
        doc.maps[0].events[0].pages[0].commands[0].lines = ["园丁：你好。"];
        const zh = await evaluate<any>(`__previewDemo.loadText(${JSON.stringify(JSON.stringify(doc))})`);
        expect(
          "preview: a Chinese document loads over the protocol with its glyphs",
          zh?.maps?.[0]?.id === "yard" && zh?.glyphs?.added === 6 && zh?.glyphs?.missing === "",
          JSON.stringify(zh?.glyphs),
        );
      }

      // ---- wire limits: exact budget accepted, one byte over refused ----
      // The padded document is built in the page (not shipped over CDP); the
      // pad length is measured with the same structural counter the host
      // bundles, so the accepted case lands exactly on the budget.
      {
        const padFor = (id: string, extra: number) =>
          PREVIEW_LIMITS.maxMessageBytes -
          previewMessageBytes({ protocol: "rpgkit-preview/v1", type: "load", requestId: id, document: sample }) +
          extra;
        const padExact = padFor("b1-exact", 0);
        const paddedCount = previewMessageBytes({
          ...{ protocol: "rpgkit-preview/v1", type: "load", requestId: "b1-exact", document: sample },
          document: sample.replace("{", `{${" ".repeat(padExact)}`),
        });
        expect("preview: limit math lands exactly on the budget", paddedCount === PREVIEW_LIMITS.maxMessageBytes, `${paddedCount} bytes`);
        const exact = await evaluate<any>(
          `__previewDemo.request({ protocol: "rpgkit-preview/v1", type: "load", requestId: "b1-exact", document: document.getElementById("sample-project").textContent.trim().replace("{", "{" + " ".repeat(${padExact})) })`,
        );
        expect("preview: a document exactly at the byte budget loads", exact?.maps?.[0]?.id === "yard", JSON.stringify(exact).slice(0, 160));
        const padOver = padFor("b1-over", 1);
        const overReply = await evaluate<any>(
          `__previewDemo.request({ protocol: "rpgkit-preview/v1", type: "load", requestId: "b1-over", document: document.getElementById("sample-project").textContent.trim().replace("{", "{" + " ".repeat(${padOver})) }).catch((e) => ({ ok: false, error: { code: String(e.message).split(":")[0] } }))`,
        );
        expect(
          "preview: a document one byte over the budget is too-large",
          overReply?.ok === false && overReply.error?.code === "too-large",
          JSON.stringify(overReply).slice(0, 160),
        );
      }

      // ---- wire limits: chapter count, tape length, snapshot bytes ----
      const refuseLoad = async (label: string, chapters: unknown) => {
        const reply = await evaluate<any>(
          `__previewDemo.request(${JSON.stringify({ protocol: "rpgkit-preview/v1", type: "load", requestId: `b1-${label}`, document: sample, chapters })})` +
            `.catch((e) => ({ ok: false, error: { code: String(e.message).split(":")[0] } }))`,
        );
        expect(`preview: ${label} is too-large`, reply?.ok === false && reply.error?.code === "too-large", JSON.stringify(reply).slice(0, 160));
      };
      await refuseLoad(
        "one chapter over the count limit",
        Array.from({ length: PREVIEW_LIMITS.maxChapters + 1 }, (_, i) => ({ id: `c${i}`, title: "t", snapshot: "s" })),
      );
      await refuseLoad(
        "one frame over the tape length limit",
        [{ id: "c0", title: "t", snapshot: "s", tape: new Array<number>(PREVIEW_LIMITS.maxChapterTapeLength + 1).fill(0) }],
      );
      await refuseLoad(
        "one byte over the snapshot size limit",
        [{ id: "c0", title: "t", snapshot: "s".repeat(PREVIEW_LIMITS.maxSnapshotBytes + 1) }],
      );

      // ---- chapter restore and tape playback on the real host ----
      // A snapshot taken headlessly from the same document (its authored
      // start) is handed to the host as a chapter with a tape. The chapter
      // start must restore the snapshot exactly; the tape must then play.
      {
        const loaded = loadProject(sample);
        expect("preview: headless snapshot document loads", loaded.errors.length === 0, loaded.errors[0]?.msg ?? "clean");
        const session = createSession(loaded.project);
        const atStart = startSession(loaded.project, session, createSwitchState(), null);
        const snapshot = createSessionSnapshot(session, atStart, 0);
        const tape = new Array<number>(30).fill(0x0020); // RIGHT for 30 frames, then release
        tape.push(0);
        const chapter = { id: "restore", title: "Restore point", snapshot, tape };
        await evaluate(`__previewDemo.startAt("yard", 2, 2, "down")`);
        const away = await evaluate<any>(`__previewDemo.readState()`);
        expect("preview: walked away from the start", away?.x === 2 && away?.y === 2, JSON.stringify(away));
        const withChapter = await evaluate<any>(
          `__previewDemo.request(${JSON.stringify({ protocol: "rpgkit-preview/v1", type: "load", requestId: "ch-load", document: sample, chapters: [chapter] })})`,
        );
        expect("preview: load with a chapter", withChapter?.maps?.[0]?.id === "yard", JSON.stringify(withChapter).slice(0, 160));
        const started = await evaluate<any>(
          `__previewDemo.request(${JSON.stringify({ protocol: "rpgkit-preview/v1", type: "start", requestId: "ch-start", chapter: "restore" })})`,
        );
        expect(
          "preview: chapter start restores the snapshot",
          started?.x === 5 && started?.y === 5 && started?.dir === "up",
          JSON.stringify(started),
        );
        await sleep(900); // let the 31-frame tape play out
        const played = await evaluate<any>(`__previewDemo.readState()`);
        expect(
          "preview: the chapter tape plays after restore",
          (played?.px ?? 0) > 5 * 16 || (played?.x ?? 0) > 5,
          `px ${played?.px}, x ${played?.x}`,
        );
      }

      // ---- reference frontend: same-origin spoofs are ignored ----
      // A second window on the host's own origin forges a ready event and a
      // reply. The demo must only accept hostFrame.contentWindow as a source.
      {
        const sameOriginHost = `${rootBase}preview/`;
        await evaluate(`__previewDemo.connect(${JSON.stringify(sameOriginHost)}, [])`);
        await waitFor("preview host ready (same-origin)", "__previewDemo.ready()");
        await evaluate(`__previewDemo.loadSample()`);
        const spoof = await evaluate<string>(`(async () => {
          const nextId = __previewDemo.nextRequestId();
          const spoof = document.createElement("iframe");
          spoof.style.display = "none";
          document.body.appendChild(spoof);
          await new Promise((resolve) => { spoof.onload = resolve; spoof.srcdoc = "<!doctype html><body>spoof</body>"; });
          const readyLines = () => [...document.getElementById("log").children].filter((d) => d.textContent.indexOf("ready:") === 0).length;
          const before = readyLines();
          // Forged ready from the wrong (same-origin) window.
          spoof.contentWindow.eval("parent.postMessage({protocol:'rpgkit-preview/v1',type:'event',event:'ready',version:1},'*')");
          // Queue a real request, then forge its reply from the spoof window in
          // the same task, so the forged reply is queued before the host answers.
          const pending = __previewDemo.request({ protocol: "rpgkit-preview/v1", type: "state", requestId: nextId }, 5000);
          spoof.contentWindow.eval("parent.postMessage({protocol:'rpgkit-preview/v1',type:'reply',requestId:'" + nextId + "',ok:true,result:{forged:true}},'*')");
          const settled = await pending.then((v) => ({ v })).catch((e) => ({ e: e.message }));
          const after = readyLines();
          spoof.remove();
          return JSON.stringify({ before, after, settled });
        })()`);
        const parsed = JSON.parse(spoof);
        expect(
          "preview: a forged ready from another same-origin window is ignored",
          parsed.after === parsed.before,
          `ready lines ${parsed.before} -> ${parsed.after}`,
        );
        expect(
          "preview: a forged reply from another same-origin window is ignored",
          parsed.settled?.v?.map === "yard" && !JSON.stringify(parsed.settled).includes("forged"),
          JSON.stringify(parsed.settled).slice(0, 160),
        );
      }

      phase = "preview-canvas";
      await navigate(previewHost);
      await waitFor("preview host running", `globalThis.__pocketPlayer?.state === "running" && __pocketPlayer.frames > 30`);
      await evaluate(`__rpgkitPreview.load(${JSON.stringify(sample)})`);
      await evaluate(`__rpgkitPreview.start({ kind: "tile", map: "yard", x: 5, y: 5, dir: "up" })`);
      await sleep(1000);
      const direct = await evaluate<any>(`__rpgkitPreview.state()`);
      expect("preview: same-origin direct drive", direct?.map === "yard" && direct?.x === 5 && direct?.y === 5, JSON.stringify(direct));
      await canvasShot("preview-canvas");

      // ---- Chinese text: baked at load from the preview's budgeted faces ----
      // Two different lines must draw two different pictures (before, both
      // drew identical missing-glyph boxes); the screenshots are kept for a
      // human look. The license of the faces is served beside the host.
      {
        phase = "preview-chinese";
        const withLines = (lines: string[]) => {
          const doc = JSON.parse(sample);
          doc.maps[0].events[0].pages[0].commands[0].lines = lines;
          return JSON.stringify(doc);
        };
        const talk = async (lines: string[], name: string) => {
          const load = await evaluate<any>(
            `(() => { const t = performance.now(); const r = __rpgkitPreview.load(${JSON.stringify(withLines(lines))}); return { ...r, ms: performance.now() - t }; })()`,
          );
          await evaluate(`__rpgkitPreview.start({ kind: "tile", map: "yard", x: 5, y: 3, dir: "up" })`);
          await sleep(300);
          // Talk with a real key press (an injected input tape would hold the
          // page in tape playback once it ends).
          await key("keyDown", "Enter");
          await sleep(80);
          await key("keyUp", "Enter");
          await sleep(2500); // the typewriter finishes
          const state = await evaluate<any>(`__rpgkitPreview.state()`);
          const stats = await canvasStats();
          await canvasShot(name);
          return { load, state, stats };
        };
        const ZH_A = ["园丁：欢迎来到预览的小院子。", "这个世界是一段粘贴进来的文档。"];
        const ZH_B = ["园丁：明天早上记得给花浇水，", "别忘了关上东边那扇木门。"];
        const a = await talk(ZH_A, "preview-chinese-a");
        const b = await talk(ZH_B, "preview-chinese-b");
        expect(
          "preview: a Chinese document's characters are baked at load",
          a.load?.glyphs?.added > 0 && a.load?.glyphs?.missing === "" && b.load?.glyphs?.missing === "",
          `A ${JSON.stringify(a.load?.glyphs)} in ${Math.round(a.load?.ms)} ms, B ${JSON.stringify(b.load?.glyphs)} in ${Math.round(b.load?.ms)} ms`,
        );
        expect(
          "preview: the Chinese lines are on screen",
          a.state?.message?.text === ZH_A.join("\n") && b.state?.message?.text === ZH_B.join("\n"),
          JSON.stringify([a.state?.message, b.state?.message]),
        );
        expect("preview: two Chinese lines draw two different pictures", a.stats.hash !== b.stats.hash, `${a.stats.hash} vs ${b.stats.hash}`);
        const licenses = await evaluate<any>(
          `Promise.all(["LICENSE-NotoSansCJK.txt", "LICENSE-Inter.txt"].map((f) => fetch(f).then(async (r) => ({ f, ok: r.ok, ofl: (await r.text()).includes("SIL OPEN FONT LICENSE Version 1.1") }))))`,
        );
        expect(
          "preview: the font licenses are served beside the host",
          Array.isArray(licenses) && licenses.length === 2 && licenses.every((l: any) => l.ok && l.ofl),
          JSON.stringify(licenses),
        );
        phase = "preview-canvas";
      }

      const stop = await evaluate<any>(`__rpgkitPreview.stop()`);
      expect("preview: stop", stop === undefined || stop === null, JSON.stringify(stop));
      const idle = await evaluate<any>(
        `(() => { try { return __rpgkitPreview.state(); } catch (e) { return { ok: false, error: { code: e.code || String(e.message).split(":")[0] } }; } })()`,
      );
      expect("preview: state after stop is not-loaded", idle?.ok === false && idle.error?.code === "not-loaded", JSON.stringify(idle));
      await screenshot("preview-demo");
    }
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${phase}: ${error instanceof Error ? error.message : error}`);
    await screenshot(`error-${phase}`).catch(() => {});
  } finally {
    const bad = requests.filter((r) => r.status >= 400);
    expect("network: no failed requests", bad.length === 0, bad.length ? bad.map((r) => `${r.status} ${r.url}`).join(", ") : `${requests.length} requests`);
    expect("console: no errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join("\n") : "clean");
    await Bun.write(join(OUT, "report.json"), JSON.stringify({ failures, results, consoleErrors, requests }, null, 2) + "\n");
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    rootServer.stop(true);
    subServer.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }

  async function toClientOf(selector: string) {
    return evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }
}

if (import.meta.main) {
  if (!existsSync(join(SITE, "index.html"))) {
    console.error(`web-verify: no site at ${SITE}; run \`bun run web\` first`);
    process.exit(2);
  }
  await main();
  console.log(`\nweb-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; screenshots and report.json in ${OUT}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
