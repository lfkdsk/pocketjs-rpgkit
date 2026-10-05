// Host-owned lifecycle effects requested by event commands. Kept separate
// from optional KRM2 presentation so every GameView can deliver menu/save/
// title requests without importing numbered-picture or HUD code.

import type { HostAction } from "../engine/interpreter.ts";
import type { SaveSnapshot } from "../engine/save.ts";
import type { SessionHostEffect } from "../engine/session.ts";
import type { GameViewSessionHost } from "./demo-contract.ts";

/** Each callback receives the same session facade used by opt-in overlays. */
export interface GameViewHostCallbacks {
  menu?: (host: GameViewSessionHost) => void;
  save?: (host: GameViewSessionHost) => void;
  /** Receives the normalized snapshot captured at the request tick, or at
   * the first later reference tick whose complete state v1 can resume. The
   * live host may already be on a later tick. */
  autosave?: (host: GameViewSessionHost, snapshot: Readonly<SaveSnapshot>) => void;
  gameOver?: (host: GameViewSessionHost) => void;
  title?: (host: GameViewSessionHost) => void;
}

/** True when the host may act on a `menu`/`save` request: the corresponding
 *  access flag (SwitchState.menuAccess / saveAccess) is enabled, which is
 *  the default — only an explicit Change Menu/Save Access disable stores
 *  false. A host without a live session state allows the request. A host
 *  that renders its own menu/save entries reads the same flags from
 *  `host.getState().sw` to show them disabled. */
export function hostActionAllowed(action: HostAction, host: GameViewSessionHost): boolean {
  const sw = host.getState?.().sw;
  if (action === "menu") return sw?.menuAccess !== false;
  if (action === "save") return sw?.saveAccess !== false;
  return true;
}

/** Dispatch one reducer frame's requests in authored order, including
 *  repeated actions. A `menu`/`save` request whose access flag is disabled
 *  is dropped (the request is not delivered), matching RPG Maker's
 *  disabled menu/save entries. Omitted callbacks are deterministic no-ops. */
export function dispatchGameViewHostActions(
  actions: readonly HostAction[] | undefined,
  callbacks: Readonly<GameViewHostCallbacks> | undefined,
  host: GameViewSessionHost,
): void {
  if (!callbacks) return;
  for (const action of actions ?? []) {
    if (!hostActionAllowed(action, host)) continue;
    // A bare reducer marker has no tick snapshot. GameView uses the effect
    // dispatcher below; this legacy helper deliberately cannot substitute
    // the later live state for an autosave checkpoint.
    if (action === "autosave") continue;
    callbacks[action]?.(host);
  }
}

/** Dispatch committed reference-tick effects in authored order. This is the
 * GameView path: streamed-map retries discard their uncommitted collector,
 * and attract rewind/refold never receives a collector in the first place. */
export function dispatchGameViewHostEffects(
  effects: readonly SessionHostEffect[],
  callbacks: Readonly<GameViewHostCallbacks> | undefined,
  host: GameViewSessionHost,
): void {
  if (!callbacks) return;
  for (const effect of effects) {
    if (!hostActionAllowed(effect.action, host)) continue;
    if (effect.action === "autosave") callbacks.autosave?.(host, effect.snapshot);
    else callbacks[effect.action]?.(host);
  }
}
