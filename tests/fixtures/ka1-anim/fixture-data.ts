import type { MapDef, Project, TileId } from "../../../src/engine/types.ts";

export const KA1_MAP_ID = "ka1-field";
export const KA1_MAP_SIZE = { width: 40, height: 25 } as const;
export const PLAYER_START = { x: 20, y: 12 } as const;
/** The autorun looping pulse, visible from boot. */
export const BURST_TILE = { x: 25, y: 12 } as const;
/** The autorun tall tower (32x64 — Tuxemon dragonbirth is 48x64, but pak
 *  textures must be pow2, so the fixture is 32 wide; the anchor rule
 *  depends only on the 64 px height), visible from boot so pixel tests
 *  cover the half-height anchor for frames taller than one tile. */
export const TALL_TILE = { x: 12, y: 17 } as const;
/** Action events around the player start. */
export const ONCE_TILE = { x: 27, y: 12 } as const;
export const RING_TILE = { x: 30, y: 12 } as const;
/** The trail-bind action event (two tiles east of the player start) and
 *  the invisible mover it binds to. The mover walks two tiles east from
 *  TRAIL_MOVER_TILE to TRAIL_LAST_TILE and erases itself, so the render
 *  test can assert a following mapAnim pins to the last live cell. */
export const TRAIL_BIND_TILE = { x: PLAYER_START.x + 2, y: PLAYER_START.y } as const;
export const TRAIL_MOVER_TILE = { x: PLAYER_START.x + 4, y: PLAYER_START.y } as const;
export const TRAIL_LAST_TILE = { x: PLAYER_START.x + 6, y: PLAYER_START.y } as const;

const ground: TileId[] = Array.from(
  { length: KA1_MAP_SIZE.width * KA1_MAP_SIZE.height },
  () => "fixture.0",
);

