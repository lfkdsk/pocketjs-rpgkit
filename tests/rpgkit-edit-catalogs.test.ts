import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { executeEditOperation } from "../editor/api/operations.ts";
import { runFileEdit } from "../editor/api/file.ts";
import type { EditExecution, EditSuccess } from "../editor/api/types.ts";
import { mapManifestHash } from "../src/engine/map-repository.ts";
import type { Project, ProjectShell } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { dispatchMcpMessage } from "../tools/rpgkit-edit/mcp.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMP = join(import.meta.dir, `.rpgkit-edit-catalogs-${process.pid}-${randomUUID()}`);
const SUNSTONE_SOURCE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Catalog fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    system: { textVariables: true },
    sheets: [
      { id: "s", pak: "chunks", cols: 2, rows: 1 },
      { id: "unused-sheet", pak: "chunks", cols: 1, rows: 1 },
    ],
    items: [
      { id: "key", name: "Key", sprite: "s.0" },
      { id: "unused-item", name: "Unused", sprite: "s.1" },
    ],
    switches: [{ id: "gate", name: "Gate" }, { id: "unused-switch" }],
    variables: [{ id: "score", name: "Score" }, { id: "unused-variable" }],
    sprites: {
      hero: { kind: "image", src: "hero.png" },
      unused: { kind: "image", src: "unused.png" },
    },
    audio: {
      beep: "audio:wav.beep",
      quiet: "audio:qoa.quiet",
    },
    animations: [{
      id: "spark", sheet: "spark.png", count: 1, frameDuration: 0.1,
      timings: [{ frame: 0, se: { id: "beep" } }],
    }],
    commonEvents: [{
      id: "common",
      trigger: "parallel",
      conditionSwitch: "gate",
      commands: [{ op: "extChoice", call: "fixture.pick", args: {}, prompt: "{v:score}", write: { index: "choice" } }],
    }],
    maps: [{
      id: "map",
      name: "Map",
      width: 2,
      height: 1,
      sheets: ["s"],
      ground: ["s.0", "s.1"],
      events: [{
        id: "npc",
        x: 0,
        y: 0,
        pages: [{
          condition: { switch: "gate", item: "key", all: [{ kind: "variable", id: "score", op: ">=", value: 1 }] },
          trigger: "action",
          sprite: "hero",
          commands: [
            { op: "text", lines: ["Score {v:score}"] },
            { op: "item", item: "key", set: "add", count: 1 },
            { op: "se", name: "beep" },
            { op: "if", if: { kind: "appearance", target: "this", sprite: "hero" }, then: [
              { op: "variable", id: "score", set: { op: "copy", from: "choice" } },
            ] },
          ],
        }],
      }],
    }],
  };
}

function source(project = fixture()): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

function success(execution: EditExecution): EditSuccess & { output?: string } {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  return Object.assign(execution.response, { output: execution.output });
}

function failure(execution: EditExecution): { code: string; details?: any } {
  if (execution.response.ok) throw new Error(`expected failure: ${JSON.stringify(execution.response.result)}`);
  return execution.response.error;
}

