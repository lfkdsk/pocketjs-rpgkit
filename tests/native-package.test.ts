import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  POCKET_SECTION,
  decodeBytecodeEnvelope,
  decodePocketPackage,
  encodeBytecodeEnvelope,
  findSection,
} from "../vendor/pocketjs/contracts/spec/pocket-package.ts";
import {
  PSP_QUICKJS_ENGINE_ABI,
  quickJsEngineAbiForTarget,
  type QuickJsEngineAbi,
} from "../vendor/pocketjs/contracts/spec/quickjs-bytecode.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import {
  RPGKIT_PSP_ENGINE_ABI,
  assertNativePackageArtifacts,
  assertRpgkitPspEngineAbi,
  packageNativeArtifacts,
  type NativePackageInput,
} from "../tools/lib/native-package.ts";
import { parsePackageNativeArgs } from "../tools/package-native.ts";
import { parseDesktopCliArgs } from "../tools/desktop.ts";
import { desktopFlags } from "../tools/lib/desktop.ts";

const ROOT = resolve(import.meta.dir, "..");

function desktopInput(bytecode: boolean): NativePackageInput {
  const manifest = new Uint8Array(
    readFileSync(join(ROOT, "examples", "meadow", "pocket.json")),
  );
  const parsed = JSON.parse(new TextDecoder().decode(manifest));
  const resolution = validateAndResolveBuildPlan(parsed, { target: "linux-app" });
  if (!resolution.ok) throw new Error("test manifest did not resolve for linux-app");
  return {
    manifest,
    plan: resolution.plan,
    // These markers stand in for a game's second minify and pak rewrite. The
    // package must contain these exact final bytes, not a recompiled neighbor.
    javascript: new TextEncoder().encode("globalThis.postProcessed = 'final';\n"),
    pak: Uint8Array.of(0x50, 0x41, 0x4b, 0xff),
    bytecode,
  };
}

test("native package adds target bytecode to the exact final JS and pak", async () => {
  const input = desktopInput(true);
  const calls: Uint8Array[] = [];
  const result = await packageNativeArtifacts(input, (target, javascript) => {
    calls.push(javascript.slice());
    const engineAbi = quickJsEngineAbiForTarget(target)!;
    const bytecode = Uint8Array.of(26, 0xaa, 0x55);
    return {
      engineAbi,
      bytecode,
      section: encodeBytecodeEnvelope({ engineAbi: engineAbi.sha256, bytecode }),
    };
  });

  expect(calls).toEqual([input.javascript]);
  expect(result.engineAbi).toBe(quickJsEngineAbiForTarget("linux-app"));
  const pkg = decodePocketPackage(result.bytes);
  const variant = pkg.variants[0]!;
  expect(findSection(variant, POCKET_SECTION.js)).toEqual(
    new Uint8Array([...input.javascript, 0]),
  );
  expect(findSection(variant, POCKET_SECTION.pak)).toEqual(input.pak);
  expect(
    decodeBytecodeEnvelope(findSection(variant, POCKET_SECTION.bytecode)!).engineAbi,
  ).toBe(result.engineAbi!.sha256);
});

test("source-only stays the default and a requested-but-missing section fails", async () => {
  const sourceOnly = desktopInput(false);
  const result = await packageNativeArtifacts(sourceOnly, () => {
    throw new Error("source-only packaging must not invoke qjsc");
  });
  const variant = decodePocketPackage(result.bytes).variants[0]!;
  expect(findSection(variant, POCKET_SECTION.bytecode)).toBeNull();

  // This is deliberately more discriminating than checking an option value:
  // a release path that forgets to carry --bytecode into its final package
  // fails verification on the artifact the host would actually boot.
  expect(() => assertNativePackageArtifacts(result.bytes, {
    ...sourceOnly,
    bytecode: true,
  })).toThrow("--bytecode requested but section 6 is missing");
});

