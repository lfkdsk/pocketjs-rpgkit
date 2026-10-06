// Host audio is an explicit `pocket-rpgkit/ui/audio` entry. A game that only
// imports GameView keeps the WAV/QOA decoders, pak reader bridge and audio host
// SDK out of its dependency graph. Build all three apps before this test.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MEADOW_JS = join(ROOT, "dist", "meadow.js");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const AUDIO_JS = join(ROOT, "dist", "kau1-audio.js");

const preflight = existsSync(MEADOW_JS) && existsSync(SUNSTONE_JS) && existsSync(AUDIO_JS)
  ? { ok: true as const }
  : {
      ok: false as const,
      reason: "run `bun run build:example meadow sunstone kau1-audio` first",
    };
if (!preflight.ok) console.warn(`audio bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

// Meadow is the ordinary GameView-only control: it carries no audio, demo or
// battle code, only shared engine/UI growth (most recently 10,219 bytes from
// rebasing PocketJS onto upstream main). Sunstone opts into QOA music and the
// demo menu (chapter codes, tape suffixes, page hook); the small audio
// fixture opts into WAV playback. KV2's per-map actor pool adds shared
// GameView bytes to all three. The immutable-session port adds 26,029 bytes
// to the ordinary Meadow bundle and 31,070 bytes to the QOA/WAV entries:
// bounded state metadata, opt-in interpreter/session caches, retained actor
// frames, stable dialog/battle paint paths, and generic-scene merge guards.
// Choice-row icons add the optional icon schema entry, the reducer's icon
// column and the DialogBox opt-in hook (the icon box itself is opt-in):
// 1,952 bytes to Meadow, 4,364 to Sunstone and 2,825 to the WAV fixture.
// The list of compatible earlier schema identities (twelve SHA-256 literals
// and the membership check the session and save decoder share) adds 1,099
// bytes to Meadow and the WAV fixture and 1,202 to Sunstone. Narrowing that
// list to one identity and naming the accepted identities in the refusal
// message saves 314 bytes in Meadow and the WAV fixture and 180 in Sunstone.
// Applying same-tick place/moveRoute requests in command order (with the
// publish-time target page) adds 2,745 shared interpreter/session bytes to
// all three. Sunstone's opted-in demo menu adds lazy tape providers, a global
// timelineFrame and a once-per-provider shared tape cache (2,461 bytes);
// Meadow and the WAV fixture do not opt into the demo menu.
// Saves that keep the current map's characters, compressed save codes and
// GameView's overlay slot leave Meadow unchanged (it never decodes a save).
// Sunstone, whose demo chapters decode codes, gains 28,977 bytes: 24,285 for
// the inflate half of the DEFLATE codec, validating, snapshotting and
// restoring the character table and route-parked parallels, and the overlay
// slot, less its shorter chapter codes (measured together); then 1,970 for
// the joint character-motion checks, 39 for the overlay's attract-aware held
// mask, 1,869 for the save-code length and depth bounds and 814 for counting
// envelope text in UTF-8 bytes (Meadow and the WAV fixture never decode
// one). The WAV fixture gains the overlay slot's 1,411 and the held-mask 39:
// 1,450.
// PocketJS #508's opt-in model-trace guards and #512's retired console-bridge
// cleanup add 323 shared bytes to each bundle.
// Hiding an erased event's actor in GameView adds 148 bytes to Sunstone and
// the WAV fixture (Meadow does not mount GameView).
// The optional streamed tile loader (StreamedGameAssets.loadTile, used by the
// preview page's supplied sheets) adds 183 bytes to the streamed ground and
// upper layers in Sunstone and the WAV fixture; Meadow is unchanged.
// CJK-aware text layout (the line breaker, row flow and cached glyph
// measurer shared by the dialog, battle and save-menu boxes) adds 8,921 shared
// bytes to Sunstone and the WAV fixture and 8,983 to Meadow; merged with the
// demo change the three measure 514,512 (Meadow), 789,647 (Sunstone) and
// 652,604 (WAV fixture). Continuing long messages on further pages and
// wrapping list labels instead of cutting them (the page state in the
// reducer, the dialog paginator, row-window helpers) adds 1,489 bytes to
// Meadow, 3,357 to Sunstone and 2,926 to the WAV fixture.
// With the save changes, the tile loader and PocketJS #508/#512 merged in,
// the three measure 516,324 (Meadow), 822,635 (Sunstone) and 657,634 (WAV
// fixture).
// The additive world-layout schema keeps the immediately preceding schema
// identity compatible, adding one 64-byte hash literal (72 bundled bytes) to
// every engine consumer; world-layout validation remains out of these apps.
// The loop/break commands, the eventTouch trigger and the {v:} text token
// add shared interpreter/session bytes to every bundle: 718 for the token,
// 4,140 for compiling and running loop/break and scanning eventTouch pages
// (Sunstone 4,982: it also carries the save checks for the new
// instructions), and 2,887 for detecting bumps and refused steps.
// Replaceable interface words (engine/ui-text.ts: the shared English table
// and its merge/format helpers, 1,164-1,510 bytes; DialogBox's shop words,
// 669; GameView's legends, attract chrome and table hand-off, 1,402; the
// compatible schema identity, 72) add 1,905 bytes to Meadow and 3,653 to
// the WAV fixture; Sunstone's opted-in demo menu words and wrapping add
// 2,307 more (5,960). The long-translation wrapping (StatBar/name-input
// ladders, shop gold/legend wrap, demo error templates) adds 1,517 bytes
// to Meadow, 5,686 to Sunstone and 2,390 to the WAV fixture.
// The optional playerStep extension hook (a null check and two number
// reads per tick when unused) adds 1,218 shared bytes to each bundle. The
// attract controller GameView bundles gains the keyframe count cap,
// shared immutable keyframes, the reused rollback checkpoint and its
// success-path resync, plus the attractRewindOptions helper GameView
// forwards through: shared bytes in Sunstone and the WAV fixture (Meadow
// does not mount GameView); Sunstone's opted-in demo adds DemoOptions.rewind
// validation and the explicit four-field forwarding.
// The W3 cache fixes add the parsed-only compiled-layer rebuild in
// acquireSessionMap (shared engine code in all three), the staged-
// preparation trim in releaseSessionMapLayers, and the explicit
// blocked.failed flag plus the falsy-rejection normalizer in GameView
// (the two GameView bundles only).
// Reusing unchanged integer chunk windows adds 76 bytes to Meadow. The
// connected-world renderer is behind `pocket-rpgkit/ui/world`: its
// concrete modules are absent here, while GameView's generic factory seam
// adds about 4.6 KB to Sunstone and the WAV fixture. Merged, the three
// measure 525,365, 840,064 and 672,828.
// KRM2's additive event instructions, screen/timer state, compiler paths,
// save checks and schema identity add shared engine bytes. The generic
// GameView screen-presentation seam and host-action dispatcher add only to
// GameView apps. Numbered-picture/HUD JSX is isolated behind
// `pocket-rpgkit/ui/krm2` and is absent from all three bundles here (pinned
// separately by krm2-ui-bundle-isolation.test.ts). Together the measured
// sizes are 542,876, 871,523 and 691,900 bytes. Timer-aware immutable page
// and trigger-scan keys add 317 shared bytes to each bundle; keeping the demo
// warp toast inside the viewport and dismissing it before a modal then adds
// 173 bytes only to Sunstone: 543,193, 872,013 and 692,217 bytes.
// The W3 cache fixes and the world coordinate-contract promotion helper
// add shared GameView bytes, bringing main to 543,736, 873,965 and 694,169.
// Merging the interface-text branch (the uiText table, BoundedLine and the
// bounded SaveMenu/DialogBox/demo paths) adds the kit's replaceable words
// and the bounded-line machinery: the merged product measures 555,516,
// 898,897 and 708,561 bytes. Merging seamless-v1 (traversal identity,
// transfer provenance, sparse reducer state and the optional GameView
// resolver seam) brings them to 561,053, 905,748 and 714,453.
// KRM3V's additive reducer/save support and optional GameView seams bring the
// three input graphs to 569,421 (+8,368), 917,053 (+11,305) and 723,778
// (+9,325). Concrete parallax and item-icon components remain opt-in and are
// checked separately by krm3v-ui-bundle-isolation.test.ts.
// KRM3's label/selectItem/access/locationInfo/stopSe command handlers and the
// SoundCue union add shared interpreter code to all three: 578,931 (+9,510),
// 929,325 (+12,272) and 733,886 (+10,108). The select-item scene stays
// opt-in and is absent from every bundle. Deterministic seamless-handoff
// fatal cleanup (source-edge movement restore, abort guards before commit)
// adds 440 shared engine bytes to each graph. The KRM3 fix-2 engine changes
// (locationInfo resolves the live eventCells origin, the tile plane is a
// cell-index map, label-scope markers are rebuilt at restore) net to
// 579,262 (-109), 930,277 (+512) and 734,217 (-109). The KRM3 fix-3 label
// `ord` field adds its schema description text to the bundled schema,
// measuring 930,923 (+646) for sunstone only.
// KRM3 fix-4 makes the live character cell the single event-position source
// (a step-local LocalCells holder replaces the freshPlacements Set on
// InterpInput; eventOrigin no longer reads the durable placements record),
// hangs battle/scene completion transfers on the frame as `onDone` (the
// branch runs its original program, so a jumpLabel inside it preserves the
// transfer; cloneFiber/break/applyJumpLabel/save-validate carry it), and
// adds the onDone completion-transfer validator. These net to 579,656
// (-252), 932,110 (+1,187) and 734,611 (-252); sunstone additionally pulls
// in the shared save-validate path its graph already bundled. Merging the
// KRM3V/STUDIO4 follow-ups (Show Animation target:"this" through a common
// event, empty-parallax clear, mapAnim.follow save validation, per-tick
// anim prune) brings the merged product to 579,759 (+103), 932,941
// (+831) and 734,714 (+103).
// KRM3 fix-5 turns the frame's `onDone` into an ordered completion queue so
// a jump that leaves a battle/scene result branch (to a parent list, a
// sibling, or an outer scope) relocates the popped frames' completions to
// the landing frame, innermost first, and each fires exactly once; the save
// validator rejects a forged `fiber` key and any unknown completion field.
// These net to 580,367 (+608), 934,069 (+1,128) and 735,322 (+608);
// sunstone's larger delta is the save-validate strictness its graph already
// bundles. KRM3 fix-6 (collect every popped completion, innermost first;
// a transfer's map change discards the rest; exit/erase abort the event)
// brings them to 580,265 (-102), 933,967 (-102) and 735,220 (-102).
// The cold-path performance work (a session-scoped entry-page dependency
// cache, one-pass page selection keyed on the effective player sprite,
// stable extension condition keys and deferred seamless-transfer eviction)
// adds 6,971 shared engine bytes to each: 587,236, 940,938 and 742,191.
// The opt-in {x:} text tokens (the GameView/attract resolver wiring and the
// frozen ext snapshot built only when a token expands) add 2,319, 2,428 and
// 2,428 shared bytes: 589,555, 943,366 and 744,619. Without
// system.textTokens the expansion path never runs.
// PocketJS upstream #514 replaces sparse touch-recorder arrays with packed,
// releasable pages in the always-reachable DevTools wrapper. That shared host
// code adds 2,020 bytes to each bundle: 591,575, 945,386 and 746,639.
// The connected-world neighbour preview keeps its rules and painter behind
// pocket-rpgkit/ui/world. On top of the PocketJS bytes above, the base path
// gains: the session's left-map snapshot (frozen on a seamless commit,
// dropped by a per-tick ring check that is one untaken branch without it)
// in every bundle; GameView's share of the preview (npc-art helper,
// seamless-commit entry-frame fallback, preview source object) in sunstone
// and the WAV fixture; and the save path's left-map validation, clone and
// restore in sunstone, which links saves. Meadow +1,624, sunstone +4,988,
// WAV fixture +2,798: 593,199, 950,374 and 749,437.
// The autosave command's exact-tick snapshot/effect seam, in-flight player
// validation and narrow host bridge add 4,598 B to Meadow, 4,809 B to
// Sunstone and 5,183 B to the WAV fixture: 597,797, 955,183 and 754,620.
// Storage adapters remain host-side.
// The text command's optional layout (position/align/valign/background:
// shared box geometry, DialogBox placement, alignment, background and
// portrait-in-box scaling, the interpreter's sparse `box` and its page cuts
// in the visible modal identity, the saved instruction's box validation)
// adds 7,325 B to Meadow, 8,628 B to Sunstone and 7,531 B to the WAV
// fixture: 605,122, 963,811 and 762,151.
// The opt-in onInstruction execution trace (one optional dispatch in the
// interpreter run loop) adds 171 B to each bundle: 605,293, 963,982 and 762,322.
// Deferred autosaves add the sparse pending bit, first-resumable-tick check
// and coalesced effect dispatch: 1,714 B to Meadow and the WAV fixture and
// 2,358 B to Sunstone, whose save validator also accepts tagged live modals.
// The three now measure 607,007, 966,340 and 764,036 B; full save validation
// remains outside bundles that do not otherwise decode saves.
// The sandboxed neighbour preview stays behind pocket-rpgkit/ui/world;
// building a World in bounded steps (beginWorld/stepWorld) adds 1,697 B to
// each bundle, and GameView's seamless commit-frame preview handover adds
// 673 B to Sunstone and the WAV fixture: 608,704, 968,710 and 766,406.
// GameView tap-to-walk adds 94 B to Meadow and 7,270 B to Sunstone and the
// WAV fixture (the tap-to-walk module, pointer-line drain and per-frame
// route fold): 608,798, 975,980 and 773,676. The per-reference-tick route
// resolver (the session/attract hook that keeps a turn from overshooting at
// 4 Hz) adds 502 B to Meadow and 977 B to Sunstone and the WAV fixture:
// 609,300, 976,957 and 774,653. PocketJS's socket module adds its entry to
// the shared platform capability table, 192 B in each: 609,492, 977,149
// and 774,845. Re-measure after every shared-path change.
const EXPECTED_MEADOW_BYTES = 609_492;
const EXPECTED_SUNSTONE_QOA_BYTES = 977_149;
const EXPECTED_WAV_FIXTURE_BYTES = 774_845;

const HOST_AUDIO_NEEDLES = [
  "// src/ui/audio/driver.ts",
  "// src/ui/audio/qoa.ts",
  "function audioHost()",
  "audio: not a RIFF/WAVE file",
  "audio: not a QOA file",
];

describe("host WAV/QOA playback remains opt-in", () => {
  maybeTest("pins the no-audio, QOA and WAV bundle sizes", () => {
    expect(statSync(MEADOW_JS).size).toBe(EXPECTED_MEADOW_BYTES);
    expect(statSync(SUNSTONE_JS).size).toBe(EXPECTED_SUNSTONE_QOA_BYTES);
    expect(statSync(AUDIO_JS).size).toBe(EXPECTED_WAV_FIXTURE_BYTES);
  });

  maybeTest("keeps both decoders out of the no-audio bundle", () => {
    const ordinary = readFileSync(MEADOW_JS, "utf8");
    const qoa = readFileSync(SUNSTONE_JS, "utf8");
    const wav = readFileSync(AUDIO_JS, "utf8");
    for (const needle of HOST_AUDIO_NEEDLES) {
      expect(ordinary.includes(needle), `meadow.js contains ${JSON.stringify(needle)}`).toBe(false);
      expect(qoa.includes(needle), `sunstone.js lacks ${JSON.stringify(needle)}`).toBe(true);
      expect(wav.includes(needle), `kau1-audio.js lacks ${JSON.stringify(needle)}`).toBe(true);
    }
    expect(qoa.includes('"sunstone-theme": "audio:qoa.music/sunstone-theme"')).toBe(true);
    expect(wav.includes('tone: "audio:wav.tone"')).toBe(true);
  });
});
