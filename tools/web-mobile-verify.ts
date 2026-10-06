// tools/web-mobile-verify.ts — play the built web site (dist/web) in headless
// Chrome with phone emulation (mobile metrics + touch) and check the mobile
// layout across the common phone viewports:
//
//   bun run web && bun tools/web-mobile-verify.ts
//   bun tools/web-mobile-verify.ts --chrome /usr/bin/google-chrome --out dist/web-mobile
//   bun tools/web-mobile-verify.ts --game pocket-tuxemon --expect-map bedroom
//
// Landing page: the chapter list is a collapsed disclosure whose chips carry
// the deep links, and neither the landing nor the player page scrolls
// horizontally at any phone width.
//
// Per portrait viewport: the touch pad and every one of its buttons sit in
// the first viewport (no scrolling), the screen sits above the pad, the demo
// menu starts collapsed, and opening it shows a really-visible panel (a
// screenshot is taken while it is open) before picking a chapter jumps there
// and collapses it again. Per landscape viewport: the Fullscreen button
// enters the immersive mode (real fullscreen when the API works in this
// browser, the fixed CSS fallback otherwise), the screen takes the largest
// whole-pixel scale fit.ts allows for the full safe-area height and is
// centred both ways, the buttons clear the screen's centre, a real touch on
// the d-pad walks the player, two fingers press the d-pad and A at once, and
// the exit button restores the page layout.
//
// This is the same mobile emulation Playwright drives
// (Emulation.setDeviceMetricsOverride with mobile=true plus
// Input.dispatchTouchEvent); the kit already speaks CDP directly in
// tools/web-verify.ts, so this tool reuses that helper instead of taking on
// a Playwright dependency. Screenshots land in --out for a human look.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Cdp, launchChrome as launchChromeWith } from "./lib/cdp.ts";
import { fitViewport } from "./web/fit.ts";

