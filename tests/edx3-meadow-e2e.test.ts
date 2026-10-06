// EDX3 acceptance: the six Meadow requirements from the EDOG 2558 field test,
// all completed through proposals and accepted. The two requirements that were
// downgraded there now complete for real: the east grassland is a NEW map
// (add-map + connect-maps, not a same-map extension) with a registered sheep
// sprite, and the lantern swap is a two-page day/night sprite change with both
// sprites registered, so QA can verify every reference.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "../src/engine/types.ts";
import { runProposalFileCommand } from "../editor/api/proposals.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.edx3-meadow-${process.pid}-${randomUUID()}`);
const MEADOW = join(ROOT, "examples/meadow/data/meadow.json");
const NPC_ART = join(ROOT, "examples/sunstone/assets/npc");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

/** The fixture is exactly the unmodified Meadow project. Requirement-owned
 * catalog entries, sprite registrations, and PNG bytes all enter later via
 * the same proposals as the events that reference them. */
function fixture(): string {
  const dir = join(TEMP, "game");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "game.json");
  writeFileSync(file, readFileSync(MEADOW));
  return file;
}

function asset(file: string) {
  return {
    type: "image/png",
    data: readFileSync(join(NPC_ART, file)).toString("base64"),
  };
}

function accept(file: string, request: unknown): void {
  const id = (request as { id: string }).id;
  const created = runProposalFileCommand({ command: "propose", file, args: request });
  expect(created).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
  const accepted = runProposalFileCommand({ command: "accept-proposal", file, args: { id, source: "edx3-e2e" } });
  expect(accepted).toMatchObject({ ok: true, result: { status: "accepted", qa: { errors: 0 } } });
}

const text = (lines: string[]) => ({ op: "text", lines });

