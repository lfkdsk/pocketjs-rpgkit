// tests/web-site.test.ts — the web site builder (tools/web.ts) without a
// browser and without building bundles: game discovery, the metadata
// table's fallbacks, viewport policy, the key table, screen sizing, and
// the pages' URLs. tools/web-verify.ts plays the built site in Chrome.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APPS, EXAMPLES } from "../tools/build-example.ts";
import {
  cardOrder,
  copyChapterPreviews,
  DEFAULT_WEB_RASTER_DENSITY,
  defaultGameIds,
  KIT_ROOT,
  loadSiteConfig,
  parseSiteConfig,
  PREVIEW_APP_ID,
  renderLanding,
  renderPlayer,
  resolveGame,
  shortTitle,
  viewportFor,
  type PlayerConfig,
  type WebChapter,
  type WebGame,
} from "../tools/web.ts";
import { fitViewport, type ViewportConfig } from "../tools/web/fit.ts";
import { rpgkitBootFromSearch } from "../tools/web/boot.ts";
import { verifyPlanHash } from "../vendor/pocketjs/framework/src/manifest/plan.ts";
import { BTN, KEYMAP, keyMasks, keysFor, withKeys } from "../tools/web/keys.ts";
import { loadProject } from "../editor/engine/document.ts";
import { createMasterAudioHost } from "../tools/web/audio-control.ts";

const config = loadSiteConfig(KIT_ROOT);
const site = { title: config.title!, intro: config.intro!, source: config.source! };
const CHAPTER_PREVIEW = "tests/goldens/showcase-lobby.png";

function chapterFixtures(count = 13): WebChapter[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `room-${index + 1}`,
    title: index === 0 ? 'Room <1> & "friends"' : `Room ${index + 1}`,
    description: index === 0 ? 'Try <everything> & say "hello".' : `Description ${index + 1}`,
    preview: CHAPTER_PREVIEW,
  }));
}

function playerConfig(game: WebGame): PlayerConfig {
  return {
    id: game.id,
    app: game.plan.app.output,
    bundle: `${game.plan.app.output}.js`,
    pak: `${game.plan.app.output}.pak`,
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
            storageKey: "test:editor",
            examples: game.documents.map((document) => ({ id: document.id, title: document.title, url: `documents/${document.id}.json` })),
          },
        }
      : {}),
  };
}

/** Every src/href in a page, minus data: URIs. */
function urls(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!).filter((u) => !u.startsWith("data:"));
}

