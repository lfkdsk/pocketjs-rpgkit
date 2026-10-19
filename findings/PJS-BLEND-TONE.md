# Blend and tone primitives — final findings

## Delivery

The component work is based on `02e1a147a1c70fdd74db0bd535f1178304208960`.
The verified feature, test and documentation candidate is `fb0a2cda` on the
delivery branch `feat/blend-tone`; this findings-only commit follows that
candidate.

The PocketJS fork branch is `feat/blend-tone`, based on `af1b5251` and ending
at `4855f47b1761386bdeec688ff6562847dcc8e670`. The upstream-ready branch is
`feat/blend-tone-upstream`, based directly on upstream `main` at
`3d0983769f62ac75bacd62b723c15202425b2dd1`; its single atomic commit is
`a4b28679e0f97069894c6cd5a46ee967093ba975` (`feat(render): add blend and tone
primitives`). It excludes the fork-only `spriteClock` ABI and applies cleanly
as one self-contained upstream change. Nothing was pushed.

The first run used the pioneer channel and ended after 55 minutes and 240
steps when the service returned `code 1001: command stream closed before end
event`. Its commits were retained, rebased and completed in the Trae default
channel.

## Implemented behavior

PocketJS now has appended image properties for RPG Maker blend modes 0–3 and
signed RGB plus gray tone, with `TEX_QUAD_EFFECT`, `TEX_TRI_EFFECT` and
`TONE_RECT` draw operations. The fork retains its existing `spriteClock=144`,
so effects occupy property ids 145–149 there. The upstream-ready patch, whose
parent has no `spriteClock`, appends effects at ids 144–148. Both use draw-op
ids 11–13. Contract generation remained synchronized and existing ids were
not renumbered.

The software rasterizer keeps source alpha and tone products rational until
the final framebuffer write. Tone follows MZ `ColorFilter`: HSL lightness is
`(min + max) / 2`, gray scales saturation, signed tone is applied in the
premultiplied order, and each output channel is clamped once. Blend follows
Pixi's premultiplied factors for normal, add, multiply and screen. The exact
path covers RGBA, ARGB, premultiplied RGBA and RGB565 targets, axis-aligned and
transformed images, clipping, opacity and all texture sampling paths. Images
with no effects keep the legacy opcodes and fast raster path byte-for-byte.

The component library adopts the primitives in three places:

- Pictures project evaluated blend and tone onto the image node, including
  rotated images. Fixed draw backends retain normal blend plus the stable tone
  overlay fallback.
- Screen tone is one childless destination-tone node below weather, numbered
  pictures and windows. Reducer state, fixed-clock interpolation, save/load,
  rewind and 60/30/20 Hz semantics are unchanged. Fixed draw backends retain
  the prior ordered gray/darken/brighten fallback.
- Window tone filters opaque chrome with destination tone. Translucent chrome
  and fixed backends transform the flat source palette with the same exact
  gray-before-RGB equation, preserving alpha and leaving text untouched.
  Stock MV/MZ window input uses RGB and gray zero; four-channel hand-authored
  input enables the kit's documented gray extension.

## Backend result

| Backend | Image blend/tone | Destination tone |
| --- | --- | --- |
| Core software / WASM / PocketBook | exact | exact |
| RGB565 ordered fallback | exact | exact |
| wgpu, GLES2 C ABI, PSP, Vita, 3DS | consumes opcode, ordinary-image fallback | consumes opcode, no-op |
| legacy gpui | consumes opcode, ordinary-image fallback | consumes opcode, no-op |

The fixed GPU/console walkers do not expose a destination-read primitive, so
claiming exact GPU parity would be false. The component capability check keeps
their source-color fallbacks. A final static audit found that gpui initially
sent transformed effect triangles through a transparent scratch surface,
which made destination-dependent modes observe scratch black. The final patch
demotes every 17-word `TEX_TRI_EFFECT` to its 12-word legacy `TEX_TRI` before
scratch rasterization. Its focused unit test passed, and the reviewer returned
PASS on the corrected path.

## Pixel and differential verification

PocketJS core contains two independent 384-vector differential tests:

- image effects randomize source/destination color and alpha, opacity,
  modulation, mode, signed tone, gray, geometry and clipping, then compare
  RGBA, ARGB, premultiplied and RGB565 results with a scalar formula oracle;
- destination tone randomizes destination color and alpha, signed tone, gray,
  rectangle and scissor, then checks the same four target families.

Separate random streams cover the legacy no-effect fast path across texture
formats and scales. Explicit identity-effect tests compare the appended opcode
with the legacy opcode. Transformed-image tests pin triangle emission and exact
pixels. Representative component pixels at both 480×272 and 960×544 are:

