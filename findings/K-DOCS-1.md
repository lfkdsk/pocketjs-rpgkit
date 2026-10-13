# K-DOCS-1 — user-facing component documentation

Base: `origin/main` `310934f9b9b3efbb09d108f1de29432335609b31`
Pinned PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`

## Verdict

**PASS.** The RPG Maker import guide now starts with working CLI and Studio
paths, the optional-capability boundary has one catalogue and extension guide,
and the QuickJS guide documents reproducible ABBA and cumulative-drift
workflows. Root navigation and the feature-status ledger point to the same
facts. The repository's complete test suite is **4,576 pass, 0 fail, 0 skip**,
TypeScript exits 0, and all local Markdown links resolve.

The documentation-only change is clean against its change base: its QuickJS
consumer bundle is byte-identical to the base bundle and all eight
single-change workloads pass the 3% guard. The fixed-history cumulative guard
does expose an existing `battleSceneImmutable` drift; two complete historical
comparisons measured **+8.784393%** and **+4.538628%** against the configured
3% ceiling. That is recorded below and needs a runtime follow-up, but it was
not introduced or hidden by this branch.

## 1. Documentation delivered

| File | Result |
| --- | --- |
| `docs/rpgmaker-import.md` | Reordered to quick start (CLI, browser Studio, desktop Studio, running the output), generated support matrix, battle, safe Script subset, limits, real-project trials and detailed mechanics. The current static catalogue has **107 rows: 95 Native, 9 Degraded, 2 Placeholder and 1 Dropped**. |
| `docs/capabilities.md` | New strict-admission and fail-soft catalogue, reducer/presentation split, package-entry isolation table, byte-pin explanation and a nine-step guide for adding an optional feature. |
| `docs/quickjs-performance.md` | Host preparation, explicit baseline selection, three-window ABBA interpretation, report/guard exit contracts, fixed-history baseline ownership and reviewed update procedure. |
| `README.md` | Top-level capability summary and task-oriented documentation index; corrected package exports and Studio/RPG Maker integration descriptions. |
| `docs/status.md` | Importer, capability isolation, Studio and cumulative performance entries now point to the current guides and headings. |
| `docs/studio.md` | Browser/desktop import behavior and desktop availability now match the implementation. |

The browser/desktop distinction is explicit. Browser Studio returns the
project shell, map entries and PNG assets, reports audio as Dropped, and uses
the generic battle stand-in. CLI and desktop import also persist the generated
battle database, QOA audio, asset manifests and coverage reports.

## 2. Implementation cross-check

The support matrix is produced by `staticCommandTable()` in the current
importer rather than copied from an older finding. The safe Script section
matches the bounded tokenizer/AST recognizer and states that arbitrary project
JavaScript is never evaluated. The battle section distinguishes imported data,
registered reducer rules and registered presentation. The capability guide
likewise separates content admission, hot-path absence and static bundle
isolation instead of treating them as one switch.

Three older documentation mismatches remain outside this documentation-only
scope and were not silently propagated:

1. `src/engine/README.md:899-911` lists 9 `SessionOptions`, while
   `src/engine/session.ts:493-553` currently declares 19. The missing table
   entries include immutable state, scene rules, RPG Maker runtime/screen
   validation, travel, text pagination/layout/tokens and world handoff.
2. `src/engine/README.md:523-528` says the RPG Maker text capability owns
   screen presentation. Reducer clocks use the text runtime, but visible
   KRM2 presentation is independently registered and validated in
   `src/engine/session.ts:517-520,602-686`.
3. `tools/studio-verify.ts:1894-1940` generates screenshot names containing
   `-web`; the two committed documentation screenshots omit that segment.

The party-name item previously listed here was not a mismatch. Message
expansion passes the fixed imported `partyActorIds` directly at
`src/engine/rpgmaker-text.ts:228-239`; the live-order helper at lines 293-313
is used by formation and battle integration, not by `\P[n]`. The engine guide
was therefore already correct: message lookups keep the imported initial
order while supported actor renames still change the displayed name.

## 3. Documented-command validation

Every executable sequence introduced or rewritten in these guides was run.
CPU 5 replaced the example CPU 2 for the final low-load timing because it and
its SMT sibling were idle; the recorded affinity confirms CPU 5.

| Command group | Actual result |
| --- | --- |
| `git submodule update --init --recursive`, frozen Bun install, tool discovery and desktop-host file check | Exit 0; Bash, Git, Bun, Cargo, awk, `taskset` and `sha256sum` were found. `bun.lock` did not change. |
| Hollow MZ CLI smoke import with `--shard` | Exit 0; **3 maps, 4 tile sheets and 12 sprites**. Coverage counted **124 uses: 112 Native, 10 Degraded, 2 Placeholder, 0 Dropped**. |
| Static command-table one-liner | `Native 95`, `Degraded 9`, `Placeholder 2`, `Dropped 1`; 107 total rows. |
| `bun tools/build-example.ts rmi-play` and the three-app capability build | Exit 0. Built bundle pins reproduced exactly: Meadow **683,647 bytes**, Sunstone **1,107,830 bytes**, `rmi-play` **1,297,182 bytes**. |
| RPG Maker capability isolation test | **4 pass, 0 fail**; the ordinary apps exclude the optional importer/runtime needles and `rmi-play` includes them. |
| Importer, safe Script/formula and guard-analyzer focused suites | **37/37**, **73/73** and **7/7** pass respectively. |
| Three-window change-base QuickJS report | Exit 0; both bundles had SHA-256 `a007b610…`. Eight medians ranged from **-6.787547%** to **+0.952277%**. |
| Three-window QuickJS single guard | **8/8 pass**; candidate and change-base bundles were byte-identical. Medians ranged from **-3.936792%** to **-0.128225%**. |
| Fixed-baseline ancestry commands | Both full SHAs resolved; `a4dc4e72341ae6aa7373623f83dbd07124316a6d` is an ancestor of `310934f9b9b3efbb09d108f1de29432335609b31`; ancestry check exited 0. |

The combined `--guard` invocation completed the single comparison before the
command runner's five-minute ceiling interrupted its cumulative half. The
cumulative comparison was therefore run directly to completion twice with the
same configured baseline, three ABBA windows, 2,000 iterations and nine host
samples. Seven workloads passed both times. Only `battleSceneImmutable`
failed: +8.784393% under elevated post-build load, then +4.538628% in the
CPU-5 confirmation. The second run's one-minute load stayed between 3.93 and
4.92 on the 32-logical-CPU host. This is a measured regression, not an
incomplete-or-malformed analyzer result. A focused Fleet follow-up was
proposed; that proposal is not assumed to be enqueued or accepted.

## 4. Screenshots and links

Both existing Studio import tiers were opened at native size and as nearest-
neighbour 3x inspection copies:

- wide English: **1440×900**, inspected again at **4320×2700**; the ready
  card, four metrics, Placeholder emphasis and action row are visible;
- compact Chinese DPR2: **1200×1800**, inspected again at **3600×5400**; the
  localized title/action, two metric columns and complete dialog fit without
  horizontal clipping.

The 3x inspection copies are retained under `/var/tmp/fleet/4527/visual/` and
are not repository changes. The committed screenshots themselves were not
rewritten.

An inline local-link checker covered root `README.md` and every Markdown file
directly under `docs/`: **12 files, 255 local file/anchor targets, 0
unresolved**. It models GitHub heading slugs, including repeated whitespace
around removed punctuation, and checks explicit HTML ids.

## 5. Gates and repository hygiene

- `bun run build:wasm`: exit 0; rebuilt web wasm is **359,675 bytes**.
- `bun run build:example`: exit 0 for all examples and fixtures.
- `bunx tsc --noEmit`: exit 0 with no output.
- `bun run test`: **4,576 pass, 0 fail, 0 skip**, 730,583 expectations across
  298 files in 508.82 seconds. The complete transcript is
  `/var/tmp/fleet/4527/full-test.log`; its captured exit status is 0.
- The final fetch still resolves `origin/main` and the branch merge-base to
  `310934f9b9b3efbb09d108f1de29432335609b31`, so no rebase was necessary.
- All three branch commits are authored by `lfkdsk <lfkdsk@gmail.com>`. The diff contains only root/documentation Markdown and this finding; there is no `bun.lock`, schema, source, generated asset or submodule-pointer diff, and the branch contains no merge commit.

## 6. Correction audit

The failed review was rechecked against implementation call paths and the
assertions in every cited test rather than accepted mechanically. The final
documentation now makes these corrections:

1. `pocket-rpgkit/ui/rpgmaker-formation` explicitly says that it has **no
   bundle-isolation assertion**. `tests/rpgmaker-formation.test.ts` is labelled
   only as functional coverage. `pocket-rpgkit/ui/saves` is disclosed the same
   way. A combined follow-up for positive/negative bundle guards was proposed;
   the proposal is not assumed to be accepted or scheduled.
2. All three user-facing descriptions of `\P[n]` now follow the actual message
   call path: imported initial party order, unaffected by formation swaps or
   later membership changes, while supported renames remain live. This also
   resolves the contradiction within the changed document set.
3. The four lower-severity review findings are fixed: a capability-bearing
   seam fails closed without its policy, the public export is named
   `rpgMakerTextRuntime`, saves no longer imply an isolation suite, and the
   obsolete `the-80-commands` compatibility anchor is gone.
4. The README command catalogue had only 81 distinct operations under its
   “87 commands” heading. It now includes `changeTileset`, `screenTone`,
   `weather`, `windowTone`, `formationAccess` and `formationSwap`; an automated
   comparison against the `Command` union reports **code=87, docs=87,
   missing=none, extra=none**.
5. Browser Studio computes and displays importer coverage but does not persist
   it in its pack, and it does not include CLI/desktop `battle.json` or
   manifests. The guide and status ledger now reserve persisted coverage and
   battle output for CLI/desktop imports. The static **95/107 Native** figure
   is described as one minimal sample per command head, while the three public
   game figures are identified as recorded manual conversion trials rather
   than automated fixtures.
6. Studio documentation now covers rollback failure (which can leave a mixed
   old/new folder), splits exact boundary tests from aggregate asset-budget
   coverage, and names the browser/desktop/importer allowlist instead of
   claiming only one browser-host file. The matching status row is consistent.
7. QuickJS guard documentation now matches the wrapper: usage/preflight errors
   exit 2 before a final result; once comparisons begin, both run and the
   wrapper always emits `PR1_QJS_GUARD_RESULT`, exiting 0, 1 or 3.
8. The package guide now describes the manifest's exports without claiming
   that this `private: true` package is currently published.

## 7. Test-citation cross-check

The six audited guides contain **46 unique `tests/*.test.ts` references**.
Every path exists. Test names and relevant assertions were inspected for each
claim; the following list records the actual scope rather than inferring it
from filenames. For compactness, table entries abbreviate
`tests/<name>.test.ts` as `<name>`:

| Documentation area | Tests checked | What the assertions actually cover |
| --- | --- | --- |
| Capability source-graph/final-bundle boundaries | `rpgmaker-capability-bundle-isolation`, `krm2-ui-bundle-isolation`, `world-ui-bundle-isolation`, `audio-bundle-isolation`, `demo-ui-bundle-isolation`, `battle-ui-bundle-isolation`, `rpgmaker-battle-isolation`, `krm3v-ui-bundle-isolation` | Export identity plus the positive fixture, ordinary-app negative control, pass-one graph, final-bundle needles or byte pins provided by each named test. The catalogue no longer claims that every row has both kinds of assertion. |
| Capability functional-only references | `rpgmaker-formation`, `ks2-save-view-sim` | Formation access/order and GameView save/load behavior. Neither is represented as a bundle-isolation test. `choice-icon-render` additionally verifies the documented labels-only fallback and one warning when the optional icon box is absent. |
| Importer matrix | `rpgmaker-import` | `staticCommandTable()` classifications and byte-for-byte equality between `commandTableLines()` and the Markdown inside the generated table markers. |
| QuickJS analyzer | `pr1-quickjs-guard` | ABBA pairing, threshold equality, report-only mode and malformed/missing/duplicate/non-positive input failures. It does not claim to exercise shell orchestration or QuickJS. |
| Studio model, host and limits | `studio-session`, `editor-api-equivalence`, `studio-host`, `studio-directory-save`, `studio-import-limits`, `studio-inspector-model`, `edit-move-map`, `studio-pack-assets`, `studio-build`, `studio-playtest`, `preview-art-sim` | Reversible edits/equivalence, allowlisted host APIs, successful and failed rollback, exact document/pack/shard/map/event/PNG boundaries, aggregate asset budgets, drag destinations, build determinism and play-test art transport/rendering. |
| README editor references | `editor-api-equivalence`, `editor-model`, `editor-sim`, `editor-proposal-sim`, `editor-agent-sim`, `editor-event-sim`, `editor-playtest-sim` | Shared patches/bytes, document and edit gates, pointer/gamepad flows, proposals, offline agent flow, responsive inspector/runtime editing and real GameView play/debug goldens. |
| README battle and guest references | `battle-ui-bundle-isolation`, `kb4-battle-rules`, `kb4-battle-sim`, `guest-globals` | Generic battle UI absence, pure battle state machine, rendered/pixel/Hz proofs, and the statically scanned QuickJS guest-global allowlist. |
| Status rendering and screen references | `rpgmaker-scroll-text-visual`, `ks1-screen-effects`, `r2-ui-sim` | Scrolling-text pixels, recursive admission/battle cleanup/screen timelines, and the world-overlay mount order. |
| Status connected-world references | `world-streamed-sim`, `seamless-handoff`, `world-bounded-sim`, `world-preview`, `world-left-map`, `world-preview-sim`, `world-preview-sandbox` | Transition frames, reducer handoff rules, bounded continuous rendering, conservative preview reasons, saved left-map snapshots, preview handover frames and sandbox purity/cache behavior. |
| Status editor/mobile web references | `editor-api-equivalence`, `tap-walk-hz`, `web-oauth-state`, `web-name-input`, `web-invite-link` | Identical editor protocol results, 60/30/20/4 Hz tap routes, OAuth lifecycle, IME-safe character naming and invite persistence/copy/consumption. |

Two nuances found by this pass are now explicit in the guides: isolation tests
do not all have the same positive/negative or source/final shape, and a
functional test is not evidence of static bundle isolation.

## 8. Correction gates

- `bun run build:example`: exit 0 for every example and fixture.
- `bunx tsc --noEmit`: exit 0 with no output.
- `bun run build:wasm`: exit 0; the rebuilt web wasm is **359,675 bytes**.
- The inline local-link checker again found **12 files, 255 local targets, 0
  unresolved**.
- The independent command-catalogue comparison reports **code=87, docs=87,
  missing=none, extra=none**.
- With Homebrew's `ffmpeg` explicitly present on `PATH`, the five importer
  files affected by the first background runner's stripped environment pass
  **62 tests, 0 fail**. The first runner's diagnostic transcript is retained
  separately; all seven failures/three module errors there were `ffmpeg`
  lookup failures rather than assertion mismatches.
- The final `bun run test` gate passes **4,576 tests, 0 fail, 0 skip**, with
  **730,583 expectations across 298 files in 580.09 seconds**. The complete
  transcript is `/var/tmp/fleet/4531/full-test-final.log`; its captured exit
  status is 0.
- A final fetch resolves both `origin/main` and the branch merge-base to
  `310934f9b9b3efbb09d108f1de29432335609b31`, so no rebase is required.
- The branch diff is documentation-only: root/documentation Markdown and this
  finding, with no lockfile, source, schema, generated asset or submodule
  pointer change. The branch contains no merge commit.

subagent 使用：4 / capability 导出与隔离、RPG Maker 导入器与文本调用路径、README Studio QuickJS、全量对抗式文档声明分别做只读审计 / 并行核对缩短了覆盖面审查时间；进入报告的代码路径、断言、命令与数字均由主代理复核

PASS
