// tests/web-invite-link.test.ts — drives the REAL initAuthUI()/setAuthUI(),
// inviteFromFragment()/pendingInvite()/forgetInvite() and boot() from
// tools/web/player.js in headless Chrome (through the kit's own CDP harness,
// tools/lib/cdp.ts) and proves the page's shareable invite-link contract
// with a multiplayer game:
//
//   no auth     a page whose config declares no auth gets no box at all
//   hidden      the box exists but stays hidden until an invite event
//   invite      shows this page's URL with the #invite=<token> fragment and
//               a hint with the validity in minutes; a later invite replaces
//               the link; no expiresIn means no hint
//   copy        the Copy button puts the URL on the real clipboard (read
//               back through navigator.clipboard.readText after a CDP
//               permission grant) and reads "Copied" for a moment; when the
//               async clipboard refuses, it selects the link and uses the
//               legacy copy command instead
//   close       the Close button hides the box and sends ("inviteEnd")
//   end/logout  inviteEnd and logout hide and clear the box
//   isolation   key events in the box never bubble past it
//   fragment    a page loaded with #invite=<token> exposes __pocketInvite at
//               boot, strips only that parameter (an oauth_token next to it
//               stays for oauthFromFragment, which then accepts it), stores
//               the token in sessionStorage so a later boot without the
//               fragment still exposes it, and inviteConsumed forgets it
//   language    labels follow the page language on __pocketPageLanguageEvent
//
// The page under test evals the functions extracted verbatim from
// tools/web/player.js (brace-matched out of the real file, not
// reimplemented), so a regression in the real file fails this test.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHROME_START_BUDGET_MS, Cdp, launchChrome } from "../tools/lib/cdp.ts";

const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome";
const PLAYER_JS = resolve(import.meta.dir, "..", "tools", "web", "player.js");

/** Extract one brace-delimited declaration verbatim from player.js,
 *  brace-matching so nested blocks don't truncate it. */
