// tools/web/i18n.ts — player-page chrome strings and the inline language
// switcher. A game declares `languages` in web.json; the player page then
// shows a switcher and translates its own chrome. The game's content
// language is the game's own business: the page persists the choice through
// the same URL parameter and storage key the game reads at boot, so the
// page switcher, the game's own switcher and a ?lang= deep link all agree.
//
// The page is static HTML, so the switch happens client-side. renderPlayer
// embeds the dictionary and the game's per-language text as JSON, and the
// inline script below resolves the active language (?param= -> storage ->
// default), swaps every [data-i18n] string, highlights the current language
// and reloads with the stored choice when a language button is pressed.
// player.js asks the same script for the few strings it sets itself
// (fullscreen/mute/loading), so its dynamic labels follow the page language.
//
// Games that declare no languages get none of this: their pages stay
// byte-for-byte as they were.

/** Chrome strings of the player page, per language code. English is the
 *  fallback and lists every key; other locales translate any subset (a
 *  missing key falls back to English). */
export const PLAYER_I18N: Record<string, Record<string, string>> = {
  en: {
    "fullscreen": "Fullscreen",
    "exit-fullscreen": "Exit fullscreen",
    "hide-buttons": "Hide buttons",
    "show-buttons": "Show buttons",
    "mute": "Mute",
    "unmute": "Unmute",
    "mute-audio": "Mute audio",
    "unmute-audio": "Unmute audio",
    "auth.signin": "Sign in with GitHub",
    "auth.signed-in": "Signed in as {name}",
    "auth.signed-out": "Sign out",
    "volume": "Volume",
    "loading": "Loading…",
    "reload": "Reload",
    "game-stopped": "The game stopped",
    "file-server": "Open this page through a web server; browsers do not load WebAssembly from file:// pages.",
    "focus-hint": "Click the game to use the keyboard",
    "rotate-hint": "Rotate your device to play in landscape.",
    "continue-portrait": "Continue in portrait",
    "caption": "Keys reach the game while it has focus: it takes focus when the page loads and whenever you click it.",
    "demo-controls": "Demo controls",
    "chapters": "Chapters",
    "chapters-toggle": "Chapters",
    "chapters-toggle-aria": "Chapters",
    "chapters-autoplay-aria": "Chapters and autoplay",
    "chapter-row": "Chapter",
    "autoplay-row": "Autoplay",
    "demo-help": "Jump instantly without reloading.",
    "demo-help-autoplay": "Jump instantly without reloading. Autoplay starts the selected chapter at the chosen speed.",
    "exhibition-halls": "Exhibition halls",
    "controls-heading": "Controls",
    "editor-open": "Open…",
    "editor-download": "Download",
    "editor-preparing": "Preparing the browser editor…",
    "editor-privacy": "Your project data stays in this browser; nothing is uploaded.",
    "lang-switch-aria": "Language",
  },
  zh: {
    "fullscreen": "全屏",
    "exit-fullscreen": "退出全屏",
    "hide-buttons": "隐藏按键",
    "show-buttons": "显示按键",
    "mute": "静音",
    "unmute": "取消静音",
    "mute-audio": "静音",
    "unmute-audio": "取消静音",
    "auth.signin": "使用 GitHub 登录",
    "auth.signed-in": "已登录：{name}",
    "auth.signed-out": "退出登录",
    "volume": "音量",
    "loading": "加载中…",
    "reload": "重新加载",
    "game-stopped": "游戏已停止",
    "file-server": "请通过网页服务器打开本页；浏览器无法从 file:// 页面加载 WebAssembly。",
    "focus-hint": "点击游戏画面以使用键盘",
    "rotate-hint": "请横屏游玩。",
    "continue-portrait": "竖屏继续",
    "caption": "键盘在游戏获得焦点时生效：页面加载时以及点击游戏画面时，游戏会获取焦点。",
    "demo-controls": "演示控制",
    "chapters": "章节",
    "chapters-toggle": "章节",
    "chapters-toggle-aria": "章节",
    "chapters-autoplay-aria": "章节与自动演示",
    "chapter-row": "章节",
    "autoplay-row": "自动演示",
    "demo-help": "无需刷新即可即时跳转。",
    "demo-help-autoplay": "无需刷新即可即时跳转。自动演示以所选速度从选定章节开始播放。",
    "exhibition-halls": "展厅",
    "controls-heading": "操作说明",
    "editor-open": "打开…",
    "editor-download": "下载",
    "editor-preparing": "正在准备浏览器编辑器…",
    "editor-privacy": "项目数据只保存在本浏览器中，不会上传。",
    "lang-switch-aria": "语言",
  },
};

