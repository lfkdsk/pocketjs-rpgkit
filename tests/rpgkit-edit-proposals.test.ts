import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Project } from "../src/engine/types.ts";
import { sha256Text } from "../src/engine/map-repository.ts";
import { serializeProject } from "../editor/engine/document.ts";
import { commitProjectReplacement, createEditorState, undo } from "../editor/engine/model.ts";
import {
  applyEditPatch,
  createEditPatch,
  semanticHash,
} from "../editor/api/operations.ts";
import {
  createProposalFromOperations,
  loadPendingProposals,
  persistReviewedProposal,
  proposalArchiveDirectoryFor,
  proposalDirectoryFor,
  runProposalFileCommand,
} from "../editor/api/proposals.ts";
import {
  applyProposalHunks,
  assessProposal,
  decideProposalHunks,
  parseProposal,
  previewProposalHunks,
  proposalErrors,
  proposalSemanticHash,
} from "../editor/proposals/model.ts";
import { syncEditorProposalBridge } from "../tools/lib/editor-proposal-bridge.ts";
import {
  EDITOR_SAVE_CAPABILITY_PATH,
  EDITOR_SAVE_PROTOCOL,
  EDITOR_SAVE_REQUEST_PATH,
  EDITOR_SAVE_RESULT_PATH,
  PROPOSAL_HOST_STATE_PATH,
} from "../editor/proposals/types.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Proposal fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 2 }],
    items: [],
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

const REQUEST = {
  id: "proposal-1",
  title: "Improve the village",
  rationale: "Make the entrance clearer and move the guide.",
  author: "test-agent",
  createdAt: "2026-09-30T12:00:00.000Z",
  hunks: [
    {
      id: "entrance-tiles",
      summary: "Paint two entrance tiles",
      operations: [{
        command: "paint-rect",
        args: { map: "map", layer: "ground", x: 0, y: 0, width: 2, height: 1, tile: "s.3" },
      }],
    },
    {
      id: "move-guide",
      summary: "Move the guide",
      operations: [{
        command: "update-event",
        args: { map: "map", event: "npc", changes: { x: 2, y: 2 } },
      }],
    },
  ],
};

