# RPG Maker scrolling text, media audio, actor conditions, and ME timing

Candidate: `6de6ff5eb9e3cf913e837bdd97710333f3ec8113`
Base: `3b35021e88036ede57665c0efb401bfe5c964bc8`
PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

All four requested behaviors are implemented without a PocketJS ABI change.
Scrolling text is a continuous, clipped full-screen presentation with the
stock speed and fast-forward rules. The importer converts referenced Ogg/M4A
media to deterministic QOA, carries volume/pitch/pan, and derives ME duration
from decoded frames. Actor conditions now evaluate the facts the importer can
represent. An ME suspends the current BGM and restores it with the stock fade
after natural or explicit completion.

| Item | Result | Focused evidence |
| --- | --- | --- |
| Show Scrolling Text 105/405 | PASS | Continuous reducer/UI, CJK and colour-flow tests, cadence/save/rewind E2E, two-resolution visual |
| Ogg/M4A import and pan | PASS | Real Ogg fixture, M4A fallback, corrupt/missing reporting, deterministic QOA, host pan tests |
| Actor conditions | PASS | Party and live-name predicates plus imported initial class/skill/equipment/state facts |
| Media-derived ME and BGM restoration | PASS | Decoded-frame duration, pitch adjustment, natural/explicit stop and fading-BGM lifecycle tests |

## Upstream semantics

The implementation was compared against fixed source revisions rather than
moving repository heads:

- RPG Maker MV official core: `rpgtkoolmv/corescript` at
  `182e31449707ba7e406db0485c44c2a9d11e2dcd`.
- RPG Maker MZ public v1.1.0 mirror: `stak/rmmz-corescript` at
  `5ecc09ae5170c6aee71c7d9513e553e3dbea116b`. This mirror corroborates MV;
  it is not represented as an official repository.

The relevant stock behavior is:

- MV command 105 collects following 405 rows and configures speed plus the
  no-fast-forward flag (`Game_Interpreter.js:412-424`). Its scrolling window
  begins below the viewport, advances continuously at `speed` half-pixels per
  60 Hz reference update, multiplies movement by three while OK/Shift is held,
  and closes only after the complete text has left the top
  (`Window_ScrollText.js:56-82`). MZ has the same command and window behavior
  at `rmmz_objects.js:9855-9867` and `rmmz_windows.js:5199-5252`.
- MV command 111's actor block tests party membership, name, class, skill,
  weapon, armour and state (`Game_Interpreter.js:487-515`); MZ has the same
  predicate set at `rmmz_objects.js:9931-9959`.
- MV commands 241-250 carry volume, pitch and pan
  (`Game_Interpreter.js:1247-1293`). `AudioManager` defines current BGM by
  name, pauses it while ME plays, resumes the saved cursor after the decoded
  ME buffer stops, and fades the resumed track in for 0.5 seconds
  (`AudioManager.js:81-133,235-268,336-349,370-398`). MZ's matching ME/BGM
  lifecycle is at `rmmz_managers.js:1254-1291`.

Pinned links to every cited source range are published in
`docs/rpgmaker-import.md`.

## Continuous scrolling text

`scrollText` is an additive command with `lines`, integer `speed` and optional
`noFastForward`. Import commands 105/405 preserve source line order and create
one command. The compiled instruction makes the optional flag explicit, so
save validation never has to infer behavior from a newer project schema.

The reducer stores a sparse `scrollText` modal containing the expanded text,
colour spans, measured content/viewport heights and `offset2`, an integer
half-pixel cursor. Fixed-reference updates add `speed`; the standard fast key
adds `speed * 3` unless no-fast-forward is set. The half-pixel representation
avoids fractional drift at 60, 30 and 20 Hz. Completion occurs at exactly
`2 * (viewportHeight + contentHeight)`. Modal equality, snapshots, save
validation and attract rewind all retain the exact cursor.

