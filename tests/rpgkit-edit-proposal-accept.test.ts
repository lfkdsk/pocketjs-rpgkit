import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project } from "../src/engine/types.ts";
import { serializeProject } from "../editor/engine/document.ts";
import { runFileEdit } from "../editor/api/file.ts";
import {
  createProposalFromOperations,
  persistReviewedProposal,
  proposalArchiveDirectoryFor,
  runProposalFileCommand,
} from "../editor/api/proposals.ts";
import { decideProposalHunks } from "../editor/proposals/model.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Acceptance fixture",
    tileSize: 16,
    start: { map: "map", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 2 }],
    items: [],
    sprites: {
      sheep: { kind: "image", src: "assets/sheep.png" },
    },
    maps: [{
      id: "map",
      name: "Map",
      width: 4,
      height: 3,
      sheets: ["s"],
      ground: new Array(12).fill("s.0"),
      events: [{
        id: "npc",
        name: "Guide",
        x: 1,
        y: 1,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Hello"] }] }],
      }],
    }],
  };
}

const TEMP = join(import.meta.dir, `.proposal-accept-${process.pid}`);
const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "tools/rpgkit-edit/cli.ts");
beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

let counter = 0;
function newFile(name = "game"): string {
  counter++;
  const dir = join(TEMP, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, serializeProject(fixture()));
  return file;
}

function propose(file: string, request: unknown) {
  return runProposalFileCommand({ command: "propose", file, args: request });
}

