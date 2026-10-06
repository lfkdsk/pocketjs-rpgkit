import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runFileEdit } from "../editor/api/file.ts";
import { buildAndVerifySunstoneAgentTask } from "../tools/rpgkit-edit/example-sunstone.ts";
import type { EditPatch, FileEditResponse } from "../editor/api/types.ts";
import type { MapDef, Project } from "../src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-tmp-${process.pid}`);
const CLI = join(ROOT, "tools/rpgkit-edit/cli.ts");
const SUNSTONE = join(ROOT, "examples/sunstone/data/sunstone.json");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function tempFile(name: string, source = readFileSync(SUNSTONE, "utf8")): string {
  const path = join(TEMP, `${name}-${randomUUID()}.json`);
  writeFileSync(path, source);
  return path;
}

function runCliJson(command: string, file: string, args: unknown, dryRun = false): { exitCode: number; stderr: string; body: any } {
  const argsFile = join(TEMP, `args-${randomUUID()}.json`);
  writeFileSync(argsFile, JSON.stringify(args));
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, command, "--file", file, "--json", `@${argsFile}`, ...(dryRun ? ["--dry-run"] : [])],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), body: JSON.parse(stdout) };
}

function mapById(project: Project, id: string): MapDef | undefined {
  return project.maps.find((map) => map.id === id);
}

const ORIGINAL = JSON.parse(readFileSync(SUNSTONE, "utf8")) as Project;
const VILLAGE = mapById(ORIGINAL, "village")!;
const EDGE_TILE = VILLAGE.ground[2 * VILLAGE.width + 2] as string;

interface CliMutationCase {
  command: string;
  args: Record<string, unknown>;
  /** Assert the change is present in the file written by a real CLI run. */
  check: (edited: Project) => void;
  /** Bad arguments that the CLI must reject with exit 1 and this error. */
  bad: { args: Record<string, unknown>; error: Record<string, unknown> };
}

const CLI_MUTATIONS: CliMutationCase[] = [
  {
    command: "paint-cells",
    args: { map: "village", cells: [[2, 2], [3, 2], [10, 7]], value: "town.1" },
    check: (edited) => {
      const village = mapById(edited, "village")!;
      for (const [x, y] of [[2, 2], [3, 2], [10, 7]] as const) expect(village.ground[y * village.width + x]).toBe("town.1");
      expect([[2, 2], [3, 2], [10, 7]].some(([x, y]) => VILLAGE.ground[y! * VILLAGE.width + x!] !== "town.1")).toBe(true);
    },
    bad: { args: { map: "village", cells: [[0, 0], [20, 0]], value: "town.1" }, error: { code: "OUT_OF_BOUNDS", path: "$.cells[1]" } },
  },
  {
    command: "paint-edges",
    args: { map: "village", cells: [[2, 2]], brush: { kind: "exit", dir: "left" } },
    check: (edited) => {
      const [sheet, cell] = EDGE_TILE.split(".");
      expect(ORIGINAL.sheets.find((item) => item.id === sheet)!.dirEdges?.[String(Number(cell))]).toBeUndefined();
      expect(edited.sheets.find((item) => item.id === sheet)!.dirEdges?.[String(Number(cell))]).toEqual({ exit: ["left"] });
    },
    bad: { args: { map: "village", cells: [[0, 0]], brush: { kind: "enter" } }, error: { code: "INVALID_ARGUMENT", path: "$.brush.dir" } },
  },
  {
    command: "add-map",
    args: { map: "market", name: "Market", width: 6, height: 5, fill: "town.0", after: "village" },
    check: (edited) => {
      expect(edited.maps.map((map) => map.id)).toEqual(["village", "market", "forest", "cave"]);
      expect(mapById(edited, "market")).toMatchObject({ id: "market", name: "Market", width: 6, height: 5, sheets: ["town"], events: [] });
      expect(mapById(edited, "market")!.ground).toEqual(new Array(30).fill("town.0"));
    },
    bad: { args: { width: 0 }, error: { code: "INVALID_ARGUMENT", path: "$.width" } },
  },
  {
    command: "duplicate-map",
    args: { map: "forest" },
    check: (edited) => {
      expect(edited.maps.map((map) => map.id)).toEqual(["village", "forest", "forest-copy", "cave"]);
      const source = mapById(ORIGINAL, "forest")!;
      expect({ ...mapById(edited, "forest-copy")!, id: source.id, name: source.name }).toEqual(source);
      expect(mapById(edited, "forest")).toEqual(source);
    },
    bad: { args: { map: "nowhere" }, error: { code: "MAP_NOT_FOUND" } },
  },
  {
    command: "delete-map",
    args: { map: "forest" },
    check: (edited) => {
      expect(edited.maps.map((map) => map.id)).toEqual(["village", "cave"]);
      expect(mapById(edited, "forest")).toBeUndefined();
    },
    bad: { args: { map: "village" }, error: { code: "MAP_DELETE_REFUSED", path: "$.map" } },
  },
];

