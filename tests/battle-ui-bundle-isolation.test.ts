// tests/battle-ui-bundle-isolation.test.ts — KB4 (src/ui/battle) is an
// independent module: a game that never registers battle/battleScene must
// not pay for it. examples/sunstone never imports src/ui/battle (it only
// imports GameView.tsx directly, and never passes a `battle` prop),
// so tools/build.ts's pass-1 reachability walk (every RELATIVE import from
// the entry) excludes the whole module by construction. This test pins
// that: dist/sunstone.js's byte size is unchanged from a build with
// src/ui/battle/ removed from the checkout entirely (verified by hand
// while writing this test — see the exact size below), and none of KB4's
// distinctive identifiers/strings leak into the bundle text.
//
// Requires `bun run build:example sunstone` to have run first (same
// preflight every other *-sim.test.ts uses).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";

const ROOT = resolve(import.meta.dir, "..");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const MEADOW_JS = join(ROOT, "dist", "meadow.js");

const preflight = existsSync(SUNSTONE_JS) && existsSync(MEADOW_JS)
  ? { ok: true as const }
  : { ok: false as const, reason: "run `bun run build:example sunstone meadow`" };
if (!preflight.ok) console.warn(`battle-ui bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

// Recorded by building sunstone twice — once with src/ui/battle/ present,
// once with it moved out of the checkout — and diffing dist/sunstone.js:
// identical both times (tools/build-example.ts never mentions FIXTURES
// when resolving an EXAMPLES entry, so kb4-battle joining FIXTURES cannot
// affect it either). The number itself moves with GameView.tsx (shared by
// every game, battle or not): GameView now registers a "back" action while
// a scene is active, a few dozen bytes GameView.tsx costs every game
// equally, kb4-battle included or not. It also moved when battles and
// extensions started sharing the session's items and gold (the engine's
// shared write-back path); re-verified with src/ui/battle/ moved out: equal.
// PR #1's persistent text/choice/shop branches add 426 bytes to the shared
// DialogBox implementation; this is the measured post-build Sunstone bundle.
// KP1's opt-in startup phase marks are shared GameView/session code and remain
// inert unless a benchmark host installs the global hook; they do not add a
// dependency on the separately checked battle identifiers below.
// Bounded rewind keyframes add 6,488 bytes of shared AttractController code;
// the distinctive-identifier assertion still proves the opt-in battle UI is
// absent.
// The worldIdle condition adds 1,820 bytes of shared session/interpreter code;
// it remains independent of the opt-in battle UI identifiers checked below.
// KB6's keep-mounted world and battle scene reuse add 2,150 bytes of shared
// GameView code (display toggles, the active-accessor gates, the battle
// keep-alive latch); the opt-in battle UI identifiers below stay absent.
// Extension-driven choices and KV1's generic runtime appearance, named-layer
// and tile-property paths, KM1 runtime movement controls (with a separately
// compiled 12,980-byte legacy movement loop so projects without controls skip
// the controlled per-frame path), KA1's state-driven map animation layer and
// its interpreter support, the 525-byte optional native FS text read, and
// KS1's shared screen-effect/camera/balloon presentation path are shared
// GameView/session/interpreter code. KS1 adds 28,383 bytes to the previously
// measured 525,552-byte bundle. The opt-in onFiberStart fiber trace
// (rpgkit-check's explore coverage) adds 273 bytes of shared
// interpreter/session code: four optional call sites in the trigger scan
// plus the WorldOptions/SessionOptions threading. It is inert when no
// session installs it. KB6 fix 1's host-portable JSON clone fast path adds
// 2,257 bytes of shared engine code: it replaces per-property defineProperty calls with
// ordinary assignment while retaining the __proto__ data-key guard. The
// distinctive battle identifiers below remain absent. KAU1's deterministic
// audio state/commands and generic effects injection point are also shared;
// its separately imported WAV host adapter remains absent (pinned by
// audio-bundle-isolation.test.ts). Rebasing PocketJS onto upstream main adds
// 10,219 shared bytes: motion framework/contracts (4,634), MicroTS contract
// (2,191), devtools (2,163), frame dispatch (741), and clock/contract glue
// (490). The exact combined size is re-measured after every shared-path
// change.
// Sunstone's opt-in demo configuration, three chapter save codes and live
// page hook combine with KAU1's shared audio/effects state path. Demo and
// audio isolation are pinned separately; the identifiers below continue to
// prove that the Sunstone bundle does not pull in battle UI.
// KV2's per-map actor pool (grow-only slots, battle-gated map animation
// and balloon layers) adds 2,301 shared GameView bytes.
// SLIM-K adds 108 shared bytes (compact-map detection on the map read path);
// the lazy CLUT8 image cache stays in the opt-in pocket-rpgkit/ui/image entry.
// The PSP work ported from lfkdsk/pocketjs-tuxemon#1 adds 5,196 shared
// PocketJS framework bytes (bounded host image residency, deferred frame
// queue release, externally indexed pak support). Dropping the duplicate
// scene clone at the GameView boundary saves 87 shared baseline bytes.
// The immutable-session/cache port adds 31,070 bytes for bounded metadata,
// opt-in engine caches, retained actor frames, stable dialog/battle paint
// paths, and generic-scene merge guards. The identifiers below still prove
// that battle UI itself stays out of this non-battle bundle.
// Choice-row icons add 4,364 shared bytes: the optional `choices.options[].icon`
// schema entry, compiling/validating the icon column and comparing it in
// modalChanged (2,425 B), and the DialogBox opt-in hook plus GameView's icon
// resolver (1,939 B). The icon box itself stays in the opt-in
// pocket-rpgkit/ui/choice-icons entry (checked below).
// The compatible earlier schema identities (twelve SHA-256 literals and the
// membership check shared by createSession and the save decoder) add 1,202
// shared bytes; narrowing the list to one identity and naming the accepted
// identities in the refusal message saves 180 of them.
// Applying same-tick place/moveRoute requests in command order adds 2,745
// shared interpreter/session bytes. Sunstone's opted-in demo menu adds lazy
// tape providers, a global timelineFrame and a shared tape cache (2,461).
// Saves that keep the current map's characters, compressed chapter codes and
// GameView's overlay slot add 28,977 bytes: 24,285 for inflate, validating,
// snapshotting and restoring the character table and the overlay slot, less
// the shorter codes (measured together), then 1,970 for joint
// character-motion checks, 39 for the overlay's held mask under attract,
// 1,869 for save-code length and depth bounds and 814 for counting envelope
// text in UTF-8 bytes. PocketJS #508's opt-in model-trace guards and #512's
// retired console-bridge cleanup add another 323 shared bytes.
// Hiding an erased event's actor adds 148 shared GameView bytes.
// The optional streamed tile loader (StreamedGameAssets.loadTile) adds 183
// shared bytes to the streamed ground and upper layers.
// CJK-aware text layout (line breaker, row flow and cached glyph measurer for
// the dialog, battle and save-menu boxes) adds 8,921 shared bytes; merged
// with the demo change Sunstone measures 789,647. Continuing long messages
// on further pages and wrapping list labels instead of cutting them adds
// 3,357 shared bytes.
// With the save changes and the tile loader merged in, Sunstone measures
// 822,635.
// The additive world-layout schema contributes only its newly compatible
// 64-byte schema identity (72 bundled bytes); its validator stays excluded.
// The loop/break commands, the eventTouch trigger and the {v:} text token
// add 8,587 shared interpreter/session/save-check bytes: 718 for the token,
// 4,982 for loop/break and the eventTouch scan, 2,887 for contact detection.
// Replaceable interface words add 5,960 bytes: the shared table and
// helpers (engine/ui-text.ts, 1,510), DialogBox's shop words (669), GameView's
// legends, attract chrome and table hand-off (1,402), the compatible schema
// identity (72), and the opted-in demo menu's words and wrapping
// (ui/demo/text.ts 642, demo.tsx 1,665). The long-translation wrapping
// (StatBar/name-input ladders, shop gold/legend wrap, demo error templates)
// adds 5,686 more.
// The optional playerStep extension hook adds 1,218 shared bytes. The
// attract controller every GameView bundles gains the keyframe count
// cap, keyframes that keep immutable states by reference, the reused
// rollback checkpoint and its success-path resync, plus the
// attractRewindOptions helper; Sunstone's opted-in demo adds
// DemoOptions.rewind validation and the explicit four-field forwarding:
// 835,407 measured.
// The W3 cache fixes add the parsed-only compiled-layer rebuild, the
// staged-preparation trim and the explicit blocked.failed flag with the
// falsy-rejection normalizer.
// Reusing integer chunk windows and the generic opt-in connected-world
// factory seam bring it to 842,016 bytes. The concrete renderer remains
// absent, as verified by world-ui-bundle-isolation.test.ts.
// KRM2's shared commands/state/compiler/save paths plus GameView's small
// optional screen-presentation and host-action seams bring Sunstone to
// 871,523 bytes. Its numbered-picture, timer/banner and number-input JSX is
// still absent; krm2-ui-bundle-isolation.test.ts checks those identifiers.
// Timer-aware immutable page and trigger-scan keys add 317 shared bytes, and
// the demo warp-toast fixes add 173 bytes: 872,013 total.
// The W3 cache fixes and the coordinate-contract helper: 873,965 measured.
// Merging the interface-text branch (uiText words, BoundedLine, bounded
// SaveMenu/DialogBox/demo paths) brings the merged product to 898,897 bytes.
// The seamless-v1 traversal identity, transfer provenance, sparse reducer
// state and optional GameView resolver seam bring it to 905,748 measured. The
// concrete world handoff resolver remains outside this non-world input graph.
// KRM3V's additive parallax/animation reducer and save paths plus the small
// optional shop-icon and parallax GameView seams add 11,305 bytes, measuring
// 917,053. The concrete ParallaxLayer and ItemIconRow remain outside this
// input graph (krm3v-ui-bundle-isolation.test.ts).
// KRM3's label/jumpLabel, selectItem, menu/save access, locationInfo and
// stopSe command handlers plus the SoundCue union add 12,272 bytes of shared
// interpreter code, measuring 929,325. The select-item scene (engine rules
// and UI) stays opt-in: it is registered through the scenes/sceneViews props
// and is absent from this bundle. Deterministic seamless-handoff fatal
// cleanup adds 440 shared engine bytes, and the KRM3 fix-2 engine changes
// (live eventCells origin, cell-index tile map, label-scope rebuild) bring
// the merged product to 930,277. The KRM3 fix-3 label `ord` field adds its
// schema description text to the bundled schema (map-repository), measuring
// 930,923 (+646). The KRM3 fix-4 engine changes (single event-position
// source, frame-carried battle/scene completion transfers, onDone
// save-validate) bring the merged product to 932,110 (+1,187). Merging the
// KRM3V/STUDIO4 follow-ups brings it to 932,941 (+831). The KRM3 fix-5
// completion queue and strict onDone validation bring it to 934,069
// (+1,128), and the fix-6 completion rules to 933,967 (-102). The cold-path
// performance work (entry-page dependency cache, effective-sprite page keys,
// stable extension condition keys, deferred seamless eviction) brings it to
// 940,938 (+6,971). The opt-in {x:} text-token wiring brings it to
// 943,366 (+2,428). PocketJS upstream #514's packed, releasable touch-recorder
// pages add 2,020 shared DevTools bytes, bringing it to 945,386. GameView's
// share of the connected-world neighbour preview (npc-art helper,
// seamless-commit entry-frame fallback, preview source object), the
// session's left-map snapshot and its save validation, clone and restore
// bring it to 950,374 (+4,988); the preview itself stays opt-in.
// The autosave command adds its exact-tick snapshot/effect seam and
// in-flight player validation to the shared runtime path (+4,809 B); the
// storage adapters remain host-side. The text command's optional layout
// (box geometry, DialogBox placement, alignment, background and
// portrait-in-box scaling, the sparse `box`, its page cuts in the visible
// modal identity and its save validation) brings it to 963,811 (+8,628).
// The opt-in onInstruction execution trace (one optional dispatch in the
// interpreter run loop) adds 171 B: 963,982.
const EXPECTED_BYTES = 963_982;

describe("KB4 does not reach games that never opt into battle", () => {
  maybeTest("sunstone's built bundle size is pinned", () => {
    expect(statSync(SUNSTONE_JS).size).toBe(EXPECTED_BYTES);
  });

  maybeTest("sunstone's bundle text contains none of KB4's distinctive identifiers", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of [
      "shakeOffsetX",
      "frameIndexAt",
      "faintPose",
      "flashOpacity",
      "barFillWidth",
      "kb4-battle-scene",
      "CommandGrid",
      "TileTextureCache:",
      "pinned working set exceeds",
    ]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  maybeTest("sunstone's pak bakes no 10 px atlas: only CommandGrid's shrink stage uses text-2xs", () => {
    // The 10 px slot (19) is baked only into apps whose styles use it, and
    // only the battle command grid does; sunstone's atlases stay as they were.
    const keys = unpack(readFileSync(join(ROOT, "dist", "sunstone.pak"))).map((blob) => blob.key);
    expect(keys.filter((key) => key.startsWith("ui:font.")).length).toBeGreaterThan(0);
    expect(keys).not.toContain("ui:font.19");
    expect(readFileSync(SUNSTONE_JS, "utf8").includes("text-2xs")).toBe(false);
  });

  maybeTest("sunstone's bundle text contains none of the name-input scene's identifiers", () => {
    // The built-in name-input scene rides along only in games that import it;
    // sunstone never does, so its scene id, debug name and args stay absent.
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of [
      "rpgkit-name-input-scene",
      "rpgkit.nameInput",
      "NameInputScene",
      "swallowCancel",
    ]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  maybeTest("sunstone's bundle contains none of the choice icon box's identifiers", () => {
    // Games opt into the icon box through GameView's `choiceIcons` prop;
    // sunstone authors no icons and never imports it.
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of ["rpgkit-choices-icon-box", "cannot paint"]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  maybeTest("sunstone's bundle contains no editor proposal-review code", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of ["proposal-session.json", "proposal-review", "PROPOSALS ("]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains ${JSON.stringify(needle)}`).toBe(false);
    }
  });

  maybeTest("editor playtest and debugger code do not reach the game bundle", () => {
    const text = readFileSync(SUNSTONE_JS, "utf8");
    for (const needle of [
      "editor-playtest-root",
      "editor-playtest-debug-panel",
      "PLAYTEST STOPPED",
      "LIVE STATE  F",
      "Preview fallback: unregistered extension",
      "PLAYTEST_SHEET_REFS",
    ]) {
      expect(text.includes(needle), `sunstone.js unexpectedly contains editor-only ${JSON.stringify(needle)}`).toBe(false);
    }
  });
});