describe("games", () => {
  test("with no names, this repository builds every example, the editor and the preview host", () => {
    expect(defaultGameIds(KIT_ROOT)).toEqual([...APPS, PREVIEW_APP_ID]);
  });

  test("cards follow the metadata table, then the rest in build order", () => {
    // "later" stands for an example with no web.json entry yet.
    expect(cardOrder(["meadow", "sunstone", "later", "grow", "wander"], config)).toEqual(["wander", "sunstone", "grow", "meadow", "later"]);
    expect(cardOrder(["later", "meadow"], config)).toEqual(["meadow", "later"]);
  });

  test("every app resolves against web-app", () => {
    for (const id of APPS) {
      const game = resolveGame(KIT_ROOT, config, id);
      expect(game.plan.target.id).toBe("web-app");
      expect(game.plan.viewport.rasterDensity).toBe(DEFAULT_WEB_RASTER_DENSITY);
      expect(game.title.length).toBeGreaterThan(0);
      expect(game.controls.length).toBeGreaterThan(0);
    }
    const showcase = resolveGame(KIT_ROOT, config, "showcase");
    expect(showcase.featured).toBe(true);
    expect(showcase.features).toHaveLength(14);
    expect(showcase.chapters).toHaveLength(14);
    expect(showcase.chapters.at(-1)).toMatchObject({
      id: "hall-registration",
      title: "14. Registration Desk",
      preview: "docs/screenshots/showcase-14-registration.png",
    });
  });

  test("the browser editor companion cannot be configured without its file host", () => {
    const games = { ...config.games, editor: { ...config.games!.editor } };
    delete games.editor!.documents;
    expect(() => resolveGame(KIT_ROOT, { ...config, games }, "editor")).toThrow(/requires browser documents/);
  });

  test("the browser editor companion cannot be configured without its file host", () => {
    const games = { ...config.games, editor: { ...config.games!.editor } };
    delete games.editor!.documents;
    expect(() => resolveGame(KIT_ROOT, { ...config, games }, "editor")).toThrow(/requires browser documents/);
  });

  test("viewports: sunstone pinned fixed, grow dynamic from its plan, meadow fixed", () => {
    expect(resolveGame(KIT_ROOT, config, "sunstone").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
    expect(resolveGame(KIT_ROOT, config, "grow").viewport).toEqual({
      policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096],
    });
    expect(resolveGame(KIT_ROOT, config, "meadow").viewport).toEqual({ policy: "fixed", logical: [480, 272] });
  });

  test("a game without a table entry gets a plain card", () => {
    const game = resolveGame(KIT_ROOT, {}, "meadow");
    expect(game.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(resolveGame(KIT_ROOT, { title: "Pocket RPG Kit" }, "meadow").title).toBe("Mini Meadow");
    expect(game.description).toBe("");
    expect(game.preview).toBeUndefined();
    expect(game.chapters).toEqual([]);
    expect(game.controls.map((c) => c.button)).toEqual(["DPAD", "CIRCLE", "CROSS"]);
  });

  test("an unknown game names the examples it looked for", () => {
    expect(() => resolveGame(KIT_ROOT, config, "nope")).toThrow(/no pocket\.json for "nope".*sunstone/);
  });

  test("the table is validated", () => {
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    expect(parse({ games: [{ id: "meadow" }] })).toThrow(/table keyed by game id/);
    expect(parse({ games: { "../x": {} } })).toThrow(/not a usable game id/);
    expect(parse({ games: { meadow: { controls: [{ button: "TURBO", action: "x" }] } } })).toThrow(/known button/);
    expect(parse({ games: { meadow: { keys: { KeyA: "TURBO" } } } })).toThrow(/not a button/);
    expect(parse({ games: { meadow: { viewport: "stretch" } } })).toThrow(/"fixed" or "dynamic"/);
    expect(parse({ games: { meadow: { controls: [{ keys: ["Mouse"], action: "Paint" }] } } })).not.toThrow();
    expect(parse({ games: { meadow: { controls: [{ button: "CIRCLE", keys: ["Enter"], action: "x" }] } } })).toThrow(/either literal keys/);
    expect(parse({ games: { meadow: { documents: [] } } })).toThrow(/non-empty list/);
    expect(parse({ games: { meadow: { documents: [{ id: "../bad", title: "Bad", document: "bad.json" }] } } })).toThrow(/usable id/);
    expect(parse({ games: { meadow: { chapters: {} } } })).toThrow(/chapters is a list/);
    expect(parse({ games: { meadow: { chapters: [null] } } })).toThrow(/chapters\[0\] is an object/);
    expect(parse({ games: { meadow: { chapters: [{ id: "bad/id", title: "Bad" }] } } })).toThrow(/usable chapter id/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "  " }] } } })).toThrow(/non-empty text/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "One" }, { id: "intro", title: "Again" }] } } })).toThrow(/duplicate id/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", autoplay: "yes" }] } } })).toThrow(/autoplay is a boolean/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", description: 1 }] } } })).toThrow(/description is text/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", preview: 1 }] } } })).toThrow(/relative PNG path/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", preview: "/preview.png" }] } } })).toThrow(/relative PNG path/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", preview: "../preview.png" }] } } })).toThrow(/relative PNG path/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", preview: "https://example.com/preview.png" }] } } })).toThrow(/relative PNG path/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", preview: "preview.jpg" }] } } })).toThrow(/relative PNG path/);
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction" }] } } })).not.toThrow();
    expect(parse({ games: { meadow: { chapters: [{ id: "intro", title: "Introduction", description: "Start here", preview: "art/intro.png", autoplay: true }] } } })()).toEqual({
      games: { meadow: { chapters: [{ id: "intro", title: "Introduction", description: "Start here", preview: "art/intro.png", autoplay: true }] } },
    });
    expect(parse({ games: { meadow: { features: "one room" } } })).toThrow(/features is a list of text/);
    expect(parse({ games: { meadow: { features: ["one room", 2] } } })).toThrow(/features is a list of text/);
    expect(parse({ games: { meadow: { featured: "yes" } } })).toThrow(/featured is a boolean/);
    expect(parse({ games: { meadow: { features: ["one room"], featured: true } } })()).toEqual({
      games: { meadow: { features: ["one room"], featured: true } },
    });
    expect(parse({ games: { meadow: { rasterDensity: 0 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: 1.5 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: 5 } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: "2" } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: Number.NaN } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { rasterDensity: Number.POSITIVE_INFINITY } } })).toThrow(/integer from 1 through 4/);
    expect(parse({ games: { meadow: { controls: [{ keys: ["Mouse"], action: "Paint" }] } } })).not.toThrow();
    expect(parse({ games: { meadow: { controls: [{ button: "CIRCLE", keys: ["Enter"], action: "x" }] } } })).toThrow(/either literal keys/);
    expect(parse({ games: { meadow: { documents: [] } } })).toThrow(/non-empty list/);
    expect(parse({ games: { meadow: { documents: [{ id: "../bad", title: "Bad", document: "bad.json" }] } } })).toThrow(/usable id/);
    expect(parse({ games: { meadow: {} } })()).toEqual({ games: { meadow: {} } });
  });

  test("chapter preview files are resolved before a game is built", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: { chapters: chapterFixtures(1) } } }, "meadow");
    expect(game.chapters[0]).toMatchObject({
      id: "room-1",
      preview: CHAPTER_PREVIEW,
      description: 'Try <everything> & say "hello".',
    });
    expect(() => resolveGame(KIT_ROOT, {
      games: { meadow: { chapters: [{ id: "missing", title: "Missing", preview: "art/not-there.png" }] } },
    }, "meadow")).toThrow(/chapter preview.*not found/);
  });

  test("a web.json game can override the default raster density", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: { rasterDensity: 3 } } }, "meadow");
    expect(game.plan.viewport.rasterDensity).toBe(3);
    expect(game.plan.viewport.physical).toEqual([1440, 816]);
    expect(verifyPlanHash(game.plan)).toBe(true);
  });

  test("viewportFor: dynamic-only manifests, and pins the manifest cannot honor", () => {
    const grow = resolveGame(KIT_ROOT, config, "grow");
    const dynamicOnly = { app: { viewport: { dynamic: { default: [960, 544], min: [480, 272], max: [2048, 2048] } } } };
    expect(viewportFor(dynamicOnly, grow.plan)).toEqual({ policy: "dynamic", default: [960, 544], min: [480, 272], max: [2048, 2048] });
    expect(() => viewportFor(dynamicOnly, grow.plan, "fixed")).toThrow(/pins a fixed viewport/);
    expect(shortTitle("Pocket RPG Kit — Wander", "Pocket RPG Kit")).toBe("Wander");
    expect(shortTitle("Alpine Post", "Pocket RPG Kit")).toBe("Alpine Post");
  });
});