function extractBraced(source: string, needle: string): string {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`tools/web/player.js has no ${needle}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let i = open;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1] ?? "";
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      i++;
      break;
    }
  }
  if (depth !== 0) throw new Error(`could not find the end of ${needle}`);
  return source.slice(start, i);
}

function extractLine(source: string, needle: string): string {
  const line = source.split("\n").find((candidate) => candidate.startsWith(needle));
  if (!line) throw new Error(`tools/web/player.js has no ${needle}`);
  return line;
}

function extractPlayerBoot(source: string): string {
  return extractBraced(source, "async boot()").replace(/^async boot\(\)/, "async function boot()");
}

const TOKEN = "plaza-1.ABCDEFGH";

function harnessPage(): string {
  const source = readFileSync(PLAYER_JS, "utf8");
  const parts = [
    extractLine(source, "const OAUTH_STATE_KEY = "),
    extractLine(source, "const INVITE_KEY = "),
    extractLine(source, "const INVITE_COPIED_MS = "),
    extractLine(source, "const t = "),
    extractBraced(source, "function oauthFromFragment"),
    extractBraced(source, "function inviteFromFragment"),
    extractBraced(source, "function pendingInvite"),
    extractBraced(source, "function forgetInvite"),
    extractBraced(source, "function initAuthUI"),
    extractBraced(source, "function setAuthUI"),
    extractPlayerBoot(source),
  ];
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>invite link harness</title></head>
<body>
<script>
${parts.join("\n")}

let commands = [];
let leaked = [];
const AUTH = { github: { clientId: "client", worker: "https://auth.invalid" } };
const useLanguage = (language) => {
  const dictionaries = {
    en: {
      "auth.signin": "Sign in with GitHub",
      "auth.signed-in": "Signed in as {name}",
      "auth.signed-out": "Sign out",
      "auth.name-label": "Character name",
      "auth.name-submit": "Create",
      "auth.name-placeholder": "Type a name",
      "auth.invite-label": "Invite link",
      "auth.invite-copy": "Copy",
      "auth.invite-copied": "Copied",
      "auth.invite-close": "Close",
      "auth.invite-hint": "Anyone who opens it joins your world. Valid for {minutes} minutes.",
    },
    zh: {
      "auth.signin": "使用 GitHub 登录",
      "auth.signed-in": "已登录：{name}",
      "auth.signed-out": "退出登录",
      "auth.name-label": "角色名",
      "auth.name-submit": "创建",
      "auth.name-placeholder": "输入名字",
      "auth.invite-label": "邀请链接",
      "auth.invite-copy": "复制",
      "auth.invite-copied": "已复制",
      "auth.invite-close": "关闭",
      "auth.invite-hint": "打开它的人会进入你的世界，{minutes} 分钟内有效。",
    },
  };
  const strings = dictionaries[language] ?? dictionaries.en;
  globalThis.__pocketI18n = (key) => strings[key] ?? key;
};
// Anything above the box that could see its keystrokes: the document and
// window listen in both phases and record what arrives from the box.
for (const type of ["keydown", "keyup", "keypress"]) {
  document.addEventListener(type, (event) => {
    if (event.target && event.target.id === "auth-invite") leaked.push("document:" + type);
  });
  window.addEventListener(type, (event) => {
    if (event.target && event.target.id === "auth-invite") leaked.push("window:" + type);
  });
}
const storedInvite = () => {
  try { return sessionStorage.getItem(INVITE_KEY); } catch (e) { return "unavailable"; }
};
const snapshot = () => {
  const box = document.getElementById("auth-invite-box");
  const input = document.getElementById("auth-invite");
  const copy = document.getElementById("auth-invite-copy");
  const close = document.getElementById("auth-invite-close");
  const hint = document.getElementById("auth-invite-hint");
  const label = box ? box.querySelector("label") : null;
  const signIn = document.getElementById("auth-signin");
  const signOut = document.getElementById("auth-signout");
  const nameBox = document.getElementById("auth-name-box");
  return {
    present: box !== null,
    hidden: box ? box.hidden : null,
    value: input ? input.value : null,
    readOnly: input ? input.readOnly : null,
    selected: input !== null && document.activeElement === input && input.selectionStart === 0
      && input.selectionEnd === input.value.length && input.value.length > 0,
    labelText: label ? label.textContent : null,
    labelFor: label ? label.htmlFor : null,
    copyText: copy ? copy.textContent : null,
    closeText: close ? close.textContent : null,
    hintText: hint ? hint.textContent : null,
    hintHidden: hint ? hint.hidden : null,
    nameHidden: nameBox ? nameBox.hidden : null,
    signInText: signIn ? signIn.textContent : null,
    signOutHidden: signOut ? signOut.hidden : null,
    commands: commands.slice(),
    leaked: leaked.slice(),
    stored: storedInvite(),
    barChildren: Array.from(document.querySelector(".bar").children).map((node) => node.id || node.className),
  };
};
window.setup = (withAuth, language = "en") => {
  delete globalThis.__pocketAuthEvent;
  delete globalThis.__pocketAuthCommand;
  delete globalThis.__pocketPageLanguageEvent;
  commands = [];
  leaked = [];
  useLanguage(language);
  document.body.innerHTML = '<div class="bar"><span class="audio-controls"></span></div>';
  globalThis.__pocketAuthCommand = (command, value) => {
    commands.push(value === undefined ? [command] : [command, value]);
  };
  initAuthUI(withAuth ? { auth: AUTH } : {});
  return snapshot();
};
window.gameEvent = (ev) => {
  globalThis.__pocketAuthEvent?.(ev);
  return snapshot();
};
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
window.clickCopy = async (waitMs = 0) => {
  document.getElementById("auth-invite-copy").click();
  // The copy is asynchronous: give the clipboard promise a few turns.
  await settle(100);
  if (waitMs > 0) await settle(waitMs);
  return snapshot();
};
window.readClipboard = () => navigator.clipboard.readText();
window.withRefusingClipboard = async () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  const execs = [];
  const originalExec = document.execCommand;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error("clipboard refused")) },
  });
  document.execCommand = function (name) {
    execs.push(name);
    return originalExec.call(document, name);
  };
  try {
    document.getElementById("auth-invite-copy").click();
    await settle(100);
    return { ...snapshot(), execs };
  } finally {
    delete navigator.clipboard;
    if (original) Object.defineProperty(Navigator.prototype, "clipboard", original);
    document.execCommand = originalExec;
  }
};
window.clickClose = () => {
  document.getElementById("auth-invite-close").click();
  return snapshot();
};
window.pressKey = (key) => {
  const input = document.getElementById("auth-invite");
  input.dispatchEvent(new KeyboardEvent("keydown", { key, code: "Key" + key.toUpperCase(), bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key, code: "Key" + key.toUpperCase(), bubbles: true }));
  return snapshot();
};
window.switchLanguage = (language) => {
  useLanguage(language);
  globalThis.__pocketPageLanguageEvent?.(language);
  return snapshot();
};
window.snapshot = snapshot;

// --- boot probe: the real boot() with the asset fetches stubbed out -------
function fetchOk() { return Promise.reject(new Error("asset probe stop")); }
const bootReceiver = (config) => ({ config, fit() {} });
window.setOAuthState = (value) => {
  if (value === null) sessionStorage.removeItem(OAUTH_STATE_KEY);
  else sessionStorage.setItem(OAUTH_STATE_KEY, value);
};
window.clearInviteStorage = () => sessionStorage.removeItem(INVITE_KEY);
window.runBoot = async (hash) => {
  if (hash !== undefined) {
    if (hash) location.hash = hash;
    else history.replaceState(null, "", location.pathname + location.search);
  }
  delete globalThis.__pocketInvite;
  delete globalThis.__pocketAuth;
  try {
    await boot.call(bootReceiver({ wasm: "core.wasm", pak: "game.pak", bundle: "game.js" }));
  } catch (error) {
    if (error.message !== "asset probe stop") throw error;
  }
  return {
    invite: globalThis.__pocketInvite === undefined ? null : globalThis.__pocketInvite,
    auth: globalThis.__pocketAuth === undefined ? null : Object.assign({}, globalThis.__pocketAuth),
    hash: location.hash,
    search: location.search,
    stored: storedInvite(),
  };
};
window.runInviteFromFragment = (hash) => {
  if (hash) location.hash = hash;
  else history.replaceState(null, "", location.pathname + location.search);
  const token = inviteFromFragment();
  return { token, hash: location.hash, search: location.search, stored: storedInvite() };
};
window.__inviteReady = true;
</script>
</body>
</html>`;
}

