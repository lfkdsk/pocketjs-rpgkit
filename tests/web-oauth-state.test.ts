// tests/web-oauth-state.test.ts — drives the REAL oauthFromFragment() from
// tools/web/player.js in headless Chrome (through the kit's own CDP harness,
// tools/lib/cdp.ts) and proves the OAuth state check fails closed:
//
//   happy path  saved state + matching fragment -> { token }, fragment
//               cleared, saved state consumed (one-time)
//   replay      the same fragment again -> rejected, fragment cleared,
//               no saved state
//   no state    sessionStorage empty -> rejected, fragment cleared
//   wrong state saved "expected", callback "wrong" -> rejected, fragment
//               cleared, saved state kept for a later legitimate callback
//   no token    saved state + fragment without oauth_token -> rejected,
//               fragment cleared, saved state kept
//   boot order  callback is consumed and the web marker/token is published
//               before any wasm, pak or bundle request starts
//   page UI     an ordinary web boot is distinguishable from desktop; login
//               shows a localized, login-only Sign out control
//   sign out    the page sends the game's existing signout command; its
//               logout event resets the page, the ticket stays gone on a
//               fresh boot, and a later login event works again
//
// The page under test evals the OAuth/UI functions and Player.boot source
// extracted verbatim from tools/web/player.js (brace-matched out of the real
// file, not reimplemented), so a regression in the real file fails this test.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// These tests start a real headless Chrome and load a page; on a busy
// machine that alone can take longer than bun's 5 s default.
setDefaultTimeout(60_000);
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, launchChrome } from "../tools/lib/cdp.ts";

const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome";
const PLAYER_JS = resolve(import.meta.dir, "..", "tools", "web", "player.js");

/** Extract one brace-delimited declaration/method verbatim from player.js,
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

function extractOAuthFromFragment(source: string): string {
  return extractBraced(source, "function oauthFromFragment");
}

function extractPlayerBoot(source: string): string {
  return extractBraced(source, "async boot()")
    .replace(/^async boot\(\)/, "async function boot()");
}

function extractLine(source: string, needle: string): string {
  const line = source.split("\n").find((candidate) => candidate.startsWith(needle));
  if (!line) throw new Error(`tools/web/player.js has no ${needle}`);
  return line;
}

/** The harness page: evals the real oauthFromFragment (and the real
 *  OAUTH_STATE_KEY constant) extracted from tools/web/player.js, then exposes
 *  window.runOAuth / window.setSaved for the test to drive. */
function harnessPage(): string {
  const source = readFileSync(PLAYER_JS, "utf8");
  const fn = extractOAuthFromFragment(source);
  const initAuthUI = extractBraced(source, "function initAuthUI");
  const setAuthUI = extractBraced(source, "function setAuthUI");
  const boot = extractPlayerBoot(source);
  const translate = extractLine(source, "const t = ");
  const key = /const OAUTH_STATE_KEY = "[^"]+";/.exec(source)?.[0];
  if (!key) throw new Error("tools/web/player.js has no OAUTH_STATE_KEY");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>oauth state harness</title></head>
<body>
<script>
${key}
${fn}
${translate}
${initAuthUI}
${setAuthUI}
${boot}

const AUTH_TICKET_KEY = "pocket-rpgkit:wander-online:ticket";
let assetLoads = [];
let assetMode = "stop";
let bundleSource = "";
let authCommands = [];
function fetchOk(url, label) {
  assetLoads.push({
    label,
    hash: location.hash,
    web: globalThis.__pocketWeb === true,
    auth: globalThis.__pocketAuth === undefined ? null : Object.assign({}, globalThis.__pocketAuth),
  });
  if (assetMode === "stop") return Promise.reject(new Error("asset probe stop"));
  return Promise.resolve({
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => bundleSource,
  });
}
const createWasmUi = async () => ({ ops: {} });
const createSocketHost = () => ({ reset() {}, ns: {} });
const createBrowserAutosaveBridge = () => ({});
const rpgkitBootFromSearch = () => ({});
const createTouchHitFacts = () => () => [];
let socketHost = null;

