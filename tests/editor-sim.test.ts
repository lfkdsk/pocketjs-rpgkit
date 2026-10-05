// tests/editor-sim.test.ts — the tile-map editor (editor/) over the
// deterministic wasm sim host, on the kit's example documents:
//
//   VISIBLE     no-svc mode renders the amber banner AND a working gamepad
//               cursor (never a dead app or an invisible button). Semantic
//               pixels: banner strip is amber, every header button has
//               non-panel pixels, palette eraser slot is its red X cell,
//               canvas ground pixels are real tile art, event markers are
//               drawn at their cells.
//   GAMEPAD     d-pad moves the cursor across canvas/palette/header; CIRCLE
//               picks a tile and paints; CROSS erases; SQUARE undoes;
//               SELECT flips the layer; START attempts a save (refused
//               visibly with no fs/svc, never silent).
//   POINTER     injected svc ops: left click picks/paints, a held drag is
//               one undo step, right click erases, SAVE emits a {t:"save"}
//               line, {t:"load"} opens a host document and pins DOC to it.
//   ROUNDTRIP   sunstone.json and meadow.json -> zero edits -> export:
//               byte-identical to the example documents.
//   PLAYABLE    edited export validates AND boots a runtime session that
//               can step (src/engine/session.ts).
//   FS          with the sim fs namespace mounted, SAVE writes
//               projects/<id>.json and a second boot reads it back.
//   DETERMINISM every tape runs twice with byte-identical framebuffers.
//
// Requires dist/editor.js (`bun run build:editor`, or `bun run
// build:example` for everything) and the vendored wasm core.

import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { createSimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { FS_WRITE_TRUNCATE } from "../vendor/pocketjs/contracts/spec/fs.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { Project } from "../src/engine/types.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import {
  fittedView,
  headerButtons,
  HEADER_H,
  PAL_W,
  TILE,
  type HeaderActionId,
} from "../editor/engine/layout.ts";
import { appBundle, appPreflight, fnv1a } from "./helpers/boot.ts";
import { bootEditorWorld, installEditorSimIsolation, type BoundEditorWorld } from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const W = 480;
const H = 272;
const SUNSTONE = BUNDLED_PROJECTS.find((d) => d.id === "sunstone")!;
const MEADOW = BUNDLED_PROJECTS.find((d) => d.id === "meadow")!;

type World = BoundEditorWorld;

// The probes of the most recently booted world (the helper throws if a
// test drives a world another boot superseded).
let live: World | null = null;
const g = () => live!.probes();

function frame(world: World, mask = 0): void {
  world.frame(mask);
  world.tick();
}

async function bootPad(): Promise<World> {
  const world = await bootEditorWorld(60, undefined, undefined, { width: W, height: H });
  live = world;
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

async function bootSvc(inbox: string[], outbox: string[]): Promise<World> {
  const world = await bootEditorWorld(
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width: W, height: H },
  );
  live = world;
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

const svcLine = (inbox: string[], world: World, line: object): void => {
  inbox.push(JSON.stringify(line));
  frame(world);
};
const click = (inbox: string[], world: World, x: number, y: number, extra: object = {}): void => {
  svcLine(inbox, world, { t: "mouse", x, y, d: true, ...extra });
  svcLine(inbox, world, { t: "mouse", x, y, d: false, ...extra });
};
const clickHeader = (inbox: string[], world: World, id: HeaderActionId): void => {
  let button = headerButtons(W).find((candidate) => candidate.id === id);
  if (!button) {
    const more = headerButtons(W).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    button = headerButtons(W, true).find((candidate) => candidate.id === id);
  }
  if (!button) throw new Error(`missing header action: ${id}`);
  click(inbox, world, button.x + Math.floor(button.w / 2), button.y + Math.floor(button.h / 2));
};
const pulse = (world: World, mask: number): void => {
  frame(world, mask);
  frame(world, 0);
};

// --- semantic pixel helpers -------------------------------------------------

const px = (fb: Uint8Array, x: number, y: number): [number, number, number, number] => {
  const i = (y * W + x) * 4;
  return [fb[i]!, fb[i + 1]!, fb[i + 2]!, fb[i + 3]!];
};
const amber = (c: [number, number, number, number]) => c[0] > 70 && c[1] > 50 && c[2] < 60;
/** A region contains at least one bright-amber glyph pixel. */
const regionHasAmber = (fb: Uint8Array, x0: number, y0: number, w: number, h: number): boolean => {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const c = px(fb, x, y);
      if (c[0] > 150 && c[1] > 120 && c[2] < 100) return true;
    }
  }
  return false;
};
/** Count bright label pixels in a fixed glyph cell. Unlike a screenshot hash,
 * this states which visible content matters: both ends of GROUND must paint. */
