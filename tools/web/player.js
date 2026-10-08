// tools/web/player.js — runs one PocketJS app bundle on a player page.
//
// tools/web.ts bundles this file, together with the vendored wasm binding
// (hosts/web/wasm-ops.js) and the touch wire helpers
// (framework/src/touch.ts), into dist/web/player.js. A player page keeps
// its settings as JSON in <script id="pocket-game">. Every URL in it is
// relative to the page, so the site also works under a subpath such as
// /pocket-rpgkit/.
//
// The loop is PocketJS's browser dev host (hosts/web/engine.js), cut down
// to one fixed app:
//   boot     createWasmUi(viewport, density). globalThis.ui is the core's
//            HostOps and globalThis.__pak is the pak; the bundle is
//            evaluated in a fresh function scope and installs
//            globalThis.frame.
//   clock    fixed 60 Hz steps on requestAnimationFrame. Elapsed time is
//            clamped to 250 ms and one animation frame runs at most 4 steps.
//   step     frame(buttons, analog, touches, hits), then one core tick. The
//            canvas is repainted once per animation frame that stepped.
// Sizing: fit.ts picks the logical viewport and a whole number of device
// pixels per game pixel that is divisible by rasterDensity. The canvas owns
// density physical samples per logical pixel, so neither high-density text
// nor nearest-neighbour pixel art lands between device pixels. A fixed
// viewport keeps its size; a dynamic one follows the page. A new logical
// size goes to the core first, then to the app's resize hook, as the desktop
// host and hosts/sim do.
// Input:
//   keys     the page's key table (keys.ts KEYMAP plus the game's changes)
//            -> the held button mask, while the game screen has focus. It
//            takes focus on load and when clicked. The editor companion also
//            receives key/ch/paste lines matching the desktop host.
//   mouse    service lines {t:"mouse",x,y,d[,b],sh} read through
//            ui.svcPoll, the form the desktop host and
//            hosts/web/system-engine.js send. ui.svcOpen(name) is true for
//            the plan's companions.
//   touch    per-frame touch contacts (frame arguments 3 and 4, with hit
//            facts), as site/playground/embed.js sends them. The primary
//            touch also sends mouse lines, the way a browser derives
//            compatibility mouse events from it, so an app that only reads
//            the mouse (Alpine Post's click-to-walk) answers a tap.
//   pad      the on-screen buttons, for devices without a keyboard.
// Embedding: ?embed hides everything but the game screen and fits it to
// the window, for a page that frames the player in an iframe.
//   files    an editor page handles load/save over the companion: Open and
//            bundled inline projects send load lines; self-contained sharded
//            packs send a shell catalog and answer map reads lazily. SAVE
//            persists to localStorage; Download asks the guest for a fresh,
//            schema-checked inline document or replacement pack.

import { createWasmUi } from "../../vendor/pocketjs/hosts/web/wasm-ops.js";
import { createAudioHost } from "../../vendor/pocketjs/hosts/web/audio.js";
import { createSocketHost } from "../../vendor/pocketjs/hosts/web/socket.js";
import {
  __packTouch,
  __packTouchWide,
  createTouchHitFacts,
} from "../../vendor/pocketjs/framework/src/touch.ts";
import { rpgkitBootFromSearch, withDemoQuery } from "./boot.ts";
import { fitViewport } from "./fit.ts";
import { BTN } from "./keys.ts";
import { createMasterAudioHost } from "./audio-control.ts";
// The pack format (kind tag, entry-key rule, envelope check, byte spelling)
// is shared with the TypeScript edit API; this file only adds plain Errors.
import {
  PNG_HEADER_BYTES,
  packAssetBytesProblem,
  packAssetCountProblem,
  pngProblem,
} from "../../editor/api/limits.ts";
import {
  base64DecodedBound,
  decodeBase64,
  packEntryProblem,
  packText,
  readPackEnvelope,
  SHARDED_PACK_KIND,
} from "../../editor/api/pack-format.ts";

const STEP_MS = 1000 / 60;
const MAX_ELAPSED_MS = 250;
const MAX_CATCH_UP = 4;
/** spec ANALOG_CENTER on both axes: no nub on this host. */
const ANALOG_CENTER = 0x8080;
/** framework/src/touch.ts caps a frame at 8 live contacts. */
const MAX_CONTACTS = 8;
/** The wide touch wire form carries 10 bits per axis. */
const TOUCH_LIMIT = 1024;
/** Mouse lines kept for an app that does not poll every frame. */
const SVC_LIMIT = 256;
/** localStorage key for the landscape "hide buttons" choice. */
const PAD_HIDDEN_KEY = "pocket-rpgkit:web:pad-hidden";
/** Companion requests normally answer in the next frame; recover the toolbar
 * after five seconds if a broken guest consumes one without replying. */
const EDITOR_REQUEST_TIMEOUT = 300;
/** Room under the screen for the caption line. */
const RESERVE_PX = 56;

let socketHost = null; // hosts/web/socket.js — browser WebSocket behind the SOCKET contract
const EDITOR_COMPANION = "rpgkit-editor";
export { SHARDED_PACK_KIND };
export const EDITOR_CHUNK_MAX_COUNT = 8192;
export const EDITOR_CHUNK_MAX_CODE_UNITS = 1024;
export const EDITOR_TRANSFER_MAX_CODE_UNITS = 8 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A deliberately tiny storage capability exposed to game bundles. The
 * browser owns the app-scoped key; guests can only replace/read one
 * autosave envelope and never receive the general localStorage object. */
export function createBrowserAutosaveBridge(storageKey, storage) {
  const target = () => {
    const value = storage ?? globalThis.localStorage;
    if (!value) throw new Error("localStorage is unavailable");
    return value;
  };
  const failed = (operation, error) => {
    globalThis.console?.debug?.(`pocket-rpgkit: browser autosave ${operation} failed`, error);
  };
  return {
    read() {
      try {
        return target().getItem(storageKey);
      } catch (error) {
        failed("read", error);
        return null;
      }
    },
    write(envelope) {
      try {
        target().setItem(storageKey, envelope);
        return true;
      } catch (error) {
        failed("write", error);
        return false;
      }
    },
  };
}

/** Browser KeyboardEvent.key -> the desktop companion's named-key dialect. */
const NAMED_KEYS = {
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Escape: "Escape",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};

const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`player page has no #${id}`);
  return element;
};

// Player-page chrome strings follow the page language when the page declares
// languages (tools/web.ts embeds the switcher, which defines __pocketI18n);
// the English fallback keeps pages without a switcher unchanged.
const t = (key, fallback) => (typeof globalThis.__pocketI18n === "function" ? globalThis.__pocketI18n(key) : fallback);

// --- GitHub OAuth (games that declare auth in web.json) --------------------
// The lfkdsk-auth worker redirects back to this page with the token in the
// fragment: /#oauth_token=...&state=... . We validate the state, strip the
// fragment immediately (the token never enters history/sentry/analytics) and
// hand the token to the game once, via globalThis.__pocketAuth. The page
// itself never persists the GitHub token.
//
// State validation fails closed: a token is accepted only when a state saved
// by startGithubSignIn exists and matches the callback's state exactly. No
// saved state (sessionStorage unavailable, or a replay after the one-time
// state was consumed) rejects the callback; the check is never skipped. On a
// successful match the saved state is deleted, so a replayed fragment cannot
// be accepted twice. A mismatched callback keeps the saved state (a later
// legitimate callback with the right state still works) but is rejected all
// the same; every rejection clears the fragment.
const OAUTH_STATE_KEY = "pocket-rpgkit:oauth-state";

function oauthFromFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("oauth_token");
  const state = params.get("state");
  const error = params.get("oauth_error");
  // Only fragments that look like an OAuth callback (token, error or state
  // parameter) are ours; leave every other fragment untouched.
  if (!token && !error && !state) return null;
  // Strip the fragment right away, before anything else can read it.
  history.replaceState(null, "", location.pathname + location.search);
  if (error) return { error };
  if (!token || !state) return { error: "invalid-fragment" };
  let saved = null;
  try {
    saved = sessionStorage.getItem(OAUTH_STATE_KEY);
  } catch {
    // sessionStorage unavailable: the state cannot be validated, so the
    // callback is rejected below rather than accepted on trust.
  }
  if (saved !== state) return { error: "state-mismatch" };
  try {
    sessionStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    // ignore
  }
  return { token };
}