const resetBoot = (hash, saved) => {
  if (hash) location.hash = hash;
  else history.replaceState(null, "", location.pathname + location.search);
  if (saved === null) sessionStorage.removeItem(OAUTH_STATE_KEY);
  else sessionStorage.setItem(OAUTH_STATE_KEY, saved);
  delete globalThis.__pocketAuth;
  delete globalThis.__pocketWeb;
  delete globalThis.__pocketAuthEvent;
  delete globalThis.__pocketAuthCommand;
  delete globalThis.__pocketI18n;
  delete globalThis.__bundleSawPocketWeb;
  delete globalThis.__bundleSawTicket;
  assetLoads = [];
  authCommands = [];
};
const useLanguage = (language) => {
  if (language !== "zh") return;
  const strings = {
    "auth.signin": "使用 GitHub 登录",
    "auth.signed-in": "已登录：{name}",
    "auth.signed-out": "退出登录",
  };
  globalThis.__pocketI18n = (key) => strings[key] ?? key;
};
const authSnapshot = () => {
  const signIn = document.getElementById("auth-signin");
  const signOut = document.getElementById("auth-signout");
  return {
    text: signIn?.textContent ?? null,
    disabled: signIn?.disabled ?? null,
    signOutText: signOut?.textContent ?? null,
    signOutHidden: signOut?.hidden ?? null,
    ticket: localStorage.getItem(AUTH_TICKET_KEY),
    commands: authCommands.slice(),
  };
};
const installGameAuth = (login, ticket) => {
  globalThis.__pocketAuthCommand = (command) => {
    authCommands.push(command);
    if (command !== "signout") return;
    // This is the real game/page contract: OnlineView's signOut clears the
    // auth-store ticket, then reports the same logout event used in-game.
    localStorage.removeItem(AUTH_TICKET_KEY);
    globalThis.__pocketAuthEvent?.({ type: "logout" });
  };
  if (login !== null) globalThis.__pocketAuthEvent?.({ type: "login", login });
  globalThis.frame = () => {};
};
const bootReceiver = (config) => ({
  config,
  width: 1,
  height: 1,
  companions: new Set(),
  svc: [],
  audio: { reset() {}, ns: {} },
  editorHost: null,
  fit() {},
  onServiceLine() {},
  step() {},
  paint() {},
  setState() {},
  resume() {},
  focus() {},
});