interface Snapshot {
  present: boolean;
  hidden: boolean | null;
  value: string | null;
  readOnly: boolean | null;
  selected: boolean;
  labelText: string | null;
  labelFor: string | null;
  copyText: string | null;
  closeText: string | null;
  hintText: string | null;
  hintHidden: boolean | null;
  nameHidden: boolean | null;
  signInText: string | null;
  signOutHidden: boolean | null;
  commands: string[][];
  leaked: string[];
  stored: string | null;
  barChildren: string[];
}

interface BootProbe {
  invite: string | null;
  auth: Record<string, string> | null;
  hash: string;
  search: string;
  stored: string | null;
}

interface FragmentProbe {
  token: string | null;
  hash: string;
  search: string;
  stored: string | null;
}

const INVITE = { type: "invite", token: TOKEN, expiresIn: 600 };

describe.skipIf(!existsSync(CHROME))("web page invite-link box", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let profile = "";
  let cdp: Cdp | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let origin = "";

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    if (!cdp) throw new Error("cdp not connected");
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  };
  const setup = (withAuth: boolean, language = "en") => evaluate<Snapshot>(`window.setup(${withAuth}, ${JSON.stringify(language)})`);
  const gameEvent = (ev: Record<string, unknown>) => evaluate<Snapshot>(`window.gameEvent(${JSON.stringify(ev)})`);
  const runBoot = (hash?: string) => evaluate<BootProbe>(`window.runBoot(${hash === undefined ? "" : JSON.stringify(hash)})`);
  const navigate = async (path: string) => {
    const loaded = new Promise((resolve) => cdp!.on("Page.loadEventFired", resolve));
    await cdp!.send("Page.navigate", { url: `${origin}${path}` });
    await loaded;
    if (!await evaluate<boolean>("window.__inviteReady === true")) throw new Error("invite harness did not initialize");
  };

  beforeAll(async () => {
    const page = harnessPage();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/") return new Response("not found", { status: 404 });
        return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    profile = mkdtempSync(join(tmpdir(), "pocket-rpgkit-invite-link-"));
    const chrome = await launchChrome(CHROME, profile, "800,600");
    proc = chrome.proc;
    cdp = await Cdp.connect(chrome.ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    // Reading the clipboard back needs the read permission; headless Chrome
    // grants nothing by itself. The async clipboard also refuses a document
    // that is not focused, which a headless tab never is on its own.
    await cdp.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Page.bringToFront");
    const exceptions: string[] = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      const detail = event.exceptionDetails;
      exceptions.push(detail?.exception?.description ?? detail?.text ?? "unknown page error");
    });
    const loaded = new Promise((resolve) => cdp!.on("Page.loadEventFired", resolve));
    await cdp.send("Page.navigate", { url: `${origin}/` });
    await loaded;
    if (!await evaluate<boolean>("window.__inviteReady === true")) {
      throw new Error(`invite harness did not initialize: ${exceptions.join("\n") || "no page exception reported"}`);
    }
  }, CHROME_START_BUDGET_MS + 30_000);

  afterAll(() => {
    cdp?.close();
    proc?.kill();
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  test("a page without auth gets no invite box, and a page with auth keeps it hidden until invite", async () => {
    const plain = await setup(false);
    expect(plain.present).toBe(false);
    expect(plain.barChildren).toEqual(["audio-controls"]);

    const withAuth = await setup(true);
    expect(withAuth.present).toBe(true);
    expect(withAuth.hidden).toBe(true);
    expect(withAuth.value).toBe("");
    expect(withAuth.readOnly).toBe(true);
    expect(withAuth.labelFor).toBe("auth-invite");
    expect(withAuth.barChildren).toEqual(["auth-signin", "auth-signout", "auth-name-box", "auth-invite-box", "audio-controls"]);
    expect(withAuth.commands).toEqual([]);
  }, 20_000);

  test("invite shows this page's URL with the #invite fragment and the minutes hint; a later invite replaces the link", async () => {
    await setup(true);
    const shown = await gameEvent(INVITE);
    expect(shown.hidden).toBe(false);
    expect(shown.value).toBe(`${origin}/#invite=${TOKEN}`);
    expect(shown.hintHidden).toBe(false);
    expect(shown.hintText).toBe("Anyone who opens it joins your world. Valid for 10 minutes.");
    expect(shown.copyText).toBe("Copy");
    expect(shown.closeText).toBe("Close");
    expect(shown.nameHidden).toBe(true);

    const replaced = await gameEvent({ type: "invite", token: "plaza-2.ZYXWVUTS", expiresIn: 90 });
    expect(replaced.hidden).toBe(false);
    expect(replaced.value).toBe(`${origin}/#invite=plaza-2.ZYXWVUTS`);
    expect(replaced.hintText).toBe("Anyone who opens it joins your world. Valid for 2 minutes.");

    const noExpiry = await gameEvent({ type: "invite", token: TOKEN });
    expect(noExpiry.value).toBe(`${origin}/#invite=${TOKEN}`);
    expect(noExpiry.hintHidden).toBe(true);
    expect(noExpiry.hintText).toBe("");

    const bogus = await gameEvent({ type: "invite", token: "" });
    expect(bogus.value).toBe(`${origin}/#invite=${TOKEN}`);
    expect(bogus.hidden).toBe(false);
  }, 20_000);

  test("Copy puts the URL on the real clipboard and reads Copied for a moment", async () => {
    await setup(true);
    await gameEvent(INVITE);
    await evaluate(`navigator.clipboard.writeText("stale")`);
    const copied = await evaluate<Snapshot>("window.clickCopy()");
    expect(copied.copyText).toBe("Copied");
    expect(await evaluate<string>("window.readClipboard()")).toBe(`${origin}/#invite=${TOKEN}`);
    expect(copied.hidden).toBe(false);
    expect(copied.commands).toEqual([]);

    const later = await evaluate<Snapshot>("window.clickCopy(2300)");
    expect(later.copyText).toBe("Copy");
  }, 20_000);

  test("when the async clipboard refuses, Copy selects the link and uses the legacy copy command", async () => {
    await setup(true);
    await gameEvent(INVITE);
    const fallback = await evaluate<Snapshot & { execs: string[] }>("window.withRefusingClipboard()");
    expect(fallback.execs).toEqual(["copy"]);
    expect(fallback.selected).toBe(true);
    expect(fallback.hidden).toBe(false);
  }, 20_000);

  test("Close hides and clears the box and tells the game to forget the invite", async () => {
    await setup(true);
    await gameEvent(INVITE);
    const closed = await evaluate<Snapshot>("window.clickClose()");
    expect(closed.hidden).toBe(true);
    expect(closed.value).toBe("");
    expect(closed.hintText).toBe("");
    expect(closed.hintHidden).toBe(true);
    expect(closed.commands).toEqual([["inviteEnd"]]);

    const reopened = await gameEvent(INVITE);
    expect(reopened.hidden).toBe(false);
    expect(reopened.value).toBe(`${origin}/#invite=${TOKEN}`);
    expect(reopened.commands).toEqual([["inviteEnd"]]);
  }, 20_000);

  test("inviteEnd and logout hide and clear the box, and the sign-in controls keep working", async () => {
    await setup(true);
    await gameEvent(INVITE);
    const ended = await gameEvent({ type: "inviteEnd" });
    expect(ended.hidden).toBe(true);
    expect(ended.value).toBe("");
    expect(ended.commands).toEqual([]);

    const signedIn = await gameEvent({ type: "login", login: "octocat" });
    expect(signedIn.signInText).toBe("Signed in as octocat");
    const opened = await gameEvent(INVITE);
    expect(opened.hidden).toBe(false);
    expect(opened.signOutHidden).toBe(false);
    const loggedOut = await gameEvent({ type: "logout" });
    expect(loggedOut.hidden).toBe(true);
    expect(loggedOut.value).toBe("");
    expect(loggedOut.signInText).toBe("Sign in with GitHub");
    expect(loggedOut.signOutHidden).toBe(true);
  }, 20_000);

  test("keystrokes in the box never leave it", async () => {
    await setup(true);
    await gameEvent(INVITE);
    await evaluate(`window.pressKey("a")`);
    const typed = await evaluate<Snapshot>(`window.pressKey("c")`);
    expect(typed.leaked).toEqual([]);
  }, 20_000);

  test("a page loaded with #invite exposes __pocketInvite at boot, strips only that parameter and keeps the OAuth callback", async () => {
    await evaluate("window.clearInviteStorage()");
    await evaluate(`window.setOAuthState("s1")`);
    await navigate(`/?lang=zh#invite=${TOKEN}&oauth_token=tok&state=s1`);

    const booted = await runBoot();
    expect(booted.invite).toBe(TOKEN);
    expect(booted.stored).toBe(TOKEN);
    // oauthFromFragment saw the callback that rode next to the invite,
    // accepted it and stripped the rest of the fragment itself.
    expect(booted.auth).toEqual({ token: "tok" });
    expect(booted.hash).toBe("");
    expect(booted.search).toBe("?lang=zh");

    // The parameter leaves the fragment on its own; what remains is intact.
    const partial = await evaluate<FragmentProbe>(`window.runInviteFromFragment("#oauth_token=tok2&invite=plaza-3.QQQQQQQQ&state=s2")`);
    expect(partial.token).toBe("plaza-3.QQQQQQQQ");
    expect(partial.hash).toBe("#oauth_token=tok2&state=s2");
    expect(partial.search).toBe("?lang=zh");
    expect(partial.stored).toBe("plaza-3.QQQQQQQQ");

    // Fragments without an invite are left alone.
    const untouched = await evaluate<FragmentProbe>(`window.runInviteFromFragment("#chapter=3")`);
    expect(untouched.token).toBe(null);
    expect(untouched.hash).toBe("#chapter=3");
    expect(untouched.stored).toBe("plaza-3.QQQQQQQQ");
    await navigate("/");
  }, 30_000);

  test("the stored token survives a boot without the fragment, and inviteConsumed forgets it", async () => {
    await evaluate("window.clearInviteStorage()");
    const booted = await runBoot(`#invite=${TOKEN}`);
    expect(booted.invite).toBe(TOKEN);
    expect(booted.hash).toBe("");

    // The GitHub sign-in redirect comes back without the invite fragment;
    // so does a reload in the same tab.
    const again = await runBoot("");
    expect(again.invite).toBe(TOKEN);
    expect(again.stored).toBe(TOKEN);

    await setup(true);
    const consumed = await gameEvent({ type: "inviteConsumed" });
    expect(consumed.stored).toBe(null);
    expect(consumed.hidden).toBe(true);
    const after = await runBoot("");
    expect(after.invite).toBe(null);
    expect(after.stored).toBe(null);
  }, 20_000);

  test("labels follow the page language on __pocketPageLanguageEvent", async () => {
    const english = await setup(true, "en");
    expect(english.labelText).toBe("Invite link");
    expect(english.copyText).toBe("Copy");
    expect(english.closeText).toBe("Close");

    const chinese = await evaluate<Snapshot>(`window.switchLanguage("zh")`);
    expect(chinese.labelText).toBe("邀请链接");
    expect(chinese.copyText).toBe("复制");
    expect(chinese.closeText).toBe("关闭");

    const opened = await gameEvent(INVITE);
    expect(opened.labelText).toBe("邀请链接");
    expect(opened.hintText).toBe("打开它的人会进入你的世界，10 分钟内有效。");
    const copied = await evaluate<Snapshot>("window.clickCopy()");
    expect(copied.copyText).toBe("已复制");

    const back = await evaluate<Snapshot>(`window.switchLanguage("en")`);
    expect(back.labelText).toBe("Invite link");
    expect(back.hintText).toBe("Anyone who opens it joins your world. Valid for 10 minutes.");
    expect(back.hidden).toBe(false);
  }, 20_000);
});