const labelPixels = (fb: Uint8Array, x0: number, y0: number, w: number, h: number): number => {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const [r, g, b] = px(fb, x, y);
      if (r > 150 && g > 150 && b > 150) count++;
    }
  }
  return count;
};
/** Pixels inside one 16px cell tinted by the translucent event-marker fill
 *  (#d82f6a at 70% over any tile art: strong red, weak green, some blue).
 *  Marker cells measure 180+ of 256 on the village; unmarked cells stay
 *  under 70 (red mushrooms and roofs), plain grass at 0. */
const markerPixels = (fb: Uint8Array, x0: number, y0: number): number => {
  let n = 0;
  for (let y = y0; y < y0 + TILE; y++) {
    for (let x = x0; x < x0 + TILE; x++) {
      const [r, g, b] = px(fb, x, y);
      if (r >= 140 && g <= 110 && b >= 60 && r - g >= 60) n++;
    }
  }
  return n;
};
const darkPanel: [number, number, number, number] = [27, 34, 48, 255];
// Banner fill (#3a2a10) sampled at a glyph-free corner.
const bannerFill: [number, number, number, number] = [58, 42, 16, 255];
// Palette slot 2 in the first thumbnail row: town.1 on both documents.
const SLOT2: [number, number] = [3 + 2 * 13 + 6, 20 + 33 + 6];

// --- boot -------------------------------------------------------------------

simDescribe("editor boot", () => {
  test("boots on the bundled sunstone document with a usable first state", async () => {
    await bootPad();
    const s = g().state();
    expect(s.hasSvc).toBe(false);
    expect(s.docId).toBe("sunstone");
    expect(s.hostFile).toBe(false);
    expect(s.editor.project.title).toBe("The Sunstone of Bramble Hollow");
    expect(s.editor.mapIndex).toBe(0);
    expect(s.editor.layer).toBe("ground");
    expect(s.notice.text).toContain("GAMEPAD MODE");
    // every tile the palette offers resolves to a baked pak image
    expect(s.uploaded).toBe(267);
  });

  test("framebuffer is non-degenerate: chrome, banner, palette and canvas all paint", async () => {
    const world = await bootPad();
    const fb = world.render();
    // banner strip (gamepad mode) right of the palette: amber-ink glyphs
    // over the #3a2a10 strip fill
    expect(px(fb, PAL_W + 300, HEADER_H + 4).join(",")).toBe(bannerFill.join(","));
    expect(regionHasAmber(fb, PAL_W + 2, HEADER_H + 1, 200, 32)).toBe(true);
    // the same strip rows over the PALETTE stay the panel fill (banner
    // starts at the palette edge, never over it)
    expect(px(fb, 10, HEADER_H + 4).join(",")).toBe(darkPanel.join(","));
    // Every currently visible header button's center is filled (not the
    // header background). The geometry is responsive, so derive probes from
    // the same pure layout model used by rendering and pointer hit-testing.
    for (const button of headerButtons(W)) {
      const cx = button.x + Math.floor(button.w / 2);
      const cy = button.y + Math.floor(button.h / 2);
      expect(px(fb, cx, cy).join(",")).not.toBe(darkPanel.join(","));
    }
    // Pin the first G and final D separately. The former 44px layer box
    // clipped away the G while still leaving a plausible-looking ROUND.
    const layer = headerButtons(W).find((button) => button.id === "layer")!;
    expect(labelPixels(fb, layer.x + 7, 6, 7, 9)).toBe(22);
    expect(labelPixels(fb, layer.x + 51, 6, 7, 9)).toBe(24);
    // palette eraser slot (0): the thumbnail row starts below the label at
    // absolute y HEADER_H + PAL_GRID_TOP; the swatch has its dark-red fill
    // and the red "X" glyph somewhere in the 12x12 thumbnail box
    const slot0Y = HEADER_H + 33;
    expect(px(fb, 4, slot0Y + 1).join(",")).not.toBe(darkPanel.join(","));
    let redPixels = 0;
    for (let y = slot0Y; y < slot0Y + 12; y++) {
      for (let x = 3; x < 15; x++) {
        const c = px(fb, x, y);
        if (c[0] > 150 && c[0] > c[1] + 50 && c[0] > c[2] + 50) redPixels++;
      }
    }
    expect(redPixels).toBeGreaterThan(3);
    // palette slot 1 (town.0, Kenney grass) is tile art: green-dominant
    const grassThumb = px(fb, 3 + 13 + 6, slot0Y + 6);
    expect(grassThumb[1]).toBeGreaterThan(grassThumb[0]);
    // canvas ground: world cell (1,1) is the town.0 grass tile and is
    // green-dominant (a semantic content assertion, not a hash)
    const frame = fittedView(W, H, true).frame;
    const grass = px(fb, frame.x + 1 * TILE + 8, frame.y + 1 * TILE + 8);
    expect(grass[1]).toBeGreaterThan(grass[0]);
    // frame boundary: the pixel just outside the frame is the root
    // background (#10131b), the first pixel inside is map art — the frame
    // rectangle really starts here
    const rootBg = [16, 19, 27, 255] as const;
    expect(px(fb, frame.x - 2, frame.y + 8 * TILE)).toEqual([...rootBg]);
    const inFrame = px(fb, frame.x + 8 * TILE + 8, frame.y + 8 * TILE + 8);
    expect(inFrame.join(",")).not.toBe(rootBg.join(","));
  });

  test("event markers are drawn at their cells, and only there", async () => {
    const world = await bootPad();
    const fb = world.render();
    const frame = fittedView(W, H, true).frame;
    const village = JSON.parse(SUNSTONE.json).maps[0] as Project["maps"][number];
    const events = new Map((village.events ?? []).map((e) => [e.y * village.width + e.x, e.id]));
    // the 12-row window (banner up) shows rows 0..11, which hold all ten
    // village events — the hidden ambient-music event at (0, 0) and the
    // sign under its star-layer board included
    // (markers draw on top); no other cell is marked
    const seen: string[] = [];
    for (let ty = 0; ty < 12; ty++) {
      for (let tx = 0; tx < village.width; tx++) {
        const n = markerPixels(fb, frame.x + tx * TILE, frame.y + ty * TILE);
        const id = events.get(ty * village.width + tx);
        if (id) {
          expect({ id, marked: n > 150 }).toEqual({ id, marked: true });
          seen.push(id);
        } else {
          expect({ at: [tx, ty], marked: n > 150 }).toEqual({ at: [tx, ty], marked: false });
        }
      }
    }
    expect(seen).toContain("ambient-music");
    expect(seen).toContain("elder");
    expect(seen).toContain("sign");
    expect(seen).toHaveLength(10);
    // a plain grass cell carries no marker tint at all
    expect(markerPixels(fb, frame.x + 1 * TILE, frame.y + 1 * TILE)).toBe(0);
  });
});

