# `rpgkit-check` QA checks reference

`rpgkit-check` runs QA tools over any `rpgkit-project/v1` document. The
dynamic checks (`locks`, `freeze`, `reach`, `explore`) drive the real engine
on a copy of the project; `lint` is static; `shot` renders schematic maps.
Game-owned extension calls, battles and scenes run through noop fallbacks
(unknown extensions are accepted as no-ops, battles are declined without a
result branch, and scenes complete on their first frame through `onDone`),
so the default checks measure event/lock/world liveness, not game logic. A
trusted game session module can replace those fallbacks for dynamic checks
and screenshots.

## Invocation

```sh
bun tools/rpgkit-check/cli.ts <check> --file <doc.json> [--json '<args>'] [--out <dir>] [--session <module>]
```

Use that direct entry when another program consumes the report: stdout
contains exactly one JSON value, including when findings make the command
exit nonzero, and the CLI itself adds no wrapper text to stderr. `bun run
rpgkit-check …` remains an interactive alias, but Bun may write its launch
line and nonzero-exit diagnostic to stderr; keep stderr separate.

Checks: `lint`, `locks`, `freeze`, `reach`, `explore`, `shot`. The short
names above and the full `rpgkit-<check>` forms are both accepted.

| flag | meaning |
| --- | --- |
| `--file <path>` | project document: an inline `rpgkit-project/v1` JSON file, or a sharded `ProjectShell` (its `mapIndex[].entry` shards are read and decoded next to it, compact `rpgkit-map/1` included). Required. |
| `--json <json>`, `--args <json>` | arguments object for the check, either inline or `@path/to/args.json`. A relative `@path` resolves from the directory containing `--file`, independent of the CLI process directory. CLI flags win over `--json` keys. |
| `--map <id>` | `lint` only: scope the pass to one map (only that map's shard is loaded). |
| `--incremental` | `lint` on a shell only: reuse cached per-shard findings and re-check only shards whose bytes on disk changed. |
| `--out <dir>` | output directory for `shot` (default `.`). |
| `--session <module>` | trusted TypeScript or JavaScript module providing function-bearing `SessionOptions` for `locks`, `freeze`, `reach`, `explore`, and `shot`. The path is resolved from the current directory. `lint` rejects this flag. |

### Game session modules

JSON cannot carry extension handlers, battle reducers, or scene rules. A
game can instead default-export a `SessionOptions` object (a named
`sessionOptions` export is also accepted) from a local `.ts` or `.js` module:

```ts
import type { BattleRules, SessionOptions } from "pocket-rpgkit/engine";

const qaBattle: BattleRules = {
  start: (ext) => ({ state: ext, ext }),
  step: (state) => state,
  done: (ext) => ({
    ext,
    result: "win",
    // These ids and values are the game's declared result convention.
    writes: { "story.lastBattleResult": 1 },
  }),
};

export default {
  extensions: {
    conditions: { "game.hasStarter": () => true },
  },
  battle: qaBattle,
  // scenes: { "game.journal": journalRules },
} satisfies SessionOptions;
```

```sh
bun run rpgkit-check locks --file game/data/project.json --session ./tools/qa-session.ts
bun run rpgkit-check shot --file game/data/project.json --session ./tools/qa-session.ts \
  --json '{"map":"village","x":4,"y":6,"out":"shots"}'
```

The checker retains its fallbacks for registrations the module omits:
unknown extensions remain allowed unless the module sets
`allowUnknown: false`, unregistered scene ids still get the one-frame
`onDone` rule, and an omitted battle adapter still declines encounters. The
checker never guesses a game's battle-result variable names or enum values;
the module must publish them through its `BattleCompletion`. `reach` sends
zero input to a session module's battle reducer, so use deterministic QA
rules when a real battle needs player input.

`--session` executes the module as local code and is therefore for trusted
modules only. It is deliberately CLI-only: it is not part of any JSON schema
and is not available through the MCP tools. With no flag, behavior is
unchanged.

Every check prints one pretty-printed JSON report on stdout. The shared
envelope is:

```json
{
  "check": "lint",
  "findings": [
    { "check": "lint", "severity": "error", "message": "…", "suggestion": "…", "loc": { "map": "village", "event": "elder", "page": 0, "commandPath": [2, "then", 0], "pointer": "/maps/0/…" } }
  ],
  "summary": { "maps": 3, "events": 21, "pages": 28, "commands": 64 }
}
```

`loc` fields are all optional; `commandPath` interleaves indexes and branch
tags (`then`, `else`, `options`, `cancel`, `onWin`, `onLose`, `onEscape`,
`onDone`, `onCancel`, `commands` for a `loop` body, `common`). Every check
descends into `loop` bodies like any other branch. A finding about a choices option's own
field ends in a field tag after the option index (`[2, "options", 1, "icon"]`).
`shot` returns an array instead of the envelope (see below).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | no error-severity findings (warnings and info do not fail a check) |
| 1 | the report contains at least one `error` finding |
| 2 | usage error, invalid `--json`, thrown error, or a document that cannot be loaded (a load failure still prints a structured report with `doc/*` findings and `summary.loadError`) |

## `lint` — static health check

Args: `file` only. Pure function of the document: switch/variable use,
provably-dead pages, missing references (including declared audio ids),
empty choices, and static map reachability. With `system.textVariables` on,
every `{v:<id>}` token in a `text` line, a `choices` prompt or option, or an
`extChoice` prompt counts as a read of variable `id` (so the variable is not a
dead write, and an id nothing sets is reported as
`lint/variable-read-never-set`). With a declared `system.textTokens`
allowlist, every `{x:<key>}` token in the same places must be listed (the
resolver itself is code-side and invisible to the check); an unlisted key is
`lint/text-token-unknown`. The declaration is also the runtime opt-in that
switches `{x:}` expansion on, so a token used without it prints verbatim and
is reported as `lint/text-token-off`. `summary` adds `maps`, `events`, `pages`,
`commands`, and per-severity counts. A missing id in a declared
`project.audio` table is retained as an `audio-missing` warning with its
exact command location. It is not an error because a project may
intentionally package only part of its host audio; the warning still keeps
typos and accidentally omitted ids visible.

```sh
$ bun run rpgkit-check lint --file examples/sunstone/data/sunstone.json
{ "check": "lint", "findings": [], "summary": { "maps": 3, "events": 21, "pages": 28, "commands": 64 } }
```

`lint` accepts a sharded `ProjectShell` wherever it takes an inline
document: the shell is materialized through the same decode/validate path
the runtime uses (compact `rpgkit-map/1` shards included), so the findings
match an inline lint of the same content.

- `--map <id>` scopes the pass to one map: only that map's shard is loaded,
  and the report carries that map's own findings. The document-global checks
  (switch/variable pairing, scene review, start, reachability) need the whole
  document and are skipped — run the full pass for them. `summary.scopedMap`
  names the map.
- `--incremental` (shell only) caches per-shard findings and usage digests
  in `.rpgkit-check-lint.json` next to the shell, keyed by the shell globals,
  the mapIndex structure and the schema hash. A shard is a cache hit only
  when both the checksum the shell declares and the SHA-256 of the shard's
  raw bytes on disk match — the byte hash is taken before UTF-8 decoding, so
  any byte drift still misses the cache, including one that decodes to the
  same text (an illegal byte replaced by U+FFFD) and ones that decode to
  different text (a BOM, a newline difference such as CRLF to LF). A shard
  that changed without a
  shell refresh (an external edit, a sync/restore, corruption) is re-checked
  and its checksum finding is replayed, and so is a shard whose declared
  checksum changed; a re-run after an edit decodes and lints only the
  re-checked shards and merges the rest from the cache.
  `summary.checked`/`summary.cached` report the split. The cache is
  invalidated by any change to the shell globals, the map set, the schema,
  or the lint logic. A read-only caller (the MCP proposal-only mode)
  computes the cache in memory without writing the sidecar.

## `locks` — permanent input-lock check

Args: `file`, `frames` (number, default `12000`). Every page containing a
`lockInput` (including inside called common events) is instrumented and run
in isolation on the real engine; the lock must be released by `unlockInput`
or a map transfer within the frame budget. A `loop` around the lock is kept
(its body forced like the page root), so a body that unlocks later in the
same pass releases it, while a lock re-taken in the same frame by a wait-less
`break`-less loop is never observed released and is reported. The static
release hint treats a loop body as running one or more times (iterated to a
fixpoint); only a `break` (or a transfer) leaves it, and a `break` inside a
called common event ends that common event, not the caller's loop.

`summary`: `pages`, `lockCommands`, `dynamicChecks`, `unlocked`,
`transferred`, `unresolved`, `errors`. `rows` carries one entry per checked
page: `{ map, event, name, page, trigger, locks, outcome, lockedAt,
resolvedAt, error? }` with `outcome` one of `unlocked`, `transferred`,
`unresolved`, `error`. Each `unresolved`/`error` row emits a
`locks/permanent-lock` error.

When a local run stays locked, the checker makes up to 16 bounded retries
for causally linked `parallel` or `autorun` release pages on the same map. It
may seed their other historical page/branch prerequisites, but leaves at
least one fact written by the lock page live. A retry only succeeds when the
real engine observes the target lock first and then an unlock or transfer;
static matching alone never clears a finding. A loaded session module can
also publish the game's declared battle-result variables and switches before
such a release page runs.

```sh
$ bun run rpgkit-check locks --file examples/sunstone/data/sunstone.json --json '{"frames":1200}'
{ "check": "locks", "findings": [], "summary": { "pages": 0, "lockCommands": 0, "dynamicChecks": 0, "unlocked": 0, "transferred": 0, "unresolved": 0, "errors": 0 }, "rows": [] }
```

(Sunstone has no `lockInput` commands, so nothing is checked.)

## `freeze` — freeze scan

Args: `file`, `windowFrames` (number, default `6000` — 100 s at 60 Hz). The
scan runs `windowFrames × 2` frames per map, entering each map at a
collected transfer landing or its centre, auto-advancing dialogs and
rotating the d-pad. A row is flagged when input is locked for the whole
window, a busy fiber makes no world progress for the whole window, or the
interpreter throws. A `loop` with no `break` on an autorun or player-started
page keeps the main fiber busy forever: when its passes change nothing it is a
`freeze/blocking-fiber` (the player never regains control — a real
soft-lock). A polling loop on a parallel page does not hold the main fiber and
is not flagged.

`summary`: `maps`, `windowFrames`, `scannedFramesPerMap`, `permanentLocks`,
`permanentBlockingFibers`, `errors`, `flagged`. `rows` (flagged entries
only): `{ map, start, finalMap, final, cells, frames, inputLocked,
blocking, error? }`. Every flagged row is an error.

```sh
$ bun run rpgkit-check freeze --file examples/sunstone/data/sunstone.json --json '{"windowFrames":600}'
{ "check": "freeze", "findings": [], "summary": { "maps": 3, "windowFrames": 600, "scannedFramesPerMap": 1200, "permanentLocks": 0, "permanentBlockingFibers": 0, "errors": 0, "flagged": 0 }, "rows": [] }
```

## `reach` — real-engine reachability with replayable witnesses

`reach` searches the real engine (no second interpreter): a breadth-first
search over world-idle session states, where each edge is a macro that walks
the engine's own passage table to a triggerable event, triggers it, and rides
the result out to world idle — through text, shops, choices (one branch per
option), battles, and transfers. Every map it calls **reached** carries a
button-mask tape the tool itself replays in a fresh session to verify the
arrival; a map it calls **notFound** is one no witness was found for within
budget — a **lead, not a proof**, with frontier stats naming the inbound
transfers whose source pages never ran.

**A "reached" verdict is only as good as the replay.** The witness is a
60 Hz tape (one PSP button mask per reference tick) recorded in constant
6-tick blocks with every pressed edge on a block boundary. Each witness is
replayed and verified at 60 Hz in a fresh session (one `stepSession` call
per tick): the replay must land on the target map with the recorded state
hash, or the map is **not** called reached — a witness that fails its own
fresh-session replay is a `reach/witness-replay-failed` error. The tool
makes no claim about other host frame rates: a witness is verified at
60 Hz only.

Args: `file`, `start` (optional object: `{ map?, x?, y?, dir?, switches?,
variables?, items?, gold? }`; defaults to the project start with a fresh
bank), and the budgets `maxFrames` / `maxStates` / `maxSeconds`.
`battle` (registered `BattleRules` plus an optional auto-input callback) is
available on the TypeScript API. The CLI can load function-bearing battle
rules through `--session`; MCP JSON cannot. Without either form the search
uses the default `encounters-declined` policy, so a map gated on a battle
outcome is notFound. A `--session` battle uses zero input; the TypeScript API
is the route when a reducer needs custom auto-input.

**Budgets are execution limits, not hints.** The frame budget counts the
ticks the search really executes: a choices fan-out's shared walk/dialog
prefix is charged once, not once per branch. The frame and wall-clock
budgets are checked inside each macro's ride-out / battle / wait loop
(before and after every 6-tick block, and between a held edge's release
block and its edge block — the release block's ticks count as already
spent at that check), so the whole search runs at most one block past the
limit: `framesRun <= maxFrames + 6`. The block-constant tape makes one
block (6 ticks) the minimum unit of work, so `maxFrames=1` runs one
block. `endedReason` is one of
`exhausted`, `frame-budget`, `state-budget`, `time-budget`.
`maxFrames` and `maxStates` are non-negative integers; `maxSeconds` is a
non-negative number (fractional allowed). The CLI exposes the budgets as
`--max-frames <n>`, `--max-states <n>`, `--max-seconds <n>` (space and
`=` forms); CLI flags win over the same keys in `--json`.

`summary`: `maps`, `reached`, `notFound`, `statesExplored`, `statesQueued`,
`framesRun`, `endedReason`. The report also carries `start` (`"map@x,y"`),
`battlePolicy`, `budgets`, `maps` (per-map `status`, `frames`,
`witness`, `stateHash`, or `frontier`), `reachableMaps`, `notFoundMaps`, and
`assumptions`. A missing or unstandable start is a `reach/start-unreachable`
error. Structural checks run alongside the search: a transfer to a map the
project does not define is a `reach/transfer-target-missing` **error**; a
transfer landing on a blocked tile is a `reach/transfer-landing-blocked`
**warning**; maps no literal transfer points at and dynamic-target transfers
are listed as `reach/map-orphan` / `reach/dynamic-transfer` **info**.

```sh
$ bun run rpgkit-check reach --file examples/sunstone/data/sunstone.json
{
  "check": "reach",
  "findings": [],
  "summary": { "maps": 3, "reached": 3, "notFound": 0, "statesExplored": 112, "framesRun": 120000, "endedReason": "frame-budget" },
  "start": "village@9,9",
  "battlePolicy": "encounters-declined",
  "budgets": { "maxFrames": 120000, "maxStates": 3000, "maxSeconds": 60 },
  "reachableMaps": [ "village", "forest", "cave" ],
  "notFoundMaps": [],
  "maps": [
    { "map": "village", "status": "reached", "frames": 0, "witness": { "hz": 60, "masks": [] }, "stateHash": "…" },
    { "map": "forest", "status": "reached", "frames": 162, "witness": { "hz": 60, "masks": ["… 162 masks …"] }, "stateHash": "…" },
    { "map": "cave", "status": "reached", "frames": 696, "witness": { "hz": 60, "masks": ["… 696 masks …"] }, "stateHash": "…" }
  ],
  "assumptions": ["… the search's known imprecisions …"]
}
```

The per-map witnesses and `stateHash` feed `shot`'s `reach` overlay and the
editor's play-test debugger.

## `explore` — headless exploration coverage

Args: `file`, `frames` (number, default `6000`), `stuckFrames` (number,
default `600`). A headless player walks the game, auto-answering choices,
and reports which event pages never ran. This is a coverage tool, not a
player: story-gated events are reported, not failures. `action` pages are
confirmed from inside the rect or facing it from a neighbor; `playerTouch`
pages and non-blocking `eventTouch` pages are stepped onto (they fire on
entry); a blocking (`blocks: true`) `eventTouch` page is bumped — the explorer
stands on a neighbor and holds the direction toward the body, so the refused
step fires it. `reach` drives the same three trigger modes (a bump holds the
direction for one 6-tick block).

`summary`: `frames`, `framesRun`, `mapsVisited`, `mapsTotal`,
`eventsTotal`, `eventsTriggered`, `eventsNeverTriggered`, `triggersTotal`,
`autoChoices`, `errors`, `endedReason`. `endedReason` is one of `budget`,
`complete`, `stuck`, `error`. `events` holds per-event stats with per-page
fiber-start counts; `neverTriggered` holds
`{ map, event, name, page, reason }` with reason `no-active-page`,
`map-unvisited`, `unreachable`, `budget`, `stuck`, or `attempted-no-fiber`.
Each never-triggered page is an `explore/never-triggered` **info** finding;
an interpreter error during exploration is an `explore/error` error and
fails the check.

```sh
$ bun run rpgkit-check explore --file examples/sunstone/data/sunstone.json --json '{"frames":1200,"stuckFrames":300}'
{
  "check": "explore",
  "findings": [ { "severity": "info", "message": "event \"thorn-gate\" (Wall of Thorns) on \"forest\" page 1 never ran within the 1200-frame observation window (attempted-no-fiber)" } ],
  "summary": { "frames": 1200, "framesRun": 1200, "mapsVisited": 3, "mapsTotal": 3, "eventsTotal": 21, "eventsTriggered": 19, "eventsNeverTriggered": 3, "triggersTotal": 23, "autoChoices": 2, "errors": 0, "endedReason": "budget" },
  "mapsVisited": [ "village", "forest", "cave" ],
  "neverTriggered": [
    { "map": "forest", "event": "forest-return", "reason": "budget" },
    { "map": "forest", "event": "thorn-gate", "reason": "attempted-no-fiber" },
    { "map": "cave", "event": "cave-return", "reason": "budget" }
  ]
}
```

## `shot` — schematic screenshots

Args: `file`, `map` (required), `x`, `y` (required numbers), `dir`
(optional), `sw` (optional `{ switches?, variables?, items?, gold? }`
switch bank), `reach` (optional array of `"map@x,y"` node keys to tint as
reachable, as produced by `reach`), `out` (optional, default `"."`).

Renders two deterministic, byte-identical PNGs per call — PSP 480×272 and
desktop 960×544 — named `<map>-<x>-<y>.<width>x<height>.png`. Green cells
are standable, gray cells blocked, orange boxes mark events, the white box
is the player, and the cyan box is the start. Returns an array (not the
shared envelope):

```sh
$ bun run rpgkit-check shot --file examples/sunstone/data/sunstone.json --json '{"map":"village","x":9,"y":9,"out":"shots"}'
[
  { "resolution": { "width": 480, "height": 272 }, "file": "shots/village-9-9.480x272.png", "bytes": 5122, "sha256": "c05a2426…" },
  { "resolution": { "width": 960, "height": 544 }, "file": "shots/village-9-9.960x544.png", "bytes": 20128, "sha256": "687fe260…" }
]
```

`shot` builds its fixture directly from source on first use and caches the
bundle under `.cache/rpgkit-check/shot/`. A PocketJS input manifest makes a
source or compiler change invalidate that cache; fresh calls reuse it. Build
output is captured so it cannot contaminate the JSON report. The only manual
prerequisite is `vendor/pocketjs/hosts/web/pocketjs.wasm` (`bun run
build:wasm`); a missing wasm is a thrown error (exit 2).

## Finding codes

### Document loading (`doc/*`, all errors)

| code | meaning | typical fix |
| --- | --- | --- |
| `doc/unreadable` | the file cannot be read | pass a path to an `rpgkit-project/v1` JSON document |
| `doc/invalid-json` | the file is not parseable JSON | fix the JSON syntax |
| `doc/schema` | JSON Schema violation (the location is in `loc.pointer`) | bring the document back to what the editor exports |
| `doc/shell` | a sharded `ProjectShell` or one of its shards is malformed (bad index, manifest, envelope, or shard content) | fix the shell/shard, or re-import |
| `doc/shard-checksum` | a shard's bytes do not match the `mapIndex` checksum | re-export the shard or restore the indexed bytes |
| `lint/map-id-duplicate` | duplicate map id | map ids must be unique; the engine keys worlds and transfers by them |
| `lint/event-id-duplicate` | duplicate event id within a map | event ids must be unique within a map; the engine keys characters and self-switches by them |

### `lint`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `lint/switch-read-never-set` | warning | a switch is read by a condition but never set in the document | it always evaluates to its default; if a save or an extension seeds it, ignore the finding |
| `lint/switch-set-never-read` | info | a switch is set but never read | dead write within the document; external code may still read it |
| `lint/variable-read-never-set` | info | a variable is read but never set | may be seeded by a save or extension; otherwise it always reads its default |
| `lint/variable-set-never-read` | info | a variable is set but never read | dead write within the document |
| `lint/selfswitch-read-never-set` | warning | a page requires self switch K=true that no page of the event ever sets | the page can never win; add a `selfSwitch` set or drop the condition |
| `lint/page-condition-contradiction` | error | a page condition is provably false | the page never activates; fix the contradictory clauses |
| `lint/page-shadowed` | error | an earlier page's condition implies a later page's, so the earlier never wins | delete the dead page or strengthen its condition |
| `lint/start-map-missing` | error | the start map is absent, or the start position is out of bounds | fix `start.map` or move the start inside the map |
| `lint/transfer-target-missing` | error | a transfer names an unknown map, or its landing is out of bounds | add the map or fix the id/landing; a transfer to a missing map throws at runtime |
| `lint/place-target-missing` | error | a `place` names an unknown event, or its landing is out of bounds | fix the event id or the landing |
| `lint/route-target-missing` | error | a `moveRoute` names an unknown event | fix the event id |
| `lint/appearance-target-missing` | error | an `appearance` command or condition names an event not on the host map | fix the event id or remove the clause |
| `lint/common-event-missing` | error | a `common` op calls an unknown common event | add the common event or fix the id |
| `lint/item-missing` | error | an item/shop/condition references an item not in the catalog | add the item to the catalog or fix the id |
| `lint/audio-missing` | warning | an audio command or `bgmPlaying` condition references an id absent from a declared `project.audio` table | add the logical id to `project.audio` or fix the reference; partial host-audio packages are allowed, so the precise diagnostic remains visible without failing the check |
| `lint/sprite-missing` | error | a page sprite, `appearance` sprite, appearance-condition sprite, or choices option `icon.sprite` key is not in `project.sprites` | add the sprite or fix the key |
| `lint/sheet-missing` | error | a map sheet, tile id prefix, or item sprite references an unknown runtime tile sheet | add the sheet or fix the id; `walker.sheet` is a build-time source path, not a `project.sheets` id |
| `lint/tileproperty-out-of-bounds` | error | a `tileProperty` command (throws at runtime) or condition (always false) addresses a cell outside the host map | move the cell inside the map or remove the clause |
| `lint/map-unreachable` | warning | no sequence of literal-id transfers reaches the map from the start map | dynamic transfers can still reach it; add a transfer path or remove the map |
| `lint/choices-empty` | error or warning | a choices modal with no options and no cancel (error), or empty branches (warning) | add an option or a cancel branch; give branches commands or remove them |
| `lint/text-variable-token-off` | warning | a `text` line, `choices` prompt/option, or `extChoice` prompt holds a `{v:<id>}` token but `system.textVariables` is off, so the braces print verbatim | set `project.system.textVariables` to `true`, or remove the token |
| `lint/text-token-unknown` | warning | a `text` line, `choices` prompt/option, or `extChoice` prompt holds a `{x:<key>}` token not listed in `system.textTokens` | add the key to `project.system.textTokens`, or fix the token; only reported when the allowlist is declared, and an unanswered token shows `???` at runtime |
| `lint/text-token-off` | warning | a `text` line, `choices` prompt/option, or `extChoice` prompt holds a `{x:<key>}` token but `system.textTokens` is not declared, so the braces print verbatim | declare `project.system.textTokens` (the keys the session resolver answers) to expand the token, or remove it |
| `lint/break-outside-loop` | info | a `break` is not inside any `loop` body (a `break` does not cross a `common` call) | legal (RPG Maker parity): it ends the current page or common event; keep it as an early exit or wrap the commands it should leave in a `loop` |
| `lint/scene-id` | info | a scene id is used by the document but has no registration in it | scene rules are code-side (`SessionOptions.scenes`); register `SceneRules` for it (the kit ships `nameInputRules` / `rpgkit.nameInput` and `numberInputRules` / `rpgkit.numberInput`) or fix the id — an unregistered explicit `scene` id throws at session startup, while `inputNumber` likewise requires its pair before execution reaches it |

### `locks`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `locks/permanent-lock` | error | a page locks input and the isolated engine run never released it within the frame budget | release the lock with `unlockInput` on the lock's own branch, or hand it to an automatic event that provably releases it |

### `freeze` (all errors)

| code | meaning | typical fix |
| --- | --- | --- |
| `freeze/interpreter-error` | the interpreter threw after N frames; the scan aborts the map | fix the command that throws |
| `freeze/permanent-lock` | the input lock was held for the whole window | every `lockInput` needs a matching `unlockInput` on every page path |
| `freeze/blocking-fiber` | a busy fiber made no world progress for the whole window | add an exit condition (a switch/selfSwitch flip, an `erase`, a transfer) so the fiber can end |

### `reach`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `reach/start-unreachable` | error | the start map is missing, or the start tile is not standable | fix `start.map` or move the start to a standable tile |
| `reach/map-not-found` | warning | no replayable witness to the map was found within budget | a lead, not a proof; puzzles, shops, extensions, dynamic transfers, and battle outcomes under non-default rules may still reach it — the frontier names the inbound pages that never ran |
| `reach/witness-replay-failed` | error | a recorded witness did not replay to its map and state in a fresh session | a check-tool bug; report it with the project |
| `reach/transfer-target-missing` | error | a literal transfer targets a map the project does not define | fix the transfer's `map` |
| `reach/transfer-landing-blocked` | warning | a transfer lands on a non-standable tile | move the landing or make the tile standable |
| `reach/map-orphan` | info | no literal transfer points at the map | expected for a map only reached by a dynamic transfer or extension; remove it otherwise |
| `reach/dynamic-transfer` | info | a transfer's target is a variable/expression, not a literal map id | the search does not follow it; ensure the target is reachable another way |

### `explore`

| code | severity | meaning | typical fix |
| --- | --- | --- | --- |
| `explore/never-triggered` | info | an event page never ran within the observation window | expected for story-gated events; `attempted-no-fiber` suggests checking erasure, an empty page, or a facing condition |
| `explore/error` | error | the interpreter errored during exploration | fix the event that errored |

## MCP tools

`rpgkit-check` starts no server of its own; the editing server mounts the
six checks as MCP tools (see [edit-api.md](edit-api.md)). The tool names are
`rpgkit-lint`, `rpgkit-locks`, `rpgkit-freeze`, `rpgkit-reach`,
`rpgkit-explore`, and `rpgkit-shot`, each taking the same arguments as the
CLI `--json` object plus `file`. Only `rpgkit-shot` writes files; the rest
are read-only. MCP inputs are JSON-only and therefore use the default session
fallbacks; `--session` is a CLI-only trusted-code facility.
