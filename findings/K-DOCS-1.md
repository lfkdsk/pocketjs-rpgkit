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

Four older documentation mismatches remain outside this documentation-only
scope and were not silently propagated:

1. `src/engine/README.md:899-911` lists 9 `SessionOptions`, while
   `src/engine/session.ts:493-553` currently declares 19. The missing table
   entries include immutable state, scene rules, RPG Maker runtime/screen
   validation, travel, text pagination/layout/tokens and world handoff.
2. `src/engine/README.md:574-575` says `\P[n]` ignores runtime party reorder,
   but `src/engine/rpgmaker-text.ts:308-313` applies saved `partyOrder`.
3. `src/engine/README.md:523-528` says the RPG Maker text capability owns
   screen presentation. Reducer clocks use the text runtime, but visible
   KRM2 presentation is independently registered and validated in
   `src/engine/session.ts:517-520,602-686`.
4. `tools/studio-verify.ts:1894-1940` generates screenshot names containing
   `-web`; the two committed documentation screenshots omit that segment.

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

subagent 使用：4 / capability 边界与隔离测试、QuickJS 流程与基线、RPG Maker 导入器与矩阵、Studio 行为与截图分别做只读审计 / 并行审计缩短了事实核对时间，进入报告的命令、数字与判断均由主代理复核

PASS