// --- gamepad mode -----------------------------------------------------------

simDescribe("editor gamepad mode (no svc)", () => {
  test("d-pad drives the cursor into palette/header and CIRCLE picks then paints", async () => {
    const world = await bootPad();
    pulse(world, BTN.LEFT); // canvas col 0 -> palette
    expect(g().state().cursor.zone).toBe("palette");
    pulse(world, BTN.DOWN);
    pulse(world, BTN.DOWN);
    // slot at row 2 is a real town tile
    const slot = g().state().cursor.slot;
    expect(slot).toBeGreaterThan(0);
    pulse(world, BTN.CIRCLE);
    expect(g().state().editor.tile).not.toBeNull();
    pulse(world, BTN.RIGHT); // back to canvas
    expect(g().state().cursor.zone).toBe("canvas");
    for (let i = 0; i < 3; i++) pulse(world, BTN.RIGHT);
    for (let i = 0; i < 8; i++) pulse(world, BTN.DOWN);
    const { tx, ty } = g().state().cursor;
    const tile = g().state().editor.tile;
    frame(world, BTN.CIRCLE);
    frame(world, BTN.CIRCLE);
    frame(world, 0);
    const s = g().state();
    expect(s.editor.past).toHaveLength(1);
    const exported = JSON.parse(g().export().text) as Project;
    expect(exported.maps[0]!.ground[ty * 20 + tx]).toBe(tile);
  });

  test("CROSS erases, SQUARE undoes the erase, SELECT flips layer", async () => {
    const world = await bootPad();
    // pick tile at palette row 1 col 0 (slot 8)
    pulse(world, BTN.LEFT);
    pulse(world, BTN.DOWN);
    pulse(world, BTN.CIRCLE);
    pulse(world, BTN.RIGHT); // canvas (0,1)
    // paint (0,1)
    frame(world, BTN.CIRCLE);
    frame(world, 0);
    expect(JSON.parse(g().export().text).maps[0].ground[20]).not.toBe("town.0");
    // CROSS erases the cell under the cursor (0,1)
    frame(world, BTN.CROSS);
    frame(world, 0);
    expect(JSON.parse(g().export().text).maps[0].ground[20]).toBeNull();
    // SQUARE undoes the erase -> the painted tile returns
    pulse(world, BTN.SQUARE);
    expect(JSON.parse(g().export().text).maps[0].ground[20]).not.toBeNull();
    // SELECT toggles to the upper layer
    pulse(world, BTN.SELECT);
    expect(g().state().editor.layer).toBe("upper");
  });

  test("R switches maps; the cave paints from the dungeon sheet", async () => {
    const world = await bootPad();
    pulse(world, BTN.RTRIGGER);
    pulse(world, BTN.RTRIGGER);
    expect(g().state().editor.mapIndex).toBe(2);
    expect(g().state().editor.project.maps[2].id).toBe("cave");
    pulse(world, BTN.LEFT); // canvas (0,0) -> palette slot 0 (eraser)
    pulse(world, BTN.DOWN); // slot 8: the cave palette is dun.0.. only
    pulse(world, BTN.CIRCLE);
    expect(g().state().editor.tile).toBe("dun.7");
    pulse(world, BTN.RIGHT); // back to the canvas on the palette row: (0,1)
    const { tx, ty } = g().state().cursor;
    expect({ tx, ty }).toEqual({ tx: 0, ty: 1 });
    frame(world, BTN.CIRCLE);
    frame(world, 0);
    expect(g().state().editor.past).toHaveLength(1);
    const exported = JSON.parse(g().export().text) as Project;
    expect(exported.maps[2]!.ground[ty * 18 + tx]).toBe("dun.7");
    expect(g().export().ok).toBe(true);
    pulse(world, BTN.LTRIGGER);
    expect(g().state().editor.mapIndex).toBe(1);
  });

  test("the palette follows the map's sheets; cursor and selection rings follow the pad", async () => {
    const world = await bootPad();
    // palette strip: the first four thumbnail rows
    const strip = (fb: Uint8Array) => {
      const rows: number[] = [];
      for (let y = HEADER_H + 33; y < HEADER_H + 33 + 4 * 13; y++) {
        for (let x = 0; x < PAL_W; x++) rows.push(...px(fb, x, y));
      }
      return fnv1a(new Uint8Array(rows));
    };
    const village = strip(world.render());
    pulse(world, BTN.RTRIGGER);
    pulse(world, BTN.RTRIGGER); // cave: dun sheet only
    const cave = strip(world.render());
    expect(cave).not.toBe(village);
    pulse(world, BTN.LTRIGGER);
    pulse(world, BTN.LTRIGGER); // back to the village
    expect(strip(world.render())).toBe(village);

    // 13px slot box at palette slot `slot`: count pixels of one ring color
    const ring = (fb: Uint8Array, slot: number, rgb: [number, number, number]) => {
      const x0 = 3 + (slot % 8) * 13;
      const y0 = HEADER_H + 33 + Math.floor(slot / 8) * 13;
      let n = 0;
      for (let y = y0; y < y0 + 13; y++) {
        for (let x = x0; x < x0 + 13; x++) {
          const c = px(fb, x, y);
          if (c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]) n++;
        }
      }
      return n;
    };
    const ACCENT: [number, number, number] = [0xff, 0xd2, 0x4a];
    const CURSOR: [number, number, number] = [0x5f, 0xd3, 0x8a];
    pulse(world, BTN.LEFT); // into the palette at slot 0
    pulse(world, BTN.DOWN); // slot 8
    let fb = world.render();
    expect(ring(fb, 8, CURSOR)).toBeGreaterThan(20);
    expect(ring(fb, 0, CURSOR)).toBe(0);
    pulse(world, BTN.CIRCLE); // pick slot 8
    pulse(world, BTN.RIGHT); // leave the palette: only the selection ring stays
    fb = world.render();
    expect(g().state().editor.tile).toBe("town.7");
    expect(ring(fb, 8, ACCENT)).toBeGreaterThan(20);
    expect(ring(fb, 0, ACCENT)).toBe(0);
    expect(ring(fb, 8, CURSOR)).toBe(0);
  });

  test("START with no channel reports the save refusal in the status notice (no silent drop)", async () => {
    const world = await bootPad();
    pulse(world, BTN.START);
    const s = g().state();
    expect(s.notice.kind).toBe("bad");
    expect(s.notice.text).toContain("NO SAVE CHANNEL");
    // and nothing got exported
    expect(s.savedText).toBeNull();
  });

  test("the same button tape renders byte-identically twice", async () => {
    const tape: number[] = [
      BTN.LEFT, 0, BTN.DOWN, 0, BTN.CIRCLE, 0, BTN.RIGHT, 0, BTN.DOWN, 0,
      BTN.CIRCLE, BTN.CIRCLE, 0, BTN.SQUARE, 0, BTN.SELECT, 0,
    ];
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const world = await bootPad();
      for (const mask of tape) frame(world, mask);
      hashes.push(fnv1a(world.render()));
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});

// --- pointer (svc) mode -----------------------------------------------------

simDescribe("editor pointer mode (svc companion)", () => {
  test("left click picks a tile and a drag paints one undo step; right click erases", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    expect(g().state().hasSvc).toBe(true);
    // no banner in pointer mode: the amber strip rows are dark background
    expect(amber(px(world.render(), PAL_W + 6, HEADER_H + 4))).toBe(false);
    // pick palette slot 2 (town.1): PAL_PAD+2*13 center, row 0
    click(inbox, world, ...SLOT2);
    expect(g().state().editor.tile).toBe("town.1");
    // pointer-mode frame: no banner => frame y 25, 14 rows
    const frameRect = fittedView(W, H, false).frame;
    const at = (tx: number, ty: number): [number, number] => [
      frameRect.x + tx * TILE + 3,
      frameRect.y + ty * TILE + 3,
    ];
    // press at (4,8), drag to (5,8), release
    const [x0, y0] = at(4, 8);
    const [x1, y1] = at(5, 8);
    svcLine(inbox, world, { t: "mouse", x: x0, y: y0, d: true });
    svcLine(inbox, world, { t: "mouse", x: x1, y: y1, d: true });
    svcLine(inbox, world, { t: "mouse", x: x1, y: y1, d: false });
    expect(g().state().editor.past).toHaveLength(1);
    const ground = JSON.parse(g().export().text).maps[0].ground;
    expect(ground[8 * 20 + 4]).toBe("town.1");
    expect(ground[8 * 20 + 5]).toBe("town.1");
    // right-click erase (5,8)
    click(inbox, world, x1, y1, { b: 2 });
    expect(JSON.parse(g().export().text).maps[0].ground[8 * 20 + 5]).toBeNull();
    // shift-left also erases: repaint then shift-erase (4,8)
    click(inbox, world, x0, y0);
    click(inbox, world, x0, y0, { sh: true });
    expect(JSON.parse(g().export().text).maps[0].ground[8 * 20 + 4]).toBeNull();
  });

  test("SAVE sends a schema-valid document over svc and UNDO/REDO header buttons work", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const frameRect = fittedView(W, H, false).frame;
    const [x, y] = [frameRect.x + 4 * TILE + 3, frameRect.y + 8 * TILE + 3];
    click(inbox, world, ...SLOT2); // town.1
    click(inbox, world, x, y); // paint (4,8)
    const before = outbox.length;
    clickHeader(inbox, world, "save");
    const saves = outbox.slice(before).map((l) => JSON.parse(l) as { t: string; text?: string }).filter((m) => m.t === "save");
    expect(saves).toHaveLength(1);
    const saved = JSON.parse(saves[0]!.text!) as Project;
    expect(saved.format).toBe("rpgkit-project/v1");
    expect(saved.maps[0]!.ground[8 * 20 + 4]).toBe("town.1");
    expect(g().state().editor.dirty).toBe(false);
    clickHeader(inbox, world, "undo");
    expect(g().state().editor.past).toHaveLength(0);
    clickHeader(inbox, world, "redo");
    expect(g().state().editor.past).toHaveLength(1);
    expect(JSON.parse(g().export().text).maps[0].ground[8 * 20 + 4]).toBe("town.1");
  });

  test("cmd+z / cmd+shift+z / cmd+s key lines drive undo, redo and save", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const frameRect = fittedView(W, H, false).frame;
    click(inbox, world, ...SLOT2);
    click(inbox, world, frameRect.x + 6 * TILE + 3, frameRect.y + 3 * TILE + 3);
    expect(g().state().editor.past).toHaveLength(1);
    const key = (k: string, sh = false, request?: number) => svcLine(inbox, world, {
      t: "key", k, cmd: true, sh, alt: false, ctl: false, ...(request === undefined ? {} : { request }),
    });
    key("z");
    expect(g().state().editor.past).toHaveLength(0);
    key("z", true);
    expect(g().state().editor.past).toHaveLength(1);
    key("s");
    key("s", false, 17);
    const saves = outbox.map((l) => JSON.parse(l) as { t: string; request?: number }).filter((m) => m.t === "save");
    expect(saves).toHaveLength(2);
    expect(saves[0]!.request).toBeUndefined();
    expect(saves[1]!.request).toBe(17);
  });

  test("a {t:load} line opens the host document, pins DOC to it, and a bad one is rejected visibly", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    // what the desktop host sends for `bun run editor meadow`
    svcLine(inbox, world, { t: "load", text: MEADOW.json, request: 41 });
    const s = g().state();
    expect(s.docId).toBe("meadow");
    expect(s.hostFile).toBe(true);
    expect(s.editor.project.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(s.editor.project.maps[0]!.name).toBe("Kit Meadow");
    expect(s.editor.project.maps[0]!.width).toBe(20);
    expect(outbox.map((line) => JSON.parse(line)).at(-1)).toEqual({ t: "loaded", ok: true, request: 41 });
    // DOC would swap another project in under the host file: refused
    clickHeader(inbox, world, "doc");
    expect(g().state().notice.kind).toBe("bad");
    expect(g().state().editor.project.title).toBe("Pocket RPG Kit — Mini Meadow");
    // all four meadow events show a marker, including the three under
    // opaque or partly opaque star tiles (signpost, chest, flowerbed). The
    // 20x12 map letterboxes one row down inside the 14-row window.
    const fb = world.render();
    const f = fittedView(W, H, false).frame;
    for (const [x, y] of [[10, 6], [8, 8], [15, 3], [2, 10]] as const) {
      expect({ at: [x, y], n: markerPixels(fb, f.x + x * TILE, f.y + TILE + y * TILE) > 150 }).toEqual({ at: [x, y], n: true });
    }
    // malformed document
    svcLine(inbox, world, { t: "load", text: "{not json", request: 42 });
    expect(g().state().notice.kind).toBe("bad");
    expect(g().state().notice.text).toContain("HOST FILE REJECTED");
    expect(g().state().editor.project.title).toBe("Pocket RPG Kit — Mini Meadow");
    expect(outbox.map((line) => JSON.parse(line)).at(-1)).toMatchObject({ t: "loaded", ok: false, request: 42 });
  });

  test("clicks on a letterboxed map land on the cell under the pointer", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    // meadow is 20x12: centered one row down in the 14-row window
    svcLine(inbox, world, { t: "load", text: MEADOW.json });
    const f = fittedView(W, H, false).frame;
    const before = JSON.parse(MEADOW.json).maps[0].ground as (string | null)[];
    click(inbox, world, ...SLOT2); // town.1
    // the center of the DRAWN cell (4,4)
    click(inbox, world, f.x + 4 * TILE + 8, f.y + TILE + 4 * TILE + 8);
    const ground = JSON.parse(g().export().text).maps[0].ground as (string | null)[];
    expect(ground[4 * 20 + 4]).toBe("town.1");
    expect(ground[5 * 20 + 4]).toBe(before[5 * 20 + 4]);
    expect(g().state().editor.past).toHaveLength(1);
    // the letterbox band above the map is not a cell: no stroke, no hover
    click(inbox, world, f.x + 4 * TILE + 8, f.y + 4);
    expect(g().state().editor.past).toHaveLength(1);
    expect(g().state().hover).toBeNull();
  });

  test("bare {d:false} release after focus loss closes an open stroke", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const frameRect = fittedView(W, H, false).frame;
    const [x, y] = [frameRect.x + 3 * TILE + 3, frameRect.y + 6 * TILE + 3];
    click(inbox, world, ...SLOT2);
    svcLine(inbox, world, { t: "mouse", x, y, d: true });
    expect(g().state().editor.stroke).not.toBeNull();
    svcLine(inbox, world, { t: "mouse", d: false }); // host Reset: no coords
    expect(g().state().editor.stroke).toBeNull();
  });

  test("buttons mirrored from keys (z/x) never edit in pointer mode", async () => {
    // The desktop host mirrors typed letters as buttons (buttons.rs: z->CROSS,
    // x->CIRCLE). With the mouse companion active those buttons must move the
    // cursor only, otherwise cmd+z would undo AND erase and a plain "z"
    // press would wipe the cell under the cursor.
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const tile0 = JSON.parse(g().export().text).maps[0].ground[0];
    frame(world, BTN.CROSS); // z key mirror while the cursor sits at (0,0)
    frame(world, 0);
    expect(g().state().editor.past).toHaveLength(0);
    expect(JSON.parse(g().export().text).maps[0].ground[0]).toBe(tile0);
    frame(world, BTN.CIRCLE); // x key mirror
    frame(world, 0);
    expect(g().state().editor.past).toHaveLength(0);
  });
});

