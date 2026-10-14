import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bindBrowserGamepads,
  BrowserGamepadInput,
  DEFAULT_GAMEPAD_DEADZONE,
  normalizeGamepadConfig,
} from "../tools/web/gamepad.ts";
import { BTN } from "../tools/web/keys.ts";
import { CHROME_START_BUDGET_MS, Cdp, launchChrome } from "../tools/lib/cdp.ts";

type Pad = Pick<Gamepad, "axes" | "buttons" | "connected" | "index" | "mapping">;

function pad(
  index: number,
  options: { axes?: number[]; pressed?: number[]; values?: Record<number, number>; mapping?: GamepadMappingType; connected?: boolean } = {},
): Pad {
  const pressed = new Set(options.pressed ?? []);
  return {
    index,
    connected: options.connected ?? true,
    mapping: options.mapping ?? "standard",
    axes: options.axes ?? [0, 0],
    buttons: Array.from({ length: 18 }, (_, buttonIndex) => ({
      pressed: pressed.has(buttonIndex),
      touched: pressed.has(buttonIndex),
      value: options.values?.[buttonIndex] ?? (pressed.has(buttonIndex) ? 1 : 0),
    })),
  };
}

describe("browser gamepad mapping", () => {
  test("maps the standard layout to the web player's letter-labelled buttons", () => {
    const slots: Array<Pad | null> = [pad(0, { pressed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15] })];
    const input = new BrowserGamepadInput(() => slots, normalizeGamepadConfig());
    expect(input.connect(slots[0]!)).toBe(true);
    expect(input.buttons()).toBe(
      BTN.CIRCLE | BTN.CROSS | BTN.TRIANGLE | BTN.SQUARE |
      BTN.LTRIGGER | BTN.RTRIGGER | BTN.SELECT | BTN.START |
      BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT,
    );
  });

  test("merges overrides, including confirm/cancel swap and unbinding", () => {
    const config = normalizeGamepadConfig({
      deadzone: 0.4,
      buttons: { 0: "CROSS", 1: "CIRCLE", 2: null },
    });
    expect(config.deadzone).toBe(0.4);
    expect(config.buttons[0]).toBe(BTN.CROSS);
    expect(config.buttons[1]).toBe(BTN.CIRCLE);
    expect(config.buttons[2]).toBeUndefined();
    expect(config.buttons[12]).toBe(BTN.UP);

    const current = pad(0, { pressed: [0, 1, 2] });
    const input = new BrowserGamepadInput(() => [current], config);
    input.connect(current);
    expect(input.buttons()).toBe(BTN.CROSS | BTN.CIRCLE);
  });

  test("validates the web.json host-specific override", () => {
    expect(DEFAULT_GAMEPAD_DEADZONE).toBe(0.25);
    expect(() => normalizeGamepadConfig([] as any)).toThrow(/gamepad is an object/);
    expect(() => normalizeGamepadConfig({ deadzone: Number.NaN })).toThrow(/finite number/);
    expect(() => normalizeGamepadConfig({ deadzone: 1.01 })).toThrow(/0 through 1/);
    expect(() => normalizeGamepadConfig({ buttons: [] as any })).toThrow(/table keyed by button index/);
    expect(() => normalizeGamepadConfig({ buttons: { "01": "CIRCLE" } })).toThrow(/integer index/);
    expect(() => normalizeGamepadConfig({ buttons: { 32: "CIRCLE" } })).toThrow(/0 through 31/);
    expect(() => normalizeGamepadConfig({ buttons: { 0: "ZL" as any } })).toThrow(/is not a button/);
  });

  test("applies the deadzone strictly and merges axes with the physical d-pad", () => {
    let current = pad(0, { axes: [-0.25, 0.25] });
    const input = new BrowserGamepadInput(() => [current], normalizeGamepadConfig());
    input.connect(current);
    expect(input.buttons()).toBe(0);

    current = pad(0, { axes: [-0.2501, 0.2501], pressed: [12] });
    expect(input.buttons()).toBe(BTN.LEFT | BTN.DOWN | BTN.UP);
    current = pad(0, { axes: [0.9, -0.9], pressed: [14] });
    expect(input.buttons()).toBe(BTN.RIGHT | BTN.UP | BTN.LEFT);
  });

  test("ORs multiple live controllers and prunes missing slots", () => {
    const slots: Array<Pad | null> = [
      pad(0, { pressed: [0] }),
      pad(1, { axes: [1, 0], pressed: [1] }),
    ];
    const input = new BrowserGamepadInput(() => slots, normalizeGamepadConfig());
    input.connect(slots[0]!);
    input.connect(slots[1]!);
    expect(input.buttons()).toBe(BTN.CIRCLE | BTN.CROSS | BTN.RIGHT);
    slots[0] = null;
    slots[1] = null;
    expect(input.buttons()).toBe(0);
    expect(input.active).toBe(false);
  });

  test("ignores non-standard controllers instead of guessing their layout", () => {
    const current = pad(0, { mapping: "" });
    const input = new BrowserGamepadInput(() => [current], normalizeGamepadConfig());
    expect(input.connect(current)).toBe(false);
    expect(input.active).toBe(false);
    expect(input.buttons()).toBe(0);
  });
});