function startGithubSignIn(auth) {
  const state = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  try {
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
  } catch {
    // private mode: the redirect still happens, but the callback's state
    // cannot be stored or validated, so oauthFromFragment rejects it
    // (fail closed) rather than skipping the check.
  }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", auth.github.clientId);
  url.searchParams.set("redirect_uri", `${auth.github.worker}/callback`);
  url.searchParams.set("scope", "");
  url.searchParams.set("state", state);
  location.href = url.toString();
}

// Wire sign-in status and sign-out into the control bar, if the game declares
// auth. The game remains the source of truth: the page sends a command, then
// waits for the same login/logout event hook used by in-game sign-out. That
// command also owns credential cleanup (wander-online removes its web ticket
// through auth-store), so the page never needs to know a game's storage key.
function initAuthUI(config) {
  const auth = config.auth;
  if (!auth?.github) return;
  const bar = document.querySelector(".bar");
  if (!bar) return;
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.id = "auth-signin";
  signIn.className = "bar-button";
  signIn.addEventListener("click", () => startGithubSignIn(auth));
  const signOut = document.createElement("button");
  signOut.type = "button";
  signOut.id = "auth-signout";
  signOut.className = "bar-button";
  signOut.addEventListener("click", () => globalThis.__pocketAuthCommand?.("signout"));
  setAuthUI(signIn, signOut, null);
  const audio = bar.querySelector(".audio-controls");
  bar.insertBefore(signIn, audio);
  bar.insertBefore(signOut, audio);
  // The game reports login/logout through this event hook.
  globalThis.__pocketAuthEvent = (ev) => {
    setAuthUI(signIn, signOut, ev.type === "login" ? ev.login : null);
  };
}

function setAuthUI(signIn, signOut, login) {
  signIn.textContent = login === null
    ? t("auth.signin", "Sign in with GitHub")
    : t("auth.signed-in", "Signed in as {name}").replace("{name}", login);
  signIn.disabled = login !== null;
  signOut.textContent = t("auth.signed-out", "Sign out");
  signOut.hidden = login === null;
}


/**
 * Pointer ids -> touch contacts. The guest reads a level snapshot every
 * frame, so the pool holds contacts rather than events and every step packs
 * the whole table (the shape of site/playground/embed.js). A release waits
 * until the contact has been sent at least once, so a tap shorter than one
 * step still reaches the app.
 */
class ContactPool {
  constructor() {
    this.slots = new Array(MAX_CONTACTS).fill(null);
    this.bySource = new Map();
    this.wide = false;
  }

  resize(width, height) {
    this.wide = width > 512 || height > 512;
  }

  down(pointerId, x, y) {
    if (this.bySource.has(pointerId)) return this.move(pointerId, x, y);
    const slot = this.slots.indexOf(null);
    if (slot < 0) return false;
    this.slots[slot] = { x, y, sent: 0, lifted: false };
    this.bySource.set(pointerId, slot);
    return true;
  }

  move(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false;
    const contact = this.slots[slot];
    if (contact.lifted) return false;
    contact.x = x;
    contact.y = y;
    return true;
  }

  up(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false;
    this.bySource.delete(pointerId);
    const contact = this.slots[slot];
    if (typeof x === "number") {
      contact.x = x;
      contact.y = y;
    }
    contact.lifted = true;
    return true;
  }

  clear() {
    this.slots.fill(null);
    this.bySource.clear();
  }

  pack() {
    const packed = [];
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (!contact) continue;
      const x = Math.min(contact.x, TOUCH_LIMIT - 1);
      const y = Math.min(contact.y, TOUCH_LIMIT - 1);
      packed.push(this.wide ? __packTouchWide(slot, x, y) : __packTouch(slot, x, y));
      contact.sent++;
    }
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (contact && contact.lifted && contact.sent > 0) this.slots[slot] = null;
    }
    return packed.length > 0 ? packed : undefined;
  }
}

async function fetchOk(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} could not be loaded (${response.status} ${url})`);
  return response;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Reassemble the guest's bounded transport envelopes into one logical JSON
 * message. A transfer is contiguous and strictly ordered; any malformed,
 * duplicate, interrupted, oversized, or mismatched stream is discarded in
 * full so a suffix can never be mistaken for a later message. */
export class BrowserMessageReassembler {
  constructor() {
    this.active = null;
  }

  push(message) {
    if (!record(message) || typeof message.t !== "string") {
      this.active = null;
      return null;
    }
    if (message.t === "chunk-start") {
      this.active = null;
      if (!requestId(message.transfer)
        || !Number.isSafeInteger(message.chunks)
        || message.chunks < 1
        || message.chunks > EDITOR_CHUNK_MAX_COUNT) return null;
      this.active = { transfer: message.transfer, chunks: message.chunks, parts: [], length: 0 };
      return null;
    }
    if (message.t === "chunk") {
      const active = this.active;
      if (!active
        || message.transfer !== active.transfer
        || !Number.isSafeInteger(message.index)
        || message.index !== active.parts.length
        || message.index >= active.chunks
        || typeof message.text !== "string"
        || message.text.length > EDITOR_CHUNK_MAX_CODE_UNITS
        || active.length + message.text.length > EDITOR_TRANSFER_MAX_CODE_UNITS) {
        this.active = null;
        return null;
      }
      active.parts.push(message.text);
      active.length += message.text.length;
      if (active.parts.length !== active.chunks) return null;
      this.active = null;
      try {
        const logical = JSON.parse(active.parts.join(""));
        return record(logical) && typeof logical.t === "string" ? logical : null;
      } catch {
        return null;
      }
    }
    // Logical messages cannot interleave a chunk stream.
    if (this.active) {
      this.active = null;
      return null;
    }
    this.active = null;
    return message;
  }
}

/** A map-index entry is an opaque POSIX-relative key, never a browser or OS
 * path. Rejecting traversal and alternate separators keeps imported packs
 * portable and makes keys such as "__proto__" harmless inside the Map. */
function packEntry(value) {
  const problem = packEntryProblem(value);
  if (problem !== null) throw new Error(problem);
  return value;
}

function parseShell(text) {
  if (typeof text !== "string") throw new Error("shell must be JSON text");
  let shell;
  try {
    shell = JSON.parse(text);
  } catch (error) {
    throw new Error(`shell is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!record(shell) || shell.format !== "rpgkit-project/v1" || !Array.isArray(shell.mapIndex)) {
    throw new Error("shell is not an rpgkit-project/v1 ProjectShell");
  }
  if (!SHA256_HEX.test(shell.mapManifestHash)) throw new Error("shell has no valid mapManifestHash");
  const catalog = new Map();
  for (const item of shell.mapIndex) {
    if (!record(item)) throw new Error("shell mapIndex contains a non-object entry");
    const entry = packEntry(item.entry);
    if (!SHA256_HEX.test(item.sha256)) throw new Error(`shell has an invalid checksum for ${JSON.stringify(entry)}`);
    if (catalog.has(entry)) throw new Error(`shell repeats shard entry ${JSON.stringify(entry)}`);
    catalog.set(entry, item);
  }
  if (catalog.size === 0) throw new Error("shell mapIndex is empty");
  return { shell, catalog };
}

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate embedded art by the edit API's pack limits while retaining the
 * accepted base64 spelling verbatim. BrowserProjectPack is a transport, but
 * accepting a pack here that Studio or rpgkit-edit refuses would make the
 * same file behave differently between the two browser editors. */
