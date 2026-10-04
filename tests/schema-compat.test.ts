// Schema identity compatibility: shells and saves produced under an earlier,
// purely additive schema generation keep loading, and older generations are
// refused. The fixtures under tests/fixtures/schema-compat were written by
// the RPG Kit revision of each generation (see generate.ts there), not
// reconstructed by this runtime; each breaking change also keeps a
// counterexample recorded by the release before it (witness.ts).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAP_SCHEMA_COMPATIBLE_HASHES,
  MAP_SCHEMA_HASH,
  createJsonMapRepository,
  describeMapSchemaRefusal,
  isCompatibleMapSchemaHash,
  mapManifestHash,
  sha256Text,
  shellContentIdentity,
} from "../src/engine/map-repository.ts";
import { createSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import { SaveError, canonicalJson, createSnapshot, decodeEnvelopeText, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { BTN_BITS } from "../src/engine/camera.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { loadValidatedProjectShell } from "../editor/api/sharded.ts";
import { createShardedEditorWorkspace } from "../editor/engine/sharded-workspace.ts";
import { EditorFiles } from "../tools/editor-files.ts";
import type { MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import schema from "../src/data/schema.json";
import { WITNESS_CASES, runWitness, type WitnessCase, type WitnessOutcome } from "./fixtures/schema-compat/witness.ts";

const FIXTURES = join(import.meta.dir, "fixtures/schema-compat");
const CHANGELOG = join(import.meta.dir, "../src/data/CHANGELOG.md");
const REPO = join(import.meta.dir, "..");
const FORGED = "f".repeat(64);

const short = (hash: string) => hash.slice(0, 8);
const genDir = (hash: string) => join(FIXTURES, `gen-${short(hash)}`);
const readShell = (hash: string): ProjectShell =>
  JSON.parse(readFileSync(join(genDir(hash), "project.json"), "utf8")) as ProjectShell;
const readSave = (hash: string): string => readFileSync(join(genDir(hash), "save.json"), "utf8");
const readMapText = (entry: string): string | undefined => {
  const path = join(FIXTURES, entry);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

function open(shell: ProjectShell): Session {
  const maps = createJsonMapRepository(shell.mapIndex, { read: readMapText });
  return createSession(shell, 60, maps);
}

function inlineProject(shell: ProjectShell): Project {
  const { mapIndex, mapManifestHash: _m, mapSchemaHash: _s, ...globals } = shell;
  const maps = mapIndex.map((meta) => JSON.parse(readMapText(meta.entry)!) as MapDef);
  return { ...globals, maps } as Project;
}

function confirm(session: Session, state: SessionState, frames = 20): SessionState {
  let next = stepSession(session, state, { buttons: 0, confirmEdge: true });
  for (let i = 1; i < frames; i++) next = stepSession(session, next, { buttons: 0 });
  return next;
}

/** Rows of the "Schema identities" table: newest first. */
function changelogIdentities(): { hash: string; older: string }[] {
  const text = readFileSync(CHANGELOG, "utf8");
  const start = text.indexOf("## Schema identities");
  if (start < 0) throw new Error("CHANGELOG has no Schema identities section");
  const section = text.slice(start).split("\n## ")[0]!;
  const rows: { hash: string; older: string }[] = [];
  for (const line of section.split("\n")) {
    const match = /^\| `([0-9a-f]{64})` \|.*\| (additive|breaking|first) \|$/.exec(line.trim());
    if (match) rows.push({ hash: match[1]!, older: match[2]! });
  }
  return rows;
}

function fixtureHashes(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.startsWith("gen-"))
    .map((name) => (JSON.parse(readFileSync(join(FIXTURES, name, "project.json"), "utf8")) as ProjectShell).mapSchemaHash!);
}

/** Fixtures of generations the runtime must refuse, newest first. */
const REFUSED = changelogIdentities()
  .map((row) => row.hash)
  .filter((hash) => hash !== MAP_SCHEMA_HASH && !MAP_SCHEMA_COMPATIBLE_HASHES.includes(hash))
  .filter((hash) => existsSync(genDir(hash)));

interface Witness {
  case: WitnessCase;
  recordedBy: string;
  outcome: WitnessOutcome;
}

function readWitness(hash: string): Witness | undefined {
  const path = join(genDir(hash), "witness.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Witness : undefined;
}

describe("schema identity", () => {
  test("MAP_SCHEMA_HASH is the hash of canonical schema.json", () => {
    expect(MAP_SCHEMA_HASH).toBe(sha256Text(canonicalJson(schema)));
  });

  test("the compatible list is well formed and excludes the current identity", () => {
    expect(new Set(MAP_SCHEMA_COMPATIBLE_HASHES).size).toBe(MAP_SCHEMA_COMPATIBLE_HASHES.length);
    for (const hash of MAP_SCHEMA_COMPATIBLE_HASHES) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(MAP_SCHEMA_COMPATIBLE_HASHES).not.toContain(MAP_SCHEMA_HASH);
    expect(Object.isFrozen(MAP_SCHEMA_COMPATIBLE_HASHES)).toBe(true);
    expect(isCompatibleMapSchemaHash(MAP_SCHEMA_HASH)).toBe(true);
    expect(isCompatibleMapSchemaHash(FORGED)).toBe(false);
    for (const hash of REFUSED) expect(isCompatibleMapSchemaHash(hash)).toBe(false);
    expect(REFUSED.length).toBeGreaterThan(0);
  });

  // Guard: a schema edit changes MAP_SCHEMA_HASH, which fails this test until
  // the CHANGELOG table gains a row for the new identity saying whether the
  // previous one stays loadable, and the compatible list follows that row.
  test("CHANGELOG schema identity table matches the runtime", () => {
    const rows = changelogIdentities();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.hash).toBe(MAP_SCHEMA_HASH);
    const expected: string[] = [];
    for (let i = 0; i + 1 < rows.length && rows[i]!.older === "additive"; i++) {
      expected.push(rows[i + 1]!.hash);
    }
    expect([...MAP_SCHEMA_COMPATIBLE_HASHES]).toEqual(expected);
  });

  test("every compatible generation has a real fixture", () => {
    const fixtures = fixtureHashes();
    for (const hash of MAP_SCHEMA_COMPATIBLE_HASHES) expect(fixtures).toContain(hash);
    for (const hash of fixtures) {
      expect(MAP_SCHEMA_COMPATIBLE_HASHES.includes(hash) || REFUSED.includes(hash)).toBe(true);
    }
  });

  // A breaking row is backed by a recorded counterexample: the generation
  // below it has a fixture and a witness the old release played differently.
  test("every breaking change keeps a refused fixture and a counterexample", () => {
    const rows = changelogIdentities();
    let breaking = 0;
    for (let i = 0; i + 1 < rows.length; i++) {
      if (rows[i]!.older !== "breaking") continue;
      breaking++;
      const older = rows[i + 1]!.hash;
      expect(REFUSED).toContain(older);
      expect(readWitness(older)?.case, `witness for ${short(older)}`).toBeDefined();
    }
    expect(breaking).toBeGreaterThan(0);
  });
});

describe("shells and saves from earlier schema generations", () => {
  for (const hash of MAP_SCHEMA_COMPATIBLE_HASHES) {
    test(`generation ${short(hash)}: old shell opens, old save restores and play continues`, () => {
      const shell = readShell(hash);
      expect(shell.mapSchemaHash).toBe(hash);
      expect(validateSchema(schema, shell)).toEqual([]);
      expect(validateSchema(schema, inlineProject(shell))).toEqual([]);
      const session = open(shell);
      expect(session.content?.schema).toBe(MAP_SCHEMA_HASH);
      expect(shellContentIdentity(shell)).toEqual(session.content!);

      const save = readSave(hash);
      expect(JSON.parse(save).content.schema).toBe(hash);
      let state = restoreSessionEnvelope(session, save);
      expect(state.mapId).toBe("yard");
      expect(state.interp.sw.variables.route).toBe(7);
      expect(state.interp.sw.gold).toBe(25);
      expect(state.interp.sw.items.key).toBe(2);
      expect(state.interp.sw.switches.met).toBe(true);
      expect(state.interp.sw.self["hall/guide"]).toBe("A");

      // Read the sign: it adds to the variable and transfers back to the hall.
      state = confirm(session, state);
      expect(state.mapId).toBe("hall");
      expect(state.interp.sw.variables.route).toBe(107);
      expect(state.move).toMatchObject({ tx: 2, ty: 3 });
      // Step up to the guide; its self switch now selects the second page.
      for (let i = 0; i < 30 && state.move.ty !== 2; i++) {
        state = stepSession(session, state, { buttons: BTN_BITS.UP });
      }
      for (let i = 0; i < 30 && state.move.moving; i++) state = stepSession(session, state, { buttons: 0 });
      expect(state.move).toMatchObject({ tx: 2, ty: 2, moving: false });
      state = confirm(session, state, 2);
      expect(state.interp.modal).toMatchObject({ kind: "text", lines: ["Already chosen."] });
      for (let i = 0; i < 4 && state.interp.modal !== null; i++) state = confirm(session, state);
      expect(state.interp.modal).toBeNull();

      // Saving again stamps the current identity, which this session accepts.
      const resaved = encodeEnvelope(createSnapshot(state.mapId, state.move, state.interp, 0), session.content);
      expect(JSON.parse(resaved).content.schema).toBe(MAP_SCHEMA_HASH);
      expect(restoreSessionEnvelope(session, resaved).mapId).toBe("hall");
    });
  }

  test("an old save also restores into a shell rebuilt by the current splitter", () => {
    const old = readShell(MAP_SCHEMA_COMPATIBLE_HASHES[0]!);
    const rebuilt = splitProjectMaps(inlineProject(old));
    expect(rebuilt.shell.mapSchemaHash).toBe(MAP_SCHEMA_HASH);
    expect(rebuilt.shell.mapManifestHash).toBe(old.mapManifestHash);
    const files = new Map(rebuilt.entries.map((entry) => [entry.path, entry.text]));
    const session = createSession(
      rebuilt.shell,
      60,
      createJsonMapRepository(rebuilt.shell.mapIndex, { read: (entry) => files.get(entry) }),
    );
    for (const hash of MAP_SCHEMA_COMPATIBLE_HASHES) {
      expect(restoreSessionEnvelope(session, readSave(hash)).interp.sw.variables.route).toBe(7);
    }
  });

  test("every generation before the latest breaking change is refused", () => {
    const current = open(readShell(MAP_SCHEMA_COMPATIBLE_HASHES[0]!));
    for (const hash of REFUSED) {
      const why = describeMapSchemaRefusal(hash);
      expect(() => open(readShell(hash))).toThrow(`map repository: shell schema hash mismatch: ${why}`);
      let error: unknown;
      try {
        restoreSessionEnvelope(current, readSave(hash));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("content");
      expect((error as SaveError).message).toContain(`save map schema hash does not match this runtime: ${why}`);
    }
  });

  test("the generation before the scene command is refused with a readable reason", () => {
    const hash = "47cf3d8ffdb35044fb6b099d98455368123db4710bc8516875a0bc06902c6d59";
    expect(REFUSED).toContain(hash);
    const accepted = [MAP_SCHEMA_HASH, ...MAP_SCHEMA_COMPATIBLE_HASHES].map((h) => `${h.slice(0, 8)}…`).join(", ");
    expect(MAP_SCHEMA_COMPATIBLE_HASHES).toEqual([
      "5f14109a6414a63f6a4eaaa25c586aca61218b3a8e53f4f3776853a9573e7349",
      "c0e962138a1f12dc5627590869b99f7c9b2ced3040e3d05ed0ebd663142d4857",
      "3315cbf7af3ceb5f6690824bf7fe0d0d7ac90f080fd741c7e24159a2b3e99ddb",
      "1b66bce2dff2f3f8476a9dcc3212ee826053447c5a7683c9942adbcfd122fc12",
      "3a57e757f9f5d4f3da13529cd376ceb8ef50a354a3a618e45a8fa41641b84562",
      "0e510772cbf540414553fd8f4204e0cecba80f4d8c844146e3be46d23841daae",
      "3ac9e23fa3289a6021dfe4e0141e732b303aefad37c2ba70538423701f00156e",
      "49d96a259da5a5bae6f15eb0c3e7184e8f874de1b0f13a8ba161586f4c0149a1",
      "bc4e72429a7ed9f491dcddf7a9b6bbd5ef8216d2521721ad1c078cabccf26906",
      "4a9a831002d95a662f16c83de31dea57998ae72b7c2183d5433eabd932f4c4a1",
      "ff6b923750b1078d15a8d2443251d14a5b5b17055b88445515a9b34e38056611",
      "ed562c6fa8e20c0d0d20a755e19b49581b49127328343c87231801a19f297de2",
      "c0588207c28d2ffcec9e2ac981f9859ca55576fb7dc53f221466c249d07bfa06",
      "0b9fff5b478b87e0dcae1f37044a444043c735339ca45245bdbbb9e2e36e7ab5",
    ]);
    expect(() => open(readShell(hash))).toThrow(
      `map repository: shell schema hash mismatch: schema 47cf3d8f… is not one this runtime reads (it reads ${accepted}); ` +
        "it comes from before a breaking format change or from a different RPG Kit build, " +
        "see Schema identities in the rpgkit-project CHANGELOG",
    );
    expect(accepted).toBe("1127febb…, 5f14109a…, c0e96213…, 3315cbf7…, 1b66bce2…, 3a57e757…, 0e510772…, 3ac9e23f…, 49d96a25…, bc4e7242…, 4a9a8310…, ff6b9237…, ed562c6f…, c0588207…, 0b9fff5b…");
    const current = open(readShell(MAP_SCHEMA_COMPATIBLE_HASHES[0]!));
    expect(() => restoreSessionEnvelope(current, readSave(hash))).toThrow(/schema 47cf3d8f… is not one this runtime reads/);
    expect(() => loadValidatedProjectShell(readFileSync(join(genDir(hash), "project.json"), "utf8")))
      .toThrow(/schema 47cf3d8f… is not one this runtime reads/);
  });

  test("a forged schema identity is refused for shells and saves", () => {
    const shell = { ...readShell(MAP_SCHEMA_COMPATIBLE_HASHES[0]!), mapSchemaHash: FORGED };
    expect(() => open(shell)).toThrow("map repository: shell schema hash mismatch");
    expect(shellContentIdentity(shell).schema).toBe(FORGED);

    const session = open(readShell(MAP_SCHEMA_COMPATIBLE_HASHES[0]!));
    const envelope = JSON.parse(readSave(MAP_SCHEMA_COMPATIBLE_HASHES[0]!));
    envelope.content.schema = FORGED;
    // The checksum covers the state only, so this is still a checksum-valid save.
    const forged = JSON.stringify(envelope);
    let error: unknown;
    try {
      decodeEnvelopeText(forged, session.content);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe("content");
    // Accepting a predecessor never relaxes the manifest binding.
    envelope.content.schema = MAP_SCHEMA_COMPATIBLE_HASHES[0];
    envelope.content.manifest = "0".repeat(64);
    expect(() => decodeEnvelopeText(JSON.stringify(envelope), session.content)).toThrow(/manifest hash/);
  });

  test("predecessor identities are only accepted against the current runtime identity", () => {
    const save = readSave(MAP_SCHEMA_COMPATIBLE_HASHES[0]!);
    const manifest = JSON.parse(save).content.manifest as string;
    expect(() => decodeEnvelopeText(save, { manifest, schema: REFUSED[0]! }))
      .toThrow("save map schema hash does not match this runtime");
    expect(decodeEnvelopeText(save, { manifest, schema: MAP_SCHEMA_HASH }).map).toBe("yard");
  });
});

describe("editor gates accept earlier generations and save under the current one", () => {
  const hash = MAP_SCHEMA_COMPATIBLE_HASHES[0]!;

  test("edit API, workspace and file server open the old shell", async () => {
    const source = readFileSync(join(genDir(hash), "project.json"), "utf8");
    expect(loadValidatedProjectShell(source).mapSchemaHash).toBe(hash);
    expect(() => loadValidatedProjectShell(source.replace(hash, FORGED))).toThrow(/map schema hash/);

    const shell = readShell(hash);
    const workspace = createShardedEditorWorkspace(shell, async (meta) => JSON.parse(readMapText(meta.entry)!));
    await workspace.activateMap("hall");
    workspace.setGroundCell("hall", 0, "tiles.0");
    workspace.updateMap("hall", (map) => ({ ...map, name: "Hall 2" }));
    const payload = workspace.buildSavePayload();
    expect(payload.shell.mapSchemaHash).toBe(MAP_SCHEMA_HASH);
    expect(payload.shell.mapManifestHash).toBe(mapManifestHash(payload.shell));
    expect(() => createShardedEditorWorkspace({ ...shell, mapSchemaHash: FORGED }, async () => {
      throw new Error("unused");
    })).toThrow(/map schema hash/);

    const dir = mkdtempSync(join(import.meta.dir, ".schema-compat-"));
    try {
      writeFileSync(join(dir, "project.json"), source);
      mkdirSync(join(dir, "maps"));
      for (const meta of shell.mapIndex) writeFileSync(join(dir, meta.entry), readMapText(meta.entry)!);
      expect(new EditorFiles(join(dir, "project.json")).project().shell).toBe(source);
      writeFileSync(join(dir, "project.json"), source.replace(hash, FORGED));
      expect(() => new EditorFiles(join(dir, "project.json"))).toThrow(/mapSchemaHash/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("breaking changes play older documents differently", () => {
  test("the witness cases cover every recorded counterexample", () => {
    const recorded = REFUSED.map(readWitness).filter((w): w is Witness => w !== undefined).map((w) => w.case);
    expect([...recorded].sort()).toEqual([...WITNESS_CASES].sort());
  });

  for (const hash of REFUSED) {
    const witness = readWitness(hash);
    if (!witness) continue;
    test(`generation ${short(hash)}: ${witness.case} differs from ${witness.recordedBy}`, async () => {
      const now = await runWitness(REPO, witness.case);
      // Valid under both schemas, so only the behaviour tells them apart.
      expect(witness.outcome.schemaErrors).toBe(0);
      expect(now.schemaErrors).toBe(0);
      expect(now).not.toEqual(witness.outcome);
    });
  }

  test("the recorded outcomes are the documented differences", async () => {
    const byCase = new Map(REFUSED.map(readWitness).filter((w): w is Witness => w !== undefined).map((w) => [w.case, w]));
    expect(byCase.get("stale-parallel-battle")!.outcome.battlesStarted).toEqual([{ clear: "go" }, {}]);
    expect((await runWitness(REPO, "stale-parallel-battle")).battlesStarted).toEqual([{ clear: "go" }]);

    const huge = byCase.get("variable-beyond-safe-integer")!.outcome;
    expect(huge.route).toBe(1e308);
    expect((await runWitness(REPO, "variable-beyond-safe-integer")).route).toBe(Number.MAX_SAFE_INTEGER);
    // The old release saved the value; this runtime refuses that save.
    let error: unknown;
    try {
      decodeEnvelopeText(huge.save as string);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe("shape");
    expect((error as SaveError).message).toContain("safe integer");

    expect(byCase.get("transfer-to-unknown-map")!.outcome).toMatchObject({ threw: true });
    expect(await runWitness(REPO, "transfer-to-unknown-map")).toMatchObject({ threw: false, error: { kind: "content" } });

    expect(byCase.get("route-through-marker")!.outcome.walker).toEqual({ x: 0, y: 2 });
    expect((await runWitness(REPO, "route-through-marker")).walker).not.toEqual({ x: 0, y: 2 });
  });
});
