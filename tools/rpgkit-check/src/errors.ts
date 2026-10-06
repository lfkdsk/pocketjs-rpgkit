// tools/rpgkit-check/src/errors.ts — error classes shared by the registry,
// the shell loader and the entry points (CLI, MCP). Kept in their own module
// so the loaders can throw them without importing the registry (which imports
// the loaders).

import type { VError } from "../../../src/engine/schema-validate.ts";
import type { Finding } from "./finding.ts";

/** Args failed the tool's inputSchema. Entry points (CLI/MCP) report this
 *  as a usage error, never a server crash. */
export class CheckArgsError extends Error {
  readonly details: VError[];
  constructor(message: string, details: VError[]) {
    super(message);
    this.name = "CheckArgsError";
    this.details = details;
  }
}

/** The project file could not be loaded. Carries the doc/* findings so the
 *  CLI/MCP can emit them as a JSON report instead of a plain crash. */
export class CheckLoadError extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[]) {
    super(message);
    this.name = "CheckLoadError";
    this.findings = findings;
  }
}
