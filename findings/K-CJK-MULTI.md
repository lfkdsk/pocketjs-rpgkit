# Regional CJK text support

## Delivery

- Proposed release branch: `feat/cjk-multi`
- Change base: `0ecb045ddf9a124284e0127c11c623c966078f84`
- Implementation HEAD before this report-only commit: `78e9670d8b113fc2a984318ec2f2fa4e265ec495`
- PocketJS dependency: `7c9d1a10f8f232a639846c0b3c950a17f39921e5`
- Schema: unchanged. `src/data/schema.json` is SHA-256
  `833a3b709299705dbcb650b37cdd33d3c399da4d28908914b4f310bad234f6b5`
  at both the change base and the candidate; no schema-identity link was
  added.

## Result

Pocket RPG Kit now builds language apps with `sc`, `tc`, `jp`, or `kr`
regional Noto Sans CJK outlines. Each language app gets a subset containing
only the decoded strings that app can display. The existing no-option path is
still SC and retains its original filenames, generated metadata, subset, and
pak bytes.

The selected face is a build/language-shard property. A language selector
chooses and mounts one complete bundle before the UI appears, so equal Han
code points resolve through that bundle's regional face and only one regional
atlas is resident. Listing several regional faces in one fallback chain is
deliberately unsupported because the first face maps the same Han code points
and would mask the others. Studio remains a budgeted SC preview and is not a
TC/JP regional-outline oracle.

The existing shared line breaker now includes Japanese small kana,
prolonged-sound and iteration marks, combining sound marks, wave dash,
halfwidth punctuation, compound question/exclamation marks, and paired
brackets in its kinsoku tables. Traditional Chinese continues through the
same Chinese rules. Mixed fitting Latin words and number tokens stay whole.
Typewriter reveal remains Unicode-code-point based; a decomposed kana plus
combining mark takes two reveal steps, while the mark cannot begin a wrapped
row.

## Pinned inputs and generated files

All source faces come from immutable noto-cjk revision
`f8d157532fbfaeda587e826d4cd5b21a49186f7c` and are checked by both byte
length and SHA-256 before entering the cache:

| Face | Source bytes | SHA-256 |
| --- | ---: | --- |
| SC | 16,437,364 | `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` |
| TC | 16,435,884 | `dce08bd4fd91aa8aa76ed8fea4b694c2dfb8550f67871e326843212ddbeb88b4` |
| JP | 16,467,736 | `68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5` |
| KR | 16,433,112 | `6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a` |

`tools/cjk-font.ts` accepts `--variant=sc|tc|jp|kr`; an invalid value exits
2. Generation and `--check` agree on the selected filename, font family,
charset, provenance, source digest, OFL notice, and
`license:NotoSansCJK.txt` pak row. Runtime-built text that static inventory
cannot see remains explicit through `--scan` or `--chars`. A missing baked
glyph keeps the existing box-glyph behavior, while `--check` reports its code
point and fails.

The OFL notice is included with both committed regional subsets and remains
discoverable by the existing pak, web, desktop, and package license paths.
Only the small JP/TC subsets and notices are committed; no complete upstream
font is stored in the repository.

## SC compatibility

The legacy SC fixture is pinned at all layers:

| Artifact | SHA-256 |
| --- | --- |
| subset OTF | `92da6341be4d84473e9bbd13c8d2eb1c94b32dd30c6547f048f3c9168dda70e8` |
| charset | `e0f88a185dd59090942c48cf3c13c33c3f36ca12b59542f47696ccba7b86cbb9` |
| `fonts.json` | `3175f6980d75770e083e3c64b134cc5c16359d5ee82f6405678e6d0656e7a538` |
| `pak.json` | `27db709343804904b1ccd177dd6a715011d83e4f30b3b9b4969b1c3599f34419` |
| density-1 pak | `f04a87d82c742de6b58835f4132f93973db8005d8e787cbda6b2580be5c73308` |
| density-2 pak | `b8b5dd2b07bd51ac275de2a2fbe807bf8db2bba9a46df69679cdbfd394081419` |
| density-3 pak | `2f84a7245a784f544c3e755c19bfdb433306eb35228b8b993a7013b1e0aad225` |

The shared Japanese kinsoku codepoint table adds 216 bytes to ordinary JS
graphs. Exact bundle pins were updated for Meadow, Sunstone, the WAV fixture,
and the RPG Maker positive fixture; their optional-module reachability checks
still pass. Undeclared SC font configuration, font subset, atlas/pak data, and
runtime behavior for text without the added Japanese characters are unchanged.

## Memory and PSP residency

Measured committed builds use the following language-local costs. PSP
residency counts the pak-embedded atlas and the parsed core copy. The 256 KiB
glyph-page cache is one shared runtime cache, not one cache per face.

| Face / example | Characters | Subset OTF | Density-1 atlas increase | PSP resident increase |
| --- | ---: | ---: | ---: | ---: |
| SC / `cjk-text` | 196 | 49,400 B | about 148 KiB | about 297 KiB |
| JP / `cjk-multi-jp` | 114 | 26,672 B | about 141 KiB | about 281 KiB |
| TC / `cjk-multi-tc` | 121 | 36,772 B | about 149 KiB | about 299 KiB |