const TWO_HUNKS = {
  id: "p-01",
  title: "Two hunks",
  rationale: "Paint and talk",
  author: "test",
  createdAt: "2026-10-05T12:00:00.000Z",
  hunks: [
    {
      id: "paint",
      summary: "Paint the entrance",
      operations: [{ command: "paint-tile", args: { map: "map", layer: "ground", x: 0, y: 0, tile: "s.3" } }],
    },
    {
      id: "talk",
      summary: "New greeter",
      operations: [{
        command: "add-event",
        args: { map: "map", event: { id: "greeter", x: 3, y: 0, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Hi"] }] }] } },
      }],
    },
  ],
};

describe("proposal accept/reject lifecycle", () => {
  test("accept applies every hunk, writes decisions, archives with source and diff summary", () => {
    const file = newFile();
    const before = readFileSync(file, "utf8");
    const created = propose(file, TWO_HUNKS);
    expect(created).toMatchObject({ ok: true, written: true, result: { qa: { errors: 0 } } });

    const accepted = runProposalFileCommand({
      command: "accept-proposal",
      file,
      args: { id: "p-01", source: "test-reviewer" },
    });
    expect(accepted).toMatchObject({
      ok: true,
      written: true,
      result: {
        id: "p-01",
        status: "accepted",
        projectChanged: true,
        appliedHunks: ["paint", "talk"],
        qa: { errors: 0 },
        summary: { hunks: 2 },
      },
    });
    const result = (accepted as { result: { archived: string; summary: { paths: string[] } } }).result;
    expect(result.archived).toStartWith(proposalArchiveDirectoryFor(file));
    expect(result.summary.paths).toContain("/maps/0/ground/0");

    // The project changed; the pending queue is empty; the archive holds the decision.
    expect(readFileSync(file, "utf8")).not.toBe(before);
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ ok: true, result: [] });
    const history = runProposalFileCommand({ command: "list-archive", file });
    expect(history).toMatchObject({
      ok: true,
      result: [{
        id: "p-01",
        status: "accepted",
        source: "test-reviewer",
        decidedAt: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/),
        summary: { hunks: 2, changes: expect.any(Number) },
        qa: { errors: 0 },
      }],
    });
    const archived = JSON.parse(readFileSync(result.archived, "utf8"));
    expect(archived.hunks.every((h: { decision: { status: string; source: string } }) =>
      h.decision.status === "accepted" && h.decision.source === "test-reviewer")).toBe(true);
  });

  test("reject archives without touching the project", () => {
    const file = newFile();
    const before = readFileSync(file, "utf8");
    expect(propose(file, { ...TWO_HUNKS, id: "p-rej" })).toMatchObject({ ok: true });
    const rejected = runProposalFileCommand({ command: "reject-proposal", file, args: { id: "p-rej", source: "reviewer" } });
    expect(rejected).toMatchObject({ ok: true, written: true, result: { id: "p-rej", status: "rejected" } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [] });
    expect(runProposalFileCommand({ command: "list-archive", file })).toMatchObject({
      result: [{ id: "p-rej", status: "rejected", source: "reviewer" }],
    });
  });

  test("accept dry-run changes nothing", () => {
    const file = newFile();
    const before = readFileSync(file, "utf8");
    expect(propose(file, { ...TWO_HUNKS, id: "p-dry" })).toMatchObject({ ok: true });
    const dry = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-dry" }, dryRun: true });
    expect(dry).toMatchObject({ ok: true, written: false, result: { projectChanged: true } });
    expect(readFileSync(file, "utf8")).toBe(before);
    // Still pending, not archived.
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [{ id: "p-dry" }] });
    expect(runProposalFileCommand({ command: "list-archive", file })).toMatchObject({ result: [] });
  });

  test("QA findings are attached at creation and block accept", () => {
    const file = newFile();
    const bad = {
      id: "p-bad",
      title: "Bad sprite",
      rationale: "References an unregistered sprite",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "ghost",
        summary: "Add a ghost",
        operations: [{
          command: "add-event",
          args: { map: "map", event: { id: "ghost", x: 3, y: 1, pages: [{ trigger: "action", sprite: "poltergeist", commands: [{ op: "text", lines: ["boo"] }] }] } },
        }],
      }],
    };
    const created = propose(file, bad);
    expect(created).toMatchObject({ ok: true, written: true });
    const qa = ((created as { result: { qa: { errors: number; findings: { code: string }[] } } }).result).qa;
    expect(qa.errors).toBeGreaterThan(0);
    expect(qa.findings.some((f) => f.code === "lint/sprite-missing")).toBe(true);

    // list and show carry the QA attachment.
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({
      result: [{ id: "p-bad", qa: { errors: qa.errors } }],
    });
    expect(runProposalFileCommand({ command: "show-proposal", file, args: { id: "p-bad" } })).toMatchObject({
      result: { qa: { errors: qa.errors } },
    });

    // Accept refuses and rolls back: the project bytes stay untouched.
    const before = readFileSync(file, "utf8");
    const refused = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-bad" } });
    expect(refused).toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED" } });
    expect(readFileSync(file, "utf8")).toBe(before);
    // The proposal stays pending so the author can fix and re-propose.
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [{ id: "p-bad" }] });
  });

  test("a conflict at accept rolls the whole acceptance back", () => {
    const file = newFile();
    expect(propose(file, { ...TWO_HUNKS, id: "p-conf" })).toMatchObject({ ok: true });
    // Drift the exact cell the paint hunk expects.
    const drift = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "map", layer: "ground", x: 0, y: 0, tile: "s.1" },
    });
    expect(drift).toMatchObject({ ok: true, written: true });
    const before = readFileSync(file, "utf8");
    const refused = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-conf" } });
    expect(refused).toMatchObject({ ok: false, error: { code: "PROPOSAL_HUNK_CONFLICT" } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(runProposalFileCommand({ command: "list-proposals", file })).toMatchObject({ result: [{ id: "p-conf" }] });
  });

  test("an archive collision rolls back the project and keeps the pending proposal", () => {
    const file = newFile();
    expect(propose(file, { ...TWO_HUNKS, id: "p-archive-conflict" })).toMatchObject({ ok: true });
    const before = readFileSync(file, "utf8");
    const pending = JSON.parse(readFileSync(join(`${file}.proposals`, "p-archive-conflict.json"), "utf8"));
    writeFileSync(
      join(proposalArchiveDirectoryFor(file), "p-archive-conflict.json"),
      `${JSON.stringify({ ...pending, title: "Conflicting archive" }, null, 2)}\n`,
    );

    const refused = runProposalFileCommand({
      command: "accept-proposal",
      file,
      args: { id: "p-archive-conflict" },
    });
    expect(refused).toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_ALREADY_EXISTS" } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(join(`${file}.proposals`, "p-archive-conflict.json"), "utf8")).toContain('"id": "p-archive-conflict"');
  });

  test("an archive QA write failure after project publication restores the project", () => {
    const file = newFile();
    const id = "p-archive-qa-failure";
    expect(propose(file, { ...TWO_HUNKS, id })).toMatchObject({ ok: true });
    const before = readFileSync(file, "utf8");
    const pending = join(`${file}.proposals`, `${id}.json`);

    // archiveWithQa writes this path only after the edited project has been
    // published. A directory at the file target forces that late write to
    // fail and exercises the compensating project write.
    mkdirSync(join(proposalArchiveDirectoryFor(file), "qa", `${id}.json`));
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_IO_ERROR" } });

    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(pending, "utf8")).toContain(`"id": "${id}"`);
  });

  test("a proposal with a partial decision cannot be accepted wholesale", () => {
    const file = newFile();
    expect(propose(file, { ...TWO_HUNKS, id: "p-partial" })).toMatchObject({ ok: true });
    // The desktop review path decides one hunk; the proposal stays pending.
    const pending = createProposalFromOperations(readFileSync(file, "utf8"), { ...TWO_HUNKS, id: "p-partial" });
    const partial = decideProposalHunks(pending, ["paint"], "accepted", "2026-10-05T12:01:00.000Z", "studio");
    expect(persistReviewedProposal(file, partial)).toEndWith("p-partial.json");
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-partial" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_ALREADY_DECIDED" } });
  });

  test("a proposal whose hunks are already applied accepts as a no-op and still archives", () => {
    const file = newFile();
    const oneHunk = {
      id: "p-redo",
      title: "One hunk",
      rationale: "Paint",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "paint",
        summary: "Paint the entrance",
        operations: [{ command: "paint-tile", args: { map: "map", layer: "ground", x: 0, y: 0, tile: "s.3" } }],
      }],
    };
    expect(propose(file, oneHunk)).toMatchObject({ ok: true });
    // Apply the same paint through a direct edit; the hunk becomes already-applied.
    const drift = runFileEdit({
      command: "paint-tile",
      file,
      args: { map: "map", layer: "ground", x: 0, y: 0, tile: "s.3" },
    });
    expect(drift).toMatchObject({ ok: true, written: true });
    const before = readFileSync(file, "utf8");
    const again = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-redo" } });
    expect(again).toMatchObject({ ok: true, result: { projectChanged: false, appliedHunks: [] } });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(runProposalFileCommand({ command: "list-archive", file })).toMatchObject({
      result: [{ id: "p-redo", status: "accepted" }],
    });
  });
});