describe("pages", () => {
  const games = cardOrder([...APPS], config).map((id) => resolveGame(KIT_ROOT, config, id));

  test("the landing page links every game with relative URLs", () => {
    const html = renderLanding(site, games.map((game) => ({ game, preview: [480, 272] as [number, number] })));
    for (const game of games) {
      expect(html).toContain(`href="${game.id}/"`);
      expect(html).toContain(`src="${game.id}/preview.png"`);
    }
    for (const url of urls(html)) expect(url.startsWith("/") || url.startsWith("./..")).toBe(false);
    expect(urls(html)).toContain("site.css");
  });

  test("chapter links stay under their game and escape their labels", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    expect(sunstone.chapters.map(({ id }) => id)).toEqual(["village", "forest", "cave"]);
    expect(sunstone.controls.find(({ button }) => button === "SELECT")?.action).toBe("Demo menu");
    const escaped = {
      ...sunstone,
      chapters: [{ id: "village", title: "Village & <home>" }],
    };
    const html = renderLanding(site, [{ game: escaped }, { game: games.find((game) => game.id === "meadow")! }]);
    expect(html).toContain('href="sunstone/?chapter=village">Village &amp; &lt;home&gt;</a>');
    expect(html).not.toContain('href="?chapter=');
    expect(html.match(/class="chapters"/g)).toHaveLength(1);
  });

  test("showcase entries are cards linked to their own site, after featured local games", () => {
    const entry = {
      title: "Pocket Tuxemon",
      url: "https://example.org/tuxemon/",
      description: "A & B",
      preview: "https://example.org/tuxemon/preview.png",
      controls: [{ button: "CIRCLE" as const, action: "Talk" }],
    };
    const html = renderLanding({ ...site, showcase: [entry] }, games.map((game) => ({ game })));
    expect(html).toContain('<article class="game-card showcase-card">');
    expect(html).toContain('<a href="https://example.org/tuxemon/">Pocket Tuxemon</a>');
    expect(html).toContain('<a class="play" href="https://example.org/tuxemon/">Play in the browser</a>');
    expect(html).toContain('src="https://example.org/tuxemon/preview.png"');
    expect(html).toContain("A &amp; B");
    const featured = games.find((game) => game.featured)!;
    const regular = games.find((game) => !game.featured)!;
    expect(html.indexOf(`id="${featured.id}"`)).toBeLessThan(html.indexOf("showcase-card"));
    expect(html.indexOf("showcase-card")).toBeLessThan(html.indexOf(`id="${regular.id}"`));
    expect(renderLanding(site, [{ game: games[0]! }])).not.toContain("showcase-card");
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    expect(parse({ showcase: [entry] })).not.toThrow();
    expect(parse({ showcase: {} })).toThrow(/"showcase" is a list/);
    expect(parse({ showcase: [{ title: "", url: entry.url }] })).toThrow(/needs a title/);
    expect(parse({ showcase: [{ title: "x", url: "/relative/" }] })).toThrow(/absolute https/);
    expect(parse({ showcase: [{ title: "x", url: "javascript:alert(1)" }] })).toThrow(/absolute https/);
    expect(parse({ showcase: [{ title: "x", url: entry.url, preview: "preview.png" }] })).toThrow(/preview must be/);
    expect(parse({ showcase: [{ title: "x", url: entry.url, controls: [{ button: "NOPE", action: "x" }] }] })).toThrow(/known button/);
  });

  test("the studio entry is validated", () => {
    const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");
    const studio = { title: "Studio", description: "Edit in the browser.", preview: "docs/screenshots/studio/a.png" };
    expect(parse({ studio })()).toEqual({ studio });
    expect(parse({ studio: { title: "Studio", description: "" } })).not.toThrow();
    expect(parse({ studio: [] })).toThrow(/"studio" is an object/);
    expect(parse({ studio: null })).toThrow(/"studio" is an object/);
    expect(parse({ studio: { description: "x" } })).toThrow(/studio\.title must be non-empty text/);
    expect(parse({ studio: { title: " ", description: "x" } })).toThrow(/studio\.title must be non-empty text/);
    expect(parse({ studio: { title: "Studio" } })).toThrow(/studio\.description is text/);
    expect(parse({ studio: { ...studio, preview: "../a.png" } })).toThrow(/studio\.preview must be a relative PNG path/);
    expect(parse({ studio: { ...studio, preview: "https://example.org/a.png" } })).toThrow(/relative PNG path/);
    expect(parse({ studio: { ...studio, preview: "a.jpg" } })).toThrow(/relative PNG path/);
    expect(config.studio?.title).toBe("Pocket RPG Kit Studio");
  });

  test("the landing page has a Studio card and tells the two editors apart", () => {
    const studio = { title: config.studio!.title, description: config.studio!.description };
    const cards = games.map((game) => ({ game }));
    const html = renderLanding({ ...site, studio }, cards);
    expect(html).toContain('<article class="game-card studio-card" id="studio">');
    expect(html).toContain('<h2><a href="studio/">Pocket RPG Kit Studio</a></h2>');
    expect(html).toContain('<a class="play" href="studio/">Open Studio</a>');
    expect(html).toContain('<span class="no-preview">Pocket RPG Kit Studio</span>');
    expect(html).not.toContain("studio/preview.png");
    // One sentence on each card says what sets it apart.
    expect(html).toContain("Runs on PocketJS, so the same editor also runs on the desktop and on devices.");
    expect(html).toContain("A full map and event editor for the browser:");
    expect(html.indexOf('id="editor"')).toBeLessThan(html.indexOf('id="studio"'));
    for (const url of urls(html)) expect(url.startsWith("/")).toBe(false);

    const pictured = renderLanding({ ...site, studio: { ...studio, preview: [960, 600] } }, cards);
    expect(pictured).toContain('<img src="studio/preview.png" width="960" height="600" alt="" loading="lazy">');
    expect(renderLanding(site, cards)).not.toContain("studio-card");
  });

  test("the site lists the featured game first, then the external showcase, regular games, and editor", () => {
    const html = renderLanding(
      { ...site, showcase: config.showcase },
      cardOrder([...APPS], config).map((id) => ({ game: resolveGame(KIT_ROOT, config, id) })),
    );
    const order = [...html.matchAll(/<h2><a href="[^"]*">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
    expect(order[0]).toBe(games.find((game) => game.featured)!.title);
    expect(order[1]).toBe("Pocket Tuxemon");
    expect(order[2]).toBe("Wander: an Endless Grown World");
    expect(order.at(-1)).toBe("Pocket RPG Kit Editor");
    expect(order.length).toBe(1 + APPS.length);
  });

  test("a card without a preview gets a placeholder, not a broken image", () => {
    const html = renderLanding(site, [{ game: games[0]! }]);
    expect(html).not.toContain("preview.png");
    expect(html).toContain('class="no-preview"');
  });

  test("player pages load everything relative to the page", () => {
    for (const game of games) {
      const html = renderPlayer(site, game, playerConfig(game), true);
      const links = urls(html);
      expect(links).toContain("../site.css");
      expect(links).toContain("../player.js");
      expect(links).toContain("../");
      expect(links).toContain("ATTRIBUTION.txt");
      for (const url of links) {
        if (/^https:\/\//.test(url)) continue;
        expect(url.startsWith("/")).toBe(false);
      }
      const json = /<script type="application\/json" id="pocket-game">(.*?)<\/script>/s.exec(html)![1]!;
      const parsed = JSON.parse(json) as PlayerConfig;
      expect(parsed.wasm).toBe("../pocketjs.wasm");
      expect(parsed.bundle).toBe(`${game.plan.app.output}.js`);
      expect(parsed.viewport).toEqual(game.viewport);
      expect(parsed.rasterDensity).toBe(DEFAULT_WEB_RASTER_DENSITY);
      expect(parsed.autosaveStorageKey).toBe(`pocket-rpgkit:${game.plan.app.id}:autosave:v1`);
      expect(parsed.autosaveStorageKey).not.toBe(parsed.editor?.storageKey);
      expect(parsed.keys.KeyA).toBe(BTN.CIRCLE);
      expect(html).toContain(`data-viewport="${game.viewport.policy}"`);
      expect(html).toContain('<button type="button" id="audio-mute" aria-label="Mute audio" aria-pressed="false">Mute</button>');
      expect(html).toContain('<label for="audio-volume">Volume</label>');
      expect(html).toContain('<input type="range" id="audio-volume" min="0" max="100" step="5" value="100">');
    }
  });

  test("the editor page exposes local files, built-in projects and browser-only privacy copy", () => {
    const editor = games.find((game) => game.id === "editor")!;
    const html = renderPlayer(site, editor, playerConfig(editor), false);
    expect(editor.documents?.map((document) => document.id)).toEqual(["sunstone", "meadow"]);
    expect(html).toContain('id="editor-open"');
    expect(html).toContain('id="editor-download"');
    expect(html).toContain('data-editor-example="sunstone"');
    expect(html).toContain('data-editor-example="meadow"');
    expect(html).toContain('id="editor-open" disabled');
    expect(html).toContain('id="editor-download" disabled');
    expect(html).toContain('data-editor-example="sunstone" disabled');
    expect(html).toContain("Your project data stays in this browser; nothing is uploaded.");
    expect(html).toContain('"storageKey":"test:editor"');
  });

  test("player pages expose progressive chapter and autoplay controls", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    expect(sunstone.chapters).toEqual([
      { id: "village", title: "Village", autoplay: true },
      { id: "forest", title: "Forest", autoplay: true },
      { id: "cave", title: "Cave", autoplay: true },
    ]);
    const html = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    expect(html.match(/data-demo-chapter=/g)).toHaveLength(3);
    expect(html.match(/data-demo-speed=/g)).toHaveLength(3);
    expect(html).toContain('data-demo-chapter="cave" data-demo-autoplay="true" href="?chapter=cave"');
    expect(html).toContain('data-demo-speed="4" href="?autoplay=village&amp;speed=4"');
    expect(html).toContain('role="button" aria-pressed="false"');

    const meadow = games.find((game) => game.id === "meadow")!;
    expect(renderPlayer(site, meadow, playerConfig(meadow), true)).not.toContain("data-demo-controls");
  });

  test("chapter cards escape text, retain fallbacks, and copy their previews", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: { chapters: chapterFixtures() } } }, "meadow");
    const html = renderPlayer(site, game, playerConfig(game), true);
    expect(html.match(/data-demo-chapter=/g)).toHaveLength(13);
    expect(html.match(/class="demo-chapter-preview"/g)).toHaveLength(13);
    expect(html).toContain('data-demo-chapter="room-1" data-demo-autoplay="false" href="?chapter=room-1"');
    expect(html).toContain('src="chapter-previews/room-1.png" alt="" loading="lazy"');
    expect(html).toContain('Room &lt;1&gt; &amp; &quot;friends&quot;');
    expect(html).toContain('Try &lt;everything&gt; &amp; say &quot;hello&quot;.');
    expect(html).toContain('aria-labelledby="demo-chapter-title-room-1" aria-describedby="demo-chapter-description-room-1"');
    expect(html).not.toContain("data-demo-speed=");

    const output = mkdtempSync(join(KIT_ROOT, ".web-chapter-previews-"));
    try {
      copyChapterPreviews(KIT_ROOT, game, output);
      const copied = readdirSync(join(output, "chapter-previews")).sort();
      expect(copied).toEqual(Array.from({ length: 13 }, (_, index) => `room-${index + 1}.png`).sort());
      expect(readFileSync(join(output, "chapter-previews", "room-1.png")))
        .toEqual(readFileSync(join(KIT_ROOT, CHAPTER_PREVIEW)));
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("the editor page exposes local files, built-in projects and browser-only privacy copy", () => {
    const editor = games.find((game) => game.id === "editor")!;
    const html = renderPlayer(site, editor, playerConfig(editor), false);
    expect(editor.documents?.map((document) => document.id)).toEqual(["sunstone", "meadow"]);
    expect(html).toContain('id="editor-open"');
    expect(html).toContain('id="editor-download"');
    expect(html).toContain('data-editor-example="sunstone"');
    expect(html).toContain('data-editor-example="meadow"');
    expect(html).toContain('id="editor-open" disabled');
    expect(html).toContain('id="editor-download" disabled');
    expect(html).toContain('data-editor-example="sunstone" disabled');
    expect(html).toContain("Your project data stays in this browser; nothing is uploaded.");
    expect(html).toContain('"storageKey":"test:editor"');
  });

  test("text is escaped and the settings cannot close their script tag", () => {
    const game = {
      ...games[0]!,
      title: "<b>A&B</b>",
      description: '"</script>"',
      features: ["One & two", "<script>three</script>"],
      chapters: [{ id: "escaped", title: "Chapter <one>", autoplay: false }],
    };
    const html = renderPlayer(site, game, { ...playerConfig(game), app: "</script><x>" }, false);
    expect(html).toContain("&lt;b&gt;A&amp;B&lt;/b&gt;");
    expect(html).toContain("<h2>Exhibition halls</h2>");
    expect(html).toContain("<ol class=\"features\">");
    expect(html).toContain("<li>One &amp; two</li>");
    expect(html).toContain("<li>&lt;script&gt;three&lt;/script&gt;</li>");
    expect(html).toContain(">Chapter &lt;one&gt;</span>");
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    expect(html).not.toContain("ATTRIBUTION.txt");
  });

  test("the controls print the keys that press each button", () => {
    const grow = games.find((g) => g.id === "grow")!;
    const html = renderPlayer(site, grow, playerConfig(grow), true);
    expect(html).toContain("<kbd>←</kbd> <kbd>→</kbd></th><td>Step the timeline");
    expect(html).toContain("<kbd>A</kbd> <kbd>Enter</kbd> <kbd>Z</kbd></th><td>Walk into the finished village");
    expect(html).toContain('data-button="TRIANGLE">X</button>');
  });
});