export const KA1_MAP: MapDef = {
  id: KA1_MAP_ID,
  name: "Map animation field",
  width: KA1_MAP_SIZE.width,
  height: KA1_MAP_SIZE.height,
  sheets: ["fixture"],
  ground,
  events: [
    {
      // Loops a four-frame pulse from boot so pixel tests can watch the
      // frame advance without driving input. A parallel fiber (not autorun)
      // so the parked wait never blocks player movement.
      id: "auto-burst",
      x: BURST_TILE.x,
      y: BURST_TILE.y,
      pages: [{
        trigger: "parallel",
        commands: [
          { op: "mapAnim", id: "burst", anim: "pulse", x: BURST_TILE.x, y: BURST_TILE.y, loop: true },
          { op: "wait", seconds: 30 },
        ],
      }],
    },
    {
      // One-shot above the player; waits for the playthrough, then flips a
      // switch so a test can observe the resume.
      id: "once",
      x: PLAYER_START.x,
      y: PLAYER_START.y - 1,
      pages: [{
        trigger: "action",
        commands: [
          { op: "mapAnim", id: "once", anim: "pulse", x: ONCE_TILE.x, y: ONCE_TILE.y, wait: true },
          { op: "switch", id: "once-done", value: true },
        ],
      }],
    },
    {
      // A looping aura bound to the player: it follows every step. It paints
      // in the above band so it stays visible over the player sprite.
      id: "follow",
      x: PLAYER_START.x,
      y: PLAYER_START.y + 1,
      pages: [{
        trigger: "action",
        commands: [
          { op: "mapAnim", id: "aura", anim: "ring", target: "player", loop: true },
        ],
      }],
    },
    {
      // Stops the boot pulse.
      id: "stop",
      x: PLAYER_START.x - 1,
      y: PLAYER_START.y,
      pages: [{
        trigger: "action",
        commands: [{ op: "stopAnim", id: "burst" }],
      }],
    },
    {
      // Loops a 48x64 tower from boot (Tuxemon dragonbirth's size) so the
      // render tests cover frames taller than one tile. A parallel fiber
      // (not autorun) so the parked wait never blocks player movement.
      id: "auto-tower",
      x: TALL_TILE.x,
      y: TALL_TILE.y,
      pages: [{
        trigger: "parallel",
        commands: [
          { op: "mapAnim", id: "tower", anim: "tower", x: TALL_TILE.x, y: TALL_TILE.y, loop: true },
          { op: "wait", seconds: 30 },
        ],
      }],
    },
    {
      // A second looping animation to the east, in the below band (under
      // characters) so both bands get pixel coverage.
      id: "ring",
      x: PLAYER_START.x + 1,
      y: PLAYER_START.y,
      pages: [{
        trigger: "action",
        commands: [
          { op: "mapAnim", id: "ring", anim: "ring", x: RING_TILE.x, y: RING_TILE.y, loop: true, layer: "below" },
        ],
      }],
    },
    {
      // Invisible mover for the trail test. Page 1 keeps a live but
      // sprite-less (so non-rendering) character at TRAIL_MOVER_TILE. Page 2
      // (switch "trail-move") walks it two tiles east and erases it, so the
      // render test can assert a following mapAnim pins to the last live
      // cell (TRAIL_LAST_TILE), not the cell where it was bound.
      id: "trail-mover",
      x: TRAIL_MOVER_TILE.x,
      y: TRAIL_MOVER_TILE.y,
      pages: [
        { trigger: "parallel", commands: [{ op: "wait", seconds: 30 }] },
        {
          trigger: "parallel",
          condition: { switch: "trail-move" },
          commands: [
            {
              op: "moveRoute",
              target: "this",
              wait: true,
              route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
            },
            { op: "erase" },
          ],
        },
      ],
    },
    {
      // Binds a looping ring to the mover, then flips the switch that makes
      // the mover walk away and erase. The ring must pin to the mover's last
      // live cell, not the cell it occupied when the ring was bound.
      id: "trail-bind",
      x: TRAIL_BIND_TILE.x,
      y: TRAIL_BIND_TILE.y,
      pages: [{
        trigger: "action",
        commands: [
          { op: "mapAnim", id: "trail", anim: "ring", target: { event: "trail-mover" }, loop: true },
          { op: "switch", id: "trail-move", value: true },
        ],
      }],
    },
  ],
};

