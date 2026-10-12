// Guest code may use only what the PocketJS guest realm provides. The sim
// suites run bundles on Bun, which also has structuredClone, TextEncoder,
// setTimeout, crypto, ...; a call to one of those passes here and throws on
// the desktop host's QuickJS (the sharded editor once refused every project
// with "structuredClone is not defined"). See tests/helpers/guest-globals.ts
// for the rules and tests/fixtures/quickjs-guest-globals.json for the
// measured allowlist (refresh: tools/editor-sharded-quickjs-check.sh
// --write-globals).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APPS, FIXTURES, appEntry } from "../tools/build-example.ts";
import {
  createGuestProgram,
  formatViolations,
  guestModuleGraph,
  loadGuestInventory,
  scanGuestSources,
} from "./helpers/guest-globals.ts";

const ROOT = resolve(import.meta.dir, "..");

/** Handwritten list of package exports that a game bundles into its guest;
 * package.json also exports `./editor-api` for Bun/Node and `./schema` as JSON,
 * so deriving this list from every export would scan code that never runs in
 * a guest. Keep it in sync when adding a guest-facing package export. */
const GUEST_EXPORTS = [
  "src/index.ts",
  "src/engine/index.ts",
  "src/ui/index.ts",
  "src/ui/image.ts",
  "src/ui/ChoiceIconBox.tsx",
  "src/ui/battle/index.ts",
  "src/ui/demo/index.ts",
  "src/ui/world/index.ts",
  "src/ui/session-saves.ts",
  "src/ui/audio/index.ts",
  "src/ui/ChoiceColourLine.tsx",
  "src/ui/TravelActors.tsx",
  "src/engine/rpgmaker-text.ts",
  "src/travel.ts",
  "src/host/index.ts",
];

const inventory = loadGuestInventory();
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("guest globals", () => {
  test("the allowlist is a QuickJS realm, not Bun", () => {
    for (const present of ["Object", "Promise", "queueMicrotask", "console", "ui", "frame"]) {
      expect(inventory.globals).toContain(present);
    }
    for (const absent of ["structuredClone", "TextEncoder", "TextDecoder", "setTimeout", "setInterval", "crypto", "fetch", "URL", "Bun", "process"]) {
      expect(inventory.globals).not.toContain(absent);
    }
  });

  test("every desktop guest app, fixture and package export uses only guest globals", () => {
    // TOOL_APPS is deliberately excluded: tools/preview is a browser-only
    // PocketJS app whose postMessage protocol uses browser globals that the
    // desktop QuickJS guest is not meant to provide.
    // tools/qoa-quickjs-entry.ts is also not a shipping app/package entry. It
    // is a standalone benchmark exercised in the real QuickJS guest by
    // tools/qoa-quickjs-bench.sh, which is its dedicated compatibility check.
    const entries = [
      ...[...APPS, ...FIXTURES].map(appEntry),
      ...GUEST_EXPORTS.map((path) => join(ROOT, path)),
    ];
    const graph = guestModuleGraph(entries);
    // The walk must reach the code that ran into the gap.
    for (const path of ["editor/app.tsx", "editor/engine/sharded-workspace.ts", "editor/proposals/model.ts", "src/engine/interpreter.ts"]) {
      expect(graph.files).toContain(join(ROOT, path));
    }
    expect(graph.files.length).toBeGreaterThan(150);
    const violations = [...graph.violations, ...scanGuestSources(graph.files, inventory)];
    expect(formatViolations(violations)).toBe("");
  }, 120_000);

  test("the scanner reports what the guest lacks and nothing else", () => {
    const dir = mkdtempSync(join(import.meta.dir, ".guest-globals-"));
    temporary.push(dir);
    const bad = join(dir, "bad.ts");
    const good = join(dir, "good.ts");
    writeFileSync(bad, [
      "export const a = structuredClone({ x: 1 });",
      "export const b = new TextEncoder().encode(\"x\");",
      "export const c = globalThis.structuredClone;",
      "setTimeout(() => {}, 0);",
      "export const d = { structuredClone };",
      "console.time(\"x\");",
      "export const f = crypto.randomUUID();",
      "import { readFileSync } from \"node:fs\";",
      "export const g = readFileSync;",
      "",
    ].join("\n"));
    writeFileSync(good, [
      "const structuredClone = <T>(v: T): T => v;",
      "export const a = structuredClone({ x: 1 });",
      "export const b = typeof TextEncoder === \"function\";",
      "export type E = TextEncoder;",
      "export const c = { setTimeout: 1 }.setTimeout;",
      "export const d = Object.hasOwn({}, \"x\") && [3, 1].toSorted()[0] === 1;",
      "export const e = new Set([1]).union(new Set([2])).size + Math.max(1, 2);",
      "queueMicrotask(() => {});",
      "export function f(encoder: TextEncoder): unknown { return encoder; }",
      "",
    ].join("\n"));
    const program = createGuestProgram([bad, good]);
    const found = scanGuestSources([bad, good], inventory, program);
    expect(found.map((v) => `${v.file.split("/").pop()}:${v.line} ${v.kind} ${v.name}`)).toEqual([
      "bad.ts:1 global structuredClone",
      "bad.ts:2 global TextEncoder",
      "bad.ts:3 global structuredClone",
      "bad.ts:4 global setTimeout",
      "bad.ts:5 global structuredClone",
      "bad.ts:6 member Console.time",
      "bad.ts:7 global crypto",
    ]);
    const graph = guestModuleGraph([bad]);
    expect(graph.violations.map((v) => `${v.kind} ${v.name}`)).toEqual(["import node:fs"]);
  }, 60_000);
});
