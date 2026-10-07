// tests/rpgkit-check-lint.test.ts — every static lint check must fire on a
// fixture broken exactly where the check says, and stay silent on a clean
// fixture. The example documents must be error-clean; their warnings and
// info findings are accepted as-is.

import { describe, expect, test } from "bun:test";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import type { CheckReport, Finding, FindingLocation } from "../tools/rpgkit-check/src/finding.ts";
import type { Project } from "../src/engine/types.ts";

function cleanProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Fixture",
    tileSize: 16,
    start: { map: "m1", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [{ id: "potion", name: "Potion", sprite: "grass.0" }],
    sprites: { npc: { kind: "image", src: "npc.png" } },
    maps: [
      {
        id: "m1",
        name: "M1",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
        events: [
          {
            id: "ev1",
            x: 2,
            y: 2,
            pages: [
              {
                trigger: "action",
                commands: [
                  { op: "switch", id: "s1", value: true },
                  { op: "if", if: { kind: "switch", id: "s1" }, then: [{ op: "text", lines: ["hi"] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function lint(project: Project): CheckReport {
  return lintProject(project);
}

function findingsOf(report: CheckReport, check: string): Finding[] {
  return report.findings.filter((f) => f.check === check);
}

function expectError(report: CheckReport, check: string, n = 1): void {
  const found = findingsOf(report, check);
  expect(found.length).toBe(n);
  expect(found.every((f) => f.severity === "error")).toBe(true);
}

/** Assert the check fired, and that every finding for it carries a loc and a
 *  non-empty suggestion. When `loc` is given, assert the first finding's loc
 *  carries those fields. Returns the first finding for further assertions. */
function expectFinding(
  report: CheckReport,
  check: string,
  loc?: Partial<FindingLocation>,
): Finding {
  const found = findingsOf(report, check);
  expect(found.length).toBeGreaterThanOrEqual(1);
  for (const f of found) {
    expect(f.severity === "error" || f.severity === "warning" || f.severity === "info").toBe(true);
    expect(f.suggestion.length).toBeGreaterThan(0);
    expect(Object.keys(f.loc).length).toBeGreaterThan(0);
  }
  const first = found[0]!;
  if (loc) {
    for (const [key, value] of Object.entries(loc)) {
      expect((first.loc as Record<string, unknown>)[key]).toEqual(value);
    }
  }
  return first;
}

/** The clean fixture must be completely silent. */
describe("rpgkit-check lint: clean fixture", () => {
  test("no findings on the clean fixture", () => {
    expect(lint(cleanProject()).findings).toEqual([]);
  });
});

describe("rpgkit-check lint: scene commands", () => {
  function sceneProject(): Project {
    const p = cleanProject();
    p.maps[0]!.events!.push({
      id: "scene-ev",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "action",
          commands: [
            {
              op: "scene",
              id: "game.journal",
              args: {},
              onDone: [{ op: "switch", id: "scene.done", value: true }],
              onCancel: [{ op: "switch", id: "scene.cancelled", value: true }],
            },
            {
              op: "if",
              if: { kind: "switch", id: "scene.done" },
              then: [{ op: "text", lines: ["logged"] }],
            },
          ],
        },
      ],
    });
    return p;
  }

  test("lists each scene id once as an info finding with its location", () => {
    const p = sceneProject();
    // A second command opening the same scene must not duplicate the finding.
    p.maps[0]!.events![1]!.pages[0]!.commands.push({ op: "scene", id: "game.journal", args: {} });
    const found = findingsOf(lint(p), "lint/scene-id");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("info");
    expect(found[0]!.message).toContain('"game.journal"');
    expect(found[0]!.loc).toMatchObject({ map: "m1", event: "scene-ev", page: 0, commandPath: [0] });
  });

  test("recurses scene onDone/onCancel branches for switch/variable usage", () => {
    const report = lint(sceneProject());
    // scene.done is set inside onDone and read by the sibling if: no
    // read-never-set finding (the walker descended into onDone).
    expect(findingsOf(report, "lint/switch-read-never-set").map((f) => f.message)).not.toContain(
      expect.stringContaining("scene.done"),
    );
    // scene.cancelled is set only inside onCancel: the set-never-read
    // finding proves the walker descended into onCancel.
    const dead = findingsOf(report, "lint/switch-set-never-read");
    expect(dead.some((f) => f.message.includes("scene.cancelled"))).toBe(true);
  });
});

describe("rpgkit-check lint: switch/variable usage", () => {
  test("switch read never set → warning", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "switch", id: "ghost" },
      then: [{ op: "text", lines: ["?"] }],
    });
    const f = findingsOf(lint(p), "lint/switch-read-never-set");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("switch declared writtenBy:\"host\" is not flagged read-never-set", () => {
    // The host/extension writes it at runtime: the document read is fine.
    const p = cleanProject();
    p.switches = [{ id: "ghost", name: "Ghost", writtenBy: "host" }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "switch", id: "ghost" },
      then: [{ op: "text", lines: ["?"] }],
    });
    const report = lint(p);
    expect(findingsOf(report, "lint/switch-read-never-set")).toEqual([]);
    expect(findingsOf(report, "lint/switch-hostwritten-also-set")).toEqual([]);
  });

  test("switch declared in the directory without the marker is still flagged", () => {
    // A bare catalog declaration does not prove the switch is ever written:
    // the directory must not become a blanket exemption, or typos hide.
    const p = cleanProject();
    p.switches = [{ id: "ghost", name: "Ghost" }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "switch", id: "ghost" },
      then: [{ op: "text", lines: ["?"] }],
    });
    const f = findingsOf(lint(p), "lint/switch-read-never-set");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("host-written switch also set by a document command → info hint", () => {
    // The marker is redundant while the document sets the switch: either the
    // marker or the set is probably a mistake. Info, never a warning.
    const p = cleanProject();
    p.switches = [{ id: "both", writtenBy: "host" }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push(
      { op: "switch", id: "both", value: true },
      { op: "if", if: { kind: "switch", id: "both" }, then: [{ op: "text", lines: ["?"] }] },
    );
    const report = lint(p);
    expect(findingsOf(report, "lint/switch-read-never-set")).toEqual([]);
    const hint = findingsOf(report, "lint/switch-hostwritten-also-set");
    expect(hint).toHaveLength(1);
    expect(hint[0]!.severity).toBe("info");
    expect(hint[0]!.message).toContain('"both"');
  });

  test("host-written switch set but never read → the redundancy hint replaces set-never-read", () => {
    const p = cleanProject();
    p.switches = [{ id: "written-only", writtenBy: "host" }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "switch", id: "written-only", value: true });
    const report = lint(p);
    expect(findingsOf(report, "lint/switch-set-never-read")).toEqual([]);
    const hint = findingsOf(report, "lint/switch-hostwritten-also-set");
    expect(hint).toHaveLength(1);
    expect(hint[0]!.severity).toBe("info");
  });

  test("switch set never read → info", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "switch", id: "dead", value: true });
    const f = findingsOf(lint(p), "lint/switch-set-never-read");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
  });

  test("variable read never set → info", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "variable", id: "v", op: ">=", value: 3 },
      then: [],
    });
    expect(findingsOf(lint(p), "lint/variable-read-never-set")).toHaveLength(1);
  });

  test("variable set never read → info", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "variable",
      id: "v",
      set: { op: "set", value: 1 },
    });
    expect(findingsOf(lint(p), "lint/variable-set-never-read")).toHaveLength(1);
  });

  test("variable op ref operand counts as a read", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push(
      { op: "variable", id: "v", set: { op: "set", value: 1 } },
      { op: "variable", id: "w", set: { op: "copy", from: "v" } },
    );
    // v is set and read (by the copy); w is set but never read.
    expect(findingsOf(lint(p), "lint/variable-read-never-set")).toEqual([]);
    expect(findingsOf(lint(p), "lint/variable-set-never-read")).toHaveLength(1);
  });

  test("KRM2 picture, timer and number-input operands count as live variable use", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push(
      { op: "variable", id: "picture.x", set: { op: "set", value: 12 } },
      { op: "variable", id: "picture.y", set: { op: "set", value: 34 } },
      {
        op: "showPicture",
        id: 1,
        layer: "picture",
        variant: "portrait",
        x: { variable: "picture.x" },
        y: { variable: "picture.y" },
      },
      { op: "timer", action: "read", variable: "remaining" },
      { op: "if", if: { kind: "variable", id: "remaining", op: "<=", value: 0 }, then: [] },
      { op: "inputNumber", variable: "answer", digits: 4 },
    );
    const report = lint(p);
    expect(findingsOf(report, "lint/variable-read-never-set")).toEqual([]);
    expect(findingsOf(report, "lint/variable-set-never-read")).toEqual([]);
  });
});

