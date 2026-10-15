// tools/desktop.ts — build an example for the PocketJS desktop host and run
// it in a window: macos-app on a Mac, linux-app elsewhere.
//
//   bun tools/desktop.ts sunstone              # build, then launch (Cmd+Q quits)
//   bun tools/desktop.ts grow --build-only     # bundle + release host, no window
//   bun tools/desktop.ts sunstone --bytecode   # source + target QuickJS bytecode
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

export interface DesktopCliArgs {
  readonly name: string;
  readonly buildOnly: boolean;
  readonly bytecode: boolean;
  readonly hostArgs: string[];
}

export function parseDesktopCliArgs(values: readonly string[]): DesktopCliArgs {
  const argv = values.filter((argument) => argument !== "--");
  const buildOnly = argv.includes("--build-only");
  const bytecode = argv.includes("--bytecode");
  const rest = argv.filter(
    (argument) => argument !== "--build-only" && argument !== "--bytecode",
  );
  const name = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "sunstone";
  return { name, buildOnly, bytecode, hostArgs: rest };
}

export async function desktopMain(values: readonly string[]): Promise<void> {
  const args = parseDesktopCliArgs(values);
  if (!(EXAMPLES as readonly string[]).includes(args.name)) {
    throw new Error(
      `desktop: unknown example "${args.name}" (have: ${EXAMPLES.join(", ")})`,
    );
  }
  const build = await buildForDesktop(
    join(root, "examples", args.name, "pocket.json"),
    { bytecode: args.bytecode },
  );
  if (args.buildOnly) {
    const mode = build.pocket ? ` + bytecode package (${build.pocket})` : "";
    console.log(
      `desktop: built ${build.plan.app.output} for ${DESKTOP_TARGET} + release host${mode} (${build.bin})`,
    );
    return;
  }
  await runDesktopHost(build, args.hostArgs);
}

if (import.meta.main) await desktopMain(process.argv.slice(2));
