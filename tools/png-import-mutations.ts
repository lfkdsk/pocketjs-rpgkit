// Run five isolated PNG-import mutation checks; restore each source in finally.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const checks = [
  {
    file: "editor/api/png-import.ts",
    from: "const sx = grid.offsetX + col * (grid.cellWidth + grid.spacingX);",
    to: "const sx = col * (grid.cellWidth + grid.spacingX);",
    test: "crops offset and spacing without shifting source pixels",
  },
  {
    file: "editor/api/png-import.ts",
    from: "if (existing && !replace) return { ok: false, message: `${id} already exists; rename it or confirm replacement.` };",
    to: "if (existing && !replace && false) return { ok: false, message: `${id} already exists; rename it or confirm replacement.` };",
    test: "rejects collisions and invalid cropped PNG without changing history",
  },
  {
    file: "editor/api/png-import.ts",
    from: "cols * rows < existing.cols * existing.rows &&",
    to: "cols * rows < 0 &&",
    test: "requires explicit replacement and refuses fewer cells on a map-used sheet",
  },
  {
    file: "editor/api/session.ts",
    from: "const asset = direction === \"reverse\" ? before : after;",
    to: "const asset = after;",
    test: "tile import attaches to a map and undoes catalog and art together",
  },
  {
    file: "editor/api/png-import.ts",
    from: "if (!map.sheets?.includes(id)) operations.push(",
    to: "if (false && !map.sheets?.includes(id)) operations.push(",
    test: "tile import attaches to a map and undoes catalog and art together",
  },
] as const;

let failed = false;
for (const check of checks) {
  const original = readFileSync(check.file, "utf8");
  if (original.split(check.from).length !== 2) throw new Error(`Mutation target missing or ambiguous: ${check.file}: ${check.from}`);
  try {
    writeFileSync(check.file, original.replace(check.from, check.to));
    const run = spawnSync("bun", ["test", "tests/studio-pack-assets.test.ts", "-t", check.test], { encoding: "utf8" });
    const caught = run.status !== 0 && (run.stdout + run.stderr).includes("(fail)");
    console.log(`${caught ? "CAUGHT" : "MISSED"}: ${check.test} (exit ${run.status})`);
    if (!caught) {
      failed = true;
      console.error(run.stdout, run.stderr);
    }
  } finally {
    writeFileSync(check.file, original);
  }
}
if (failed) process.exitCode = 1;