/** The inline script that runs the switcher on a player page. It reads its
 *  configuration from <script type="application/json" id="pocket-i18n"> and
 *  exposes __pocketI18n(key) for player.js. Deliberately dependency-free and
 *  pre-ES6: it runs as a classic inline script so it can swap the chrome
 *  before the first paint (the page hides <body> while <html> carries
 *  data-page-lang="pending"). */
export const PAGE_I18N_SCRIPT = `(function () {
  "use strict";
  var node = document.getElementById("pocket-i18n");
  if (!node) return;
  var cfg;
  try { cfg = JSON.parse(node.textContent || "{}"); } catch (error) { return; }
  var options = cfg.options || [];
  var param = cfg.param || "lang";
  function known(code) {
    for (var i = 0; i < options.length; i++) if (options[i].code === code) return true;
    return false;
  }
  function urlLang() {
    try {
      var value = new URLSearchParams(location.search).get(param);
      return value && known(value) ? value : null;
    } catch (error) { return null; }
  }
  function storedLang() {
    try {
      var value = localStorage.getItem(cfg.storage);
      return value && known(value) ? value : null;
    } catch (error) { return null; }
  }
  var lang = urlLang() || storedLang() || cfg.default || (options[0] && options[0].code) || "en";
  function dict(code) { return (cfg.ui && cfg.ui[code]) || {}; }
  function t(key) {
    var active = dict(lang);
    if (active[key] !== undefined) return active[key];
    var en = dict("en");
    return en[key] !== undefined ? en[key] : key;
  }
  function publishLanguage() {
    // Flip the pending flag before any swap so the page can never stay hidden.
    document.documentElement.setAttribute("data-page-lang", lang);
    document.documentElement.lang = lang;
    // player.js reads this for the strings it sets itself. Its optional hook
    // immediately re-renders stateful labels such as the signed-in user.
    globalThis.__pocketI18n = t;
    globalThis.__pocketPageLang = lang;
    if (typeof globalThis.__pocketPageLanguageEvent === "function") {
      globalThis.__pocketPageLanguageEvent(lang);
    }
  }
  publishLanguage();
  function content() { return (cfg.content && cfg.content[lang]) || {}; }
  function apply() {
    var strings = dict(lang);
    var text = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < text.length; i++) {
      var key = text[i].getAttribute("data-i18n");
      if (strings[key] !== undefined) text[i].textContent = strings[key];
    }
    var aria = document.querySelectorAll("[data-i18n-aria-label]");
    for (var j = 0; j < aria.length; j++) {
      var akey = aria[j].getAttribute("data-i18n-aria-label");
      if (strings[akey] !== undefined) aria[j].setAttribute("aria-label", strings[akey]);
    }
    var page = content();
    if (page.description) {
      var description = document.querySelector("[data-game-description]");
      if (description) description.textContent = page.description;
      var meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", page.description);
    }
    if (page.chapters) {
      Object.keys(page.chapters).forEach(function (id) {
        var chapter = page.chapters[id];
        var title = document.getElementById("demo-chapter-title-" + id);
        if (title && chapter.title) title.textContent = chapter.title;
        var body = document.getElementById("demo-chapter-description-" + id);
        if (body && chapter.description) body.textContent = chapter.description;
        if (chapter.preview) {
          var img = document.getElementById("demo-chapter-preview-" + id);
          if (img) img.src = chapter.preview;
        }
      });
    }
    // The controls table shows one language at a time: swap every row whose
    // action has a translation, and the pointer note.
    var pageControls = page.controls;
    if (pageControls) {
      var controlRows = document.querySelectorAll("[data-i18n-control]");
      for (var cr = 0; cr < controlRows.length; cr++) {
        var ckey = controlRows[cr].getAttribute("data-i18n-control");
        if (ckey && pageControls[ckey] !== undefined) controlRows[cr].textContent = pageControls[ckey];
      }
    }
    if (page.pointer) {
      var pointerRow = document.querySelector("[data-i18n-pointer]");
      if (pointerRow) pointerRow.textContent = page.pointer;
    }
    // Landing page: chapter chips carry data-landing-chapter
    // "<gameId>/<chapterId>"; the landing config maps game ids to i18n tables.
    if (cfg.landing) {
      var chips = document.querySelectorAll("[data-landing-chapter]");
      for (var c = 0; c < chips.length; c++) {
        var ref = chips[c].getAttribute("data-landing-chapter").split("/");
        var gameTable = cfg.landing[ref[0]];
        var chapter = gameTable && gameTable[lang] && gameTable[lang].chapters
          ? gameTable[lang].chapters[ref.slice(1).join("/")]
          : null;
        if (chapter && chapter.title) chips[c].textContent = chapter.title;
        // Carry the active language (and any other non-demo parameter) from
        // the landing page into the player page. The demo-owned keys mirror
        // tools/web/boot.ts; setting .href resolves the attribute, so only
        // touch it when there is something to add.
        try {
          var here = new URL(location.href);
          var carried = [];
          here.searchParams.forEach(function (value, key) {
            if (key !== "chapter" && key !== "map" && key !== "x" && key !== "y" && key !== "autoplay" && key !== "speed") {
              carried.push([key, value]);
            }
          });
          if (carried.length > 0) {
            var chipUrl = new URL(chips[c].href, location.href);
            carried.forEach(function (pair) {
              if (chipUrl.searchParams.get(pair[0]) === null) chipUrl.searchParams.set(pair[0], pair[1]);
            });
            chips[c].href = chipUrl.pathname + chipUrl.search + chipUrl.hash;
          }
        } catch (error) { /* keep the static href */ }
      }
      var descriptions = document.querySelectorAll("[data-landing-description]");
      for (var d = 0; d < descriptions.length; d++) {
        var descGame = cfg.landing[descriptions[d].getAttribute("data-landing-description")];
        var descText = descGame && descGame[lang] && descGame[lang].description;
        if (descText) descriptions[d].textContent = descText;
      }
      // The landing controls tables swap the same way, per game.
      var landingControls = document.querySelectorAll("[data-landing-control]");
      for (var lc = 0; lc < landingControls.length; lc++) {
        var lgame = cfg.landing[landingControls[lc].getAttribute("data-landing-control")];
        var lkey = landingControls[lc].getAttribute("data-i18n-control");
        var ltable = lgame && lgame[lang] && lgame[lang].controls;
        if (lkey && ltable && ltable[lkey] !== undefined) landingControls[lc].textContent = ltable[lkey];
      }
      var landingPointers = document.querySelectorAll("[data-landing-pointer]");
      for (var lp = 0; lp < landingPointers.length; lp++) {
        var lpgame = cfg.landing[landingPointers[lp].getAttribute("data-landing-pointer")];
        var lptext = lpgame && lpgame[lang] && lpgame[lang].pointer;
        if (lptext) landingPointers[lp].textContent = lptext;
      }
    }
    var buttons = document.querySelectorAll("[data-lang-code]");
    for (var k = 0; k < buttons.length; k++) {
      var on = buttons[k].getAttribute("data-lang-code") === lang;
      buttons[k].classList.toggle("active", on);
      buttons[k].setAttribute("aria-pressed", String(on));
    }
    // Chapters/autoplay may be unavailable in a language (tapes recorded in
    // another): say so instead of letting the links silently reload.
    var notice = document.querySelector("[data-chapters-notice]");
    if (notice) {
      notice.textContent = page.chaptersNotice || "";
      notice.hidden = !page.chaptersNotice;
    }
    if (page.chaptersNotice) {
      var cards = document.querySelectorAll("[data-demo-chapter],[data-demo-speed]");
      for (var m = 0; m < cards.length; m++) {
        cards[m].setAttribute("aria-disabled", "true");
        cards[m].classList.add("is-disabled");
      }
    }
  }
  function cleanUrl() {
    // Mirror the game's switcher: drop the lang parameter so the stored
    // choice wins on the next boot (a present parameter still beats it).
    try {
      var url = new URL(location.href);
      url.searchParams.delete(param);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (error) { /* URL/history unavailable: the reload keeps the parameter */ }
  }
  function switchTo(code) {
    if (!known(code) || code === lang) return;
    // Translate the live page before navigation. This matters when a host or
    // test defers the reload, and keeps stateful auth chrome in lockstep with
    // the static labels rather than waiting for the next login/logout event.
    lang = code;
    publishLanguage();
    apply();
    var persisted = false;
    try { localStorage.setItem(cfg.storage, code); persisted = true; } catch (error) {}
    if (persisted) {
      cleanUrl();
      location.reload();
    } else {
      // Storage unavailable (private mode): carry the choice in the URL.
      try {
        var url = new URL(location.href);
        url.searchParams.set(param, code);
        location.href = url.pathname + url.search + url.hash;
      } catch (error) { /* give up silently */ }
    }
  }
  globalThis.__pocketLangSwitch = switchTo;
  function wire() {
    var buttons = document.querySelectorAll("[data-lang-code]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function () {
        switchTo(this.getAttribute("data-lang-code"));
      });
    }
    if (content().chaptersNotice) {
      var cards = document.querySelectorAll("[data-demo-chapter],[data-demo-speed]");
      for (var j = 0; j < cards.length; j++) {
        cards[j].addEventListener("click", function (event) { event.preventDefault(); });
      }
    }
  }
  apply();
  wire();
})();`;