class FakeBrowser {
  slots: Array<Pad | null> = [];
  navigator = { getGamepads: () => this.slots };
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: "gamepadconnected" | "gamepaddisconnected", gamepad: Pad): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ gamepad } as unknown as Event);
  }
}

describe("browser gamepad button-path integration", () => {
  test("patches only while connected and clears a held button on disconnect", () => {
    class Player {
      base = BTN.SQUARE;
      buttons(): number { return this.base; }
    }
    const browser = new FakeBrowser();
    const player = new Player();
    const binding = bindBrowserGamepads(player, normalizeGamepadConfig(), browser);
    expect(Object.hasOwn(player, "buttons")).toBe(false);
    expect(player.buttons()).toBe(BTN.SQUARE);

    const current = pad(0, { pressed: [0], axes: [1, 0] });
    browser.slots[0] = current;
    browser.dispatch("gamepadconnected", current);
    expect(Object.hasOwn(player, "buttons")).toBe(true);
    expect(player.buttons()).toBe(BTN.SQUARE | BTN.CIRCLE | BTN.RIGHT);

    // Keep the browser's last snapshot pressed: the disconnect event itself
    // must remove it, rather than trusting that stale object to clear.
    browser.dispatch("gamepaddisconnected", current);
    expect(Object.hasOwn(player, "buttons")).toBe(false);
    expect(player.buttons()).toBe(BTN.SQUARE);
    expect(binding.input?.active).toBe(false);
  });

  test("defensively restores the zero-overhead path when a disconnect event is missed", () => {
    class Player { buttons(): number { return BTN.SELECT; } }
    const browser = new FakeBrowser();
    const current = pad(0, { pressed: [1] });
    browser.slots[0] = current;
    const player = new Player();
    const binding = bindBrowserGamepads(player, normalizeGamepadConfig(), browser);
    expect(Object.hasOwn(player, "buttons")).toBe(true);
    expect(player.buttons()).toBe(BTN.SELECT | BTN.CROSS);

    browser.slots[0] = null;
    expect(player.buttons()).toBe(BTN.SELECT);
    expect(Object.hasOwn(player, "buttons")).toBe(false);
    expect(binding.input?.active).toBe(false);
  });

  test("does nothing when the browser has no Gamepad API", () => {
    class Player { buttons(): number { return BTN.START; } }
    const player = new Player();
    const listeners: string[] = [];
    const binding = bindBrowserGamepads(player, normalizeGamepadConfig(), {
      navigator: {},
      addEventListener: (type) => { listeners.push(type); },
      removeEventListener() {},
    });
    expect(binding.input).toBeNull();
    expect(listeners).toEqual([]);
    expect(Object.hasOwn(player, "buttons")).toBe(false);
    expect(player.buttons()).toBe(BTN.START);
  });
});

const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome";
setDefaultTimeout(CHROME_START_BUDGET_MS + 30_000);