describe("rpgkit-edit file and CLI adapter", () => {
  test("dry-run computes a patch without changing one source byte", () => {
    const file = tempFile("dry-run");
    const before = readFileSync(file, "utf8");
    const response = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
      dryRun: true,
    });
    expect(response).toMatchObject({ ok: true, changed: true, dryRun: true, written: false });
    expect(response.ok && response.patch?.changes).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("an invalid edit is rejected and the original file stays unchanged", () => {
    const file = tempFile("invalid");
    const before = readFileSync(file, "utf8");
    const response = runFileEdit({
      command: "paint-rect",
      file,
      args: { map: "village", x: 19, y: 12, width: 2, height: 1, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: false, written: false, error: { code: "OUT_OF_BOUNDS", path: "$" } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a successful write is atomic at the adapter boundary", () => {
    const file = tempFile("write");
    const response = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: true, changed: true, dryRun: false, written: true });
    expect((JSON.parse(readFileSync(file, "utf8")) as any).maps[0].ground[0]).toBe("town.1");
    expect(readdirSync(TEMP).filter((name) => name.includes(".rpgkit-edit-") && name.endsWith(".tmp"))).toEqual([]);
  });

  test("editing through a symlink updates its target without replacing the link", () => {
    const target = tempFile("symlink-target");
    const link = join(TEMP, `symlink-${randomUUID()}.json`);
    symlinkSync(target, link);
    const response = runFileEdit({
      command: "paint-tile",
      file: link,
      args: { map: "village", x: 0, y: 0, tile: "town.1" },
    });
    expect(response).toMatchObject({ ok: true, written: true, file: target });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect((JSON.parse(readFileSync(target, "utf8")) as any).maps[0].ground[0]).toBe("town.1");
  });

  test("an optional project root rejects files reached outside it, including through symlinks", () => {
    const root = join(TEMP, `root-${randomUUID()}`);
    mkdirSync(root);
    const outside = tempFile("outside");
    const link = join(root, "escape.json");
    symlinkSync(outside, link);
    expect(runFileEdit({ command: "open", file: link, root })).toMatchObject({
      ok: false,
      written: false,
      error: { code: "PATH_OUTSIDE_ROOT" },
    });
  });

  test("saving a local event edit preserves an untouched event's exact bytes", () => {
    const keep = `{ "id" : "keep", "name" : "Odd spacing stays", "x" : 0, "y" : 0,
          "pages" : [ { "trigger" : "action", "commands" : [ { "op" : "text", "lines" : ["KEEP  punctuation"] } ] } ] }`;
    const source = `{
 "format":"rpgkit-project/v1", "title":"Preserve", "tileSize":16,
 "start":{"map":"m","x":0,"y":0,"dir":"down"},
 "sheets":[{"id":"s","pak":"chunks","cols":1,"rows":1}], "items":[],
 "maps":[{"id":"m","name":"M","width":2,"height":1,"sheets":["s"],"ground":["s.0","s.0"],
 "events":[${keep},{"id":"edit","name":"Before","x":1,"y":0,"pages":[{"trigger":"action","commands":[]}]}]}]
}`;
    const file = tempFile("preserve", source);
    const response = runFileEdit({ command: "update-event", file, args: { map: "m", event: "edit", changes: { name: "After" } } });
    expect(response).toMatchObject({ ok: true, written: true });
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain(keep);
    expect((JSON.parse(saved) as any).maps[0].events[1].name).toBe("After");
  });

  test("CLI stdout is one JSON document and errors exit nonzero", () => {
    const file = tempFile("cli");
    const good = Bun.spawnSync({
      cmd: [process.execPath, CLI, "list-events", "--file", file, "--json", '{"map":"village"}'],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe("");
    const response = JSON.parse(good.stdout.toString()) as FileEditResponse;
    expect(response).toMatchObject({ ok: true, command: "list-events", written: false });
    expect(good.stdout.toString().trim().split("\n")).toHaveLength(1);

    const before = readFileSync(file, "utf8");
    const bad = Bun.spawnSync({
      cmd: [process.execPath, CLI, "paint-tile", "--file", file, "--json", '{"map":"missing","x":0,"y":0,"tile":"town.1"}'],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout.toString())).toMatchObject({ ok: false, error: { code: "MAP_NOT_FOUND", path: "$.map" } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("CLI --file wins over a file key inside --json", () => {
    // The explicit --file is the CLI's own input; a "file" hidden in the
    // operation JSON must not redirect the command to another project.
    const argsFile = join(TEMP, `args-${randomUUID()}.json`);
    writeFileSync(argsFile, JSON.stringify({
      file: SUNSTONE,
      direction: "pack",
      out: join(TEMP, `must-not-be-created-${randomUUID()}`),
    }));
    const missing = join(TEMP, `explicit-missing-${randomUUID()}.json`);
    const result = Bun.spawnSync({
      cmd: [process.execPath, CLI, "materialize", "--file", missing, "--json", `@${argsFile}`, "--dry-run"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout.toString());
    expect(body).toMatchObject({ ok: false, file: missing });
  });

  test("CLI authors a loop, fills its body through loop-segment addresses, and edits inside it", () => {
    const file = tempFile("cli-loop");
    const at = { map: "village", event: "boy", page: 0 };
    const body = (index: number) => ({ path: [{ kind: "loop", index: 0, branch: "body" }], index });
    const loop = runCliJson("insert-command", file, { ...at, address: { path: [], index: 0 }, command: { op: "loop", commands: [] } });
    expect(loop.exitCode).toBe(0);
    expect(loop.body.addresses).toEqual(["map:village/event:boy/page:0/command:root#0"]);
    const text = runCliJson("insert-command", file, { ...at, address: body(0), command: { op: "text", lines: ["Gold left: {v:gold}"] } });
    expect(text.exitCode).toBe(0);
    expect(text.body.addresses).toEqual(["map:village/event:boy/page:0/command:l0:body#0"]);
    expect(runCliJson("insert-command", file, { ...at, address: body(1), command: { op: "break" } }).exitCode).toBe(0);
    const edited = runCliJson("update-command", file, { ...at, address: body(0), field: "lines", value: "{name} has {v:gold}G" });
    expect(edited.body).toMatchObject({ ok: true, result: { op: "text", lines: ["{name} has {v:gold}G"] } });

    const listed = runCliJson("list-commands", file, at);
    expect(listed.body.result.map((row: any) => [row.key, row.depth, row.branch ?? null, row.summary])).toEqual([
      ["root#0", 0, null, "Loop (2 commands)"],
      ["l0:body#0", 1, "Body", "Text: {name} has {v:gold}G"],
      ["l0:body#1", 1, "Body", "Break loop"],
      ["root#1", 0, null, expect.stringMatching(/^Text: BOY:/)],
    ]);
    // A listed commandAddress is a reusable insert/delete address.
    expect(listed.body.result[2].commandAddress).toEqual(body(1));
    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(mapById(project, "village")!.events!.find((event) => event.id === "boy")!.pages[0]!.commands[0]).toEqual({
      op: "loop",
      commands: [{ op: "text", lines: ["{name} has {v:gold}G"] }, { op: "break" }],
    });
    expect(runCliJson("validate", file, {}).body).toMatchObject({ ok: true, result: { valid: true, errors: [] } });

    // break has no fields; a loop segment on a non-loop or with a bad branch is refused.
    const before = readFileSync(file, "utf8");
    expect(runCliJson("update-command", file, { ...at, address: body(1), field: "id", value: "x" }))
      .toMatchObject({ exitCode: 1, body: { ok: false, error: { code: "INVALID_COMMAND_FIELD" } } });
    expect(runCliJson("insert-command", file, { ...at, address: { path: [{ kind: "loop", index: 0, branch: "then" }], index: 0 }, command: { op: "break" } }))
      .toMatchObject({ exitCode: 1, body: { ok: false, error: { code: "INVALID_ARGUMENT" } } });
    expect(runCliJson("insert-command", file, { ...at, address: { path: [{ kind: "loop", index: 1, branch: "body" }], index: 0 }, command: { op: "break" } }))
      .toMatchObject({ exitCode: 1, body: { ok: false, error: { code: "COMMAND_ADDRESS_NOT_FOUND" } } });
    expect(readFileSync(file, "utf8")).toBe(before);

    const deleted = runCliJson("delete-command", file, { ...at, address: body(0) });
    expect(deleted.body).toMatchObject({ ok: true, result: { deleted: { op: "text" } } });
    expect(runCliJson("list-commands", file, at).body.result.map((row: any) => row.key)).toEqual(["root#0", "l0:body#0", "root#1"]);
  });

  for (const entry of CLI_MUTATIONS) {
    describe(`CLI ${entry.command}`, () => {
      test("--dry-run returns a patch-v1 patch and leaves the file bytes unchanged", () => {
        const file = tempFile(`cli-${entry.command}-dry`);
        const before = readFileSync(file);
        const { exitCode, stderr, body } = runCliJson(entry.command, file, entry.args, true);
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(body).toMatchObject({ ok: true, command: entry.command, changed: true, dryRun: true, written: false });
        expect(body.patch.format).toBe("rpgkit-edit/patch-v1");
        expect(body.patch.changes.length).toBeGreaterThan(0);
        expect(readFileSync(file).equals(before)).toBe(true);
      });

      test("a real write persists the change, validates, and a reverse save restores the exact bytes", () => {
        const file = tempFile(`cli-${entry.command}-write`);
        const before = readFileSync(file);
        const edit = runCliJson(entry.command, file, entry.args);
        expect(edit.exitCode).toBe(0);
        expect(edit.body).toMatchObject({ ok: true, command: entry.command, changed: true, dryRun: false, written: true });
        const patch = edit.body.patch as EditPatch;
        expect(patch.format).toBe("rpgkit-edit/patch-v1");
        expect(readFileSync(file).equals(before)).toBe(false);
        entry.check(JSON.parse(readFileSync(file, "utf8")) as Project);

        const validated = runCliJson("validate", file, {});
        expect(validated.exitCode).toBe(0);
        expect(validated.body).toMatchObject({ ok: true, result: { valid: true, errors: [] } });

        const undo = runCliJson("save", file, { patch, direction: "reverse" });
        expect(undo.exitCode).toBe(0);
        expect(undo.body).toMatchObject({ ok: true, command: "save", changed: true, written: true });
        expect(undo.body.project.revision).toBe(patch.beforeHash);
        expect(readFileSync(file).equals(before)).toBe(true);
      });

      test("bad arguments exit nonzero and leave the file unchanged", () => {
        const file = tempFile(`cli-${entry.command}-bad`);
        const before = readFileSync(file);
        const { exitCode, body } = runCliJson(entry.command, file, entry.bad.args);
        expect(exitCode).toBe(1);
        expect(body).toMatchObject({ ok: false, error: entry.bad.error });
        expect(readFileSync(file).equals(before)).toBe(true);
      });
    });
  }

  test("example authors a three-line, ten-gold, self-switch NPC through seven CLI edits", () => {
    const output = join(TEMP, "sunstone-agent-task.json");
    const sourceBefore = readFileSync(SUNSTONE, "utf8");
    const result = buildAndVerifySunstoneAgentTask(output);
    expect(result).toMatchObject({
      output,
      event: "agent-greeter",
      cliEdits: 7,
      initialGold: 5,
      finalGold: 15,
      selfSwitch: "A",
      oneShot: true,
    });
    expect(result.dialogues).toHaveLength(3);
    expect(readFileSync(SUNSTONE, "utf8")).toBe(sourceBefore);
    const edited = JSON.parse(readFileSync(output, "utf8")) as any;
    const villageEvents = edited.maps.find((map: any) => map.id === "village").events;
    expect(villageEvents.find((event: any) => event.id === "agent-greeter")).toMatchObject({ x: 10, y: 1 });
    expect(villageEvents.some((event: any) => event.id === "elder")).toBe(true);
    expect(villageEvents.some((event: any) => event.id === "north-gate")).toBe(true);
  });
});