export const KA1_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "KA1 map animation fixture",
  tileSize: 16,
  start: { map: KA1_MAP_ID, x: PLAYER_START.x, y: PLAYER_START.y, dir: "down" },
  sheets: [{ id: "fixture", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  animations: [
    { id: "pulse", sheet: "assets/anim-sheet-pulse.png", count: 4, frameDuration: 0.25, loop: false },
    { id: "ring", sheet: "assets/anim-sheet-ring.png", count: 2, frameDuration: 0.5, loop: true },
    { id: "tower", sheet: "assets/anim-sheet-tower.png", count: 2, frameDuration: 0.5, frameW: 32, frameH: 64, cols: 1, loop: true },
  ],
  maps: [KA1_MAP],
};

/** Opt-in KS1 fixture. It reuses the deterministic KA1 art but replaces the
 * event set with a staged controller for camera, balloon and screen layers. */
export const KS1_PROJECT: Project = {
  ...KA1_PROJECT,
  title: "KS1 screen presentation fixture",
  maps: [{
    ...KA1_MAP,
    events: [{
      id: "screen-controller",
      x: PLAYER_START.x,
      y: PLAYER_START.y + 1,
      pages: [
        {
          trigger: "action",
          commands: [
            { op: "balloon", target: "player", icon: "pulse" },
            { op: "camera", target: { x: 35, y: PLAYER_START.y }, duration: 0 },
            { op: "screenTint", layer: "night", color: { r: 0, g: 64, b: 192, a: 96 }, duration: 0 },
            { op: "switch", id: "ks1.stage.1", value: true },
          ],
        },
        {
          condition: { switch: "ks1.stage.1" },
          trigger: "action",
          commands: [
            { op: "screenFlash", color: { r: 255, g: 64, b: 32, a: 220 }, intensity: 200, duration: 1 },
            { op: "screenShake", strength: 7, speed: 15, duration: 1 },
            { op: "switch", id: "ks1.stage.2", value: true },
          ],
        },
        {
          condition: { switch: "ks1.stage.2" },
          trigger: "action",
          commands: [
            { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
            { op: "switch", id: "ks1.backdrop.covered", value: true },
            { op: "text", lines: ["Backdrop keeps dialogue readable."], cps: 120 },
            { op: "switch", id: "ks1.stage.3", value: true },
          ],
        },
        {
          condition: { switch: "ks1.stage.3" },
          trigger: "autorun",
          commands: [
            { op: "screenBackdrop", layer: "cutscene", variant: null },
            { op: "screenFade", direction: "out", duration: 1, wait: true },
            { op: "switch", id: "ks1.stage.4", value: true },
          ],
        },
        {
          condition: { switch: "ks1.stage.4" },
          trigger: "action",
          commands: [
            { op: "screenFade", direction: "in", duration: 1, wait: true },
            { op: "balloon", target: "player" },
            { op: "screenTint", layer: "night", color: { r: 0, g: 64, b: 192, a: 0 }, duration: 0 },
            { op: "camera", target: "player", duration: 0 },
            { op: "switch", id: "ks1.stage.5", value: true },
          ],
        },
        {
          condition: { switch: "ks1.stage.5" },
          trigger: "action",
          commands: [],
        },
      ],
    }, {
      id: "covered-backdrop-replacer",
      x: 0,
      y: 0,
      pages: [{
        condition: { switch: "ks1.backdrop.covered" },
        trigger: "parallel",
        blocks: false,
        commands: [
          { op: "wait", seconds: 0.05 },
          { op: "screenBackdrop", layer: "cutscene", variant: "red", whenModalOpen: "ignore" },
          { op: "switch", id: "ks1.backdrop.attempted", value: true },
          { op: "wait", seconds: 30 },
        ],
      }],
    }],
  }],
};

export const KS1_PERSIST_TARGET_ID = "ks1-persist-target";

/** Two-map visual fixture for transfer-persistent presentation. The source
 * action starts animation/camera/balloon state and transfers immediately;
 * the target's parallel page later opens two exposed backdrops so replacement
 * can be captured separately without hiding the world effects. */
export const KS1_PERSIST_PROJECT: Project = {
  ...KA1_PROJECT,
  title: "KS1 transfer-persistent presentation fixture",
  system: { ...KA1_PROJECT.system, transferPresentation: "retain" },
  maps: [
    {
      ...KA1_MAP,
      events: [{
        id: "persist-source",
        x: PLAYER_START.x,
        y: PLAYER_START.y + 1,
        pages: [{
          trigger: "action",
          commands: [
            { op: "mapAnim", id: "persist-pulse", anim: "pulse", target: "player", loop: true },
            { op: "camera", target: { x: 35, y: PLAYER_START.y }, duration: 0 },
            { op: "balloon", target: "player", icon: "pulse" },
            { op: "transfer", map: KS1_PERSIST_TARGET_ID, x: PLAYER_START.x, y: PLAYER_START.y, dir: "down", fade: 0 },
          ],
        }],
      }],
    },
    {
      ...KA1_MAP,
      id: KS1_PERSIST_TARGET_ID,
      name: "Persistent presentation target",
      events: [{
        id: "persist-backdrop",
        x: 0,
        y: 0,
        pages: [{
          trigger: "parallel",
          commands: [
            { op: "wait", seconds: 0.5 },
            { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
            { op: "screenBackdrop", layer: "cutscene", variant: "red" },
            { op: "wait", seconds: 30 },
          ],
        }],
      }],
    },
  ],
};