describe("AI edit proposal model", () => {
  test("dry-runs grouped operations into independent validated hunks", () => {
    const project = fixture();
    const source = serializeProject(project);
    const proposal = createProposalFromOperations(source, REQUEST);
    expect(proposal).toMatchObject({
      id: "proposal-1",
      baseHash: semanticHash(project),
      hunks: [
        { id: "entrance-tiles", changes: [{ path: "/maps/0/ground/0" }, { path: "/maps/0/ground/1" }] },
        { id: "move-guide", changes: [{ path: "/maps/0/events/0/x" }, { path: "/maps/0/events/0/y" }] },
      ],
    });
    expect(serializeProject(project)).toBe(source);

    const after = applyProposalHunks(project, proposal, proposal.hunks.map((hunk) => hunk.id));
    expect(after.maps[0]!.ground.slice(0, 2)).toEqual(["s.3", "s.3"]);
    expect(after.maps[0]!.events![0]).toMatchObject({ x: 2, y: 2 });
    const normalPatch = {
      ...createEditPatch(project, after),
      changes: proposal.hunks.flatMap((hunk) => hunk.changes),
    };
    expect(applyEditPatch(project, normalPatch)).toEqual(after);
  });

  test("rejects invalid operations, empty hunks and overlapping hunk paths", () => {
    expect(() => createProposalFromOperations(serializeProject(fixture()), {
      ...REQUEST,
      hunks: [{ id: "bad", summary: "Bad", operations: [{ command: "paint-tile", args: { map: "map", x: 0, y: 0, tile: "missing.0" } }] }],
    })).toThrow("operation 1 failed");
    expect(() => createProposalFromOperations(serializeProject(fixture()), {
      ...REQUEST,
      hunks: [{ id: "empty", summary: "Empty", operations: [{ command: "paint-tile", args: { map: "map", x: 0, y: 0, tile: "s.0" } }] }],
    })).toThrow("makes no semantic change");
    expect(() => createProposalFromOperations(serializeProject(fixture()), {
      ...REQUEST,
      hunks: [
        { id: "one", summary: "One", operations: [{ command: "paint-tile", args: { map: "map", x: 0, y: 0, tile: "s.1" } }] },
        { id: "two", summary: "Two", operations: [{ command: "paint-tile", args: { map: "map", x: 0, y: 0, tile: "s.2" } }] },
      ],
    })).toThrow("overlaps");
    expect(() => parseProposal({ ...createProposalFromOperations(serializeProject(fixture()), REQUEST), surprise: true }))
      .toThrow("additional property");
    const noncanonical = createProposalFromOperations(serializeProject(fixture()), REQUEST);
    noncanonical.hunks[0]!.changes[0]!.path = "/maps/00/ground/0";
    expect(() => parseProposal(noncanonical)).toThrow("canonical decimal form");
  });

  test("allows unrelated drift while detecting the same tile and same event", () => {
    const project = fixture();
    const proposal = createProposalFromOperations(serializeProject(project), REQUEST);
    const unrelated = structuredClone(project);
    unrelated.title = "Human title edit";
    const safe = assessProposal(unrelated, proposal);
    expect(safe.baseMatches).toBe(false);
    expect(safe.hasConflicts).toBe(false);
    expect(safe.hunks.map((hunk) => hunk.state)).toEqual(["clean", "clean"]);
    expect(applyProposalHunks(unrelated, proposal, ["entrance-tiles"]).title).toBe("Human title edit");

    const tileConflict = structuredClone(project);
    tileConflict.maps[0]!.ground[0] = "s.2";
    expect(assessProposal(tileConflict, proposal).hunks.map((hunk) => hunk.state))
      .toEqual(["conflict", "clean"]);
    expect(() => applyProposalHunks(tileConflict, proposal, ["entrance-tiles"]))
      .toThrow("cannot be applied");

    const eventConflict = structuredClone(project);
    eventConflict.maps[0]!.events![0]!.x = 3;
    expect(assessProposal(eventConflict, proposal).hunks.map((hunk) => hunk.state))
      .toEqual(["clean", "conflict"]);
  });

  test("derives tile and moved-event ghosts without mutating the document", () => {
    const project = fixture();
    const before = structuredClone(project);
    const proposal = createProposalFromOperations(serializeProject(project), REQUEST);
    const preview = previewProposalHunks(project, proposal, ["entrance-tiles", "move-guide"]);
    expect(preview.tiles).toEqual([
      { mapId: "map", layer: "ground", x: 0, y: 0, tile: "s.3" },
      { mapId: "map", layer: "ground", x: 1, y: 0, tile: "s.3" },
    ]);
    expect(preview.events).toEqual([{
      mapId: "map", kind: "moved", id: "npc", x: 2, y: 2, w: 1, h: 1, fromX: 1, fromY: 1,
    }]);
    expect(project).toEqual(before);
  });

  test("derives resize and rename ghosts in stable live-map coordinates", () => {
    const project = fixture();
    project.maps[0]!.ground[11] = "s.2";
    const expanded = createProposalFromOperations(serializeProject(project), {
      ...REQUEST,
      id: "resize-wide",
      hunks: [{
        id: "resize",
        summary: "Expand without moving existing tiles",
        operations: [{ command: "update-map", args: { map: "map", changes: { width: 5 } } }],
      }],
    });
    const expandedPreview = previewProposalHunks(project, expanded, ["resize"]);
    expect(expandedPreview.tiles).toEqual([]);
    expect(expandedPreview.maps).toEqual([{ mapId: "map", width: 5, height: 3 }]);

    const expandedAndPainted = createProposalFromOperations(serializeProject(project), {
      ...REQUEST,
      id: "resize-paint",
      hunks: [{
        id: "resize",
        summary: "Expand and paint the new column",
        operations: [
          { command: "update-map", args: { map: "map", changes: { width: 5 } } },
          { command: "paint-tile", args: { map: "map", layer: "ground", x: 4, y: 0, tile: "s.3" } },
        ],
      }],
    });
    expect(previewProposalHunks(project, expandedAndPainted, ["resize"])).toMatchObject({
      maps: [{ mapId: "map", width: 5, height: 3 }],
      tiles: [{ mapId: "map", layer: "ground", x: 4, y: 0, tile: "s.3" }],
    });

    const cropped = createProposalFromOperations(serializeProject(project), {
      ...REQUEST,
      id: "resize-narrow",
      hunks: [{
        id: "resize",
        summary: "Crop the authored edge",
        operations: [{ command: "update-map", args: { map: "map", changes: { width: 3 } } }],
      }],
    });
    expect(previewProposalHunks(project, cropped, ["resize"]).tiles).toEqual([
      { mapId: "map", layer: "ground", x: 3, y: 0, tile: null },
      { mapId: "map", layer: "ground", x: 3, y: 1, tile: null },
      { mapId: "map", layer: "ground", x: 3, y: 2, tile: null },
    ]);

    const renamed = createProposalFromOperations(serializeProject(project), {
      ...REQUEST,
      id: "rename-paint",
      hunks: [{
        id: "rename",
        summary: "Rename and repaint",
        operations: [
          { command: "update-map", args: { map: "map", changes: { id: "new-map" } } },
          { command: "paint-tile", args: { map: "new-map", layer: "ground", x: 2, y: 1, tile: "s.3" } },
        ],
      }],
    });
    expect(previewProposalHunks(project, renamed, ["rename"]).tiles).toEqual([
      { mapId: "map", layer: "ground", x: 2, y: 1, tile: "s.3" },
    ]);
  });

  test("records independent hunk decisions", () => {
    const proposal = createProposalFromOperations(serializeProject(fixture()), REQUEST);
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:01:00.000Z");
    const partial = decideProposalHunks(accepted, ["move-guide"], "rejected", "2026-09-30T12:02:00.000Z");
    expect(partial.hunks.map((hunk) => hunk.decision?.status)).toEqual(["accepted", "rejected"]);
  });

  test("commits an accepted selection as one editor undo step", () => {
    const project = fixture();
    const proposal = createProposalFromOperations(serializeProject(project), REQUEST);
    const candidate = applyProposalHunks(project, proposal, ["entrance-tiles", "move-guide"]);
    const before = createEditorState(project);
    const accepted = commitProjectReplacement(before, candidate);
    expect(accepted.past).toHaveLength(1);
    expect(accepted.project.maps[0]!.ground[0]).toBe("s.3");
    expect(accepted.project.maps[0]!.events![0]!.x).toBe(2);
    const restored = undo(accepted);
    expect(restored.project).toEqual(project);
    expect(restored.past).toHaveLength(0);
  });
});

