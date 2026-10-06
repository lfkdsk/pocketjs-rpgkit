// tools/rpgkit-check/src/doc.ts — load an rpgkit-project/v1 document for
// checking. The editor exports inline Projects (maps in the document);
// those are what every check consumes. A ProjectShell (sharded maps) is
// detected here and materialized by the registry (src/shell.ts), so both
// shapes check through the same code path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSchema, type Schema } from "../../../src/engine/schema-validate.ts";
import type { Project, ProjectSource } from "../../../src/engine/types.ts";
import { makeFinding, type Finding } from "./finding.ts";

// Imported for its side effect of bundling the normative schema with the
// tool; JSON import is a first-class bun/tsc feature in this repo
// (src/index.ts re-exports the same file).
import schemaJson from "../../../src/data/schema.json" with { type: "json" };

export const PROJECT_SCHEMA: Schema = schemaJson as Schema;

export interface LoadedProject {
  /** The typed project. Present even when `schemaErrors` is non-empty:
   *  structural checks run best-effort on the parsed JSON. Absent only when
   *  the file is not parseable JSON or not an object. */
  project: Project | null;
  /** Schema-validation findings (error severity) for this document. */
  schemaErrors: Finding[];
  /** True when the document is a ProjectShell (sharded maps). The registry
   *  materializes it (src/shell.ts) instead of checking it inline. */
  shell: boolean;
}

function isProjectShell(doc: unknown): doc is { mapIndex: unknown } {
  return typeof doc === "object" && doc !== null && "mapIndex" in doc;
}

/** Parse and schema-validate a project file. Never throws on a malformed
 *  document — the problems become findings. */
export function loadProjectFile(path: string): LoadedProject {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    return {
      project: null,
      shell: false,
      schemaErrors: [
        makeFinding(
          "doc/unreadable",
          "error",
          `cannot read ${abs}: ${String(err)}`,
          "pass a path to an rpgkit-project/v1 JSON document",
        ),
      ],
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      project: null,
      shell: false,
      schemaErrors: [
        makeFinding(
          "doc/invalid-json",
          "error",
          `${abs} is not valid JSON: ${String(err)}`,
          "fix the JSON syntax (the editor's export gate would have refused this)",
        ),
      ],
    };
  }
  const errors = validateSchema(PROJECT_SCHEMA, doc).map((ve) =>
    makeFinding(
      "doc/schema",
      "error",
      `schema violation at ${ve.path}: ${ve.msg}`,
      "bring the document back to what the editor exports",
      { pointer: ve.path },
    ),
  );
  const shell = isProjectShell(doc);
  return { project: doc as Project, schemaErrors: errors, shell };
}

// structuralFindings lives in structure.ts (no Node imports) so browser
// front-ends can run the lint checks; re-exported for existing callers.
export { structuralFindings } from "./structure.ts";

export function isInlineProject(source: ProjectSource): source is Project {
  return !isProjectShell(source);
}
