// tests/web-site.test.ts — the web site builder (tools/web.ts) without a
// browser and without building bundles: game discovery, the metadata
// table's fallbacks, viewport policy, the key table, screen sizing, and
// the pages' URLs. tools/web-verify.ts plays the built site in Chrome.

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APPS, EXAMPLES, LOCAL_ONLY_APPS } from "../tools/build-example.ts";
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
  renderManifest,
  renderPlayer,
  resolveGame,
  shortTitle,
  viewportFor,
  type PlayerConfig,
  type WebChapter,
  type WebGame,
} from "../tools/web.ts";
import { fitViewport, type ViewportConfig } from "../tools/web/fit.ts";
import { rpgkitBootFromSearch, withDemoQuery } from "../tools/web/boot.ts";
import { verifyPlanHash } from "../vendor/pocketjs/framework/src/manifest/plan.ts";
import { BTN, KEYMAP, keyMasks, keysFor, withKeys } from "../tools/web/keys.ts";
import { loadProject } from "../editor/engine/document.ts";
import { createMasterAudioHost } from "../tools/web/audio-control.ts";
import { decodePngRgba, drawIcon, drawIconFromPreview, encodePngRgba, SITE_ICONS, writeSiteIcons } from "../tools/web/icon.ts";

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
    expect(defaultGameIds(KIT_ROOT)).toEqual([...APPS.filter((id) => !LOCAL_ONLY_APPS.includes(id)), PREVIEW_APP_ID]);
    expect(defaultGameIds(KIT_ROOT)).not.toContain("wander");
    expect(defaultGameIds(KIT_ROOT)).not.toContain("wander-online");
  });

  test("cards follow the metadata table, then the rest in build order", () => {
    // "later" stands for an example with no web.json entry yet.
    expect(cardOrder(["meadow", "sunstone", "later", "grow"], config)).toEqual(["sunstone", "grow", "meadow", "later"]);
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

  test("wander-online publishes a stable English/Chinese page language channel", () => {
    const online = resolveGame(KIT_ROOT, config, "wander-online");
    expect(online.languages).toEqual({
      options: [
        { code: "en", label: "English" },
        { code: "zh", label: "中文" },
      ],
      param: "lang",
      storage: "pocket-rpgkit:wander-online:lang:v1",
    });
    expect(online.i18n?.zh?.description).toContain("GitHub");
    expect(online.i18n?.zh?.controls).toEqual({
      "Walk": "行走",
      "Confirm": "确认",
      "Cancel / back": "取消 / 返回",
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

  test("the landing chapter list is a collapsed disclosure with wrapping chips", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    const html = renderLanding(site, [{ game: sunstone }]);
    // Collapsed by default: a <details> without the open attribute.
    expect(html).toContain("<details");
    expect(html).toContain('<details class="chapters">');
    expect(html).not.toContain("<details open");
    // The summary names the chapter count, and the links are chips.
    expect(html).toContain("<summary><span>Chapters</span> (3)</summary>");
    expect(html).toContain('<ul class="chapter-chips">');
    expect(html).toContain('href="sunstone/?chapter=village">Village</a>');
    expect(html).toContain('href="sunstone/?chapter=cave">Cave</a>');
    // A game without chapters renders no disclosure.
    const meadow = games.find((game) => game.id === "meadow")!;
    expect(renderLanding(site, [{ game: meadow }])).not.toContain('class="chapters"');
  });

  test("the landing page follows the first game's language when one declares languages", () => {
    const sunstone = games.find((game) => game.id === "sunstone")!;
    const localized: WebGame = {
      ...sunstone,
      languages: {
        options: [
          { code: "en", label: "English" },
          { code: "zh", label: "中文" },
        ],
        param: "lang",
        storage: "pocket-tuxemon/lang",
      },
      i18n: { zh: { chapters: { village: { title: "村庄" }, cave: { title: "山洞" } } } },
    };
    const html = renderLanding(site, [{ game: localized }]);
    expect(html).toContain('<html lang="en" data-page-lang="pending">');
    expect(html).toContain('<details class="chapters" data-landing-game="sunstone">');
    expect(html).toContain('<summary><span data-i18n="chapters">Chapters</span> (3)</summary>');
    expect(html).toContain('data-landing-chapter="sunstone/village" href="sunstone/?chapter=village"');
    const json = /<script type="application\/json" id="pocket-i18n">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const parsed = JSON.parse(json) as {
      options: { code: string }[];
      param: string;
      storage: string;
      default: string;
      landing: Record<string, unknown>;
    };
    expect(parsed.options.map((o) => o.code)).toEqual(["en", "zh"]);
    expect(parsed.param).toBe("lang");
    expect(parsed.storage).toBe("pocket-tuxemon/lang");
    expect(parsed.default).toBe("en");
    expect(parsed.landing.sunstone).toMatchObject({ zh: { chapters: { village: { title: "村庄" } } } });
    // The game description follows the page language on the landing too.
    expect(html).toContain('data-landing-description="sunstone"');
  });

  test("the landing page has no i18n trace when no game declares languages", () => {
    const plainGames = games.filter((game) => game.languages === undefined);
    const html = renderLanding(site, plainGames.map((game) => ({ game })));
    expect(html).not.toContain("pocket-i18n");
    expect(html).not.toContain("data-page-lang");
    expect(html).not.toContain("data-landing-chapter");
    expect(html).not.toContain("data-i18n");
    expect(html).toContain('<html lang="en">');
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
    const published = APPS.filter((id) => !LOCAL_ONLY_APPS.includes(id));
    const html = renderLanding(
      { ...site, showcase: config.showcase },
      cardOrder(published, config).map((id) => ({ game: resolveGame(KIT_ROOT, config, id) })),
    );
    const order = [...html.matchAll(/<h2><a href="[^"]*">([^<]+)<\/a><\/h2>/g)].map((m) => m[1]);
    expect(order[0]).toBe(games.find((game) => game.featured)!.title);
    expect(order.slice(1, 4)).toEqual([
      "Pocket Tuxemon",
      "Wander: an Endless Grown World",
      "Wander Online",
    ]);
    expect(order.at(-1)).toBe("Pocket RPG Kit Editor");
    expect(order.length).toBe(config.showcase!.length + published.length);
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
      if (game.languages) {
        expect(html).toContain('<button type="button" id="audio-mute" aria-label="Mute audio" aria-pressed="false" data-i18n="mute" data-i18n-aria-label="mute-audio">Mute</button>');
        expect(html).toContain('<label for="audio-volume" data-i18n="volume">Volume</label>');
      } else {
        expect(html).toContain('<button type="button" id="audio-mute" aria-label="Mute audio" aria-pressed="false">Mute</button>');
        expect(html).toContain('<label for="audio-volume">Volume</label>');
      }
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

  test("localized chapter previews cannot read or publish files outside the project root", () => {
    const root = mkdtempSync(join(KIT_ROOT, ".web-preview-root-"));
    const outside = mkdtempSync(join(KIT_ROOT, ".web-preview-out-"));
    const output = mkdtempSync(join(KIT_ROOT, ".web-preview-dst-"));
    try {
      mkdirSync(join(root, "art"), { recursive: true });
      copyFileSync(join(KIT_ROOT, CHAPTER_PREVIEW), join(root, "art", "real.png"));
      writeFileSync(join(outside, "secret.png"), "outside the project");
      symlinkSync(join(outside, "secret.png"), join(root, "art", "escape.png"));
      const game = (preview: string) =>
        ({
          id: "meadow",
          chapters: [{ id: "intro", title: "Intro", preview: "art/real.png" }],
          i18n: { zh: { chapters: { intro: { preview } } } },
        }) as unknown as WebGame;
      // A symlinked preview that resolves outside the root is refused...
      expect(() => copyChapterPreviews(root, game("art/escape.png"), output)).toThrow(/leaves the project root/);
      // ...and so are absolute and parent-relative sources that name outside
      // files directly, even when they bypass the schema check.
      expect(() => copyChapterPreviews(root, game(join(outside, "secret.png")), output)).toThrow(/not found/);
      const parentPreview = join(relative(root, outside), "secret.png");
      expect(() => copyChapterPreviews(root, game(parentPreview), output)).toThrow(/not found/);
      // Nothing was published for the refused previews.
      expect(existsSync(join(output, "chapter-previews", "intro.zh.png"))).toBe(false);
      // A real inside file still copies into both the default and the zh slot.
      copyChapterPreviews(root, game("art/real.png"), output);
      expect(readFileSync(join(output, "chapter-previews", "intro.zh.png"))).toEqual(readFileSync(join(root, "art", "real.png")));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
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

describe("install icons and manifest", () => {
  /** Decode the icon's PNG just far enough to read pixels back. */
  function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
    let offset = 8;
    let width = 0;
    let height = 0;
    const idat: number[] = [];
    while (offset < bytes.length) {
      const len = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      const data = bytes.subarray(offset + 8, offset + 8 + len);
      if (type === "IHDR") {
        width = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
        height = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0);
      } else if (type === "IDAT") {
        idat.push(...data);
      }
      offset += 12 + len;
    }
    // Bun.inflateSync is raw DEFLATE; the IDAT carries the zlib wrapper
    // (2-byte header, 4-byte ADLER32 trailer).
    const raw = Bun.inflateSync(Uint8Array.from(idat).subarray(2, idat.length - 4));
    const stride = width * 4;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
    }
    return { width, height, rgba };
  }

  const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => {
    const i = (y * width + x) * 4;
    return `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  };

  test("icons are deterministic PNGs at the manifest's sizes", () => {
    for (const [name, size] of Object.entries(SITE_ICONS)) {
      const a = drawIcon(size);
      const b = drawIcon(size);
      expect(a).toEqual(b);
      expect(a.subarray(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const decoded = decodePng(a);
      expect(decoded.width).toBe(size);
      expect(decoded.height).toBe(size);
      // The mark: page background in the corner, yellow on a plus arm, the
      // light highlight at the very centre.
      expect(pixel(decoded.rgba, size, 0, 0)).toBe("#0d0f14");
      expect(pixel(decoded.rgba, size, Math.floor(size / 2), Math.floor(size / 8))).toBe("#f4c35a");
      expect(pixel(decoded.rgba, size, Math.floor(size / 2), Math.floor(size / 2))).toBe("#fff3c4");
      // Fully opaque: maskable icons need a full-bleed background.
      expect(decoded.rgba.some((_, i) => i % 4 === 3 && decoded.rgba[i] !== 255)).toBe(false);
    }
  });

  test("decodePngRgba round-trips the encoder and reads RGB PNGs", () => {
    const size = 4;
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = (i * 7) & 0xff;
      pixels[i + 1] = (i * 13) & 0xff;
      pixels[i + 2] = (i * 29) & 0xff;
      pixels[i + 3] = 255;
    }
    const roundTrip = decodePngRgba(encodePngRgba(size, pixels));
    expect(roundTrip.width).toBe(size);
    expect(roundTrip.height).toBe(size);
    expect(roundTrip.pixels).toEqual(pixels);

    // A 1x2 RGB (color type 2) PNG with an Up filter on the second row.
    const rgb = (() => {
      const crcTable = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c >>> 0;
        }
        return table;
      })();
      const chunk = (type: string, data: Uint8Array) => {
        const typeBytes = new TextEncoder().encode(type);
        const body = new Uint8Array(typeBytes.length + data.length);
        body.set(typeBytes, 0);
        body.set(data, typeBytes.length);
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        out.set(body, 4);
        let crc = 0xffffffff;
        for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        view.setUint32(4 + body.length, (crc ^ 0xffffffff) >>> 0);
        return out;
      };
      const ihdr = new Uint8Array(13);
      new DataView(ihdr.buffer).setUint32(0, 1);
      new DataView(ihdr.buffer).setUint32(4, 2);
      ihdr[8] = 8; // 8-bit
      ihdr[9] = 2; // RGB
      // Row 0: filter None, red. Row 1: filter Up, black (reconstructs to red).
      const raw = Uint8Array.from([0, 255, 0, 0, 2, 0, 0, 0]);
      const deflated = Bun.deflateSync(raw);
      const zlib = new Uint8Array(deflated.length + 6);
      zlib[0] = 0x78;
      zlib[1] = 0x9c;
      zlib.set(deflated, 2);
      let a = 1, b = 0;
      for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
      new DataView(zlib.buffer).setUint32(2 + deflated.length, ((b << 16) | a) >>> 0);
      const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib),
        chunk("IEND", new Uint8Array(0)),
      ];
      const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) { png.set(part, offset); offset += part.length; }
      return png;
    })();
    const decoded = decodePngRgba(rgb);
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(2);
    // Both rows reconstruct to red (the second used the Up filter).
    expect([...decoded.pixels]).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
  });

  test("preview icons come from the preview, deterministically and full-bleed", () => {
    // A 4x4 preview: red top-left, green top-right, blue bottom-left, white
    // bottom-right, so a cover-crop and scale can be checked at the corners.
    const width = 4, height = 4;
    const source = new Uint8Array(width * height * 4);
    source.fill(255); // fully opaque
    const set = (x: number, y: number, r: number, g: number, b: number) => {
      const i = (y * width + x) * 4;
      source[i] = r; source[i + 1] = g; source[i + 2] = b; source[i + 3] = 255;
    };
    set(0, 0, 255, 0, 0); set(3, 0, 0, 255, 0);
    set(0, 3, 0, 0, 255); set(3, 3, 255, 255, 255);
    const a = drawIconFromPreview(8, width, height, source);
    const b = drawIconFromPreview(8, width, height, source);
    expect(a).toEqual(b);
    const decoded = decodePngRgba(a);
    expect(decoded.width).toBe(8);
    const corner = (x: number, y: number) => {
      const i = (y * 8 + x) * 4;
      return [decoded.pixels[i], decoded.pixels[i + 1], decoded.pixels[i + 2]];
    };
    expect(corner(0, 0)).toEqual([255, 0, 0]);
    expect(corner(7, 0)).toEqual([0, 255, 0]);
    expect(corner(0, 7)).toEqual([0, 0, 255]);
    expect(corner(7, 7)).toEqual([255, 255, 255]);
    // Full-bleed: every pixel opaque.
    expect(decoded.pixels.some((_, i) => i % 4 === 3 && decoded.pixels[i] !== 255)).toBe(false);
    // A preview icon is not the kit mark.
    expect(drawIconFromPreview(192, width, height, source)).not.toEqual(drawIcon(192));
  });

  test("writeSiteIcons uses the preview when one is given, the mark otherwise", () => {
    const dir = mkdtempSync(join(import.meta.dir, "icon-tmp-"));
    try {
      const previewPath = join(dir, "preview.png");
      const source = new Uint8Array(4 * 4 * 4).fill(255);
      writeFileSync(previewPath, encodePngRgba(4, source));
      const written = new Map<string, Uint8Array>();
      writeSiteIcons(dir, (path, bytes) => written.set(path, bytes), previewPath);
      expect(written.size).toBe(Object.keys(SITE_ICONS).length);
      for (const [name, size] of Object.entries(SITE_ICONS)) {
        const bytes = written.get(join(dir, name))!;
        const decoded = decodePngRgba(bytes);
        expect(decoded.width).toBe(size);
        // The white preview fills the icon, not the dark kit mark.
        expect(decoded.pixels[0]).toBe(255);
      }
      written.clear();
      writeSiteIcons(dir, (path, bytes) => written.set(path, bytes));
      for (const [name, size] of Object.entries(SITE_ICONS)) {
        expect(written.get(join(dir, name))).toEqual(drawIcon(size));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the manifest is fullscreen landscape with the generated icons", () => {
    const manifest = JSON.parse(renderManifest(site)) as Record<string, unknown>;
    expect(manifest.display).toBe("fullscreen");
    expect(manifest.orientation).toBe("landscape");
    expect(manifest.start_url).toBe(".");
    expect(manifest.theme_color).toBe("#0d0f14");
    const icons = manifest.icons as Array<{ src: string; sizes: string; type: string; purpose: string }>;
    expect(icons.map((icon) => icon.src).sort()).toEqual(Object.keys(SITE_ICONS).filter((n) => n !== "apple-touch-icon.png").sort());
    const iconSizes: Record<string, number> = { ...SITE_ICONS };
    for (const icon of icons) {
      const size = Number(icon.sizes.split("x")[0]);
      expect(icon.sizes).toBe(`${size}x${size}`);
      expect(iconSizes[icon.src]).toBe(size);
      expect(icon.purpose).toContain("maskable");
    }
  });
});

describe("mobile chrome", () => {
  const sunstone = resolveGame(KIT_ROOT, config, "sunstone");

  test("every page ships the install manifest and the mobile web-app meta", () => {
    const landing = renderLanding(site, [{ game: sunstone }]);
    expect(landing).toContain('<link rel="manifest" href="manifest.webmanifest">');
    expect(landing).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
    expect(landing).toContain('<meta name="theme-color" content="#0d0f14">');
    expect(landing).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(landing).toContain("viewport-fit=cover");
    const player = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    expect(player).toContain('<link rel="manifest" href="../manifest.webmanifest">');
    expect(player).toContain('<link rel="apple-touch-icon" href="../apple-touch-icon.png">');
  });

  test("the player page has the fullscreen toggle, the immersive exit and the rotate hint", () => {
    const html = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    expect(html).toContain('<button type="button" id="fullscreen-toggle" class="bar-button" aria-pressed="false">Fullscreen</button>');
    expect(html).toContain('<button type="button" class="immersive-exit" id="immersive-exit" hidden>Exit fullscreen</button>');
    expect(html).toContain('<div class="rotate-hint" id="rotate-hint" hidden>');
    expect(html).toContain("Rotate your device to play in landscape.");
    expect(html).toContain('data-rotate-dismiss');
  });

  test("the screen and the touch pad share one play surface, in that order", () => {
    const html = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    const surface = html.indexOf('class="play-surface"');
    const screen = html.indexOf('class="screen-area"');
    const pad = html.indexOf('class="pad"');
    const exit = html.indexOf('id="immersive-exit"');
    expect(surface).toBeGreaterThan(-1);
    expect(surface).toBeLessThan(screen);
    expect(screen).toBeLessThan(pad);
    expect(pad).toBeLessThan(exit);
    // The pad keeps its buttons inside the surface.
    expect(html.slice(surface, exit)).toContain('data-button="UP"');
  });

  test("the demo controls are a disclosure, open by default for mouse users", () => {
    const html = renderPlayer(site, sunstone, playerConfig(sunstone), true);
    expect(html).toContain('data-demo-toggle aria-expanded="true" aria-controls="demo-controls-body"');
    expect(html).toContain('<div class="demo-body" id="demo-controls-body">');
    expect(html).toContain('class="demo-head"');
    // The chapter cards keep their markup inside the collapsible body.
    const body = html.slice(html.indexOf('id="demo-controls-body"'));
    expect(body).toContain('data-demo-chapter="cave"');
    expect(body).toContain('data-demo-speed="4"');
  });

  test("a game without chapters has no demo disclosure but keeps the immersive chrome", () => {
    const meadow = resolveGame(KIT_ROOT, config, "meadow");
    const html = renderPlayer(site, meadow, playerConfig(meadow), true);
    expect(html).not.toContain("data-demo-toggle");
    expect(html).not.toContain("demo-body");
    expect(html).toContain('id="fullscreen-toggle"');
    expect(html).toContain('class="play-surface"');
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

  test("withDemoQuery keeps the language parameter and other non-demo keys", () => {
    // The B1 regression: a chapter click used to wipe ?lang=, so a deep link
    // lost its language on the next refresh.
    expect(withDemoQuery("?lang=en&chapter=bedroom", { chapter: "paper-town" })).toBe("?lang=en&chapter=paper-town");
    expect(withDemoQuery("?lang=en", { autoplay: "bedroom", speed: "2" })).toBe("?lang=en&autoplay=bedroom&speed=2");
    expect(withDemoQuery("?lang=zh&campaign=spyder", { chapter: "bedroom" })).toBe("?lang=zh&campaign=spyder&chapter=bedroom");
  });

  test("withDemoQuery replaces the demo keys it owns and drops the rest", () => {
    expect(withDemoQuery("?chapter=bedroom&autoplay=bedroom&speed=4", { chapter: "paper-town" })).toBe("?chapter=paper-town");
    expect(withDemoQuery("?map=village&x=1&y=2", { chapter: "bedroom" })).toBe("?chapter=bedroom");
    expect(withDemoQuery("", { chapter: "bedroom" })).toBe("?chapter=bedroom");
    expect(withDemoQuery("?lang=en", {})).toBe("?lang=en");
    expect(withDemoQuery("?chapter=bedroom", {})).toBe("");
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