const TEMP = join(import.meta.dir, `.proposal-tmp-${process.pid}`);
const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "tools/rpgkit-edit/cli.ts");
beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

describe("proposal sidecar storage", () => {
  test("creates, lists, shows, archives and withdraws one JSON file per proposal", () => {
    const file = join(TEMP, "game.json");
    const source = serializeProject(fixture());
    writeFileSync(file, source);
    const created = runProposalFileCommand({ command: "propose", file, args: REQUEST });
    expect(created).toMatchObject({ ok: true, written: true, result: { proposal: { id: "proposal-1" } } });
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(loadPendingProposals(file)).toHaveLength(1);

    const listed = runProposalFileCommand({ command: "list-proposals", file });
    expect(listed).toMatchObject({ ok: true, written: false, result: [{ id: "proposal-1", hunkCount: 2, pendingHunks: 2 }] });
    const shown = runProposalFileCommand({ command: "show-proposal", file, args: { id: "proposal-1" } });
    expect(shown).toMatchObject({ ok: true, result: { archived: false, proposal: { author: "test-agent" } } });

    const decided = decideProposalHunks(loadPendingProposals(file)[0]!, ["entrance-tiles", "move-guide"], "rejected", "2026-09-30T12:03:00.000Z");
    const archivedPath = persistReviewedProposal(file, decided);
    expect(archivedPath).toStartWith(proposalArchiveDirectoryFor(file));
    expect(loadPendingProposals(file)).toEqual([]);
    expect(runProposalFileCommand({ command: "show-proposal", file, args: { id: "proposal-1" } }))
      .toMatchObject({ ok: true, result: { archived: true } });

    const second = { ...REQUEST, id: "proposal-2" };
    expect(runProposalFileCommand({ command: "propose", file, args: second })).toMatchObject({ ok: true });
    expect(runProposalFileCommand({ command: "withdraw-proposal", file, args: { id: "proposal-2" } }))
      .toMatchObject({ ok: true, written: true, result: { withdrawn: true } });
    expect(proposalDirectoryFor(file)).toEndWith("game.json.proposals");
  });

  test("QA storage cannot overwrite a proposal whose id ends in .qa", () => {
    const file = join(TEMP, "qa-id-collision.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "pair.qa" } }))
      .toMatchObject({ ok: true });
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "pair" } }))
      .toMatchObject({ ok: true });

    const pending = loadPendingProposals(file);
    expect(pending.map((proposal) => proposal.id).sort()).toEqual(["pair", "pair.qa"]);
    expect(readFileSync(join(proposalDirectoryFor(file), "qa", "pair.json"), "utf8"))
      .toContain('"documentHash"');
  });

  test("accept allows unchanged baseline QA errors but still reports them", () => {
    const file = join(TEMP, "baseline-qa-errors.json");
    const project = fixture();
    project.maps[0]!.events!.push({
      id: "old-ghost",
      x: 3,
      y: 2,
      pages: [{
        trigger: "action",
        sprite: "unregistered-old-sprite",
        commands: [{ op: "text", lines: ["This defect predates the proposal"] }],
      }],
    });
    writeFileSync(file, serializeProject(project));
    const created = runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "baseline-errors" } });
    expect(created).toMatchObject({
      ok: true,
      result: { qa: { errors: 1, baseline: { errors: [{ code: "lint/sprite-missing" }] } } },
    });

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "baseline-errors" } }))
      .toMatchObject({ ok: true, result: { projectChanged: true, qa: { errors: 1 } } });
    expect((JSON.parse(readFileSync(file, "utf8")) as Project).maps[0]!.ground.slice(0, 2))
      .toEqual(["s.3", "s.3"]);
  });

  test("a same-message error at a new event is not covered by the baseline", () => {
    const file = join(TEMP, "baseline-error-location.json");
    const project = fixture();
    project.maps[0]!.events!.push({
      id: "old-ghost",
      x: 3,
      y: 2,
      pages: [{ trigger: "action", sprite: "same-missing-sprite", commands: [] }],
    });
    writeFileSync(file, serializeProject(project));
    const request = {
      ...REQUEST,
      id: "new-location-error",
      hunks: [{
        id: "new-ghost",
        summary: "Add a second broken reference",
        operations: [{
          command: "add-event",
          args: { map: "map", event: {
            id: "new-ghost",
            x: 0,
            y: 0,
            pages: [{ trigger: "action", sprite: "same-missing-sprite", commands: [] }],
          } },
        }],
      }],
    };
    expect(runProposalFileCommand({ command: "propose", file, args: request }))
      .toMatchObject({ ok: true, result: { qa: { errors: 2 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "new-location-error" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED", actual: 1 } });
  });

  test("an old or malformed QA sidecar cannot whitelist existing errors", () => {
    const file = join(TEMP, "legacy-qa-baseline.json");
    const project = fixture();
    project.maps[0]!.events!.push({
      id: "old-ghost",
      x: 3,
      y: 2,
      pages: [{ trigger: "action", sprite: "unregistered-old-sprite", commands: [] }],
    });
    writeFileSync(file, serializeProject(project));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "legacy-baseline" } }))
      .toMatchObject({ ok: true, result: { qa: { errors: 1 } } });
    const qaPath = join(proposalDirectoryFor(file), "qa", "legacy-baseline.json");
    const qa = JSON.parse(readFileSync(qaPath, "utf8")) as Record<string, unknown>;
    delete qa.baseline;
    writeFileSync(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
    const before = readFileSync(file, "utf8");

    expect(runProposalFileCommand({ command: "accept-proposal", file, args: { id: "legacy-baseline" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED", actual: 1 } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("review persistence rejects rewrites, preserves omissions, and refuses decision reversal", () => {
    const file = join(TEMP, "review-guard.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "guarded" } }).ok).toBe(true);
    const original = loadPendingProposals(file)[0]!;
    expect(() => persistReviewedProposal(file, { ...original, title: "Rewritten" }))
      .toThrow("may not change proposal metadata");
    const partial = decideProposalHunks(original, ["entrance-tiles"], "accepted", "2026-09-30T12:04:00.000Z");
    persistReviewedProposal(file, partial);
    const reversed = structuredClone(partial);
    delete reversed.hunks[0]!.decision;
    persistReviewedProposal(file, reversed);
    expect(loadPendingProposals(file)[0]!.hunks[0]!.decision?.status).toBe("accepted");
    const conflicting = decideProposalHunks(original, ["entrance-tiles"], "rejected", "2026-09-30T12:04:01.000Z");
    expect(() => persistReviewedProposal(file, conflicting)).toThrow("may not change the existing decision");
  });

  test("desktop bridge applies accepted hunks to the latest project and archives completion", () => {
    const file = join(TEMP, "bridged.json");
    const sessionFile = join(TEMP, "guest-data", "proposal-session.json");
    const project = fixture();
    writeFileSync(file, serializeProject(project));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "bridged" } }).ok).toBe(true);

    const seeded = syncEditorProposalBridge(file, sessionFile);
    expect(seeded).toMatchObject({ pending: 1, persisted: 0, wroteSession: true, waitingForProject: false });
    expect(JSON.parse(readFileSync(join(TEMP, "guest-data", EDITOR_SAVE_CAPABILITY_PATH), "utf8")))
      .toEqual({ protocol: EDITOR_SAVE_PROTOCOL });
    expect(JSON.parse(readFileSync(join(TEMP, "guest-data", PROPOSAL_HOST_STATE_PATH), "utf8")))
      .toEqual({ projectHash: semanticHash(project) });
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:05:00.000Z");
    const external = structuredClone(project);
    external.title = "External title retained";
    writeFileSync(file, serializeProject(external));
    writeFileSync(sessionFile, `${JSON.stringify({
      projectHash: "0".repeat(64),
      proposals: [accepted],
    }, null, 2)}\n`);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({
      pending: 1,
      persisted: 1,
      archived: 0,
      waitingForProject: false,
      conflicts: [],
    });
    const applied = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(applied.title).toBe("External title retained");
    expect(applied.maps[0]!.ground.slice(0, 2)).toEqual(["s.3", "s.3"]);
    expect(JSON.parse(readFileSync(join(TEMP, "guest-data", PROPOSAL_HOST_STATE_PATH), "utf8")))
      .toEqual({ projectHash: semanticHash(applied) });
    const partial = loadPendingProposals(file)[0]!;
    expect(partial.hunks[0]!.decision?.status).toBe("accepted");

    const complete = decideProposalHunks(partial, ["move-guide"], "rejected", "2026-09-30T12:06:00.000Z");
    writeFileSync(sessionFile, `${JSON.stringify({
      projectHash: "f".repeat(64),
      proposals: [complete],
    }, null, 2)}\n`);
    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({
      pending: 0, persisted: 1, archived: 1, waitingForProject: false, conflicts: [],
    });
    expect(loadPendingProposals(file)).toEqual([]);
    expect(JSON.parse(readFileSync(sessionFile, "utf8"))).toMatchObject({ proposals: [] });
  });

  test("desktop bridge publishes its managed-save marker before reading a bad session", () => {
    const file = join(TEMP, "bad-bridge-session.json");
    const dataDir = join(TEMP, "bad-bridge-session-data");
    const sessionFile = join(dataDir, "proposal-session.json");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, serializeProject(fixture()));
    writeFileSync(sessionFile, "not json\n");

    expect(() => syncEditorProposalBridge(file, sessionFile)).toThrow();
    expect(JSON.parse(readFileSync(join(dataDir, EDITOR_SAVE_CAPABILITY_PATH), "utf8")))
      .toEqual({ protocol: EDITOR_SAVE_PROTOCOL });
  });

  test("bridge applies a mixed review for proposal id project without lock aliasing", () => {
    const file = join(TEMP, "project-id.json");
    const sessionFile = join(TEMP, "project-id-data", "proposal-session.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "project" } }).ok).toBe(true);
    syncEditorProposalBridge(file, sessionFile);
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:05:30.000Z");
    const mixed = decideProposalHunks(accepted, ["move-guide"], "rejected", "2026-09-30T12:05:31.000Z");
    writeFileSync(sessionFile, `${JSON.stringify({ projectHash: proposal.baseHash, proposals: [mixed] }, null, 2)}\n`);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({
      pending: 0, persisted: 1, archived: 1, conflicts: [],
    });
    const project = JSON.parse(readFileSync(file, "utf8")) as Project;
    expect(project.maps[0]!.ground.slice(0, 2)).toEqual(["s.3", "s.3"]);
    expect(project.maps[0]!.events![0]).toMatchObject({ x: 1, y: 1 });
    expect(runProposalFileCommand({ command: "show-proposal", file, args: { id: "project" } }))
      .toMatchObject({ ok: true, result: { archived: true, proposal: { hunks: [
        { decision: { status: "accepted" } },
        { decision: { status: "rejected" } },
      ] } } });
  });

  test("desktop bridge rejects a same-target acceptance without changing the project", () => {
    const file = join(TEMP, "bridge-conflict.json");
    const sessionFile = join(TEMP, "conflict-data", "proposal-session.json");
    const project = fixture();
    writeFileSync(file, serializeProject(project));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "conflicted" } }).ok).toBe(true);
    syncEditorProposalBridge(file, sessionFile);
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:05:00.000Z");
    const mixed = decideProposalHunks(accepted, ["move-guide"], "rejected", "2026-09-30T12:05:01.000Z");
    const external = structuredClone(project);
    external.maps[0]!.ground[0] = "s.1";
    writeFileSync(file, serializeProject(external));
    writeFileSync(sessionFile, `${JSON.stringify({ projectHash: proposal.baseHash, proposals: [mixed] }, null, 2)}\n`);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({ persisted: 1, conflicts: [expect.stringContaining("conflict")] });
    expect((JSON.parse(readFileSync(file, "utf8")) as Project).maps[0]!.ground[0]).toBe("s.1");
    expect(loadPendingProposals(file)[0]!.hunks[0]!.decision).toBeUndefined();
    expect(loadPendingProposals(file)[0]!.hunks[1]!.decision?.status).toBe("rejected");
    expect(JSON.parse(readFileSync(sessionFile, "utf8")).proposals[0].hunks[0].decision).toBeUndefined();
    expect(JSON.parse(readFileSync(sessionFile, "utf8")).proposals[0].hunks[1].decision.status).toBe("rejected");
  });

  test("desktop bridge reruns QA and refuses a newly broken live project", () => {
    const file = join(TEMP, "bridge-qa-drift.json");
    const sessionFile = join(TEMP, "bridge-qa-drift-data", "proposal-session.json");
    const project = fixture();
    writeFileSync(file, serializeProject(project));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "qa-drift" } }).ok).toBe(true);
    syncEditorProposalBridge(file, sessionFile);
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:05:00.000Z");

    const drifted = structuredClone(project);
    drifted.maps[0]!.events!.push({
      id: "ghost",
      x: 3,
      y: 2,
      pages: [{ trigger: "action", sprite: "missing-ghost", commands: [{ op: "text", lines: ["Boo"] }] }],
    });
    const driftedText = serializeProject(drifted);
    writeFileSync(file, driftedText);
    writeFileSync(sessionFile, `${JSON.stringify({ projectHash: proposal.baseHash, proposals: [accepted] }, null, 2)}\n`);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({
      persisted: 0,
      archived: 0,
      conflicts: [expect.stringContaining("QA")],
    });
    expect(readFileSync(file, "utf8")).toBe(driftedText);
    expect(loadPendingProposals(file)[0]!.hunks[0]!.decision).toBeUndefined();
  });

  test("desktop bridge finishes an accepted decision after a post-write crash", () => {
    const file = join(TEMP, "bridge-recovery.json");
    const sessionFile = join(TEMP, "recovery-data", "proposal-session.json");
    const project = fixture();
    writeFileSync(file, serializeProject(project));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "bridge-recovery" } }).ok).toBe(true);
    syncEditorProposalBridge(file, sessionFile);
    const proposal = loadPendingProposals(file)[0]!;
    const accepted = decideProposalHunks(proposal, ["entrance-tiles"], "accepted", "2026-09-30T12:06:30.000Z");
    // Simulate a process dying after the project rename but before it could
    // persist the sidecar decision.
    writeFileSync(file, serializeProject(applyProposalHunks(project, proposal, ["entrance-tiles"])));
    writeFileSync(sessionFile, `${JSON.stringify({ projectHash: proposal.baseHash, proposals: [accepted] }, null, 2)}\n`);
    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({ persisted: 1, conflicts: [] });
    expect(loadPendingProposals(file)[0]!.hunks[0]!.decision?.status).toBe("accepted");
  });

  test("desktop save bridge commits only the exact source revision under review", () => {
    const file = join(TEMP, "editor-save.json");
    const dataDir = join(TEMP, "editor-save-data");
    const sessionFile = join(dataDir, "proposal-session.json");
    const requestFile = join(dataDir, EDITOR_SAVE_REQUEST_PATH);
    const resultFile = join(dataDir, EDITOR_SAVE_RESULT_PATH);
    const source = serializeProject(fixture());
    const edited = { ...fixture(), title: "Saved by editor" };
    const output = serializeProject(edited);
    writeFileSync(file, source);
    syncEditorProposalBridge(file, sessionFile);
    writeFileSync(requestFile, `${JSON.stringify({
      id: "a".repeat(64),
      expectedSourceHash: sha256Text(source),
      projectHash: semanticHash(edited),
      text: output,
    })}\n`);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({ saveStatus: "saved" });
    expect(readFileSync(file, "utf8")).toBe(output);
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({
      id: "a".repeat(64), status: "saved", projectHash: semanticHash(edited),
    });
  });

  test("desktop save bridge refuses a stale request after another writer changes the project", () => {
    const file = join(TEMP, "editor-save-conflict.json");
    const dataDir = join(TEMP, "editor-save-conflict-data");
    const sessionFile = join(dataDir, "proposal-session.json");
    const requestFile = join(dataDir, EDITOR_SAVE_REQUEST_PATH);
    const resultFile = join(dataDir, EDITOR_SAVE_RESULT_PATH);
    const source = serializeProject(fixture());
    const staleEdit = { ...fixture(), title: "Stale editor text" };
    const external = structuredClone(fixture());
    external.maps[0]!.name = "Changed by another writer";
    writeFileSync(file, source);
    syncEditorProposalBridge(file, sessionFile);
    writeFileSync(requestFile, `${JSON.stringify({
      id: "b".repeat(64),
      expectedSourceHash: sha256Text(source),
      projectHash: semanticHash(staleEdit),
      text: serializeProject(staleEdit),
    })}\n`);
    writeFileSync(file, serializeProject(external));

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({ saveStatus: "conflict" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(external);
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({
      id: "b".repeat(64), status: "conflict", projectHash: semanticHash(external),
    });
    expect(JSON.parse(readFileSync(join(dataDir, PROPOSAL_HOST_STATE_PATH), "utf8")))
      .toEqual({ projectHash: semanticHash(external) });
  });

  test("desktop save bridge acknowledges a retry after the project rename", () => {
    const file = join(TEMP, "editor-save-recovery.json");
    const dataDir = join(TEMP, "editor-save-recovery-data");
    const sessionFile = join(dataDir, "proposal-session.json");
    const requestFile = join(dataDir, EDITOR_SAVE_REQUEST_PATH);
    const source = serializeProject(fixture());
    const edited = { ...fixture(), title: "Recovered editor save" };
    const output = serializeProject(edited);
    writeFileSync(file, source);
    syncEditorProposalBridge(file, sessionFile);
    writeFileSync(requestFile, `${JSON.stringify({
      id: "c".repeat(64),
      expectedSourceHash: sha256Text(source),
      projectHash: semanticHash(edited),
      text: output,
    })}\n`);
    // Simulate a crash after replacing the project but before acknowledging it.
    writeFileSync(file, output);

    expect(syncEditorProposalBridge(file, sessionFile)).toMatchObject({ saveStatus: "saved" });
    expect(readFileSync(file, "utf8")).toBe(output);
    expect(JSON.parse(readFileSync(join(dataDir, EDITOR_SAVE_RESULT_PATH), "utf8")))
      .toMatchObject({ id: "c".repeat(64), status: "saved", projectHash: semanticHash(edited) });
  });

  test("stale concurrent reviews merge different hunks and never reverse a winner", () => {
    const file = join(TEMP, "concurrent-review.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "concurrent" } }).ok).toBe(true);
    const original = loadPendingProposals(file)[0]!;
    const first = decideProposalHunks(original, ["entrance-tiles"], "accepted", "2026-09-30T12:07:00.000Z");
    const staleSecond = decideProposalHunks(original, ["move-guide"], "rejected", "2026-09-30T12:07:01.000Z");
    persistReviewedProposal(file, first);
    persistReviewedProposal(file, staleSecond);
    const archived = runProposalFileCommand({ command: "show-proposal", file, args: { id: "concurrent" } });
    expect(archived).toMatchObject({
      ok: true,
      result: { archived: true, proposal: { hunks: [
        { decision: { status: "accepted" } },
        { decision: { status: "rejected" } },
      ] } },
    });
    const staleConflict = decideProposalHunks(original, ["entrance-tiles"], "rejected", "2026-09-30T12:07:02.000Z");
    expect(() => persistReviewedProposal(file, staleConflict)).toThrow("does not exist");
  });

  test("repairs a completed pending file after an interrupted archive transition", () => {
    const file = join(TEMP, "archive-recovery.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "recover" } }).ok).toBe(true);
    const complete = decideProposalHunks(
      loadPendingProposals(file)[0]!,
      ["entrance-tiles", "move-guide"],
      "rejected",
      "2026-09-30T12:08:00.000Z",
    );
    writeFileSync(join(proposalDirectoryFor(file), "recover.json"), `${JSON.stringify(complete, null, 2)}\n`);
    expect(loadPendingProposals(file)).toEqual([]);
    expect(runProposalFileCommand({ command: "show-proposal", file, args: { id: "recover" } }))
      .toMatchObject({ ok: true, result: { archived: true } });
  });

  test("a live storage lock refuses a concurrent review writer", () => {
    const file = join(TEMP, "locked-review.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "locked" } }).ok).toBe(true);
    const proposal = decideProposalHunks(loadPendingProposals(file)[0]!, ["entrance-tiles"], "rejected");
    const lock = join(proposalDirectoryFor(file), ".lock-locked");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    expect(() => persistReviewedProposal(file, proposal)).toThrow("storage is busy");
    rmSync(lock);
    expect(loadPendingProposals(file)[0]!.hunks[0]!.decision).toBeUndefined();
  });

  test("two stale-lock reclaimers never enter the critical section together", async () => {
    const lock = join(TEMP, "reclaim-race.lock");
    const critical = join(TEMP, "reclaim-race.critical");
    const dead = Bun.spawn({ cmd: [process.execPath, "-e", "process.exit(0)"] });
    await dead.exited;
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: dead.pid,
      token: "stale-owner",
      createdAt: "2026-09-30T00:00:00.000Z",
    }));
    const lockModule = pathToFileURL(join(ROOT, "editor/api/lock.ts")).href;
    const worker = `
      import { rmSync, writeFileSync } from "node:fs";
      import { withFileLock } from ${JSON.stringify(lockModule)};
      let ownsCritical = false;
      try {
        withFileLock(${JSON.stringify(lock)}, () => {
          try {
            writeFileSync(${JSON.stringify(critical)}, String(process.pid), { flag: "wx" });
            ownsCritical = true;
            const until = Date.now() + 80;
            while (Date.now() < until) {}
          } finally {
            if (ownsCritical) rmSync(${JSON.stringify(critical)}, { force: true });
          }
        });
        process.exit(0);
      } catch (error) {
        process.exit(error && error.code === "FILE_LOCK_BUSY" ? 2 : 3);
      }
    `;
    const children = Array.from({ length: 8 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", worker],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }));
    const exitCodes = await Promise.all(children.map((child) => child.exited));
    expect(exitCodes).toContain(0);
    expect(exitCodes).not.toContain(3);
  });

  test("rejects a proposal file whose basename and payload id disagree", () => {
    const file = join(TEMP, "mismatched-id.json");
    writeFileSync(file, serializeProject(fixture()));
    expect(runProposalFileCommand({ command: "propose", file, args: { ...REQUEST, id: "payload-id" } }).ok).toBe(true);
    const directory = proposalDirectoryFor(file);
    const source = readFileSync(join(directory, "payload-id.json"), "utf8");
    writeFileSync(join(directory, "wrong-name.json"), source);
    expect(() => loadPendingProposals(file)).toThrow("file name does not match");
  });

  test("CLI proposal commands emit one JSON result and never edit the project", () => {
    const file = join(TEMP, "cli-game.json");
    const source = serializeProject(fixture());
    writeFileSync(file, source);
    const invoke = (command: string, args: unknown = {}, extra: string[] = []) => Bun.spawnSync({
      cmd: [process.execPath, CLI, command, "--file", file, "--json", JSON.stringify(args), ...extra],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const dry = invoke("propose", REQUEST, ["--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout.toString())).toMatchObject({ ok: true, dryRun: true, written: false });
    expect(loadPendingProposals(file)).toEqual([]);

    const created = invoke("propose", REQUEST);
    expect(created.exitCode).toBe(0);
    expect(created.stderr.toString()).toBe("");
    expect(created.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(created.stdout.toString())).toMatchObject({ ok: true, command: "propose", written: true });
    expect(JSON.parse(invoke("list-proposals").stdout.toString())).toMatchObject({ ok: true, result: [{ id: "proposal-1" }] });
    expect(JSON.parse(invoke("show-proposal", { id: "proposal-1" }).stdout.toString()))
      .toMatchObject({ ok: true, result: { proposal: { id: "proposal-1" } } });
    expect(JSON.parse(invoke("withdraw-proposal", { id: "proposal-1" }).stdout.toString()))
      .toMatchObject({ ok: true, result: { withdrawn: true } });
    expect(readFileSync(file, "utf8")).toBe(source);
  });
});

// The proposal example in docs/protocols.md must stay runnable: it is the
// contract frontends design against, so the test extracts both JSON blocks
// from that section and drives them through the real implementation.
describe("docs/protocols.md proposal example", () => {
  test("validates against the schema, matches its baseHash and applies", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "docs", "protocols.md"), "utf8");
    const start = docs.indexOf("## 4. Proposal protocol");
    const end = docs.indexOf("## 5.", start);
    const section = docs.slice(start, end);
    const fences = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(fences.length).toBe(2); // the proposal example and its minimal project
    const example = JSON.parse(fences[0]!);
    const project = JSON.parse(fences[1]!) as Project;

    expect(proposalErrors(example)).toEqual([]);
    const proposal = parseProposal(example);
    expect(proposal.baseHash).toBe(proposalSemanticHash(project));

    const assessment = assessProposal(project, example);
    expect(assessment.baseMatches).toBe(true);
    expect(assessment.hunks).toHaveLength(1);
    expect(assessment.hunks[0]!.state).toBe("clean");

    const applied = applyProposalHunks(project, example, [proposal.hunks[0]!.id]);
    expect(applied.title).toBe("Proposal Demo (edited)");
  });
});
