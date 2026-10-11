// Optional follower/vehicle paint projection. Session integration tests own
// movement semantics; these checks make the UI contract discriminating:
// party visibility, current-map vehicle filtering, ridden-body suppression,
// walker pose selection, and stable actor depth all come from reducer state.

import { describe, expect, test } from "bun:test";
import { createSession, startSession } from "../src/engine/session.ts";
import type { Project } from "../src/engine/types.ts";
import { travelActorFrames } from "../src/ui/travel-actors.ts";
import { actorDepth } from "../src/ui/OccludingUpperLayer.tsx";

const WALKER = {
  idle: ["idle-down", "idle-left", "idle-up", "idle-right"],
  walkL: ["left-down", "left-left", "left-up", "left-right"],
  walkR: ["right-down", "right-left", "right-up", "right-right"],
  h: 32 as const,
} as const;

const project: Project = {
  format: "rpgkit-project/v1",
  title: "travel render fixture",
  tileSize: 16,
  start: { map: "harbor", x: 2, y: 2, dir: "right" },
  sheets: [{ id: "terrain", cols: 1, rows: 1, defaultPassage: "pass" }],
  sprites: {
    friend: { kind: "walker", sheet: "friend.png", h: 32 },
    boat: { kind: "image", src: "boat.png" },
    airship: { kind: "walker", sheet: "airship.png", h: 32 },
  },
  followers: { enabled: true, members: [{ id: "friend-1", sprite: "friend" }] },
  vehicles: [
    { id: "boat-1", kind: "boat", sprite: "boat", start: { map: "harbor", x: 3, y: 2, dir: "down" } },
    { id: "airship-1", kind: "airship", sprite: "airship", start: { map: "island", x: 1, y: 1, dir: "up" } },
  ],
  items: [],
  maps: [
    { id: "harbor", name: "Harbor", width: 8, height: 6, sheets: ["terrain"], ground: new Array(48).fill("terrain.0"), events: [] },
    { id: "island", name: "Island", width: 8, height: 6, sheets: ["terrain"], ground: new Array(48).fill("terrain.0"), events: [] },
  ],
};

const sprites = project.sprites!;
const npcSrc = { friend: WALKER, boat: "boat-image", airship: WALKER };
const STRIDE = 8 * 16;

describe("travel actor rendering projection", () => {
  test("selects walker frames and paints only current-map parked vehicles", () => {
    const session = createSession(project);
    const state = startSession(project, session);
    const member = state.travel!.followers!.members[0]!;
    member.move.phase = 2;
    member.move.facing = 3;

    const frames = travelActorFrames(state, sprites, npcSrc, STRIDE);
    expect(frames.followers).toEqual([{
      id: "friend-1",
      px: 32,
      py: 32,
      src: "left-right",
      height: 32,
      visible: true,
      depth: actorDepth(32, 32, STRIDE),
    }]);
    expect(frames.vehicles.map((frame) => [frame.id, frame.src, frame.visible])).toEqual([
      ["boat-1", "boat-image", true],
      ["airship-1", "idle-up", false],
    ]);
  });

  test("keeps nodes stable but hides the chain and ridden vehicle while mounted", () => {
    const session = createSession(project);
    const state = startSession(project, session);
    state.travel!.vehicles!.riding = "boat-1";
    const mounted = travelActorFrames(state, sprites, npcSrc, STRIDE);
    expect(mounted.followers).toHaveLength(1);
    expect(mounted.followers[0]!.visible).toBe(false);
    expect(mounted.vehicles).toHaveLength(2);
    expect(mounted.vehicles.find((frame) => frame.id === "boat-1")!.visible).toBe(false);

    state.travel!.vehicles!.riding = null;
    state.travel!.followers!.visible = false;
    const hidden = travelActorFrames(state, sprites, npcSrc, STRIDE);
    expect(hidden.followers[0]!.visible).toBe(false);
    expect(hidden.vehicles.find((frame) => frame.id === "boat-1")!.visible).toBe(true);
  });
});