describe("project catalog operations", () => {
  test("lists and gets all six catalogs, including implicit state ids and full reference details", () => {
    const json = source();
    const expected = new Map([
      ["list-items", ["key", "unused-item"]],
      ["list-sprites", ["hero", "unused"]],
      ["list-audio", ["beep", "quiet"]],
      ["list-sheets", ["s", "unused-sheet"]],
      ["list-switches", ["gate", "unused-switch"]],
      ["list-variables", ["score", "unused-variable", "choice"]],
    ]);
    for (const [command, ids] of expected) {
      const response = success(executeEditOperation(json, command));
      expect((response.result as any[]).map((entry) => entry.id)).toEqual(ids);
      expect(response.changed).toBe(false);
    }

    const variable = success(executeEditOperation(json, "get-variable", { variable: "choice" })).result as any;
    expect(variable).toMatchObject({ id: "choice", declared: false, value: { id: "choice" } });
    expect(variable.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "common:common/command:root#0", field: "write.index", access: "write" }),
    ]));

    const sound = success(executeEditOperation(json, "get-audio", { audio: "beep" })).result as any;
    expect(sound.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "animation:spark", field: "animations[0].timings[0].se.id" }),
      expect.objectContaining({ address: "map:map/event:npc/page:0/command:root#2", field: "name" }),
    ]));
  });

  test("adds, updates and removes every catalog shape through reversible edits", () => {
    const cases = [
      { add: "add-item", addArgs: { item: { id: "new-item", name: "New", sprite: "s.0" } }, update: "update-item", updateArgs: { item: "new-item", changes: { name: "Newer", price: 4 } }, remove: "remove-item", removeArgs: { item: "new-item" } },
      { add: "add-sprite", addArgs: { sprite: "new-sprite", value: { kind: "image", src: "new.png" } }, update: "update-sprite", updateArgs: { sprite: "new-sprite", value: { kind: "walker", sheet: "new-sheet.png" } }, remove: "remove-sprite", removeArgs: { sprite: "new-sprite" } },
      { add: "add-audio", addArgs: { audio: "new-audio", value: "audio:wav.new" }, update: "update-audio", updateArgs: { audio: "new-audio", value: "audio:qoa.new" }, remove: "remove-audio", removeArgs: { audio: "new-audio" } },
      { add: "add-sheet", addArgs: { sheet: { id: "new-sheet", pak: "chunks", cols: 1, rows: 1 } }, update: "update-sheet", updateArgs: { sheet: "new-sheet", changes: { defaultPassage: "block" } }, remove: "remove-sheet", removeArgs: { sheet: "new-sheet" } },
      { add: "add-switch", addArgs: { switch: { id: "new-switch" } }, update: "update-switch", updateArgs: { switch: "new-switch", changes: { name: "New switch" } }, remove: "remove-switch", removeArgs: { switch: "new-switch" } },
      { add: "add-variable", addArgs: { variable: { id: "new-variable" } }, update: "update-variable", updateArgs: { variable: "new-variable", changes: { name: "New variable" } }, remove: "remove-variable", removeArgs: { variable: "new-variable" } },
    ];
    for (const entry of cases) {
      const added = success(executeEditOperation(source(), entry.add, entry.addArgs));
      expect(added.changed).toBe(true);
      const updated = success(executeEditOperation(added.output!, entry.update, entry.updateArgs));
      expect(updated.changed).toBe(true);
      const removed = success(executeEditOperation(updated.output!, entry.remove, entry.removeArgs));
      expect(removed.changed).toBe(true);
      expect(removed.patch?.changes.length).toBeGreaterThan(0);
    }
  });

  test("add-sprite rejects an id alongside the catalog shape instead of ignoring it", () => {
    const json = source();
    // The proposal-flow shape {id, sprite: def} stays accepted.
    expect(success(executeEditOperation(json, "add-sprite", {
      id: "flow-sprite", sprite: { kind: "image", src: "flow.png" },
    })).changed).toBe(true);
    // The catalog shape {sprite: id, value: def} stays accepted.
    expect(success(executeEditOperation(json, "add-sprite", {
      sprite: "catalog-sprite", value: { kind: "image", src: "catalog.png" },
    })).changed).toBe(true);
    // A stray id with the catalog shape is refused, not silently dropped.
    const error = failure(executeEditOperation(json, "add-sprite", {
      sprite: "mixed-sprite", value: { kind: "image", src: "mixed.png" }, id: "ignored",
    }));
    expect(error.code).toBe("INVALID_ARGUMENT");
  });

  test("refuses removal of each referenced resource with a stable reference list", () => {
    const json = source();
    for (const [command, args] of [
      ["remove-item", { item: "key" }],
      ["remove-sprite", { sprite: "hero" }],
      ["remove-audio", { audio: "beep" }],
      ["remove-sheet", { sheet: "s" }],
      ["remove-switch", { switch: "gate" }],
      ["remove-variable", { variable: "score" }],
    ] as const) {
      const error = failure(executeEditOperation(json, command, args));
      expect(error.code).toBe("RESOURCE_IN_USE");
      expect(error.details.references.length).toBeGreaterThan(0);
    }
  });

  test("adds the EDOG key and an NPC giver without constructing a patch by hand", () => {
    const addedItem = success(executeEditOperation(source(), "add-item", {
      item: { id: "storehouse-key", name: "Storehouse Key", sprite: "s.0", type: "key" },
    }));
    const addedNpc = success(executeEditOperation(addedItem.output!, "add-event", {
      map: "map",
      event: {
        id: "key-giver",
        name: "Key Giver",
        x: 1,
        y: 0,
        pages: [{ trigger: "action", commands: [{ op: "item", item: "storehouse-key", set: "add", count: 1 }] }],
      },
    }));
    const read = success(executeEditOperation(addedNpc.output!, "get-item", { item: "storehouse-key" })).result as any;
    expect(read.value).toMatchObject({ id: "storehouse-key", name: "Storehouse Key", type: "key" });
    expect(read.references).toEqual([
      expect.objectContaining({ address: "map:map/event:key-giver/page:0/command:root#0", field: "item" }),
    ]);
    expect(failure(executeEditOperation(addedNpc.output!, "remove-item", { item: "storehouse-key" })).code)
      .toBe("RESOURCE_IN_USE");
  });
});

