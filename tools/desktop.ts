// tools/desktop.ts — build an example for the PocketJS desktop host and run
// it in a window: macos-app on a Mac, linux-app elsewhere.
//
//   bun tools/desktop.ts sunstone              # build, then launch (Cmd+Q quits)
//   bun tools/desktop.ts grow --build-only     # bundle + release host, no window
//   bun tools/desktop.ts sunstone -- --quit-after 900   # extra host flags pass through
//
// The plan -> bundle -> host pipeline lives in tools/lib/desktop.ts (shared
// with tools/editor.ts): the example's pocket.json resolves against the
// desktop target, the bundle lands in dist/<target>/, and every host flag
// derives from the resolved plan.

import { join, resolve } from "node:path";
import { EXAMPLES } from "./build-example.ts";
import { DESKTOP_TARGET, buildForDesktop, runDesktopHost } from "./lib/desktop.ts";

const root = resolve(import.meta.dir, "..");

const argv = process.argv.slice(2).filter((a) => a !== "--");
const buildOnly = argv.includes("--build-only");
const rest = argv.filter((a) => a !== "--build-only");
const name = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "sunstone";
if (!(EXAMPLES as readonly string[]).includes(name)) {
  throw new Error(`desktop: unknown example "${name}" (have: ${EXAMPLES.join(", ")})`);
}

const build = await buildForDesktop(join(root, "examples", name, "pocket.json"));
if (buildOnly) {
  console.log(`desktop: built ${build.plan.app.output} for ${DESKTOP_TARGET} + release host (${build.bin})`);
  process.exit(0);
}
await runDesktopHost(build, rest);
