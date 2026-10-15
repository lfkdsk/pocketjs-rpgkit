// Assemble a source-preserving .pocket from artifacts that have already gone
// through an application's final build/post-processing pipeline.  This is the
// boundary used by desktop and PSP release scripts: neither target is allowed
// to ask PocketJS to compile the manifest again and accidentally package bytes
// from before a game's second minify, pak rewrite, or release transform.

import {
  POCKET_SECTION,
  decodeBytecodeEnvelope,
  decodePocketPackage,
  encodePocketPackage,
  encodeIdentity,
  findSection,
  type PocketPackageSection,
  type PocketPackageVariant,
} from "../../vendor/pocketjs/contracts/spec/pocket-package.ts";
import {
  PSP_QUICKJS_ENGINE_ABI,
  quickJsEngineAbiForTarget,
  type QuickJsEngineAbi,
} from "../../vendor/pocketjs/contracts/spec/quickjs-bytecode.ts";
import {
  canonicalJson,
  verifyPlanHash,
  type ResolvedBuildPlan,
} from "../../vendor/pocketjs/framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/resolve.ts";

/** The PSP engine actually linked by PocketJS's host.  Keep the digest here,
 * as well as in PocketJS, so a submodule update cannot silently make RPG Kit
 * release packages target a different bytecode ABI. */
export const RPGKIT_PSP_ENGINE_ABI = {
  schema: "pocketjs.quickjs-engine-abi/v1",
  binding: "lfkdsk/quickjs-rs:libquickjs-sys",
  bindingVersion: "0.9.0",
  repository: "https://github.com/lfkdsk/quickjs-rs.git",
  revision: "2af09e8f18b0b810a7f1b0699762c0f08bcc0f85",
  engineVersion: "2026-06-04",
  bytecodeVersion: 5,
  sha256: "sha256:58b9adf09c223efd9a84bffb4637312075ebb0ed1729b7d352282a01f7e8b73d",
} as const;

export interface NativePackageInput {
  /** Verbatim pocket.json bytes. */
  readonly manifest: Uint8Array;
  /** The exact plan used to produce javascript and pak. */
  readonly plan: ResolvedBuildPlan;
  /** Final, post-processed bundle bytes (without the package NUL terminator). */
  readonly javascript: Uint8Array;
  /** Final, post-processed pak bytes. */
  readonly pak: Uint8Array;
  /** Required on purpose: every caller chooses source-only or bytecode. */
  readonly bytecode: boolean;
  /** Compiler cache/products; the source checkout remains PocketJS-managed. */
  readonly bytecodeBuildDirectory?: string;
}

export interface NativePackageResult {
  readonly bytes: Uint8Array;
  readonly engineAbi?: QuickJsEngineAbi;
}

export interface CompiledNativeBytecode {
  readonly engineAbi: QuickJsEngineAbi;
  readonly bytecode: Uint8Array;
  readonly section: Uint8Array;
}

export type NativeBytecodeCompiler = (
  target: string,
  javascript: Uint8Array,
  options: { readonly buildDirectory?: string },
) => CompiledNativeBytecode | Promise<CompiledNativeBytecode>;

/** Fail closed when PocketJS's declared PSP ABI no longer describes the host
 * dependency RPG Kit releases.  In particular, ba5bdd0 is the Vita/stock
 * QuickJS pin; PSP carries lfkdsk's generational-GC fork at 2af09e8f. */
export function assertRpgkitPspEngineAbi(
  abi: QuickJsEngineAbi = PSP_QUICKJS_ENGINE_ABI,
): void {
  const expected = RPGKIT_PSP_ENGINE_ABI;
  const descriptor = abi.descriptor;
  const facts = {
    schema: descriptor.schema,
    binding: descriptor.binding.name,
    bindingVersion: descriptor.binding.version,
    bindingRevision: descriptor.binding.revision,
    repository: descriptor.engine.repository,
    revision: descriptor.engine.revision,
    engineVersion: descriptor.engine.version,
    bytecodeVersion: descriptor.engine.bytecodeVersion,
    sha256: abi.sha256,
  };
  const drift =
    facts.schema !== expected.schema ||
    facts.binding !== expected.binding ||
    facts.bindingVersion !== expected.bindingVersion ||
    facts.bindingRevision !== expected.revision ||
    facts.repository !== expected.repository ||
    facts.revision !== expected.revision ||
    facts.engineVersion !== expected.engineVersion ||
    facts.bytecodeVersion !== expected.bytecodeVersion ||
    facts.sha256 !== expected.sha256;
  if (drift) {
    throw new Error(
      "native-package: PSP QuickJS engine ABI drifted; " +
        `expected ${expected.repository}@${expected.revision} ${expected.sha256}, ` +
        `got ${facts.repository}@${facts.revision} ${facts.sha256}`,
    );
  }
}

/** Assemble one target variant from final artifacts.  Source is always kept;
 * bytecode is an explicit, target-matched section 6 addition. */
