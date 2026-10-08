// tests/web-i18n.test.ts — the player-page language switcher (tools/web.ts,
// tools/web/i18n.ts): the web.json schema, the page markup, the embedded
// configuration, and the byte-for-byte stability of pages that declare no
// languages. The switch behavior itself is exercised in a real browser by
// the game repo's web verifiers and the WEBLANG Playwright/CDP pass.

import { describe, expect, test } from "bun:test";
import {
  KIT_ROOT,
  loadSiteConfig,
  parseSiteConfig,
  renderLanding,
  renderPlayer,
  resolveGame,
  type PlayerConfig,
  type WebGame,
} from "../tools/web.ts";
import { PAGE_I18N_SCRIPT, PLAYER_I18N } from "../tools/web/i18n.ts";
import { keyMasks } from "../tools/web/keys.ts";

const config = loadSiteConfig(KIT_ROOT);
const site = { title: config.title!, intro: config.intro!, source: config.source! };

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
  };
}

const LANGUAGES = {
  languages: [
    { code: "en", label: "English" },
    { code: "zh", label: "中文" },
  ],
  languageSwitch: { param: "lang", storage: "pocket-tuxemon/lang" },
};

const ZH_TEXT = {
  description: "从卧室到无线电塔的完整中文战役。",
  chapters: {
    village: { title: "村庄", description: "荆棘谷里的村庄。" },
  },
  chaptersNotice: "章节与自动演示的录像按英文录制，中文模式下暂不可用。",
};

describe("web.json language schema", () => {
  const parse = (value: unknown) => () => parseSiteConfig(value, "web.json");

  test("languages is a non-empty list of code/label pairs with unique codes", () => {
    expect(parse({ games: { meadow: { languages: [] } } })).toThrow(/non-empty list/);
    expect(parse({ games: { meadow: { languages: [{ code: "EN", label: "English" }] } } })).toThrow(/language code/);
    expect(parse({ games: { meadow: { languages: [{ code: "en", label: "" }] } } })).toThrow(/non-empty text/);
    expect(parse({ games: { meadow: { languages: [{ code: "en", label: "English" }, { code: "en", label: "Englisch" }] } } })).toThrow(/repeats "en"/);
    expect(parse({ games: { meadow: LANGUAGES } })).not.toThrow();
    expect(parse({ games: { meadow: { languages: [{ code: "pt-br", label: "Português" }] } } })).not.toThrow();
  });

  test("languageSwitch takes a parameter name and a storage key", () => {
    expect(parse({ games: { meadow: { languageSwitch: {} } } })).not.toThrow();
    expect(parse({ games: { meadow: { languageSwitch: { param: "1lang" } } } })).toThrow(/query parameter name/);
    expect(parse({ games: { meadow: { languageSwitch: { storage: "" } } } })).toThrow(/localStorage key/);
    expect(parse({ games: { meadow: { languageSwitch: "lang" } } })).toThrow(/object/);
  });

  test("i18n keys must be declared languages and known chapters", () => {
    expect(parse({ games: { meadow: { i18n: { zh: {} } } } })).toThrow(/not one of the declared languages/);
    expect(parse({ games: { meadow: { languages: LANGUAGES.languages, i18n: { zh: { description: 1 } } } } })).toThrow(/description is text/);
    expect(parse({ games: { meadow: { languages: LANGUAGES.languages, i18n: { zh: { chapters: {} } } } } })).not.toThrow();
    expect(parse({
      games: {
        meadow: {
          languages: LANGUAGES.languages,
          chapters: [{ id: "intro", title: "Introduction" }],
          i18n: { zh: { chapters: { missing: { title: "?" } } } },
        },
      },
    })).toThrow(/not one of this game's chapters/);
    expect(parse({
      games: {
        meadow: {
          languages: LANGUAGES.languages,
          chapters: [{ id: "intro", title: "Introduction" }],
          i18n: { zh: { chapters: { intro: { title: "简介" } }, chaptersNotice: "暂不可用" } },
        },
      },
    })).not.toThrow();
  });

  test("i18n controls must be a table of known action strings, and pointer text", () => {
    const base = { languages: LANGUAGES.languages, controls: [{ button: "CIRCLE" as const, action: "Talk, confirm" }] };
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { controls: "移动" } } } } })).toThrow(/table keyed by the English control action/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { controls: { "Walk": "移动" } } } } } })).toThrow(/not one of this game's control actions/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { controls: { "Talk, confirm": "" } } } } } })).toThrow(/is text/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { controls: { "Talk, confirm": "对话、确认" }, pointer: "鼠标与触屏" } } } } })).not.toThrow();
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { pointer: 1 } } } } })).toThrow(/pointer is text/);
  });

  test("i18n chapter previews are relative PNG paths, like the default previews", () => {
    const base = { languages: LANGUAGES.languages, chapters: [{ id: "intro", title: "Introduction" }] };
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { chapters: { intro: { preview: 1 } } } } } } })).toThrow(/relative PNG preview/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { chapters: { intro: { preview: "/etc/hostname" } } } } } } })).toThrow(/relative PNG preview/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { chapters: { intro: { preview: "../secret.png" } } } } } } })).toThrow(/relative PNG preview/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { chapters: { intro: { preview: "docs/intro-zh.jpg" } } } } } } })).toThrow(/relative PNG preview/);
    expect(parse({ games: { meadow: { ...base, i18n: { zh: { chapters: { intro: { preview: "docs/intro-zh.png" } } } } } } })).not.toThrow();
  });

  test("a valid entry round-trips", () => {
    const entry = {
      games: {
        meadow: {
          ...LANGUAGES,
          chapters: [{ id: "village", title: "Village" }],
          i18n: { zh: ZH_TEXT },
        },
      },
    };
    expect(parse(entry)()).toEqual(entry);
  });
});