describe("rpgkit-check lint: pages", () => {
  test("self switch read never set → warning", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = { selfSwitch: "A" };
    const f = findingsOf(lint(p), "lint/selfswitch-read-never-set");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("self switch read and set within the event → silent", () => {
    const p = cleanProject();
    const ev = p.maps[0]!.events![0]!;
    ev.pages[0]!.condition = { selfSwitch: "A" };
    ev.pages.unshift({ trigger: "action", commands: [{ op: "selfSwitch", key: "A", value: true }] });
    expect(findingsOf(lint(p), "lint/selfswitch-read-never-set")).toEqual([]);
  });

  test("self switch read with value:false never set → silent (default state satisfies it)", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [{ kind: "selfSwitch", key: "B", value: false }],
    };
    expect(findingsOf(lint(p), "lint/selfswitch-read-never-set")).toEqual([]);
  });

  test("self switch required true but only written false → warning", () => {
    const p = cleanProject();
    const ev = p.maps[0]!.events![0]!;
    ev.pages[0]!.condition = { selfSwitch: "A" };
    ev.pages[0]!.commands.push({ op: "selfSwitch", key: "A", value: false });
    const f = findingsOf(lint(p), "lint/selfswitch-read-never-set");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("self switch set inside a called common event → silent", () => {
    const p = cleanProject();
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{ op: "selfSwitch", key: "A", value: true }],
    }];
    const ev = p.maps[0]!.events![0]!;
    ev.pages[0]!.condition = { selfSwitch: "A" };
    ev.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expect(findingsOf(lint(p), "lint/selfswitch-read-never-set")).toEqual([]);
  });

  test("page requiring two distinct self switches true → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "selfSwitch", key: "A", value: true },
        { kind: "selfSwitch", key: "B", value: true },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("page requiring A=true and B=false → silent (self=A satisfies both)", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "selfSwitch", key: "A", value: true },
        { kind: "selfSwitch", key: "B", value: false },
      ],
    };
    expect(findingsOf(lint(p), "lint/page-condition-contradiction")).toEqual([]);
  });

  test("contradictory page condition → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "switch", id: "a", value: true },
        { kind: "switch", id: "a", value: false },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("contradictory variable bounds → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "variable", id: "v", op: ">=", value: 5 },
        { kind: "variable", id: "v", op: "<=", value: 2 },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("earlier page shadowed by later unconditional page → error", () => {
    const p = cleanProject();
    const ev = p.maps[0]!.events![0]!;
    ev.pages[0]!.condition = { switch: "a" };
    ev.pages.push({ trigger: "action", commands: [] });
    expectError(lint(p), "lint/page-shadowed");
  });

  test("normal page progression (unconditional then conditional) → silent", () => {
    const p = cleanProject();
    const ev = p.maps[0]!.events![0]!;
    ev.pages[0]!.commands = [{ op: "selfSwitch", key: "A", value: true }];
    ev.pages.push({
      trigger: "action",
      condition: { selfSwitch: "A" },
      commands: [{ op: "text", lines: ["after"] }],
    });
    expect(findingsOf(lint(p), "lint/page-shadowed")).toEqual([]);
  });
});