describe("preview host", () => {
  const preview = resolveGame(KIT_ROOT, config, PREVIEW_APP_ID);

  test("resolves against web-app from tools/preview/pocket.json", () => {
    expect(preview.plan.target.id).toBe("web-app");
    expect(preview.plan.app.output).toBe(PREVIEW_APP_ID);
    expect(preview.title).toBe("Project Preview");
    expect(preview.controls.length).toBeGreaterThan(0);
  });

  test("renders an ordinary player page for the preview bundle", () => {
    const html = renderPlayer(site, preview, playerConfig(preview), false);
    const json = /<script type="application\/json" id="pocket-game">(.*?)<\/script>/s.exec(html)![1]!;
    const parsed = JSON.parse(json) as PlayerConfig;
    expect(parsed.bundle).toBe("preview.js");
    expect(parsed.wasm).toBe("../pocketjs.wasm");
    expect(html).not.toContain("data-demo-controls");
  });

  test("games that do not opt into preview carry no preview markup", () => {
    // The preview protocol lives entirely in the preview app's own bundle;
    // every other player page must stay byte-for-byte free of it.
    for (const id of EXAMPLES) {
      const game = resolveGame(KIT_ROOT, config, id);
      const html = renderPlayer(site, game, playerConfig(game), true);
      expect(html).not.toContain("rpgkit-preview");
      expect(html).not.toContain("preview-demo");
      expect(html).not.toContain("__rpgkitPreview");
    }
  });

  test("the landing page links the preview demo only when the preview app is built", () => {
    const meadow = resolveGame(KIT_ROOT, config, "meadow");
    const withPreview = renderLanding(site, [{ game: preview }, { game: meadow }]);
    expect(withPreview).toContain('href="preview-demo.html"');
    const withoutPreview = renderLanding(site, [{ game: meadow }]);
    expect(withoutPreview).not.toContain("preview-demo.html");
  });
});

