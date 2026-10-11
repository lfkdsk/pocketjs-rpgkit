import { describe, expect, test } from "bun:test";
import { activePage } from "../src/engine/interpreter.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import type { Project } from "../src/engine/types.ts";
import {
  checkConditionContext,
  worldFingerprint,
} from "../tools/rpgkit-check/src/dynamic/sim.ts";

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Checker travel fixture",
    tileSize: 16,
    start: { map: "field", x: 0, y: 0, dir: "down" },
    sheets: [],
    items: [],
    sprites: { boat: { kind: "image", src: "boat.png" } },
    vehicles: [{
      id: "boat",
      kind: "boat",
      sprite: "boat",
      start: { map: "field", x: 1, y: 0, dir: "down" },
    }],
    maps: [{
      id: "field",
      name: "Field",
      width: 3,
      height: 3,
      ground: new Array(9).fill(null),
      events: [{
        id: "sailor",
        x: 2,
        y: 2,
        pages: [
          { trigger: "action", commands: [], sprite: "boat" },
          {
            trigger: "action",
            commands: [],
            sprite: "boat",
            condition: { all: [{ kind: "vehicle", id: "boat" }] },
          },
        ],
      }],
    }],
  };
}

describe("rpgkit-check dynamic vehicle context", () => {
  test("uses live ridden state for page sampling and progress fingerprints", () => {
    const doc = project();
    const session = createSession(doc, 60);
    const state = startSession(doc, session);
    const map = session.maps.get("field")!;
    const event = map.events![0]!;
    const extension = { runtime: session.extensions, ext: state.ext };

    const walking = checkConditionContext(state, map);
    expect(walking.vehicle).toBeNull();
    expect(activePage(event, state.sw, map.id, state.move.facing, extension, walking)?.index).toBe(0);
    const walkingFingerprint = worldFingerprint(state);

    state.travel!.vehicles!.riding = "boat";
    const riding = checkConditionContext(state, map);
    expect(riding.vehicle).toBe("boat");
    expect(activePage(event, state.sw, map.id, state.move.facing, extension, riding)?.index).toBe(1);
    expect(worldFingerprint(state)).not.toBe(walkingFingerprint);
  });
});