`ScrollTextLayer` is transparent and clipped to the 480x272 design viewport.
It positions the first row below the bottom edge and translates the measured
flow upward from the modal cursor. It uses the existing message expansion,
colour-span and `flowRows` path, so CJK boundaries and `\C[n]` runs behave like
ordinary messages. Layout is memoized for the modal content instead of being
remeasured every animation frame. Games with no open scrolling modal allocate
no layer rows and perform no reducer work for it.

The imported fixture E2E compares reducer snapshots at 60, 30 and 20 Hz,
including held acceleration, then saves/loads mid-scroll and rewinds/replays
through the same cursor. Direct validation tests reject malformed speeds,
dimensions, flags and completed/negative cursors.

## RPG Maker audio media and pan

The importer discovers logical names case-insensitively under
`audio/{bgm,bgs,me,se}`. It prefers Ogg when both deployment formats exist and
uses M4A when Ogg is absent. A corrupt preferred Ogg is reported rather than
silently changing the selected source. `ffmpeg` decodes the stream to signed
16-bit stereo PCM at 44.1 kHz; the repository QOA encoder then produces stable
bytes. The generated `audio-media.json`, JSON/Markdown coverage and CLI warning
all expose missing or corrupt files with a concrete reason.

The committed Stage fixture measured:

| Kind / logical id | Source | Source bytes | Frames at 44.1 kHz | QOA bytes | 60 Hz ticks |
| --- | --- | ---: | ---: | ---: | ---: |
| BGM `stage-overture` | Ogg | 7,421 | 88,320 | 71,384 | 121 |
| ME `stage-fanfare` | Ogg | 5,545 | 34,816 | 28,144 | 48 |
| Total successful media | | 12,966 | 123,136 | 99,528 | |

The fixture deliberately references one missing BGS and four missing SEs.
Each has zero source/output bytes and its expected path in the report. Tests
also exercise same-name Ogg preference, M4A fallback, malformed media and
conversion-byte stability. Embedded original Ogg bytes let fixture regeneration
reproduce those two files without depending on the locally installed encoder.

Every imported BGM/BGS/ME/SE command retains volume, pitch and pan, clamped to
the stock ranges. Pan remains sparse when centred, preserving old snapshots.
The UI driver applies equal-power gains to mono input and stereo crossfeed to
stereo input; full-left/full-right cases retain both source channels instead of
discarding one. The host ABI still receives ordinary PCM frames, so PocketJS
itself did not need a change.

Reissuing the same BGM/BGS id updates volume, pitch and pan without resetting
its current cursor, fade or pause state, matching the upstream name-only
identity check. Save/replay uses the same rule. A track already fading out is
not considered current for save/replay or later ME resumption.

## Media-derived ME lifecycle

The importer derives ME playback time from decoded media, not project-side
metadata. It first adjusts decoded frames for pitch with
`ceil(frames * 100 / pitch)`, converts that duration to seconds, and the runtime
rounds upward to the fixed 60 Hz reference tick. The fixture's 34,816-frame ME
therefore lasts 48 reference ticks at pitch 100.

Starting ME suspends the current non-fading BGM at its exact cursor. Natural
completion and explicit `stopMe` restore it with the stock 30-tick fade-in.
Stopping or fading the BGM while ME is active prevents a stale later resume;
an already-fading BGM is allowed to finish rather than being frozen behind the
ME. State, fade counters and cursors survive saves and attract rewind.

## Actor conditions

The additive actor condition evaluates:

- party membership through the importer's per-actor party switch;
- name against the leader's saved `playerName` or another actor's live
  `actorNNN-name` variable, falling back to the database name;
- class, skill, weapon, armour and state against optional imported facts on
  `ActorDef`.

Initial actor facts include the database class, level-appropriate class
learnings, valid initial states and valid equipment. Equipment import applies
slot type, dual-wield layout, weapon/armour type permissions and seal traits,
releasing invalid entries until the remaining trait set is stable. Skills
granted by released equipment are not retained.

Party and name predicates are native because the corresponding runtime state
can change. Class/skill/equipment/state predicates execute, but coverage marks
them Degraded: they describe imported initial facts only because later RPG
Maker actor mutation commands and a complete actor simulation are not yet
modelled. Missing database actors/facts evaluate false. Actor stats, enemies
and battle-only conditions keep their prior unsupported behavior and remain
listed in coverage instead of being guessed.