describe("preview demo page", () => {
  const path = join(KIT_ROOT, "tools", "web", "preview-demo.html");
  const html = existsSync(path) ? readFileSync(path, "utf8") : "";

  test("is a self-contained page with the protocol, host iframe and driver hooks", () => {
    expect(html).toContain('id="host"');
    expect(html).toContain('"rpgkit-preview/v1"');
    expect(html).toContain("__previewDemo");
    expect(html).toContain("preview-origin");
    // Pure HTML/JS: no build step and no external resources.
    expect(html).not.toContain("<script type=\"module\"");
    expect(html).toContain('id="sample-project"');
  });

  test("its embedded sample project is a valid rpgkit-project/v1 document", () => {
    const match = /<script type="application\/json" id="sample-project">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const loaded = loadProject(match![1]!.trim());
    expect(loaded.errors).toEqual([]);
    expect(loaded.project.format).toBe("rpgkit-project/v1");
    expect(loaded.project.maps).toHaveLength(1);
    const map = loaded.project.maps[0]!;
    expect(map.ground).toHaveLength(map.width * map.height);
  });
});

describe("boot query", () => {
  test("keeps the supported deep-link values as strings", () => {
    expect(rpgkitBootFromSearch("?chapter=forest")).toEqual({ chapter: "forest" });
    expect(rpgkitBootFromSearch("?map=village&x=&y=12")).toEqual({ map: "village", x: "", y: "12" });
    expect(rpgkitBootFromSearch("?autoplay=intro&speed=2")).toEqual({ autoplay: "intro", speed: "2" });
  });

  test("ignores unknown keys and treats decoded text only as data", () => {
    expect(rpgkitBootFromSearch("?unknown=x&__proto__=bad")).toEqual({});
    expect(rpgkitBootFromSearch("?chapter=%3C%2Fscript%3E&chapter=second")).toEqual({ chapter: "</script>" });
  });
});

