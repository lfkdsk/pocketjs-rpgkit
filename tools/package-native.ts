#!/usr/bin/env bun
// Package already-final JS/pak bytes for a native PocketJS host.  This tool
// never compiles the app: game/Wander release scripts call it only after all
// bundle and pak post-processing is complete.
//
//   bun tools/package-native.ts --target psp --manifest pocket.json \
//     --plan .pocket/psp/game.plan.json --js dist/psp/game.js \
//     --pak dist/psp/game.pak --bytecode -o dist/psp/game.pocket

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResolvedBuildPlan } from "../vendor/pocketjs/framework/src/manifest/plan.ts";
import { packageNativeArtifacts } from "./lib/native-package.ts";

const USAGE =
  "usage: bun tools/package-native.ts --target <psp|macos-app|linux-app> " +
  "--manifest <pocket.json> --plan <plan.json> --js <final.js> " +
  "--pak <final.pak> [--bytecode] -o <app.pocket>";

export interface PackageNativeArgs {
  readonly target: string;
  readonly manifest: string;
  readonly plan: string;
  readonly javascript: string;
  readonly pak: string;
  readonly output: string;
  readonly bytecode: boolean;
}

export function parsePackageNativeArgs(argv: readonly string[]): PackageNativeArgs {
  const args = [...argv];
  const options = new Map<string, string>();
  let bytecode = false;
  while (args.length > 0) {
    const argument = args.shift()!;
    if (argument === "--bytecode") {
      if (bytecode) throw new Error(`${USAGE}\nduplicate --bytecode`);
      bytecode = true;
      continue;
    }
    const name = argument === "-o"
      ? "output"
      : argument.startsWith("--")
        ? argument.slice(2)
        : "";
    const value = args.shift();
    if (!name || !value || value.startsWith("--")) throw new Error(USAGE);
    if (options.has(name)) throw new Error(`${USAGE}\nduplicate --${name}`);
    options.set(name, value);
  }
  const allowed = new Set(["target", "manifest", "plan", "js", "pak", "output"]);
  const unknown = [...options.keys()].filter((name) => !allowed.has(name));
  const missing = [...allowed].filter((name) => !options.has(name));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${USAGE}\n${[
        ...missing.map((name) => `missing --${name}`),
        ...unknown.map((name) => `unknown --${name}`),
      ].join(", ")}`,
    );
  }
  const target = options.get("target")!;
  if (!new Set(["psp", "macos-app", "linux-app"]).has(target)) {
    throw new Error(`${USAGE}\nunsupported native target ${target}`);
  }
  return {
    target,
    manifest: resolve(options.get("manifest")!),
    plan: resolve(options.get("plan")!),
    javascript: resolve(options.get("js")!),
    pak: resolve(options.get("pak")!),
    output: resolve(options.get("output")!),
    bytecode,
  };
}

export async function packageNativeMain(argv: readonly string[]): Promise<string> {
  const args = parsePackageNativeArgs(argv);
  const plan = JSON.parse(readFileSync(args.plan, "utf8")) as ResolvedBuildPlan;
  if (plan.target.id !== args.target) {
    throw new Error(
      `package-native: --target ${args.target} differs from plan target ${plan.target.id}`,
    );
  }
  const result = await packageNativeArtifacts({
    manifest: new Uint8Array(readFileSync(args.manifest)),
    plan,
    javascript: new Uint8Array(readFileSync(args.javascript)),
    pak: new Uint8Array(readFileSync(args.pak)),
    bytecode: args.bytecode,
    bytecodeBuildDirectory: resolve(dirname(args.output), ".quickjs-bytecode"),
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, result.bytes);
  const mode = result.engineAbi
    ? `source + bytecode ${result.engineAbi.sha256}`
    : "source only";
  console.log(`package-native: ${args.output} (${result.bytes.length}B, ${mode})`);
  return args.output;
}

if (import.meta.main) {
  try {
    await packageNativeMain(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
