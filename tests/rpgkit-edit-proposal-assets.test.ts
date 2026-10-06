import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "../src/engine/types.ts";
import {
  canonicalMapJson,
  MAP_SCHEMA_HASH,
  mapManifestHash,
  sha256Text,
} from "../src/engine/map-repository.ts";
import { serializeProject } from "../editor/engine/document.ts";
import {
  applyAcceptedProposalReview,
  loadPendingProposals,
  proposalArchiveDirectoryFor,
  runProposalFileCommand,
} from "../editor/api/proposals.ts";
import { decideProposalHunks } from "../editor/proposals/model.ts";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE_PNG = join(ROOT, "examples/sunstone/assets/npc/slime.png");
const TEMP = join(import.meta.dir, `.proposal-assets-${process.pid}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Proposal asset fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 2 }],
    items: [],
    maps: [{
      id: "map",
      name: "Map",
      width: 2,
      height: 2,
      sheets: ["s"],
      ground: new Array(4).fill("s.0"),
      events: [],
    }],
  };
}

let counter = 0;
function newFile(): string {
  const dir = join(TEMP, `case-${++counter}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "game.json");
  writeFileSync(file, serializeProject(fixture()));
  return file;
}

function newShellFile(): string {
  const dir = join(TEMP, `shell-${++counter}`);
  mkdirSync(join(dir, "maps"), { recursive: true });
  const project = fixture();
  const map = project.maps[0]!;
  const mapText = canonicalMapJson(map);
  const { maps: _maps, ...globals } = project;
  const shell = {
    ...globals,
    mapIndex: [{ id: map.id, width: map.width, height: map.height, entry: "maps/map.json", sha256: sha256Text(mapText) }],
    mapSchemaHash: MAP_SCHEMA_HASH,
  };
  Object.assign(shell, { mapManifestHash: mapManifestHash(shell) });
  writeFileSync(join(dir, "maps/map.json"), mapText);
  const file = join(dir, "project-shell.json");
  writeFileSync(file, `${JSON.stringify(shell, null, 2)}\n`);
  return file;
}

function png() {
  return { type: "image/png", data: readFileSync(SOURCE_PNG).toString("base64") };
}

function request(id: string) {
  return {
    id,
    title: "Add a sheep key",
    rationale: "Register the art and a real key item in one reviewed change.",
    author: "test",
    createdAt: "2026-10-05T12:00:00.000Z",
    hunks: [{
      id: "catalog-and-art",
      summary: "Add the item, sprite registration, and PNG",
      operations: [
        { command: "add-item", args: { item: { id: "village-key", name: "Village Key", sprite: "s.1", type: "key" } } },
        { command: "add-sprite", args: { id: "sheep", sprite: { kind: "image", src: "assets/npc/sheep.png" } } },
        { command: "add-asset", args: { path: "assets/npc/sheep.png", ...png() } },
      ],
    }],
  };
}