// --- round trip + runtime playability --------------------------------------

simDescribe("editor document round trip and playability", () => {
  test("a document the edit protocol cannot edit is refused when it opens", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    project.maps[0]!.events!.push({ ...project.maps[0]!.events![0]!, x: 99 }); // duplicate id, off the map
    const text = JSON.stringify(project);
    expect(g().inject(text)).toMatchObject({ ok: false });
    svcLine(inbox, world, { t: "load", text });
    expect(g().state().notice).toMatchObject({ kind: "bad" });
    expect(g().state().notice.text).toContain("HOST FILE REJECTED");
    expect(g().state().hostFile).toBe(false);
    expect(g().export().text).toBe(SUNSTONE.json);
  });

  test("no-edit export of sunstone.json and meadow.json is byte-identical", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    for (const doc of [SUNSTONE, MEADOW]) {
      const world = await bootSvc(inbox, outbox);
      if (doc.id === "meadow") svcLine(inbox, world, { t: "load", text: doc.json });
      const exported = g().export();
      expect(exported.ok).toBe(true);
      expect(exported.errors).toEqual([]);
      expect(exported.text).toBe(doc.json);
    }
  });

  test("an edited export validates and boots a playable runtime session", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const frameRect = fittedView(W, H, false).frame;
    // paint town.1 on a road-adjacent grass cell (8,8) — a walkable tile
    // swap that keeps the schema (town is the village's sheet) and does not
    // block the start at (9,9).
    const [x, y] = [frameRect.x + 8 * TILE + 3, frameRect.y + 8 * TILE + 3];
    click(inbox, world, ...SLOT2); // town.1
    click(inbox, world, x, y);
    const edited = JSON.parse(g().export().text) as Project;
    expect(edited.maps[0]!.ground![8 * 20 + 8]).toBe("town.1");
    // runtime session boots and steps DOWN once from the start (9,9)
    const session = createSession(edited, 60);
    let state = startSession(edited, session);
    const frame0 = state.frame;
    const map0 = state.mapId;
    state = stepSession(session, state, { buttons: BTN.DOWN });
    // a frame was consumed even when the destination decides to block; the
    // session accepts the edited document without throwing.
    expect(state.frame).toBe(frame0 + 1);
    expect(state.mapId).toBe(map0);
  });
});