## Coverage and generated project integration

The static command catalogue now classifies 68 of 107 command forms Native,
1 Degraded, 4 Placeholder and 34 Dropped. It continues to name the missing kit
capability for every non-native row. The Stage project itself imports 58 command
uses as 52 Native, 5 Degraded, 1 Placeholder and 0 Dropped; media disposition
is reported separately so an absent file cannot masquerade as a converted one.

The complete `rmi-play` fixture imports the projects, bakes generated art,
packages converted QOA, and mounts the standard audio effects. This exercises
the actual asset manifest and PAK route rather than only inspecting importer
objects.

## Schema compatibility

The project schema additions are optional: `scrollText`, `stopMe`, audio pan,
initial actor facts and the actor condition. The current canonical identity is
`c394541ca7c28bd85899f944e3d57e506a66cd3d221d14cb5d3d56b4a21cdc13`.
The directly preceding published identity
`4f6e1e734edff23e4fbf0fb1bd18708fb56c7ce4d8fca99c01773b65d60efab8`
is accepted first in the compatibility list.

`tests/fixtures/schema-compat/gen-4f6e1e73` was genuinely generated from
commit `7323c5d7`, not made by editing a current hash. Tests open its sharded
project, restore its save, continue play and resave under the current identity.
The intermediate `4c049fc2...` identity was never published, so it is
intentionally absent from both the compatibility list and fixtures. Schema,
embedded editor schema, exhaustive editor/checker consumers, CHANGELOG and
identity hash all agree.

## Imported lifecycle tests

The imported Stage fixture drives each new behavior through the real importer:

- scrolling reaches the same cursor at 60, 30 and 20 Hz, survives mid-scroll
  save/load, and reproduces after rewind;
- audio reaches the same ME/BGM state at each cadence, persists the suspended
  cursor and resume fade through save/load, and reproduces after rewind;
- imported actor facts select the same branch at every cadence and remain
  stable through save/load and rewind.

Pure reducer and host tests add malformed-state validation, same-id audio
updates, explicit/natural ME stop, fade interactions, mono/stereo pan edges,
missing actors and live renamed actors. The full suite covers compiler,
editor, preview, checker and schema round-trips as well.

## Mutation testing

All mutations ran in a detached disposable worktree and were reversed before
the next mutation. The candidate checkout was never mutated.

| Deliberate regression | Focused result |
| --- | --- |
| Change the fast-scroll multiplier from 3 to 2 | `11 pass, 4 fail` |
| Change the pan normalization divisor from 100 to 200 | `19 pass, 1 fail` |
| Force the actor class predicate false | `6 pass, 2 fail` |
| Round decoded ME duration down instead of up | `7 pass, 1 fail` |

Every requested behavior therefore has at least one test that fails for a
plausible one-line regression.

## Visual review

Scrolling text was rendered independently at 480x272 and 960x544. Both PNGs
were enlarged to 3x and opened for inspection. The clipped text enters from
below, the visible rows move continuously through a transparent window, colour
runs remain in the intended rows, and the underlying checker/map remains
visible outside glyph pixels. No top-row clipping or tofu glyphs remain in the
accepted fixture.

The visual test also asserts the exact 2x nearest-neighbour relationship,
transparent/background pixel regions, coloured leading/trailing rows, reducer
cursor and lossless CJK source wrapping. Thus a pair of consistently wrong
images cannot pass on hashes alone.

| Golden | SHA-256 |
| --- | --- |
| `rpgmaker-scroll-text-fast.480x272.png` | `65cf639c526523cddd268365a6d63f8f852e29e53eb3a4a3804dddf58a772d18` |
| `rpgmaker-scroll-text-fast.960x544.png` | `a244da0d13f4c72cabc2fd45dd534884977814296f70cbcadfb70adf2bf44364` |

## Consumer bundle impact