describe("player master audio", () => {
  test("primes and resumes the lazy browser host inside a user gesture", () => {
    const calls: string[] = [];
    const raw = {
      ns: {
        createStream: (rate: number, channels: number) => {
          calls.push(`create ${rate} ${channels}`);
          return 7;
        },
        destroyStream: (handle: number) => calls.push(`destroy ${handle}`),
        writePcm: () => 0,
        play: (handle: number) => calls.push(`play ${handle}`),
        pause: () => {},
        stop: () => {},
        setVolume: () => {},
        endStream: () => {},
        poll: () => undefined,
      },
      beginFrame: () => {},
      reset: () => {},
    };

    createMasterAudioHost(raw).activate();
    expect(calls).toEqual(["create 11025 1", "play 7", "destroy 7"]);
  });

  test("mutes without pausing and restores each stream's latest guest volume", () => {
    let nextHandle = 1;
    let begins = 0;
    let resets = 0;
    const volumes: Array<[number, number]> = [];
    const destroyed: number[] = [];
    const raw = {
      ns: {
        createStream: () => nextHandle++,
        destroyStream: (handle: number) => destroyed.push(handle),
        writePcm: () => 0,
        play: () => {},
        pause: () => { throw new Error("master mute must not pause streams"); },
        stop: () => {},
        setVolume: (handle: number, volume: number) => volumes.push([handle, volume]),
        endStream: () => {},
        poll: () => undefined,
      },
      beginFrame: () => { begins++; },
      reset: () => { resets++; },
    };
    const host = createMasterAudioHost(raw);
    const bgm = host.ns.createStream(11_025, 1);
    const effect = host.ns.createStream(22_050, 2);
    host.ns.setVolume(bgm, 0.35);
    host.ns.setVolume(effect, 0.8);
    expect(volumes.splice(0)).toEqual([[bgm, 0.35], [effect, 0.8]]);

    host.setMasterVolume(0.5);
    expect(volumes.splice(0)).toEqual([[bgm, 0.175], [effect, 0.4]]);
    host.setMuted(true);
    expect(host.muted).toBe(true);
    expect(volumes.splice(0)).toEqual([[bgm, 0], [effect, 0]]);

    // A guest fade while muted stays silent, but becomes the restored volume.
    host.ns.setVolume(bgm, 0.2);
    host.setMasterVolume(0.25);
    expect(volumes.splice(0)).toEqual([[bgm, 0], [bgm, 0], [effect, 0]]);
    host.setMuted(false);
    expect(volumes.splice(0)).toEqual([[bgm, 0.05], [effect, 0.2]]);

    host.ns.destroyStream(effect);
    host.setMasterVolume(1);
    expect(destroyed).toEqual([effect]);
    expect(volumes.splice(0)).toEqual([[bgm, 0.2]]);
    host.beginFrame();
    host.reset();
    expect({ begins, resets }).toEqual({ begins: 1, resets: 1 });
    host.setMuted(true);
    expect(volumes).toEqual([]);
  });
});