Only the selected language bundle is mounted. An app without CJK text emits
no CJK font configuration or atlas.

## Example and visual evidence

`examples/cjk-multi/` contains Japanese and Traditional Chinese shards over
one gallery. Each language renders dialog, choices, shop, battle menu, and
save menu at 480x272 and 960x544, for 20 committed golden PNGs.

The simulator verifies all displayed strings, absence of replacement
characters, complete framebuffer equality, and complete font-atlas equality
against a direct bake from the selected subset. Four shared Han probes
(`骨令返曜`) have pinned cell hashes at both densities and must differ between
JP and TC. This distinguishes the regional outlines rather than merely
checking cmap coverage. All four JP/TC by 480/960 contact sheets were opened
at 3x scale; text, selection states, panels, and both raster densities were
visually coherent.

## Mutation strength

All mutations ran in an isolated checkout and were removed afterwards:

| Mutation | Expected detector | Result |
| --- | --- | --- |
| Regenerate JP with the SC face | regional atlas/golden assertions | killed: 5 pass, 4 fail; framebuffer and direct-atlas comparisons failed |
| Remove U+301C from Japanese no-line-start | independent kinsoku oracle and exact layout | killed: 19 pass, 2 fail; missing membership and illegal `〜` row start both failed |
| Add one newline to undeclared SC `fonts.json` | exact legacy digest | killed: expected `3175f698…`, received `d99d…` |
| Remove the JP OFL pak row | regional license check | killed: `pak.json does not ship the license` |

## Component gates

The final run started from an empty `dist/` and used the rebuilt PocketJS
wasm.

| Command | Result |
| --- | --- |
| `bun run build:wasm` | exit 0 |
| `bun run build:example` | exit 0; all density-1/2/3 examples built |
| `bunx tsc --noEmit` | exit 0 |
| `bun run test` | 4,645 pass, 0 fail, 0 skip across 305 files; 732,249 assertions; exit 0 |

The QuickJS guard used six counterbalanced windows for both the change base
and the configured historical baseline. Positive values are regressions;
the limit is +3%.

| Workload | Single-parent median | Single 95% CI | Cumulative median | Cumulative 95% CI |
| --- | ---: | ---: | ---: | ---: |
| `sunstoneIdle` | +0.16% | [-0.48%, +1.17%] | -1.84% | [-1.96%, -1.78%] |
| `sunstoneWalk` | -0.16% | [-0.33%, +0.01%] | -2.41% | [-2.84%, -1.76%] |
| `sunstoneControlWalk` | +0.38% | [+0.10%, +0.43%] | -2.11% | [-2.33%, -2.04%] |
| `streamedRoam` | -0.07% | [-1.12%, +1.08%] | -0.93% | [-1.47%, -0.84%] |
| `battleScene` | -0.00% | [-0.22%, +0.18%] | -0.73% | [-2.03%, -0.60%] |
| `sunstoneIdleImmutable` | -0.09% | [-0.49%, +0.12%] | -2.25% | [-2.63%, -2.09%] |
| `sunstoneControlWalkImmutable` | +0.30% | [-0.05%, +1.06%] | -1.51% | [-2.19%, -0.72%] |
| `battleSceneImmutable` | -0.28% | [-0.54%, +0.01%] | -4.64% | [-4.99%, -4.50%] |

Final guard result: `verdict=pass regressions=0 inconclusive=0 errors=0`.

## Consumer gates

Both consumers were fresh isolated clones with the candidate component and
its recorded PocketJS revision checked out as real submodules.

### Wander

- wasm and application builds: exit 0;
- full tests after the required application build: 523 pass, 0 fail, 0 skip
  across 45 files;
- `bunx tsc --noEmit`: exit 0;
- static web build: exit 0, with both `wander` and `wander-online` pages.

### Tuxemon

- pinned-source import: 263 maps, 430 tileset entries, 160 NPC walkers plus
  the player, 86 animated atlases, and no generated-file drift;
- `bunx tsc --noEmit`, production build, wasm build, and `check:cjk`: exit 0;
  the CJK check covers 2,645 fallback characters;
- GB6 mainline: 116,107 frames, 111 battles, terminal
  `spyder_route3@4,6`, and unchanged committed terminal-state SHA-256
  `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`;
- affected CI groups: font/dialog 15 pass, localization 77 pass, production
  locale visuals 5 pass, text/token paths 53 pass, and Chinese UI/web locale
  9 pass; every group had 0 fail and 0 skip.

## Limits

- Studio preview continues to use SC outlines.
- Regional Han switching selects a different bundle before mount; it does not
  replace a regional face inside a live atlas.
- There is no CJK input method, ruby, vertical text, or justification.
- Korean has the same pinned pipeline and checks, but this delivery's UI
  gallery and visual regional-outline oracles cover JP and TC.

Subagent usage: 4 read-only agents audited runtime/schema seams, typography and kinsoku, visual/example coverage, and pinned font/licensing data; parallel review saved integration time.

PASS
