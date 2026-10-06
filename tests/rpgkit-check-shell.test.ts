// tests/rpgkit-check-shell.test.ts — rpgkit-check on sharded ProjectShell
// projects: full materialization, --map scoping, and incremental lint with
// its per-shard cache. Findings must match the inline lint exactly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkTool } from "../tools/rpgkit-check/src/registry.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import {
  canonicalMapJson,
  mapManifestHash,
  sha256Bytes,
  sha256Text,
} from "../src/engine/map-repository.ts";
import type { Command, MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";
import type { CheckReport, Finding } from "../tools/rpgkit-check/src/finding.ts";

const TEMP = join(import.meta.dir, `.rpgkit-check-shell-${process.pid}-${randomUUID()}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const lint = checkTool("lint")!;

function text(lines: string[]): Command {
  return { op: "text", lines };
}

function projectWithFindings(): Project {
  const sameCondition = { switch: "s1" };
  return {
    format: "rpgkit-project/v1",
    title: "shell check acceptance",
    tileSize: 16,
    start: { map: "map-a", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    maps: [
      {
        id: "map-a",
        name: "A",
        width: 2,
        height: 1,
        sheets: ["s"],
        ground: ["s.0", "s.0"],
        events: [{
          id: "ev-a",
          x: 0,
          y: 0,
          pages: [
            { trigger: "action", condition: { ...sameCondition }, commands: [text(["a1"])] },
            { trigger: "action", condition: { ...sameCondition }, commands: [text(["a2"])] },
          ],
        }],
      },
      {
        id: "map-b",
        name: "B",
        width: 2,
        height: 1,
        sheets: ["s"],
        ground: ["s.0", "s.0"],
        events: [{
          id: "ev-b",
          x: 0,
          y: 0,
          pages: [{
            trigger: "action",
            commands: [
              { op: "transfer", map: "map-x", x: 0, y: 0 },
              { op: "variable", id: "v1", set: { op: "set", value: 1 } },
            ],
          }],
        }],
      },
      {
        id: "map-c",
        name: "C",
        width: 2,
        height: 1,
        sheets: ["s"],
        ground: ["s.0", "s.0"],
        events: [{
          id: "ev-c",
          x: 0,
          y: 0,
          pages: [{
            trigger: "action",
            condition: { switch: "s2" },
            commands: [
              text(["c1"]),
              { op: "variable", id: "v1", set: { op: "set", value: 1 } },
            ],
          }],
        }],
      },
    ],
  };
}

/** Write a shell + shards under root, one map per file, each in its chosen
 *  encoding. Returns the shell file path. */
function writeShell(
  root: string,
  project: Project,
  encodings: Record<string, "json" | "compact"> = {},
): string {
  const split = splitProjectMaps(project);
  mkdirSync(root, { recursive: true });
  const shell: ProjectShell = JSON.parse(split.shellText) as ProjectShell;
  for (const entry of split.entries) {
    const map = JSON.parse(entry.text) as MapDef;
    const encoding = encodings[map.id] ?? "json";
    const rel = encoding === "compact" ? entry.path.replace(/\.json$/, ".rkm") : entry.path;
    const text = encoding === "compact" ? encodeCompactMap(map).text : entry.text;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    const meta = shell.mapIndex.find((item) => item.id === map.id)!;
    meta.entry = rel;
    meta.sha256 = sha256Text(text);
  }
  delete shell.mapManifestHash;
  shell.mapManifestHash = mapManifestHash(shell);
  const shellFile = join(root, "project.json");
  writeFileSync(shellFile, JSON.stringify(shell));
  return shellFile;
}

function findingCodes(report: CheckReport): string[] {
  return report.findings.map((f) => `${f.check}@${f.loc.map ?? f.loc.common ?? f.loc.pointer ?? ""}`);
}

/** Global checks need the whole document and are intentionally skipped by a
 *  --map pass, even when their finding's location is on the scoped map. */
const GLOBAL_CHECKS = new Set([
  "lint/switch-read-never-set",
  "lint/switch-set-never-read",
  "lint/variable-read-never-set",
  "lint/variable-set-never-read",
  "lint/map-unreachable",
  "lint/start-map-missing",
  "lint/scene-id",
]);

describe("rpgkit-check on ProjectShell documents", () => {
  test("full shell lint matches the inline lint, on JSON and compact shards", async () => {
    const inline = projectWithFindings();
    const expected = lintProject(inline);
    const variants: Record<string, "json" | "compact">[] = [
      {},
      { "map-a": "compact", "map-b": "compact", "map-c": "compact" },
    ];
    for (const [index, encodings] of variants.entries()) {
      const root = join(TEMP, `full-${index}`);
      const shellFile = writeShell(root, inline, encodings);
      const report = (await lint.run({ file: shellFile })) as CheckReport;
      expect(findingCodes(report)).toEqual(findingCodes(expected));
      expect(report.summary.error).toBe(expected.summary.error);
    }
  });

  test("--map scopes the pass to one shard and reports its findings", async () => {
    const inline = projectWithFindings();
    const root = join(TEMP, "map");
    const shellFile = writeShell(root, inline, { "map-b": "compact" });
    const full = lintProject(inline);
    const report = (await lint.run({ file: shellFile, map: "map-b" })) as CheckReport;
    // map-b's own findings: the transfer to unknown map-x. Global findings
    // (switch/variable pairing, unreachable) need the whole document and are
    // intentionally absent from a scoped pass.
    const expectedCodes = full.findings
      .filter((f) => f.loc.map === "map-b" && !GLOBAL_CHECKS.has(f.check))
      .map((f) => `${f.check}@${f.loc.map ?? ""}`);
    expect(findingCodes(report)).toEqual(expectedCodes);
    expect(report.summary.scopedMap).toBe("map-b");
    expect(report.summary.maps).toBe(1);
    // Only map-b's shard was read: map-a and map-c files can be absent.
    rmSync(join(root, "maps", "map-a.json"));
    rmSync(join(root, "maps", "map-c.json"));
    const again = (await lint.run({ file: shellFile, map: "map-b" })) as CheckReport;
    expect(again.findings.length).toBe(report.findings.length);
  });

  test("--map works on inline documents too", async () => {
    const inline = projectWithFindings();
    const file = join(TEMP, "inline.json");
    writeFileSync(file, JSON.stringify(inline));
    const report = (await lint.run({ file, map: "map-c" })) as CheckReport;
    expect(report.summary.scopedMap).toBe("map-c");
    expect(report.findings.some((f) => f.check === "lint/switch-read-never-set")).toBe(false);
  });

  test("incremental lint: cache miss checks all, cache hit re-checks none, findings identical", async () => {
    const inline = projectWithFindings();
    const root = join(TEMP, "incr");
    const shellFile = writeShell(root, inline, { "map-a": "compact", "map-c": "compact" });
    const expected = lintProject(inline);

    const first = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(first.summary.checked).toBe(3);
    expect(first.summary.cached).toBe(0);
    expect(findingCodes(first)).toEqual(findingCodes(expected));

    const second = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(second.summary.checked).toBe(0);
    expect(second.summary.cached).toBe(3);
    expect(findingCodes(second)).toEqual(findingCodes(expected));
  });

  test("incremental lint re-checks only the changed shard", async () => {
    const inline = projectWithFindings();
    const root = join(TEMP, "incr-change");
    const shellFile = writeShell(root, inline, { "map-a": "compact", "map-b": "compact", "map-c": "compact" });
    // Prime the cache.
    await lint.run({ file: shellFile, incremental: true });

    // Edit map-b: remove the bad transfer (fix the finding) by rewriting its
    // shard and refreshing the shell checksum, like the edit API does.
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((m) => m.id === "map-b")!;
    const mapB = inline.maps.find((m) => m.id === "map-b")!;
    mapB.events![0]!.pages[0]!.commands = [{ op: "text", lines: ["fixed"] }];
    const text = encodeCompactMap(mapB).text;
    writeFileSync(join(root, meta.entry), text);
    meta.sha256 = sha256Text(text);
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const report = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(report.summary.checked).toBe(1);
    expect(report.summary.cached).toBe(2);
    const expected = lintProject(inline);
    expect(findingCodes(report)).toEqual(findingCodes(expected));
    expect(report.findings.some((f) => f.check === "lint/transfer-target-missing")).toBe(false);

    // A further run caches everything again.
    const third = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(third.summary.checked).toBe(0);
    expect(third.summary.cached).toBe(3);
  });

  test("incremental lint catches a shard changed without a shell checksum refresh", async () => {
    // The cache must key on the shard bytes on disk, not only on the
    // checksum the shell declares: an external edit, sync or corruption can
    // drift a shard while the shell index stays stale.
    const inline = projectWithFindings();
    const root = join(TEMP, "incr-drift");
    const shellFile = writeShell(root, inline, { "map-a": "compact" });
    await lint.run({ file: shellFile, incremental: true }); // prime

    // Corrupt map-b's shard directly, without touching the shell.
    const shardPath = join(root, "maps", "map-b.json");
    const original = readFileSync(shardPath, "utf8");
    writeFileSync(shardPath, `${original}\n`);

    const drifted = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(drifted.summary.checked).toBe(1);
    expect(drifted.summary.cached).toBe(2);
    expect(drifted.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);

    // The drift stays visible on a cached re-run.
    const again = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(again.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);
    expect(again.summary.cached).toBe(3);

    // Refreshing the shell checksum to match the bytes on disk re-checks
    // the shard and clears the checksum finding.
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((m) => m.id === "map-b")!;
    meta.sha256 = sha256Text(`${original}\n`);
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));
    const refreshed = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(refreshed.summary.checked).toBe(1);
    expect(refreshed.findings.some((f) => f.check === "doc/shard-checksum")).toBe(false);
  });

  test("a checksum mismatch is an error finding, not a crash", async () => {
    const inline = projectWithFindings();
    const root = join(TEMP, "checksum");
    const shellFile = writeShell(root, inline);
    // Any byte change invalidates the checksum (a trailing newline keeps
    // the JSON parseable, so the checksum gate is what fires).
    const original = readFileSync(join(root, "maps", "map-a.json"), "utf8");
    writeFileSync(join(root, "maps", "map-a.json"), `${original}\n`);
    const report = (await lint.run({ file: shellFile })) as CheckReport;
    expect(report.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);
    expect(report.summary.error).toBeGreaterThan(0);
  });

  test("loadProjectFile still flags the shell shape for callers that ask", () => {
    const root = join(TEMP, "flag");
    const shellFile = writeShell(root, projectWithFindings());
    const loaded = loadProjectFile(shellFile);
    expect(loaded.shell).toBe(true);
    expect(loaded.schemaErrors.some((f: Finding) => f.check === "doc/shell-unsupported")).toBe(false);
  });

  test("incremental lint keys on the shard's raw bytes, not its decoded text", async () => {
    // A drift that changes the raw bytes but not the UTF-8 decoded text must
    // still miss the cache: the legal U+FFFD encoding EF BF BD and the
    // illegal byte FF both decode to U+FFFD, so a hash over decoded text
    // would report a cache hit for a changed file.
    const inline = projectWithFindings();
    const root = join(TEMP, "incr-raw-bytes");
    const shellFile = writeShell(root, inline);
    await lint.run({ file: shellFile, incremental: true }); // prime

    // Plant the legal U+FFFD bytes inside map-b's name string and refresh
    // the shell's declared checksum to the decoded text (what the shell
    // would declare after a real edit through the editor API).
    const shardPath = join(root, "maps", "map-b.json");
    const planted = readFileSync(shardPath);
    const at = planted.indexOf(Buffer.from('"B"', "ascii"));
    expect(at).toBeGreaterThan(-1);
    const legal = Buffer.concat([
      planted.subarray(0, at + 1),
      Buffer.from([0xef, 0xbf, 0xbd]),
      planted.subarray(at + 2),
    ]);
    writeFileSync(shardPath, legal);
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((m) => m.id === "map-b")!;
    meta.sha256 = sha256Text(legal.toString("utf8"));
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const plantedRun = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(plantedRun.summary.checked).toBe(1);
    expect(plantedRun.summary.cached).toBe(2);

    // Drift the raw bytes: EF BF BD -> the illegal byte FF. The decoded
    // text is byte-for-byte the same, but the file on disk changed.
    const driftedBytes = Buffer.concat([
      legal.subarray(0, at + 1),
      Buffer.from([0xff]),
      legal.subarray(at + 4),
    ]);
    expect(sha256Bytes(driftedBytes)).not.toBe(sha256Bytes(legal));
    expect(driftedBytes.toString("utf8")).toBe(legal.toString("utf8"));
    writeFileSync(shardPath, driftedBytes);

    const drifted = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(drifted.summary.checked).toBe(1);
    expect(drifted.summary.cached).toBe(2);
    expect(findingCodes(drifted)).toEqual(findingCodes(plantedRun));

    // The re-check cached the new bytes, so a further run is fully cached.
    const again = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(again.summary.checked).toBe(0);
    expect(again.summary.cached).toBe(3);
  });

  test("incremental lint re-checks a BOM or newline byte drift", async () => {
    const inline = projectWithFindings();
    for (const [name, mutate] of [
      ["bom", (bytes: Buffer): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])],
      ["newline", (bytes: Buffer): Buffer => Buffer.from(bytes.toString("utf8").replace(":", ":\n"), "utf8")],
    ] as const) {
      const root = join(TEMP, `incr-drift-${name}`);
      const shellFile = writeShell(root, inline);
      await lint.run({ file: shellFile, incremental: true }); // prime

      const shardPath = join(root, "maps", "map-a.json");
      writeFileSync(shardPath, mutate(readFileSync(shardPath)));

      const drifted = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
      expect(drifted.summary.checked).toBe(1);
      expect(drifted.summary.cached).toBe(2);
      expect(drifted.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);
    }
  });

  test("incremental lint re-checks a CRLF to LF byte drift", async () => {
    // The cache key is the shard's raw bytes, not a newline-normalized text:
    // a shard whose line endings drift CRLF -> LF (bytes changed, shell
    // declaration stale) must miss the cache. A hash over CRLF-normalized
    // text would report a hit for the changed file.
    const inline = projectWithFindings();
    const root = join(TEMP, "incr-crlf");
    const shellFile = writeShell(root, inline);
    // Insert a CRLF (valid JSON whitespace) into map-a's single-line shard
    // and refresh the shell's declared checksum, so the prime is clean.
    const shardPath = join(root, "maps", "map-a.json");
    const original = readFileSync(shardPath, "utf8");
    expect(original.includes("\r\n")).toBe(false);
    expect(original.includes("\n")).toBe(false);
    const crlf = original.replace("{", "{\r\n");
    writeFileSync(shardPath, crlf);
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((m) => m.id === "map-a")!;
    meta.sha256 = sha256Text(crlf);
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const prime = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(prime.summary.checked).toBe(3);
    expect(prime.summary.cached).toBe(0);
    expect(prime.findings.some((f) => f.check === "doc/shard-checksum")).toBe(false);

    // An external rewrite normalizes the line ending CRLF -> LF without
    // refreshing the shell. The raw bytes changed; the cache must miss.
    const lf = crlf.replaceAll("\r\n", "\n");
    expect(sha256Bytes(Buffer.from(lf, "utf8"))).not.toBe(sha256Bytes(Buffer.from(crlf, "utf8")));
    writeFileSync(shardPath, lf);
    const drifted = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(drifted.summary.checked).toBe(1);
    expect(drifted.summary.cached).toBe(2);
    expect(drifted.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);
  });

  test("incremental lint re-checks a shard whose declared checksum changed", async () => {
    // The cache hit needs BOTH hashes to match: changing only what the shell
    // declares (no shard byte on disk changed) must also re-check the shard.
    const inline = projectWithFindings();
    const root = join(TEMP, "incr-declared");
    const shellFile = writeShell(root, inline);
    await lint.run({ file: shellFile, incremental: true }); // prime

    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((m) => m.id === "map-b")!;
    meta.sha256 = `${"0".repeat(64)}`;
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const drifted = (await lint.run({ file: shellFile, incremental: true })) as CheckReport;
    expect(drifted.summary.checked).toBe(1);
    expect(drifted.summary.cached).toBe(2);
    expect(drifted.findings.some((f) => f.check === "doc/shard-checksum")).toBe(true);
  });
});