describe("rpgkit-check lint: missing references", () => {
  test("start map missing → error", () => {
    const p = cleanProject();
    p.start = { map: "nope", x: 0, y: 0, dir: "down" };
    expectError(lint(p), "lint/start-map-missing");
  });

  test("start out of bounds → error", () => {
    const p = cleanProject();
    p.start = { map: "m1", x: 99, y: 99, dir: "down" };
    expectError(lint(p), "lint/start-map-missing");
  });

  test("transfer to unknown map → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "transfer",
      map: "nope",
      x: 0,
      y: 0,
    });
    expectError(lint(p), "lint/transfer-target-missing");
  });

  test("transfer out of bounds → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "transfer", map: "m1", x: 99, y: 0 });
    expectError(lint(p), "lint/transfer-target-missing");
  });

  test("place unknown event → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "place",
      target: { event: "nope" },
      x: 0,
      y: 0,
    });
    expectError(lint(p), "lint/place-target-missing");
  });

  test("place out of bounds → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "place", target: "this", x: 99, y: 0 });
    expectError(lint(p), "lint/place-target-missing");
  });

  test("moveRoute unknown event → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "moveRoute",
      target: { event: "nope" },
      route: { steps: [], repeat: false, skippable: false },
    });
    expectError(lint(p), "lint/route-target-missing");
  });

  test("common event missing → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "nope" });
    expectError(lint(p), "lint/common-event-missing");
  });

  test("common event present → silent", () => {
    const p = cleanProject();
    p.commonEvents = [{ id: "ce1", trigger: "none", commands: [{ op: "text", lines: ["x"] }] }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expect(findingsOf(lint(p), "lint/common-event-missing")).toEqual([]);
  });

  test("item op unknown item → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "item", item: "nope", set: "add", count: 1 });
    expectError(lint(p), "lint/item-missing");
  });

  test("shop selling unknown item → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "shop",
      id: "shop1",
      goods: [{ item: "nope" }],
    });
    expectError(lint(p), "lint/item-missing");
  });

  test("page sprite missing → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.sprite = "nope";
    expectError(lint(p), "lint/sprite-missing");
  });

  test("map sheet missing → error", () => {
    const p = cleanProject();
    p.maps[0]!.sheets = ["nope"];
    expectError(lint(p), "lint/sheet-missing");
  });

  test("tile sheet missing → error", () => {
    const p = cleanProject();
    p.maps[0]!.ground![0] = "nope.0";
    expectError(lint(p), "lint/sheet-missing");
  });

  test("item sprite sheet missing → error", () => {
    const p = cleanProject();
    p.items.push({ id: "bad", name: "Bad", sprite: "nope.0" });
    expectError(lint(p), "lint/sheet-missing");
  });

  test("duplicate event id → error", () => {
    const p = cleanProject();
    p.maps[0]!.events!.push({ id: "ev1", x: 0, y: 0, pages: [] });
    expectError(lint(p), "lint/event-id-duplicate");
  });

  test("duplicate map id → error", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m1",
      name: "M1 again",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
    });
    expectError(lint(p), "lint/map-id-duplicate");
  });

  test("upper-layer tile sheet missing → error", () => {
    const p = cleanProject();
    p.maps[0]!.upper = [[0, "nope.0"]];
    expectError(lint(p), "lint/sheet-missing");
  });

  test("walker source sheet is independent of project tile sheets → silent", () => {
    const p = cleanProject();
    p.sprites!["walker"] = { kind: "walker", sheet: "assets/sprites/walker.png" };
    expect(findingsOf(lint(p), "lint/sheet-missing")).toEqual([]);
  });

  test("page condition item unknown → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = { item: "nope" };
    expectError(lint(p), "lint/item-missing");
  });

  test("if condition item unknown → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "item", id: "nope", count: 1 },
      then: [],
    });
    expectError(lint(p), "lint/item-missing");
  });

  test("shop good condition item unknown → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "shop",
      id: "shop1",
      goods: [{ item: "potion", condition: { item: "nope" } }],
    });
    expectError(lint(p), "lint/item-missing");
  });

  test("item condition on a catalog item → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = { item: "potion" };
    expect(findingsOf(lint(p), "lint/item-missing")).toEqual([]);
  });

  test("transfer with literal x out of bounds and dynamic y → error", () => {
    const p = cleanProject();
    p.maps[0]!.width = 2;
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "transfer",
      map: "m1",
      x: 99,
      y: { variable: "y" },
    });
    expectError(lint(p), "lint/transfer-target-missing");
  });

  test("place in a common event with a unique caller map → error", () => {
    const p = cleanProject();
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{ op: "place", target: { event: "nope" }, x: 0, y: 0 }],
    }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expectError(lint(p), "lint/place-target-missing");
  });

  test("moveRoute in a common event with a unique caller map → error", () => {
    const p = cleanProject();
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{
        op: "moveRoute",
        target: { event: "nope" },
        route: { steps: [], repeat: false, skippable: false },
      }],
    }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expectError(lint(p), "lint/route-target-missing");
  });

  test("place in a nested common event (common calls common) with a unique caller map → error", () => {
    const p = cleanProject();
    p.commonEvents = [
      { id: "ce1", trigger: "none", commands: [{ op: "common", id: "ce2" }] },
      { id: "ce2", trigger: "none", commands: [{ op: "place", target: { event: "nope" }, x: 0, y: 0 }] },
    ];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    // ce2's only caller is ce1, whose only caller is m1 — the host map is
    // provably m1, so the unknown place target is caught.
    expectError(lint(p), "lint/place-target-missing");
  });

  test("place in a common event called from several maps → silent", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m2",
      name: "M2",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
      events: [{
        id: "ev2",
        x: 0,
        y: 0,
        pages: [{ trigger: "action", commands: [{ op: "common", id: "ce1" }] }],
      }],
    });
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{ op: "place", target: { event: "nope" }, x: 0, y: 0 }],
    }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expect(findingsOf(lint(p), "lint/place-target-missing")).toEqual([]);
  });

  test("place of a valid event → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "place",
      target: { event: "ev1" },
      x: 0,
      y: 0,
    });
    expect(findingsOf(lint(p), "lint/place-target-missing")).toEqual([]);
  });

  test("moveRoute at a valid event → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "moveRoute",
      target: { event: "ev1" },
      route: { steps: [], repeat: false, skippable: false },
    });
    expect(findingsOf(lint(p), "lint/route-target-missing")).toEqual([]);
  });

  test("appearance with unknown sprite → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "appearance",
      target: "this",
      sprite: "nope",
    });
    expectError(lint(p), "lint/sprite-missing");
  });

  test("appearance targeting an unknown event → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "appearance",
      target: { event: "nope" },
    });
    expectError(lint(p), "lint/appearance-target-missing");
  });

  test("appearance in a common event with a unique caller map → error", () => {
    const p = cleanProject();
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{ op: "appearance", target: { event: "nope" } }],
    }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expectError(lint(p), "lint/appearance-target-missing");
  });

  test("appearance with valid sprite and target → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "appearance",
      target: { event: "ev1" },
      sprite: "npc",
    });
    const report = lint(p);
    expect(findingsOf(report, "lint/sprite-missing")).toEqual([]);
    expect(findingsOf(report, "lint/appearance-target-missing")).toEqual([]);
  });

  test("tileProperty out of bounds → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "tileProperty",
      x: 99,
      y: 0,
      passage: "block",
    });
    expectError(lint(p), "lint/tileproperty-out-of-bounds");
  });

  test("tileProperty in bounds → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "tileProperty",
      x: 0,
      y: 0,
      passage: "block",
    });
    expect(findingsOf(lint(p), "lint/tileproperty-out-of-bounds")).toEqual([]);
  });

  test("findings carry a loc and a non-empty suggestion", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "transfer",
      map: "nope",
      x: 0,
      y: 0,
    });
    const f = expectFinding(lint(p), "lint/transfer-target-missing", { map: "m1", event: "ev1" });
    expect(f.loc.commandPath).toBeDefined();
  });
});

