# Protocols

One page of pointers to the protocols that keep Pocket RPG Kit usable from
many frontends. An editor, a web page, a CLI, or an AI agent only has to
honor these; the runtime itself does not care which frontend produced its
data.

Each section names the file that is the normative specification. When this
page and a normative file disagree, the normative file wins.

## 1. Project data format — `rpgkit-project/v1`

**Normative: [`../src/data/schema.json`](../src/data/schema.json)** (JSON
Schema 2020-12). A document is a JSON object whose `format` is the literal
`"rpgkit-project/v1"`; the schema defines every field, including the event
commands and the four triggers. The matching TypeScript types are
[`../src/engine/types.ts`](../src/engine/types.ts).

- **Changes** are recorded in
  [`../src/data/CHANGELOG.md`](../src/data/CHANGELOG.md). The format string
  stays `v1` while changes are amendments; see
  [section 6](#6-version-and-compatibility-rules) for what that means in
  practice.
- **Sharded projects.** A large project may replace its `maps` array with a
  `mapIndex` (`ProjectShell` in `types.ts`) plus one canonical JSON entry per
  map. The splitter is `splitProjectMaps` in
  [`../tools/lib/map-project.ts`](../tools/lib/map-project.ts); the runtime
  side is `createJsonMapRepository` in
  [`../src/engine/map-repository.ts`](../src/engine/map-repository.ts). Each
  index entry carries the map's SHA-256, and the shell carries a
  `mapManifestHash` over its canonical JSON. The preimage is the shell with
  **both** declared hash fields removed first — `mapManifestHash` and
  `mapSchemaHash` (`shellWithoutDeclaredHashes` in `map-repository.ts`);
  canonical JSON sorts keys recursively (`canonicalJson` in
  [`../src/engine/save.ts`](../src/engine/save.ts)). `assertShellManifestFresh`
  (exported from `pocket-rpgkit/engine`) verifies a packaged shell before
  release.
- **Schema identity.** `MAP_SCHEMA_HASH` (`src/engine/schema-identity.ts`,
  re-exported from `map-repository.ts`) is
  `sha256(canonicalJson(schema.json))`. It identifies the schema a sharded
  project was built against, and sharded save envelopes carry the same
  identity in `content.schema`. A session, the edit API, the sharded editor
  workspace and the editor file server accept a shell or save whose identity
  is the current one or one of `MAP_SCHEMA_COMPATIBLE_HASHES` — earlier
  identities that differ only by purely additive changes — and refuse any
  other (`shell schema hash mismatch`; save error `content`; the message
  names the refused and the accepted identities). A session
  records the current identity, so saves and editor writes are always
  stamped with it; accepting an older schema identity never relaxes the
  manifest check. The literal is kept in source so inline bundles need not
  embed the schema, and a test pins it to `data/schema.json` so the two
  cannot drift apart.
- **Saves** are a separate envelope, `rpgkit-save/v1`
  (`src/engine/save.ts`): FNV-checksummed, validated by
  `src/engine/save-validate.ts` before live state is replaced.
  - Envelope: `{format: "rpgkit-save/v1", version: 1, frame, checksum,
    content?, state}`. `checksum` is FNV-1a 32 (8 hex digits) over the
    canonical JSON of `state`; `frame` repeats `state.interp.frame`;
    `content` (`{manifest, schema}`) appears in sharded projects.
  - `state`: `map`, `player` (the mover on a tile boundary), `held` (the
    button mask of the save frame), `interp` (the full interpreter state,
    cues and request queues drained), `ext` (the game's extension state,
    `null` when absent) and, since the map runtime was recorded, the
    optional `mapRuntime`: `{chars: {rng, chars: {<event id>: character}},
    playerRoute, fade}`. A character keeps its cell, pixel position, facing,
    step phase, page, visibility and body, wander timer, running `route` and
    page `patrol` (steps, step index, repeat/skip flags, the fiber it
    resumes, wait and path-plan progress). A path search still being
    computed is stored with its buffers as number arrays; the validator
    checks they form the search tree the runtime builds. `playerRoute` is a
    move route running on the player; `fade` is the fade-in after a
    transfer. A save without `mapRuntime` restores as before: characters
    start again from the map on the next tick. With it, a parallel event
    waiting on a saved route resumes when the route finishes; without it,
    such a save is refused (`shape`).
  - Save code: the envelope's UTF-8 JSON as unpadded URL-safe base64
    (`A-Z a-z 0-9 - _`). The compressed form, written by default, is `z1`
    followed by the base64 of the envelope's raw DEFLATE (RFC 1951) stream;
    the uncompressed form begins with `e` (the base64 of `{`). Whitespace is
    ignored. Any other `z` prefix is a newer encoding and is refused with
    `version`; a stream that does not inflate, or inflates past 16 MiB, is
    `bad-json`.

## 2. Edit protocol — `rpgkit-edit`

**Normative: [`edit-api.md`](edit-api.md)** (parameters, outputs, error
codes, exit codes, MCP reference).

A JSON-in/JSON-out editing interface for scripts and agents, over a CLI or
MCP stdio. Every request parses and validates the input document first;
every effective mutation validates again before publishing. An inline
project's file is then atomically replaced (temp file, a re-check that the
target still holds the bytes the edit started from, rename). A sharded project publishes a sequence of per-file renames —
changed shards first, the shell manifest last — with best-effort rollback
of already-published shards if a later rename fails; this is **not**
crash-atomic. See `editor/api/file.ts` and
[`edit-api.md`](edit-api.md#response-envelope) (the atomicity paragraph).

- **Operations** (58): `open`, `list-maps`, `list-events`, `list-pages`,
  `list-commands`, `validate`, `update-map`, `add-map`, `duplicate-map`,
  `delete-map`, `move-map`, `paint-tile`, `paint-rect`, `fill-region`,
  `paint-passage`, `paint-cells`, `paint-edges`, `add-event` (optional
  `index` places the event in the map's event list), `update-event`,
  `delete-event`, `add-page`, `update-page`, `delete-page`,
  `insert-command`, `delete-command`, `update-command`, `batch` (several
  operations as one all-or-nothing transaction), `save`, plus
  `list-items`, `get-item`, `add-item`, `update-item`, `remove-item`,
  `list-sprites`, `get-sprite`, `add-sprite`, `update-sprite`,
  `remove-sprite`, `list-audio`, `get-audio`, `add-audio`, `update-audio`,
  `remove-audio`, `list-sheets`, `get-sheet`, `add-sheet`, `update-sheet`,
  `remove-sheet`, `list-switches`, `get-switch`, `add-switch`,
  `update-switch`, `remove-switch`, `list-variables`, `get-variable`,
  `add-variable`, `update-variable`, and `remove-variable`.
- **Addresses** are stable text paths: `map:<id>`,
  `map:<id>/event:<eid>/page:<i>/command:<key>`, with recursive command keys
  such as `i2:then#0` (if), `c2:option:1#0` (choices), `b2:win#0`
  (battle).
- **Reversible patches** use the `rpgkit-edit/patch-v1` envelope:
  `{ format, beforeHash, afterHash, changes[] }`, each change a JSON Pointer
  plus a `before`/`after` side (`{exists:false}` or `{exists:true,value}`).
  Hashes are SHA-256 over canonical semantic JSON. Forward applies in order
  expecting `before`; reverse applies backwards expecting `after`; a base
  hash mismatch fails closed. Implementation: `editor/api/operations.ts`
  (`diffJson`, `applyEditPatch`).
- **Array diff granularity.** `diffJson` compares equal-length arrays by
  index, and replaces an array as one change when its length changes. There
  is one deliberate order-only exception: when an equal-length array of
  objects with unique string `id` fields is a permutation of the same ids,
  every changed index is a whole-cell replacement. It does not field-diff
  the object that used to occupy that index against the object moved into
  it. This is how `move-map` remains reversible while preserving each map
  object's source property order.
- **Both editors edit through this protocol.** Studio's `EditSession`, the
  CLI and the MCP tools call the text entry point
  (`executeEditOperation` on the document source). The PocketJS editor calls
  the in-memory entry point (`executeProjectOperation` /
  `executeProjectTransaction`), which runs the same mutation, validation and
  diff on an immutable in-memory revision without re-parsing or
  re-serializing per edit; `projectEditPatch` gives the same patch-v1 bytes
  the text entry point reports, and `applyProjectEdit` undoes or redoes an
  edit with the same per-change preconditions as `save`. Both editors keep
  patch-v1 history, so the same edits produce the same patches, undo/redo
  stacks and saved bytes (`tests/editor-api-equivalence.test.ts`).
- **Patterned paint is additive.** `paint-cells` keeps its original
  `{ cells, value }` form and also accepts `{ cells, values }`, where the
  arrays have equal length and each coordinate receives its corresponding
  tile or passage value. Exactly one form is accepted; either form remains
  one operation, one reversible patch and one undo step. Project and patch
  formats are unchanged.
- **Sharded projects are first-class.** The same commands open a
  `ProjectShell` (`add-map`, `duplicate-map`, `delete-map`, `move-map` and
  `paint-edges` are inline-only as direct edits); reads and ordinary map
  mutations load only the addressed
  shard, and `save` publishes only the changed shards plus the shell.
  `validate` loads every shard by default, while `validate {map}` reads only
  the named shard and returns `scopedMap`; a real map-id rename still loads
  every shard so transfers in other maps can follow the rename. A
  shell response's `diff`/`patch` addresses a logical
  `{ kind: "rpgkit-edit/sharded-document-v1", shell, shards }` document,
  with patch paths under `/shell/...` or `/shards/<entry>/...` (the entry is
  one RFC 6901 token). Full contract: [`edit-api.md`](edit-api.md),
  "Sharded `ProjectShell` documents". Project-global `add-item` and
  `add-sprite` mutate only the shell; reviewed proposals additionally support
  structural map operations and publish new/changed shards before the shell.
  A refused direct structural command explicitly points callers to the
  `propose` then `accept-proposal` flow.
- **Browser packs.** The in-browser editor additionally reads and writes a
  self-contained `rpgkit-edit/sharded-pack-v1` file
  (`{ kind, shell: "<json text>", shards: { "<entry>": "<json text>" } }`).
  It is a browser-storage/transport format, not an edit-protocol operation;
  see [`editor/README.md`](../editor/README.md) ("Sharded packs").

## 3. QA protocol — `rpgkit-check`

**Normative: [`qa-checks.md`](qa-checks.md)** (check parameters, output
fields, finding codes, exit codes).

Six checks over any inline `rpgkit-project/v1` document, from the CLI or as
MCP tools mounted on the edit server: `lint` (static health), `locks`
(input-lock audit), `freeze` (forever-blocking scan), `reach`
(real-engine reachability with a replayable witness tape), `explore`
(headless coverage), `shot` (schematic passability/event PNGs).

Five checks (`lint`, `locks`, `freeze`, `reach`, `explore`) print the shared
envelope:

```json
{ "check": "lint", "findings": [], "summary": { "maps": 3 } }
```

`locks` and `freeze` add a `rows` table; `reach` and `explore` add
check-specific fields (budgets, maps reached, events seen). `shot` is the
exception: it prints a bare array of `{ resolution, file, bytes, sha256 }`
entries, one per rendered PNG, with no envelope.

Exit codes (from `tools/rpgkit-check/cli.ts`):

| code | meaning |
| --- | --- |
| 0 | no error-severity findings — warnings and info never fail a check |
| 1 | the report contains at least one `error`-severity finding |
| 2 | usage error, invalid `--json`, a thrown error, or a document that cannot be loaded (a load failure still prints a structured report with `doc/*` findings and `summary.loadError`) |

Because `shot` returns an array (no `findings`), it exits 0 on success even
when it renders warning-worthy content.

## 4. Proposal protocol — `rpgkit-edit/proposal-v1`

**Normative: [`../editor/proposals/schema.json`](../editor/proposals/schema.json)**
(JSON Schema 2020-12), implemented in `editor/proposals/` and
`editor/api/proposals.ts`. Status: **implemented** (desktop editor review
queue, CLI and MCP lifecycle; inline and sharded projects).

A proposal is one JSON file describing reviewed edits before they touch a
project. Proposals live in a sidecar directory next to the project file:
`<projectFile>.proposals/<id>.json`; fully reviewed proposals move to
`<projectFile>.proposals/archive/<id>.json`. The filename must equal the
proposal's `id`.

```json
{
  "id": "docs-demo",
  "title": "Rename the project",
  "rationale": "Demonstrate a reviewed edit.",
  "author": "docs",
  "createdAt": "2026-10-01T12:00:00Z",
  "baseHash": "b61f2311f44fcca2636d048898ac4f4abe1bd99d2fe27a82fdef6cebede30a65",
  "hunks": [
    {
      "id": "rename",
      "summary": "Change the project title",
      "changes": [
        { "path": "/title", "before": { "exists": true, "value": "Proposal Demo" }, "after": { "exists": true, "value": "Proposal Demo (edited)" } }
      ]
    }
  ]
}
```

The example above is exercised by a test end to end: it validates against
the schema, its `baseHash` matches the semantic hash of the minimal project
below, and the hunk applies cleanly to it, leaving the title changed.

```json
{
  "format": "rpgkit-project/v1",
  "title": "Proposal Demo",
  "tileSize": 16,
  "start": { "map": "yard", "x": 0, "y": 0, "dir": "down" },
  "sheets": [{ "id": "town", "cols": 12, "rows": 11, "pak": "chunks" }],
  "items": [],
  "maps": [{ "id": "yard", "name": "Yard", "width": 1, "height": 1, "sheets": ["town"], "ground": ["town.0"], "events": [] }]
}
```

Contract:

- **Required fields** (no `format` field; `additionalProperties` is false):
  `id` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), `title` (1–160 chars),
  `rationale` (1–4000), `author` (1–160), `createdAt` (UTC ISO-8601 with
  `Z`), `baseHash` (64 lowercase hex), and `hunks` (at least one).
- **Hunks** need `id`, `summary` (1–240), a `changes` array, and at least one
  change or one attached asset; a hunk may carry a `decision` while under
  review.
- **Changes** are `{ path, before, after }`. `path` is a JSON Pointer
  (root `""` or leading `/`); `before`/`after` are sides
  (`{ "exists": false }` or `{ "exists": true, "value": <any JSON> }`).
  Beyond the schema, the implementation requires unique hunk ids, canonical
  decimal array tokens, and non-overlapping change paths across hunks.
- **Assets** are an optional `assets` object keyed by confined
  project-relative path. Each value is
  `{ "type": "image/png", "data": <canonical padded base64> }`. PNG shape,
  byte/pixel/count limits, unique paths across hunks, and symlink/path escape
  protections are checked before creation or publication. Assets are
  immutable additions: missing bytes are clean, identical bytes are already
  applied, and different bytes conflict.
- **Applying** (`applyProposalHunks`): every selected hunk must assess
  `clean` (each change's `before` matches the project and each attachment is
  absent), then the changes
  apply through the proposal module's own `setSide` and the result is
  schema-validated as one transaction. `setSide` permits adding, replacing
  or deleting an **object property**, and replacing an **existing array
  index**; it refuses array appends (`/-`), array element deletes, and
  removing the document root. To grow an array, replace the whole array at
  its parent path.
- **`baseHash`** is the SHA-256 of the project's canonical semantic JSON
  (`proposalSemanticHash`). A mismatch means the proposal is stale; the
  editor shows live conflict state per hunk (`clean` / `conflict` /
  `already-applied` / `partially-applied`).
- **Decisions** are `{ "status": "accepted" | "rejected", "decidedAt":
  <UTC ISO-8601>, "source"?: string }`, omitted while a hunk waits for
  review. Review persistence may only add decisions, never rewrite the
  proposal payload. Accepting/rejecting is available in the desktop editor
  and through the CLI/MCP commands `accept-proposal`, `reject-proposal`,
  and `list-archive`; the CLI also offers `propose`, `list-proposals`,
  `show-proposal` and `withdraw-proposal`. Whole-proposal acceptance publishes
  assets, then project files, then the archive transition. A failure restores
  project/assets and leaves the proposal pending; an unverifiable rollback is
  reported as `PROPOSAL_PARTIAL_WRITE` with `written: true`.
- **QA sidecar**: `propose` stores `qa/<id>.json` below the pending directory;
  a decision moves it to `archive/qa/<id>.json`. It holds
  `{checkedAt, documentHash, findings[], errors, warnings, infos, baseline?}`.
  The versioned baseline is bound to proposal id and base hash and contains
  creation-time errors, so unchanged old corpus errors remain acceptable but
  a new, moved, or duplicated error blocks. Legacy adjacent `<id>.qa.json`
  files remain readable and fail closed when errors exist. `accept-proposal`
  re-runs schema and the full static lint (references, page health,
  transfer-graph reachability) over the live proposed document.
- **Sharded projects**: a proposal next to a ProjectShell stores hunks over
  the sparse `{shell, shards}` logical document with `/shell/...` and
  `/shards/<entry>/...` paths. Derived shell metadata (mapIndex checksums
  and dimensions, manifest hash) is not stored in hunks; it is rebuilt from
  the shards at accept time. Operation execution and conflict assessment load
  only touched shards, while creation-time and accept-time QA materialize the
  full map corpus. `add-map`, `duplicate-map`, `move-map`, `delete-map`, and
  `connect-maps` are supported for both JSON and compact `.rkm` shards; new
  shard files are created atomically and the shell remains the last commit
  marker.

## 5. Preview protocol — `rpgkit-preview/v1`

**Normative: this section.** A web frontend embeds the real engine in an
iframe and drives it with `postMessage`. The kit ships a host app (the
`preview` player page, `tools/preview/`) and a reference frontend
(`/preview-demo.html` on the site, source
[`../tools/web/preview-demo.html`](../tools/web/preview-demo.html)); Studio's
play-test panel is a second frontend ([Studio](studio.md#play-test)). The
host plays an arbitrary `rpgkit-project/v1` document through the production
`GameView` with the editor playtest art, or with the project's own images
when the frontend supplies them (see [Project art](#project-art)), so no game
bundle or baked pak is needed.

### Transport

- Every request is a `postMessage` JSON object. The host only accepts
  messages from origins it is configured for: its own origin always, plus
  any `?preview-origin=<origin>` query parameters on the host page URL
  (repeatable, comma-separated). Messages from other origins are dropped
  without a reply. The opaque `null` origin is never allowed.
- Replies target `event.origin`; the host never uses `*` for replies.
- A frontend must accept replies and the `ready` event only from the iframe
  window it embedded (`event.source === hostFrame.contentWindow`), in
  addition to checking `event.origin`. A message from any other window —
  even same-origin — is a spoof and is ignored. The reference frontend
  does both checks.

### Limits

Every host enforces these bounds before doing expensive work
(stringify, validation, traversal). The constants live in
`tools/preview/protocol.ts` (`PREVIEW_LIMITS`); an over-budget message is
refused with `error.code: "too-large"` and never reaches the backend.
Every reply — success, parse error and backend error alike — leaves
through one exit that measures it by the same rule before it is sent: a
reply over the whole-message bound (for example a `state` reply carrying an
enormous dialogue text, or a backend error with a huge message) is replaced
by a short `ok: false` reply with `error.code: "too-large"`, so a host never
posts more than 4 MiB. Error messages that quote a request value (an
unsupported `protocol`, an unknown `type`) quote at most 64 characters of
it, followed by `... (truncated, N chars)`; a non-string value is named by
kind (`an object`, `an array`). Notifications (`input`/`stop` without a
`requestId`) never get a reply, whatever happens.

| Bound | Value | What is counted |
| --- | --- | --- |
| Whole message | 4 MiB | Structural JSON size: string UTF-8 bytes, 8 per number, 4 per boolean/null, plus container overhead. The check walks only until the budget is exceeded, so an oversized message costs work proportional to the budget, not to the message. |
| Chapters per `load` | 64 | `chapters.length` |
| One chapter snapshot | 1 MiB | Save-code string bytes, or the structural size of a snapshot object |
| One chapter tape | 36,000 frames | `tape.length` (u16 masks) |
| `requestId` | 128 bytes | UTF-8 length |
| Staged images | 1,024 | Images staged by `art` at once, complete or not |
| Staged image bytes | 32 MiB | Sum of `width * height * 4` over the staged images, reserved by each image's first slice |
| Image side | 4,096 px | `width` and `height` of one `art` image |
| Image id | 256 bytes | UTF-8 length of an `art` `id` |

String bytes follow the UTF-8 encoding of the wire string itself: a lone
surrogate counts as the 3-byte U+FFFD (exactly what `TextEncoder` produces),
and a high/low surrogate pair counts as one 4-byte scalar. The walk stops the
moment the running total exceeds the budget, so an oversized string costs
work proportional to the budget, not to the string.

### Messages

All requests carry `protocol: "rpgkit-preview/v1"`. `load`, `art`, `start`
and `state` require a `requestId` string; `input` and `stop` may omit it (no
reply is sent then). A `requestId` that is present but not a non-empty
bounded string (a number, an object, an empty string, or over 128 bytes)
refuses the whole message: it is never demoted to a fire-and-forget
notification, and it gets no reply (there is no valid correlation key).

| Request | Fields | Reply `result` |
| --- | --- | --- |
| `load` | `document`: project JSON text or object; optional `chapters`: `[{id, title, snapshot, tape?}]` (save snapshot/code + u16 tape, for `start` by chapter); optional `art: true` (draw the staged images) | `{title, maps: [{id, name, width, height}], start: {map, x, y, dir}, glyphs: {added, missing}}` (`glyphs`: the document's characters the host baked at load beyond its built-in ones, and the ones it has no glyph for, drawn as boxes), plus `art: {used, skipped: [{kind, id, reason}]}` when the load asked for art |
| `art` | `kind` (`sheet` or `sprite`), `id`, `width`, `height`, `offset`, `rgba` (base64 of RGBA8 bytes starting at byte `offset` of the image) | `{received, complete, staged}`: bytes of this image so far, whether it is whole, images staged |
| `start` | `map` + `x` + `y` + optional `dir` (`down`/`left`/`up`/`right`), **or** `chapter` (a chapter id supplied with `load`) | `{map, x, y, dir}` after the warp/restore |
| `state` | — | `{status, map, x, y, px, py, dir, moving, frame, running, event, message, switches, variables, gold, items}` |
| `input` | `buttons`: u16 mask; optional `frames` (1–600, default 1) | empty ok |
| `stop` | — | empty ok; unmounts the project |

Reply envelope: `{protocol, type: "reply", requestId, ok: true, result}` or
`{..., ok: false, error: {code, message}}`. The host also sends one
unsolicited event on boot: `{protocol, type: "event", event: "ready",
version: 1, features: ["art"]}` (to `window.parent`, target `*`). `features`
is an optional addition within v1 listing the optional capabilities the host
has; a host without the field has none, and a frontend ignores names it does
not know.

In a `state` reply, `frame` is the session frame counter (it advances once
per simulated frame), `running` counts the event pages running now (the main
one plus parallels), `event` is the `map/event` key of the page in the main
slot or null, and `message` is the open message box or null:
`{kind: "text", text}` with the dialogue lines joined by newlines,
`{kind: "choices", text}` with the prompt and options one per line, or
`{kind: "shop", text: ""}`. These four fields are optional additions
within v1: the preview host always sends them, but a frontend must accept a
`state` reply without them (the public `PreviewStateResult` type marks them
optional), and a frontend written before them ignores them.

`load` validates the document through the editor's schema gate; a JSON or
schema failure is refused with `error.code: "bad-document"` and the first
error. Sharded (`mapIndex`) documents are refused. `start` to a tile uses
the demo runtime's validated warp (the cell must be in bounds, standable and
free of authored events). A chapter start restores the snapshot and, when
the chapter carries a tape, plays it from the snapshot's frame zero.
`input` holds the mask for `frames` host frames then releases, through the
attract controller's tape path, so edges arise exactly as from live input.

A notification (`input`/`stop` without `requestId`) has no reply channel:
the host runs it inside the same error boundary as replies, so a backend
error stays contained and never reaches the browser's event loop. The
notification contract is silent failure.

Error codes: `bad-message`, `bad-version`, `not-loaded` (before `load` or
after `stop`), `bad-document`, `unknown-map`, `bad-start`,
`unknown-chapter`, `bad-input`, `too-large` (a wire limit from the table
above), `internal`.

### Project art

A host that lists `"art"` in its `ready` features draws a project's own
images instead of the stand-ins. The frontend stages each image with `art`
requests, then sends `load` with `art: true`:

- An image is keyed by `kind` and `id`: a `sheet` by its sheet id, a
  `sprite` by its sprite id (an image sprite's picture, or a walker's whole
  sheet). Its bytes are `width * height * 4` RGBA8, row-major.
- An image larger than one message goes in several slices, in order: the
  first at `offset: 0`, each next one exactly where the previous ended, with
  the same `width`/`height`. Base64 inflates bytes by 4/3, so a frontend
  keeps a slice's raw bytes to about 2 MiB (`PREVIEW_ART_SLICE_BYTES`) to
  stay under the 4 MiB message bound. A slice at offset 0 starts the image
  afresh. The image is complete when all its bytes have arrived.
- `bad-message`: a `kind` other than `sheet`/`sprite`, an empty id, a
  non-integer size or offset, `rgba` that is not strict standard base64
  (RFC 4648 alphabet, `=` padding, no whitespace), a slice that runs past the
  image, an out-of-order offset, or a size that differs from the image's
  first slice. `too-large`: a side over 4,096 px, or an image or a new image
  that would pass the staged-image or staged-byte bounds. A refused slice
  leaves the staged image as it was.
- `load` with `art: true` draws the complete staged images; incomplete ones
  are ignored. Every `load` empties the staging area, so a `load` without
  `art` discards staged images and plays with stand-ins as before; `stop`
  empties it too. The reply's `art.used` counts the images the game now
  draws, and `art.skipped` lists complete images it could not use (each
  keeps its stand-in): a sheet that is not a whole number of 16 px cells, a
  sprite the document does not declare, an image sprite over 512 px, a
  walker sheet that does not match its declared `cols` x `rows` grid of
  16 x `h` cells, or a legacy atlas walker.
- A sheet is cut into 16 px cells, streamed like baked tiles. An image
  sprite is drawn as is (a side that is not a power of two is resampled to
  the next one). A walker sheet is cut into the twelve frames the asset
  baker cuts (`tools/lib/walker-slice.ts`, shared with `tools/lib/bake.ts`).
  Their textures are freed by the next `load` or `stop`.
- Art only changes what is drawn. The session, and so every `state` reply,
  is the same with and without it for the same document and inputs
  (`tests/preview-art-sim.test.ts` checks this on the wasm sim).

Compatibility runs both ways. A frontend that never sends `art` (or a
`load` without `art`) gets exactly the earlier behaviour. A frontend sends
`art` only to a host whose `ready` lists the feature: an older host has no
`features`, would refuse `art` as an unknown type, and would ignore
`load.art`.

The same operations are available on the host page as
`globalThis.__rpgkitPreview` for same-origin drivers and tests (`art` takes
the request's fields). The pure
protocol core (allowlist, parsing, dispatch, byte budget) is
`tools/preview/protocol.ts`, unit-tested in
`tests/preview-protocol.test.ts`; the end-to-end browser path — including
the limit boundary, requestId refusal, notification containment and
same-origin spoof rejection — is `tools/web-verify.ts` (the `preview`
check).

## 6. Version and compatibility rules

- **`rpgkit-project/v1`.** The schema is the contract; every change is
  recorded in `src/data/CHANGELOG.md` and, if normative, changes
  `MAP_SCHEMA_HASH`. The format string stays `v1` for amendments — new
  optional fields, new commands or conditions, and loosened constraints.
  The v1 history also contains a small number of **semantic changes** that
  were folded in as amendments with explicit migration notes, including:
  `dirBlock` edges became bidirectional (a one-way exit now needs a
  `passage` override); moving characters are stopped only by `blocks: true`
  pages; `variable` division floors toward negative infinity and
  div/mod-by-zero leaves the variable unchanged; transfer failures enter
  the fatal content-error state instead of throwing from the host; and save
  validation requires safe integers. A document that relied on the old
  behavior follows the changelog note. A genuinely breaking change — one
  that cannot be absorbed as an amendment — gets a new marker
  (`rpgkit-project/v2`) and a new changelog entry. Frontends detect
  compatibility from the `format` field, and sharded projects additionally
  from `mapSchemaHash` (see the next item).
- **Schema identity compatibility.** Every normative schema edit changes
  `MAP_SCHEMA_HASH`. A change is *purely additive* when every document valid
  under the previous schema is still valid and behaves exactly as before: a
  new optional property, a new command or condition variant, a new enum
  value, a loosened limit. The outgoing identity then joins
  `MAP_SCHEMA_COMPATIBLE_HASHES`, and existing sharded shells and their saves
  keep loading without a rebuild. A new required field, a removed or narrowed
  value, or an existing field that behaves differently — even only for
  unusual values, or in a change that also adds a command — is *breaking*:
  the list is cleared, and older shells and saves are refused until a
  migration exists. Compatibility carries across generations, so only the
  identities after the most recent breaking change are listed (today just
  the identity before optional choice icons). `src/data/CHANGELOG.md` ("Schema identities") lists every identity
  and its classification; `tests/schema-compat.test.ts` keeps that table,
  the list and the real per-generation fixtures in
  `tests/fixtures/schema-compat` in step, so a schema edit cannot land
  without choosing one of the two paths; each breaking change also keeps a
  counterexample recorded by the release before it. A shell that omits
  `mapSchemaHash` is not checked against the list: it is read as the current
  schema and saved under the current identity.
- **`rpgkit-save/v1`.** The envelope carries `format` and `version`; a
  mismatch is a typed rejection, never a silent migration. The public
  `SaveErrorCode` values are `bad-json` (empty, malformed or non-UTF-8 save
  data, envelope JSON over 16 MiB, or JSON nested deeper than 128 levels;
  the size is the text's UTF-8 byte count, measured before parsing and only
  until it passes 16,777,216, with a lone surrogate counted as 3 bytes and a
  surrogate pair as 4), `format` (not an `rpgkit-save/v1` envelope), `version` (envelope
  version this build cannot load), `checksum` (FNV mismatch), `content`
  (sharded-project identity mismatch: a different manifest, or a schema
  identity that is neither current nor listed as compatible) and `shape`
  (envelope or state fails validation). Old saves that omit newer optional
  fields keep their defaults. Adding an optional field to the snapshot (the
  map runtime is the latest) keeps `rpgkit-save/v1`: older saves still load,
  and an older runtime ignores the new field on any save its own checks
  accept (it refuses one whose parallel event waits on a saved move route,
  and it reads only uncompressed save codes). The project schema, and with
  it the schema identity, is unchanged by snapshot-only additions. The
  session-level loader (`loadSession`) adds `not-safe-point` for a save
  attempted off a safe point and `map-not-ready` when an asynchronous map
  repository must load the saved map first.
- **`rpgkit-edit/patch-v1`.** The patch format is versioned in its `format`
  field. `beforeHash`/`afterHash` fail closed, so a patch can neither probe
  nor apply against a changed base.
- **`rpgkit-preview/v1`.** The protocol string travels on every message and
  the host announces itself with a `ready` event. Additive changes — new
  optional request or reply fields, new message types, new error codes —
  stay v1; a
  frontend ignores what it does not know. Changing the meaning or shape of
  an existing message, or removing one, bumps the protocol to `v2`, and a
  host replies `bad-version` to a protocol it does not speak. Frontends
  should wait for `ready`, then gate features on the announced protocol and
  version.