// --- data.fs ----------------------------------------------------------------

simDescribe("editor data.fs project store", () => {
  test("an invalid exported copy warns and falls back to the bundled document", async () => {
    const fsHost = createSimFsHost();
    const write = fsHost.ns.write as (path: string, data: string, mode: number) => number;
    expect(write("projects/sunstone.json", JSON.stringify("{not json"), FS_WRITE_TRUNCATE)).toBe(0);

    const world = await bootEditorWorld(60, { fs: fsHost.ns }, undefined, { width: W, height: H });
    live = world;
    for (let i = 0; i < 4; i++) frame(world);

    const state = g().state();
    expect(state.docId).toBe("sunstone");
    expect(state.hostFile).toBe(false);
    expect(state.notice.kind).toBe("bad");
    expect(state.notice.text).toContain("EXPORTED COPY REJECTED");
    expect(state.notice.text).toContain("OPENED BUNDLED sunstone");
    expect(g().export().text).toBe(SUNSTONE.json);
  });

  test("START saves to projects/sunstone.json and a fresh boot reads it back", async () => {
    const fsHost = createSimFsHost();
    const world = await bootEditorWorld(60, { fs: fsHost.ns }, undefined, { width: W, height: H });
    live = world;
    for (let i = 0; i < 4; i++) frame(world);
    expect(g().state().hasFs).toBe(true);
    expect(g().state().hasSvc).toBe(false);
    // gamepad: into palette (slot 0 = eraser), down to slot 8, pick, back
    // to canvas (0,0), paint.
    pulse(world, BTN.LEFT);
    pulse(world, BTN.DOWN);
    pulse(world, BTN.CIRCLE);
    const tile = g().state().editor.tile;
    expect(tile).not.toBeNull();
    pulse(world, BTN.RIGHT);
    const at = g().state().cursor;
    expect(at.zone).toBe("canvas");
    expect(at.tx).toBe(0);
    frame(world, BTN.CIRCLE);
    frame(world, 0);
    expect(g().state().editor.past).toHaveLength(1);
    pulse(world, BTN.START);
    const s1 = g().state();
    expect(s1.notice.kind).toBe("good");
    expect(s1.notice.text).toContain("projects/sunstone.json");
    // second boot with the SAME fs: the stored copy overrides the bundled doc
    const world2 = await bootEditorWorld(60, { fs: fsHost.ns }, undefined, { width: W, height: H });
    live = world2;
    for (let i = 0; i < 4; i++) frame(world2);
    const reloaded = JSON.parse(g().export().text) as Project;
    expect(reloaded.maps[0]!.ground![at.ty * 20 + at.tx]).toBe(tile);
    expect(g().state().editor.dirty).toBe(false);
  });
});