window.__oauthReady = true;
window.setSaved = (value) => {
  if (value === null) sessionStorage.removeItem(OAUTH_STATE_KEY);
  else sessionStorage.setItem(OAUTH_STATE_KEY, value);
};
window.runOAuth = (hash) => {
  location.hash = hash;
  const result = oauthFromFragment();
  let saved = null;
  try { saved = sessionStorage.getItem(OAUTH_STATE_KEY); } catch (e) { saved = null; }
  return {
    result: result === null ? null : Object.assign({}, result),
    hash: location.hash,
    saved,
  };
};
window.runBootProbe = async (hash, saved) => {
  resetBoot(hash, saved);
  assetMode = "stop";
  try {
    await boot.call(bootReceiver({ wasm: "core.wasm", pak: "game.pak", bundle: "game.js" }));
  } catch (error) {
    if (error.message !== "asset probe stop") throw error;
  }
  return {
    hash: location.hash,
    web: globalThis.__pocketWeb === true,
    auth: globalThis.__pocketAuth === undefined ? null : Object.assign({}, globalThis.__pocketAuth),
    loads: assetLoads,
  };
};
window.runOrdinaryPageBoot = async (login, language = "en") => {
  resetBoot("", null);
  useLanguage(language);
  document.body.innerHTML = '<div class="bar"><span class="audio-controls"></span></div>';
  assetMode = "complete";
  localStorage.setItem(AUTH_TICKET_KEY, JSON.stringify({ ticket: "web-ticket" }));
  bundleSource = "globalThis.__bundleSawPocketWeb = globalThis.__pocketWeb === true;\\n"
    + "installGameAuth(" + JSON.stringify(login) + ", 'web-ticket');";
  await boot.call(bootReceiver({
    wasm: "core.wasm",
    pak: "game.pak",
    bundle: "game.js",
    app: "oauth-test",
    auth: { github: { clientId: "client", worker: "https://auth.invalid" } },
  }));
  return {
    web: globalThis.__pocketWeb === true,
    bundleSawWeb: globalThis.__bundleSawPocketWeb === true,
    auth: globalThis.__pocketAuth === undefined ? null : Object.assign({}, globalThis.__pocketAuth),
    ...authSnapshot(),
  };
};
window.clickSignOut = () => {
  document.getElementById("auth-signout")?.click();
  return authSnapshot();
};
window.runRefreshProbe = async (language = "en") => {
  resetBoot("", null);
  useLanguage(language);
  document.body.innerHTML = '<div class="bar"><span class="audio-controls"></span></div>';
  assetMode = "complete";
  bundleSource = "globalThis.__bundleSawTicket = localStorage.getItem(" + JSON.stringify(AUTH_TICKET_KEY) + ") !== null;\\n"
    + "installGameAuth(globalThis.__bundleSawTicket ? 'stored-user' : null, 'web-ticket');";
  await boot.call(bootReceiver({
    wasm: "core.wasm",
    pak: "game.pak",
    bundle: "game.js",
    app: "oauth-test",
    auth: { github: { clientId: "client", worker: "https://auth.invalid" } },
  }));
  return { bundleSawTicket: globalThis.__bundleSawTicket === true, ...authSnapshot() };
};
window.publishLoginAgain = (login) => {
  localStorage.setItem(AUTH_TICKET_KEY, JSON.stringify({ ticket: "new-ticket" }));
  globalThis.__pocketAuthEvent?.({ type: "login", login });
  return authSnapshot();
};
</script>
</body>
</html>`;
}

interface OAuthRun {
  result: { token?: string; error?: string } | null;
  hash: string;
  saved: string | null;
}

interface BootProbe {
  hash: string;
  web: boolean;
  auth: Record<string, string> | null;
  loads: Array<{ label: string; hash: string; web: boolean; auth: Record<string, string> | null }>;
}

interface AuthSnapshot {
  text: string | null;
  disabled: boolean | null;
  signOutText: string | null;
  signOutHidden: boolean | null;
  ticket: string | null;
  commands: string[];
}

interface PageBoot extends AuthSnapshot {
  web: boolean;
  bundleSawWeb: boolean;
  auth: Record<string, string> | null;
}

interface RefreshProbe extends AuthSnapshot {
  bundleSawTicket: boolean;
}

describe.skipIf(!existsSync(CHROME))("web OAuth state (fail-closed)", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let profile = "";
  let cdp: Cdp | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    if (!cdp) throw new Error("cdp not connected");
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
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
    profile = mkdtempSync(join(tmpdir(), "pocket-rpgkit-oauth-state-"));
    const chrome = await launchChrome(CHROME, profile, "800,600");
    proc = chrome.proc;
    cdp = await Cdp.connect(chrome.ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    const exceptions: string[] = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      const detail = event.exceptionDetails;
      const message = detail?.exception?.description ?? detail?.text ?? "unknown page error";
      exceptions.push(`${message} (line ${detail?.lineNumber ?? "?"}, column ${detail?.columnNumber ?? "?"})`);
    });
    const loaded = new Promise((resolve) => cdp!.on("Page.loadEventFired", resolve));
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await loaded;
    if (!await evaluate<boolean>("window.__oauthReady === true")) {
      const excerpt = await evaluate<string>(
        `document.querySelector("script").textContent.split("\\n").slice(55, 65).map((line, i) => (i + 56) + ": " + line).join("\\n")`,
      );
      throw new Error(`OAuth harness did not initialize: ${exceptions.join("\n") || "no page exception reported"}\n${excerpt}`);
    }
  });

  afterAll(() => {
    cdp?.close();
    proc?.kill();
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  const runOAuth = (hash: string) => evaluate<OAuthRun>(`window.runOAuth(${JSON.stringify(hash)})`);
  const setSaved = (value: string | null) =>
    evaluate(`window.setSaved(${value === null ? "null" : JSON.stringify(value)})`);

  test("ordinary web boot publishes its platform marker and receives the signed-in label", async () => {
    const r = await evaluate<PageBoot>(`window.runOrdinaryPageBoot("octocat")`);
    expect(r.web).toBe(true);
    expect(r.bundleSawWeb).toBe(true);
    expect(r.auth).toBeNull();
    expect(r.text).toBe("Signed in as octocat");
    expect(r.disabled).toBe(true);
    expect(r.signOutText).toBe("Sign out");
    expect(r.signOutHidden).toBe(false);
  }, 20_000);

  test("sign out clears the ticket, survives a fresh boot, and allows a later login", async () => {
    await evaluate<PageBoot>(`window.runOrdinaryPageBoot("octocat")`);

    const signedOut = await evaluate<AuthSnapshot>(`window.clickSignOut()`);
    expect(signedOut.commands).toEqual(["signout"]);
    expect(signedOut.ticket).toBeNull();
    expect(signedOut.text).toBe("Sign in with GitHub");
    expect(signedOut.disabled).toBe(false);
    expect(signedOut.signOutHidden).toBe(true);

    const refreshed = await evaluate<RefreshProbe>(`window.runRefreshProbe()`);
    expect(refreshed.bundleSawTicket).toBe(false);
    expect(refreshed.text).toBe("Sign in with GitHub");
    expect(refreshed.signOutHidden).toBe(true);

    const signedInAgain = await evaluate<AuthSnapshot>(`window.publishLoginAgain("octo-again")`);
    expect(signedInAgain.text).toBe("Signed in as octo-again");
    expect(signedInAgain.disabled).toBe(true);
    expect(signedInAgain.signOutText).toBe("Sign out");
    expect(signedInAgain.signOutHidden).toBe(false);
  }, 20_000);

  test("the login-only sign-out control follows the Chinese page language", async () => {
    const signedIn = await evaluate<PageBoot>(`window.runOrdinaryPageBoot("章鱼猫", "zh")`);
    expect(signedIn.text).toBe("已登录：章鱼猫");
    expect(signedIn.signOutText).toBe("退出登录");
    expect(signedIn.signOutHidden).toBe(false);

    const signedOut = await evaluate<AuthSnapshot>(`window.clickSignOut()`);
    expect(signedOut.text).toBe("使用 GitHub 登录");
    expect(signedOut.signOutHidden).toBe(true);
  }, 20_000);

  test("boot clears the callback and publishes its token before starting wasm, pak or bundle loads", async () => {
    const r = await evaluate<BootProbe>(`window.runBootProbe("#oauth_token=early&state=boot", "boot")`);
    expect(r.hash).toBe("");
    expect(r.web).toBe(true);
    expect(r.auth).toEqual({ token: "early" });
    expect(r.loads.map((load) => load.label)).toEqual([
      "The PocketJS core",
      "The asset pack",
      "The game bundle",
    ]);
    expect(r.loads.every((load) => load.hash === "")).toBe(true);
    expect(r.loads.every((load) => load.web)).toBe(true);
    expect(r.loads.every((load) => load.auth?.token === "early")).toBe(true);
  }, 20_000);

  test("happy path: matching state returns the token, clears the fragment and consumes the state", async () => {
    await setSaved("st");
    const r = await runOAuth("#oauth_token=tok&state=st");
    expect(r.result).toEqual({ token: "tok" });
    expect(r.hash).toBe("");
    expect(r.saved).toBeNull();
  }, 20_000);

  test("replay: the same fragment again is rejected, fragment cleared, no saved state", async () => {
    // The previous test consumed the saved state; run the identical fragment
    // again immediately, exactly as a replay attack would.
    const r = await runOAuth("#oauth_token=tok&state=st");
    expect(r.result).toEqual({ error: "state-mismatch" });
    expect(r.hash).toBe("");
    expect(r.saved).toBeNull();
  }, 20_000);

  test("no saved state: a callback with no stored state is rejected", async () => {
    await setSaved(null);
    const r = await runOAuth("#oauth_token=tok2&state=attacker");
    expect(r.result).toEqual({ error: "state-mismatch" });
    expect(r.hash).toBe("");
    expect(r.saved).toBeNull();
  }, 20_000);

  test("wrong state: mismatch is rejected, fragment cleared, saved state kept", async () => {
    await setSaved("expected");
    const r = await runOAuth("#oauth_token=tok3&state=wrong");
    expect(r.result).toEqual({ error: "state-mismatch" });
    expect(r.hash).toBe("");
    expect(r.saved).toBe("expected");
  }, 20_000);

  test("missing token: a fragment without oauth_token is rejected and does not consume the state", async () => {
    await setSaved("st");
    const r = await runOAuth("#state=st");
    expect(r.result).toEqual({ error: "invalid-fragment" });
    expect(r.hash).toBe("");
    expect(r.saved).toBe("st");
  }, 20_000);
});