describe("rpgkit-check lint: declared audio references", () => {
  test("an omitted audio table leaves state-only audio references valid", () => {
    const p = cleanProject();
    const page = p.maps[0]!.events![0]!.pages[0]!;
    page.condition = { all: [{ kind: "bgmPlaying", id: "ambient" }] };
    page.commands.push(
      { op: "playBgm", id: "field" },
      { op: "playBgs", id: "rain" },
      { op: "playMe", id: "victory", duration: 1 },
      { op: "playSe", id: "door" },
      { op: "se", name: "legacy-cue" },
      { op: "if", if: { kind: "bgmPlaying", id: "field" }, then: [] },
    );
    expect(findingsOf(lint(p), "lint/audio-missing")).toEqual([]);
  });

  test("declared tables warn once per missing command and condition id at precise paths", () => {
    const p = cleanProject();
    p.audio = { field: "audio:wav.field" };
    const page = p.maps[0]!.events![0]!.pages[0]!;
    page.condition = { all: [{ kind: "bgmPlaying", id: "missing-page" }] };
    page.commands.push(
      { op: "playBgm", id: "field" },
      { op: "playBgs", id: "missing-bgs" },
      {
        op: "if",
        if: { kind: "bgmPlaying", id: "missing-if" },
        then: [{ op: "playMe", id: "missing-me", duration: 1 }],
      },
      {
        op: "choices",
        prompt: "sound?",
        options: [{ text: "yes", commands: [{ op: "playSe", id: "missing-se" }] }],
      },
      { op: "se", name: "legacy-cue" },
    );
    p.commonEvents = [{
      id: "audio-common",
      trigger: "none",
      commands: [{ op: "playBgm", id: "missing-common" }],
    }];

    const findings = findingsOf(lint(p), "lint/audio-missing");
    expect(findings).toHaveLength(6);
    // A declared table cannot say whether a missing id is supplied by a
    // partial host setup or is a typo. Preserve every reference for review,
    // with its exact location, without turning that ambiguity into an error.
    expect(findings.every((finding) => finding.severity === "warning")).toBe(true);
    expect(findings.map((finding) => finding.loc)).toContainEqual({
      map: "m1", event: "ev1", page: 0,
    });
    expect(findings.map((finding) => finding.loc.commandPath)).toContainEqual([3]);
    expect(findings.map((finding) => finding.loc.commandPath)).toContainEqual([4, "then", 0]);
    expect(findings.map((finding) => finding.loc.commandPath)).toContainEqual([5, "options", 0, 0]);
    expect(findings.map((finding) => finding.loc)).toContainEqual({
      common: "audio-common", commandPath: [0],
    });
  });

  test("declared ids and id-less bgmPlaying remain silent", () => {
    const p = cleanProject();
    p.audio = {
      field: "audio:wav.field",
      rain: "audio:wav.rain",
      victory: "audio:wav.victory",
      door: "audio:wav.door",
    };
    const page = p.maps[0]!.events![0]!.pages[0]!;
    page.condition = { all: [{ kind: "bgmPlaying" }] };
    page.commands.push(
      { op: "playBgm", id: "field" },
      { op: "playBgs", id: "rain" },
      { op: "playMe", id: "victory", duration: 1 },
      { op: "playSe", id: "door" },
    );
    expect(findingsOf(lint(p), "lint/audio-missing")).toEqual([]);
  });
});