// --- budget -----------------------------------------------------------------

simDescribe("editor budget", () => {
  test("bundle sizes stay in the editor budget", () => {
    const pak = statSync(appBundle("editor") + ".pak").size;
    const js = statSync(appBundle("editor") + ".js").size;
    // E3 adds two 16px raw TILESET entries (37,836 B), 25 preview actor
    // images, and the larger text slots used by the play/debug chrome.
    // The playtest-art fixture adds its icon sheet's 3 cells, 4 animation
    // frames, one 128x64 parallax and a sheet-icons TILESET: measured
    // complete editor pak 522,384 B. The Chinese names of the text layout
    // fields bake a 12-character CJK subset into the editor's font atlases
    // and carry the Noto Sans CJK license (4,560 B): measured 541,152 B.
    expect(pak).toBeLessThan(545_000);
    // Shared framework + tile editor + structured event inspector, the map
    // inspector/passage mode/transfer picking (E2), the two bundled documents,
    // and KS1's embedded command schema/read-only summaries.
    // E3 intentionally adds the production GameView/session renderer to the
    // editor-only entry plus its debug adapter, and KAU1 adds the audio schema
    // plus read-only audio command/condition summaries. The PocketJS upstream
    // rebase adds the same 10,219 shared bytes as Sunstone, and DEMO1's shared
    // GameView demo seam adds a little more. Together with the proposal queue,
    // portable validation/apply model, review panel, ghost overlays, the
    // exact-revision host SAVE handshake, and E5's editable fields for every
    // current command/condition with schema gates and resource hints (about
    // 43,650 B), and KG1's scene branch ADD dispatch, scene fields and
    // play-test scene placeholder, the merged editor is 1,195,808 B. Large
    // (sharded) project editing adds the lazy shard workspace, chunked
    // companion transport and virtual map catalog: 1,232,242 B. ED-UI1's
    // measured text fitting and responsive chrome baseline is 1,242,030 B;
    // AI4's local-agent protocol/request UI and responsive integration add
    // 16,949 B, for 1,258,979 B. The shared immutable-session engine/UI
    // paths add 31,070 B: measured 1,290,049 B; 1,304,853 B before the
    // PocketJS editor moved onto editor/api. Every edit now runs through the
    // shared protocol: editor/api/operations.ts joins the bundle (66,881 B:
    // argument checks, addresses, diff/patch-v1, in-memory revisions), the
    // edit rules move out of the model (edit-rules.ts 33,258 B, model.ts
    // 42,405 -> 25,393 B for the operation/history layer), plus the
    // validation memo (1,632 B) and refusal reporting in the app (1,225 B):
    // measured 1,391,375 B.
    // CJK-aware text layout in the shared dialog/battle/save-menu boxes
    // (9,416 B) and dialog pages and wrapped list labels that never cut
    // text (5,252 B) join it, with Studio's move-map
    // operation: measured 1,412,949 B.
    // The editor's embedded WorldLayout schema and project support add
    // 5,620 B: measured 1,418,569 B. Runtime consumers only pay for the
    // compatible schema identity recorded by the isolation tests.
    // The loop/break commands, the eventTouch trigger and the {v:} text
    // token (shared engine code, the embedded schema, and the editor's
    // loop-body paths, picker entries and token scan) join it: measured
    // 1,430,125 B.
    // The editor does not opt into connected-world rendering. Integer
    // chunk-window reuse plus GameView's generic factory seam bring the
    // measured bundle to 1,436,638 B; the 30,507 B concrete renderer portion
    // formerly pulled through the preview is absent. Keep a narrow margin.
    // KRM2 engine/schema/editor support and the editor's intentional
    // krm2ScreenPresentation registration measure 1,492,592 bytes. Ordinary
    // GameView apps keep the picture/HUD implementation isolated. The merged
    // Studio command palette, minimap, layers and canvas polish add 3,595 B;
    // timer-aware immutable cache keys add 317 B: measured 1,496,504 B.
    // The W3 cache driver's editor-visible types and the world-bounded
    // fixture's shared paths: measured 1,498,456 B. The interface-text merge
    // adds the bundled schema's uiText keys, BoundedLine and the bounded
    // editor paths: the merged editor measures 1,522,089 B. Seamless-v1's
    // schema/editor preservation, traversal identity, transfer provenance and
    // sparse reducer state bring it to 1,528,850 B; the editor still does not
    // opt into the concrete world handoff resolver. KRM3V's embedded schema,
    // parallax/animation Studio preview and shared reducer support add 15,006
    // B, measuring 1,543,856 B. The in-editor playtest now registers the
    // opt-in ItemIconRow and ParallaxLayer renderers so shops draw the baked
    // item-icon cells, adding 10,076 B: measured 1,553,932 B. The bundled
    // playtest-art fixture (its 11.7 KB document plus the three-kind art
    // manifest) brings the merged editor to 1,566,916 B. KRM3's label/
    // select-item/access/locationInfo/stop-se commands and the fix-4 engine
    // changes land on top, bringing the merged editor to 1,591,111 B. The
    // cold-path performance work (entry-page dependency cache, stable
    // extension condition keys, deferred seamless eviction) brings it to
    // 1,598,588 B, and the {x:} text-token wiring brings it to 1,601,512 B.
    // PocketJS upstream #514's packed touch-recorder pages add 2,020 B of
    // shared DevTools code (1,603,532 B), and GameView's share of the
    // connected-world neighbour preview plus the session's left-map snapshot
    // bring it to 1,606,330 B (+2,798). Autosave's embedded schema, bilingual
    // picker/summary, in-flight validation and shared snapshot seam add
    // 5,813 B: 1,612,143 B. The text command's optional layout (shared box
    // geometry and DialogBox, the four select fields with wrapped bilingual
    // hints in the event inspector, the embedded schema, interpreter, theme
    // and list summary, portrait-in-box scaling) adds 13,223 B: 1,625,366 B.
    // Deferred autosave scheduling adds 1,714 shared runtime bytes: the
    // measured editor bundle is 1,627,080 B. The seamless commit-frame
    // preview handover and the stepped World build bring it to 1,629,994 B.
    // Keep a narrow margin.
    expect(js).toBeLessThan(1_631_000);
  });
});