function materialize(
  project: Project,
  root: string,
  entryEncoding: "json" | "compact" = "json",
): { shellFile: string; shell: ProjectShell } {
  const split = splitProjectMaps(project, {
    entryEncoding,
    mapEntry: (id) => `maps/${id}.${entryEncoding === "compact" ? "rkm" : "json"}`,
  });
  const shellFile = join(root, "project.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(shellFile, split.shellText);
  for (const entry of split.entries) {
    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.text);
  }
  return { shellFile, shell: split.shell };
}

describe("catalog transports and sharded projects", () => {
  test("catalog scans decode compact map shards and shell-only edits preserve their bytes", () => {
    const root = join(TEMP, "compact-sharded");
    const { shellFile, shell } = materialize(fixture(), root, "compact");
    const mapFile = join(root, shell.mapIndex[0]!.entry);
    const beforeMap = readFileSync(mapFile, "utf8");

    const listed = runFileEdit({ command: "list-variables", file: shellFile, root });
    expect(listed).toMatchObject({ ok: true, changed: false, written: false });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    expect((listed.result as any[]).find((row) => row.id === "choice"))
      .toMatchObject({ declared: false, referenceCount: 2 });

    expect(runFileEdit({
      command: "add-item",
      file: shellFile,
      root,
      args: { item: { id: "compact-item", name: "Compact Item", sprite: "s.0" } },
    })).toMatchObject({ ok: true, changed: true, written: true, writtenFiles: [shellFile] });
    expect(readFileSync(mapFile, "utf8")).toBe(beforeMap);
    expect(runFileEdit({ command: "remove-item", file: shellFile, root, args: { item: "key" } }))
      .toMatchObject({ ok: false, written: false, error: { code: "RESOURCE_IN_USE" } });
  });

  test("a sharded global edit writes only the shell and keeps a valid manifest", () => {
    const root = join(TEMP, "sharded");
    const { shellFile, shell: before } = materialize(fixture(), root);
    const response = runFileEdit({
      command: "add-item",
      file: shellFile,
      root,
      args: { item: { id: "shard-item", name: "Shard Item", sprite: "s.0" } },
    });
    expect(response).toMatchObject({ ok: true, changed: true, written: true, writtenFiles: [shellFile] });
    const after = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    expect(after.items.at(-1)?.id).toBe("shard-item");
    expect(after.mapIndex).toEqual(before.mapIndex);
    expect(after.mapManifestHash).toBe(mapManifestHash(after));
    expect(runFileEdit({ command: "list-items", file: shellFile, root })).toMatchObject({ ok: true });
    expect(runFileEdit({ command: "remove-item", file: shellFile, root, args: { item: "key" } }))
      .toMatchObject({ ok: false, written: false, error: { code: "RESOURCE_IN_USE" } });
    expect(runFileEdit({ command: "remove-item", file: shellFile, root, args: { item: "shard-item" } }))
      .toMatchObject({ ok: true, changed: true, written: true, writtenFiles: [shellFile] });
    expect(runFileEdit({ command: "get-item", file: shellFile, root, args: { item: "shard-item" } }))
      .toMatchObject({ ok: false, written: false, error: { code: "RESOURCE_NOT_FOUND" } });
  });

  test.each(["json", "compact"] as const)(
    "catalog add/update on a multi-map shell writes the shell and leaves shards untouched (%s)",
    (encoding) => {
      const root = join(TEMP, `multimap-${encoding}`);
      const project = JSON.parse(SUNSTONE_SOURCE) as Project;
      const { shellFile, shell } = materialize(project, root, encoding);
      expect(shell.mapIndex.length).toBe(3);
      const shardFiles = shell.mapIndex.map((meta) => join(root, meta.entry));
      const beforeShards = shardFiles.map((file) => readFileSync(file, "utf8"));
      const beforeStart = shell.start;

      const cases: Array<{
        command: string;
        args: Record<string, unknown>;
        verify: (onDisk: ProjectShell) => void;
      }> = [
        {
          command: "update-item",
          args: { item: "torch", changes: { name: "Probe Torch" } },
          verify: (onDisk) => expect(onDisk.items?.find((item) => item.id === "torch")?.name).toBe("Probe Torch"),
        },
        {
          command: "add-switch",
          args: { switch: { id: "probe-switch", name: "Probe Switch" } },
          verify: (onDisk) => expect(onDisk.switches?.some((entry) => entry.id === "probe-switch")).toBe(true),
        },
        {
          command: "update-switch",
          args: { switch: "probe-switch", changes: { name: "Renamed Switch" } },
          verify: (onDisk) => expect(onDisk.switches?.find((entry) => entry.id === "probe-switch")?.name).toBe("Renamed Switch"),
        },
        {
          command: "add-variable",
          args: { variable: { id: "probe-var", name: "Probe Variable" } },
          verify: (onDisk) => expect(onDisk.variables?.some((entry) => entry.id === "probe-var")).toBe(true),
        },
        {
          command: "update-variable",
          args: { variable: "probe-var", changes: { name: "Renamed Variable" } },
          verify: (onDisk) => expect(onDisk.variables?.find((entry) => entry.id === "probe-var")?.name).toBe("Renamed Variable"),
        },
        {
          command: "add-audio",
          args: { audio: "probe-beep", value: "audio:wav.probe-beep" },
          verify: (onDisk) => expect(onDisk.audio?.["probe-beep"]).toBe("audio:wav.probe-beep"),
        },
        {
          command: "update-audio",
          args: { audio: "probe-beep", value: "audio:qoa.probe-beep" },
          verify: (onDisk) => expect(onDisk.audio?.["probe-beep"]).toBe("audio:qoa.probe-beep"),
        },
        {
          command: "add-sheet",
          args: { sheet: { id: "probe-sheet", pak: "chunks", cols: 1, rows: 1 } },
          verify: (onDisk) => expect(onDisk.sheets?.some((entry) => entry.id === "probe-sheet")).toBe(true),
        },
        {
          command: "update-sheet",
          args: { sheet: "probe-sheet", changes: { cols: 2 } },
          verify: (onDisk) => expect(onDisk.sheets?.find((entry) => entry.id === "probe-sheet")?.cols).toBe(2),
        },
        {
          command: "update-sprite",
          args: { sprite: "wiz", value: { kind: "image", src: "assets/npc/wiz-probe.png" } },
          verify: (onDisk) => expect(onDisk.sprites?.wiz).toEqual({ kind: "image", src: "assets/npc/wiz-probe.png" }),
        },
      ];

      for (const { command, args, verify } of cases) {
        const response = runFileEdit({ command, file: shellFile, root, args });
        expect(response, command).toMatchObject({ ok: true, changed: true, written: true, writtenFiles: [shellFile] });
        verify(JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell);
      }

      // A global-only removal still publishes on a multi-map shell (the
      // original EDX3 case: no shard changes, only the shell differs).
      expect(runFileEdit({
        command: "add-item",
        file: shellFile,
        root,
        args: { item: { id: "probe-removable", name: "Removable", sprite: "town.0" } },
      })).toMatchObject({ ok: true, changed: true, written: true });
      expect(runFileEdit({ command: "remove-item", file: shellFile, root, args: { item: "probe-removable" } }))
        .toMatchObject({ ok: true, changed: true, written: true, writtenFiles: [shellFile] });

      // Catalog edits never touch shard bytes or the shell start map.
      shardFiles.forEach((file, index) => {
        expect(readFileSync(file, "utf8"), file).toBe(beforeShards[index]);
      });
      const after = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
      expect(after.start).toEqual(beforeStart);
      expect(after.mapManifestHash).toBe(mapManifestHash(after));
    },
  );

  test("CLI and MCP expose the same item lifecycle and domain errors", async () => {
    const cliFile = join(TEMP, "cli.json");
    writeFileSync(cliFile, source());
    const cli = Bun.spawnSync({
      cmd: [process.execPath, "tools/rpgkit-edit/cli.ts", "add-item", "--file", cliFile, "--json", JSON.stringify({ item: { id: "transport-key", name: "Transport Key", sprite: "s.0" } })],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString())).toMatchObject({ ok: true, command: "add-item", written: true });

    const mcpRead = await dispatchMcpMessage({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "rpgkit_item_get", arguments: { file: cliFile, item: "transport-key" } },
    });
    expect(mcpRead).toMatchObject({ result: { isError: false, structuredContent: { ok: true, command: "get-item" } } });

    const mcpFailure = await dispatchMcpMessage({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "rpgkit_item_remove", arguments: { file: cliFile, item: "key" } },
    });
    expect(mcpFailure).toMatchObject({
      result: { isError: true, structuredContent: { ok: false, error: { code: "RESOURCE_IN_USE" } } },
    });
  });

  test("all thirty MCP catalog tools complete a lifecycle with their public schemas", async () => {
    const cases = [
      {
        plural: "items", singular: "item", selector: "item", id: "mcp-item",
        add: { item: { id: "mcp-item", name: "MCP Item", sprite: "s.0" } },
        update: { item: "mcp-item", changes: { name: "MCP Item 2" } },
      },
      {
        plural: "sprites", singular: "sprite", selector: "sprite", id: "mcp-sprite",
        add: { sprite: "mcp-sprite", value: { kind: "image", src: "mcp.png" } },
        update: { sprite: "mcp-sprite", value: { kind: "walker", sheet: "mcp-walker.png" } },
      },
      {
        plural: "audio", singular: "audio", selector: "audio", id: "mcp-audio",
        add: { audio: "mcp-audio", value: "audio:wav.mcp" },
        update: { audio: "mcp-audio", value: "audio:qoa.mcp" },
      },
      {
        plural: "sheets", singular: "sheet", selector: "sheet", id: "mcp-sheet",
        add: { sheet: { id: "mcp-sheet", pak: "chunks", cols: 1, rows: 1 } },
        update: { sheet: "mcp-sheet", changes: { defaultPassage: "block" } },
      },
      {
        plural: "switches", singular: "switch", selector: "switch", id: "mcp-switch",
        add: { switch: { id: "mcp-switch" } },
        update: { switch: "mcp-switch", changes: { name: "MCP Switch" } },
      },
      {
        plural: "variables", singular: "variable", selector: "variable", id: "mcp-variable",
        add: { variable: { id: "mcp-variable" } },
        update: { variable: "mcp-variable", changes: { name: "MCP Variable" } },
      },
    ] as const;

    for (const entry of cases) {
      const file = join(TEMP, `${entry.singular}.json`);
      writeFileSync(file, source());
      const invoke = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const response = await dispatchMcpMessage({
          jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { file, ...args } },
        });
        expect(response).toMatchObject({ result: { isError: false, structuredContent: { ok: true } } });
        return response;
      };
      await invoke(`rpgkit_${entry.plural}_list`, {});
      await invoke(`rpgkit_${entry.singular}_add`, entry.add);
      await invoke(`rpgkit_${entry.singular}_get`, { [entry.selector]: entry.id });
      await invoke(`rpgkit_${entry.singular}_update`, entry.update);
      await invoke(`rpgkit_${entry.singular}_remove`, { [entry.selector]: entry.id });

      const missing = await dispatchMcpMessage({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: `rpgkit_${entry.singular}_get`, arguments: { file, [entry.selector]: entry.id } },
      });
      expect(missing).toMatchObject({
        result: { isError: true, structuredContent: { ok: false, error: { code: "RESOURCE_NOT_FOUND" } } },
      });
    }

    expect(await dispatchMcpMessage({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "rpgkit_item_add", arguments: { file: join(TEMP, "item.json"), item: { id: "bad" } } },
    })).toMatchObject({ error: { code: -32602 } });
  });
});