function browserPackAssets(supplied) {
  const assets = [];
  const paths = Object.keys(supplied ?? {});
  const countProblem = packAssetCountProblem(paths.length);
  if (countProblem !== null) throw new Error(countProblem);
  let total = 0;
  for (const path of paths) {
    packEntry(path);
    const asset = supplied[path];
    if (!record(asset)
      || asset.type !== "image/png"
      || typeof asset.data !== "string"
      || Object.keys(asset).some((key) => key !== "type" && key !== "data")) {
      throw new Error(`pack asset ${JSON.stringify(path)} is not a PNG entry with only type and data`);
    }
    const padding = asset.data.endsWith("==") ? 2 : asset.data.endsWith("=") ? 1 : 0;
    const bound = base64DecodedBound(asset.data.length) - padding;
    const sizeProblem = pngProblem(`asset ${JSON.stringify(path)}`, bound);
    if (sizeProblem !== null) throw new Error(sizeProblem);
    const bytes = decodeBase64(asset.data);
    if (bytes === null) throw new Error(`pack asset ${JSON.stringify(path)} is not valid base64`);
    total += bytes.length;
    const totalProblem = packAssetBytesProblem(total);
    if (totalProblem !== null) throw new Error(totalProblem);
    const imageProblem = pngProblem(`asset ${JSON.stringify(path)}`, bytes.length, bytes.subarray(0, PNG_HEADER_BYTES));
    if (imageProblem !== null) throw new Error(imageProblem);
    assets.push([path, { type: asset.type, data: asset.data }]);
  }
  return assets;
}

/** Self-contained browser transport for a ProjectShell and its shard bytes.
 * It deliberately keeps shard text in a private Map: projectMessage() sends
 * the shell/catalog only and read() releases one requested shard at a time. */
export class BrowserProjectPack {
  constructor(shellText, shards) {
    const parsed = parseShell(shellText);
    if (!(shards instanceof Map)) throw new Error("pack shards must be a Map");
    for (const [entry, text] of shards) {
      packEntry(entry);
      if (!parsed.catalog.has(entry)) throw new Error(`pack contains unindexed shard ${JSON.stringify(entry)}`);
      if (typeof text !== "string") throw new Error(`pack shard ${JSON.stringify(entry)} is not text`);
    }
    for (const entry of parsed.catalog.keys()) {
      if (!shards.has(entry)) throw new Error(`pack is missing shard ${JSON.stringify(entry)}`);
    }
    this.shellText = shellText;
    this.shell = parsed.shell;
    this.catalog = parsed.catalog;
    this.shards = new Map(shards);
    /** Images the pack carries (Studio's project art); kept as they came
     * so a re-exported pack still has them. */
    this.assets = [];
  }

  static parse(text) {
    const envelope = readPackEnvelope(text);
    if (envelope.problem !== null) throw new Error(envelope.message);
    const shards = new Map();
    for (const entry of Object.keys(envelope.shards)) {
      packEntry(entry);
      const shard = envelope.shards[entry];
      if (typeof shard !== "string") throw new Error(`pack shard ${JSON.stringify(entry)} is not text`);
      shards.set(entry, shard);
    }
    const pack = new BrowserProjectPack(envelope.shell, shards);
    pack.assets = browserPackAssets(envelope.assets);
    return pack;
  }

  projectMessage(request) {
    if (request !== undefined && !requestId(request)) throw new Error("project request must be a non-negative safe integer");
    return { t: "project", shell: this.shellText, ...(request === undefined ? {} : { request }) };
  }

  /** Answer a guest request without exposing the remaining pack payloads. */
  read(message) {
    if (!record(message) || message.t !== "map-read" || !requestId(message.request) || typeof message.entry !== "string") {
      return null;
    }
    let entry;
    try {
      entry = packEntry(message.entry);
    } catch (error) {
      return { t: "map-error", request: message.request, entry: message.entry, error: error instanceof Error ? error.message : String(error) };
    }
    const text = this.shards.get(entry);
    return text === undefined
      ? { t: "map-error", request: message.request, entry, error: `unknown shard entry ${JSON.stringify(entry)}` }
      : { t: "map-data", request: message.request, entry, text };
  }

  /** Validate a complete save request before changing any in-memory byte.
   * `expectedSha256` is the optimistic concurrency identity of the old shard;
   * the replacement text must match the checksum advertised by the new shell. */
  async save(message) {
    if (!record(message) || message.t !== "project-save" || !requestId(message.request)) {
      throw new Error("invalid project-save request");
    }
    if (!SHA256_HEX.test(message.baseManifestHash) || message.baseManifestHash !== this.shell.mapManifestHash) {
      throw new Error("project-save base manifest does not match the open pack");
    }
    if (!Array.isArray(message.shards)) throw new Error("project-save shards must be an array");
    const next = parseShell(message.shell);
    if (next.catalog.size !== this.catalog.size || [...this.catalog.keys()].some((entry) => !next.catalog.has(entry))) {
      throw new Error("project-save cannot add, remove, or rename shard entry keys");
    }

    const replacements = new Map();
    for (const item of message.shards) {
      if (!record(item) || typeof item.entry !== "string" || typeof item.text !== "string" || !SHA256_HEX.test(item.expectedSha256)) {
        throw new Error("project-save contains an invalid shard replacement");
      }
      const entry = packEntry(item.entry);
      if (replacements.has(entry)) throw new Error(`project-save repeats shard ${JSON.stringify(entry)}`);
      const oldMeta = this.catalog.get(entry);
      const newMeta = next.catalog.get(entry);
      if (!oldMeta || !newMeta) throw new Error(`project-save refers to unknown shard ${JSON.stringify(entry)}`);
      if (oldMeta.sha256 !== item.expectedSha256) throw new Error(`project-save found a stale shard ${JSON.stringify(entry)}`);
      if (await sha256Text(item.text) !== newMeta.sha256) {
        throw new Error(`project-save checksum does not match the new shell for ${JSON.stringify(entry)}`);
      }
      replacements.set(entry, item.text);
    }
    for (const [entry, oldMeta] of this.catalog) {
      if (!replacements.has(entry) && next.catalog.get(entry).sha256 !== oldMeta.sha256) {
        throw new Error(`project-save changed the checksum of unsupplied shard ${JSON.stringify(entry)}`);
      }
    }

    this.shellText = message.shell;
    this.shell = next.shell;
    this.catalog = next.catalog;
    for (const [entry, text] of replacements) this.shards.set(entry, text);
    return { request: message.request, entries: [...replacements.keys()] };
  }

  serialize() {
    return packText(this.shellText, [...this.catalog.keys()].map((entry) => [entry, this.shards.get(entry)]), this.assets);
  }
}

/** The file half of the browser rpgkit-editor companion. Input stays in the
 * Player so every host uses the same logical-coordinate conversion; this
 * object owns Open, built-ins, localStorage, SAVE and Download. */
export class BrowserEditorHost {
  constructor(player, config) {
    this.player = player;
    this.config = config;
    this.statusElement = $("editor-status");
    this.input = $("editor-open-input");
    this.controls = [$("editor-open"), $("editor-download"), ...document.querySelectorAll("[data-editor-example]")];
    this.ready = false;
    this.fetching = false;
    this.nextRequest = 1;
    this.pendingLoad = null;
    this.pendingDownload = null;
    this.currentName = "rpgkit-project.json";
    this.currentText = null;
    this.currentPack = null;
    this.projectSaving = false;
    this.guestMessages = new BrowserMessageReassembler();
    this.lastDownload = null;
    this.storageReadError = null;
  }

  bind() {
    $("editor-open").addEventListener("click", () => {
      if (this.canStartRequest()) this.input.click();
    });
    this.input.addEventListener("change", async () => {
      const file = this.input.files?.[0];
      this.input.value = "";
      if (!file || !this.canStartRequest()) return;
      this.fetching = true;
      this.updateControls();
      this.setStatus(`Reading ${file.name}…`);
      try {
        const text = await file.text();
        this.fetching = false;
        this.updateControls();
        this.loadDocument(text, file.name, file.name);
      } catch (error) {
        this.fetching = false;
        this.updateControls();
        this.setStatus(`Open failed: ${error instanceof Error ? error.message : error}`, true);
      }
    });
    for (const button of document.querySelectorAll("[data-editor-example]")) {
      button.addEventListener("click", () => {
        const example = this.config.examples.find((item) => item.id === button.dataset.editorExample);
        if (example && this.canStartRequest()) void this.loadExample(example);
      });
    }
    $("editor-download").addEventListener("click", () => {
      if (!this.canStartRequest()) return;
      const request = this.nextRequest++;
      this.pendingDownload = { request, deadline: this.player.frames + EDITOR_REQUEST_TIMEOUT };
      this.updateControls();
      this.setStatus("Validating the project for Download…");
      this.requestSave(request);
      this.player.focus();
    });
    this.updateControls();
  }