describe("resolved language settings", () => {
  test("resolveGame carries the options and the switch channels", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: LANGUAGES } }, "meadow");
    expect(game.languages).toEqual({
      options: [
        { code: "en", label: "English" },
        { code: "zh", label: "中文" },
      ],
      param: "lang",
      storage: "pocket-tuxemon/lang",
    });
  });

  test("defaults are the kit's own param and an app-scoped storage key", () => {
    const game = resolveGame(KIT_ROOT, { games: { meadow: { languages: LANGUAGES.languages } } }, "meadow");
    expect(game.languages?.param).toBe("lang");
    expect(game.languages?.storage).toBe("pocket-rpgkit:meadow:lang:v1");
  });

  test("a game without languages carries none", () => {
    const game = resolveGame(KIT_ROOT, config, "meadow");
    expect(game.languages).toBeUndefined();
    expect(game.i18n).toBeUndefined();
  });

  test("the landing page's chapters key exists in both dictionaries", () => {
    expect(PLAYER_I18N.en["chapters"]).toBe("Chapters");
    expect(PLAYER_I18N.zh["chapters"]).toBe("章节");
  });

  test("the published wander-online page exposes its bilingual auth shell", () => {
    const game = resolveGame(KIT_ROOT, config, "wander-online");
    expect(game.languages).toEqual({
      options: [
        { code: "en", label: "English" },
        { code: "zh", label: "中文" },
      ],
      param: "lang",
      storage: "pocket-rpgkit:wander-online:lang:v1",
    });
    expect(game.i18n?.zh).toMatchObject({
      description: expect.stringContaining("多人世界"),
      controls: {
        "Walk": "行走",
        "Confirm": "确认",
        "Cancel / back": "取消 / 返回",
      },
    });

    const html = renderPlayer(site, game, playerConfig(game), false);
    expect(html).toContain('data-lang-code="zh" aria-pressed="false">中文</button>');
    const json = /<script type="application\/json" id="pocket-i18n">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const embedded = JSON.parse(json) as {
      storage: string;
      ui: Record<string, Record<string, string>>;
      content: Record<string, { description?: string; controls?: Record<string, string> }>;
    };
    expect(embedded.storage).toBe("pocket-rpgkit:wander-online:lang:v1");
    expect(embedded.ui.en["auth.signed-out"]).toBe("Sign out");
    expect(embedded.ui.zh["auth.signed-out"]).toBe("退出登录");
    expect(embedded.content.zh.controls?.["Walk"]).toBe("行走");
  });
});

