// tests/web-name-input.test.ts — drives the REAL initAuthUI()/setAuthUI()
// from tools/web/player.js in headless Chrome (through the kit's own CDP
// harness, tools/lib/cdp.ts) and proves the page's character-name text box
// contract with the game:
//
//   no auth     a page whose config declares no auth gets no box at all
//   hidden      the box exists but stays hidden until a nameInput event
//   nameInput   shows the box with the prefilled value and maxlength, moves
//               focus into it, and later nameInput events keep what the
//               player typed
//   submit      Enter (a real browser key event after real inserted text)
//               and the Create button send ("name", text) with the trimmed
//               Chinese text; an empty box submits nothing
//   composing   Enter during an IME composition (isComposing / keyCode 229)
//               does not submit
//   error       the game's refusal text shows beside the box and clears when
//               a later nameInput carries no error
//   close       nameInputEnd and logout hide and clear the box
//   isolation   key events typed into the box never bubble past it
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
import { Cdp, launchChrome } from "../tools/lib/cdp.ts";

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

function harnessPage(): string {
  const source = readFileSync(PLAYER_JS, "utf8");
  const initAuthUI = extractBraced(source, "function initAuthUI");
  const setAuthUI = extractBraced(source, "function setAuthUI");
  const translate = extractLine(source, "const t = ");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>name input harness</title></head>
<body>
<script>
${translate}
${initAuthUI}
${setAuthUI}

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
      "auth.name-placeholder": "Type a name (letters, digits, space, _ . - or common Chinese)",
    },
    zh: {
      "auth.signin": "使用 GitHub 登录",
      "auth.signed-in": "已登录：{name}",
      "auth.signed-out": "退出登录",
      "auth.name-label": "角色名",
      "auth.name-submit": "创建",
      "auth.name-placeholder": "输入名字（字母、数字、空格、_ . - 或常用汉字）",
    },
  };
  const strings = dictionaries[language] ?? dictionaries.en;
  globalThis.__pocketI18n = (key) => strings[key] ?? key;
};
// Anything above the box that could see its keystrokes: the document and
// window listen in both phases and record what arrives from the box.
for (const type of ["keydown", "keyup", "keypress"]) {
  document.addEventListener(type, (event) => {
    if (event.target && event.target.id === "auth-name") leaked.push("document:" + type);
  });
  window.addEventListener(type, (event) => {
    if (event.target && event.target.id === "auth-name") leaked.push("window:" + type);
  });
}
const snapshot = () => {
  const box = document.getElementById("auth-name-box");
  const input = document.getElementById("auth-name");
  const submit = document.getElementById("auth-name-submit");
  const error = document.getElementById("auth-name-error");
  const label = box ? box.querySelector("label") : null;
  const signIn = document.getElementById("auth-signin");
  const signOut = document.getElementById("auth-signout");
  return {
    present: box !== null,
    hidden: box ? box.hidden : null,
    value: input ? input.value : null,
    maxLength: input ? input.getAttribute("maxlength") : null,
    placeholder: input ? input.placeholder : null,
    focused: input !== null && document.activeElement === input,
    labelText: label ? label.textContent : null,
    labelFor: label ? label.htmlFor : null,
    submitText: submit ? submit.textContent : null,
    submitClass: submit ? submit.className : null,
    errorText: error ? error.textContent : null,
    errorHidden: error ? error.hidden : null,
    signInText: signIn ? signIn.textContent : null,
    signOutHidden: signOut ? signOut.hidden : null,
    commands: commands.slice(),
    leaked: leaked.slice(),
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
window.typeValue = (value) => {
  const input = document.getElementById("auth-name");
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return snapshot();
};
window.pressEnter = (init = {}) => {
  const input = document.getElementById("auth-name");
  const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, ...init }));
  return snapshot();
};
window.pressKey = (key) => {
  const input = document.getElementById("auth-name");
  input.dispatchEvent(new KeyboardEvent("keydown", { key, code: "Key" + key.toUpperCase(), bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key, code: "Key" + key.toUpperCase(), bubbles: true }));
  return snapshot();
};
window.clickCreate = () => {
  document.getElementById("auth-name-submit").click();
  return snapshot();
};
window.switchLanguage = (language) => {
  useLanguage(language);
  globalThis.__pocketPageLanguageEvent?.(language);
  return snapshot();
};
window.snapshot = snapshot;
window.__nameReady = true;
</script>
</body>
</html>`;
}

interface Snapshot {
  present: boolean;
  hidden: boolean | null;
  value: string | null;
  maxLength: string | null;
  placeholder: string | null;
  focused: boolean;
  labelText: string | null;
  labelFor: string | null;
  submitText: string | null;
  submitClass: string | null;
  errorText: string | null;
  errorHidden: boolean | null;
  signInText: string | null;
  signOutHidden: boolean | null;
  commands: string[][];
  leaked: string[];
  barChildren: string[];
}

const OPEN = { type: "nameInput", title: "Name your character", maxLength: 12, value: "", error: "" };

describe.skipIf(!existsSync(CHROME))("web page character-name box", () => {
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
  const setup = (withAuth: boolean, language = "en") => evaluate<Snapshot>(`window.setup(${withAuth}, ${JSON.stringify(language)})`);
  const gameEvent = (ev: Record<string, unknown>) => evaluate<Snapshot>(`window.gameEvent(${JSON.stringify(ev)})`);
  const snapshot = () => evaluate<Snapshot>("window.snapshot()");

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
    profile = mkdtempSync(join(tmpdir(), "pocket-rpgkit-name-input-"));
    const chrome = await launchChrome(CHROME, profile, "800,600");
    proc = chrome.proc;
    cdp = await Cdp.connect(chrome.ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    const exceptions: string[] = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      const detail = event.exceptionDetails;
      exceptions.push(detail?.exception?.description ?? detail?.text ?? "unknown page error");
    });
    const loaded = new Promise((resolve) => cdp!.on("Page.loadEventFired", resolve));
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await loaded;
    if (!await evaluate<boolean>("window.__nameReady === true")) {
      throw new Error(`name input harness did not initialize: ${exceptions.join("\n") || "no page exception reported"}`);
    }
  });

  afterAll(() => {
    cdp?.close();
    proc?.kill();
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  test("a page without auth gets no name box, and a page with auth keeps it hidden until nameInput", async () => {
    const plain = await setup(false);
    expect(plain.present).toBe(false);
    expect(plain.barChildren).toEqual(["audio-controls"]);

    const withAuth = await setup(true);
    expect(withAuth.present).toBe(true);
    expect(withAuth.hidden).toBe(true);
    expect(withAuth.barChildren).toEqual(["auth-signin", "auth-signout", "auth-name-box", "audio-controls"]);
    expect(withAuth.labelFor).toBe("auth-name");
    expect(withAuth.submitClass).toBe("bar-button");
    expect(withAuth.commands).toEqual([]);
  }, 20_000);

  test("nameInput shows the box with the prefilled value and maxlength, focuses it, and never clobbers typed text", async () => {
    await setup(true);
    const shown = await gameEvent({ ...OPEN, value: "旅人" });
    expect(shown.hidden).toBe(false);
    expect(shown.value).toBe("旅人");
    expect(shown.maxLength).toBe("12");
    expect(shown.focused).toBe(true);
    expect(shown.errorHidden).toBe(true);

    await evaluate(`window.typeValue("旅人甲")`);
    const again = await gameEvent({ ...OPEN, value: "something else", maxLength: 8 });
    expect(again.value).toBe("旅人甲");
    expect(again.maxLength).toBe("8");
    expect(again.hidden).toBe(false);
  }, 20_000);

  test("a real Enter after real inserted text submits the trimmed Chinese name; Create submits too; empty submits nothing", async () => {
    const opened = await setup(true).then(() => gameEvent(OPEN));
    expect(opened.focused).toBe(true);

    // The browser's own text insertion and key dispatch, into whatever has
    // focus: proves the box is focusable and receives the keyboard.
    await cdp!.send("Input.insertText", { text: " 章鱼猫 " });
    await cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    const entered = await snapshot();
    expect(entered.value).toBe(" 章鱼猫 ");
    expect(entered.commands).toEqual([["name", "章鱼猫"]]);
    expect(entered.hidden).toBe(false);

    const clicked = await evaluate<Snapshot>("window.clickCreate()");
    expect(clicked.commands).toEqual([["name", "章鱼猫"], ["name", "章鱼猫"]]);

    await evaluate(`window.typeValue("   ")`);
    const blank = await evaluate<Snapshot>("window.pressEnter()");
    expect(blank.commands).toEqual([["name", "章鱼猫"], ["name", "章鱼猫"]]);
    const blankClick = await evaluate<Snapshot>("window.clickCreate()");
    expect(blankClick.commands).toEqual([["name", "章鱼猫"], ["name", "章鱼猫"]]);
  }, 20_000);

  test("Enter during an IME composition does not submit", async () => {
    await setup(true);
    await gameEvent(OPEN);
    await evaluate(`window.typeValue("章鱼")`);
    const composing = await evaluate<Snapshot>("window.pressEnter({ isComposing: true })");
    expect(composing.commands).toEqual([]);
    const legacy = await evaluate<Snapshot>("window.pressEnter({ keyCode: 229 })");
    expect(legacy.commands).toEqual([]);
    const committed = await evaluate<Snapshot>("window.pressEnter()");
    expect(committed.commands).toEqual([["name", "章鱼"]]);
  }, 20_000);

  test("the game's refusal text appears beside the box and clears on the next nameInput", async () => {
    await setup(true);
    await gameEvent(OPEN);
    await evaluate(`window.typeValue("bad name!")`);
    const refused = await gameEvent({ ...OPEN, value: "", error: "That name is not allowed" });
    expect(refused.errorText).toBe("That name is not allowed");
    expect(refused.errorHidden).toBe(false);
    expect(refused.value).toBe("bad name!");
    expect(refused.hidden).toBe(false);

    const cleared = await gameEvent({ ...OPEN });
    expect(cleared.errorText).toBe("");
    expect(cleared.errorHidden).toBe(true);
    expect(cleared.value).toBe("bad name!");
  }, 20_000);

  test("nameInputEnd hides and clears the box, and a later nameInput prefills again", async () => {
    await setup(true);
    await gameEvent({ ...OPEN, value: "旅人" });
    await evaluate(`window.typeValue("旅人乙")`);
    await gameEvent({ ...OPEN, error: "refused" });
    const closed = await gameEvent({ type: "nameInputEnd" });
    expect(closed.hidden).toBe(true);
    expect(closed.value).toBe("");
    expect(closed.errorText).toBe("");
    expect(closed.errorHidden).toBe(true);

    const reopened = await gameEvent({ ...OPEN, value: "新角色" });
    expect(reopened.hidden).toBe(false);
    expect(reopened.value).toBe("新角色");
  }, 20_000);

  test("logout hides the box while the sign-in controls keep working, and nameInput leaves login state alone", async () => {
    await setup(true);
    const signedIn = await gameEvent({ type: "login", login: "octocat" });
    expect(signedIn.signInText).toBe("Signed in as octocat");
    expect(signedIn.signOutHidden).toBe(false);

    const opened = await gameEvent({ ...OPEN, value: "旅人" });
    expect(opened.hidden).toBe(false);
    expect(opened.signInText).toBe("Signed in as octocat");
    expect(opened.signOutHidden).toBe(false);

    const loggedOut = await gameEvent({ type: "logout" });
    expect(loggedOut.hidden).toBe(true);
    expect(loggedOut.value).toBe("");
    expect(loggedOut.signInText).toBe("Sign in with GitHub");
    expect(loggedOut.signOutHidden).toBe(true);
  }, 20_000);

  test("keystrokes typed into the box never leave it", async () => {
    await setup(true);
    await gameEvent(OPEN);
    await evaluate(`window.pressKey("a")`);
    await evaluate(`window.pressKey("z")`);
    const typed = await evaluate<Snapshot>("window.pressEnter()");
    expect(typed.leaked).toEqual([]);
  }, 20_000);

  test("labels follow the page language on __pocketPageLanguageEvent", async () => {
    const english = await setup(true, "en");
    expect(english.labelText).toBe("Character name");
    expect(english.submitText).toBe("Create");
    expect(english.placeholder).toBe("Type a name (letters, digits, space, _ . - or common Chinese)");

    const chinese = await evaluate<Snapshot>(`window.switchLanguage("zh")`);
    expect(chinese.labelText).toBe("角色名");
    expect(chinese.submitText).toBe("创建");
    expect(chinese.placeholder).toBe("输入名字（字母、数字、空格、_ . - 或常用汉字）");

    const opened = await gameEvent(OPEN);
    expect(opened.labelText).toBe("角色名");
    const back = await evaluate<Snapshot>(`window.switchLanguage("en")`);
    expect(back.labelText).toBe("Character name");
    expect(back.submitText).toBe("Create");
    expect(back.hidden).toBe(false);
  }, 20_000);
});
