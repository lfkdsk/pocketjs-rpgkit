// tests/rpgmaker-import.test.ts — the RPG Maker MV/MZ importer end to end
// on the two self-written fixture projects (tests/fixtures/rpgmaker):
// schema-valid output, byte-stable files, the CLI, coverage accounting, the
// generated tile sheets' passage, and the committed play fixture
// (tests/fixtures/rmi-play/games.ts) staying in step with the importer.
// The keyed playthroughs are in rpgmaker-import-journey.test.ts.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import schema from "../src/data/schema.json";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { QoaFile } from "../src/ui/audio/qoa.ts";
import { buildPassage, canStepFrom } from "../src/engine/passability.ts";
import { mapForTileset, parseTileId } from "../src/engine/tiles.ts";
import type { Command, Project } from "../src/engine/types.ts";
import { RM_COMMANDS } from "../tools/rpgmaker-import/catalog.ts";
import { itemId } from "../tools/rpgmaker-import/ids.ts";
import { importToDirectory } from "../tools/rpgmaker-import/index.ts";
import { loadRmProject, RmLoadError } from "../tools/rpgmaker-import/load.ts";
import { importRmProject, invertInitialParty, type ImportResult } from "../tools/rpgmaker-import/project.ts";
import type { RmCommand, RmProject } from "../tools/rpgmaker-import/rm-types.ts";
import { commandTableLines, staticCommandTable } from "../tools/rpgmaker-import/report.ts";
import { readPng, writePngBytes } from "../tools/rpgmaker-import/png.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { RMI_GAMES } from "./fixtures/rmi-play/games.ts";

const ROOT = join(import.meta.dir, "..");
const HOLLOW = join(ROOT, "tests/fixtures/rpgmaker/hollow-mz");
const STAGE = join(ROOT, "tests/fixtures/rpgmaker/stage-mv");
const WINDOW_PALETTE = join(HOLLOW, "test-art/Window.png");
const SCRATCH_ROOT = "/var/tmp/fleet/4306";
mkdirSync(SCRATCH_ROOT, { recursive: true });

const CUSTOM_WINDOW_COLOURS = [
  "#102030", "#214365", "#32659A", "#4387CF", "#54A904", "#65CB39", "#76ED6E", "#870FA3",
  "#9831D8", "#A9530D", "#BA7542", "#CB9777", "#DCB9AC", "#EDDBE1", "#FEFD16", "#0F1F4B",
  "#204180", "#3163B5", "#4285EA", "#53A71F", "#64C954", "#75EB89", "#860DBE", "#972FF3",
  "#A85128", "#B9735D", "#CA9592", "#DBB7C7", "#ECD9FC", "#FDFB31", "#0E1D66", "#1F3F9B",
];

const hollow = await importRmProject(loadRmProject(HOLLOW));
const stage = await importRmProject(loadRmProject(STAGE));