describe("player pages with languages", () => {
  const game = resolveGame(
    KIT_ROOT,
    { games: { sunstone: { ...config.games!.sunstone, ...LANGUAGES, i18n: { zh: ZH_TEXT } } } },
    "sunstone",
  );
  const html = renderPlayer(site, game, playerConfig(game), false);

  test("hide the page until the switcher ran, with a noscript fallback", () => {
    expect(html).toContain('<html lang="en" data-page-lang="pending">');
    expect(html).toContain("<noscript><style>html[data-page-lang=\"pending\"] body{visibility:visible}</style></noscript>");
  });

  test("render the switcher in the bar with every option", () => {
    expect(html).toContain('class="lang-switch" role="group" aria-label="Language" data-i18n-aria-label="lang-switch-aria"');
    expect(html).toContain('data-lang-code="en" aria-pressed="false">English</button>');
    expect(html).toContain('data-lang-code="zh" aria-pressed="false">中文</button>');
  });

  test("embed the switcher configuration and the chrome dictionaries", () => {
    const json = /<script type="application\/json" id="pocket-i18n">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const parsed = JSON.parse(json) as {
      options: { code: string; label: string }[];
      param: string;
      storage: string;
      default: string;
      ui: Record<string, Record<string, string>>;
      content: Record<string, unknown>;
    };
    expect(parsed.options).toEqual(LANGUAGES.languages);
    expect(parsed.param).toBe("lang");
    expect(parsed.storage).toBe("pocket-tuxemon/lang");
    expect(parsed.default).toBe("en");
    expect(parsed.ui.en["fullscreen"]).toBe("Fullscreen");
    expect(parsed.ui.zh["fullscreen"]).toBe("全屏");
    expect(parsed.ui.zh["demo-controls"]).toBe("演示控制");
    expect(parsed.content.zh).toMatchObject({ description: ZH_TEXT.description });
    expect(parsed.content.zh).toMatchObject({ chapters: { village: { title: "村庄" } } });
  });

  test("embed the inline switcher script", () => {
    expect(html).toContain(`<script>${PAGE_I18N_SCRIPT}</script>`);
    // The behaviors the acceptance criteria require, in the script itself.
    expect(PAGE_I18N_SCRIPT).toContain("URLSearchParams");
    expect(PAGE_I18N_SCRIPT).toContain("localStorage.getItem");
    expect(PAGE_I18N_SCRIPT).toContain("localStorage.setItem");
    expect(PAGE_I18N_SCRIPT).toContain("searchParams.delete");
    expect(PAGE_I18N_SCRIPT).toContain("location.reload");
    expect(PAGE_I18N_SCRIPT).toContain("__pocketI18n");
    expect(PAGE_I18N_SCRIPT).toContain("data-chapters-notice");
    expect(PAGE_I18N_SCRIPT).toContain("data-i18n-control");
    expect(PAGE_I18N_SCRIPT).toContain("data-landing-control");
  });

  test("hook every chrome string the page owns", () => {
    for (const key of [
      "fullscreen", "mute", "volume", "loading", "reload", "focus-hint",
      "rotate-hint", "continue-portrait", "exit-fullscreen", "caption",
      "demo-controls", "chapters-toggle", "chapter-row", "autoplay-row",
      "controls-heading",
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
    }
    expect(html).toContain('data-i18n-aria-label="mute-audio"');
    expect(html).toContain('data-i18n-aria-label="chapters-autoplay-aria"');
    expect(html).toContain("data-game-description");
    expect(html).toContain('data-chapters-notice hidden');
  });

  test("every hooked key exists in both dictionaries, with English as the static text", () => {
    const keys = [...html.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(10);
    const ariaKeys = new Set([...html.matchAll(/data-i18n-aria-label="([^"]+)"/g)].map((m) => m[1]!));
    for (const key of keys) {
      expect(PLAYER_I18N.en[key], `en dict lacks ${key}`).toBeTypeOf("string");
      expect(PLAYER_I18N.zh[key], `zh dict lacks ${key}`).toBeTypeOf("string");
      // The static HTML stays English (noscript and pre-swap fallback): text
      // between tags for text keys, in the attribute for aria-label keys.
      if (ariaKeys.has(key)) {
        expect(html).toContain(`aria-label="${PLAYER_I18N.en[key]}"`);
      } else {
        expect(html).toContain(`>${PLAYER_I18N.en[key]}<`);
      }
    }
  });

  test("the demo toggle and help use the autoplay variants when speeds exist", () => {
    expect(html).toContain('data-i18n="demo-help-autoplay"');
    expect(html).toContain('aria-label="Chapters and autoplay"');
    const noAutoplay = resolveGame(
      KIT_ROOT,
      { games: { sunstone: { ...LANGUAGES, chapters: [{ id: "intro", title: "Intro" }] } } },
      "sunstone",
    );
    const noAutoplayHtml = renderPlayer(site, noAutoplay, playerConfig(noAutoplay), false);
    expect(noAutoplayHtml).toContain('data-i18n="demo-help"');
    expect(noAutoplayHtml).toContain('aria-label="Chapters"');
    expect(noAutoplayHtml).not.toContain("data-demo-speed=");
  });
});

describe("localized controls tables and chapter previews", () => {
  const ZH_CONTROLS = {
    "Walk, pick an answer. During the demo, any key takes over.": "移动、选择答案。演示中任意键接管。",
    "Talk, confirm": "对话、确认",
    "Rewind 3 seconds": "倒回 3 秒",
    "Demo menu": "演示菜单",
  };
  const game = resolveGame(
    KIT_ROOT,
    {
      games: {
        sunstone: {
          ...config.games!.sunstone,
          ...LANGUAGES,
          chapters: config.games!.sunstone.chapters!.map((chapter) =>
            chapter.id === "village" ? { ...chapter, preview: "docs/screenshots/showcase-lobby.png" } : chapter,
          ),
          i18n: {
            zh: {
              controls: ZH_CONTROLS,
              chapters: { village: { preview: "docs/screenshots/showcase-overview.png" } },
            },
          },
        },
      },
    },
    "sunstone",
  );
  const html = renderPlayer(site, game, playerConfig(game), false);

  test("the player controls table hooks every action row for the swap", () => {
    for (const action of Object.keys(ZH_CONTROLS)) {
      expect(html).toContain(`data-i18n-control="${action}">${action}`);
    }
    expect(html).not.toContain('data-landing-control="sunstone"');
    expect(html).not.toContain(" data-i18n-pointer");
  });

  test("the embedded config carries the controls table and the resolved preview URL", () => {
    const json = /<script type="application\/json" id="pocket-i18n">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const parsed = JSON.parse(json) as { content: Record<string, any> };
    expect(parsed.content.zh.controls).toEqual(ZH_CONTROLS);
    expect(parsed.content.zh.chapters.village.preview).toBe("chapter-previews/village.zh.png");
  });

  test("the chapter preview image carries the swap id", () => {
    expect(html).toContain('id="demo-chapter-preview-village"');
    expect(html).toContain('src="chapter-previews/village.png"');
  });

  test("the landing table hooks rows per game and embeds the table", () => {
    const landing = renderLanding(site, [{ game, preview: [480, 272] }]);
    expect(landing).toContain('data-i18n-control="Talk, confirm" data-landing-control="sunstone"');
    const json = /<script type="application\/json" id="pocket-i18n">([\s\S]*?)<\/script>/.exec(landing)![1]!;
    const parsed = JSON.parse(json) as { landing: Record<string, any> };
    expect(parsed.landing.sunstone.zh.controls).toEqual(ZH_CONTROLS);
  });
});

describe("player pages without languages", () => {
  for (const id of ["sunstone", "meadow", "editor"] as const) {
    test(`${id}: no trace of the switcher and the English page is unchanged`, () => {
      const game = resolveGame(KIT_ROOT, config, id);
      const html = renderPlayer(site, game, playerConfig(game), true);
      expect(html).not.toContain("data-i18n");
      expect(html).not.toContain("pocket-i18n");
      expect(html).not.toContain("lang-switch");
      expect(html).not.toContain("data-page-lang");
      expect(html).not.toContain("data-game-description");
      expect(html).not.toContain("data-chapters-notice");
      expect(html).not.toContain(PAGE_I18N_SCRIPT);
      expect(html).toContain('<html lang="en">');
    });
  }
});