  async start() {
    this.player.sendService({ t: "hello", w: this.player.width, h: this.player.height, epoch: Date.now() });
    this.player.sendService({
      t: "agent-ready",
      protocol: "rpgkit-local-agent/v1",
      available: false,
      adapter: "browser",
      message: "Desktop companion required",
      maxPromptChars: 4096,
    });
    let stored = null;
    try {
      stored = localStorage.getItem(this.config.storageKey);
    } catch (error) {
      this.storageReadError = error instanceof Error ? error.message : String(error);
      this.setStatus(`Browser storage is unavailable: ${this.storageReadError}`, true);
    }
    if (stored && this.loadDocument(stored, this.fileName(stored), "the saved browser project", {
      startup: true,
      restore: true,
    })) return;
    const first = this.config.examples[0];
    if (first) await this.loadExample(first, true);
    else this.finishStartup();
  }

  async loadExample(example, startup = false) {
    this.fetching = true;
    this.updateControls();
    this.setStatus(`Opening ${example.title}…`);
    try {
      const response = await fetchOk(new URL(example.url, document.baseURI), example.title);
      const text = await response.text();
      this.fetching = false;
      this.updateControls();
      if (!this.loadDocument(text, `${example.id}.json`, example.title, { startup })) {
        if (startup) this.finishStartup();
      }
    } catch (error) {
      this.fetching = false;
      if (startup) this.finishStartup();
      else this.updateControls();
      this.setStatus(`${example.title} could not be opened: ${error instanceof Error ? error.message : error}`, true);
    }
  }