describe("structural changes in proposals", () => {
  test("add-map, connect-maps and a new event form one acceptable proposal", () => {
    const file = newFile("structural");
    const request = {
      id: "p-east",
      title: "East meadow",
      rationale: "New map with a sheep, connected both ways",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "new-map",
        summary: "Add the east map, wire both transfers, place the sheep",
        operations: [
          { command: "add-map", args: { map: "east", name: "East", width: 4, height: 3, sheets: ["s"], fill: "s.0" } },
          { command: "connect-maps", args: { map: "map", x: 0, y: 0, targetMap: "east", targetX: 0, targetY: 0, eventId: "east-exit" } },
          { command: "connect-maps", args: { map: "east", x: 0, y: 0, targetMap: "map", targetX: 0, targetY: 0, eventId: "west-exit" } },
          { command: "add-event", args: { map: "east", event: { id: "sheep", x: 2, y: 1, pages: [{ trigger: "action", sprite: "sheep", moveType: "random", commands: [{ op: "text", lines: ["Baa"] }] }] } } },
        ],
      }],
    };
    const created = propose(file, request);
    expect(created).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    const accepted = runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-east" } });
    expect(accepted).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });

    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(project.maps.map((m) => m.id)).toEqual(["map", "east"]);
    const east = project.maps[1]!;
    expect(east.events?.map((e) => e.id)).toEqual(["west-exit", "sheep"]);
    expect(east.events?.[0]?.pages[0]?.commands[0]).toMatchObject({ op: "transfer", map: "map", x: 0, y: 0 });
    const map = project.maps[0]!;
    expect(map.events?.some((e) => e.id === "east-exit")).toBe(true);
    // The new map is reachable: no lint/map-unreachable in the archived QA.
    const qa = ((accepted as { result: { qa: { findings: { code: string }[] } } }).result).qa;
    expect(qa.findings.some((f) => f.code === "lint/map-unreachable")).toBe(false);
  });

  test("connect-maps fails at creation on an unknown target map", () => {
    const file = newFile("structural");
    const request = {
      id: "p-bad-connect",
      title: "Bad connection",
      rationale: "Targets a missing map",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "connect",
        summary: "Connect to nowhere",
        operations: [
          { command: "connect-maps", args: { map: "map", x: 0, y: 0, targetMap: "nowhere", targetX: 0, targetY: 0 } },
        ],
      }],
    };
    expect(propose(file, request)).toMatchObject({ ok: false, error: { code: "MAP_NOT_FOUND" } });
  });

  test("duplicate-map copies a map through a proposal", () => {
    const file = newFile("structural");
    const request = {
      id: "p-dup",
      title: "Duplicate",
      rationale: "Copy the map",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "dup",
        summary: "Duplicate the map",
        operations: [{ command: "duplicate-map", args: { map: "map" } }],
      }],
    };
    expect(propose(file, request)).toMatchObject({ ok: true });
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "p-dup" } })).toMatchObject({ ok: true });
    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(project.maps.map((m) => m.id)).toEqual(["map", "map-copy"]);
  });
});
