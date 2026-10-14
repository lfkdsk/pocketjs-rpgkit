// Browser Gamepad API -> the same BTN mask used by keyboard and touch.
// Configuration lives in web.json because physical controller layout is a
// browser-host concern, not a portable guest capability.

import { BTN, BUTTON_NAMES, type ButtonName } from "./keys.ts";

export const DEFAULT_GAMEPAD_DEADZONE = 0.25;
export const GAMEPAD_MAX_BUTTON_INDEX = 31;

/** web.json spelling. Entries merge over the standard-layout defaults;
 * `null` unbinds one physical button, just as the keyboard table does. */
export interface WebGamepadConfig {
  deadzone?: number;
  buttons?: Record<string, ButtonName | null>;
}

/** Player-page spelling: validated once, with BTN names compiled to masks. */
export interface BrowserGamepadConfig {
  deadzone: number;
  buttons: Record<string, number>;
}

const DEFAULT_BUTTON_NAMES: Readonly<Record<string, ButtonName>> = {
  0: "CIRCLE", // standard south / A: confirm
  1: "CROSS", // standard east / B: cancel
  2: "TRIANGLE", // standard west / X
  3: "SQUARE", // standard north / Y
  4: "LTRIGGER",
  5: "RTRIGGER",
  6: "LTRIGGER",
  7: "RTRIGGER",
  8: "SELECT",
  9: "START",
  12: "UP",
  13: "DOWN",
  14: "LEFT",
  15: "RIGHT",
};

const DEFAULT_BUTTON_MASKS = Object.fromEntries(
  Object.entries(DEFAULT_BUTTON_NAMES).map(([index, name]) => [index, BTN[name]]),
) as Record<string, number>;