Tuxemon and Wander were each built from identical detached consumer commits,
changing only the kit revision. Both sides use PocketJS `862040bd`; compressed
figures use `gzip -n -9`.

| Consumer / output | Base bytes | Candidate bytes | Delta | Delta % |
| --- | ---: | ---: | ---: | ---: |
| Tuxemon `main.js` | 2,036,872 | 2,052,146 | +15,274 | +0.7499% |
| Tuxemon `main.js` gzip | 468,172 | 471,417 | +3,245 | +0.6931% |
| Tuxemon `main.pak` | 79,975,744 | 79,975,760 | +16 | +0.0000% |
| Tuxemon `main.pak` gzip | 27,511,487 | 27,511,419 | -68 | -0.0002% |
| Wander `wander.js` | 914,506 | 923,702 | +9,196 | +1.0056% |
| Wander `wander.js` gzip | 192,419 | 194,370 | +1,951 | +1.0139% |
| Wander `wander.pak` | 1,132,768 | 1,132,768 | 0 | 0% |
| Wander `wander.pak` gzip | 73,952 | 73,952 | 0 | 0% |

Wander's normalized build-input manifests both contain 608 entries with no
difference, and its 388-entry PAK is byte-identical. The JavaScript increase is
therefore changes in already-reachable engine/UI modules, not newly pulled
importer code or assets.

Tuxemon's two 6,202-entry PAKs differ in only two keys. The generated
`l10n/zh_CN/project-shell.json` keeps the same 207,651-byte entry size and only
updates the schema identity. `ui:styles` grows from 1,894 to 1,908 bytes for
the scrolling presentation; 16-byte PAK alignment turns that 14-byte payload
increase into the observed 16-byte file increase. Importer, tests, Studio and
documentation do not enter either consumer JavaScript bundle.

## QuickJS performance

The pinned desktop QuickJS guest ran each unused-feature workload in three
windows, 10,000 iterations per slot on CPU 3. Every window used
main -> candidate -> candidate -> main. The acceptance value is the median of
six direction-balanced paired deltas.

| Unused-feature workload | Six paired deltas | Median candidate delta | Limit | Result |
| --- | --- | ---: | ---: | --- |
| `sunstoneIdle` | +1.60, +0.70, +0.85, +1.12, -1.25, +2.07% | +0.98% | <= +3% | PASS |
| `sunstoneWalk` | -1.27, +0.35, -3.68, -1.57, -0.50, -1.00% | -1.13% | <= +3% | PASS |
| `streamedRoam` | +1.30, -0.05, -1.22, +1.57, -1.07, +0.13% | +0.04% | <= +3% | PASS |

The feature additions therefore stay within the no-use performance gate.
Importer conversion remains build-time only; runtime state is sparse and the
scrolling presentation exits immediately when no scrolling modal is open.

## Clean gates and determinism

The required final sequence started from a deleted `dist/`:

1. `bun run build:wasm` — exit 0; web wasm 359,675 bytes.
2. `bun run build:example` — exit 0; 32.455 s.
3. `bunx tsc --noEmit` — exit 0; 16.37 s.
4. `bun run test -- --only-failures` — **4,282 pass, 0 fail, 728,510
   assertions, 274 files, 492.58 s**.

The Stage importer was then run twice into empty independent directories.
Each produced 24 files and 221,548 bytes. `diff -qr` found no difference, and
both sorted content manifests hashed to
`f63628e4419a2e363e12ec8243e1313071b32c1a6654609d845413f56943cab1`.

`bun.lock` is unchanged. All eleven implementation/test/documentation commits
use `lfkdsk <lfkdsk@gmail.com>`, have no Co-authored-by or AI trailer, and keep
the PocketJS submodule at the baseline revision.

subagent 使用：7 个 / 分别调研并实现角色导入、核对音频语义、实现滚动 UI、制作视觉测试、整理消费者测量方法；另 1 个滚动调研被中止、1 个只读验证因权限约束未产出 / 有产出的独立工作并行完成，节省了时间，主代理复核实现并亲自完成冷门禁、变异、视觉、消费者与性能测量。
PASS