  /** Queue a correlated load. The guest validates the complete schema and
   * answers with {t:"loaded"}; opening a document never overwrites the last
   * explicitly saved recovery copy. */
  loadDocument(text, name, label, options = {}) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.setStatus(`${label} was not opened: ${error instanceof Error ? error.message : error}`, true);
      return false;
    }
    let pack = null;
    if (record(parsed) && parsed.kind === SHARDED_PACK_KIND) {
      try {
        pack = BrowserProjectPack.parse(text);
      } catch (error) {
        this.setStatus(`${label} was not opened: ${error instanceof Error ? error.message : error}`, true);
        return false;
      }
    } else if (!record(parsed) || parsed.format !== "rpgkit-project/v1") {
      this.setStatus(`${label} was not opened: not an rpgkit-project/v1 document or ${SHARDED_PACK_KIND} pack`, true);
      return false;
    }
    const request = this.nextRequest++;
    this.pendingLoad = {
      request,
      text,
      pack,
      name: this.safeName(name),
      label,
      startup: options.startup === true,
      restore: options.restore === true,
      deadline: this.player.frames + EDITOR_REQUEST_TIMEOUT,
    };
    this.player.sendService(pack ? pack.projectMessage(request) : { t: "load", text, request });
    this.setStatus(`Opening ${label}…`);
    this.player.focus();
    this.updateControls();
    return true;
  }

  afterStep() {
    if (this.pendingLoad && this.player.frames >= this.pendingLoad.deadline) {
      const pending = this.pendingLoad;
      this.pendingLoad = null;
      if (pending.startup) this.finishStartup();
      else this.updateControls();
      this.setStatus(`${pending.label} did not receive a response from the editor.`, true);
    }
    if (this.pendingDownload && this.player.frames >= this.pendingDownload.deadline) {
      this.pendingDownload = null;
      this.updateControls();
      this.setStatus("Download timed out; the editor did not return a valid project.", true);
    }
  }

  requestSave(request) {
    if (this.player.state === "error") return;
    this.player.sendService({
      t: "key",
      k: "s",
      cmd: true,
      sh: false,
      alt: false,
      ctl: true,
      ...(request === undefined ? {} : { request }),
    });
  }

  receive(envelope) {
    const message = this.guestMessages.push(envelope);
    if (!record(message) || typeof message.t !== "string") return;
    if (message.t === "map-read") {
      const pack = this.pendingLoad?.pack ?? this.currentPack;
      const response = pack?.read(message);
      if (response) this.player.sendService(response);
      else if (requestId(message.request) && typeof message.entry === "string") {
        this.player.sendService({ t: "map-error", request: message.request, entry: message.entry, error: "no sharded project is open" });
      }
      return;
    }
    if (message.t === "project-save") {
      void this.receiveProjectSave(message);
      return;
    }
    if (message.t === "loaded") {
      this.receiveLoaded(message);
      return;
    }
    if (message.t !== "save") return;
    const download = this.pendingDownload;
    if (download && message.request === download.request) {
      this.pendingDownload = null;
      this.updateControls();
      if (typeof message.text !== "string") {
        this.setStatus(`Download was refused: ${message.error || "the editor returned no document"}.`, true);
        return;
      }
      this.currentText = message.text;
      const stored = this.persist(message.text);
      const downloaded = this.download(message.text);
      if (!downloaded.ok) {
        this.setStatus(`Download failed: ${downloaded.error}`, true);
      } else if (!stored.ok) {
        this.setStatus(`Downloaded ${this.currentName}, but its browser recovery copy was not saved: ${stored.error}`, true);
      } else {
        this.setStatus(`Downloaded ${this.currentName}; the same project is saved in this browser.`);
      }
      return;
    }
    // A stale correlated reply belongs to an expired Download request. It
    // must not turn into an unrelated browser Save.
    if (message.request !== undefined) return;
    if (typeof message.text !== "string") {
      this.setStatus("The editor returned an invalid save message.", true);
      return;
    }
    this.currentText = message.text;
    const stored = this.persist(message.text);
    if (stored.ok) this.setStatus("Saved in this browser.");
    else this.setStatus(`Save failed because browser storage is unavailable: ${stored.error}`, true);
  }

  async receiveProjectSave(message) {
    if (!requestId(message.request)) return;
    const pack = this.currentPack;
    if (!pack || this.projectSaving) {
      const error = this.projectSaving ? "another project save is in progress" : "no sharded project is open";
      this.player.sendService({ t: "project-saved", request: message.request, ok: false, error });
      return;
    }
    this.projectSaving = true;
    this.updateControls();
    try {
      const saved = await pack.save(message);
      const text = pack.serialize();
      this.currentText = text;
      const stored = this.persist(text);
      this.player.sendService({ t: "project-saved", request: message.request, ok: true });
      const download = this.pendingDownload;
      if (download && message.request === download.request) {
        this.pendingDownload = null;
        const downloaded = this.download(text);
        if (!downloaded.ok) this.setStatus(`Download failed: ${downloaded.error}`, true);
        else if (!stored.ok) this.setStatus(`Downloaded ${this.currentName}, but its browser recovery copy was not saved: ${stored.error}`, true);
        else this.setStatus(`Downloaded replacement pack ${this.currentName}; the same pack is saved in this browser.`);
      } else if (stored.ok) {
        const count = saved.entries.length;
        this.setStatus(`Saved ${count} changed map shard${count === 1 ? "" : "s"} in the browser pack.`);
      } else {
        this.setStatus(`Pack save was accepted, but browser recovery is unavailable: ${stored.error}`, true);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.player.sendService({ t: "project-saved", request: message.request, ok: false, error: text });
      if (this.pendingDownload?.request === message.request) this.pendingDownload = null;
      this.setStatus(`Pack save failed: ${text}`, true);
    } finally {
      this.projectSaving = false;
      this.updateControls();
    }
  }

  receiveLoaded(message) {
    const pending = this.pendingLoad;
    if (!pending || message.request !== pending.request) return;
    this.pendingLoad = null;
    if (message.ok === true) {
      this.currentName = pending.name;
      this.currentPack = pending.pack;
      this.currentText = pending.pack ? pending.pack.serialize() : pending.text;
      if (pending.startup) this.finishStartup();
      else this.updateControls();
      const status = pending.restore
        ? `Restored ${pending.label}.`
        : `Opened ${pending.label}; press Ctrl/Cmd+S to save a browser recovery copy.`;
      if (this.storageReadError) {
        this.setStatus(`${status} Browser recovery is unavailable: ${this.storageReadError}`, true);
      } else {
        this.setStatus(status);
      }
      return;
    }
    this.setStatus(`${pending.label} was rejected by the editor: ${message.error || "invalid project"}.`, true);
    if (pending.restore && this.config.examples[0]) {
      void this.loadExample(this.config.examples[0], true);
    } else if (pending.startup) {
      this.finishStartup();
    } else {
      this.updateControls();
    }
  }

  persist(text) {
    try {
      localStorage.setItem(this.config.storageKey, text);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  download(text) {
    let url = null;
    try {
      const blob = new Blob([text], { type: "application/json" });
      url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = this.currentName;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      this.lastDownload = text;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (url !== null) setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  canStartRequest() {
    return this.ready && !this.fetching && !this.projectSaving && !this.pendingLoad && !this.pendingDownload && this.player.state === "running";
  }

  finishStartup() {
    this.ready = true;
    this.updateControls();
  }

  updateControls() {
    const disabled = !this.canStartRequest();
    for (const control of this.controls) control.disabled = disabled;
    this.input.disabled = disabled;
  }

  fileName(text) {
    try {
      const title = String(JSON.parse(text)?.title ?? "rpgkit-project");
      return this.safeName(`${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "rpgkit-project"}.json`);
    } catch {
      return "rpgkit-project.json";
    }
  }

  safeName(name) {
    const stem = String(name || "rpgkit-project.json").split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]+/g, "-");
    return stem.toLowerCase().endsWith(".json") ? stem : `${stem || "rpgkit-project"}.json`;
  }

  setStatus(text, error = false) {
    this.statusElement.textContent = text;
    this.statusElement.classList.toggle("error", error);
  }
}

class Player {
  constructor(config) {
    this.config = config;
    // ?embed: the page shows only the game screen, sized to the window, for
    // a page that frames the player (Studio's play-test panel).
    this.embedded = new URLSearchParams(location.search).has("embed");
    if (this.embedded) document.body.classList.add("embedded");
    this.stage = $("stage");
    this.canvas = $("screen");
    this.overlay = $("overlay");
    this.message = $("overlay-message");
    this.hint = $("focus-hint");
    this.muteButton = $("audio-mute");
    this.volumeControl = $("audio-volume");
    this.volumeValue = $("audio-volume-value");
    this.playSurface = document.querySelector(".play-surface");
    this.fullscreenToggle = $("fullscreen-toggle");
    this.immersiveExit = $("immersive-exit");
    this.padToggle = $("pad-toggle");
    this.padHidden = false;
    this.rotateHint = $("rotate-hint");
    this.context = this.canvas.getContext("2d");
    this.audio = createMasterAudioHost(createAudioHost());
    this.pool = new ContactPool();
    this.width = 0;
    this.height = 0;
    this.image = null;
    this.companions = new Set(config.companions ?? []);
    this.svc = [];
    this.serviceOut = [];
    this.keyMasks = config.keys;
    this.keys = new Map();
    this.pad = new Map();
    this.mouseDown = false;
    this.touchMouseDown = false;
    this.lastMouse = null;
    this.frameFn = null;
    this.wasm = null;
    this.hitFacts = null;
    this.state = "loading";
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.acc = 0;
    this.frames = 0;
    this.scale = { device: 1, css: 1 };
    this.editorHost = config.editor && this.companions.has(EDITOR_COMPANION)
      ? new BrowserEditorHost(this, config.editor)
      : null;
    this.tick = this.tick.bind(this);
  }

  setState(state, message = "") {
    this.state = state;
    this.stage.dataset.state = state;
    this.message.textContent = message;
    this.overlay.hidden = state === "running";
    this.updateHint();
    this.editorHost?.updateControls();
  }

  // ---- boot ---------------------------------------------------------------

  bindInput() {
    this.bindAudioActivation();
    this.bindKeys();
    this.bindPointer();
    this.bindPad();
    this.editorHost?.bind();
    this.bindDemoControls();
    this.bindDemoMenu();
    this.editorHost?.bind();
    this.bindAudioControls();
    this.bindImmersive();
    this.bindPadToggle();
  }

  async boot() {
    const { config } = this;
    const base = document.baseURI;
    // Consume an OAuth callback before starting any wasm, pack or bundle
    // request. __pocketWeb is an explicit guest-readable platform marker;
    // unlike the one-time OAuth token, it is present on ordinary page loads.
    const oauth = oauthFromFragment();
    globalThis.__pocketWeb = true;
    globalThis.__pocketAuth = oauth?.token ? { token: oauth.token } : undefined;
    if (oauth?.error) console.warn("OAuth:", oauth.error);
    const [wasmBytes, pak, source] = await Promise.all([
      fetchOk(new URL(config.wasm, base), "The PocketJS core").then((r) => r.arrayBuffer()),
      config.pak ? fetchOk(new URL(config.pak, base), "The asset pack").then((r) => r.arrayBuffer()) : undefined,
      fetchOk(new URL(config.bundle, base), "The game bundle").then((r) => r.text()),
    ]);
    this.fit();
    this.wasm = await createWasmUi(wasmBytes, {
      width: this.width,
      height: this.height,
      rasterDensity: config.rasterDensity ?? 1,
    });
    const ops = this.wasm.ops;
    ops.svcOpen = (name) => this.companions.has(name);
    ops.svcPoll = () => (this.svc.length > 0 ? `${this.svc.splice(0).join("\n")}\n` : null);
    ops.svcSend = (line) => this.onServiceLine(line);
    // The host contract (engine.js load()): every global before the eval.
    globalThis.ui = ops;
    globalThis.__pak = pak;
    this.audio.reset();
    globalThis.audio = this.audio.ns;
    if (!socketHost) socketHost = createSocketHost();
    socketHost.reset();
    globalThis.socket = socketHost.ns;
    globalThis.__simHz = config.simHz ?? 60;
    globalThis.__pocketApp = config.app;
    globalThis.__rpgkitAutosave = createBrowserAutosaveBridge(
      config.autosaveStorageKey ?? `pocket-rpgkit:${config.app}:autosave:v1`,
    );
    globalThis.__rpgkitBoot = rpgkitBootFromSearch(location.search);
    globalThis.__rpgkitDemo = undefined;
    // A generic, browser-only storage bridge for games that need small
    // app-owned values beyond the kit autosave slot. Desktop QuickJS has no
    // localStorage global, so games use their ordinary save directory there.
    globalThis.__pocketWebStore = globalThis.localStorage ?? undefined;
    globalThis.frame = undefined;
    initAuthUI(config);
    new Function(`${source}\n//# sourceURL=${config.app}.js`)();
    if (typeof globalThis.frame !== "function") {
      throw new Error(`${config.app}.js ran but did not install frame()`);
    }
    this.frameFn = globalThis.frame;
    this.hitFacts = createTouchHitFacts((x, y) => {
      const query = ops.hitTestBounds ?? ops.hitTest;
      return query ? query(x, y) : 0;
    });
    if (this.editorHost) await this.editorHost.start();
    this.step();
    this.paint();
    this.setState("running");
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
    this.resume();
    this.focus();
  }

  fail(error) {
    this.pause();
    this.frameFn = null;
    console.error(`${this.config.app}:`, error);
    const text = error && error.message ? error.message : String(error);
    this.setState("error", `${t("game-stopped", "The game stopped")}: ${text}`);
    $("overlay-reload").hidden = false;
  }

  // ---- clock --------------------------------------------------------------

  resume() {
    if (this.running || this.state !== "running") return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.releaseAll();
  }

  tick(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    this.acc += Math.min(MAX_ELAPSED_MS, now - this.last);
    this.last = now;
    let steps = 0;
    try {
      while (this.acc >= STEP_MS && steps < MAX_CATCH_UP) {
        this.step();
        this.acc -= STEP_MS;
        steps++;
      }
      // A slow machine runs at most MAX_CATCH_UP steps per animation frame;
      // drop the rest instead of carrying a growing debt.
      if (this.acc > STEP_MS * MAX_CATCH_UP) this.acc = 0;
      if (steps > 0) this.paint();
    } catch (error) {
      this.fail(error);
    }
  }

  buttons() {
    let mask = 0;
    for (const bit of this.keys.values()) mask |= bit;
    for (const bit of this.pad.values()) mask |= bit;
    return mask;
  }

  step() {
    const packed = this.pool.pack();
    const hits = this.hitFacts(packed);
    this.audio.beginFrame();
    if (socketHost) socketHost.beginFrame();
    this.frameFn(this.buttons(), ANALOG_CENTER, packed, hits);
    this.wasm.tick();
    this.frames++;
    this.editorHost?.afterStep();
    this.syncDemoControls();
    this.editorHost?.afterStep();
  }

  paint() {
    this.image.data.set(this.wasm.renderScaledIncremental(this.config.rasterDensity ?? 1));
    this.context.putImageData(this.image, 0, 0);
  }

  onServiceLine(line) {
    this.serviceOut.push(line);
    if (this.serviceOut.length > SVC_LIMIT) this.serviceOut.splice(0, this.serviceOut.length - SVC_LIMIT);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.t === "cursor" && typeof message.k === "string") {
      this.canvas.style.cursor = message.k;
    }
    this.editorHost?.receive(message);
  }

  // ---- focus and keyboard -------------------------------------------------

  focus() {
    this.stage.focus({ preventScroll: true });
    this.updateHint();
  }

  updateHint() {
    const focused = document.activeElement === this.stage;
    this.hint.hidden = focused || this.state !== "running";
    this.stage.dataset.focused = focused ? "true" : "false";
  }

  releaseAll() {
    this.keys.clear();
    this.pad.clear();
    for (const button of document.querySelectorAll("[data-button].held")) button.classList.remove("held");
    if (this.mouseDown || this.touchMouseDown || this.lastMouse) {
      this.mouseDown = false;
      this.touchMouseDown = false;
      this.sendService({ t: "mouse", d: false });
      this.lastMouse = null;
    }
    this.pool.clear();
  }

  bindKeys() {
    const stage = this.stage;
    stage.addEventListener("keydown", (event) => {
      // In the CSS-fallback immersive mode (no real fullscreen), Escape
      // leaves immersive instead of reaching the game as CROSS. A real
      // fullscreen swallows Escape to exit itself, then fullscreenchange
      // runs exitImmersive().
      if (
        event.code === "Escape" &&
        document.body.classList.contains("immersive") &&
        !document.fullscreenElement
      ) {
        event.preventDefault();
        this.exitImmersive();
        return;
      }
      const command = event.ctrlKey || event.metaKey;
      // Keep browser navigation reachable while the editor owns the stage.
      // Tab must leave the canvas, and reload shortcuts must retain their
      // native meaning instead of becoming editor companion key messages.
      if (this.editorHost && (
        event.key === "Tab" ||
        event.key === "F5" ||
        (command && event.key.toLowerCase() === "r")
      )) return;
      const bit = !command && !event.altKey && Object.hasOwn(this.keyMasks, event.code) ? this.keyMasks[event.code] : undefined;
      if (bit !== undefined) this.keys.set(event.code, bit);
      let sent = false;
      if (this.editorHost && !event.isComposing) {
        const key = command ? event.key.toLowerCase() : NAMED_KEYS[event.key];
        if (command && event.key.toLowerCase() === "v") {
          // Let the native paste event carry clipboardData. Preventing this
          // keydown would suppress that reliable fallback when Clipboard API
          // permission is absent.
          sent = false;
        } else if (command || key) {
          this.sendService({
            t: "key",
            k: key ?? event.key,
            cmd: command,
            sh: event.shiftKey,
            alt: event.altKey,
            ctl: event.ctrlKey,
          });
          sent = true;
        } else if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
          this.sendService({ t: "ch", s: event.key });
          sent = true;
        }
      }
      if (bit !== undefined || sent) event.preventDefault();
    });
    stage.addEventListener("keyup", (event) => {
      if (!this.keys.has(event.code)) return;
      event.preventDefault();
      this.keys.delete(event.code);
    });
    stage.addEventListener("focus", () => this.updateHint());
    stage.addEventListener("compositionend", (event) => {
      if (this.editorHost && event.data) this.sendService({ t: "ch", s: event.data });
    });
    stage.addEventListener("paste", (event) => {
      if (!this.editorHost) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      this.sendService({ t: "paste", text });
    });
    stage.addEventListener("blur", () => {
      this.keys.clear();
      this.updateHint();
    });
    window.addEventListener("blur", () => this.releaseAll());
  }

  // ---- pointer ------------------------------------------------------------

  /** Client coordinates -> logical pixels, clamped to the viewport. */
  logical(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) * this.width) / (rect.width || 1));
    const y = Math.floor(((event.clientY - rect.top) * this.height) / (rect.height || 1));
    return {
      x: Math.max(0, Math.min(this.width - 1, x)),
      y: Math.max(0, Math.min(this.height - 1, y)),
    };
  }

  sendService(message) {
    this.svc.push(typeof message === "string" ? message : JSON.stringify(message));
    if (this.svc.length > SVC_LIMIT) this.svc.splice(0, this.svc.length - SVC_LIMIT);
  }

  /** Same-origin parents use the same narrow bridge as PocketAppInstance. */
  drainService() {
    return this.serviceOut.splice(0);
  }

  bindPointer() {
    const canvas = this.canvas;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      this.focus();
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        if (event.button !== 0 && event.button !== 2) return;
        if (event.button === 0) this.mouseDown = true;
        this.lastMouse = point;
        this.sendService({ t: "mouse", x: point.x, y: point.y, d: true, b: event.button, sh: event.shiftKey });
      } else {
        if (!this.pool.down(event.pointerId, point.x, point.y)) return;
        if (event.isPrimary) {
          this.touchMouseDown = true;
          this.sendService({ t: "mouse", x: point.x, y: point.y, d: true, b: 0, sh: false });
        }
      }
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events have no active pointer to capture.
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        const last = this.lastMouse;
        if (last && last.x === point.x && last.y === point.y) return;
        this.lastMouse = point;
        this.sendService({ t: "mouse", x: point.x, y: point.y, d: this.mouseDown, sh: event.shiftKey });
      } else if (this.pool.move(event.pointerId, point.x, point.y)) {
        event.preventDefault();
        if (event.isPrimary) this.sendService({ t: "mouse", x: point.x, y: point.y, d: true, sh: false });
      }
    });
    const up = (event) => {
      if (this.state !== "running") return;
      const point = this.logical(event);
      if (event.pointerType === "mouse") {
        if (event.button !== 0 && event.button !== 2) return;
        if (event.button === 0) {
          if (!this.mouseDown) return;
          this.mouseDown = false;
        }
        this.lastMouse = point;
        this.sendService({ t: "mouse", x: point.x, y: point.y, d: false, b: event.button, sh: event.shiftKey });
      } else if (this.pool.up(event.pointerId, point.x, point.y) && event.isPrimary) {
        this.touchMouseDown = false;
        this.sendService({ t: "mouse", x: point.x, y: point.y, d: false, b: 0, sh: false });
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "mouse") up(event);
      else if (this.pool.up(event.pointerId) && event.isPrimary) {
        this.touchMouseDown = false;
        this.sendService({ t: "mouse", d: false });
      }
    });
    canvas.addEventListener("wheel", (event) => {
      if (!this.editorHost || this.state !== "running") return;
      event.preventDefault();
      this.sendService({ t: "scroll", dy: event.deltaY });
    }, { passive: false });
  }

  // ---- on-screen buttons --------------------------------------------------

  bindPad() {
    for (const element of document.querySelectorAll("[data-button]")) {
      const bit = BTN[element.dataset.button];
      if (bit === undefined) continue;
      const release = (event) => {
        if (!this.pad.delete(event.pointerId)) return;
        element.classList.remove("held");
      };
      element.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        this.pad.set(event.pointerId, bit);
        element.classList.add("held");
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic events have no active pointer to capture.
        }
      });
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", release);
      element.addEventListener("lostpointercapture", release);
      element.addEventListener("contextmenu", (event) => event.preventDefault());
    }
  }

  // ---- HTML demo controls ------------------------------------------------

  /** The chapter/speed panel is a disclosure (tools/web.ts renders the
   *  toggle). Touch screens start collapsed so the on-screen pad stays in
   *  reach; mouse users get it open. */
  setDemoMenu(open) {
    const toggle = document.querySelector("[data-demo-toggle]");
    const body = document.querySelector(".demo-body");
    if (!toggle || !body) return;
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  }

  bindDemoMenu() {
    const toggle = document.querySelector("[data-demo-toggle]");
    if (!toggle) return;
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) this.setDemoMenu(false);
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      this.setDemoMenu(open);
      if (!open) this.focus();
    });
  }

  demoHook() {
    const hook = globalThis.__rpgkitDemo;
    return hook && typeof hook.jump === "function" && typeof hook.autoplay === "function" && typeof hook.current === "function"
      ? hook
      : null;
  }

  // The demo owns only the chapter/autoplay/warp keys (tools/web/boot.ts);
  // every other parameter — the language one first of all — is preserved, so
  // a ?lang= deep link survives chapter and autoplay clicks.
  replaceDemoQuery(values) {
    history.replaceState(history.state, "", location.pathname + withDemoQuery(location.search, values) + location.hash);
  }

  /** A fallback href (no demo hook) that keeps every non-demo parameter. */
  demoHref(values) {
    return withDemoQuery(location.search, values) + location.hash;
  }

  syncDemoControls() {
    const root = document.querySelector("[data-demo-controls]");
    if (!root) return;
    const hook = this.demoHook();
    let current = null;
    if (hook) {
      try {
        current = hook.current();
      } catch {
        current = null;
      }
    }
    const boot = rpgkitBootFromSearch(location.search);
    const chapter = typeof current?.chapter === "string"
      ? current.chapter
      : typeof boot.chapter === "string"
        ? boot.chapter
        : typeof boot.autoplay === "string" ? boot.autoplay : null;
    const speed = current?.speed ?? (boot.speed === "2" ? 2 : boot.speed === "4" ? 4 : 1);
    root.dataset.hook = hook ? "ready" : "fallback";
    root.dataset.chapter = chapter ?? "";
    root.dataset.speed = String(speed);
    for (const button of root.querySelectorAll("[data-demo-chapter]")) {
      const active = button.dataset.demoChapter === chapter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      // Keep the no-hook fallback link on the current language (and any
      // other non-demo parameter).
      button.href = this.demoHref({ chapter: button.dataset.demoChapter });
    }
    const activeChapter = root.querySelector(`[data-demo-chapter="${CSS.escape(chapter ?? "")}"][data-demo-autoplay="true"]`);
    const fallbackChapter = activeChapter?.dataset.demoChapter ?? root.querySelector('[data-demo-chapter][data-demo-autoplay="true"]')?.dataset.demoChapter;
    for (const button of root.querySelectorAll("[data-demo-speed]")) {
      const active = Number(button.dataset.demoSpeed) === speed;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      if (fallbackChapter) {
        button.href = this.demoHref({ autoplay: fallbackChapter, speed: button.dataset.demoSpeed });
      }
    }
  }

  bindDemoControls() {
    const root = document.querySelector("[data-demo-controls]");
    if (!root) return;
    for (const button of root.querySelectorAll("[data-demo-chapter]")) {
      button.addEventListener("click", (event) => {
        const hook = this.demoHook();
        if (!hook) return;
        event.preventDefault();
        const id = button.dataset.demoChapter;
        hook.jump(id);
        this.replaceDemoQuery({ chapter: id });
        this.syncDemoControls();
        this.setDemoMenu(false);
        this.focus();
      });
    }
    for (const button of root.querySelectorAll("[data-demo-speed]")) {
      button.addEventListener("click", (event) => {
        const hook = this.demoHook();
        if (!hook) return;
        const current = hook.current();
        const currentButton = current.chapter
          ? root.querySelector(`[data-demo-chapter="${CSS.escape(current.chapter)}"][data-demo-autoplay="true"]`)
          : null;
        const id = currentButton?.dataset.demoChapter ?? root.querySelector('[data-demo-chapter][data-demo-autoplay="true"]')?.dataset.demoChapter;
        if (!id) return;
        event.preventDefault();
        const speed = Number(button.dataset.demoSpeed);
        hook.autoplay(id, speed);
        this.replaceDemoQuery({ autoplay: id, speed });
        this.syncDemoControls();
        this.setDemoMenu(false);
        this.focus();
      });
    }
    this.syncDemoControls();
  }

  // ---- immersive (fullscreen play) ----------------------------------------

  bindImmersive() {
    this.fullscreenToggle.addEventListener("click", () => {
      if (document.body.classList.contains("immersive")) this.exitImmersive();
      else void this.enterImmersive();
    });
    this.immersiveExit.addEventListener("click", () => this.exitImmersive());
    this.rotateHint.querySelector("[data-rotate-dismiss]")?.addEventListener("click", () => {
      this.rotateHint.hidden = true;
      this.focus();
    });
    // Esc / the browser's back control leave fullscreen natively; sync the
    // CSS fallback either way (iPhone Safari has no Fullscreen API).
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && document.body.classList.contains("immersive")) this.exitImmersive();
    });
    window.addEventListener("popstate", () => {
      if (document.body.classList.contains("immersive")) this.exitImmersive();
    });
  }

  async enterImmersive() {
    document.body.classList.add("immersive");
    this.rotateHint.hidden = false;
    this.fullscreenToggle.setAttribute("aria-pressed", "true");
    this.fullscreenToggle.textContent = t("exit-fullscreen", "Exit fullscreen");
    this.immersiveExit.hidden = false;
    this.fit();
    // A history entry lets the device back button exit the CSS fallback.
    try {
      history.pushState({ immersive: true }, "");
    } catch {
      // Sandboxed windows may forbid history changes; the exit button stays.
    }
    try {
      if (this.playSurface.requestFullscreen) await this.playSurface.requestFullscreen();
    } catch {
      // iPhone Safari: the fixed CSS surface is the immersive mode.
    }
    try {
      await screen.orientation?.lock?.("landscape");
    } catch {
      // Orientation locking is best effort; the layout handles both.
    }
    this.focus();
  }

  exitImmersive() {
    if (!document.body.classList.contains("immersive")) return;
    document.body.classList.remove("immersive");
    this.rotateHint.hidden = true;
    this.fullscreenToggle.setAttribute("aria-pressed", "false");
    this.fullscreenToggle.textContent = t("fullscreen", "Fullscreen");
    this.immersiveExit.hidden = true;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    try {
      screen.orientation?.unlock?.();
    } catch {
      // Best effort.
    }
    this.fit();
    this.focus();
  }

  // ---- on-screen pad visibility -------------------------------------------

  /** The "hide buttons" toggle (landscape immersive only): a hidden pad
   *  leaves a small translucent "show" button in the corner. The choice is
   *  stored per browser; storage can be unavailable (private mode), so every
   *  read and write is guarded. */
  bindPadToggle() {
    if (!this.padToggle) return;
    try {
      this.padHidden = localStorage.getItem(PAD_HIDDEN_KEY) === "1";
    } catch {
      this.padHidden = false;
    }
    this.applyPadHidden();
    this.padToggle.addEventListener("click", () => {
      this.padHidden = !this.padHidden;
      try {
        localStorage.setItem(PAD_HIDDEN_KEY, this.padHidden ? "1" : "0");
      } catch {
        // The toggle still works for this session without persistence.
      }
      this.applyPadHidden();
      this.focus();
    });
  }

  applyPadHidden() {
    document.body.classList.toggle("pad-hidden", this.padHidden);
    if (!this.padToggle) return;
    const key = this.padHidden ? "show-buttons" : "hide-buttons";
    const fallback = this.padHidden ? "Show buttons" : "Hide buttons";
    this.padToggle.textContent = t(key, fallback);
    // Keep the data-i18n hook on the active label so a language switch
    // translates the button the user actually sees.
    this.padToggle.dataset.i18n = key;
    this.padToggle.setAttribute("aria-pressed", String(this.padHidden));
  }

  // ---- audio controls ------------------------------------------------------

  bindAudioActivation() {
    const activate = () => {
      // WebAudio resume must happen synchronously in a trusted gesture. Prime
      // the lazy host before target handlers let the guest react to that same
      // key/pointer event (including interaction-only sound effects).
      this.audio.activate();
      window.removeEventListener("keydown", activate, true);
      window.removeEventListener("pointerdown", activate, true);
    };
    window.addEventListener("keydown", activate, true);
    window.addEventListener("pointerdown", activate, true);
  }

  bindAudioControls() {
    const update = () => {
      const percent = Math.round(this.audio.masterVolume * 100);
      this.muteButton.textContent = this.audio.muted ? t("unmute", "Unmute") : t("mute", "Mute");
      this.muteButton.setAttribute("aria-label", this.audio.muted ? t("unmute-audio", "Unmute audio") : t("mute-audio", "Mute audio"));
      this.muteButton.setAttribute("aria-pressed", String(this.audio.muted));
      this.volumeControl.value = String(percent);
      this.volumeControl.setAttribute("aria-valuetext", `${percent}%`);
      this.volumeValue.textContent = `${percent}%`;
    };
    this.muteButton.addEventListener("click", () => {
      this.audio.setMuted(!this.audio.muted);
      update();
    });
    this.volumeControl.addEventListener("input", () => {
      this.audio.setMasterVolume(Number(this.volumeControl.value) / 100);
      update();
    });
    update();
  }

  // ---- sizing -------------------------------------------------------------

  /** Position the immersive pad so its clusters straddle the screen's left
   *  and right edges: the maximised screen is letterboxed on narrow phones,
   *  and viewport-corner buttons would sit in the black bars instead of over
   *  the picture. The pad keeps its CSS band everywhere else (normal flow,
   *  portrait immersive). Called from fit() and the immersive transitions. */
  layoutPad() {
    const pad = document.querySelector(".pad");
    if (!pad) return;
    const immersive = document.body.classList.contains("immersive");
    if (!immersive || window.innerWidth <= window.innerHeight) {
      pad.style.left = "";
      pad.style.right = "";
      pad.style.bottom = "";
      return;
    }
    const stage = this.stage.getBoundingClientRect();
    const surface = this.playSurface.getBoundingClientRect();
    // Hang up to 96px of each cluster in the letterbox; on a wide screen
    // (thin letterbox) keep the buttons a few px inside the viewport.
    const leftGap = Math.max(0, stage.left - surface.left - 4);
    const rightGap = Math.max(0, surface.right - stage.right - 4);
    const straddle = Math.min(96, leftGap, rightGap);
    pad.style.left = `${Math.max(0, stage.left - surface.left - straddle)}px`;
    pad.style.right = `${Math.max(0, surface.right - stage.right - straddle)}px`;
    // Rest the pad's bottom edge on the screen's bottom edge so the buttons
    // overlap the picture instead of the black bar below a letterboxed
    // screen.
    pad.style.bottom = `${Math.max(0, surface.bottom - stage.bottom)}px`;
  }

  /** Height of the on-screen pad when it is displayed, plus a gap. */
  padReserve() {
    const pad = document.querySelector(".pad");
    if (!pad || getComputedStyle(pad).display === "none") return 0;
    return pad.offsetHeight + 10;
  }

  /** Room to keep free below the screen so the touch pad and the collapsed
   *  demo menu stay in the first viewport on phones. */
  reserveBelow() {
    let reserved = RESERVE_PX;
    if (!this.embedded && matchMedia("(hover: none) and (pointer: coarse)").matches) {
      reserved += this.padReserve();
      const demo = document.querySelector("[data-demo-controls]");
      if (demo) reserved += demo.offsetHeight + 12;
    }
    return reserved;
  }

  fit() {
    const dpr = window.devicePixelRatio || 1;
    const area = this.stage.parentElement;
    // clientWidth includes the area's side padding; the stage gets the rest.
    const style = getComputedStyle(area);
    const areaWidth = area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const immersive = document.body.classList.contains("immersive");
    // In immersive mode the screen area fills the fixed surface between the
    // safe-area insets; the touch pad floats at the left/right corners, so it
    // reserves no band of height. Fitting the full area is what lets the
    // screen take the largest whole-pixel scale (fit.ts) and centre.
    const areaHeight = immersive
      ? Math.max(area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), 0)
      : this.embedded
        ? window.innerHeight
        : Math.max(window.innerHeight - (this.stage.getBoundingClientRect().top + window.scrollY) - this.reserveBelow(), window.innerHeight * 0.5);
    const density = this.config.rasterDensity ?? 1;
    const { size, k } = fitViewport(this.config.viewport, areaWidth, areaHeight, dpr, density);
    const [w, h] = size;
    const cssWidth = k >= 1 ? (w * k) / dpr : Math.min(areaWidth, (areaHeight * w) / h);
    this.stage.style.width = `${cssWidth}px`;
    this.stage.style.height = `${(cssWidth * h) / w}px`;
    this.stage.style.aspectRatio = `${w} / ${h}`;
    this.scale = { device: k, raster: k > 0 ? k / density : 0, css: cssWidth / w };
    this.stage.dataset.scale = String(k);
    this.stage.dataset.density = String(density);
    if (w !== this.width || h !== this.height) this.resize(w, h);
    this.layoutPad();
  }

  /** A new logical size: canvas, touch wire, and (once booted) core and app. */
  resize(width, height) {
    this.width = width;
    this.height = height;
    const density = this.config.rasterDensity ?? 1;
    this.canvas.width = width * density;
    this.canvas.height = height * density;
    this.context.imageSmoothingEnabled = false;
    this.image = this.context.createImageData(width * density, height * density);
    this.pool.resize(width, height);
    this.pool.clear();
    this.stage.dataset.logical = `${width}x${height}`;
    if (!this.wasm) return;
    // Core first, app hook second, so hostViewport() already reads the new
    // size when the app reacts (hosts/desktop, hosts/sim).
    this.wasm.resizeViewport(width, height);
    if (typeof globalThis.__pocketResizeViewport === "function") globalThis.__pocketResizeViewport(width, height);
    if (this.editorHost) this.sendService({ t: "resize", w: width, h: height });
    if (this.state === "running") this.paint();
  }

  bindSizing() {
    const refit = () => {
      try {
        this.fit();
      } catch (error) {
        this.fail(error);
      }
    };
    refit();
    window.addEventListener("resize", refit);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(refit).observe(this.stage.parentElement);
    const watchDensity = () => {
      const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener("change", () => {
        refit();
        watchDensity();
      }, { once: true });
    };
    watchDensity();
  }
}

if (typeof document !== "undefined") {
  const player = new Player(JSON.parse($("pocket-game").textContent));
  // Read by tools/web-verify.ts.
  globalThis.__pocketPlayer = player;
  $("overlay-reload").addEventListener("click", () => location.reload());
  player.bindSizing();
  player.bindInput();
  if (location.protocol === "file:") {
    player.setState("error", t("file-server", "Open this page through a web server; browsers do not load WebAssembly from file:// pages."));
  } else {
    player.setState("loading", t("loading", "Loading…"));
    player.boot().catch((error) => player.fail(error));
  }
}