function files(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

function pixel(image: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

function tilePixels(result: ImportResult, id: string): Buffer {
  const { sheet, cell } = parseTileId(id);
  const meta = result.assets.sheets[sheet]!;
  const image = result.images.get(meta.png)!;
  const x0 = (cell % meta.cols) * 16;
  const y0 = Math.floor(cell / meta.cols) * 16;
  const out = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    const from = ((y0 + y) * image.width + x0) * 4;
    out.set(image.data.subarray(from, from + 16 * 4), y * 16 * 4);
  }
  return out;
}

function allCommands(project: Project): { op: string }[] {
  const out: { op: string }[] = [];
  const visit = (list: readonly unknown[]): void => {
    for (const c of list as Record<string, unknown>[]) {
      out.push(c as { op: string });
      for (const key of ["commands", "then", "else", "onWin", "onLose", "onEscape", "onDone", "onCancel"]) {
        if (Array.isArray(c[key])) visit(c[key] as unknown[]);
      }
      if (c.op === "choices") {
        for (const o of c.options as { commands: unknown[] }[]) visit(o.commands);
        if (c.cancel) visit((c.cancel as { commands: unknown[] }).commands);
      }
    }
  };
  for (const map of project.maps) for (const ev of map.events ?? []) for (const p of ev.pages) visit(p.commands);
  for (const ce of project.commonEvents ?? []) visit(ce.commands);
  return out;
}

describe("rpgmaker-import: output", () => {
  for (const [name, result] of [["hollow-mz", hollow], ["stage-mv", stage]] as const) {
    test(`${name}: the project validates against the kit schema`, () => {
      expect(validateSchema(result.project, schema as Record<string, unknown>)).toEqual([]);
    });

    test(`${name}: visual extensions do not produce checker errors`, () => {
      expect(lintProject(result.project).findings.filter((finding) => finding.severity === "error")).toEqual([]);
    });
  }

  test("maps, sheets and start come from the RM data", () => {
    expect(hollow.project.maps.map((m) => [m.id, m.width, m.height])).toEqual([
      ["map001", 24, 16],
      ["map002", 13, 10],
      ["map003", 20, 15],
    ]);
    expect(hollow.project.start).toEqual({ map: "map001", x: 11, y: 9, dir: "down" });
    expect(hollow.project.playerName).toBe("Wren");
    expect(hollow.project.actors).toEqual([
      {
        id: "actor001", databaseId: 1, name: "Wren", classId: "class001",
        skills: ["skill001"], weapons: ["weapon001"], armors: ["armor001"],
      },
      {
        id: "actor002", databaseId: 2, name: "Moss", classId: "class001",
        skills: ["skill001"], weapons: ["weapon002"],
      },
    ]);
    expect(hollow.project.system?.rpgMakerText).toEqual({ party: [1], currencyUnit: "G" });
    expect(hollow.project.sheets.map((s) => s.id)).toEqual(["ts1", "ts2", "ts3", "iconset"]);
    // MV is 48 px: composed at 48 and averaged down, every sheet is 16 px.
    expect(stage.project.maps.map((m) => [m.id, m.width, m.height])).toEqual([["map001", 17, 13]]);
    expect(stage.project.sheets.map((s) => s.id)).toEqual(["ts1", "iconset"]);
    for (const r of [hollow, stage]) {
      for (const sheet of r.project.sheets) {
        const img = r.images.get(`tiles/${sheet.id}.png`)!;
        expect([img.width, img.height]).toEqual([sheet.cols * 16, sheet.rows * 16]);
      }
    }
  });

  test("actor facts reproduce initial class, learned skills and equipment", async () => {
    const rm = loadRmProject(HOLLOW);
    const extraSkills = [
      { id: 2, name: "Guard", note: "" },
      { id: 3, name: "Focus", note: "" },
    ];
    const mutated: RmProject = {
      ...rm,
      skills: [...rm.skills, ...extraSkills],
      classes: rm.classes.map((entry) => entry?.id === 1
        ? { ...entry, learnings: [...entry.learnings, { level: 2, skillId: 2, note: "" }] }
        : entry),
      weapons: rm.weapons.map((entry) => entry?.id === 1
        ? { ...entry, traits: [...(entry.traits ?? []), { code: 43, dataId: 3, value: 0 }] }
        : entry),
      actors: rm.actors.map((entry) => entry?.id === 1
        ? {
            ...entry,
            equips: [1, 2, 0, 1, 0],
            traits: [...entry.traits, { code: 55, dataId: 1, value: 0 }],
          }
        : entry),
    };
    const imported = await importRmProject(mutated);
    expect(imported.project.actors?.[0]).toEqual({
      id: "actor001",
      databaseId: 1,
      name: "Wren",
      classId: "class001",
      // Skill 2 is above the actor's level and stays absent; skill 3 comes
      // from the equipped staff's TRAIT_SKILL_ADD.
      skills: ["skill001", "skill003"],
      // TRAIT_SLOT_TYPE dual wield makes the second equip a weapon. The
      // fourth equip keeps its ordinary body-armor slot.
      weapons: ["weapon001", "weapon002"],
      armors: ["armor001"],
    });
  });

  test("fixture actor branches import every database-backed predicate", async () => {
    const rm = loadRmProject(HOLLOW);
    const branch = (subtype: number, value: string | number): RmCommand[] => [
      { code: 111, indent: 0, parameters: [4, 1, subtype, value] },
      { code: 121, indent: 1, parameters: [20, 20, 0] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
    ];
    rm.commonEvents = [
      ...rm.commonEvents,
      {
        id: 3,
        name: "Actor facts",
        trigger: 0,
        switchId: 0,
        list: [
          ...branch(1, "Wren"),
          ...branch(2, 1),
          ...branch(3, 1),
          ...branch(4, 1),
          ...branch(5, 1),
          ...branch(6, 1),
          { code: 0, indent: 0, parameters: [] },
        ],
      },
    ];
    const imported = await importRmProject(rm);
    const conditions = allCommands(imported.project)
      .filter((command) => command.op === "if")
      .map((command) => (command as Command & { if: unknown }).if)
      .filter((condition) => (condition as { kind?: string }).kind === "actor");
    expect(conditions).toEqual([
      { kind: "actor", actor: "actor001", test: "name", value: "Wren" },
      { kind: "actor", actor: "actor001", test: "class", value: "class001" },
      { kind: "actor", actor: "actor001", test: "skill", value: "skill001" },
      { kind: "actor", actor: "actor001", test: "weapon", value: "weapon001" },
      { kind: "actor", actor: "actor001", test: "armor", value: "armor001" },
      { kind: "actor", actor: "actor001", test: "state", value: "state001" },
    ]);
    expect(imported.cov.list("condition").find((row) => row.key === "actor")?.counts).toMatchObject({
      Native: 1,
      Degraded: 5,
    });
  });

  test("referenced Ogg media becomes deterministic QOA and supplies exact ME duration", () => {
    expect(stage.project.audio).toEqual({
      "bgm-stage-overture": "audio:qoa.bgm-stage-overture",
      "me-stage-fanfare": "audio:qoa.me-stage-fanfare",
    });
    expect(stage.assets.audio).toEqual({
      "bgm-stage-overture": "audio/bgm-stage-overture.qoa",
      "me-stage-fanfare": "audio/me-stage-fanfare.qoa",
    });
    expect([...stage.audioFiles.keys()]).toEqual([
      "audio/bgm-stage-overture.qoa",
      "audio/me-stage-fanfare.qoa",
    ]);

    const bgm = stage.audioMedia.find((record) => record.key === "bgm/stage-overture");
    const me = stage.audioMedia.find((record) => record.key === "me/stage-fanfare");
    expect(bgm).toMatchObject({
      status: "success", sourceFormat: "ogg", sourceBytes: 7421,
      outputBytes: 71384, channels: 2, sampleRate: 44_100, frames: 88_320,
    });
    expect(me).toMatchObject({
      status: "success", sourceFormat: "ogg", sourceBytes: 5545,
      outputBytes: 28144, channels: 2, sampleRate: 44_100, frames: 34_816, durationTicks: 48,
    });
    if (me?.status !== "success") throw new Error("stage fanfare fixture did not convert");
    const qoa = new QoaFile(stage.audioFiles.get("audio/me-stage-fanfare.qoa")!);
    expect({ channels: qoa.channels, sampleRate: qoa.sampleRate, frames: qoa.frames }).toEqual({
      channels: me.channels, sampleRate: me.sampleRate, frames: me.frames,
    });
    const playMe = allCommands(stage.project).find((command) => command.op === "playMe") as Command & { duration: number };
    expect(playMe.duration).toBe(me.durationTicks / 60);

    expect(stage.audioMedia.find((record) => record.key === "bgs/stage-crowd")).toMatchObject({
      status: "missing", sourceBytes: 0, outputBytes: 0,
    });
    expect(stage.cov.list("audio").find((row) => row.key === "bgs/stage-crowd")?.counts.Dropped).toBe(1);
    expect(stage.warnings).toContain("bgs/stage-crowd: audio/bgs/stage-crowd.ogg or .m4a was not found");
  });

  test("ME duration follows decoded frames and authored pitch", async () => {
    const source = loadRmProject(STAGE);
    const command = [...source.maps.values()]
      .flatMap((map) => map.events.flatMap((event) => event?.pages.flatMap((page) => page.list) ?? []))
      .find((entry) => entry.code === 249)!;
    const audio = command.parameters?.[0] as { pitch: number };
    audio.pitch = 125;
    const imported = await importRmProject(source);
    const me = imported.audioMedia.find((record) => record.key === "me/stage-fanfare");
    if (me?.status !== "success") throw new Error("stage fanfare fixture did not convert");
    const expectedTicks = Math.ceil(Math.ceil(me.frames * 100 / 125) * 60 / me.sampleRate);
    const playMe = allCommands(imported.project).find((entry) => entry.op === "playMe") as Command & { duration: number };
    expect(playMe.duration).toBe(expectedTicks / 60);
  });

  test("missing named ME is reported and dropped instead of becoming Stop ME", async () => {
    const base = mkdtempSync(join(SCRATCH_ROOT, "rmi-missing-me-"));
    const root = join(base, "stage");
    try {
      cpSync(STAGE, root, { recursive: true });
      rmSync(join(root, "audio", "me"), { recursive: true, force: true });
      const imported = await importRmProject(loadRmProject(root));
      expect(allCommands(imported.project).some((entry) => entry.op === "playMe" || entry.op === "stopMe")).toBe(false);
      expect(imported.cov.list("audio").find((row) => row.key === "me/stage-fanfare")?.counts.Dropped).toBe(1);
      expect(imported.warnings).toContain("me/stage-fanfare: audio/me/stage-fanfare.ogg or .m4a was not found");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("followers and placed vehicles project from System.json", async () => {
    const source = loadRmProject(HOLLOW);
    source.system.optFollowers = false;
    source.system.boat = {
      ...source.system.boat!, characterName: "People", characterIndex: 2,
      startMapId: 1, startX: 3, startY: 11,
      bgm: { name: "Ship Theme", volume: 109, pitch: 40, pan: 5 },
    };
    source.system.airship = {
      ...source.system.airship!, characterName: "People", characterIndex: 6,
      startMapId: 0, startX: 7, startY: 9,
    };
    const imported = await importRmProject(source);
    expect(imported.project.followers).toEqual({
      enabled: false,
      members: [{ id: "actor002", sprite: "chr-people-4", activeSwitch: "party-actor002" }],
    });
    expect(imported.project.vehicles).toEqual([{
      id: "boat", kind: "boat", sprite: "chr-people-2",
      start: { map: "map001", x: 3, y: 11, dir: "left" },
      bgm: { id: "bgm-ship-theme", volume: 100, pitch: 50, pan: 5 },
    }]);
    expect(imported.warnings).not.toContain("boat: vehicle BGM pan is not supported and was ignored");

    source.system.partyMembers = [1, 2];
    const withStartingFollower = await importRmProject(source);
    expect(withStartingFollower.project.followers?.members[0]).toEqual({
      id: "actor002", sprite: "chr-people-4",
      activeSwitch: "party-out-actor002", activeValue: false,
    });
  });

  test("the RPG Maker region plane is copied into each map as sparse row-major cells", () => {
    expect(hollow.project.maps[0]!.regions).toEqual([
      [243, 1], [244, 1], [245, 1], [266, 1], [267, 1], [268, 1], [269, 1],
      [290, 1], [291, 1], [292, 1], [293, 1], [314, 1], [315, 1], [316, 1],
    ]);
    expect(hollow.project.maps[1]!.regions).toBeUndefined();
    expect(hollow.project.maps[2]!.regions).toEqual([
      [69, 3], [70, 3], [71, 3], [89, 3], [90, 3], [91, 3], [109, 3], [110, 3], [111, 3],
    ]);
    expect(hollow.cov.list("tile").find((row) => row.key === "region id")?.counts.Native).toBe(23);
  });

  test("MV Show Text background and position become the text box layout", () => {
    const texts = allCommands(stage.project).filter((c) => c.op === "text") as unknown as Record<string, unknown>[];
    expect(texts).toContainEqual({ op: "text", lines: ["Woo! Front row!"], position: "top", background: "dim" });
    expect(texts).toContainEqual({ op: "text", lines: ["A chalk mark: the lead's spot."], position: "center", background: "transparent" });
    // Default messages (window, bottom) stay plain.
    expect(texts).toContainEqual({ op: "text", lines: ["Break a leg!"] });
    expect(texts.filter((t) => "position" in t || "background" in t)).toHaveLength(2);
    expect(validateSchema(stage.project, schema as Record<string, unknown>)).toEqual([]);
  });

  test("message escapes stay raw and every import opts into live RPG Maker text data", async () => {
    expect(hollow.project.system).toMatchObject({
      messageBlocksPlayer: true,
      mapNameDisplay: true,
      rpgMakerText: { party: [1], currencyUnit: "G" },
    });
    expect(stage.project.system).toMatchObject({
      messageBlocksPlayer: true,
      mapNameDisplay: true,
      rpgMakerText: { party: [1, 2], currencyUnit: "G" },
    });
    const messages = allCommands(hollow.project).filter((c) => c.op === "text") as unknown as { lines: string[] }[];
    expect(messages.some((m) => m.lines.some((line) => line.includes("\\V[2]")))).toBe(true);

    const noTokens = loadRmProject(STAGE);
    for (const map of noTokens.maps.values()) {
      for (const ev of map.events) for (const page of ev?.pages ?? []) {
        for (const command of page.list) {
          command.parameters = command.parameters?.map((value) =>
            typeof value === "string" ? value.replace(/\\V\[\d+\]/gi, "number") : value,
          );
        }
      }
    }
    const imported = await importRmProject(noTokens);
    expect(imported.project.system).toEqual({
      messageBlocksPlayer: true,
      mapNameDisplay: true,
      rpgMakerText: { party: [1, 2], currencyUnit: "G" },
    });
    expect(hollow.cov.list("escape").find((row) => row.key === "\\C")?.counts).toEqual({
      Native: 8, Degraded: 0, Placeholder: 0, Dropped: 0,
    });
  });

  test("Window.png supplies the exact 32-colour palette through case-insensitive lookup", async () => {
    const base = mkdtempSync(join(SCRATCH_ROOT, "rmi-window-"));
    const root = join(base, "project");
    try {
      cpSync(HOLLOW, root, { recursive: true });
      writeFileSync(join(root, "img/system/wInDoW.pNg"), readFileSync(WINDOW_PALETTE));
      const imported = await importRmProject(loadRmProject(root));
      expect(imported.project.system?.rpgMakerText?.colours).toEqual(CUSTOM_WINDOW_COLOURS);
      expect(validateSchema(imported.project, schema as Record<string, unknown>)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("missing Window.png keeps the stock palette implicit; malformed or wrong-sized files fail", async () => {
    expect(hollow.project.system?.rpgMakerText?.colours).toBeUndefined();
    expect(stage.project.system?.rpgMakerText?.colours).toBeUndefined();

    const base = mkdtempSync(join(SCRATCH_ROOT, "rmi-window-bad-"));
    const root = join(base, "project");
    const window = join(root, "img/system/Window.png");
    try {
      cpSync(HOLLOW, root, { recursive: true });
      writeFileSync(window, "not a png");
      await expect(importRmProject(loadRmProject(root))).rejects.toThrow(
        "rpgmaker-import: img/system/Window.png cannot be decoded",
      );

      writeFileSync(window, writePngBytes({
        width: 191,
        height: 192,
        data: new Uint8Array(191 * 192 * 4),
      }));
      await expect(importRmProject(loadRmProject(root))).rejects.toThrow(
        "rpgmaker-import: img/system/Window.png must be 192x192 pixels (got 191x192)",
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a native Steps read opts the imported project into persistent step counting", async () => {
    const rm = loadRmProject(STAGE);
    const page = rm.maps.get(1)!.events.find((event) => event !== null)!.pages[0]!;
    page.list = [
      { code: 122, indent: 0, parameters: [9, 9, 0, 3, 7, 3, 0] },
      { code: 111, indent: 0, parameters: [12, "$gameParty.steps() >= 10"] },
      { code: 0, indent: 1, parameters: [] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];
    const imported = await importRmProject(rm);
    expect(imported.project.system?.stepCounter).toBe(true);
    const commands = imported.project.maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands).toEqual([
      { op: "variable", id: "v009", set: { op: "steps" } },
      { op: "if", if: { kind: "steps", op: ">=", value: 10 }, then: [] },
    ]);
    expect(stage.project.system?.stepCounter).toBeUndefined();
  });

  test("plugin and script commands are visible placeholders, battles a battle op", () => {
    const texts = allCommands(hollow.project).filter((c) => c.op === "text") as unknown as { lines: string[] }[];
    expect(texts.some((t) => t.lines.join(" ").includes("Plugin command not ported"))).toBe(true);
    expect(texts.some((t) => t.lines.join(" ").includes("Script not ported"))).toBe(true);
    const battles = allCommands(hollow.project).filter((c) => c.op === "battle") as unknown as {
      setup: Record<string, unknown>;
      onWin?: unknown[];
      onLose?: unknown[];
      onEscape?: unknown[];
    }[];
    expect(battles).toHaveLength(1);
    expect(battles[0]!.setup).toMatchObject({ troop: 1, name: "Golem", canEscape: true, canLose: true });
    expect(battles[0]!.onWin?.length).toBeGreaterThan(0);
    expect(battles[0]!.onLose?.length).toBeGreaterThan(0);
    expect(battles[0]!.onEscape?.length).toBeGreaterThan(0);
    for (const code of ["355", "357"]) {
      const row = hollow.cov.list("command").find((r) => r.key === code)!;
      expect(row.counts.Placeholder).toBeGreaterThan(0);
      expect(row.counts.Native + row.counts.Degraded + row.counts.Dropped).toBe(0);
    }
    expect(stage.cov.list("command").find((r) => r.key === "356")!.counts.Placeholder).toBe(1);
  });

  test("MV Show Animation cooks a deterministic mapAnim sheet, cues, target, and wait flag", () => {
    expect(stage.project.animations?.find((entry) => entry.id === "anim001")).toEqual({
      id: "anim001",
      sheet: "animations/anim001.png",
      frameW: 54,
      frameH: 54,
      cols: 2,
      count: 4,
      frameDuration: 4 / 60,
      loop: false,
      timings: [
        { frame: 0, se: { id: "se-stage-puff", volume: 70, pitch: 100 } },
        {
          frame: 2,
          flash: {
            color: { r: 160, g: 208, b: 255, a: 255 },
            intensity: 120,
            duration: 0.2,
          },
        },
      ],
    });
    expect(stage.assets.animations.anim001).toEqual({
      sheet: "animations/anim001.png",
      offsetX: -22,
      offsetY: -24,
    });
    const sheet = stage.images.get("animations/anim001.png")!;
    expect(sheet).toMatchObject({ width: 108, height: 108 });
    // A transparent corner and four authored centres prove the compositor
    // emitted real per-frame pixels rather than four copies of one cell.
    expect(pixel(sheet, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(sheet, 30, 31)).toEqual([255, 255, 255, 255]);
    expect(pixel(sheet, 84, 31)).toEqual([128, 232, 255, 113]);
    expect(pixel(sheet, 30, 79)).toEqual([255, 255, 255, 220]);
    expect(pixel(sheet, 86, 80)).toEqual([239, 229, 255, 180]);
    expect(allCommands(stage.project).find((command) => command.op === "mapAnim") as unknown).toEqual({
      op: "mapAnim",
      id: "map001-ev001-p0-anim0",
      anim: "anim001",
      target: { event: "ev002" },
      wait: true,
    });
    const coverage = stage.cov.list("command").find((row) => row.key === "212")!;
    expect(coverage.counts.Degraded).toBe(1);
    expect(coverage.reasons).toContain("target-local animation flash is omitted");
  });

  test("IconSet item cells and map/change parallaxes retain authored pixels and metadata", () => {
    expect(hollow.assets.sheets.iconset).toEqual({ png: "tiles/iconset.png", cols: 16, rows: 13 });
    expect(hollow.project.items.map((item) => [item.id, item.sprite])).toEqual([
      ["item001", "iconset.176"],
      ["item002", "iconset.195"],
      ["weapon001", "iconset.97"],
      ["weapon002", "iconset.98"],
      ["armor001", "iconset.135"],
    ]);
    const icons = hollow.images.get("tiles/iconset.png")!;
    expect(icons).toMatchObject({ width: 256, height: 208 });
    expect(pixel(icons, 8, 11 * 16 + 8)).toEqual([255, 144, 176, 255]);

    // The fixture authors parallaxSx 2 on 48 px tiles: a third of that in
    // 16 px kit pixels keeps MV's on-screen scroll rate.
    expect(stage.project.maps[0]!.parallax).toEqual({
      image: "parallax-stageclouds",
      loopX: true,
      loopY: false,
      sx: 2 * 16 / 48,
      sy: 0,
      showInEditor: true,
    });
    expect(stage.assets.parallaxes).toEqual({
      "parallax-stageclouds": { png: "parallaxes/parallax-stageclouds.png", w: 128, h: 64 },
      "parallax-stageglow": { png: "parallaxes/parallax-stageglow.png", w: 128, h: 64 },
    });
    expect(pixel(stage.images.get("parallaxes/parallax-stageclouds.png")!, 12, 5)).toEqual([255, 240, 176, 255]);
    expect(pixel(stage.images.get("parallaxes/parallax-stageglow.png")!, 64, 16)).toEqual([255, 224, 144, 255]);
    expect(allCommands(stage.project).find((command) => command.op === "changeParallax") as unknown).toEqual({
      op: "changeParallax",
      image: "parallax-stageglow",
      loopX: false,
      loopY: false,
      sx: 0,
      sy: 0,
      zero: true,
    });
    expect(stage.cov.list("command").find((row) => row.key === "284")!.counts.Native).toBe(1);
  });

  test("an out-of-bounds iconIndex warns and falls back to the first sheet's first cell", async () => {
    // Both sides of the guard: a cell past the sheet (>= count) and a
    // negative index. The sprite falls back to "<firstSheet>.0" so the item
    // still renders, and the warning names the kind, id and cell count.
    // iconIndex === count (208) is the first illegal cell: the guard is
    // `< count`, so a `<= count` mutant would let it through as iconset.208.
    const rm = loadRmProject(HOLLOW);
    const mutated: RmProject = {
      ...rm,
      items: [
        ...rm.items.map((it) => (it && it.id === 1 ? { ...it, iconIndex: 99999 } : it)),
        { ...rm.items.find((it) => it && it.id === 1)!, id: 3, name: "Seal Charm", iconIndex: 208 },
      ],
      weapons: rm.weapons.map((it) => (it && it.id === 1 ? { ...it, iconIndex: -1 } : it)),
    };
    const result = await importRmProject(mutated);
    const potion = result.project.items.find((it) => it.id === itemId("item", 1))!;
    const staff = result.project.items.find((it) => it.id === itemId("weapon", 1))!;
    expect(potion.sprite).toBe("ts1.0");
    expect(staff.sprite).toBe("ts1.0");
    const charm = result.project.items.find((it) => it.id === itemId("item", 3))!;
    expect(charm.sprite).toBe("ts1.0");
    const warnings = result.warnings.filter((w) => w.includes("iconIndex"));
    expect(warnings).toContain("item 1: iconIndex 99999 is outside IconSet (208 cells)");
    expect(warnings).toContain("item 3: iconIndex 208 is outside IconSet (208 cells)");
    expect(warnings).toContain("weapon 1: iconIndex -1 is outside IconSet (208 cells)");
    // In-bounds items on the same run keep their authored icon cell.
    const cavePass = result.project.items.find((it) => it.id === itemId("item", 2))!;
    expect(cavePass.sprite).toBe("iconset.195");
  });

  test("silent placeholders drop the text but still count as Placeholder", async () => {
    const silent = await importRmProject(loadRmProject(HOLLOW), { placeholders: "silent" });
    const texts = allCommands(silent.project).filter((c) => c.op === "text") as unknown as { lines: string[] }[];
    expect(texts.some((t) => t.lines.join(" ").includes("not ported"))).toBe(false);
    expect(silent.cov.list("command").find((r) => r.key === "357")!.counts.Placeholder).toBeGreaterThan(0);
  });

  test("tile passage: walls block, the fence blocks one edge, and a touch door keeps a body-only bump path", () => {
    const map = hollow.project.maps[0]!;
    const table = buildPassage(map, new Map(hollow.project.sheets.map((s) => [s.id, s])));
    // House wall (A3) at (9,4) blocks; grass at (11,9) passes.
    expect(canStepFrom(table, 9, 6, 2)).toBe(false);
    expect(canStepFrom(table, 11, 9, 3)).toBe(true);
    // The fence (B tile, passage bit 0x01 = down) on row y=6 east of the
    // house: leaving it downward and entering it from below are blocked,
    // walking along it is not.
    const fenceSheet = hollow.project.sheets[0]!;
    expect(Object.values(fenceSheet.dirBlock ?? {})).toContainEqual(["down"]);
    // The door (11,5) is a same-as-characters touch event on the wall. The
    // terrain below it is opened, but its event body remains blocking, so a
    // refused player step is attributed to the body and starts eventTouch.
    expect(map.passage).toContainEqual([5 * map.width + 11, "pass"]);
    expect(canStepFrom(table, 11, 6, 2)).toBe(true);
    const door = map.events!.find((event) => event.id === "ev003")!.pages[0]!;
    expect(door).toMatchObject({ trigger: "eventTouch", blocks: true });
    const cave = map.events!.find((event) => event.id === "ev006")!.pages[0]!;
    expect(cave).toMatchObject({ trigger: "eventTouch", blocks: false });
  });

  test("Change Tileset composes stable map, common-event and troop-event variants", async () => {
    const root = mkdtempSync(join(SCRATCH_ROOT, "rmi-tileset-"));
    try {
      cpSync(HOLLOW, root, { recursive: true });
      const alternateB = await readPng(join(root, "img/tilesets/Hollow_B.png"));
      for (let i = 0; i < alternateB.data.length; i += 4) {
        alternateB.data[i] = 255 - alternateB.data[i]!;
        alternateB.data[i + 1] = 255 - alternateB.data[i + 1]!;
        alternateB.data[i + 2] = 255 - alternateB.data[i + 2]!;
      }
      writeFileSync(join(root, "img/tilesets/Alternate_B.png"), writePngBytes(alternateB));

      const source = (): RmProject => {
        const rm = loadRmProject(root);
        const baseTileset = rm.tilesets[1]!;
        const rmMap = rm.maps.get(1)!;
        const fence = 6 * rmMap.width + 16;
        const plane = rmMap.width * rmMap.height;
        const fenceTile = rmMap.data[2 * plane + fence]!;
        const flags = [...baseTileset.flags];
        // The authored fence blocks downward. The alternate makes it pass
        // and assigns terrain tag 5 while retaining every unrelated flag.
        flags[fenceTile] = ((flags[fenceTile] ?? 0) & ~0x0f & ~(0x07 << 12)) | (5 << 12);
        rm.tilesets[3] = {
          ...baseTileset,
          id: 3,
          name: "Alternate Field",
          flags,
          tilesetNames: baseTileset.tilesetNames.map((name, index) => index === 5 ? "Alternate_B" : name),
        };

        // A map-local reference applies only to map001. Common and troop
        // references may execute on any current map and are global.
        rmMap.events[1]!.pages[0]!.list.unshift(
          { code: 282, indent: 0, parameters: [3] },
          { code: 282, indent: 0, parameters: [999] },
        );
        rm.commonEvents[1]!.list.unshift({ code: 282, indent: 0, parameters: [2] });
        rm.troops[1]!.pages[0]!.list.unshift({ code: 282, indent: 0, parameters: [1] });
        return rm;
      };

      const imported = await importRmProject(source());
      expect(validateSchema(imported.project, schema as Record<string, unknown>)).toEqual([]);
      const map = imported.project.maps.find((entry) => entry.id === "map001")!;
      const other = imported.project.maps.find((entry) => entry.id === "map002")!;
      expect(map.tileset).toBe("ts1");
      expect(Object.keys(map.tilesetVariants ?? {})).toEqual(["ts2", "ts3"]);
      expect(other.tileset).toBe("ts2");
      expect(Object.keys(other.tilesetVariants ?? {})).toEqual(["ts1"]);

      const alternate = map.tilesetVariants!.ts3!;
      expect(alternate.sheets).toEqual(["ts3"]);
      expect(Array.isArray(alternate.upper)).toBe(true);
      expect(Array.isArray(alternate.passage)).toBe(true);
      expect(Array.isArray(alternate.vehiclePassage?.boat)).toBe(true);
      expect(Array.isArray(alternate.vehiclePassage?.ship)).toBe(true);
      expect(Array.isArray(alternate.vehiclePassage?.airshipLand)).toBe(true);
      expect(Array.isArray(alternate.terrain)).toBe(true);
      const fence = 6 * map.width + 16;
      expect(map.terrain ?? []).not.toContainEqual([fence, 5]);
      expect(alternate.terrain).toEqual(expect.arrayContaining([[fence, 5]]));
      expect(tilePixels(imported, map.ground[fence]!)).not.toEqual(tilePixels(imported, alternate.ground[fence]!));
      const baseUpper = new Map(map.upper ?? []);
      const alternateUpper = new Map(alternate.upper ?? []);
      expect(
        [...baseUpper].some(([cell, tile]) => {
          const changed = alternateUpper.get(cell);
          return tile !== null && changed !== undefined && changed !== null &&
            !tilePixels(imported, tile).equals(tilePixels(imported, changed));
        }),
        "alternate upper art differs at an authored star tile",
      ).toBe(true);

      const sheets = new Map(imported.project.sheets.map((sheet) => [sheet.id, sheet]));
      const alternateMap = mapForTileset(map, "ts3")!;
      expect(canStepFrom(buildPassage(map, sheets), 16, 6, 0)).toBe(false);
      expect(canStepFrom(buildPassage(alternateMap, sheets), 16, 6, 0)).toBe(true);

      expect(imported.project.sheets.map((sheet) => sheet.id)).toContain("ts3");
      expect(imported.images.has("tiles/ts3.png")).toBe(true);
      expect(imported.assets.sheets.ts3).toBeDefined();
      expect(map.tilesetVariants).not.toHaveProperty("ts999");
      expect(allCommands(imported.project)).not.toContainEqual({ op: "changeTileset", id: "ts999" });
      expect(imported.cov.list("command").find((row) => row.key === "282")?.counts.Dropped)
        .toBeGreaterThanOrEqual(1);
      expect(imported.cov.list("command").find((row) => row.key === "282")?.reasons)
        .toContain("tileset 999 does not exist");
      expect(imported.warnings).toContain("Change Tileset references missing tileset 999; no variant was emitted");
      const animatedVariants = imported.assets.animatedVariants!.map001!;
      expect(Object.keys(animatedVariants)).toEqual(["ts1", "ts2", "ts3"]);
      expect(animatedVariants.ts1).toEqual(imported.assets.animated.map001);
      expect(animatedVariants.ts3.length).toBeGreaterThan(0);
      expect(animatedVariants.ts3.every((animation) =>
        animation.frames.every((frame) => frame?.startsWith("ts3.")))).toBe(true);
      expect(imported.warnings.some((warning) => warning.includes("alternate animated frames"))).toBe(false);

      const again = await importRmProject(source());
      expect(JSON.stringify(again.project)).toBe(JSON.stringify(imported.project));
      expect(JSON.stringify(again.assets)).toBe(JSON.stringify(imported.assets));
      expect(again.warnings).toEqual(imported.warnings);
      expect([...again.images.keys()]).toEqual([...imported.images.keys()]);
      for (const [name, image] of imported.images) {
        expect(Buffer.from(writePngBytes(again.images.get(name)!))).toEqual(Buffer.from(writePngBytes(image)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("vehicle passage uses the boat, ship and airship landing bits", async () => {
    const source = loadRmProject(HOLLOW);
    const rmMap = source.maps.get(1)!;
    const tileset = source.tilesets[rmMap.tilesetId]!;
    for (let id = 0; id < tileset.flags.length; id++) tileset.flags[id] = (tileset.flags[id] ?? 0) | 0x600;
    const pond = 11 * rmMap.width + 3;
    const grass = 9 * rmMap.width + 7;
    const fence = 6 * rmMap.width + 16;
    const pondTile = rmMap.data[pond]!;
    tileset.flags[pondTile] = (tileset.flags[pondTile] ?? 0) & ~0x600;

    const imported = await importRmProject(source);
    const passage = imported.project.maps[0]!.vehiclePassage!;
    expect(passage.boat).toContain(pond);
    expect(passage.ship).toContain(pond);
    expect(passage.boat).not.toContain(grass);
    expect(passage.ship).not.toContain(grass);
    expect(passage.airshipLand).not.toContain(pond);
    expect(passage.airshipLand).toContain(grass);
    // A one-direction fence flag is not a complete 0x0f rejection; MV's
    // check falls through to the walkable ground below it.
    expect(passage.airshipLand).toContain(fence);

    // Bit 0x800 separately forbids an otherwise walkable landing tile.
    const grassTile = rmMap.data[grass]!;
    tileset.flags[grassTile] = (tileset.flags[grassTile] ?? 0) | 0x800;
    const noLand = await importRmProject(source);
    expect(noLand.project.maps[0]!.vehiclePassage!.airshipLand).not.toContain(grass);
  });

  test("the starting party member's switch is stored inverted", async () => {
    const r = await importRmProject(loadRmProject(HOLLOW));
    const ids = new Set<string>();
    for (const c of allCommands(r.project)) if (c.op === "switch") ids.add((c as unknown as { id: string }).id);
    // Actor 2 joins (129): a plain party switch; actor 1 is never toggled.
    expect(ids.has("party-actor002")).toBe(true);
    expect([...ids].some((id) => id.startsWith("party-out-"))).toBe(false);
  });

  test("starting-party switch inversion reaches commands nested in a loop", () => {
    const project = structuredClone(hollow.project);
    const page = project.maps[0]!.events![0]!.pages[0]!;
    page.commands = [{
      op: "loop",
      commands: [
        { op: "switch", id: "party-actor001", value: true },
        { op: "if", if: { kind: "switch", id: "party-actor001" }, then: [{ op: "break" }] },
      ],
    }];
    invertInitialParty(project, [1]);
    expect(project.maps[0]!.events![0]!.pages[0]!.commands).toEqual([{
      op: "loop",
      commands: [
        { op: "switch", id: "party-out-actor001", value: false },
        { op: "if", if: { kind: "switch", id: "party-out-actor001", value: false }, then: [{ op: "break" }] },
      ],
    }]);
  });

  test("coverage counts every command the fixtures use, by code", () => {
    const used = new Set<string>();
    for (const r of [hollow, stage]) for (const row of r.cov.list("command")) used.add(row.key);
    for (const code of ["101", "102", "111", "112", "117", "121", "122", "123", "124", "125", "126", "129", "201", "203", "205",
      "211", "212", "213", "214", "221", "222", "223", "224", "225", "230", "231", "232", "235", "241", "250", "284", "301", "302", "355", "356", "357"]) {
      expect(used.has(code)).toBe(true);
    }
    // Tile constructs are counted too.
    const tiles = new Set(hollow.cov.list("tile").map((r) => r.key));
    for (const key of ["A1 water", "A1 waterfall", "A2 ground", "A3 roof", "A4 wall top", "A5", "B-E", "shadow", "star (upper layer)"]) {
      expect(tiles.has(key)).toBe(true);
    }
  });

  test("the static table lists every MV/MZ command code with a handling", () => {
    const rows = staticCommandTable();
    const codes = RM_COMMANDS.filter((c) => !c.continuation).map((c) => c.code);
    expect(rows.map((r) => r.code)).toEqual(codes);
    for (const r of rows) expect(r.disposition).not.toBe("—");
    const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get(101)!.disposition).toBe("Native");
    expect(by.get(112)!.disposition).toBe("Native");
    expect(by.get(113)!.disposition).toBe("Native");
    for (const code of [103, 104, 124, 134, 135, 202, 204, 206, 212, 216, 217, 231, 232, 233, 234, 235, 236, 251, 281, 284, 285, 323, 351, 352, 353, 354]) {
      expect(by.get(code)!.disposition).toBe("Native");
      expect(by.get(code)!.needsKit).toBe("");
    }
    for (const code of [137, 138, 223, 282]) {
      expect(by.get(code)!.disposition).toBe("Degraded");
      expect(by.get(code)!.needsKit).toBe("");
    }
    expect(by.get(320)!.disposition).toBe("Native");
    expect(by.get(320)!.needsKit).toContain("actors other than actor 1");
    expect(by.get(111)!.needsKit).not.toContain("timer");
    expect(by.get(111)!.needsKit).not.toContain("vehicles");
    expect(by.get(140)!.disposition).toBe("Native");
    expect(by.get(140)!.needsKit).not.toContain("audio pan");
    expect(by.get(122)!.needsKit).not.toContain("timer");
    expect(by.get(118)!.disposition).toBe("Native");
    expect(by.get(119)!.disposition).toBe("Native");
    expect(by.get(355)!.disposition).toBe("Placeholder");
    expect(by.get(357)!.disposition).toBe("Placeholder");
    expect(by.get(301)!.disposition).toBe("Native");
    expect(by.get(301)!.needsKit).toBe("");
  });

  test("an encrypted deployment is refused", () => {
    const dir = mkdtempSync(join(SCRATCH_ROOT, "rmi-enc-"));
    try {
      const data = join(dir, "data");
      mkdirSync(data);
      writeFileSync(join(data, "System.json"), JSON.stringify({ hasEncryptedImages: true, partyMembers: [] }));
      expect(() => loadRmProject(dir)).toThrow(RmLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rpgmaker-import: files and determinism", () => {
  test("the CLI writes byte-identical output twice, inline and sharded", async () => {
    const base = mkdtempSync(join(SCRATCH_ROOT, "rmi-cli-"));
    try {
      const run = (out: string, ...extra: string[]) => {
        const proc = Bun.spawnSync([process.execPath, join(ROOT, "tools/rpgmaker-import"), HOLLOW, "--out", out, ...extra], { cwd: ROOT });
        expect(proc.exitCode).toBe(0);
        return files(out);
      };
      const a = run(join(base, "a"));
      const b = run(join(base, "b"));
      expect([...a.keys()]).toEqual([...b.keys()]);
      for (const [k, v] of a) expect(v.equals(b.get(k)!)).toBe(true);
      for (const f of ["project.json", "assets.json", "audio-media.json", "coverage.md", "coverage.json", "tiles/ts1.png", "tiles/ts2.png"]) {
        expect(a.has(f)).toBe(true);
      }
      const project = JSON.parse(a.get("project.json")!.toString("utf8")) as Project;
      expect(project).toEqual(JSON.parse(JSON.stringify(hollow.project)));
      const sharded = run(join(base, "s"), "--shard");
      const shell = JSON.parse(sharded.get("project.json")!.toString("utf8"));
      expect(shell.mapIndex.map((e: { id: string }) => e.id)).toEqual(["map001", "map002", "map003"]);
      expect([...sharded.keys()].filter((k) => k.startsWith("maps/"))).toHaveLength(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  test("generated images and QOA media are a pure function of the project", async () => {
    const again = await importRmProject(loadRmProject(STAGE));
    expect([...again.images.keys()]).toEqual([...stage.images.keys()]);
    for (const [k, img] of stage.images) {
      expect(Buffer.from(writePngBytes(img)).equals(Buffer.from(writePngBytes(again.images.get(k)!)))).toBe(true);
    }
    expect([...again.audioFiles.keys()]).toEqual([...stage.audioFiles.keys()]);
    for (const [key, bytes] of stage.audioFiles) {
      expect(Buffer.from(bytes).equals(Buffer.from(again.audioFiles.get(key)!))).toBe(true);
    }
  });

  test("the committed play fixture holds the importer's current output", async () => {
    // tests/fixtures/rmi-play/games.ts is regenerated by its gen-assets.ts;
    // a stale copy would test yesterday's importer.
    expect(RMI_GAMES.hollow.project).toEqual(JSON.parse(JSON.stringify(hollow.project)));
    expect(RMI_GAMES.stage.project).toEqual(JSON.parse(JSON.stringify(stage.project)));
  });

  test("the importer is not part of any game bundle", () => {
    for (const name of ["sunstone", "meadow", "showcase", "grow", "rmi-play"]) {
      const bundle = join(ROOT, "dist", `${name}.js`);
      const text = readFileSync(bundle, "utf8");
      expect(text.includes("FLOOR_AUTOTILE_TABLE")).toBe(false);
      expect(text.includes("rpgkit-rpgmaker-assets")).toBe(false);
    }
  });
});

test("docs/rpgmaker-import.md embeds the current command table", () => {
  const doc = readFileSync(join(ROOT, "docs/rpgmaker-import.md"), "utf8");
  const begin = doc.indexOf("<!-- rpgmaker-commands:begin -->\n");
  const end = doc.indexOf("\n<!-- rpgmaker-commands:end -->");
  expect(begin).toBeGreaterThan(0);
  expect(doc.slice(begin + "<!-- rpgmaker-commands:begin -->\n".length, end)).toBe(commandTableLines().join("\n"));
});