describe.skipIf(!existsSync(CHROME))("real Chrome Gamepad API path", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let profile = "";
  let cdp: Cdp | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  const evaluate = async <T>(expression: string): Promise<T> => {
    if (!cdp) throw new Error("CDP is not connected");
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`Chrome evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  };

  beforeAll(async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", "tools", "web", "gamepad.ts")],
      target: "browser",
      format: "esm",
    });
    if (!built.success || built.outputs.length !== 1) throw new Error("could not bundle the browser Gamepad helper");
    const module = await built.outputs[0]!.text();
    const page = `<!doctype html><meta charset="utf-8"><script type="module">
      import { bindBrowserGamepads, normalizeGamepadConfig } from "/gamepad.js";
      const BTN = ${JSON.stringify(BTN)};
      const makePad = (index, pressed = [], axes = [0, 0]) => ({
        index, connected: true, mapping: "standard", axes,
        buttons: Array.from({ length: 18 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })),
      });
      class SmokePlayer {
        constructor() { this.base = BTN.SQUARE; }
        buttons() { return this.base; }
      }
      const player = new SmokePlayer();
      const binding = bindBrowserGamepads(player, normalizeGamepadConfig());
      const fire = (type, gamepad) => {
        const event = new Event(type);
        Object.defineProperty(event, "gamepad", { value: gamepad });
        dispatchEvent(event);
      };
      window.gamepadSmoke = {
        initial: () => ({ mask: player.buttons(), patched: Object.hasOwn(player, "buttons") }),
        connect: () => {
          const gamepad = makePad(0, [0], [1, 0]);
          globalThis.__gamepadSlots[0] = gamepad;
          fire("gamepadconnected", gamepad);
          return { mask: player.buttons(), patched: Object.hasOwn(player, "buttons") };
        },
        disconnectHeld: () => {
          const gamepad = globalThis.__gamepadSlots[0];
          fire("gamepaddisconnected", gamepad);
          return { mask: player.buttons(), patched: Object.hasOwn(player, "buttons"), active: binding.input.active };
        },
        missDisconnect: () => {
          const gamepad = makePad(0, [1]);
          globalThis.__gamepadSlots[0] = gamepad;
          fire("gamepadconnected", gamepad);
          globalThis.__gamepadSlots[0] = null;
          return { mask: player.buttons(), patched: Object.hasOwn(player, "buttons"), active: binding.input.active };
        },
      };
      window.__gamepadReady = true;
    </script>`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/gamepad.js") return new Response(module, { headers: { "Content-Type": "text/javascript" } });
        if (pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        return new Response("not found", { status: 404 });
      },
    });
    profile = mkdtempSync(join(tmpdir(), "pocket-rpgkit-gamepad-"));
    const chrome = await launchChrome(CHROME, profile, "800,600");
    proc = chrome.proc;
    cdp = await Cdp.connect(chrome.ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.__gamepadSlots = []; Object.defineProperty(Navigator.prototype, "getGamepads", { configurable: true, value() { return globalThis.__gamepadSlots; } });`,
    });
    const loaded = new Promise((resolveLoaded) => cdp!.on("Page.loadEventFired", resolveLoaded));
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await loaded;
    expect(await evaluate<boolean>("window.__gamepadReady === true")).toBe(true);
  });

  afterAll(() => {
    cdp?.close();
    proc?.kill();
    server?.stop(true);
    if (profile) rmSync(profile, { recursive: true, force: true });
  });

  test("uses navigator.getGamepads in Chrome and restores buttons after disconnect", async () => {
    type Snapshot = { mask: number; patched: boolean; active?: boolean };
    expect(await evaluate<Snapshot>("gamepadSmoke.initial()")).toEqual({ mask: BTN.SQUARE, patched: false });
    expect(await evaluate<Snapshot>("gamepadSmoke.connect()")).toEqual({
      mask: BTN.SQUARE | BTN.CIRCLE | BTN.RIGHT,
      patched: true,
    });
    expect(await evaluate<Snapshot>("gamepadSmoke.disconnectHeld()")).toEqual({ mask: BTN.SQUARE, patched: false, active: false });
    expect(await evaluate<Snapshot>("gamepadSmoke.missDisconnect()")).toEqual({ mask: BTN.SQUARE, patched: false, active: false });
  });
});
