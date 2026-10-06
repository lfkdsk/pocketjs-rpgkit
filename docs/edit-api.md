# `rpgkit-edit` API reference

`rpgkit-edit` exposes the editor's pure document model as a stable
JSON-in/JSON-out command line, for scripts and coding agents. Every request
parses and validates the input document first; every effective mutation is
validated again, returns JSON Pointer changes with before/after values and a
reversible `rpgkit-edit/patch-v1` patch, and replaces either one inline file
or the changed map shards plus their `ProjectShell` manifest.
Proposal creation and review commands manage a sidecar queue for both inline
and sharded projects. Creating, listing, showing and withdrawing a proposal do
not edit the project; accepting one applies its clean hunks and attached PNGs
as one rollback-protected transaction before archiving it.

The same operations are available as MCP tools; see [MCP tools](#mcp-tools).

## Invocation

```sh
bun tools/rpgkit-edit/cli.ts <command> --file <project.json> [--json '<args>'] [--map <id>] [--dry-run]
```

Use that direct entry for machine consumption: stdout is exactly one JSON
object on success and failure, and the CLI itself writes no wrapper text to
stderr. `bun run rpgkit-edit …` remains a convenient interactive alias, but
Bun may print its `$ bun …` launcher line and a nonzero-exit diagnostic to
stderr; do not merge that stream into JSON stdout.

The commands are `open`, `list-maps`, `list-events`, `list-pages`,
`list-commands`, `add-item`, `add-sprite`, `update-map`, `add-map`,
`duplicate-map`, `delete-map`,
`move-map`, `paint-tile`, `paint-rect`, `fill-region`, `paint-passage`,
`paint-cells`, `paint-edges`, `add-event`, `update-event`, `delete-event`,
`add-page`, `update-page`, `delete-page`, `insert-command`, `delete-command`,
`update-command`, `batch`, `validate`, `save`, `propose`, `list-proposals`,
`show-proposal`, `withdraw-proposal`, `accept-proposal`, `reject-proposal`,
and `list-archive`. The six project catalogs add
`list-<plural>`, `get-<singular>`, `add-<singular>`, `update-<singular>`, and
`remove-<singular>` for `items`/`item`, `sprites`/`sprite`, `audio`/`audio`,
`sheets`/`sheet`, `switches`/`switch`, and `variables`/`variable`.

### Common flags

| flag | meaning |
| --- | --- |
| `--file <path>` | inline project or sharded `ProjectShell`. Required for every command. Shard entries resolve relative to the shell. |
| `--json <json>` | arguments object: an inline JSON string or `@path/to/args.json`. A relative `@path` resolves from the directory containing `--file`, independent of the CLI process directory. Defaults to `{}`. |
| `--map <id>` | `validate` only: validate one map. This overrides a `map` value in `--json`; a shell reads only that map's shard. |
| `--dry-run` | project mutations and proposal create/withdraw/accept/reject: run full validation but do not write the project, assets, or sidecar. Read commands accept it only as a reported no-op. |
| `--help`, `-h` | print usage, exit 0. |

## Response envelope

The direct entry prints exactly one JSON object on stdout.
This subsection describes project read/edit commands; proposal commands use
the [proposal envelope](#proposal-request-and-validation) below.

Success:

```json
{
  "ok": true,
  "command": "paint-tile",
  "project": { "format": "rpgkit-project/v1", "title": "...", "documentKind": "inline", "editable": true, "mapCount": 3, "revision": "57b3…" },
  "changed": true,
  "addresses": ["map:village/layer:ground/tile:1,1"],
  "diff": [ { "path": "/maps/0/ground/21", "before": { "exists": true, "value": "town.0" }, "after": { "exists": true, "value": "town.42" } } ],
  "patch": { "format": "rpgkit-edit/patch-v1", "beforeHash": "…", "afterHash": "…", "changes": [ … ] },
  "result": { "map": "village", "layer": "ground", "tile": "town.42", "cells": 1 },
  "file": "sunstone/data/sunstone.json",
  "dryRun": false,
  "written": true
}
```

- `project` is a summary of the document; `revision` is the SHA-256 of its
  canonical semantic JSON. For a shell this is the operation's bounded
  logical view: shell only for `open`/`list-maps`, shell plus one target shard
  for ordinary map operations, shell plus the start shard for a project
  catalog add/update, all shards for catalog list/get/remove, unscoped
  validation or a map-id rename, one target shard for scoped validation, or
  the patch-addressed shards for `save`.
- `changed` is false when the edit was a no-op (for example painting a tile
  with the value it already has); `diff` and `patch` are still returned.
- `patch` is present on successful mutating commands.
- `result` is command-specific; documented per command below.
- `file`, `dryRun`, and `written` are added by the file adapter. A successful
  sharded mutation also returns `writtenFiles` in commit order: changed map
  shards first, then the shell.

Failure:

```json
{ "ok": false, "command": "delete-page", "error": { "code": "LAST_PAGE", "message": "…" }, "file": "…", "dryRun": false, "written": false }
```

`error` may also carry `path`, `expected`, `actual`, or `details`. Error
codes include `READ_FAILED`, `WRITE_FAILED`, `WRITE_CONFLICT`,
`PATH_OUTSIDE_ROOT` (file layer), `UNKNOWN_COMMAND`, `INVALID_ARGUMENT`,
`INVALID_DOCUMENT`, `MAP_NOT_FOUND`,
`EVENT_NOT_FOUND`, `PAGE_NOT_FOUND`, `OUT_OF_BOUNDS`, `INVALID_TILE`,
`DUPLICATE_EVENT`, `DUPLICATE_RESOURCE`, `RESOURCE_NOT_FOUND`,
`RESOURCE_IN_USE`, `LAST_PAGE`, `MAP_DELETE_REFUSED`, `COMMAND_ADDRESS_NOT_FOUND`,
`READ_ONLY_COMMAND`, `READ_ONLY_PROJECT_SHELL`, `UNSUPPORTED_FOR_SHELL`,
`INVALID_COMMAND_FIELD`, `INVALID_PATCH`,
`PATCH_BASE_MISMATCH`, `PATCH_CHANGE_MISMATCH`, `INVALID_JSON_VALUE`,
`INVALID_EDIT`, and `INTERNAL_ERROR`.

For a shell, `INVALID_DOCUMENT` includes stale manifest/schema identities and
shard checksum/schema/metadata mismatches; `READ_FAILED` covers a required
missing shard; `PATH_OUTSIDE_ROOT` covers an unsafe entry; and
`WRITE_CONFLICT` covers drift in either the shell or a targeted shard.

Inline writes are atomic: a temp file in the same directory is written, the
target's current bytes are re-checked against the revision the edit started
from, and the temp file is renamed over the target. Sharded writes stage every changed shard and the shell, re-check all
source bytes before the first rename, then publish shards first and the shell
manifest last. An ordinary later rename failure triggers best-effort rollback
of already-published shards. If any input changed before publication, the
command fails with `WRITE_CONFLICT` and publishes nothing. This ordering keeps
the old manifest live until the final step, but a multi-file save is not
crash-atomic.

## Addresses

Stable text addresses identify every editable thing:

```
map:<id>
map:<id>/layer:<ground|upper|passage>/tile:<x>,<y>
map:<id>/event:<eid>
map:<id>/event:<eid>/page:<i>
map:<id>/event:<eid>/page:<i>/command:<key>
sheet:<sheet>/cell:<n>
item:<id>
sprite:<id>
audio:<id>
sheet:<id>
switch:<id>
variable:<id>
```

`sheet:<sheet>/cell:<n>` names a project-global sheet `dirEdges` entry, as
changed by `paint-edges`.

Command keys address the recursive command tree:

| key | meaning |
| --- | --- |
| `root#2` | command 2 at the page root |
| `i2:then#0` | command 0 in the `then` branch of the `if` at index 2 (`i2:else#…` for else) |
| `c2:option:1#0` | command 0 in option 1 of the `choices` at index 2 |
| `c2:cancel#0` | command 0 in the cancel branch of the `choices` at index 2 |
| `b2:win#0` | command 0 in the win branch of the `battle` at index 2 (`b2:lose#…`, `b2:escape#…`) |
| `s2:done#0` | command 0 in the `onDone` branch of the `scene` at index 2 (`s2:cancel#…` for `onCancel`) |
| `l2:body#0` | command 0 in the body of the `loop` at index 2 |

Segments nest left to right with `/`: `l0:body/i1:then#0` is command 0 in
the `then` branch of the `if` at index 1 of the body of the `loop` at root
index 0.

The structured form used by the command-editing args is
`{ "path": [ …segments ], "index": n }`, where each segment is one of
`{ "kind": "if", "index": n, "branch": "then"|"else" }`,
`{ "kind": "choices", "index": n, "branch": "option", "option": n }`,
`{ "kind": "choices", "index": n, "branch": "cancel" }`,
`{ "kind": "battle", "index": n, "branch": "win"|"lose"|"escape" }`,
`{ "kind": "scene", "index": n, "branch": "done"|"cancel" }`, or
`{ "kind": "loop", "index": n, "branch": "body" }`.
For inserts, `index` may equal the addressed list's length.

## Sharded `ProjectShell` documents

The CLI and MCP tools accept the same commands for an inline document and a
`ProjectShell`, except the five structural commands listed below. The shell
remains the catalog and content-identity record; map payloads stay in the
files named by `mapIndex[].entry`.

- `open` and `list-maps` read no shard files.
- A project-catalog `list-*`, `get-*`, or `remove-*` reads and validates every
  shard so implicit switch/variable ids and references cannot be missed.
  Catalog `add-*` and `update-*` load only the start-map shard (except
  `add-item` and `add-sprite`, which load no shard at all). Every effective
  catalog mutation changes and writes only the shell; a refused removal
  writes nothing.
- `add-item` and `add-sprite` update project-global shell catalogs without
  loading a map shard, then refresh the manifest identity.
- A map read or ordinary mutation loads and validates only the addressed
  shard. Its raw SHA-256, id and dimensions must match the index entry.
  Shards may be plain JSON or `rpgkit-map/1` compact envelopes (the
  importer's default): the edit API decodes a compact shard before
  validating and re-encodes it compact on write, so a project keeps its
  on-disk format. JSON shards stay JSON.
- `validate` with no `map` loads every shard. `validate {"map":"town"}`
  loads only that map's shard and returns `scopedMap`; a missing id is
  `MAP_NOT_FOUND`. Renaming a map id also loads every shard so literal
  transfers in other maps can follow the rename.
- `add-map`, `duplicate-map`, `delete-map`, `move-map`, and `paint-edges`
  fail with `UNSUPPORTED_FOR_SHELL` before any shard is read. Patch-v1 keeps
  every `mapIndex` entry stable and in place (so a reverse patch can
  reacquire the same files; map order is the `mapIndex` order), and sheet
  `dirEdges` are project-global shell data. `paint-cells` loads only
  its target shard, like `paint-tile`.
- An effective mutation canonicalizes only byte-changed map payloads, updates
  their index metadata/checksums, refreshes `mapSchemaHash` and
  `mapManifestHash`, and writes only those shards plus the shell.
- Shard entries must be confined relative paths beneath the configured MCP
  root (or beneath the shell directory for the CLI). Traversal, absolute
  paths, symlink escapes, physical aliases, and an entry resolving to the
  shell itself are refused.

Those restrictions apply to direct reversible edits. A reviewed proposal may
add, duplicate, move, delete and connect shell maps; acceptance creates or
removes the corresponding shard files and publishes the refreshed shell last.
The five refused direct commands return `UNSUPPORTED_FOR_SHELL` with a prompt
to use `propose` and then `accept-proposal` rather than leaving the caller at a
dead end.

For example, this changes one map shard and its shell without loading the
other maps:

```sh
bun run rpgkit-edit paint-tile --file game/data/project.json \
  --json '{"map":"town","x":4,"y":6,"tile":"outdoor.12"}'
```

The response's `diff` and `patch` use a logical document rather than
pretending all resources are one JSON file:

```json
{
  "kind": "rpgkit-edit/sharded-document-v1",
  "shell": { "format": "rpgkit-project/v1", "mapIndex": [] },
  "shards": { "maps/town.json": { "id": "town" } }
}
```

Patch paths are `/shell/...` or `/shards/<entry>/...`, with the entry encoded
as one RFC 6901 token. Thus `maps/town.json` appears as
`/shards/maps~1town.json/ground/124`. Entry strings remain stable across a
patch; map ids may change. A sharded patch hash covers the shell plus exactly
the shard payloads involved in that operation, while the shell manifest
commits the checksums of untouched shards.

### Sharded packs and their art

Browser front-ends exchange a sharded project as one
`rpgkit-edit/sharded-pack-v1` file: the shell text and every shard text as
JSON strings (`editor/api/pack.ts`, format in `editor/api/pack-format.ts`).
A pack may also carry the project's own art in an optional `assets` object,
written after `shards`:

```json
{
  "kind": "rpgkit-edit/sharded-pack-v1",
  "shell": "<shell JSON text>",
  "shards": { "maps/town.json": "<shard JSON text>" },
  "assets": {
    "art/sheets/town.png": { "type": "image/png", "data": "<base64>" },
    "assets/npc/wiz.png": { "type": "image/png", "data": "<base64>" }
  }
}
```

- Each key is the relative path the project names the image by: a sprite's
  `src` or `sheet`, an animation's `sheet`, or a conventional path such as
  `art/sheets/<sheet id>.png` or `art/parallaxes/<parallax id>.png` (see
  [`studio.md`](studio.md), "Project art").
  Keys follow the shard-entry rule: portable POSIX-relative paths, no
  absolute paths, `..`, `.`, empty segments, backslashes or control
  characters.
- Each value has exactly `type` (only `"image/png"`) and `data` (the file's
  bytes in standard padded base64, with no whitespace and zero unused bits).
  The data must decode to a PNG whose header passes the local-PNG limits.
- Limits: at most 4,096 images, each at most 16 MiB and 8,192 px on a side
  (16,777,216 pixels), and at most 32 MiB of images in total, decoded. The
  whole pack text stays capped at 64 MiB. An image's size is checked from
  its base64 length before it is decoded.
- A malformed key, value, type, base64 text or PNG is refused with
  `INVALID_PACK`; a pack over a count or size limit with `TOO_LARGE`.

Assets are opaque to editing: no operation changes them, undo and redo do
not touch them, and a re-serialized pack writes them back unchanged in the
same order. `assets` is written only when it has at least one image, so a
pack without art keeps exactly the bytes it had before assets existed. The
browser player applies the same asset count, decoded-byte, PNG and dimension
limits when it opens a pack, then retains every accepted base64 string
byte-for-byte.

## Materialize and pack

`materialize` converts between an inline `rpgkit-project/v1` document and a
sharded `ProjectShell` on disk, in both directions. It is a file-level
conversion (no patch envelope); the CLI and MCP tool are
`materialize` and `rpgkit_project_materialize`.

```sh
# shell + shards -> one inline document. A full-project materialize also
# records the shell's per-map transports in a sidecar next to the output,
# so the default pack below round-trips a mixed-transport shell.
bun run rpgkit-edit materialize --file game/data/project.json \
  --json '{"direction":"inline","out":"game-inline.json"}'

# inline document -> shell + per-map shards under a directory. With no
# encoding and no fromShell, pack reproduces the recorded transports.
bun run rpgkit-edit materialize --file game-inline.json \
  --json '{"direction":"pack","out":"game-data"}'
```

- `direction`: `"inline"` (a shell file) or `"pack"` (an inline document).
- `map` (inline only): materialize just that map's `MapDef` instead of the
  whole project. With `out` it writes one map file; without, the map JSON is
  returned in `result.text`.
- `out`: a file for inline (required for a full project), a directory for
  pack (required). `pack` refuses to overwrite any existing output file.
- `encoding` (pack only): `json`, `compact`, or `auto`. An explicit value
  opts out of the transports recorded by the inline step and decides every
  map (`auto`: compact when it is smaller — the importer's default).
- `fromShell` (pack only): the shell the inline document was materialized
  from. Each map keeps that shell's entry path and transport (JSON or
  compact); maps not in the reference shell use `encoding`. Overrides the
  recorded transports.

A full-project `inline` writes a `.rpgkit-transports` sidecar next to `out`
recording each map's entry path and encoding. A default `pack` (no
`encoding`, no `fromShell`) reads that sidecar and reproduces every
transport, so a shell that mixed transports (the importer's oversize-shard
JSON fallback plus compact shards) round-trips byte-for-byte through the
two-step flow with no flags. A document without a sidecar falls back to
`encoding` (default `auto`); a malformed sidecar is a hard
`MATERIALIZE_TRANSPORTS_INVALID` failure. Every recorded entry — in a
sidecar or in a `fromShell` reference — must be a canonical relative path
under `maps/` (no absolute paths, `..`/`.` segments, backslashes or empty
segments); an entry that is not fails the pack as `INVALID_DOCUMENT`
before anything is written. The pack result names the source in
`transportsSource` (`sidecar` or `fromShell`).

Both directions are deterministic. `pack` revalidates its own output through
the editor's shell and shard validation gates before writing, and publishes
atomically: every file is staged next to its target and renamed into place,
shards first and the shell last; a failure removes what this pack created,
so a failed pack never leaves a partial project on disk. Before staging the
first file, every publish target is confined to the output directory with
symlinks resolved, and — through MCP — to the server root; a target that
escapes either fails `PATH_OUTSIDE_ROOT` and writes nothing. `pack` after
`materialize` reproduces a `splitProjectMaps` shell and every shard
byte-for-byte; the default flow preserves a mixed-transport shell's per-map
encoding and entry paths through the recorded sidecar, and `fromShell`
reproduces them from a named shell. A canonical inline document (sorted keys,
maps in id order) round-trips exactly; a non-canonical inline document is
normalized to canonical key and map order by the round trip. `--dry-run`
reports what would be written without writing.

On the CLI, the explicit `--file` argument is always the input; a `file` key
inside `--json` is ignored. Through MCP, the input file, the `fromShell`
file and the recorded sidecar must resolve inside the server root
(symlinks resolved); the sidecar's and `fromShell`'s entries must be
canonical `maps/`-relative paths, and every publish target must resolve
inside both the output directory and the server root, or the pack fails
before writing. Proposal-only mode runs `lint --incremental` without
writing its cache sidecar.

## Read commands

### `open`

Args: none. `result` is the project summary plus `start` and the sheet list.

```sh
$ bun run rpgkit-edit open --file examples/sunstone/data/sunstone.json
{"ok":true,"command":"open","project":{"format":"rpgkit-project/v1","title":"The Sunstone of Bramble Hollow","documentKind":"inline","editable":true,"mapCount":3,"revision":"57b33669…"},"changed":false,"addresses":[],"diff":[],"result":{"format":"rpgkit-project/v1","title":"The Sunstone of Bramble Hollow","documentKind":"inline","editable":true,"mapCount":3,"revision":"57b33669…","start":{"map":"village","x":9,"y":9,"dir":"up"},"sheets":[{"id":"town","cols":12,"rows":11},{"id":"dun","cols":12,"rows":11}]},"file":"…","dryRun":false,"written":false}
```

### `list-maps`

Args: none. `result` is an array of map rows. Inline documents report
`name`, `width`, `height`, `sheets`, and `eventCount`; sharded shells report
the `entry` and `sha256` of each map payload instead.

```sh
$ bun run rpgkit-edit list-maps --file examples/sunstone/data/sunstone.json
[
  { "address": "map:village", "id": "village", "name": "Bramble Hollow", "width": 20, "height": 13, "sheets": ["town"], "eventCount": 9 },
  { "address": "map:forest", "id": "forest", "name": "Whispering Wood", "width": 18, "height": 14, "sheets": ["town"], "eventCount": 5 },
  { "address": "map:cave", "id": "cave", "name": "Sunstone Cave", "width": 18, "height": 13, "sheets": ["dun"], "eventCount": 7 }
]
```

### `list-events`

Args: `map` (string, required). For a shell, only that map's shard is loaded.
`result` is an array of `{ address, id, name?, x, y, w, h, pageCount }`.

```sh
$ bun run rpgkit-edit list-events --file examples/sunstone/data/sunstone.json --json '{"map":"village"}'
[
  { "address": "map:village/event:elder", "id": "elder", "name": "Village Elder", "x": 9, "y": 5, "w": 1, "h": 1, "pageCount": 1 },
  { "address": "map:village/event:merchant", "id": "merchant", "name": "Traveling Merchant", "x": 11, "y": 5, "w": 1, "h": 1, "pageCount": 1 }
]
```

### `list-pages`

Args: `map`, `event` (both required). `result` is an array of
`{ address, index, trigger, condition?, sprite?, blocks, commandCount }` in
authored (priority) order.

```sh
$ bun run rpgkit-edit list-pages --file examples/sunstone/data/sunstone.json --json '{"map":"village","event":"elder"}'
[ { "address": "map:village/event:elder/page:0", "index": 0, "trigger": "action", "sprite": "wiz", "blocks": true, "commandCount": 4 } ]
```

### `list-commands`

Args: `map`, `event`, `page` (integer ≥ 0; all required). `result` is an
array of flattened rows, one per command in the page's recursive tree:
`{ address, commandAddress, key, depth, branch?, summary, readOnly, command }`.
`commandAddress` is the structured `{ path, index }` form accepted by the
command-editing commands. Every op in the current project schema is owned by
the field editor, so its rows report `readOnly: false`; the flag remains for
forward-compatible display of an unknown future op.

```sh
$ bun run rpgkit-edit list-commands --file examples/sunstone/data/sunstone.json --json '{"map":"village","event":"elder","page":0}'
map:village/event:elder/page:0/command:root#0 | root#0 | Text: ELDER: The Sunstone that lit our valley / was taken into the ca…
map:village/event:elder/page:0/command:root#1 | root#1 | Choices: Ask about the road ahead? (2)
map:village/event:elder/page:0/command:c1:option:0#0 | c1:option:0#0 | Text: ELDER: A rune stone sleeps among the trees. / Touch it, and the…
map:village/event:elder/page:0/command:c1:option:1#0 | c1:option:1#0 | Text: ELDER: Walk tall. The hollow believes in you.
```

### `add-item`

Args: `item` (required), one complete schema-valid item object with a unique
lowercase `id`. The item is appended to the project-global catalog and the
result is the stored item. Duplicate ids fail with `DUPLICATE_RESOURCE`. This
operation also works on a `ProjectShell` without loading map shards.

### `add-sprite`

Args: either `sprite` (the new id) plus `value` (one complete schema-valid
image or walker sprite declaration), or the proposal-flow shape `id` plus
`sprite` (the declaration object). The result is the stored sprite
definition. Duplicate ids fail with `DUPLICATE_RESOURCE`. An `id` alongside
the `{sprite, value}` shape is refused with `INVALID_ARGUMENT` rather than
ignored. This operation also works on a `ProjectShell` without loading map
shards.

### `validate`

Args: optional `map` string, also accepted as CLI `--map <id>`. With no map,
`result` is `{ valid: boolean, errors: [{ path, msg }] }`; with a map it also
contains `scopedMap`. Invalid content is reported with `ok: true` and
`valid: false`. An unknown map is instead a domain failure with
`MAP_NOT_FOUND` at `$.map`.

Unscoped validation runs schema and structural checks over the complete
document (duplicate ids, bounds and start map). For a shell it also verifies
the manifest, schema identity, every declared shard checksum and every
shard's metadata and full map schema. Scoped validation checks only the named
inline map or shell shard; other map payloads are neither loaded nor reported.
The shell header and selected shard's checksum, metadata and map schema are
still verified.

```sh
$ bun tools/rpgkit-edit/cli.ts validate \
    --file examples/sunstone/data/sunstone.json --map village
{"ok":true,"command":"validate","result":{"valid":true,"errors":[],"scopedMap":"village"},…}
```

## Project catalogs

Items, sprites, audio, tile sheets, switches and variables share one CRUD
contract. It is available through the in-process edit API, this CLI and the
MCP tools below for both inline projects and sharded `ProjectShell` projects.

| catalog | list | get/add/update/remove selector | add payload | update payload |
| --- | --- | --- | --- | --- |
| items | `list-items` | `item` | `item`: complete item object | `item`: id, `changes`: item fields |
| sprites | `list-sprites` | `sprite` | `sprite`: id, `value`: complete sprite definition | `sprite`: id, `value`: replacement definition |
| audio | `list-audio` | `audio` | `audio`: id, `value`: pak entry | `audio`: id, `value`: replacement pak entry |
| sheets | `list-sheets` | `sheet` | `sheet`: complete sheet object | `sheet`: id, `changes`: sheet fields |
| switches | `list-switches` | `switch` | `switch`: `{ "id": "…", "name"?: "…" }` | `switch`: id, `changes`: `{ "name"?: string|null }` |
| variables | `list-variables` | `variable` | `variable`: `{ "id": "…", "name"?: "…" }` | `variable`: id, `changes`: `{ "name"?: string|null }` |

Every list command takes no arguments and returns deterministic rows:

```json
{
  "address": "item:storehouse-key",
  "id": "storehouse-key",
  "declared": true,
  "value": { "id": "storehouse-key", "name": "Storehouse Key", "sprite": "town.12" },
  "referenceCount": 1
}
```

`get-*` returns the same row with `references`, an array of
`{ address, field, access }`; `access` is `read`, `write`, `readWrite`, or
`reference`. Items and sheets retain author order, while keyed sprite/audio
ids are sorted. Switch and variable rows contain declarations in author order
followed by sorted ids discovered in event content.

Switch and variable declarations are optional editor metadata. An id used by
an event but absent from the declaration array is still listed and can be read
with `declared: false` and `value: { id }`. Adding a declaration does not
initialize or otherwise change the runtime's sparse switch/variable bank.
Only declared entries can be updated or removed.

`add-*` rejects an existing id with `DUPLICATE_RESOURCE`; `get-*`, `update-*`
and `remove-*` report `RESOURCE_NOT_FOUND` when their applicable entry is
absent. Updates keep the id stable. For item, sheet, switch and variable
`changes`, `null` removes an optional field; a complete sprite/audio value is
replaced as a unit. The ordinary post-edit project validation applies to every
payload.

Removal is conservative and has no cascade mode. If a built-in, statically
typed project field uses the id, the command fails without a patch or write:

```json
{
  "code": "RESOURCE_IN_USE",
  "details": {
    "resource": { "kind": "item", "id": "storehouse-key" },
    "references": [
      { "address": "map:town/event:key-giver/page:0/command:root#0", "field": "item", "access": "reference" }
    ]
  }
}
```

The scanner covers map/page/common-event conditions and commands, map sheets
and tile layers, item icon cells, actor/page appearances, animation timing
sounds, and text-variable tokens when enabled. Extension arguments, extension
choice arguments, battle setup and scene arguments are opaque JSON, so ids
inside those payloads are not guessed as references.

For example, adding a key and then giving it from a new NPC needs two ordinary
commands, not a hand-authored patch:

```sh
bun run rpgkit-edit add-item --file game.json \
  --json '{"item":{"id":"storehouse-key","name":"Storehouse Key","sprite":"town.12","type":"key"}}'
bun run rpgkit-edit add-event --file game.json \
  --json '{"map":"town","event":{"id":"key-giver","x":4,"y":6,"pages":[{"trigger":"action","commands":[{"op":"item","item":"storehouse-key","set":"add","count":1}]}]}}'
```

## Map editing

### `update-map`

Args: `map` (required), `changes` (object with at least one of `id`, `name`,
`width`, `height`, `sheets`). `id` matches `^[a-z0-9_-]+$`; `name` is 1–40
characters; `width`/`height` are 1–256; `sheets` is a non-empty unique list.
Renaming an id follows `start.map` and every transfer that names it;
resizing crops events fully outside the new bounds and reports them in
`croppedEvents`. A shell rename therefore scans every shard; the other map
changes load only their target shard.

```sh
$ bun run rpgkit-edit update-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","changes":{"name":"Bramble Hollow Village"}}'
{"ok":true,"changed":true,"addresses":["map:village"],"patch":{…},"result":{"map":{"id":"village","name":"Bramble Hollow Village",…},"croppedEvents":[]}}
```

### `add-map`

Args (all optional): `map` (preferred new id), `name` (at most 40
characters; default `Map <n>`), `width`, `height` (1–256; default 20×14),
`sheets` (non-empty list of project sheet ids; default the anchor map's
sheets), `fill` (ground tile for every cell, or `null`/omitted for void),
`after` (existing map id to insert after; default the last map). The model
makes the preferred id schema-safe and unique (`market`, `market-2`, …), so
read the created id from `result`, which is the new `MapDef`.

```sh
$ bun run rpgkit-edit add-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"market","name":"Market","width":10,"height":8,"fill":"town.0","after":"village"}'
{"ok":true,"changed":true,"addresses":["map:market"],"patch":{…},"result":{"id":"market","name":"Market","width":10,"height":8,"sheets":["town"],"ground":[…],"events":[]}}
```

### `duplicate-map`

Args: `map` (required). Inserts a copy directly after the source with a
unique `<id>-copy` id. Event ids are map-local and kept verbatim. `result`
is the new `MapDef`.

```sh
$ bun run rpgkit-edit duplicate-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"forest"}'
{"ok":true,"changed":true,"addresses":["map:forest-copy"],"patch":{…},"result":{"id":"forest-copy","name":"Whispering Wood",…}}
```

### `delete-map`

Args: `map` (required). The only map and the start map are refused with
`MAP_DELETE_REFUSED` (`details.references` is the model's reference list).
Otherwise the map is deleted; literal transfer commands that targeted it are
kept, exactly as in the visual editor's confirmed delete, and listed in
`result.references` as `{ mapId, eventId, page, command }` rows
(`mapId` is `(common)` for common events) so they can be retargeted.

```sh
$ bun run rpgkit-edit delete-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"forest"}'
{"ok":true,"changed":true,"addresses":["map:forest"],"patch":{…},"result":{"deleted":{"id":"forest",…},"references":[{"mapId":"village","eventId":"north-gate","page":0,"command":"root#0"},{"mapId":"cave","eventId":"cave-return","page":0,"command":"root#0"}]}}
$ bun run rpgkit-edit delete-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village"}'
{"ok":false,"command":"delete-map","error":{"code":"MAP_DELETE_REFUSED","message":"map village cannot be deleted: cannot delete the start map","path":"$.map",…}}
```

### `move-map`

Args: `map` and `index` (required). Moves the map so it ends up at the
zero-based position `index` of `maps` (`0` … map count − 1); every other map
keeps its relative order. Ids do not change, so the start map and transfers
are unaffected. Moving a map to its current position succeeds with
`changed:false`. An out-of-range `index` is `INVALID_ARGUMENT`. `result` is
`{ map, from, to }`.

```sh
$ bun run rpgkit-edit move-map --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"cave","index":0}'
{"ok":true,"changed":true,"addresses":["map:cave"],"patch":{…},"result":{"map":"cave","from":2,"to":0}}
```

### `paint-tile`

Args: `map` (required), `x`, `y` (required, in bounds), `tile` (required: a
`"sheet.cell"` id declared by the map, or `null` to erase), `layer`
(`"ground"` or `"upper"`, default `"ground"`).

```sh
$ bun run rpgkit-edit paint-tile --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":["map:village/layer:ground/tile:0,0"],"patch":{…},"result":{"map":"village","layer":"ground","tile":"town.0","cells":1}}
```

(`changed` is false here because cell 0,0 already held `town.0`.)

### `paint-rect`

Args: `map`, `x`, `y` (required), `width`, `height` (positive integers; the
rectangle must fit the map), and one of these mutually exclusive paint forms:

- Ground or upper (the compatible default): `tile` is required (`null`
  erases), and `layer` is `"ground"` (default) or `"upper"`.
- Uniform passage: `layer` is `"passage"` and `value` is `"pass"`, `"block"`,
  or `null` to clear the override.
- Passage room template: `layer` is `"passage"`, `template` is `"room"`, and
  `doors` optionally lists absolute `[x, y]` cells on the rectangle border.
  Width and height must be at least 3. The border becomes `block`; the
  interior and every listed door become `pass`. Omitting `doors` makes a
  sealed room.

All forms are one stroke and one reversible patch. Door coordinates outside
the map are `OUT_OF_BOUNDS`; coordinates that are not on this rectangle's
border are `INVALID_ARGUMENT`.

```sh
$ bun run rpgkit-edit paint-rect --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"width":2,"height":2,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":["map:village/layer:ground/tile:0,0","map:village/layer:ground/tile:1,0","map:village/layer:ground/tile:0,1","map:village/layer:ground/tile:1,1"],"result":{"map":"village","layer":"ground","tile":"town.0","cells":4}}
```

This single call replaces the explicit 31-wall-cell plus 49-pass-cell lists
for a 10×8 room with one bottom door:

```sh
$ bun run rpgkit-edit paint-rect --file game/data/project.json --dry-run \
    --json '{"map":"guard-warehouse","layer":"passage","x":0,"y":0,"width":10,"height":8,"template":"room","doors":[[4,7]]}'
{"ok":true,"changed":true,"addresses":[…80 cells…],"result":{"map":"guard-warehouse","layer":"passage","template":"room","doors":1,"blocked":31,"passable":49,"cells":80}}
```

### `fill-region`

Args: `map`, `x`, `y` (required), `tile` (required, `null` erases), `layer`
(default `"ground"`). Four-way flood fill of the contiguous region
containing (x, y).

```sh
$ bun run rpgkit-edit fill-region --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"tile":"town.0"}'
{"ok":true,"changed":false,"addresses":[],"result":{"map":"village","layer":"ground","tile":"town.0","cells":0}}
```

(`cells` is 0 because the region at 0,0 was already `town.0`.)

### `paint-passage`

Args: `map`, `x`, `y` (required, in bounds), `value` (required: `"pass"`,
`"block"`, or `null` to clear the override).

```sh
$ bun run rpgkit-edit paint-passage --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","x":0,"y":0,"value":"pass"}'
{"ok":true,"changed":true,"addresses":["map:village/layer:passage/tile:0,0"],"result":{"map":"village","x":0,"y":0,"value":"pass"}}
```

### `paint-cells`

Args: `map` (required), `cells` (required: non-empty array of in-bounds
`[x, y]` integer pairs, at most `width * height` entries; duplicates are
harmless), exactly one of `value` or `values`, and `layer` (`"ground"`,
`"upper"`, or `"passage"`, default `"ground"`). `value` paints every cell
uniformly. `values` is a parallel array with one value per `cells` entry and
paints a pattern in the listed order; on duplicate coordinates the last value
wins. For ground/upper each value is a tile id declared by the map
(`INVALID_TILE` otherwise) or `null` to erase; for passage each value is
`"pass"`, `"block"`, or `null` to clear. The cells are one free-form brush
stroke: one operation, one patch. An out-of-bounds cell fails with
`OUT_OF_BOUNDS` at `$.cells[i]`; an invalid patterned value reports
`$.values[i]`. `result.cells` and `addresses` count distinct cells. A
patterned result reports the submitted value count as `result.values`.

```sh
$ bun run rpgkit-edit paint-cells --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","cells":[[2,2],[3,2],[3,3]],"value":"town.1"}'
{"ok":true,"changed":true,"addresses":["map:village/layer:ground/tile:2,2","map:village/layer:ground/tile:3,2","map:village/layer:ground/tile:3,3"],"result":{"map":"village","layer":"ground","value":"town.1","cells":3}}
```

```sh
$ bun run rpgkit-edit paint-cells --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","cells":[[2,2],[3,2],[2,3],[3,3]],"values":["town.1","town.2","town.3","town.4"]}'
{"ok":true,"changed":true,"addresses":["map:village/layer:ground/tile:2,2","map:village/layer:ground/tile:3,2","map:village/layer:ground/tile:2,3","map:village/layer:ground/tile:3,3"],"result":{"map":"village","layer":"ground","values":4,"cells":4}}
```

### `paint-edges`

Args: `map`, `cells` (as for `paint-cells`), `brush` (required:
`{ "kind": "enter" | "exit", "dir": "up" | "down" | "left" | "right" }` or
`{ "kind": "clear" }`). One-way edges live on the sheet (`sheets[].dirEdges`),
keyed by the tile cell, so each painted map cell edits the entry for its
ground tile and the change applies wherever that tile is used. `enter`/`exit`
toggle the direction; `clear` removes the entry. Void cells are skipped and
each sheet cell is toggled at most once per call, even if several painted
cells share a tile. `result` is `{ map, brush, cells, changed }`, where
`changed` lists `{ sheet, cell, edges }` (the new entry, or `null` when
removed); `addresses` are the matching `sheet:<sheet>/cell:<n>` entries.

```sh
$ bun run rpgkit-edit paint-edges --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","cells":[[2,2]],"brush":{"kind":"exit","dir":"left"}}'
{"ok":true,"changed":true,"addresses":["sheet:town/cell:0"],"result":{"map":"village","brush":{"kind":"exit","dir":"left"},"cells":1,"changed":[{"sheet":"town","cell":"0","edges":{"exit":["left"]}}]}}
```

## Event and page editing

### `add-event`

Args: `map` (required), `event` (required: a full event object). Required
fields: `id` (`^[A-Za-z0-9_-]+$`, unique on the map), `x`, `y` (non-negative
integers), `pages` (non-empty array). Optional: `name`, `w`, `h` (positive
integers). The footprint must fit the map. Optional `index` (0..event
count; default appends) places the new event at that position in the map's
event list.

```sh
$ bun run rpgkit-edit add-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":{"id":"doc-demo","x":5,"y":5,"pages":[{"trigger":"action","commands":[{"op":"text","lines":["Hi."]}]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:doc-demo"],"result":{"id":"doc-demo","x":5,"y":5,"pages":[{"trigger":"action","commands":[{"op":"text","lines":["Hi."]}]}]}}
```

### `update-event`

Args: `map`, `event` (the existing id), `changes` (object: any of `id`,
`name`, `x`, `y`, `w`, `h`; `null` removes optional `name`/`w`/`h`). Page
content is not editable here.

```sh
$ bun run rpgkit-edit update-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"sign","changes":{"name":"Village Signpost"}}'
{"ok":true,"changed":true,"addresses":["map:village/event:sign"],"result":{"id":"sign","name":"Village Signpost","x":13,"y":7,"pages":[…]}}
```

### `delete-event`

Args: `map`, `event`. `result` is `{ deleted: <event> }`.

```sh
$ bun run rpgkit-edit delete-event --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy"}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy"],"result":{"deleted":{"id":"boy","name":"Curious Boy","x":7,"y":9,"pages":[…]}}}
```

### `add-page`

Args: `map`, `event`, `page` (a full page object), `index` (optional,
0..page count; default appends). A page requires `trigger`
(`action`/`playerTouch`/`eventTouch`/`autorun`/`parallel`) and `commands`; optional fields
are `condition`, `sprite` (string or null), `blocks`, `moveType`,
`moveRoute`, `moveSpeed` (1–6), `moveFrequency` (1–5), `directionFix`,
`through`, `facingMode`, and `dir`. Higher index means higher runtime
priority.

```sh
$ bun run rpgkit-edit add-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:1"],"result":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}
```

### Page conditions

An absent `condition` means the page is eligible. When a condition is present,
every authored flat field and every entry in `condition.all` must hold: the
forms combine with logical AND, including when both forms appear together.
The runtime tests pages from the highest array index down and selects the
first eligible page.

The four flat fields are compact, compatibility-preserving spellings:

| flat field | condition that must hold |
| --- | --- |
| `switch: "door-open"` | switch `door-open` is true |
| `selfSwitch: "A"` | this event's self switch A is true |
| `variable: {"id":"visits","op":">=","value":2}` | the numeric variable comparison is true; `op` is `>=`, `<=`, `==`, or `!=` |
| `item: "key"` | the party owns at least one `key` |

`condition.all` is a non-empty array of full condition objects. It supports
the same four concepts with more control, plus the remaining condition kinds:

| `kind` | fields and meaning |
| --- | --- |
| `switch` | `id`, optional `value` (default true) |
| `variable` | `id`, `op` (`>=`, `<=`, `==`, `!=`), integer `value` |
| `selfSwitch` | `key` (`A`–`D`), optional `value` (default true) |
| `item` | `id`, positive `count` |
| `gold` | non-negative `amount`; current gold must be at least this value |
| `facing` | `dir` (`down`, `left`, `right`, `up`); tests player facing |
| `appearance` | `target`, `sprite`; `null` means built-in player art or a sprite-less event page |
| `tileProperty` | `x`, `y`, and one or more of `passage`, `enter`, `exit`; every listed runtime override must match |
| `worldIdle` | optional `negate`; tests whether no blocking world activity is active |
| `region` | `x`, `y`, `id` (0–255); id 0 matches an unmarked cell |
| `bgmPlaying` | optional `id` and `negate`; tests audibly advancing BGM |
| `timer` | `op` (`>=` or `<=`) and non-negative `seconds`; a stopped timer never matches |
| `ext` | namespaced `call` and JSON `args`; invokes a registered pure game condition |

For example, this page requires both the compact switch and two compound
clauses:

```json
{
  "condition": {
    "switch": "quest-started",
    "all": [
      { "kind": "gold", "amount": 10 },
      { "kind": "facing", "dir": "up" }
    ]
  },
  "trigger": "action",
  "commands": []
}
```

The schema validates each spelling and payload, but it deliberately does not
reject a logically contradictory combination. Run `rpgkit-check lint`; a
provably impossible gate is reported as
`lint/page-condition-contradiction`.

### `update-page`

Args: `map`, `event`, `page` (integer), `value` (a full replacement page).

```sh
$ bun run rpgkit-edit update-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"value":{"trigger":"action","commands":[{"op":"text","lines":["Hey!"]}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0"],"result":{"trigger":"action","commands":[{"op":"text","lines":["Hey!"]}]}}
```

### `delete-page`

Args: `map`, `event`, `page`. Refuses to delete an event's last page with
`LAST_PAGE`. `result` is `{ deleted: <page> }`.

```sh
$ bun run rpgkit-edit delete-page --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":1}'
{"ok":true,"changed":true,"result":{"deleted":{"trigger":"action","commands":[{"op":"text","lines":["Hmm?"]}]}}}
```

## Command editing

### `insert-command`

Args: `map`, `event`, `page`, `address` (`{ path, index }`; `index` may equal
the list length), `command` (an object with a non-empty `op` string).
The command object is inserted intact; the whole-project schema gate after an
inline mutation, or the selected map-schema gate for a shell, decides whether
that op and payload are valid.

```sh
$ bun run rpgkit-edit insert-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"address":{"path":[],"index":0},"command":{"op":"text","lines":["Hi there!"]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0/command:root#0"],"result":{"op":"text","lines":["Hi there!"]}}
```

A `loop` repeats its `commands` body until a `break` inside it (at any depth
of if/choices/battle/scene branches) leaves the loop; a `break` outside any
loop ends the current page or common event. A loop may be inserted with its
body already filled:

```sh
$ bun run rpgkit-edit insert-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"address":{"path":[],"index":0},"command":{"op":"loop","commands":[{"op":"text","lines":["Again, {name}?"]},{"op":"break"}]}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0/command:root#0"],"result":{"op":"loop","commands":[{"op":"text","lines":["Again, {name}?"]},{"op":"break"}]}}
```

Once that loop exists at root index 0, a later insert addresses its body with
a `loop` segment (`index` 1 here is the slot before the `break`):

```sh
$ bun run rpgkit-edit insert-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"boy","page":0,"address":{"path":[{"kind":"loop","index":0,"branch":"body"}],"index":1},"command":{"op":"wait","seconds":1}}'
{"ok":true,"changed":true,"addresses":["map:village/event:boy/page:0/command:l0:body#1"],"result":{"op":"wait","seconds":1}}
```

### `delete-command`

Args: `map`, `event`, `page`, `address`. The address must resolve to an
existing command. `result` is `{ deleted: <command> }`.

```sh
$ bun run rpgkit-edit delete-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"elder","page":0,"address":{"path":[],"index":0}}'
{"ok":true,"changed":true,"addresses":["map:village/event:elder/page:0/command:root#0"],"result":{"deleted":{"op":"text","lines":["ELDER: The Sunstone that lit our valley","was taken into the cave beyond the wood.","Thorns seal the forest path. Take the key","from the village chest, hero."]}}}
```

### `update-command`

Args: `map`, `event`, `page`, `address`, `field` (non-empty string), `value`
(string: the editor's text spelling, e.g. `"10"`, `"true"`, or
newline-separated text lines). Every command and condition kind in the current
project schema is field-editable. A future unknown op fails with
`READ_ONLY_COMMAND`; a bad field or value fails with `INVALID_COMMAND_FIELD`
and lists the legal fields for the selected command.

Field names are literal and case-sensitive. The core forms are:

| command | `field` spellings |
| --- | --- |
| `text` | `lines`, `cps`, `position`, `align`, `valign`, `background` (choosing a field's default removes it) |
| `choices` | `prompt`, `optionCount`, `option:<i>` (label), `option:<i>.icon`, `option:<i>.icon.dir`, `option:<i>.icon.frame`, `cancel`; `<i>` is the zero-based option index |
| `switch` | `id`, `value` |
| `variable` | `id`, `mode`, then `value`, `from`, or `min`/`max` as selected by the mode |
| `selfSwitch` | `key`, `value` |
| `if` | `if.kind`, the matching `if.<condition-field>` values below, and `else` |
| `transfer` | `map`, `x`, `y`, `dir`, `fade`; variable operands use `$<variable-id>` |
| `moveRoute` | `target`, `wait`, `steps`, `repeat`, `skippable`; `steps` is a comma-separated basic-step list |
| `wait` | `seconds` |
| `gold` | `set`, `amount` |
| `item` | `item`, `set`, `count` |
| legacy `se` | `name`, `volume`, `pitch` |
| `common` | `id` |
| `place` | `target`, `x`, `y`, `dir` |

The movement, presentation, modal, extension, and battle forms use:

| command | `field` spellings and text forms |
| --- | --- |
| `moveControl` | `target`, `control.kind`; `control.value` for value-bearing kinds, or `control.bounds` (`x,y,width,height`) and `control.frequency` for `wander` |
| `appearance` | `target`, `sprite`, `opacity`, `visible`, `saveDefault` |
| `layer` | `layer`, `visible`, `variant` |
| `changeParallax` | `image` (or `null`), `loopX`, `loopY`, `sx`, `sy`, `zero` |
| `tileProperty` | `x`, `y`, `passage`, `enter`, `exit`; directions are a comma list, JSON array, `[]`, `null`, or `(unset)` |
| `screenFade` | `direction`, `duration`, `color` (`r,g,b,a` or `(unset)`), `wait` |
| `screenTint` | `layer`, `color.r`, `color.g`, `color.b`, `color.a`, `duration`, `wait` |
| `screenFlash` | `color.r`, `color.g`, `color.b`, `color.a`, `intensity`, `duration`, `wait` |
| `screenShake` | `strength`, `speed`, `duration`, `wait` |
| `camera` | `target`, `duration`, `wait`; target is `player`, `this`, `event:<id>`, or `tile:<x>,<y>` |
| `scrollMap` | `direction`, `distance`, `speed` (RPG Maker grade 1–6), `wait` |
| `balloon` | `target`, `icon`, `duration`, `wait` |
| `screenBackdrop` | `layer`, `variant` |
| `showPicture` | `id`, `layer`, `variant`, `origin`, `x`, `y`, `scaleX`, `scaleY`, `opacity`, `blend`; variable coordinates use `$<variable-id>` |
| `movePicture` | `id`, `origin`, `x`, `y`, `scaleX`, `scaleY`, `opacity`, `blend`, `duration`, `wait`, `easing`; variable coordinates use `$<variable-id>` |
| `rotatePicture` | `id`, `speed` |
| `tintPicture` | `id`, `tone.r`, `tone.g`, `tone.b`, `tone.gray`, `duration`, `wait` |
| `erasePicture` | `id` |
| `timer` | `action`, then `seconds` for `start` or `variable` for `read`; `stop` has no other field |
| `inputNumber` | `variable`, `digits` (1–8) |
| `selectItem` | `variable`, `itemType` (`regular`, `key`, `hiddenA`, `hiddenB`) |
| `changeName` | `name` |
| `mapNameDisplay` | `visible` |
| `menuAccess` / `saveAccess` | `enabled` |
| `locationInfo` | `variable`, `x`, `y`, `kind` (`terrain`, `event`, `tile`, `region`), `layer` (0..3, the raw tile plane; only used by `kind: "tile"`) |
| `label` / `jumpLabel` | `name` |
| `shop` | `id`, `goods` (JSON array), `sell`, `sellList` |
| `mapAnim` | `id`, `anim`, `placement`; then `x`/`y` for `tile` or `target` (`player`, `this`, or an event id) for `target`; also `follow`, `layer`, `loop`, `wait` |
| `stopAnim` | `selector` (`all`, `id`, or `anim`), then the selected `id` or `anim` |
| `ext` | `call`, `args` (JSON) |
| `extChoice` | `call`, `args` (JSON), `prompt`, `cancel`, `write` (JSON object or `(unset)`) |
| `battle` | `setup` (JSON) |
| `scene` | `id`, `args` (JSON or `(unset)`) |

Picture-coordinate variables are resolved when the command executes and must
hold a finite number. An unset or invalid value stops the interpreter with a
content error rather than falling back to zero.

Audio fields are `id`, `volume`, and `pitch` for `playBgm`, `playBgs`, and
`playSe`; `playMe` also has `duration`; `fadeoutBgm` and `fadeoutBgs` have
`duration`. `stopBgm`, `pauseBgm`, `resumeBgm`, `saveBgm`, `replayBgm`,
`erase`, `exit`, `openMenu`, `openSave`, `autosave`, `gameOver`, `returnTitle`,
`lockInput`, `unlockInput`, `break`, and `stopSe` are supported but have no
parameter fields. `loop` has no parameter fields either: its only
payload is its `commands` body, edited with `insert-command`/`delete-command`
at `loop` body addresses.

Text lines (`text.lines`), the `choices` `prompt` and `option:<i>` labels,
and the `extChoice` `prompt` are stored verbatim. They may hold `{name}` (the player's name) and, when the
project sets `system.textVariables: true`, `{v:<variable-id>}` (that
variable's live value, 0 when unset); without the flag the braces show
verbatim. A project that declares `system.textTokens` (the key allowlist)
may also hold `{x:<key>}` tokens, which a session's
`textTokens` resolver answers at runtime (`???` when unanswered); without
the declaration the braces show verbatim, like `{v:}` without its flag. The
edit API stores the placeholder text and never previews the value.
Tokens are expanded only at runtime, so the 52-character limit
applies to the raw authored text. The edit API has no operation for
`project.system` fields; set `textVariables`, the `textTokens`
allowlist or the initial
`mapNameDisplay` preference in the project JSON directly.

Changing `if.kind` installs a schema-valid default condition. The remaining
condition fields are prefixed with `if.`:

| condition kind | fields after the `if.` prefix |
| --- | --- |
| `switch` | `id`, `value` |
| `variable` | `id`, `op`, `value` |
| `selfSwitch` | `key`, `value` |
| `item` | `id`, `count` |
| `gold` | `amount` |
| `facing` | `dir` |
| `appearance` | `target`, `sprite` (`null` means the default sprite) |
| `tileProperty` | `x`, `y`, `passage`, `enter`, `exit` |
| `region` | `x`, `y`, `id` |
| `worldIdle` | `negate` |
| `bgmPlaying` | `id` (`(any)` or an empty string omits it), `negate` |
| `timer` | `op` (`>=` or `<=`), `seconds` |
| `ext` | `call`, `args` (JSON) |

The desktop inspector also edits every one of these condition kinds in a
page's compound `condition.all` list. At the API level, `update-command`
edits an `if`; `update-page` can replace a complete page condition.

`(unset)` (or an empty value where accepted) removes an optional property.
`null` is deliberately different on nullable appearance, layer, backdrop,
and tile-property fields: it stores an explicit runtime reset. A field change
is rejected when removing it would violate the schema, such as removing the
last appearance or tile-property override. JSON-valued fields parse the
field's string before schema validation, so JSON nested inside the command
line argument must be escaped, for example:

```sh
$ bun run rpgkit-edit update-command --file game.json --dry-run \
    --json '{"map":"field","event":"merchant","page":0,"address":{"path":[],"index":0},"field":"goods","value":"[{\"item\":\"potion\",\"price\":25}]"}'
```

A `choices` option may show a picture left of its label: one frame of a
`project.sprites` entry. `option:<i>.icon` sets the sprite key, or removes the
whole `icon` object when the value is `(unset)` or empty. Once a sprite is set,
`option:<i>.icon.dir` (`down`, `left`, `right`, `up`) and
`option:<i>.icon.frame` (`0`, `1`, `2`) pick the walker facing and pose;
before that they fail with `INVALID_COMMAND_FIELD`. The defaults (`down`,
`0`) are omitted from the document rather than stored, and changing the sprite
keeps the chosen facing and pose. Sprite keys are suggestions like every other
resource hint, not a closed enum; the schema still rejects an empty sprite, an
out-of-range `dir`/`frame`, or any other key inside `icon`.

```sh
$ bun run rpgkit-edit update-command --file game.json --dry-run \
    --json '{"map":"field","event":"guide","page":0,"address":{"path":[],"index":0},"field":"option:1.icon","value":"hero"}'
```

The patch adds one property, so reversing it restores the text-only row:

```json
{ "path": "/maps/0/events/0/pages/0/commands/0/options/1/icon",
  "before": { "exists": false },
  "after": { "exists": true, "value": { "sprite": "hero" } } }
```

Clearing it again with `"value":"(unset)"` produces the mirror change
(`before` holds the old icon, `after` is `{ "exists": false }`).

The desktop inspector offers resource hints drawn from project maps, items,
sprites, animations, parallaxes, audio ids and common events, plus
already-authored layer variants, animation instance ids, and extension calls.
These remain suggestions rather than closed enums because games can supply presentation
layers and registered extensions outside project JSON.

For nested insertion, the desktop add prompt accepts `<op>@then`/`@else`
for an `if`, `@option<n>`/`@cancel` for `choices`, `@win`, `@lose`, and
`@escape` for a `battle`, `@done`/`@cancel` for a `scene`, and `@body` for a
`loop` (for example `break@body`). API clients use the structured paths
documented under [Addresses](#addresses).
`extChoice` does not contain authored command branches: its rows are returned
dynamically by the registered provider, and `write` only names result
variables. `scene` opens a game-registered scene by `id`; its optional
`onDone`/`onCancel` branches are authored command lists, and `battle` remains
the authored command for the built-in battle scene.

```sh
$ bun run rpgkit-edit update-command --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"map":"village","event":"elder","page":0,"address":{"path":[],"index":0},"field":"lines","value":"New text"}'
{"ok":true,"changed":true,"addresses":["map:village/event:elder/page:0/command:root#0"],"result":{"op":"text","lines":["New text"]}}
```

## `save`

Apply a previously captured patch. Args: `patch` (a full
`rpgkit-edit/patch-v1` object), `direction` (`"forward"` default, or
`"reverse"` to undo).

`result` is `{ direction, beforeHash, afterHash }`. Errors: `INVALID_PATCH`
(malformed), `PATCH_BASE_MISMATCH` (the document's semantic hash is not the
patch's expected base), `PATCH_CHANGE_MISMATCH` (a change's precondition does
not match), `INVALID_EDIT` (the patched result would be invalid).

For a shell, `save` derives the exact shard set from the patch paths, verifies
the shell and those shards, checks the logical-view base hash and each change
precondition, then publishes only changed shards plus the shell. Reapplying a
forward patch fails closed; reverse uses the same stable entry paths. Mixed
inline paths such as `/maps/0/...`, unknown entries, and attempts to add,
remove, or rename entry keys are rejected.

```sh
$ jq '{patch:.patch}' preview.json > apply.json
$ bun run rpgkit-edit save --file examples/sunstone/data/sunstone.json --json @apply.json
{"ok":true,"changed":true,"result":{"direction":"forward","beforeHash":"01fb89c775a8…","afterHash":"76b5f5ca537e…"}}
$ jq '.direction="reverse"' apply.json > reverse.json
$ bun run rpgkit-edit save --file examples/sunstone/data/sunstone.json --json @reverse.json
{"ok":true,"changed":true,"result":{"direction":"reverse","beforeHash":"76b5f5ca537e…","afterHash":"01fb89c775a8…"}}
```

## `batch`

Run several editing operations as one all-or-nothing transaction. Args:
`operations` (a non-empty array of `{command, args}` objects, as for the
standalone commands). Every operation validates and applies in order; the
batch returns one reversible patch from the original to the final document
and one publish. A failure in any operation returns that failure (with
`error.operationIndex`, the 0-based index of the operation that failed) and
writes nothing. `save` and a nested `batch` are refused inside a batch. Read
operations are allowed and contribute their result but no document change.

`batch` works on both inline projects and sharded `ProjectShell`s. A shell
batch loads each operation's shards lazily and writes only the affected
shards plus the shell. The structural shell commands (`add-map` and friends)
stay proposal-only for a direct batch, as for a single direct edit; a
`batch` inside a proposal hunk may use them, the same as a plain hunk
operation.

`result` is `{operations: [{command, result}, …], count}`, one entry per
operation in order. The response carries the combined `addresses` and one
`patch` over the whole transaction.

```sh
$ bun run rpgkit-edit batch --file examples/sunstone/data/sunstone.json --dry-run \
    --json '{"operations":[
      {"command":"add-item","args":{"item":{"id":"storehouse-key","name":"Storehouse Key","sprite":"town.12","type":"key"}}},
      {"command":"add-event","args":{"map":"village","event":{"id":"key-giver","x":4,"y":6,"pages":[{"trigger":"action","commands":[{"op":"item","item":"storehouse-key","set":"add","count":1}]}]}}}
    ]}'
{"ok":true,"changed":true,"addresses":["item:storehouse-key","map:village/event:key-giver"],"patch":{…},"result":{"operations":[{…},{…}],"count":2}}
```

A proposal hunk may also contain a `batch` operation, so a reviewed proposal
can carry a multi-step transaction as one independently reviewable unit.

## Compact envelope

Every mutating command (including `batch`) accepts an optional `envelope`
argument. The default `"full"` envelope returns the structural `diff` and
reversible `patch`. `"compact"` empties `diff`, omits `patch`, and returns a
`semanticDiff` instead — a smaller, human-facing summary of the same change:

- An array of id-keyed objects (`maps`, `events`, `items`, …) changes by
  `insert`/`remove`/`move` rather than a whole-array replacement. A mixed
  change (an insert or remove together with a reorder) reports the reorder as
  `move` entries as well as the insert/remove, so no movement is hidden. A
  `move` names only an item whose relative order changed; an item that an
  insert or remove merely shifted (its order relative to every other item
  stayed the same) is not reported as a move.
- A sparse map layer (`upper`, `passage`, `regions`, `terrain`, `tiles`)
  reports only the cells whose dense value changed, so editing one passage
  cell reports one cell instead of the normalization noise the structural
  diff shows when the sparse pair order shifts. This treatment applies only
  to a map's own fields — an inline map at `/maps/<n>/<key>`, or a map shard
  at `/shards/<entry>/<key>`. Any other array of pairs with one of those key
  names (for example an event command's `args` or a battle's `setup`, which
  are free JSON) is compared element-wise, so a reorder is reported.
- A sharded edit's derived shell metadata (per-shard checksums,
  `mapSchemaHash`, `mapManifestHash`) is dropped, since a reader can rebuild
  it from the shards.

```sh
$ bun run rpgkit-edit paint-passage --file examples/sunstone/data/sunstone.json \
    --json '{"map":"village","x":0,"y":0,"value":"pass","envelope":"compact"}'
{"ok":true,"changed":true,"diff":[],"semanticDiff":[{"kind":"set","path":"/maps/0/passage/0","before":{"exists":true,"value":"block"},"after":{"exists":true,"value":"pass"}}],…}
```

`semanticDiff` entries are `{kind:"set",path,before,after}`,
`{kind:"insert",path,index,after}`, `{kind:"remove",path,index,before}`, or
`{kind:"move",path,from,to}`. Array indices are per side: an insert's `index`
is its position in the after array, a remove's `index` is its position in the
before array, and a move's `from`/`to` are the item's positions in the before
and after arrays. The summary is descriptive — for inspection and logs — and
is not a replay recipe; the reversible `patch` (returned by the default
envelope) remains the form `save` replays and the way to reconstruct either
side.

Why the default envelope still shows many entries for one cell: an edit rule
rewrites a sparse layer by appending the edited pair to the end of the array
(the runtime's "last pair at an index wins" rule makes the order irrelevant),
so the structural diff lists every slot the pair moved past — one passage
cell can be dozens of `diff` entries. This is intentional and keeps the
reversible patch a precise structural record; the `compact` envelope above is
the remedy when only the real change matters.

## AI proposal lifecycle

The proposal commands put typed edits into a human-review queue instead of
changing the project immediately. A project `game.json` owns the sidecar
directory `game.json.proposals/`; completed reviews move to its `archive/`
directory. Proposals work on both inline projects and sharded ProjectShells:
a shell proposal stores hunks over the sparse `{shell, shards}` logical
document (paths `/shell/...` and `/shards/<entry>/...`). Applying operations
and assessing conflicts are sparse; creation-time and accept-time QA load the
complete corpus so references and reachability cannot be hidden in an
untouched shard. `propose`, `list-proposals`, `show-proposal`, and
`list-archive` are project read-only; `withdraw-proposal`, `reject-proposal`,
and archival mutate only the queue. `accept-proposal` changes the project and
may publish attached assets before archiving. Accepting and rejecting is
available from the CLI and MCP as well as the inline desktop editor.

Every `propose` runs a QA gate over the document the proposal would produce
(schema validity plus the static lint: references, page health, and
transfer-graph reachability) and stores the findings under
`game.json.proposals/qa/<id>.json`; archived QA moves to
`archive/qa/<id>.json`. The versioned baseline in that sidecar is bound to the
proposal id and base hash. It permits unchanged creation-time errors in an
older corpus, while a new, moved, or duplicated error still blocks. Legacy
adjacent `<id>.qa.json` files remain readable but, because they have no valid
baseline, fail closed when errors exist. `list-proposals` and
`show-proposal` return the QA summary and findings; `accept-proposal` re-runs
the gate against the live full document and rolls the whole acceptance back
on a QA regression.

### Proposal request and validation

`propose` takes this arguments object:

```json
{
  "id": "docs-demo",
  "title": "Paint one tile",
  "rationale": "Demonstrate proposal review.",
  "author": "docs",
  "createdAt": "2026-10-01T00:00:00.000Z",
  "hunks": [
    {
      "id": "tile",
      "summary": "Change one entrance tile",
      "operations": [
        {
          "command": "paint-tile",
          "args": { "map": "village", "x": 0, "y": 0, "tile": "town.1" }
        }
      ]
    }
  ]
}
```

- Proposal and hunk ids match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. `title` and `author` are 1–160
  characters, `rationale` is 1–4000, and `summary` is 1–240.
- `createdAt` is optional. When present it is an ISO UTC timestamp; when
  omitted the command supplies the current time.
- `hunks` and every hunk's `operations` must be non-empty. Operations may use
  `add-item`, `add-sprite`, `add-asset`, `update-map`, `move-map`, `add-map`,
  `duplicate-map`, `delete-map`,
  `paint-tile`, `paint-rect`, `fill-region`, `paint-passage`,
  `add-event`, `update-event`, `delete-event`, `add-page`, `update-page`,
  `delete-page`, `insert-command`, `delete-command`, `update-command`, or
  `connect-maps`. Read commands, `save`, and proposal commands cannot be
  nested in a hunk. `add-item` takes `{item}`, `add-sprite` takes
  `{id,sprite}`, and proposal-only `add-asset` takes
  `{path,type:"image/png",data}` with canonical padded base64 PNG data.
  Attachment paths are confined beneath the project directory and the
  combined proposal is bounded by the pack image count, byte and pixel
  limits. `connect-maps` is a proposal macro that expands to an
  `add-event` placing a transfer event: `{map, x, y, targetMap, targetX,
  targetY, eventId?, trigger?}` (trigger defaults to `playerTouch`); it
  validates both maps and the landing bounds at proposal time. Shell
  proposals support `add-map`, `duplicate-map`, `move-map`, `delete-map`,
  and `connect-maps`, including compact `.rkm` shards.
- Operations inside one hunk run in order. Every hunk starts from the same
  original project, must produce at least one semantic JSON change or attached
  asset, and must not overlap another hunk's JSON Pointer or asset paths. The
  stored proposal replaces `operations` with validated reversible `changes`,
  stores assets on the hunk, and records the project's semantic `baseHash`.

Proposal success has a separate envelope from direct project edits:

```json
{
  "ok": true,
  "command": "propose",
  "file": "/absolute/path/game.json",
  "proposalDirectory": "/absolute/path/game.json.proposals",
  "dryRun": false,
  "written": true,
  "result": {}
}
```

For creation/list/show/withdraw, `written` says whether the command changed
the sidecar queue, not the project. A successful non-dry-run
`accept-proposal` reports `written: true` only after the project, assets, and
archive transition have all succeeded. A verified rollback reports
`written: false`; `PROPOSAL_PARTIAL_WRITE` reports `written: true` with
recovery details if compensation cannot be verified. `propose --dry-run`
still builds and
validates the complete proposal and checks for an id collision, but returns
`written: false` and creates nothing. `list-proposals` and `show-proposal`
always return `written: false`; `withdraw-proposal --dry-run` validates that a
pending proposal exists without deleting it.

Proposal failure uses the same one-object stdout contract:

```json
{
  "ok": false,
  "command": "show-proposal",
  "file": "/absolute/path/game.json",
  "dryRun": false,
  "written": false,
  "error": { "code": "PROPOSAL_NOT_FOUND", "message": "proposal \"missing\" does not exist" }
}
```

The following four examples were run consecutively against a fresh copy of
Sunstone. The `jq` filters omit absolute temporary paths and large proposal
payloads, but the displayed JSON is the actual output. The project SHA-256 was
unchanged before and after the lifecycle.

Save the request above as `proposal.json`, then prepare the disposable copy:

```sh
DEMO_DIR="$(mktemp -d)"
cp examples/sunstone/data/sunstone.json "$DEMO_DIR/game.json"
PROPOSAL="$(jq -c . proposal.json)"
```

### `propose`

Args: `id`, `title`, `rationale`, `author`, and `hunks` are required;
`createdAt` is optional. `result` is `{ path, proposal, qa }` (plus
`touchedEntries` on a shell), where `path` is the new pending sidecar,
`proposal` contains `baseHash` plus generated changes/assets, and `qa` is the
creation-time QA report (`{checkedAt, documentHash, findings, errors,
warnings, infos}`). Findings use lint check ids such as
`lint/sprite-missing`; error findings do not block creation but are
re-checked at accept time. Normal mode atomically creates the sidecar and
its QA sidecar under `qa/`; `--dry-run` writes nothing.

```sh
$ bun run rpgkit-edit propose --file "$DEMO_DIR/game.json" --json "$PROPOSAL" \
    | jq -c '{ok,command,dryRun,written,result:{path:(.result.path|split("/")|last),proposal:{id:.result.proposal.id,baseHash:.result.proposal.baseHash,hunks:(.result.proposal.hunks|map({id,changeCount:(.changes|length)}))}}}'
{"ok":true,"command":"propose","dryRun":false,"written":true,"result":{"path":"docs-demo.json","proposal":{"id":"docs-demo","baseHash":"57b33669a8c5a2302462507cf558970ebdbf230ca5101b71b52290e355285fe5","hunks":[{"id":"tile","changeCount":1}]}}}
```

Command-specific errors are `INVALID_PROPOSAL_REQUEST` (shape or required
field), `INVALID_PROPOSAL_OPERATION` (not an editing operation),
`PROPOSAL_OPERATION_FAILED` (an edit failed; its error is in `details`),
`EMPTY_PROPOSAL_HUNK`, `INVALID_PROPOSAL`, and
`PROPOSAL_ALREADY_EXISTS`. A duplicate id, for example, returns
`{"code":"PROPOSAL_ALREADY_EXISTS","message":"proposal \"docs-demo\" already exists"}`.

### `list-proposals`

Args: none. `result` is the pending queue ordered by `createdAt` then id. Each
row is `{ id, title, author, createdAt, hunkCount, pendingHunks, assessment,
qa? }`. `assessment` contains `baseMatches`, `hasConflicts`, and hunk rows
whose `state` is `clean`, `already-applied`, `partially-applied`, or
`conflict`. JSON preconditions and attached asset bytes both contribute to
that state: a missing attachment is clean, identical bytes are
already-applied, and different bytes conflict. On a shell the assessment
loads only each proposal's touched shards. `qa` is the summary
`{checkedAt, errors, warnings, infos}` when a QA sidecar exists.

```sh
$ bun run rpgkit-edit list-proposals --file "$DEMO_DIR/game.json" \
    | jq -c '{ok,command,dryRun,written,result:(.result|map({id,hunkCount,pendingHunks,assessment:{baseMatches:.assessment.baseMatches,hasConflicts:.assessment.hasConflicts,states:(.assessment.hunks|map(.state))}}))}'
{"ok":true,"command":"list-proposals","dryRun":false,"written":false,"result":[{"id":"docs-demo","hunkCount":1,"pendingHunks":1,"assessment":{"baseMatches":true,"hasConflicts":false,"states":["clean"]}}]}
```

The arguments object must be empty; extra fields fail with
`INVALID_ARGUMENT`. A malformed sidecar fails the whole list with
`INVALID_PROPOSAL` instead of being silently skipped.

### `show-proposal`

Args: `id` (required). `result` is
`{ path, archived, proposal, assessment, qa }`. Pending hunks omit `decision`;
after review, each decision has `status: "accepted"` or `"rejected"` and, for
CLI/MCP decisions, `source` and `decidedAt`. The command searches pending
first and then `archive/`, so an agent can poll until `archived` becomes
true. `qa` is the full QA report when a sidecar exists.

```sh
$ bun run rpgkit-edit show-proposal --file "$DEMO_DIR/game.json" --json '{"id":"docs-demo"}' \
    | jq -c '{ok,command,dryRun,written,result:{archived:.result.archived,id:.result.proposal.id,decisions:(.result.proposal.hunks|map(.decision.status?)),states:(.result.assessment.hunks|map(.state))}}'
{"ok":true,"command":"show-proposal","dryRun":false,"written":false,"result":{"archived":false,"id":"docs-demo","decisions":[null],"states":["clean"]}}
```

An absent or non-string id is `INVALID_PROPOSAL_REQUEST`, an unsafe id is
`INVALID_PROPOSAL_ID`, extra fields are `INVALID_ARGUMENT`, and an id found in
neither location is `PROPOSAL_NOT_FOUND`.

### `withdraw-proposal`

Args: `id` (required). Only a pending proposal can be withdrawn. Normal mode
deletes its sidecar and returns `{ id, withdrawn: true }`; `--dry-run` returns
the same result with top-level `dryRun: true, written: false` and leaves it in
the queue.

```sh
$ bun run rpgkit-edit withdraw-proposal --file "$DEMO_DIR/game.json" --json '{"id":"docs-demo"}' \
    | jq -c '{ok,command,dryRun,written,result}'
{"ok":true,"command":"withdraw-proposal","dryRun":false,"written":true,"result":{"id":"docs-demo","withdrawn":true}}
```

Argument errors match `show-proposal`. A missing or already archived id is
`PROPOSAL_NOT_FOUND`; a live storage lock is `PROPOSAL_BUSY`.

### `accept-proposal`

Args: `id` (required), `source` (optional, defaults to `cli`; recorded on
the archived decision). Applies every clean hunk as one transaction, re-runs
the QA gate against the live document, then archives the proposal with its
decisions. `result` is `{ id, status: "accepted", archived?, projectChanged,
appliedHunks, qa, publishedAssets, summary }`, where `summary` is
`{hunks, changes, assets, paths}`.
Hunks that are already applied are skipped (an all-already-applied proposal
accepts as a no-op and still archives). A conflict (`PROPOSAL_HUNK_CONFLICT`),
a QA error (`PROPOSAL_QA_FAILED`, findings in `details`), or a proposal that
already carries decisions (`PROPOSAL_ALREADY_DECIDED`) refuses without
writing the project or the queue. On a shell, acceptance publishes the
changed shards first and the shell manifest last through the staged
multi-file writer, which restores already-published files if a later rename
fails. Assets are immutable additions: identical existing bytes count as
already applied, differing bytes conflict, and clean assets are published
before project files. Any later project or archive failure restores the
project and removes newly published assets/directories. If that compensation
cannot be verified, `PROPOSAL_PARTIAL_WRITE` reports `written: true` instead
of claiming no write. `--dry-run` reports the would-be result with
`written: false` and changes nothing.

### `reject-proposal`

Args: `id` (required), `source` (optional). Records a `rejected` decision on
every hunk and archives the proposal without touching the project. `result`
is `{ id, status: "rejected", archived?, summary }`. A proposal that already
carries decisions is `PROPOSAL_ALREADY_DECIDED`; a missing id is
`PROPOSAL_NOT_FOUND`. `--dry-run` validates without archiving.

### `list-archive`

Args: none. `result` is the decided history, one row per archived proposal:
`{ id, title, author, createdAt, decidedAt, status, source?, summary, qa? }`.
`status` is `accepted`, `rejected`, or `mixed` (per-hunk decisions from the
desktop editor). `qa` is the summary of the archived QA sidecar when one
exists.

Proposal commands can report `INVALID_PROPOSAL_ASSET`,
`UNSAFE_PROPOSAL_PATH`, `PROPOSAL_IO_ERROR`, `PROPOSAL_PARTIAL_WRITE`, and,
when constrained by an MCP root, `PATH_OUTSIDE_ROOT`.

## The `rpgkit-edit/patch-v1` envelope

```json
{
  "format": "rpgkit-edit/patch-v1",
  "beforeHash": "01fb89c775a8f229acefccbc79c29d23110b323fec6178fb75f03ebf546a54b5",
  "afterHash": "76b5f5ca537e0c00e105d2a34c7a3a2636c67a0f0d20495968d20b253205b398",
  "changes": [
    {
      "path": "/maps/0/ground/21",
      "before": { "exists": true, "value": "town.0" },
      "after": { "exists": true, "value": "town.42" }
    }
  ]
}
```

- `beforeHash`/`afterHash` are lowercase SHA-256 hex of canonical semantic
  JSON (sorted keys).
- Inline paths are RFC 6901 JSON Pointers into the project, such as
  `/maps/0/ground/21`.
- A shell patch points into a logical
  `{ kind: "rpgkit-edit/sharded-document-v1", shell, shards }` document.
  Examples are `/shell/mapIndex/0/sha256`, `/shell/mapManifestHash`, and
  `/shards/maps~1village.json/ground/21`. Its `shards` object contains only
  operation-involved payloads; the shell manifest commits the untouched set.
  The stable key is `mapIndex.entry`, not map id. RFC 6901 encodes `~` as
  `~0` and `/` as `~1`.
- `before`/`after` sides distinguish a missing value (`{ "exists": false }`)
  from a JSON null (`{ "exists": true, "value": null }`).
- Forward applies changes in order, expecting `before` and writing `after`;
  reverse applies them in reverse order, expecting `after` and writing
  `before`. The base hash must match or the save fails closed.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success |
| 1 | edit/proposal domain failure: the response is `{ "ok": false, "error": … }` (unknown command, not found, conflict, invalid proposal, patch mismatch, and so on) |
| 2 | CLI usage error: missing `--file`, malformed `--json`, unknown flag; stdout is a `CLI_USAGE` error object |

## MCP tools

The MCP server (`bun run rpgkit-edit:mcp`, or
`bun tools/rpgkit-edit/mcp.ts --root <project-dir>`) speaks newline-delimited
JSON-RPC 2.0 over stdio and mounts edit, proposal, and QA check tools (see
[qa-checks.md](qa-checks.md)). Every tool takes a `file` argument that must
resolve inside `--root`; every shard referenced by a shell must remain inside
that root after symlink resolution. Mutating tools also take `dryRun`.

| MCP tool | CLI command | required args | optional args |
| --- | --- | --- | --- |
| `rpgkit_project_open` | `open` | `file` | — |
| `rpgkit_maps_list` | `list-maps` | `file` | — |
| `rpgkit_events_list` | `list-events` | `file`, `map` | — |
| `rpgkit_pages_list` | `list-pages` | `file`, `map`, `event` | — |
| `rpgkit_commands_list` | `list-commands` | `file`, `map`, `event`, `page` | — |
| `rpgkit_items_list` | `list-items` | `file` | — |
| `rpgkit_item_get` | `get-item` | `file`, `item` | — |
| `rpgkit_item_add` | `add-item` | `file`, `item` | `dryRun` |
| `rpgkit_item_update` | `update-item` | `file`, `item`, `changes` | `dryRun` |
| `rpgkit_item_remove` | `remove-item` | `file`, `item` | `dryRun` |
| `rpgkit_sprites_list` | `list-sprites` | `file` | — |
| `rpgkit_sprite_get` | `get-sprite` | `file`, `sprite` | — |
| `rpgkit_sprite_add` | `add-sprite` | `file`, `sprite`, `value` | `dryRun` |
| `rpgkit_sprite_update` | `update-sprite` | `file`, `sprite`, `value` | `dryRun` |
| `rpgkit_sprite_remove` | `remove-sprite` | `file`, `sprite` | `dryRun` |
| `rpgkit_audio_list` | `list-audio` | `file` | — |
| `rpgkit_audio_get` | `get-audio` | `file`, `audio` | — |
| `rpgkit_audio_add` | `add-audio` | `file`, `audio`, `value` | `dryRun` |
| `rpgkit_audio_update` | `update-audio` | `file`, `audio`, `value` | `dryRun` |
| `rpgkit_audio_remove` | `remove-audio` | `file`, `audio` | `dryRun` |
| `rpgkit_sheets_list` | `list-sheets` | `file` | — |
| `rpgkit_sheet_get` | `get-sheet` | `file`, `sheet` | — |
| `rpgkit_sheet_add` | `add-sheet` | `file`, `sheet` | `dryRun` |
| `rpgkit_sheet_update` | `update-sheet` | `file`, `sheet`, `changes` | `dryRun` |
| `rpgkit_sheet_remove` | `remove-sheet` | `file`, `sheet` | `dryRun` |
| `rpgkit_switches_list` | `list-switches` | `file` | — |
| `rpgkit_switch_get` | `get-switch` | `file`, `switch` | — |
| `rpgkit_switch_add` | `add-switch` | `file`, `switch` | `dryRun` |
| `rpgkit_switch_update` | `update-switch` | `file`, `switch`, `changes` | `dryRun` |
| `rpgkit_switch_remove` | `remove-switch` | `file`, `switch` | `dryRun` |
| `rpgkit_variables_list` | `list-variables` | `file` | — |
| `rpgkit_variable_get` | `get-variable` | `file`, `variable` | — |
| `rpgkit_variable_add` | `add-variable` | `file`, `variable` | `dryRun` |
| `rpgkit_variable_update` | `update-variable` | `file`, `variable`, `changes` | `dryRun` |
| `rpgkit_variable_remove` | `remove-variable` | `file`, `variable` | `dryRun` |
| `rpgkit_map_update` | `update-map` | `file`, `map`, `changes` | `dryRun` |
| `rpgkit_map_add` | `add-map` | `file` | `map`, `name`, `width`, `height`, `sheets`, `fill`, `after`, `dryRun` |
| `rpgkit_map_duplicate` | `duplicate-map` | `file`, `map` | `dryRun` |
| `rpgkit_map_delete` | `delete-map` | `file`, `map` | `dryRun` |
| `rpgkit_map_move` | `move-map` | `file`, `map`, `index` | `dryRun` |
| `rpgkit_tile_paint` | `paint-tile` | `file`, `map`, `x`, `y`, `tile` | `layer`, `dryRun` |
| `rpgkit_tile_rect` | `paint-rect` | `file`, `map`, `x`, `y`, `width`, `height`, plus `tile`, `value`, or `template:"room"` as described above | `layer`, `doors`, `dryRun` |
| `rpgkit_tile_fill` | `fill-region` | `file`, `map`, `x`, `y`, `tile` | `layer`, `dryRun` |
| `rpgkit_passage_paint` | `paint-passage` | `file`, `map`, `x`, `y`, `value` | `dryRun` |
| `rpgkit_cells_paint` | `paint-cells` | `file`, `map`, `cells`, exactly one of `value` / `values` | `layer`, `dryRun` |
| `rpgkit_edges_paint` | `paint-edges` | `file`, `map`, `cells`, `brush` | `dryRun` |
| `rpgkit_event_add` | `add-event` | `file`, `map`, `event` | `index`, `dryRun` |
| `rpgkit_event_update` | `update-event` | `file`, `map`, `event`, `changes` | `dryRun` |
| `rpgkit_event_delete` | `delete-event` | `file`, `map`, `event` | `dryRun` |
| `rpgkit_page_add` | `add-page` | `file`, `map`, `event`, `page` | `index`, `dryRun` |
| `rpgkit_page_update` | `update-page` | `file`, `map`, `event`, `page`, `value` | `dryRun` |
| `rpgkit_page_delete` | `delete-page` | `file`, `map`, `event`, `page` | `dryRun` |
| `rpgkit_command_insert` | `insert-command` | `file`, `map`, `event`, `page`, `address`, `command` | `dryRun` |
| `rpgkit_command_delete` | `delete-command` | `file`, `map`, `event`, `page`, `address` | `dryRun` |
| `rpgkit_command_update` | `update-command` | `file`, `map`, `event`, `page`, `address`, `field`, `value` | `dryRun` |
| `rpgkit_project_validate` | `validate` | `file` | `map` |
| `rpgkit_project_batch` | `batch` | `file`, `operations` | `dryRun`, `envelope` |
| `rpgkit_project_save` | `save` | `file`, `patch` | `direction`, `dryRun` |
| `rpgkit_proposal_create` | `propose` | `file`, `id`, `title`, `rationale`, `author`, `hunks` | `createdAt`, `dryRun` |
| `rpgkit_proposals_list` | `list-proposals` | `file` | — |
| `rpgkit_proposal_show` | `show-proposal` | `file`, `id` | — |
| `rpgkit_proposal_withdraw` | `withdraw-proposal` | `file`, `id` | `dryRun` |
| `rpgkit_proposal_accept` | `accept-proposal` | `file`, `id` | `source`, `dryRun` |
| `rpgkit_proposal_reject` | `reject-proposal` | `file`, `id` | `source`, `dryRun` |
| `rpgkit_proposal_archive` | `list-archive` | `file` | — |

Proposal tool arguments have the same constraints as their CLI command.
`rpgkit_proposal_create` is annotated as a non-destructive sidecar mutation;
withdraw, accept and reject are destructive; list/show/archive are read-only. A
list call may nevertheless finish crash recovery by moving an already-decided
pending sidecar into `archive/`. A successful `tools/call` result wraps the
same CLI envelope twice:

```json
{
  "content": [{ "type": "text", "text": "{\"ok\":true,...}" }],
  "structuredContent": { "ok": true, "command": "propose", "written": true, "result": {} },
  "isError": false
}
```

A proposal domain failure is still a JSON-RPC result, with the failure
envelope in `structuredContent` and `isError: true`. A proposal/edit file
outside `--root` follows that path with `PATH_OUTSIDE_ROOT`. Input that fails
the tool's JSON Schema or names an unknown tool uses JSON-RPC `-32602`; an
unexpected server exception uses `-32603`.

These normalized excerpts came from one real stdio session. Only the absolute
temporary path, an unrelated queue row, and large proposal fields are
shortened; each arrow's object is the corresponding `structuredContent`
result.

```text
rpgkit_proposal_create({file:"/work/demo/game.json",id:"docs-mcp",title:"Paint one tile through MCP",rationale:"Demonstrate the MCP proposal lifecycle.",author:"docs",createdAt:"2026-10-01T00:01:00.000Z",hunks:[{id:"tile",summary:"Change one entrance tile",operations:[{command:"paint-tile",args:{map:"village",x:1,y:0,tile:"town.1"}}]}]})
→ {ok:true,command:"propose",dryRun:false,written:true,result:{proposal:{id:"docs-mcp",hunks:[{id:"tile",changes:[...]}]}}}

rpgkit_proposals_list({file:"/work/demo/game.json"})
→ {ok:true,command:"list-proposals",dryRun:false,written:false,result:[{id:"docs-mcp",pendingHunks:1,assessment:{baseMatches:true,hasConflicts:false,hunks:[{id:"tile",state:"clean",conflicts:[]}]}}]}

rpgkit_proposal_show({file:"/work/demo/game.json",id:"docs-mcp"})
→ {ok:true,command:"show-proposal",dryRun:false,written:false,result:{archived:false,proposal:{id:"docs-mcp"},assessment:{baseMatches:true,hasConflicts:false}}}

rpgkit_proposal_withdraw({file:"/work/demo/game.json",id:"docs-mcp"})
→ {ok:true,command:"withdraw-proposal",dryRun:false,written:true,result:{id:"docs-mcp",withdrawn:true}}
```

Register it with an absolute script path and root, for example:

```sh
claude mcp add --scope project rpgkit-edit -- \
  bun /absolute/path/to/pocket-rpgkit/tools/rpgkit-edit/mcp.ts \
  --root /absolute/path/to/game-project
```

## Editor local-agent integration

For an inline project, the desktop editor can turn a natural-language request
into an AI proposal without embedding or depending on one agent frontend. Open
**PROPOSALS**, type in “Describe what to change”, and press Enter or **RUN**.
The editor sends the current map, the last explicitly selected cell, and the
selected event/page as context. When the command creates a proposal, the
editor reloads the sidecar queue and opens the first new proposal in the
normal review UI. Nothing is accepted automatically.

The integration has three process boundaries:

1. The PocketJS editor guest sends `rpgkit-local-agent/v1` start/cancel
   messages over its existing SVC channel. It cannot spawn processes or read
   arbitrary host files.
2. The Bun launcher owns a loopback-only companion. Every launcher run creates
   a fresh 256-bit token that the desktop host must present in its PKNT hello;
   the fixed editor app name is not accepted. The companion verifies that the
   request's semantic project hash still matches the host file, starts at most
   one configured command, enforces its timeout, and reports lifecycle states
   back to the guest. Each agent starts in an independent process group.
   **CANCEL** and timeout send `SIGTERM` to that whole group, followed by
   group-wide `SIGKILL` after one second if needed; their terminal state waits
   for this cleanup barrier.
3. The child command receives a private MCP registration for
   `tools/rpgkit-edit/mcp.ts --root <project-dir> --proposal-only`.
   Proposal-only mode exposes project reads, `validate`, non-writing QA checks,
   and proposal create/list/show. It does not expose direct project mutations,
   proposal withdrawal, or `rpgkit-shot`; the only write is creation of a
   review sidecar. This is enforced by the MCP server's tool registry, not by
   the prompt or a client-side allowlist.

The random token blocks an unrelated process from claiming the endpoint by
guessing its fixed app name. It is not an operating-system sandbox: another
process running as the same account may be able to inspect the desktop host's
command line and recover the token. Use normal account and machine isolation
when that threat is in scope.

The companion also prepends a fixed policy that tells the agent to use this
MCP server and create one proposal. A configurable prompt template follows
it. An exit-zero command that creates no new proposal is reported as a
failure. The editor refuses to start when it has unsaved edits or a save is
still pending; the companion repeats the semantic-hash check immediately
before spawning, closing the race with stale editor content. Sharded editor
sessions use a separate confined file companion and deliberately disable both
proposal review and local-agent requests.

### Built-in adapters

TraeCLI is the default. Both built-ins use a one-shot session and an isolated
MCP registration:

```sh
bun run editor --agent traecli
bun run editor --agent claude
bun run editor --agent off
```

The TraeCLI adapter runs `traecli exec` with ephemeral/read-only settings and
passes the MCP registration as a command configuration. The Claude Code
adapter runs `claude -p` with a strict MCP config, no persisted session, and
an `mcp__rpgkit-edit__*` allowlist. If the chosen executable is not installed
or executable, the input remains visible and the panel explains the problem.

### Custom MCP-capable commands

Pass a JSON file with `--agent-config`. A complete editable example lives at
[`editor/agent-config.example.json`](../editor/agent-config.example.json):

```sh
bun run editor --agent-config editor/agent-config.example.json
```

Its fields are:

| field | meaning |
| --- | --- |
| `adapter` | `traecli`, `claude`, `custom`, or `off`. `custom` requires `command`. |
| `name` | Short label shown in the proposal panel and status messages. |
| `command` | Non-empty argv array. It is spawned directly, without a shell. |
| `mcpRegistration` | `claude-json` for the generated `mcpServers` JSON file, or `traecli-config` for the generated TraeCLI config expression. |
| `workingDirectory` | Child working directory; defaults to `{{projectDir}}`. |
| `timeoutMs` | Integer from 20 through 1,800,000; defaults to 120,000. |
| `promptTemplate` | Text appended after the fixed proposal-only policy. |
| `env` | String environment variables explicitly added to or overriding the inherited safe baseline. |

`workingDirectory` accepts `{{projectDir}}` and `{{repoRoot}}`. Command and
environment values also accept `{{prompt}}`, `{{promptFile}}`,
`{{mcpConfig}}`, `{{mcpRegistration}}`, `{{projectFile}}`, `{{request}}`, and
`{{contextJson}}`. The prompt template accepts `{{request}}`,
`{{contextJson}}`, `{{projectFile}}`, `{{projectDir}}`, and `{{repoRoot}}`.
Unknown placeholders and unknown config fields are rejected. The launcher
also sets `RPGKIT_AGENT_PROJECT_FILE`, `RPGKIT_AGENT_MCP_CONFIG`, and
`RPGKIT_AGENT_REQUEST_ID`, which makes a small wrapper sufficient for an MCP
client with a different command-line syntax.

The child does not inherit the launcher's full environment. The inherited
baseline is exactly `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`TMP`, `TEMP`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`,
`NO_COLOR`, `FORCE_COLOR`, `TZ`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `TRAE_HOME`,
`CLAUDE_CONFIG_DIR`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, and
`NODE_EXTRA_CA_CERTS`, when each is present in the launcher. Tokens, cloud
credential families, proxy URLs, SSH agent sockets, runtime options, and
dynamic-loader variables are not inherited implicitly. A custom command that
needs one may opt in through `env`; keep configurations containing secrets out
of source control. Environment names must use shell-variable syntax, and
launcher-owned `RPGKIT_AGENT_PROJECT_FILE`, `RPGKIT_AGENT_MCP_CONFIG`, and
`RPGKIT_AGENT_REQUEST_ID` cannot be overridden.

### Desktop and manual verification

A static web page cannot start a process on the viewer's computer. The web
editor therefore reports “Desktop companion required”; it can still review
proposals placed in its queue by another integration. The shipped launcher
implements local agents for the Linux and macOS desktop hosts.

Real agents are deliberately not called by the automated test suite. To check
an installed adapter manually:

1. Run `traecli --version` or `claude --version`.
2. Launch `bun run editor --agent traecli` (or `--agent claude`).
3. In EVENT mode select an event (or select a cell and save any resulting
   edit), open **PROPOSALS**, enter a small request, and press Enter.
4. Confirm the status changes to running, **CANCEL** is available, and the
   completed proposal opens without changing the map.
5. Accept one clean hunk, then use Cmd+Z (Ctrl+Z on Linux) to verify the normal
   proposal-review undo path.

Automated coverage uses an offline fake command. It reads the real prompt,
connects to the generated stdio MCP server, checks that direct edit tools are
absent, calls `rpgkit_proposal_create`, then drives proposal acceptance and
undo in the PocketJS wasm simulator. Separate cases cover the pre-launch hash
recheck, environment filtering, a TERM-resistant grandchild, timeout,
cancellation, concurrency, an unavailable executable, rejection of a fixed
SVC app name, and fresh authentication tokens across launches.