describe("proposal-owned items, sprites, and PNG assets", () => {
  test("creation is side-effect free; dry-run and rejection never publish an asset", () => {
    const file = newFile();
    const projectBefore = readFileSync(file, "utf8");
    const asset = join(file, "..", "assets/npc/sheep.png");
    const created = runProposalFileCommand({ command: "propose", file, args: request("asset-dry") });
    expect(created).toMatchObject({
      ok: true,
      result: { proposal: { hunks: [{ assets: { "assets/npc/sheep.png": { type: "image/png" } } }] } },
    });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(existsSync(asset)).toBe(false);

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-dry" }, dryRun: true }))
      .toMatchObject({ ok: true, written: false, result: { projectChanged: true } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(existsSync(asset)).toBe(false);

    expect(runProposalFileCommand({ command: "reject-proposal", file, args: { id: "asset-dry" } }))
      .toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(existsSync(asset)).toBe(false);
  });

  test("accept publishes JSON and exact PNG bytes, then archives the attachment", () => {
    const file = newFile();
    const asset = resolve(file, "../assets/npc/sheep.png");
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-accept") }))
      .toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    const accepted = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-accept", source: "reviewer" } });
    expect(accepted).toMatchObject({
      ok: true,
      written: true,
      result: { status: "accepted", projectChanged: true, appliedHunks: ["catalog-and-art"] },
    });

    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(project.items).toContainEqual({ id: "village-key", name: "Village Key", sprite: "s.1", type: "key" });
    expect(project.sprites?.sheep).toEqual({ kind: "image", src: "assets/npc/sheep.png" });
    expect(readFileSync(asset)).toEqual(readFileSync(SOURCE_PNG));

    const archived = JSON.parse(readFileSync(join(proposalArchiveDirectoryFor(file), "asset-accept.json"), "utf8"));
    expect(archived.hunks[0].assets["assets/npc/sheep.png"]).toEqual(png());
  });

  test("Studio review acceptance uses the same asset publication path", () => {
    const file = newFile();
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-studio") }))
      .toMatchObject({ ok: true });
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(
      proposal,
      ["catalog-and-art"],
      "accepted",
      "2026-10-05T12:01:00.000Z",
      "studio",
    );
    expect(applyAcceptedProposalReview(file, accepted)).toMatchObject({ projectChanged: true });
    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(project.items.some((item) => item.id === "village-key")).toBe(true);
    expect(project.sprites?.sheep).toBeDefined();
    expect(readFileSync(resolve(file, "../assets/npc/sheep.png"))).toEqual(readFileSync(SOURCE_PNG));
  });

  test("the same item, sprite, and asset proposal works on a ProjectShell", () => {
    const file = newShellFile();
    const shard = resolve(file, "../maps/map.json");
    const shardBefore = readFileSync(shard, "utf8");
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-shell") }))
      .toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-shell" } }))
      .toMatchObject({ ok: true, result: { status: "accepted", publishedAssets: ["assets/npc/sheep.png"] } });
    const shell = JSON.parse(readFileSync(file, "utf8"));
    expect(shell.items).toContainEqual({ id: "village-key", name: "Village Key", sprite: "s.1", type: "key" });
    expect(shell.sprites.sheep).toEqual({ kind: "image", src: "assets/npc/sheep.png" });
    expect(readFileSync(shard, "utf8")).toBe(shardBefore);
    expect(readFileSync(resolve(file, "../assets/npc/sheep.png"))).toEqual(readFileSync(SOURCE_PNG));
  });

  test("a differing existing asset conflicts without changing project or queue", () => {
    const file = newFile();
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-conflict") }))
      .toMatchObject({ ok: true });
    const asset = resolve(file, "../assets/npc/sheep.png");
    mkdirSync(resolve(asset, ".."), { recursive: true });
    writeFileSync(asset, "different bytes");
    const projectBefore = readFileSync(file, "utf8");

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-conflict" } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_HUNK_CONFLICT" } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(readFileSync(asset, "utf8")).toBe("different bytes");
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [{ id: "asset-conflict" }] });
  });

  test("an identical pre-existing asset plus clean JSON is partially applied and fails closed", () => {
    const file = newFile();
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-partial") }))
      .toMatchObject({ ok: true });
    const asset = resolve(file, "../assets/npc/sheep.png");
    mkdirSync(resolve(asset, ".."), { recursive: true });
    writeFileSync(asset, readFileSync(SOURCE_PNG));
    const projectBefore = readFileSync(file, "utf8");
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-partial" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_HUNK_CONFLICT", actual: ["catalog-and-art"] } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
  });

  test("an archive collision rolls back both the JSON edit and a newly published asset", () => {
    const file = newFile();
    expect(runProposalFileCommand({ command: "propose", file, args: request("asset-archive-conflict") }))
      .toMatchObject({ ok: true });
    const projectBefore = readFileSync(file, "utf8");
    const asset = resolve(file, "../assets/npc/sheep.png");
    const pendingPath = join(`${file}.proposals`, "asset-archive-conflict.json");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    writeFileSync(
      join(proposalArchiveDirectoryFor(file), "asset-archive-conflict.json"),
      `${JSON.stringify({ ...pending, title: "Conflicting archive" }, null, 2)}\n`,
    );

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "asset-archive-conflict" } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_ALREADY_EXISTS" } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(existsSync(asset)).toBe(false);
    expect(existsSync(pendingPath)).toBe(true);
  });

  test("a late archive QA failure removes published assets and restores JSON", () => {
    const file = newFile();
    const id = "asset-archive-qa-failure";
    expect(runProposalFileCommand({ command: "propose", file, args: request(id) }))
      .toMatchObject({ ok: true });
    const projectBefore = readFileSync(file, "utf8");
    const asset = resolve(file, "../assets/npc/sheep.png");
    const pendingPath = join(`${file}.proposals`, `${id}.json`);
    mkdirSync(join(proposalArchiveDirectoryFor(file), "qa", `${id}.json`));

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_IO_ERROR" } });
    expect(readFileSync(file, "utf8")).toBe(projectBefore);
    expect(existsSync(asset)).toBe(false);
    expect(existsSync(resolve(file, "../assets"))).toBe(false);
    expect(existsSync(pendingPath)).toBe(true);
  });

  test("unsafe paths and malformed PNG payloads are rejected at proposal creation", () => {
    const file = newFile();
    const unsafe = request("unsafe-asset");
    unsafe.hunks[0]!.operations[2] = { command: "add-asset", args: { path: "../escape.png", ...png() } };
    expect(runProposalFileCommand({ command: "propose", file, args: unsafe }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PROPOSAL", message: expect.stringContaining("unsafe asset path") } });

    const malformed = request("malformed-asset");
    malformed.hunks[0]!.operations[2] = {
      command: "add-asset",
      args: { path: "assets/npc/not-png.png", type: "image/png", data: "bm90IGEgcG5n" },
    };
    expect(runProposalFileCommand({ command: "propose", file, args: malformed }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PROPOSAL", message: expect.stringContaining("not a PNG image") } });
    expect(existsSync(resolve(file, "../escape.png"))).toBe(false);
  });
});