describe("rpgkit-check lint: KV1 condition references", () => {
  test("appearance condition with a missing sprite → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [{ kind: "appearance", target: "player", sprite: "ghost" }],
    };
    expectError(lint(p), "lint/sprite-missing");
  });

  test("appearance condition with sprite:null → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [{ kind: "appearance", target: "player", sprite: null }],
    };
    expect(findingsOf(lint(p), "lint/sprite-missing")).toEqual([]);
  });

  test("appearance condition targeting an event not on the map → error", () => {
    const p = cleanProject();
    p.sprites!["hero"] = { kind: "image", src: "hero.png" };
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [{ kind: "appearance", target: { event: "ghost" }, sprite: "hero" }],
    };
    expectError(lint(p), "lint/appearance-target-missing");
  });

  test("appearance condition targeting player or this → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "appearance", target: "player", sprite: "npc" },
        { kind: "appearance", target: "this", sprite: "npc" },
      ],
    };
    const report = lint(p);
    expect(findingsOf(report, "lint/appearance-target-missing")).toEqual([]);
    expect(findingsOf(report, "lint/sprite-missing")).toEqual([]);
  });

  test("appearance condition in an if guard with a missing sprite → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "if",
      if: { kind: "appearance", target: "player", sprite: "ghost" },
      then: [],
    });
    expectError(lint(p), "lint/sprite-missing");
  });

  test("tileProperty condition out of bounds → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [{ kind: "tileProperty", x: 99, y: 99, passage: "block" }],
    };
    expectError(lint(p), "lint/tileproperty-out-of-bounds");
  });

  test("appearance conflict: same target, different sprites → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "appearance", target: "player", sprite: "npc" },
        { kind: "appearance", target: "player", sprite: null },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("appearance same target and same sprite → silent (redundant)", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "appearance", target: "player", sprite: "npc" },
        { kind: "appearance", target: "player", sprite: "npc" },
      ],
    };
    expect(findingsOf(lint(p), "lint/page-condition-contradiction")).toEqual([]);
  });

  test("appearance conflict on an event target → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "appearance", target: { event: "ev1" }, sprite: "npc" },
        { kind: "appearance", target: { event: "ev1" }, sprite: null },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("tileProperty conflict: same cell, passage pass vs block → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "tileProperty", x: 0, y: 0, passage: "pass" },
        { kind: "tileProperty", x: 0, y: 0, passage: "block" },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("tileProperty conflict: same cell, enter masks differ → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "tileProperty", x: 0, y: 0, enter: ["down"] },
        { kind: "tileProperty", x: 0, y: 0, enter: ["down", "left"] },
      ],
    };
    expectError(lint(p), "lint/page-condition-contradiction");
  });

  test("tileProperty same cell, same field expectations → silent (redundant)", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "tileProperty", x: 0, y: 0, passage: "block", enter: ["down"] },
        { kind: "tileProperty", x: 0, y: 0, passage: "block", enter: ["down"] },
      ],
    };
    expect(findingsOf(lint(p), "lint/page-condition-contradiction")).toEqual([]);
  });

  test("tileProperty on different cells → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "tileProperty", x: 0, y: 0, passage: "pass" },
        { kind: "tileProperty", x: 1, y: 1, passage: "block" },
      ],
    };
    expect(findingsOf(lint(p), "lint/page-condition-contradiction")).toEqual([]);
  });

  test("valid appearance and in-bounds tileProperty conditions → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.condition = {
      all: [
        { kind: "appearance", target: "player", sprite: "npc" },
        { kind: "tileProperty", x: 0, y: 0, passage: "block" },
      ],
    };
    expect(lint(p).findings).toEqual([]);
  });
});

