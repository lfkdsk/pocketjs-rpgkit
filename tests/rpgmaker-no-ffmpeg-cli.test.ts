import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = join(import.meta.dir, "fixtures", "rpgmaker", "hollow-mz");
const SCRATCH = join(import.meta.dir, `.rpgmaker-no-ffmpeg-cli-${process.pid}`);

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relative);
      else files.push(relative);
    }
  };
  walk(root);
  return files;
}

describe("RPG Maker CLI without ffmpeg on PATH", () => {
  test("completes the project and imports Ogg through the bundled decoder", () => {
    const output = join(SCRATCH, "imported");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "tools/rpgmaker-import", SOURCE, "--out", output, "--shard"],
      cwd: ROOT,
      env: { ...process.env, PATH: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(child.stderr ?? new Uint8Array());
    expect(child.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("rpgmaker-import: 3 maps");
    expect(stderr).not.toContain("audio decoder unavailable");

    for (const path of ["project.json", "battle.json", "assets.json", "audio-media.json", "coverage.json", "coverage.md"]) {
      expect(existsSync(join(output, path)), path).toBe(true);
    }
    const project = JSON.parse(readFileSync(join(output, "project.json"), "utf8")) as {
      mapIndex: unknown[];
      audio?: Record<string, string>;
    };
    expect(project.mapIndex).toHaveLength(3);
    expect(Object.keys(project.audio ?? {})).toHaveLength(6);

    const media = JSON.parse(readFileSync(join(output, "audio-media.json"), "utf8")) as Array<{
      key: string;
      status: string;
      reason?: string;
    }>;
    const ogg = media.filter((record) => record.status === "success");
    expect(ogg.map((record) => record.key)).toEqual([
      "bgm/hollow-battle",
      "bgm/hollow-map",
      "bgs/hollow-cave",
      "me/hollow-defeat",
      "me/hollow-victory",
      "se/hollow-spark",
    ]);
    expect(media.filter((record) => record.status === "missing")).toHaveLength(6);
    expect(filesBelow(join(output, "audio"))).toHaveLength(6);

    const coverage = JSON.parse(readFileSync(join(output, "coverage.json"), "utf8")) as Array<{
      section: string;
      key: string;
      counts: { Native: number; Dropped: number };
      reasons: string[];
    }>;
    const audioRows = coverage.filter((row) => row.section === "audio");
    expect(audioRows.reduce((sum, row) => sum + row.counts.Native, 0)).toBe(6);
    expect(audioRows.reduce((sum, row) => sum + row.counts.Dropped, 0)).toBe(6);
  }, 30_000);
});