const ROOT = resolve(import.meta.dir, "..");
const SITE = resolve(option("site", join(ROOT, "dist", "web")));
const OUT = resolve(option("out", join(ROOT, "dist", "web-mobile")));
const CHROME = option("chrome", Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome");
const GAME = option("game", "sunstone");
/** The chapter to jump to (and walk in); needs room to walk right. */
const CHAPTER = option("chapter", "cave");
/** The map id the chapter jump lands on, when the game exposes it. */
const EXPECT_MAP = option("expect-map", "cave");

function option(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

/** CSS viewports the task names, with a representative device pixel ratio. */
const PORTRAIT: ReadonlyArray<readonly [number, number, number]> = [
  [390, 844, 3], // iPhone 14 Pro
  [412, 915, 2.625], // Pixel 7
  [360, 740, 3], // Galaxy S20
  [375, 667, 2], // iPhone SE
];

interface Failure { check: string; message: string }
const failures: Failure[] = [];
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];

function expect(check: string, ok: boolean, message: string): void {
  if (!ok) failures.push({ check, message });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${check}: ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!existsSync(join(SITE, "index.html"))) {
    console.error(`web-mobile-verify: no site at ${SITE}; run \`bun run web\` first`);
    process.exit(2);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const path = resolve(SITE, `.${decodeURIComponent(url.pathname)}`);
      if (!path.startsWith(SITE)) return new Response("forbidden", { status: 403 });
      if (existsSync(path) && statSync(path).isDirectory()) {
        if (!url.pathname.endsWith("/")) return Response.redirect(`${url.pathname}/`, 301);
        return new Response(Bun.file(join(path, "index.html")));
      }
      return existsSync(path) ? new Response(Bun.file(path)) : new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}/`;
  const profile = mkdtempSync(join(OUT, "chrome-profile-"));
  const chrome = await launchChromeWith(CHROME, profile);
  const cdp = await Cdp.connect(chrome.ws);
  let phase = "startup";

  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") {
      consoleErrors.push(`[${phase}] console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description).join(" ")}`);
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    consoleErrors.push(`[${phase}] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
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
  const frames = () => evaluate<number>("__pocketPlayer.frames");
  const waitFrames = async (count: number) => {
    const target = (await frames()) + count;
    await waitFor(`frame ${target}`, `__pocketPlayer.frames >= ${target}`, count * 50 + 5_000);
  };
  const navigate = async (url: string) => {
    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url });
    await loaded;
  };
  const openGame = async (width: number, height: number, dpr: number) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await navigate(`${base}${GAME}/`);
    await waitFor(`${GAME} running`, `globalThis.__pocketPlayer?.state === "running" && __pocketPlayer.frames > 30`);
  };
  const screenshot = async (name: string) => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
  };
  /** Whole device pixels per raster sample, backing canvas == logical × density.
   *  When one raster sample per device pixel cannot fit (a 480px game on a
   *  375px@2x phone), fit.ts deliberately shrinks the canvas (k=0); that is a
   *  designed fallback, reported separately rather than failed. Either way the
   *  presented rectangle must keep the logical aspect ratio, so a deformed
   *  stage (e.g. a scaleX override) fails instead of passing silently. */
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
        cssW: r.width, cssH: r.height,
        logicalW: __pocketPlayer.width, logicalH: __pocketPlayer.height,
        backingW: c.width, backingH: c.height,
        density: __pocketPlayer.config.rasterDensity,
      };
    })()`);
    const backing = fit.backingW === fit.logicalW * fit.density && fit.backingH === fit.logicalH * fit.density;
    const shrunk = fit.k === 0;
    const aspect = fit.logicalW / fit.logicalH;
    const presentedAspect = fit.cssW / fit.cssH;
    const undeformed = Math.abs(presentedAspect - aspect) / aspect < 0.02;
    const ok =
      fit.density >= 1 &&
      backing &&
      undeformed &&
      (shrunk ||
        (fit.k >= fit.density &&
          fit.k % fit.density === 0 &&
          fit.raster === fit.k / fit.density &&
          Math.abs(fit.cssW * dpr - fit.backingW * fit.raster) < 0.05 &&
          Math.abs(fit.cssH * dpr - fit.backingH * fit.raster) < 0.05));
    return {
      ok,
      shrunk,
      text:
        `${fit.logicalW}x${fit.logicalH} logical, ${fit.backingW}x${fit.backingH} backing at ${fit.density}x; ` +
        (shrunk
          ? `shrunk to fit (${fit.cssW.toFixed(2)}x${fit.cssH.toFixed(2)} CSS px at ${dpr}x)`
          : `${fit.raster} device px/raster sample (${fit.cssW.toFixed(2)}x${fit.cssH.toFixed(2)} CSS px at ${dpr}x)`),
    };
  };
  const rectOf = async (selector: string) =>
    evaluate<{ x: number; y: number; top: number; left: number; w: number; h: number; bottom: number; right: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.x, y: r.y, top: r.top, left: r.left, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; })()`,
    );
  const touchAt = async (points: Array<{ x: number; y: number; id: number }>, type: "touchStart" | "touchMove" | "touchEnd") => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
    });
  };
  const centerOf = async (selector: string) => {
    const r = await rectOf(selector);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  /** documentElement.scrollWidth must not exceed the viewport width:
   *  nothing on the page may force a horizontal scrollbar on a phone. */
  const noOverflow = async (label: string) => {
    const report = await evaluate<{ scrollWidth: number; innerWidth: number }>(
      `({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`,
    );
    expect(
      `${label}: no horizontal overflow`,
      report.scrollWidth <= report.innerWidth + 1,
      `scrollWidth ${report.scrollWidth} <= innerWidth ${report.innerWidth}`,
    );
  };
  /** Whether an element is really presented: in the flow, unhidden, with
   *  non-zero opacity and a non-empty rect. A check on the attribute alone
   *  passes while the panel is invisible, so the geometry is checked too. */
  const reallyVisible = async (selector: string) =>
    evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        parseFloat(style.opacity) > 0.01 && r.width > 2 && r.height > 2;
    })()`);

  try {
    // ---- landing page: collapsed chapter disclosure and no overflow ------
    phase = "landing";
    console.log(`\n# landing (${GAME} site)`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await navigate(base);
    await sleep(400);
    await noOverflow("landing 390x844");
    const chaptersOnLanding = await evaluate<number>(`document.querySelectorAll("details.chapters").length`);
    if (chaptersOnLanding > 0) {
      const collapsed = await evaluate<boolean>(
        `[...document.querySelectorAll("details.chapters")].every((d) => !d.open)`,
      );
      expect("landing: the chapter list starts collapsed", collapsed, "every <details class=chapters> is closed");
      const chipLinks = await evaluate<string[]>(
        `[...document.querySelectorAll(".chapter-chips a")].map((a) => a.getAttribute("href"))`,
      );
      expect(
        "landing: chapter chips keep their deep links",
        chipLinks.length > 0 && chipLinks.every((href) => /\\?chapter=[^&]+$/.test(href)),
        `${chipLinks.length} chips, e.g. ${chipLinks[0] ?? "none"}`,
      );
      // A real touch on the summary expands the panel and shows the chips.
      // The disclosure can sit below the first viewport on a tall card, so
      // scroll it into view before touching it.
      await evaluate(`document.querySelector("details.chapters summary").scrollIntoView({ block: "center" })`);
      await sleep(200);
      const summary = await centerOf("details.chapters summary");
      await touchAt([{ ...summary, id: 1 }], "touchStart");
      await touchAt([{ ...summary, id: 1 }], "touchEnd");
      const expanded = await waitFor(
        "landing chapters expanded",
        `document.querySelector("details.chapters").open === true`,
      );
      const chipsVisible = await reallyVisible(".chapter-chips a");
      expect(
        "landing: the disclosure opens to visible chips by touch",
        expanded !== undefined && chipsVisible,
        `details.open=${expanded !== undefined}, chips visible=${chipsVisible}`,
      );
      await noOverflow("landing 390x844 expanded");
      await screenshot(`mobile-landing-chapters-open`);
    } else {
      console.log("  ok  landing: no chapter lists on this site");
    }

    for (const [width, height, dpr] of PORTRAIT) {
      phase = `portrait ${width}x${height}`;
      console.log(`\n# portrait ${width}x${height} @${dpr}x`);
      await openGame(width, height, dpr);
      await sleep(300);

      const layout = await evaluate<{
        pad: boolean; padBottom: number; padTop: number; stageBottom: number;
        buttons: Array<{ label: string; bottom: number; visible: boolean }>;
        innerHeight: number; menuCollapsed: boolean;
      }>(`(() => {
        const pad = document.querySelector(".pad");
        const pr = pad.getBoundingClientRect();
        const sr = document.getElementById("stage").getBoundingClientRect();
        const toggle = document.querySelector("[data-demo-toggle]");
        return {
          pad: getComputedStyle(pad).display !== "none",
          padTop: pr.top, padBottom: pr.bottom, stageBottom: sr.bottom,
          buttons: [...pad.querySelectorAll("[data-button]")].map((b) => {
            const r = b.getBoundingClientRect();
            return { label: b.dataset.button, bottom: r.bottom, visible: r.width > 0 && r.height > 0 };
          }),
          innerHeight: window.innerHeight,
          menuCollapsed: toggle?.getAttribute("aria-expanded") === "false" && document.querySelector(".demo-body")?.hidden === true,
        };
      })()`);
      const allButtonsInFirstViewport = layout.buttons.every((b) => b.visible && b.bottom <= layout.innerHeight + 1);
      expect(
        `${phase}: pad and every button are in the first viewport`,
        layout.pad && allButtonsInFirstViewport && layout.padBottom <= layout.innerHeight + 1,
        `${layout.buttons.length} buttons, pad bottom ${layout.padBottom.toFixed(0)} of ${layout.innerHeight}`,
      );
      expect(
        `${phase}: the screen sits directly above the pad`,
        layout.stageBottom <= layout.padTop + 1,
        `stage bottom ${layout.stageBottom.toFixed(0)}, pad top ${layout.padTop.toFixed(0)}`,
      );
      expect(`${phase}: the demo menu starts collapsed`, layout.menuCollapsed, `aria-expanded=false, body hidden`);
      const fit = await wholePixels(dpr);
      expect(`${phase}: whole device pixels`, fit.ok, fit.text);
      await noOverflow(phase);
      await evaluate(`window.scrollTo(0, 0)`);
      await screenshot(`mobile-${width}x${height}-portrait`);

      // Open the menu and prove it is really visible before picking. The
      // screenshot is taken while the panel is open, not after it collapsed.
      const toggle = await centerOf("[data-demo-toggle]");
      await touchAt([{ ...toggle, id: 1 }], "touchStart");
      await touchAt([{ ...toggle, id: 1 }], "touchEnd");
      const opened = await evaluate<string>(`document.querySelector("[data-demo-toggle]").getAttribute("aria-expanded")`);
      expect(`${phase}: the toggle opens the menu by touch`, opened === "true", `aria-expanded=${opened}`);
      const menuVisible = await reallyVisible(".demo-body");
      const cardVisible = await reallyVisible('[data-demo-chapter]');
      expect(
        `${phase}: the open menu is really visible`,
        menuVisible && cardVisible,
        `demo-body visible=${menuVisible}, a chapter card visible=${cardVisible}`,
      );
      await evaluate(`document.querySelector('[data-demo-chapter="${CHAPTER}"]')?.scrollIntoView({ block: "center" })`);
      await sleep(100);
      await screenshot(`mobile-${width}x${height}-portrait-menu`);
      // A large page can keep the renderer busy while the screenshot is
      // captured; let it settle so the chapter touch is not dropped.
      await sleep(300);
      const chapter = await centerOf(`[data-demo-chapter="${CHAPTER}"]`);
      await touchAt([{ ...chapter, id: 1 }], "touchStart");
      await touchAt([{ ...chapter, id: 1 }], "touchEnd");
      await sleep(500);
      const jumped = await waitFor(
        `${phase} ${CHAPTER} jump`,
        // Return a boolean, not the session object: a large game state can
        // fail returnByValue serialization and make the poll never settle.
        `!!__rpgSessionState &&
          document.querySelector('[data-demo-chapter="${CHAPTER}"]').getAttribute("aria-current") === "true" &&
          document.querySelector("[data-demo-toggle]").getAttribute("aria-expanded") === "false"`,
      );
      const mapOk = EXPECT_MAP
        ? await evaluate<boolean>(`__rpgSessionState?.mapId === ${JSON.stringify(EXPECT_MAP)}`)
        : true;
      expect(
        `${phase}: picking a chapter jumps and collapses the menu`,
        jumped !== undefined && mapOk,
        `aria-current, collapsed${EXPECT_MAP ? `, mapId=${EXPECT_MAP}` : ""}`,
      );
    }

    for (const [height, width, dpr] of PORTRAIT) {
      phase = `landscape ${width}x${height}`;
      console.log(`\n# landscape ${width}x${height} @${dpr}x`);
      await openGame(width, height, dpr);
      await sleep(300);

      const toggle = await centerOf("#fullscreen-toggle");
      await touchAt([{ ...toggle, id: 1 }], "touchStart");
      await touchAt([{ ...toggle, id: 1 }], "touchEnd");
      const immersive = await waitFor(
        `${phase} immersive`,
        `document.body.classList.contains("immersive") && __pocketPlayer.state === "running"`,
      );
      const fullscreenPath = await evaluate<string>(
        `document.fullscreenElement ? "fullscreen-api" : "css-fallback"`,
      );
      expect(
        `${phase}: the Fullscreen button enters immersive play (${fullscreenPath})`,
        immersive !== undefined,
        `body.immersive via ${fullscreenPath}`,
      );
      await sleep(200);

      const stage = await rectOf("#stage");
      const pad = await rectOf(".pad");
      expect(
        `${phase}: the screen is fully visible`,
        stage.y >= -1 && stage.bottom <= height + 1,
        `stage ${stage.y.toFixed(0)}..${stage.bottom.toFixed(0)} of ${height}`,
      );
      // The screen must take the largest whole-pixel scale fit.ts allows for
      // the full safe-area area (not a band reserved for the pad), and be
      // centred both ways.
      const area = await evaluate<{
        w: number; h: number; dpr: number; density: number;
        viewport: { policy: string; logical?: [number, number]; default?: [number, number]; min?: [number, number]; max?: [number, number] };
        k: number;
      }>(`(() => {
        const area = document.querySelector(".screen-area");
        const style = getComputedStyle(area);
        return {
          w: area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          h: area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
          dpr: window.devicePixelRatio || 1,
          density: __pocketPlayer.config.rasterDensity,
          viewport: __pocketPlayer.config.viewport,
          k: __pocketPlayer.scale.device,
        };
      })()`);
      const expected = fitViewport(area.viewport as any, area.w, area.h, area.dpr, area.density);
      expect(
        `${phase}: the screen takes the largest whole-pixel scale`,
        area.k === expected.k,
        `k=${area.k}, fit.ts allows ${expected.k} for ${area.w.toFixed(0)}x${area.h.toFixed(0)}@${area.dpr}x`,
      );
      const areaRect = await rectOf(".screen-area");
      const stageCenterY = stage.y + stage.h / 2;
      const areaCenterY = areaRect.y + areaRect.h / 2;
      expect(
        `${phase}: the screen is centred vertically`,
        Math.abs(stageCenterY - areaCenterY) <= 1,
        `stage centre ${stageCenterY.toFixed(1)} vs area centre ${areaCenterY.toFixed(1)}`,
      );
      // The pad floats OVER the picture: the d-pad and the action cluster
      // each intersect the screen rect, and no button covers the screen's
      // centre half (the 50%-wide, 50%-tall rectangle on the screen
      // centre). The corners are the accepted handheld layout.
      const overlay = await evaluate<{ clusters: boolean; centerClear: boolean }>(`(() => {
        const stage = document.getElementById("stage").getBoundingClientRect();
        const hit = (r) => r.left < stage.right && r.right > stage.left && r.top < stage.bottom && r.bottom > stage.top;
        const clusters = hit(document.querySelector(".dpad").getBoundingClientRect()) &&
          hit(document.querySelector(".actions").getBoundingClientRect());
        const cx = stage.left + stage.width / 2;
        const cy = stage.top + stage.height / 2;
        const centerClear = ![...document.querySelectorAll(".pad [data-button], .immersive-tools > button")].some((b) => {
          const r = b.getBoundingClientRect();
          return r.right > cx - stage.width / 4 && r.left < cx + stage.width / 4 &&
                 r.bottom > cy - stage.height / 4 && r.top < cy + stage.height / 4;
        });
        return { clusters, centerClear };
      })()`);
      expect(`${phase}: the controls overlay the screen`, overlay.clusters, "d-pad and actions intersect the stage rect");
      expect(`${phase}: the buttons clear the screen's centre half`, overlay.centerClear, "no button covers the centre 50% rect");
      // Resting buttons are translucent (30-45% opaque); a held button turns
      // solid and highlighted.
      const restOpacity = await evaluate<number>(
        `parseFloat(getComputedStyle(document.querySelector('[data-button="CIRCLE"]')).opacity)`,
      );
      expect(
        `${phase}: the resting buttons are translucent`,
        restOpacity >= 0.3 && restOpacity <= 0.45,
        `opacity ${restOpacity.toFixed(2)}`,
      );
      const circle = await centerOf('[data-button="CIRCLE"]');
      await touchAt([{ ...circle, id: 1 }], "touchStart");
      await waitFrames(2);
      const heldOpacity = await evaluate<number>(
        `parseFloat(getComputedStyle(document.querySelector('[data-button="CIRCLE"].held')).opacity)`,
      );
      await touchAt([], "touchEnd");
      expect(`${phase}: a held button turns solid`, heldOpacity >= 0.9, `opacity ${heldOpacity.toFixed(2)}`);
      const fit = await wholePixels(dpr);
      expect(`${phase}: whole device pixels in immersive mode`, fit.ok, fit.text);
      await noOverflow(phase);

      // A real touch on the d-pad walks the player (game state, not events).
      // Jump to a walkable chapter first: a fresh boot can sit in a dialog
      // (Pocket Tuxemon's intro) where no input moves the player. The demo
      // menu is hidden in immersive mode, so drive the hook directly.
      await evaluate(`globalThis.__rpgkitDemo?.jump(${JSON.stringify(CHAPTER)})`);
      await waitFor(`${phase} ${CHAPTER} for walk`, `__rpgSessionState?.mapId && __pocketPlayer.state === "running"`);
      await waitFrames(10);
      const before = await evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgSessionState)`);
      const right = await centerOf('[data-button="RIGHT"]');
      await touchAt([{ ...right, id: 1 }], "touchStart");
      await waitFrames(45);
      await touchAt([{ ...right, id: 1 }], "touchEnd");
      await waitFrames(5);
      const after = await evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgSessionState)`);
      expect(
        `${phase}: a touch on the d-pad walks the player`,
        after.px > before.px && after.py === before.py,
        `px ${before.px} -> ${after.px}`,
      );

      // Multi-touch: d-pad and A held together both reach the game.
      const aButton = await centerOf('[data-button="CIRCLE"]');
      await touchAt([{ ...right, id: 1 }, { ...aButton, id: 2 }], "touchStart");
      await waitFrames(2);
      const held = await evaluate<{ count: number; bits: number[] }>(
        `({ count: __pocketPlayer.pad.size, bits: [...__pocketPlayer.pad.values()] })`,
      );
      await touchAt([], "touchEnd");
      expect(
        `${phase}: d-pad and A press together (multi-touch)`,
        held.count === 2 && held.bits.length === 2 && held.bits[0] !== held.bits[1],
        `${held.count} contact(s), bits ${held.bits.join(",")}`,
      );

      // A tap on the picture (a non-button part of the screen) reaches the
      // game: the player walks toward the tapped tile. Re-jump so the tap
      // starts from the chapter's known position.
      await evaluate(`globalThis.__rpgkitDemo?.jump(${JSON.stringify(CHAPTER)})`);
      await waitFor(`${phase} ${CHAPTER} for tap`, `__rpgSessionState?.mapId && __pocketPlayer.state === "running"`);
      await waitFrames(10);
      const tapTarget = await evaluate<{ x: number; y: number } | null>(`(() => {
        const ps = globalThis.__rpgPlayerScreen;
        if (!ps) return null;
        const stage = document.getElementById("stage").getBoundingClientRect();
        const lw = __pocketPlayer.width, lh = __pocketPlayer.height;
        // Three tiles to the right of the player, into open floor.
        const lx = Math.min(ps.x + 48, lw - 8);
        const ly = Math.min(Math.max(ps.y + 8, 8), lh - 8);
        const x = stage.left + (lx / lw) * stage.width;
        const y = stage.top + (ly / lh) * stage.height;
        const el = document.elementFromPoint(x, y);
        if (!el || !el.closest("#stage")) return null; // a button is there
        return { x, y };
      })()`);
      if (tapTarget) {
        const before = await evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgSessionState)`);
        await touchAt([{ ...tapTarget, id: 1 }], "touchStart");
        await touchAt([{ ...tapTarget, id: 1 }], "touchEnd");
        await waitFrames(90);
        const after = await evaluate<{ px: number; py: number }>(`(({ move }) => ({ px: move.px, py: move.py }))(__rpgSessionState)`);
        expect(
          `${phase}: a tap on the picture walks the player`,
          after.px > before.px + 24,
          `px ${before.px} -> ${after.px}`,
        );
      } else {
        expect(`${phase}: a tap on the picture walks the player`, false, "no button-free tap target found");
      }

      // Overlay screenshots for the report (idle, A held, pad hidden) on the
      // widest viewport; both game runs produce the six required shots.
      if (width === 844 && height === 390) {
        await screenshot(`mobile-landscape-overlay-idle`);
        await touchAt([{ ...aButton, id: 1 }], "touchStart");
        await waitFrames(2);
        await screenshot(`mobile-landscape-overlay-hold-a`);
        await touchAt([], "touchEnd");
        const padToggle = await centerOf("#pad-toggle");
        await touchAt([{ ...padToggle, id: 1 }], "touchStart");
        await touchAt([{ ...padToggle, id: 1 }], "touchEnd");
        await sleep(100);
        await screenshot(`mobile-landscape-overlay-hidden`);
        // Restore the pad so the exit check below sees the normal layout.
        await touchAt([{ ...padToggle, id: 1 }], "touchStart");
        await touchAt([{ ...padToggle, id: 1 }], "touchEnd");
        await sleep(100);
        await evaluate(`localStorage.removeItem("pocket-rpgkit:web:pad-hidden")`);
      }

      await screenshot(`mobile-${width}x${height}-landscape`);

      // The exit button restores the normal page layout.
      const exit = await centerOf("#immersive-exit");
      await touchAt([{ ...exit, id: 1 }], "touchStart");
      await touchAt([{ ...exit, id: 1 }], "touchEnd");
      const restored = await waitFor(
        `${phase} exit immersive`,
        `!document.body.classList.contains("immersive") && __pocketPlayer.state === "running"`,
      );
      const normal = await evaluate<boolean>(
        `document.getElementById("stage").getBoundingClientRect().top >= 0 && !document.fullscreenElement`,
      );
      expect(`${phase}: the exit button restores the page layout`, restored !== undefined && normal, `immersive off, fullscreen off`);
      results[`landscape-${width}x${height}`] = { fullscreenPath, fit: fit.text };
    }

    // The "hide buttons" toggle hides the pad, and the choice survives a
    // reload (localStorage). Checked once, on the widest viewport.
    phase = "landscape hide-toggle";
    console.log(`\n# landscape hide-toggle`);
    await openGame(844, 390, 3);
    await evaluate(`localStorage.removeItem("pocket-rpgkit:web:pad-hidden")`);
    const enterImmersive = async (): Promise<void> => {
      const toggle = await centerOf("#fullscreen-toggle");
      await touchAt([{ ...toggle, id: 1 }], "touchStart");
      await touchAt([{ ...toggle, id: 1 }], "touchEnd");
      await waitFor("immersive", `document.body.classList.contains("immersive") && __pocketPlayer.state === "running"`);
      await sleep(200);
    };
    await enterImmersive();
    const padToggle = await centerOf("#pad-toggle");
    await touchAt([{ ...padToggle, id: 1 }], "touchStart");
    await touchAt([{ ...padToggle, id: 1 }], "touchEnd");
    await sleep(100);
    const hidden = await evaluate<boolean>(`getComputedStyle(document.querySelector(".pad")).display === "none"`);
    const showLabel = await evaluate<string>(`document.getElementById("pad-toggle").textContent.trim()`);
    expect("hide-toggle: the pad hides", hidden, "pad display is none");
    expect("hide-toggle: the toggle offers to show the buttons", /show/i.test(showLabel), `label "${showLabel}"`);
    // Reload: the persisted choice keeps the pad hidden in immersive.
    await navigate(`${base}${GAME}/`);
    await waitFor(`${GAME} running`, `globalThis.__pocketPlayer?.state === "running" && __pocketPlayer.frames > 30`);
    await enterImmersive();
    const hiddenAfterReload = await evaluate<boolean>(`getComputedStyle(document.querySelector(".pad")).display === "none"`);
    expect("hide-toggle: the choice survives a reload", hiddenAfterReload, "pad still hidden after reload");
    const showToggle = await centerOf("#pad-toggle");
    await touchAt([{ ...showToggle, id: 1 }], "touchStart");
    await touchAt([{ ...showToggle, id: 1 }], "touchEnd");
    await sleep(100);
    const shown = await evaluate<boolean>(`getComputedStyle(document.querySelector(".pad")).display !== "none"`);
    expect("hide-toggle: showing the buttons again", shown, "pad visible after toggling back");
    await evaluate(`localStorage.removeItem("pocket-rpgkit:web:pad-hidden")`);

    expect("console: no errors", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join("\n") : "clean");
  } catch (error) {
    failures.push({ check: phase, message: error instanceof Error ? error.message : String(error) });
    console.log(`  FAIL ${phase}: ${error instanceof Error ? error.message : error}`);
    await screenshot(`error-${phase.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
  } finally {
    await Bun.write(join(OUT, "report.json"), JSON.stringify({ failures, results, consoleErrors }, null, 2) + "\n");
    cdp.close();
    chrome.proc.kill();
    await chrome.proc.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`\nweb-mobile-verify: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}; screenshots and report.json in ${OUT}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
