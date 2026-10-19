// studio-desktop/e2e/run.ts — run the desktop app's end-to-end test.
//
//   bun run build && bun run e2e
//
// Prepares the fixtures (Sunstone as a project folder, the same folder with
// its own art (an autumn town sheet and a recoloured sprite), an agent config for
// the kit's offline fake agent, a project with an engine-check finding) under
// studio-desktop/.e2e/, starts a virtual X display when there is none (Xvfb on
// PATH, or the XVFB variable), then runs e2e/studio-desktop.test.mjs under
// Node: Playwright drives Electron from Node, not from Bun.
//
// Screenshots go to docs/screenshots/studio-desktop/.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Project } from "../../src/engine/types.ts";
import { splitProjectMaps } from "../../tools/lib/map-project.ts";
import { autumn, encodePng } from "../../tools/lib/png-encode.ts";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";

const HERE = resolve(import.meta.dir, "..");
const KIT = resolve(HERE, "..");
const WORK = join(HERE, ".e2e");
const RPG_MAKER_SOURCE = join(KIT, "tests", "fixtures", "rpgmaker", "hollow-mz");

if (!existsSync(join(HERE, "app", "main.cjs"))) {
  console.error("studio-desktop e2e: app/ is not built; run `bun run build` first");
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const importParent = join(WORK, "imports");
mkdirSync(importParent, { recursive: true });
const decoderFreePath = join(WORK, "path-without-ffmpeg");
mkdirSync(decoderFreePath, { recursive: true });

// Keep the checked-in fixture immutable. One present M4A exercises the
// per-file decoder warning while its Ogg tracks exercise the bundled fallback.
const rpgMaker = join(WORK, "hollow-mz");
cpSync(RPG_MAKER_SOURCE, rpgMaker, { recursive: true });
writeFileSync(join(rpgMaker, "audio", "se", "hollow-chest.m4a"), Uint8Array.of(
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
));

// Sunstone as a project folder: project.json plus one file per map.
const sunstone = JSON.parse(readFileSync(join(KIT, "examples", "sunstone", "data", "sunstone.json"), "utf8")) as Project;
const split = splitProjectMaps(sunstone);
const folder = join(WORK, "sunstone");
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, "project.json"), split.shellText);
for (const entry of split.entries) {
  mkdirSync(dirname(join(folder, entry.path)), { recursive: true });
  writeFileSync(join(folder, entry.path), entry.text);
}

// The same project with its own art, found by Studio's folder conventions:
// art/sheets/<sheet id>.png and an image sprite's `src` path.
const artFolder = join(WORK, "sunstone-art");
mkdirSync(join(artFolder, "art", "sheets"), { recursive: true });
mkdirSync(join(artFolder, "assets", "npc"), { recursive: true });
writeFileSync(join(artFolder, "project.json"), split.shellText);
for (const entry of split.entries) {
  mkdirSync(dirname(join(artFolder, entry.path)), { recursive: true });
  writeFileSync(join(artFolder, entry.path), entry.text);
}
const town = decodePng(new Uint8Array(readFileSync(join(KIT, "examples", "sunstone", "assets", "src", "town-tiles.png"))));
writeFileSync(join(artFolder, "art", "sheets", "town.png"), encodePng(town.width, town.height, autumn(town.rgba)));
const wiz = new Uint8Array(16 * 16 * 4);
for (let i = 0; i < wiz.length; i += 4) wiz.set([236, 64, 200, 255], i);
writeFileSync(join(artFolder, "assets", "npc", "wiz.png"), encodePng(16, 16, wiz));

// A single-file project rpgkit-check's engine checks have something to say about.
const broken = join(WORK, "broken.json");
copyFileSync(join(KIT, "tests", "fixtures", "rpgkit-check", "broken.json"), broken);

// The kit's offline fake agent: it reads the real prompt, talks to the
// proposal-only MCP server (the app's helper) and creates one proposal.
const agentConfig = join(WORK, "agent.json");
writeFileSync(agentConfig, `${JSON.stringify({
  adapter: "custom",
  name: "offline fake agent",
  command: [process.execPath, join(KIT, "tests", "fixtures", "fake-local-agent.ts")],
  mcpRegistration: "claude-json",
  workingDirectory: "{{projectDir}}",
  timeoutMs: 60_000,
  env: { FAKE_AGENT_MODE: "success" },
}, null, 2)}\n`);

function which(name: string): string | null {
  if (process.platform === "win32") {
    const found = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    if (found.status !== 0) return null;
    return found.stdout.split(/\r?\n/, 1)[0]?.trim() || null;
  }
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}

let xvfb: ChildProcess | null = null;
let display = process.env.DISPLAY;
if (process.platform === "linux" && !display) {
  const binary = process.env.XVFB ?? which("Xvfb");
  if (!binary) {
    console.error("studio-desktop e2e: no DISPLAY and no Xvfb; install xvfb or set XVFB to its path");
    process.exit(1);
  }
  display = `:${90 + Math.floor(Math.random() * 400)}`;
  xvfb = spawn(binary, [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
  await Bun.sleep(800);
}

const node = process.env.NODE ?? which("node");
if (!node) {
  console.error("studio-desktop e2e: Node.js is needed to run Playwright");
  process.exit(1);
}

let code = 1;
try {
  const test = spawnSync(node, ["--test", "--test-concurrency=1", "--test-force-exit", "--test-reporter", process.env.STUDIO_E2E_REPORTER ?? "spec", join(HERE, "e2e", "studio-desktop.test.mjs")], {
    cwd: HERE,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(display ? { DISPLAY: display } : {}),
      STUDIO_E2E_WORK: WORK,
      STUDIO_E2E_FOLDER: folder,
      STUDIO_E2E_ART_FOLDER: artFolder,
      STUDIO_E2E_BROKEN: broken,
      STUDIO_E2E_AGENT_CONFIG: agentConfig,
      STUDIO_E2E_RPG_MAKER: rpgMaker,
      STUDIO_E2E_IMPORT_PARENT: importParent,
      STUDIO_E2E_SHOTS: join(KIT, "docs", "screenshots", "studio-desktop"),
      STUDIO_E2E_APP_PATH: decoderFreePath,
    },
  });
  code = test.status ?? 1;
} finally {
  xvfb?.kill("SIGTERM");
  if (code === 0 && !process.env.STUDIO_E2E_KEEP) rmSync(WORK, { recursive: true, force: true });
}
process.exit(code);