export const DEFAULT_BROWSER_GAMEPAD_CONFIG: BrowserGamepadConfig = {
  deadzone: DEFAULT_GAMEPAD_DEADZONE,
  buttons: DEFAULT_BUTTON_MASKS,
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate and compile one optional web.json gamepad override. */
export function normalizeGamepadConfig(value?: WebGamepadConfig): BrowserGamepadConfig {
  if (value !== undefined && !record(value)) throw new Error("gamepad is an object");
  const deadzone = value?.deadzone ?? DEFAULT_GAMEPAD_DEADZONE;
  if (typeof deadzone !== "number" || !Number.isFinite(deadzone) || deadzone < 0 || deadzone > 1) {
    throw new Error("deadzone is a finite number from 0 through 1");
  }
  if (value?.buttons !== undefined && !record(value.buttons)) throw new Error("buttons is a table keyed by button index");

  const buttons = { ...DEFAULT_BUTTON_MASKS };
  for (const [indexText, name] of Object.entries(value?.buttons ?? {})) {
    if (!/^(0|[1-9][0-9]*)$/.test(indexText) || Number(indexText) > GAMEPAD_MAX_BUTTON_INDEX) {
      throw new Error(`buttons.${indexText} is an integer index from 0 through ${GAMEPAD_MAX_BUTTON_INDEX}`);
    }
    if (name === null) {
      delete buttons[indexText];
    } else if (!(BUTTON_NAMES as readonly unknown[]).includes(name)) {
      throw new Error(`buttons.${indexText} is not a button (${BUTTON_NAMES.join(", ")})`);
    } else {
      buttons[indexText] = BTN[name as ButtonName];
    }
  }
  return { deadzone, buttons };
}

type GamepadSnapshot = Pick<Gamepad, "axes" | "buttons" | "connected" | "index" | "mapping">;
type GamepadSource = () => ArrayLike<GamepadSnapshot | null>;

/** Live connected-controller set. Event snapshots select indices; sampling
 * always reads navigator.getGamepads() so held state cannot become stale. */
export class BrowserGamepadInput {
  private readonly indices = new Set<number>();
  private readonly buttonMap: Array<readonly [number, number]>;

  constructor(
    private readonly source: GamepadSource,
    private readonly config: BrowserGamepadConfig = DEFAULT_BROWSER_GAMEPAD_CONFIG,
  ) {
    this.buttonMap = Object.entries(config.buttons).map(([index, bit]) => [Number(index), bit] as const);
  }

  get active(): boolean {
    return this.indices.size > 0;
  }

  connect(gamepad: Pick<GamepadSnapshot, "connected" | "index" | "mapping">): boolean {
    if (gamepad.connected === false || gamepad.mapping !== "standard" || !Number.isInteger(gamepad.index) || gamepad.index < 0) {
      return false;
    }
    this.indices.add(gamepad.index);
    return true;
  }

  disconnect(index: number): void {
    this.indices.delete(index);
  }

  buttons(): number {
    let pads: ArrayLike<GamepadSnapshot | null>;
    try {
      pads = this.source() ?? [];
    } catch {
      pads = [];
    }
    let mask = 0;
    for (const index of this.indices) {
      const gamepad = pads[index];
      if (!gamepad || gamepad.connected === false || gamepad.mapping !== "standard") {
        this.indices.delete(index);
        continue;
      }
      for (const [buttonIndex, bit] of this.buttonMap) {
        const button = gamepad.buttons[buttonIndex];
        if (button && (button.pressed || button.value >= 0.5)) mask |= bit;
      }
      const x = gamepad.axes[0] ?? 0;
      const y = gamepad.axes[1] ?? 0;
      if (x < -this.config.deadzone) mask |= BTN.LEFT;
      if (x > this.config.deadzone) mask |= BTN.RIGHT;
      if (y < -this.config.deadzone) mask |= BTN.UP;
      if (y > this.config.deadzone) mask |= BTN.DOWN;
    }
    return mask;
  }
}

interface ButtonPlayer {
  buttons(): number;
}

interface GamepadBrowser {
  navigator?: { getGamepads?: () => ArrayLike<GamepadSnapshot | null> };
  addEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void;
  removeEventListener(type: "gamepadconnected" | "gamepaddisconnected", listener: EventListener): void;
}

export interface BrowserGamepadBinding {
  readonly input: BrowserGamepadInput | null;
  dispose(): void;
}

/** Attach browser connection events. Until a standard controller exists, the
 * player's original buttons method is untouched; after the last disconnect it
 * is restored, so no-controller frames perform no Gamepad work. */
export function bindBrowserGamepads(
  player: ButtonPlayer,
  config: BrowserGamepadConfig = DEFAULT_BROWSER_GAMEPAD_CONFIG,
  browser: GamepadBrowser = globalThis as unknown as GamepadBrowser,
): BrowserGamepadBinding {
  const getGamepads = browser.navigator?.getGamepads;
  if (typeof getGamepads !== "function") return { input: null, dispose() {} };

  const input = new BrowserGamepadInput(() => getGamepads.call(browser.navigator), config);
  const original = Object.getOwnPropertyDescriptor(player, "buttons");
  const baseButtons = player.buttons;
  let patched = false;

  const restore = () => {
    if (!patched) return;
    if (original) Object.defineProperty(player, "buttons", original);
    else delete (player as { buttons?: () => number }).buttons;
    patched = false;
  };
  const patch = () => {
    if (patched) return;
    player.buttons = function buttonsWithGamepad() {
      const gamepad = input.buttons();
      if (!input.active) restore();
      return baseButtons.call(this) | gamepad;
    };
    patched = true;
  };
  const connect = (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad;
    if (gamepad && input.connect(gamepad)) patch();
  };
  const disconnect = (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad;
    if (!gamepad) return;
    input.disconnect(gamepad.index);
    if (!input.active) restore();
  };

  browser.addEventListener("gamepadconnected", connect);
  browser.addEventListener("gamepaddisconnected", disconnect);
  const present = getGamepads.call(browser.navigator);
  for (let index = 0; index < present.length; index++) {
    const gamepad = present[index];
    if (gamepad) input.connect(gamepad);
  }
  if (input.active) patch();

  return {
    input,
    dispose() {
      browser.removeEventListener("gamepadconnected", connect);
      browser.removeEventListener("gamepaddisconnected", disconnect);
      restore();
    },
  };
}