export async function packageNativeArtifacts(
  input: NativePackageInput,
  compileBytecode: NativeBytecodeCompiler = loadAndCompileQuickJsBytecode,
): Promise<NativePackageResult> {
  const { plan } = input;
  if (!verifyPlanHash(plan)) {
    throw new Error("native-package: resolved build plan hash is invalid");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(input.manifest));
  } catch {
    throw new Error("native-package: manifest is not JSON");
  }
  const resolution = validateAndResolveBuildPlan(manifest, { target: plan.target.id });
  if (!resolution.ok || canonicalJson(resolution.plan) !== canonicalJson(plan)) {
    throw new Error("native-package: manifest does not resolve to the supplied plan");
  }
  if (input.javascript.at(-1) === 0) {
    throw new Error("native-package: javascript already has a NUL terminator");
  }

  let compiled: CompiledNativeBytecode | undefined;
  if (input.bytecode) {
    const engineAbi = quickJsEngineAbiForTarget(plan.target.id);
    if (!engineAbi) {
      throw new Error(`native-package: ${plan.target.id} has no QuickJS bytecode ABI`);
    }
    if (plan.target.id === "psp") assertRpgkitPspEngineAbi(engineAbi);
    compiled = await compileBytecode(plan.target.id, input.javascript, {
      ...(input.bytecodeBuildDirectory
        ? { buildDirectory: input.bytecodeBuildDirectory }
        : {}),
    });
    if (compiled.engineAbi.sha256 !== engineAbi.sha256) {
      throw new Error(`native-package: compiler ABI does not match ${plan.target.id}`);
    }
  }

  const planJson = canonicalJson(plan);
  const js = new Uint8Array(input.javascript.length + 1);
  js.set(input.javascript);
  const sections: PocketPackageSection[] = [
    {
      kind: POCKET_SECTION.identity,
      bytes: encodeIdentity({
        output: plan.app.output,
        id: plan.app.id,
        title: plan.app.title,
      }),
    },
    { kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode(planJson) },
    { kind: POCKET_SECTION.js, bytes: js },
    { kind: POCKET_SECTION.pak, bytes: input.pak },
  ];
  if (compiled) {
    decodeBytecodeEnvelope(compiled.section);
    sections.push({ kind: POCKET_SECTION.bytecode, bytes: compiled.section });
  }
  const variant: PocketPackageVariant = {
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    sections,
  };
  const bytes = encodePocketPackage({
    manifest: input.manifest,
    variants: [variant],
  });
  assertNativePackageArtifacts(bytes, input);
  return { bytes, engineAbi: compiled?.engineAbi };
}

/** Keep PocketJS's compiler tool outside RPG Kit's TypeScript program: that
 * tool owns host/toolchain modules resolved relative to the PocketJS checkout.
 * The non-literal dynamic import preserves those runtime semantics without
 * making RPG Kit typecheck PocketJS's excluded `tools/` tree. */
async function loadAndCompileQuickJsBytecode(
  target: string,
  javascript: Uint8Array,
  options: { readonly buildDirectory?: string },
): Promise<CompiledNativeBytecode> {
  const moduleUrl = new URL(
    "../../vendor/pocketjs/tools/quickjs-bytecode.ts",
    import.meta.url,
  ).href;
  const module = await import(moduleUrl) as {
    compileQuickJsBytecode: NativeBytecodeCompiler;
  };
  return module.compileQuickJsBytecode(target, javascript, options);
}

/** Verify the release artifact itself, not an adjacent loose build. */
export function assertNativePackageArtifacts(
  bytes: Uint8Array,
  input: NativePackageInput,
): void {
  const pkg = decodePocketPackage(bytes);
  if (pkg.variants.length !== 1) {
    throw new Error("native-package: expected exactly one target variant");
  }
  if (!equalBytes(pkg.manifest, input.manifest)) {
    throw new Error("native-package: embedded manifest differs from the release input");
  }
  const variant = pkg.variants[0]!;
  if (
    variant.target !== input.plan.target.id ||
    variant.hostAbi !== input.plan.target.hostAbi
  ) {
    throw new Error("native-package: package target differs from the release plan");
  }
  const js = findSection(variant, POCKET_SECTION.js);
  if (
    !js ||
    js.length !== input.javascript.length + 1 ||
    js[js.length - 1] !== 0 ||
    !equalBytes(js.subarray(0, -1), input.javascript)
  ) {
    throw new Error("native-package: embedded source differs from the final bundle");
  }
  const pak = findSection(variant, POCKET_SECTION.pak);
  if (!pak || !equalBytes(pak, input.pak)) {
    throw new Error("native-package: embedded pak differs from the final pak");
  }
  const plan = findSection(variant, POCKET_SECTION.plan);
  if (
    !plan ||
    new TextDecoder().decode(plan) !== canonicalJson(input.plan)
  ) {
    throw new Error("native-package: embedded plan differs from the release plan");
  }
  const section = findSection(variant, POCKET_SECTION.bytecode);
  if (input.bytecode && !section) {
    throw new Error("native-package: --bytecode requested but section 6 is missing");
  }
  if (!input.bytecode && section) {
    throw new Error("native-package: source-only build unexpectedly carries bytecode");
  }
  if (section) {
    const abi = quickJsEngineAbiForTarget(variant.target);
    const envelope = decodeBytecodeEnvelope(section);
    if (!abi || envelope.engineAbi !== abi.sha256) {
      throw new Error("native-package: bytecode engine ABI differs from its target");
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
