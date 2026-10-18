import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const desktopPackage = JSON.parse(readFileSync(join(ROOT, "studio-desktop", "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const builder = readFileSync(join(ROOT, "studio-desktop", "electron-builder.yml"), "utf8");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "studio-desktop.yml"), "utf8");
const e2eRunner = readFileSync(join(ROOT, "studio-desktop", "e2e", "run.ts"), "utf8");

describe("Studio desktop Windows packaging", () => {
  test("the public script and builder config produce one unsigned x64 NSIS installer", () => {
    expect(desktopPackage.scripts?.["dist:win"])
      .toBe("bun build.ts && electron-builder --win nsis --x64 --publish never");
    expect(builder).toContain("win:\n  artifactName: pocket-rpgkit-studio-${version}-${arch}-setup.${ext}");
    expect(builder).toMatch(/target:\n\s+- target: nsis\n\s+arch:\n\s+- x64/);
  });

  test("Linux and Windows package before running the same Playwright smoke", () => {
    expect(workflow).toContain("- os: ubuntu-latest\n            os-name: Linux\n            dist-script: dist:linux");
    expect(workflow).toContain("- os: windows-latest\n            os-name: Windows\n            dist-script: dist:win");
    expect(workflow.match(/- name: Run the desktop end-to-end test/g)).toHaveLength(1);
    expect(workflow).toContain("run: bun run ${{ matrix.dist-script }}");
    expect(workflow).toContain("run: bun run e2e");
    expect(workflow).toContain("dist/win-unpacked/resources/app.asar");
    expect(workflow).toContain("dist/win-unpacked/resources/helper/rpgkit-studio-helper.exe");
    expect(workflow).toContain("pocket-rpgkit-studio-*-x64-setup.exe");
  });

  test("CI uses frozen public lockfiles and the runner resolves Node on Windows", () => {
    // Root + desktop installs appear once in the smoke matrix and once in the
    // existing macOS release job; every path stays on a frozen public lockfile.
    expect(workflow.match(/bun install --frozen-lockfile/g)).toHaveLength(4);
    expect(workflow).not.toMatch(/registry-url|npm\.pkg\.github|artifactory|jfrog/i);
    expect(e2eRunner).toContain('process.platform === "win32"');
    expect(e2eRunner).toContain('spawnSync("where.exe", [name]');
    expect(e2eRunner).toContain("split(/\\r?\\n/, 1)");
  });
});