describe("rpgkit-check lint: branches and reachability", () => {
  test("choices with no options and no cancel → error", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "choices", prompt: "?", options: [] });
    expectError(lint(p), "lint/choices-empty");
  });

  test("choices with cancel only → silent", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "choices",
      prompt: "?",
      options: [],
      cancel: { commands: [] },
    });
    expect(findingsOf(lint(p), "lint/choices-empty")).toEqual([]);
  });

  test("choices where every branch is empty → warning", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "choices",
      prompt: "?",
      options: [
        { text: "a", commands: [] },
        { text: "b", commands: [] },
      ],
    });
    const f = findingsOf(lint(p), "lint/choices-empty");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("choices where one option is empty → warning naming the index", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "choices",
      prompt: "?",
      options: [
        { text: "a", commands: [{ op: "text", lines: ["a"] }] },
        { text: "b", commands: [] },
      ],
    });
    const f = findingsOf(lint(p), "lint/choices-empty");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.message).toContain("1");
  });

  test("choices where one option is empty but the cancel acts → warning", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "choices",
      prompt: "?",
      options: [
        { text: "a", commands: [{ op: "text", lines: ["a"] }] },
        { text: "b", commands: [] },
      ],
      cancel: { commands: [{ op: "text", lines: ["c"] }] },
    });
    const f = findingsOf(lint(p), "lint/choices-empty");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.message).toContain("1");
  });

  test("choices where every option is empty but the cancel acts → warning", () => {
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "choices",
      prompt: "?",
      options: [
        { text: "a", commands: [] },
        { text: "b", commands: [] },
      ],
      cancel: { commands: [{ op: "text", lines: ["c"] }] },
    });
    const f = findingsOf(lint(p), "lint/choices-empty");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.message).toContain("only the cancel branch has commands");
  });

  test("map never transferred to → warning", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m2",
      name: "M2",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
    });
    const f = findingsOf(lint(p), "lint/map-unreachable");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("map reached by a literal transfer → silent", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m2",
      name: "M2",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
    });
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "transfer", map: "m2", x: 0, y: 0 });
    expect(findingsOf(lint(p), "lint/map-unreachable")).toEqual([]);
  });

  test("map reached only through a common-event transfer → silent", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m2",
      name: "M2",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
    });
    p.commonEvents = [{
      id: "ce1",
      trigger: "none",
      commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }],
    }];
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "common", id: "ce1" });
    expect(findingsOf(lint(p), "lint/map-unreachable")).toEqual([]);
  });

  test("map with only a self-loop transfer → unreachable warning", () => {
    const p = cleanProject();
    p.maps.push({
      id: "m2",
      name: "M2",
      width: 5,
      height: 5,
      sheets: ["grass"],
      ground: new Array<string>(25).fill("grass.0"),
      events: [{
        id: "loop",
        x: 0,
        y: 0,
        pages: [{
          trigger: "action",
          commands: [{ op: "transfer", map: "m2", x: 0, y: 0 }],
        }],
      }],
    });
    const f = findingsOf(lint(p), "lint/map-unreachable");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warning");
  });

  test("map behind a chain of transfers → silent", () => {
    const p = cleanProject();
    p.maps.push(
      {
        id: "m2",
        name: "M2",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
        events: [{
          id: "go",
          x: 0,
          y: 0,
          pages: [{
            trigger: "action",
            commands: [{ op: "transfer", map: "m3", x: 0, y: 0 }],
          }],
        }],
      },
      {
        id: "m3",
        name: "M3",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
      },
    );
    p.maps[0]!.events![0]!.pages[0]!.commands.push({ op: "transfer", map: "m2", x: 0, y: 0 });
    expect(findingsOf(lint(p), "lint/map-unreachable")).toEqual([]);
  });
});