describe("keys", () => {
  test("letter keys match the web-app glyphs; Enter and Z also confirm", () => {
    expect(keysFor("CIRCLE")).toEqual(["A", "Enter", "Z"]);
    expect(keysFor("CROSS")).toEqual(["B", "Esc", "Backspace"]);
    expect(keysFor("TRIANGLE")).toEqual(["X"]);
    expect(keysFor("SQUARE")).toEqual(["Y"]);
    expect(keysFor("DPAD")).toEqual(["Arrow keys"]);
    expect(keyMasks().Space).toBe(BTN.START);
    expect(Object.keys(KEYMAP)).not.toContain("Tab");
  });

  test("a game can rebind and unbind keys", () => {
    const keymap = withKeys({ KeyA: "SQUARE", KeyY: null, Tab: "SELECT" });
    expect(keysFor("SQUARE", keymap)).toEqual(["A"]);
    expect(keysFor("CIRCLE", keymap)).toEqual(["Enter", "Z"]);
    expect(keysFor("SELECT", keymap)).toEqual(["Shift", "Tab"]);
    expect(keyMasks(keymap).KeyY).toBeUndefined();
    expect(() => withKeys({ "Key A": "CIRCLE" })).toThrow(/KeyboardEvent\.code/);
  });
});

describe("screen sizing", () => {
  const fixed: ViewportConfig = { policy: "fixed", logical: [480, 272] };
  const dynamic: ViewportConfig = { policy: "dynamic", default: [960, 544], min: [480, 272], max: [4096, 4096] };

  test("fixed: the largest whole scale that fits, in device pixels", () => {
    expect(fitViewport(fixed, 1408, 894, 1)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 2)).toEqual({ size: [480, 272], k: 5 });
    // 1.25: 3 device pixels per game pixel = 1152 CSS px, not 2.5x smeared.
    expect(fitViewport(fixed, 1408, 894, 1.25)).toEqual({ size: [480, 272], k: 3 });
    expect(fitViewport(fixed, 358, 600, 3)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 300, 600, 1).k).toBe(0);
    expect(fitViewport(fixed, 1408, 894, 1, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 2, 2)).toEqual({ size: [480, 272], k: 4 });
    expect(fitViewport(fixed, 1408, 894, 1.25, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 358, 600, 3, 2)).toEqual({ size: [480, 272], k: 2 });
    expect(fitViewport(fixed, 1408, 894, 1, 3).k).toBe(0);
    expect(() => fitViewport(fixed, 1408, 894, 1, 1.5)).toThrow(/positive integer/);
  });

  test("dynamic: the viewport follows the area at the largest scale above the minimum", () => {
    for (const [w, h, dpr] of [[1408, 894, 1], [1408, 894, 2], [968, 600, 1], [358, 700, 3], [2528, 794, 1], [1000, 700, 1.25]] as const) {
      const { size, k } = fitViewport(dynamic, w, h, dpr);
      const deviceW = Math.floor(w * dpr);
      const deviceH = Math.floor(Math.min(h, (w * 544) / 960) * dpr);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(size[0]).toBeGreaterThanOrEqual(480);
      expect(size[1]).toBeGreaterThanOrEqual(272);
      expect(size[0] * k).toBeLessThanOrEqual(deviceW);
      expect(size[1] * k).toBeLessThanOrEqual(deviceH);
      // One step larger would drop below the minimum.
      expect(Math.floor(deviceW / (k + 1)) < 480 || Math.floor(deviceH / (k + 1)) < 272).toBe(true);
      // Never taller than the default shape.
      expect(size[1] / size[0]).toBeLessThanOrEqual(544 / 960 + 0.01);
    }
    expect(fitViewport(dynamic, 1408, 894, 1)).toEqual({ size: [704, 398], k: 2 });
    expect(fitViewport(dynamic, 300, 200, 1)).toEqual({ size: [480, 272], k: 0 });
    expect(fitViewport({ ...dynamic, max: [600, 300] }, 1408, 894, 1)).toEqual({ size: [600, 300], k: 2 });
  });

  test("dynamic: every raster sample covers a whole number of device pixels", () => {
    for (const density of [2, 3]) {
      for (const [w, h, dpr] of [[1408, 894, 2], [968, 600, 2], [358, 700, 3], [2528, 794, 2]] as const) {
        const { size, k } = fitViewport(dynamic, w, h, dpr, density);
        expect(k === 0 || k % density === 0).toBe(true);
        if (k > 0) {
          const deviceW = Math.floor(w * dpr);
          const deviceH = Math.floor(Math.min(h, (w * 544) / 960) * dpr);
          expect(size[0] * k).toBeLessThanOrEqual(deviceW);
          expect(size[1] * k).toBeLessThanOrEqual(deviceH);
          expect(
            Math.floor(deviceW / (k + density)) < 480 || Math.floor(deviceH / (k + density)) < 272,
          ).toBe(true);
        }
      }
    }
  });
});