| Operation | Expected RGBA |
| --- | --- |
| add | `[180, 120, 60, 255]` |
| multiply | `[28, 13, 3, 255]` |
| screen | `[152, 107, 57, 255]` |
| signed RGB plus full gray tone | `[100, 50, 180, 255]` |

The KRM5 visual oracle independently computes destination and window tone,
asserts the screen-tone node count and layer order, checks nonzero window gray,
and confirms battle windows remain unfiltered above the toned scene.

## Visual review

Maintained goldens cover KRM2 picture effects and KRM5 map, battle, window and
formation presentation at 480×272 and 960×544. All eight affected frames were
also enlarged to 3× and opened for manual inspection. Picture transforms and
window borders stayed crisp, tone covered the intended world/battle pixels,
window gray remained visible, and dialog text stayed legible. The semantic
pixel assertions above prevent a visually plausible but mathematically wrong
golden from passing.

## Mutation evidence

Five isolated mutations were run outside the candidate worktree; every one
failed its intended test:

1. multiply replaced by screen: expected `[28, 13, 3, 255]`, received
   `[152, 107, 57, 255]`;
2. signed tone offset reversed: expected `[188, 0, 0, 255]`, received
   `[0, 0, 0, 255]`;
3. legacy nearest sampling shifted one source column: the randomized
   no-effect oracle failed at instruction 16;
4. gray lightness changed from `min + max` to `2 * min`: expected
   `[191, 64, 64, 255]`, received `[127, 0, 0, 255]`;
5. transformed-image effect dispatch disabled: the draw test observed four
   legacy triangles where it required zero.

Each selected mutation run reported 0 passed and 1 failed.

## Build and test gates

The final PocketJS fork gates passed: contract generation all green; core
215/215; RGB565 21 unit plus 7 integration tests; wgpu 3/3; UI C ABI/GL 18/18;
gpui check; and the focused gpui transformed fallback test 1/1. The
upstream-ready branch independently passed the same gates against upstream
`main`, with 202/202 core tests and the same backend counts.

The component release rebuild started from an empty `dist/`:

- `bun run build:wasm`: exit 0, `pocketjs.wasm` 455,380 bytes;
- `bun run build:example`: exit 0 for every example, editor, fixture and
  preview density;
- `bunx tsc --noEmit`: exit 0;
- final focused gate after history cleanup: 146 passed, 0 failed, 0 skipped
  across the blend/tone visual, bundle, importer, schema and Sunstone suites;
- complete Bun suite, split into three 103-file shards to stay below the
  execution host's absolute command limit: 1,849 + 1,280 + 1,591 = **4,720
  passed, 0 failed, 0 skipped across all 309 files**.

The component schema and identity chain did not change. Import output remained
byte-stable across two runs. The generated command table stayed synchronized
with the Tint Screen coverage wording.

## Bundle and QuickJS guards

Bundle isolation remained intact: Meadow and Sunstone contain none of the
opt-in RPG Maker implementation needles, while the opted-in fixture contains
all eleven. Rebuilt byte pins are Meadow 688,044, Sunstone 1,114,375,
`rmi-play` 1,351,047 and `kau1-audio` 876,741. The measured shared presentation
plumbing deltas are documented beside the pins; no optional battle, audio,
editor or importer implementation became reachable.

The fixed-history QuickJS guard ran six interleaved rounds on CPU 31. All eight
single-change and all eight cumulative cases passed the 3% bound:

| Single-change case | Median change |
| --- | ---: |
| sunstoneIdle | +0.174971% |
| sunstoneWalk | -0.042415% |
| sunstoneControlWalk | +0.364241% |
| streamedRoam | -0.351137% |
| battleScene | +0.082204% |
| sunstoneIdleImmutable | +0.007439% |
| sunstoneControlWalkImmutable | +0.296681% |
| battleSceneImmutable | +0.078889% |

The final line was `verdict=pass regressions=0 inconclusive=0 errors=0`. The
guard predates history cleanup; the final component delta from that measured
tree is documentation/comments plus the submodule update. The submodule delta
is `docs/BACKENDS.md` and the gpui-only fallback fix, so the QuickJS core and
guest inputs are unchanged.

## Remaining limits

- Fixed GPU/console backends parse but do not execute effect pixels; the
  documented component fallbacks remain required.
- Battle target-local flash still uses its prior source-over projection rather
  than an alpha-masked target filter.
- Stock MV/MZ ignores window gray. The fourth window channel is a deliberate
  kit extension for compatible hand-authored data, not a stock-compatibility
  claim.

Subagent use: 4 / upstream formula and layer semantics, component integration,
acceptance-test gaps, and final PocketJS static audit / parallel review exposed
the gpui blocker and shortened the verification cycle.

PASS