test("native package refuses artifacts paired with a different manifest", async () => {
  const input = desktopInput(false);
  const manifest = JSON.parse(new TextDecoder().decode(input.manifest));
  manifest.title = "A different release";
  await expect(packageNativeArtifacts({
    ...input,
    manifest: new TextEncoder().encode(JSON.stringify(manifest)),
  })).rejects.toThrow("manifest does not resolve to the supplied plan");
});

test("package-native CLI makes bytecode opt-in explicit", () => {
  const common = [
    "--target", "psp",
    "--manifest", "pocket.json",
    "--plan", "plan.json",
    "--js", "final.js",
    "--pak", "final.pak",
    "-o", "game.pocket",
  ];
  expect(parsePackageNativeArgs(common).bytecode).toBe(false);
  expect(parsePackageNativeArgs([...common, "--bytecode"]).bytecode).toBe(true);
  expect(() => parsePackageNativeArgs([...common, "--bytecode", "--bytecode"]))
    .toThrow("duplicate --bytecode");
});

test("desktop CLI carries the explicit bytecode choice without leaking it to the host", () => {
  expect(parseDesktopCliArgs([
    "sunstone", "--bytecode", "--build-only", "--", "--quit-after", "9",
  ])).toEqual({
    name: "sunstone",
    buildOnly: true,
    bytecode: true,
    hostArgs: ["--quit-after", "9"],
  });
  expect(parseDesktopCliArgs(["meadow"]).bytecode).toBe(false);
});

test("desktop host switches from loose artifacts to the final package only", () => {
  const plan = desktopInput(false).plan;
  const loose = { plan, outdir: "/release", bin: "/host" };
  expect(desktopFlags(loose)).toContain("--js");
  expect(desktopFlags(loose)).toContain("--pak");
  expect(desktopFlags({ ...loose, pocket: "/release/meadow.pocket" })).toEqual([
    "--pocket", "/release/meadow.pocket",
  ]);
});

test("PSP bytecode ABI follows the linked lfkdsk QuickJS fork cumulatively", () => {
  expect(() => assertRpgkitPspEngineAbi()).not.toThrow();
  expect(PSP_QUICKJS_ENGINE_ABI.sha256).toBe(RPGKIT_PSP_ENGINE_ABI.sha256);

  const pspToml = readFileSync(join(ROOT, "vendor/pocketjs/hosts/psp/Cargo.toml"), "utf8");
  const pspLock = readFileSync(join(ROOT, "vendor/pocketjs/hosts/psp/Cargo.lock"), "utf8");
  const toolchain = JSON.parse(
    readFileSync(join(ROOT, "vendor/pocketjs/tools/cli/psp-toolchain.json"), "utf8"),
  ) as { quickJsRs: { repository: string; rev: string } };
  const dependency =
    `git = ${JSON.stringify(RPGKIT_PSP_ENGINE_ABI.repository)}, ` +
    `rev = ${JSON.stringify(RPGKIT_PSP_ENGINE_ABI.revision)}`;
  expect(pspToml).toContain(dependency);
  expect(pspLock).toContain(
    `${RPGKIT_PSP_ENGINE_ABI.repository}?rev=${RPGKIT_PSP_ENGINE_ABI.revision}`,
  );
  expect(toolchain.quickJsRs).toEqual({
    repository: RPGKIT_PSP_ENGINE_ABI.repository,
    rev: RPGKIT_PSP_ENGINE_ABI.revision,
  });

  const wrong = structuredClone(PSP_QUICKJS_ENGINE_ABI) as unknown as {
    -readonly [Key in keyof QuickJsEngineAbi]: QuickJsEngineAbi[Key]
  };
  wrong.descriptor = {
    ...wrong.descriptor,
    engine: {
      ...wrong.descriptor.engine,
      repository: "https://github.com/pocket-nexus/quickjs-rs.git",
      revision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
    },
  };
  expect(() => assertRpgkitPspEngineAbi(wrong)).toThrow("PSP QuickJS engine ABI drifted");
});