describe("rpgkit-check lint: {x:key} text tokens", () => {
  /** The clean fixture with its page commands replaced by token-bearing
   *  text/choices; `system` sets the project's resolver allowlist. */
  function withTokens(system?: Project["system"]): Project {
    const p = cleanProject();
    p.system = system;
    p.maps[0]!.events![0]!.pages[0]!.commands = [
      { op: "text", lines: ["Today is {x:date}.", "Again {x:date} and {x:map}."] },
      {
        op: "choices",
        prompt: "{x:gold}",
        options: [{ text: "{x:unknown}", commands: [] }],
      },
    ];
    return p;
  }

  test("without a declared allowlist, the key check is off and the opt-in warning fires", () => {
    const report = lint(withTokens());
    expect(findingsOf(report, "lint/text-token-unknown")).toEqual([]);
    // The declaration is the runtime opt-in: without it {x:…} prints
    // verbatim, so each command carrying a token gets one off-warning.
    const off = findingsOf(report, "lint/text-token-off");
    expect(off.map((f) => f.severity)).toEqual(["warning", "warning"]);
    expect(off.map((f) => f.loc.commandPath)).toEqual([[0], [1]]);
    expect(off.every((f) => f.suggestion.length > 0)).toBe(true);
  });

  test("a declared allowlist warns once per unknown key per command", () => {
    const report = lint(withTokens({ textTokens: ["date"] }));
    const unknown = findingsOf(report, "lint/text-token-unknown");
    expect(unknown.map((f) => f.severity)).toEqual(["warning", "warning", "warning"]);
    expect(unknown.map((f) => f.message)).toEqual([
      expect.stringContaining("{x:map}"),
      expect.stringContaining("{x:gold}"),
      expect.stringContaining("{x:unknown}"),
    ]);
    // The choices command carries both the prompt and the option label, so
    // both findings point at the command's path.
    expect(unknown.map((f) => f.loc.commandPath)).toEqual([[0], [1], [1]]);
    expect(unknown.every((f) => f.suggestion.length > 0)).toBe(true);
    // Declared: the opt-in warning stays silent.
    expect(findingsOf(report, "lint/text-token-off")).toEqual([]);
  });

  test("every key listed stays silent", () => {
    const report = lint(withTokens({ textTokens: ["date", "map", "gold", "unknown"] }));
    expect(findingsOf(report, "lint/text-token-unknown")).toEqual([]);
    expect(findingsOf(report, "lint/text-token-off")).toEqual([]);
  });

  test("an empty allowlist warns on every key", () => {
    const report = lint(withTokens({ textTokens: [] }));
    expect(findingsOf(report, "lint/text-token-unknown").map((f) => f.loc.commandPath))
      .toEqual([[0], [0], [1], [1]]);
    expect(findingsOf(report, "lint/text-token-off")).toEqual([]);
  });

  test("extChoice prompts are checked like text and choices", () => {
    // The checker's extChoice branch was untested (a green mutation deleted
    // it without red): pin both the off-warning and the unknown-key warning
    // for an extChoice prompt carrying {x:}.
    const p = cleanProject();
    p.maps[0]!.events![0]!.pages[0]!.commands = [
      { op: "extChoice", call: "game.party", prompt: "Lead: {x:leader}", args: {} },
    ];
    const off = findingsOf(lint(p), "lint/text-token-off");
    expect(off.map((f) => f.loc.commandPath)).toEqual([[0]]);
    expect(off[0]?.message).toContain("{x:leader}");
    p.system = { textTokens: ["leader"] };
    expect(findingsOf(lint(p), "lint/text-token-unknown")).toEqual([]);
    expect(findingsOf(lint(p), "lint/text-token-off")).toEqual([]);
    p.system = { textTokens: ["other"] };
    const unknown = findingsOf(lint(p), "lint/text-token-unknown");
    expect(unknown.map((f) => f.loc.commandPath)).toEqual([[0]]);
    expect(unknown[0]?.message).toContain("{x:leader}");
  });
});

describe("rpgkit-check lint: example documents", () => {
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
    "examples/grow/data/grow-settlement.json",
  ]) {
    test(`${path} is error-clean`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      const report = lint(loaded.project!);
      const errors = report.findings.filter((f) => f.severity === "error");
      if (errors.length > 0) {
        console.log(`${path} lint findings:`, JSON.stringify(report.findings, null, 2));
      }
      expect(errors).toEqual([]);
    });
  }
});
