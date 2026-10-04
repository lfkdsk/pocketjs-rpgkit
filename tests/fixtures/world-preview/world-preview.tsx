import { mount } from "@pocketjs/framework";
import { GameView, type ActorPoolStats, type GameViewOverlayConfig } from "../../../src/ui/index.ts";
import { cloneSnapshot, createSessionSnapshot } from "../../../src/engine/save.ts";
import type { SaveSnapshot } from "../../../src/engine/save.ts";
import type { SessionState } from "../../../src/engine/session.ts";
import { loadIntoView } from "../../../src/ui/session-saves.ts";
import { createWorldRenderer, type WorldNpcPreviewStats } from "../../../src/ui/world/index.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { WORLD_PREVIEW_LEGACY_PROJECT, WORLD_PREVIEW_PROJECT } from "./fixture-data.ts";

/** Queued for the next host frame: "save" captures a v1 save and the live
 * reducer state; "load" restores the save through the normal loader;
 * "load-older" restores it without the left-map snapshot, as a save written
 * before that snapshot existed; "rewind" presents the captured reducer
 * state again, as a rewind keyframe restore does. */
export type WorldPreviewCommand = "save" | "load" | "load-older" | "rewind";

export interface WorldPreviewFixtureProbe {
  queue: WorldPreviewCommand[];
  error: string | null;
  /** Every preview repaint, in order. */
  previews: WorldNpcPreviewStats[];
  actors?: ActorPoolStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __worldPreviewProbe: WorldPreviewFixtureProbe | undefined;
  /** "preview" (default), "off" (renderer with npcPreview: false) or
   * "legacy" (no connected-world renderer at all). */
  // eslint-disable-next-line no-var
  var __worldPreviewMode: "preview" | "off" | "legacy" | undefined;
}

const probe: WorldPreviewFixtureProbe = { queue: [], error: null, previews: [] };
globalThis.__worldPreviewProbe = probe;
const mode = globalThis.__worldPreviewMode ?? "preview";
globalThis.__worldPreviewMode = undefined;

const world = mode === "legacy"
  ? undefined
  : createWorldRenderer(mode === "off" ? { npcPreview: false } : {});

let saved: SaveSnapshot | undefined;
let kept: SessionState | undefined;
const overlay: GameViewOverlayConfig = {
  create(host) {
    return {
      step() {
        const command = probe.queue.shift();
        if (!command) return { consumed: false };
        if (command === "save") {
          saved = createSessionSnapshot(host.session, host.getState(), host.heldButtons());
          kept = host.getState();
          return { consumed: true, stateChanged: false };
        }
        if (command === "rewind") {
          host.replaceState(kept!);
          return { consumed: true, stateChanged: true };
        }
        let snapshot = saved!;
        if (command === "load-older") {
          snapshot = cloneSnapshot(saved!);
          delete snapshot.mapRuntime?.leftMap;
        }
        const loaded = loadIntoView(host, snapshot);
        if (!loaded.ok) probe.error = loaded.error.code;
        return { consumed: true, stateChanged: loaded.ok };
      },
      isOpen: () => false,
      render: () => null,
    };
  },
};

mount(() => (
  <GameView
    project={mode === "legacy" ? WORLD_PREVIEW_LEGACY_PROJECT : WORLD_PREVIEW_PROJECT}
    assets={GAME_ASSETS}
    world={world}
    overlay={overlay}
    onWorldPreviewStats={(stats) => { probe.previews.push(stats); }}
    onActorStats={(stats) => { probe.actors = stats; }}
  />
));
