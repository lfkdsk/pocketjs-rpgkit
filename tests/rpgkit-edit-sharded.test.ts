import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectFileLockPath, runFileEdit } from "../editor/api/file.ts";
import { withFileLock } from "../editor/api/lock.ts";
import { proposalDirectoryFor, runProposalFileCommand } from "../editor/api/proposals.ts";
import type { EditPatch } from "../editor/api/types.ts";
import {
  createJsonMapRepository,
  mapManifestHash,
  sha256Text,
} from "../src/engine/map-repository.ts";
import type { Command, MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const TEMP = join(import.meta.dir, `.rpgkit-edit-sharded-${process.pid}-${randomUUID()}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function transfer(map: string): Command {
  return { op: "transfer", map, x: 0, y: 0 };
}

function mapAt(index: number, count: number): MapDef {
  const id = `map-${String(index).padStart(3, "0")}`;
  return {
    id,
    name: `Map ${index}`,
    width: 2,
    height: 1,
    sheets: ["s"],
    ground: ["s.0", "s.0"],
    events: index === count - 1
      ? [{
          id: "exit",
          x: 0,
          y: 0,
          pages: [{ trigger: "action", commands: [transfer("map-000")] }],
        }]
      : [],
  };
}

function syntheticProject(count = 263): Project {
  return {
    format: "rpgkit-project/v1",
    title: `${count} map sharded acceptance`,
    tileSize: 16,
    start: { map: "map-000", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    commonEvents: [{ id: "return-home", trigger: "none", commands: [transfer("map-000")] }],
    maps: Array.from({ length: count }, (_, index) => mapAt(index, count)),
  };
}

function materialize(project: Project, root: string): { shellFile: string; shell: ProjectShell } {
  const split = splitProjectMaps(project, {
    mapEntry: (id) => id === "map-000" ? "maps/a~b/map-000.json" : `maps/${id}.json`,
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

function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (relative: string): void => {
    const directory = join(root, relative);
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) files.set(next, readFileSync(join(root, next)).toString("base64"));
    }
  };
  visit("");
  return files;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

describe("rpgkit-edit ProjectShell protocol", () => {
  test("splits the same 263-map project into byte-identical output", () => {
    const project = syntheticProject();
    const options = {
      mapEntry: (id: string) => id === "map-000" ? "maps/a~b/map-000.json" : `maps/${id}.json`,
    };
    const first = splitProjectMaps(project, options);
    const second = splitProjectMaps(project, options);

    expect(second.shellText).toBe(first.shellText);
    expect(second.entries).toEqual(first.entries);
  });

  test("proposal sidecar commands on a shell stay sidecar-only; assessment reads only touched shards", () => {
    const root = join(TEMP, "proposal-boundary");
    const { shellFile } = materialize(syntheticProject(2), root);
    const proposalDirectory = proposalDirectoryFor(shellFile);
    const proposal = {
      id: "sharded-boundary",
      title: "Inline-only proposal",
      rationale: "Exercise the ProjectShell boundary.",
      author: "test",
      createdAt: "2026-10-01T00:00:00.000Z",
      baseHash: "0".repeat(64),
      hunks: [{
        id: "map-name",
        summary: "Rename the first inline map",
        changes: [{
          path: "/maps/0/name",
          before: { exists: true, value: "Map 0" },
          after: { exists: true, value: "Renamed" },
        }],
      }],
    };
    mkdirSync(proposalDirectory, { recursive: true });
    writeFileSync(join(proposalDirectory, `${proposal.id}.json`), `${JSON.stringify(proposal, null, 2)}\n`);

    const maps = join(root, "maps");
    const offline = join(root, "maps-offline");
    renameSync(maps, offline);
    try {
      // Request validation fails before any shard IO.
      expect(runProposalFileCommand({ command: "propose", file: shellFile, args: {} })).toMatchObject({
        ok: false,
        written: false,
        error: { code: "INVALID_PROPOSAL_REQUEST" },
      });
      // An inline proposal next to a shell assesses against the shell's
      // sparse document without reading shards (it has no /shards paths).
      expect(runProposalFileCommand({ command: "list-proposals", file: shellFile })).toMatchObject({
        ok: true,
        written: false,
        result: [{ id: proposal.id, assessment: { hasConflicts: true } }],
      });
      expect(runProposalFileCommand({ command: "show-proposal", file: shellFile, args: { id: proposal.id } })).toMatchObject({
        ok: true,
        written: false,
        result: { archived: false, assessment: { hasConflicts: true } },
      });
      // Withdrawal remains sidecar-only.
      expect(runProposalFileCommand({
        command: "withdraw-proposal",
        file: shellFile,
        args: { id: proposal.id },
      })).toMatchObject({ ok: true, written: true, result: { withdrawn: true } });
      expect(readdirSync(proposalDirectory).filter((name) => name.endsWith(".json"))).toEqual([]);
    } finally {
      renameSync(offline, maps);
    }
  });

  test("sharded mutations share the project lock and publish no bytes while it is busy", () => {
    const root = join(TEMP, "project-lock");
    const { shellFile } = materialize(syntheticProject(2), root);
    const before = snapshotFiles(root);
    const response = withFileLock(projectFileLockPath(shellFile), () => runFileEdit({
      command: "paint-tile",
      file: shellFile,
      root,
      args: { map: "map-000", x: 0, y: 0, tile: "s.1" },
    }));
    expect(response).toMatchObject({ ok: false, written: false, error: { code: "WRITE_CONFLICT" } });
    expect(snapshotFiles(root)).toEqual(before);
  });

  test("edits a 263-map project with bounded loading, stable logical patches, rename rewrites, and repository reacquire", () => {
    const root = join(TEMP, "large");
    const { shellFile, shell } = materialize(syntheticProject(), root);
    const mapsDir = join(root, "maps");
    const offline = join(root, "maps-offline");

    // Shell-only reads do not touch any shard.
    renameSync(mapsDir, offline);
    expect(runFileEdit({ command: "open", file: shellFile, root })).toMatchObject({
      ok: true,
      result: { documentKind: "shell", editable: true, mapCount: 263 },
    });
    const listed = runFileEdit({ command: "list-maps", file: shellFile, root });
    expect(listed.ok && (listed.result as unknown[])).toHaveLength(263);
    renameSync(offline, mapsDir);

    // Ordinary reads/writes need only their target. An absent unrelated map
    // is harmless, while validate and id rename correctly require all maps.
    const unrelated = join(root, "maps/map-100.json");
    const unavailable = `${unrelated}.missing`;
    renameSync(unrelated, unavailable);
    expect(runFileEdit({ command: "list-events", file: shellFile, root, args: { map: "map-000" } }))
      .toMatchObject({ ok: true });
    expect(runFileEdit({
      command: "update-map",
      file: shellFile,
      root,
      dryRun: true,
      args: { map: "map-000", changes: { id: "map-renamed" } },
    })).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    expect(runFileEdit({ command: "validate", file: shellFile, root }))
      .toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    renameSync(unavailable, unrelated);
    expect(runFileEdit({ command: "validate", file: shellFile, root }))
      .toMatchObject({ ok: true, result: { valid: true, errors: [] } });

    const targetEntry = shell.mapIndex[0]!.entry;
    const targetPath = join(root, targetEntry);
    const untouchedPath = join(root, shell.mapIndex[1]!.entry);
    const untouched = readFileSync(untouchedPath, "utf8");
    const preview = runFileEdit({
      command: "paint-tile",
      file: shellFile,
      root,
      dryRun: true,
      args: { map: "map-000", x: 0, y: 0, tile: "s.1" },
    });
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.patch?.changes.some((change) => change.path === "/shards/maps~1a~0b~1map-000.json/ground/0"))
      .toBe(true);
    expect(preview.patch?.changes.some((change) => change.path.startsWith("/shell/"))).toBe(true);
    expect(preview.patch?.changes.every((change) =>
      change.path.startsWith("/shell/") || change.path.startsWith("/shards/maps~1a~0b~1map-000.json/"),
    )).toBe(true);

    const patch = preview.patch as EditPatch;
    const beforeSave = snapshotFiles(root);
    const forward = runFileEdit({ command: "save", file: shellFile, root, args: { patch } });
    expect(forward).toMatchObject({ ok: true, written: true, writtenFiles: [targetPath, shellFile] });
    expect(changedFiles(beforeSave, snapshotFiles(root))).toEqual([targetEntry, "project.json"].sort());
    expect((JSON.parse(readFileSync(targetPath, "utf8")) as MapDef).ground[0]).toBe("s.1");
    expect(readFileSync(untouchedPath, "utf8")).toBe(untouched);
    expect(runFileEdit({ command: "save", file: shellFile, root, args: { patch } }))
      .toMatchObject({ ok: false, error: { code: "PATCH_BASE_MISMATCH" } });
    expect(runFileEdit({ command: "save", file: shellFile, root, args: { patch, direction: "reverse" } }))
      .toMatchObject({ ok: true, written: true });
    expect((JSON.parse(readFileSync(targetPath, "utf8")) as MapDef).ground[0]).toBe("s.0");

    const renamed = runFileEdit({
      command: "update-map",
      file: shellFile,
      root,
      args: { map: "map-000", changes: { id: "map-renamed" } },
    });
    expect(renamed).toMatchObject({ ok: true, written: true });
    const nextShell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    expect(nextShell.mapIndex[0]).toMatchObject({ id: "map-renamed", entry: targetEntry });
    expect(nextShell.start.map).toBe("map-renamed");
    expect((nextShell.commonEvents![0]!.commands[0] as Extract<Command, { op: "transfer" }>).map)
      .toBe("map-renamed");
    const lastEntry = nextShell.mapIndex.at(-1)!.entry;
    const lastMap = JSON.parse(readFileSync(join(root, lastEntry), "utf8")) as MapDef;
    expect((lastMap.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "transfer" }>).map)
      .toBe("map-renamed");
    expect(readFileSync(untouchedPath, "utf8")).toBe(untouched);

    const repository = createJsonMapRepository(nextShell.mapIndex, {
      read: (entry) => readFileSync(join(root, entry), "utf8"),
    }, { verify: true, validate: "full" });
    const first = repository.acquire("map-renamed");
    repository.releaseExcept([]);
    const reacquired = repository.acquire("map-renamed");
    expect(reacquired).not.toBe(first);
    expect(reacquired.id).toBe("map-renamed");
    expect(repository.acquire("map-262").events![0]!.pages[0]!.commands[0])
      .toMatchObject({ op: "transfer", map: "map-renamed" });
  });

  test("rejects stale identities, shard metadata drift, traversal, and symlink escapes", () => {
    const root = join(TEMP, "safety");
    const { shellFile } = materialize(syntheticProject(2), root);
    const originalShell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;

    writeFileSync(shellFile, JSON.stringify({ ...originalShell, title: "stale manifest" }));
    expect(runFileEdit({ command: "open", file: shellFile, root }))
      .toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT", path: "$.mapManifestHash" } });
    writeFileSync(shellFile, JSON.stringify(originalShell));

    const targetMeta = originalShell.mapIndex[0]!;
    const targetPath = join(root, targetMeta.entry);
    const map = JSON.parse(readFileSync(targetPath, "utf8")) as MapDef;
    const wrong = { ...map, id: "different-id" };
    const wrongText = JSON.stringify(wrong);
    const wrongIndex = originalShell.mapIndex.map((meta, index) => index === 0
      ? { ...meta, sha256: sha256Text(wrongText) }
      : meta);
    const unhashed = { ...originalShell, mapIndex: wrongIndex, mapManifestHash: undefined };
    const wrongShell: ProjectShell = { ...unhashed, mapManifestHash: mapManifestHash(unhashed) };
    writeFileSync(targetPath, wrongText);
    writeFileSync(shellFile, JSON.stringify(wrongShell));
    expect(runFileEdit({ command: "list-events", file: shellFile, root, args: { map: "map-000" } }))
      .toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT" } });

    // Restore valid content, then make the target entry a symlink escaping
    // the configured root. The checksum is irrelevant: resolution fails first.
    const clean = splitProjectMaps(syntheticProject(2), {
      mapEntry: (id) => id === "map-000" ? "maps/a~b/map-000.json" : `maps/${id}.json`,
    });
    writeFileSync(shellFile, clean.shellText);
    const outside = join(TEMP, "outside-map.json");
    writeFileSync(outside, clean.entries[0]!.text);
    rmSync(targetPath);
    symlinkSync(outside, targetPath);
    expect(runFileEdit({ command: "list-events", file: shellFile, root, args: { map: "map-000" } }))
      .toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_ROOT" } });

    const traversalShell: ProjectShell = {
      ...clean.shell,
      mapIndex: clean.shell.mapIndex.map((meta, index) => index === 0 ? { ...meta, entry: "../outside-map.json" } : meta),
      mapManifestHash: undefined,
    };
    traversalShell.mapManifestHash = mapManifestHash(traversalShell);
    writeFileSync(shellFile, JSON.stringify(traversalShell));
    expect(runFileEdit({ command: "list-events", file: shellFile, root, args: { map: "map-000" } }))
      .toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  });
});
