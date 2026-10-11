import { describe, expect, test } from "bun:test";
import { executeEditOperation } from "../editor/api/operations.ts";
import { executeShardedEditOperation, shardEntriesForOperation } from "../editor/api/sharded.ts";
import type { Project, ProjectShell } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Mobility editor",
    tileSize: 16,
    start: { map: "field", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 1, rows: 1 }],
    items: [],
    sprites: {
      actor: { kind: "image", src: "actor.png" },
      boat: { kind: "image", src: "boat.png" },
      airship: { kind: "image", src: "airship.png" },
    },
    maps: [{
      id: "field",
      name: "Field",
      width: 4,
      height: 3,
      sheets: ["s"],
      ground: new Array(12).fill(null),
      events: [],
    }],
  };
}

const update: { followersEnabled: boolean; vehicles: NonNullable<Project["vehicles"]> } = {
  followersEnabled: true,
  vehicles: [
    { id: "skiff", kind: "boat", sprite: "boat", start: { map: "field", x: 3, y: 2, dir: "left" } },
    { id: "falcon", kind: "airship", sprite: "airship", start: { map: "field", x: 1, y: 1, dir: "up" } },
  ],
};

describe("followers and vehicles editor operation", () => {
  test("updates inline globals atomically and preserves follower members", () => {
    const project = fixture();
    project.followers = { enabled: false, members: [{ id: "friend", sprite: "actor" }] };
    const execution = executeEditOperation(JSON.stringify(project), "update-mobility", update);
    expect(execution.response).toMatchObject({ ok: true, changed: true, addresses: ["mobility"] });
    expect(execution.output).toBeDefined();
    const edited = JSON.parse(execution.output!) as Project;
    expect(edited.followers).toEqual({ enabled: true, members: [{ id: "friend", sprite: "actor" }] });
    expect(edited.vehicles).toEqual(update.vehicles);
  });

  test("rejects duplicate ids, duplicate kinds, malformed ids, and out-of-bounds starts", () => {
    const source = JSON.stringify(fixture());
    const failure = (vehicles: unknown[]) => executeEditOperation(source, "update-mobility", {
      followersEnabled: false,
      vehicles,
    }).response;
    const base = update.vehicles[0]!;
    expect(failure([base, { ...base, kind: "ship" }])).toMatchObject({ ok: false, error: { code: "DUPLICATE_VEHICLE", path: "$.vehicles[1].id" } });
    expect(failure([base, { ...base, id: "ship", sprite: "boat" }])).toMatchObject({ ok: false, error: { code: "DUPLICATE_VEHICLE", path: "$.vehicles[1].kind" } });
    expect(failure([{ ...base, id: "bad.id" }])).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.vehicles[0].id" } });
    expect(failure([{ ...base, start: { ...base.start, x: 4 } }])).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.vehicles[0].start.x" } });
  });

  test("is shard-free and validates starts from shell index dimensions", () => {
    const split = splitProjectMaps(fixture());
    expect(shardEntriesForOperation(split.shell, "update-mobility", update)).toEqual([]);
    const execution = executeShardedEditOperation(split.shellText, {}, "update-mobility", update);
    expect(execution.response).toMatchObject({ ok: true, changed: true, addresses: ["mobility"] });
    expect(execution.output?.shards).toEqual({});
    const shell = JSON.parse(execution.output!.shell) as ProjectShell;
    expect(shell.followers?.enabled).toBe(true);
    expect(shell.vehicles).toEqual(update.vehicles);
    expect(shell.mapIndex).toEqual(split.shell.mapIndex);

    const outside = executeShardedEditOperation(split.shellText, {}, "update-mobility", {
      followersEnabled: true,
      vehicles: [{ ...update.vehicles[0]!, start: { map: "field", x: 0, y: 3, dir: "down" } }],
    });
    expect(outside.response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.vehicles[0].start.y" } });
  });
});