describe("EDOG 2558's six Meadow requirements, end to end through proposals", () => {
  test("all six are proposed and accepted; the two downgraded ones complete for real", () => {
    const file = fixture();
    const assetRoot = join(file, "..", "assets/npc");
    expect(existsSync(assetRoot)).toBe(false);

    // Requirement 4 first: it grows the map set, so the event-only proposals
    // that follow are diffed against the new structure.
    accept(file, {
      id: "req-04-east-grassland",
      title: "East grassland with a wandering sheep",
      rationale: "A new map east of the village, connected through the wall gap, with a sheep.",
      author: "villager",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "east-map",
        summary: "Add east-meadow, open the wall, wire both transfers, place the sheep",
        operations: [
          { command: "add-asset", args: { path: "assets/npc/sheep.png", ...asset("slime.png") } },
          { command: "add-sprite", args: { id: "sheep", sprite: { kind: "image", src: "assets/npc/sheep.png" } } },
          { command: "add-map", args: { map: "east-meadow", name: "East Meadow", width: 12, height: 12, sheets: ["town"], fill: "town.0" } },
          { command: "paint-tile", args: { map: "meadow", layer: "upper", x: 19, y: 7, tile: null } },
          { command: "paint-passage", args: { map: "meadow", x: 19, y: 7, value: null } },
          { command: "connect-maps", args: { map: "meadow", x: 19, y: 7, targetMap: "east-meadow", targetX: 0, targetY: 7, eventId: "east-exit" } },
          { command: "connect-maps", args: { map: "east-meadow", x: 0, y: 7, targetMap: "meadow", targetX: 19, targetY: 7, eventId: "west-exit" } },
          {
            command: "add-event",
            args: {
              map: "east-meadow",
              event: {
                id: "wandering-sheep", name: "Wandering Sheep", x: 5, y: 6,
                pages: [{ trigger: "action", sprite: "sheep", moveType: "random", commands: [text(["Baa!"])] }],
              },
            },
          },
        ],
      }],
    });

    // Requirement 1: the potion uncle at the inn door.
    accept(file, {
      id: "req-01-potion-uncle",
      title: "Potion uncle by the inn",
      rationale: "A merchant sells potions for 30 gold and does not buy.",
      author: "villager",
      createdAt: "2026-10-05T12:01:00.000Z",
      hunks: [{
        id: "uncle",
        summary: "Add the potion shopkeeper",
        operations: [
          { command: "add-asset", args: { path: "assets/npc/potion-uncle.png", ...asset("merchant.png") } },
          { command: "add-sprite", args: { id: "potion-uncle", sprite: { kind: "image", src: "assets/npc/potion-uncle.png" } } },
          {
            command: "add-event",
            args: {
              map: "meadow",
              event: {
                id: "inn-potion-uncle", name: "Potion Uncle", x: 14, y: 6,
                pages: [{
                  trigger: "action",
                  sprite: "potion-uncle",
                  commands: [
                    text(["Fine potions, only 30 gold!"]),
                    { op: "shop", id: "inn-potion-shop", goods: [{ item: "potion", price: 30 }], sell: false },
                  ],
                }],
              },
            },
          },
        ],
      }],
    });

    // Requirement 2: a real key-item catalog entry, grant, condition and
    // one-time consume — no switch standing in for inventory state.
    accept(file, {
      id: "req-02-keyed-door",
      title: "Well key and locked inn door",
      rationale: "Fetch the village key from the well; the inn door opens once.",
      author: "villager",
      createdAt: "2026-10-05T12:02:00.000Z",
      hunks: [{
        id: "key-and-door",
        summary: "Add the well-key gift and the three-page door",
        operations: [
          {
            command: "add-item",
            args: { item: { id: "village-key", name: "Village Key", sprite: "town.108", type: "key", sellable: false } },
          },
          {
            command: "add-event",
            args: {
              map: "meadow",
              event: {
                id: "well-key", name: "Old Well", x: 3, y: 9,
                pages: [
                  { trigger: "playerTouch", commands: [text(["You found the village key!"]), { op: "item", item: "village-key", set: "add", count: 1 }, { op: "selfSwitch", key: "A", value: true }] },
                  { condition: { selfSwitch: "A" }, trigger: "action", commands: [text(["The well is quiet now."])] },
                ],
              },
            },
          },
          {
            command: "add-event",
            args: {
              map: "meadow",
              event: {
                id: "locked-inn-door", name: "Inn Door", x: 10, y: 1,
                pages: [
                  { trigger: "action", commands: [text(["The door is locked. You need a key."])] },
                  { condition: { item: "village-key" }, trigger: "action", commands: [text(["The key fits!"]), { op: "item", item: "village-key", set: "sub", count: 1 }, { op: "selfSwitch", key: "A", value: true }] },
                  { condition: { selfSwitch: "A" }, trigger: "action", blocks: false, commands: [text(["The door stands open."])] },
                ],
              },
            },
          },
        ],
      }],
    });

    // Requirement 3: the elder's first-visit greeting.
    accept(file, {
      id: "req-03-elder-greeting",
      title: "Village elder greeting",
      rationale: "A welcome the first time, a farewell afterwards.",
      author: "villager",
      createdAt: "2026-10-05T12:03:00.000Z",
      hunks: [{
        id: "elder",
        summary: "Add the two-page elder",
        operations: [{
          command: "add-event",
          args: {
            map: "meadow",
            event: {
              id: "village-elder", name: "Village Elder", x: 6, y: 5,
              pages: [
                { trigger: "action", commands: [text(["Welcome to Kit Meadow, traveler!"]), { op: "selfSwitch", key: "A", value: true }] },
                { condition: { selfSwitch: "A" }, trigger: "action", commands: [text(["Safe travels."])] },
              ],
            },
          },
        }],
      }],
    });

    // Requirement 5: nightfall lights the village lantern (day/night pages).
    accept(file, {
      id: "req-05-night-lantern",
      title: "Nightfall lantern",
      rationale: "When night falls, the village lantern swaps to its lit image.",
      author: "villager",
      createdAt: "2026-10-05T12:04:00.000Z",
      hunks: [{
        id: "night-and-lantern",
        summary: "Add the nightfall switch and the two-page lantern",
        operations: [
          { command: "add-asset", args: { path: "assets/npc/lantern-off.png", ...asset("runestone.png") } },
          { command: "add-asset", args: { path: "assets/npc/lantern-on.png", ...asset("runestone-lit.png") } },
          { command: "add-sprite", args: { id: "lantern-off", sprite: { kind: "image", src: "assets/npc/lantern-off.png" } } },
          { command: "add-sprite", args: { id: "lantern-on", sprite: { kind: "image", src: "assets/npc/lantern-on.png" } } },
          {
            command: "add-event",
            args: {
              map: "meadow",
              event: {
                id: "nightfall-switch", name: "Dusk", x: 5, y: 7,
                pages: [
                  { trigger: "action", commands: [text(["Night falls over the village."]), { op: "switch", id: "night-mode", value: true }, { op: "selfSwitch", key: "A", value: true }] },
                  { condition: { selfSwitch: "A" }, trigger: "parallel", commands: [] },
                ],
              },
            },
          },
          {
            command: "add-event",
            args: {
              map: "meadow",
              event: {
                id: "village-lantern", name: "Village Lantern", x: 1, y: 7,
                pages: [
                  { trigger: "action", sprite: "lantern-off", commands: [text(["An unlit stone lantern."])] },
                  { condition: { switch: "night-mode" }, trigger: "action", sprite: "lantern-on", commands: [text(["The lantern glows warmly."])] },
                ],
              },
            },
          },
        ],
      }],
    });

    // Requirement 6: the first-entry opening, autorun once.
    accept(file, {
      id: "req-06-first-entry-opening",
      title: "First entry opening",
      rationale: "Two opening lines on first entry, never again.",
      author: "villager",
      createdAt: "2026-10-05T12:05:00.000Z",
      hunks: [{
        id: "opening",
        summary: "Add the one-shot autorun opening",
        operations: [{
          command: "add-event",
          args: {
            map: "meadow",
            event: {
              id: "village-opening", name: "Opening", x: 0, y: 0,
              pages: [
                { trigger: "autorun", commands: [text(["KIT MEADOW", "A village wakes at dawn."]), { op: "selfSwitch", key: "A", value: true }] },
                { condition: { selfSwitch: "A" }, trigger: "parallel", commands: [] },
              ],
            },
          },
        }],
      }],
    });

    // Final state: every requirement is in the accepted project.
    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    const meadow = project.maps.find((m) => m.id === "meadow")!;
    const east = project.maps.find((m) => m.id === "east-meadow");

    // Req 4 truly completes: a REAL new map, connected both ways, with a sheep.
    expect(east).toBeDefined();
    expect(east!.width).toBe(12);
    expect(east!.height).toBe(12);
    const eastExit = meadow.events?.find((e) => e.id === "east-exit");
    const westExit = east!.events?.find((e) => e.id === "west-exit");
    expect(eastExit?.pages[0]?.commands[0]).toMatchObject({ op: "transfer", map: "east-meadow", x: 0, y: 7 });
    expect(westExit?.pages[0]?.commands[0]).toMatchObject({ op: "transfer", map: "meadow", x: 19, y: 7 });
    const sheep = east!.events?.find((e) => e.id === "wandering-sheep");
    expect(sheep?.pages[0]?.sprite).toBe("sheep");
    expect(sheep?.pages[0]?.moveType).toBe("random");
    expect(project.sprites?.sheep).toEqual({ kind: "image", src: "assets/npc/sheep.png" });
    expect(readFileSync(join(assetRoot, "sheep.png"))).toEqual(readFileSync(join(NPC_ART, "slime.png")));

    // Req 1: the shopkeeper with a 30-gold, no-sell shop.
    const uncle = meadow.events?.find((e) => e.id === "inn-potion-uncle");
    expect(uncle?.pages[0]?.sprite).toBe("potion-uncle");
    const shop = uncle?.pages[0]?.commands.find((c) => c.op === "shop");
    expect(shop).toMatchObject({ id: "inn-potion-shop", goods: [{ item: "potion", price: 30 }], sell: false });
    expect(project.sprites?.["potion-uncle"]).toEqual({ kind: "image", src: "assets/npc/potion-uncle.png" });
    expect(readFileSync(join(assetRoot, "potion-uncle.png"))).toEqual(readFileSync(join(NPC_ART, "merchant.png")));

    // Req 2: the well grants and the door consumes a real key item.
    expect(project.items).toContainEqual({
      id: "village-key", name: "Village Key", sprite: "town.108", type: "key", sellable: false,
    });
    const well = meadow.events?.find((e) => e.id === "well-key");
    expect(well?.pages[0]?.commands).toContainEqual({ op: "item", item: "village-key", set: "add", count: 1 });
    const door = meadow.events?.find((e) => e.id === "locked-inn-door");
    expect(door?.pages).toHaveLength(3);
    expect(door?.pages[1]?.condition?.item).toBe("village-key");
    expect(door?.pages[1]?.commands).toContainEqual({ op: "item", item: "village-key", set: "sub", count: 1 });
    expect(door?.pages[2]?.blocks).toBe(false);

    // Req 3: the two-page elder.
    const elder = meadow.events?.find((e) => e.id === "village-elder");
    expect(elder?.pages).toHaveLength(2);
    expect(elder?.pages[1]?.condition?.selfSwitch).toBe("A");

    // Req 5 truly completes: the lantern swaps to a REGISTERED lit sprite.
    const lantern = meadow.events?.find((e) => e.id === "village-lantern");
    expect(lantern?.pages[0]?.sprite).toBe("lantern-off");
    expect(lantern?.pages[1]?.condition?.switch).toBe("night-mode");
    expect(lantern?.pages[1]?.sprite).toBe("lantern-on");
    expect(project.sprites?.["lantern-on"]).toBeDefined();
    expect(project.sprites?.["lantern-off"]).toBeDefined();
    expect(readFileSync(join(assetRoot, "lantern-off.png"))).toEqual(readFileSync(join(NPC_ART, "runestone.png")));
    expect(readFileSync(join(assetRoot, "lantern-on.png"))).toEqual(readFileSync(join(NPC_ART, "runestone-lit.png")));

    // Req 6: the one-shot autorun opening.
    const opening = meadow.events?.find((e) => e.id === "village-opening");
    expect(opening?.pages[0]?.trigger).toBe("autorun");
    expect(opening?.pages[1]?.trigger).toBe("parallel");

    // Static QA is clean on the finished village (0 errors; the new map is
    // reachable through the literal transfers).
    const report = lintProject(project);
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
    expect(report.findings.some((f) => f.check === "lint/map-unreachable")).toBe(false);

    // All six proposals are archived as accepted.
    const history = runProposalFileCommand({ command: "list-archive", file });
    expect(history).toMatchObject({ ok: true });
    const entries = (history as { result: { id: string; status: string }[] }).result;
    expect(entries.map((e) => e.id).sort()).toEqual([
      "req-01-potion-uncle",
      "req-02-keyed-door",
      "req-03-elder-greeting",
      "req-04-east-grassland",
      "req-05-night-lantern",
      "req-06-first-entry-opening",
    ]);
    expect(entries.every((e) => e.status === "accepted")).toBe(true);
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [] });
  });
});
