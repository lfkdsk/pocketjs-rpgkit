# Pocket RPG Kit — Editor (preview)

> **Frozen.** This PocketJS editor receives fixes but no new features. New
> editing work goes to [Studio](../docs/studio.md), which runs in the browser
> and as a desktop app through Electron (`studio-desktop/`), and to the shared
> `editor/api` protocol that Studio, `rpgkit-edit` and its MCP server use.
> Shared `editor/api` code still lands in this editor's bundle; it has no
> size budget, only a loose guard against accidental growth.

A tile-map editor for `rpgkit-project/v1` documents, running as a PocketJS
app on the portable desktop host and in the browser. It opens the kit's
example projects (`examples/sunstone`, `examples/meadow`) and paints them
with those examples' own tile art. It also edits existing map payloads in
sharded `ProjectShell` projects. The editor can render only tile and sprite
art already baked into its bundle; opening a project does not import new
assets.

Working in a browser? [Studio](../docs/studio.md) is a browser-native editor
(DOM + canvas) with a zoomable canvas, inspector forms and a history panel;
this PocketJS editor is the one that also runs on the desktop host and
devices. Both editors make every change through the `editor/api`
operations that `rpgkit-edit` runs, and both keep reversible
`rpgkit-edit/patch-v1` history: Studio through the text entry point, this
editor through the in-memory one (see
[Protocols](../docs/protocols.md#2-edit-protocol--rpgkit-edit)).
`tests/editor-api-equivalence.test.ts` checks that the same edits produce
identical patches, undo/redo stacks and saved bytes in both.

New to the editor? [`docs/editor-tutorial.md`](../docs/editor-tutorial.md)
follows one small scenario — a villager NPC with branching dialog and a
one-time reward, a second map with two-way portals, and a play-test with
the live debugger — from launch to save, with regenerable screenshots and
a guard test.

## What it does

- **Tile painting**: click or drag on the canvas to paint ground cells.
  The first header button cycles **GROUND → UPPER → PASS → EVENT**. Upper is
  the sparse star layer drawn above characters at runtime; PASS paints
  passage overrides and one-way edges (see below). Right click or
  shift+click erases; palette slot 0 is the eraser brush.
- **Events**: EVENT mode selects the topmost event under the pointer and
  highlights its full `w`×`h` footprint. Drag anywhere in that footprint to
  move it without changing the grabbed-cell offset. The left tools create an
  event at the last canvas cell, open its inspector, copy it, or delete it.
  The inspector edits the display name, origin and footprint.
- **Pages**: add, delete, copy and reorder pages; select the trigger, existing
  sprite key, facing, autonomous move type, `blocks`, and a basic movement
  route. Conditions support the v1 flat forms and every current schema kind in
  compound `all` clauses: switches, variables, self switches, items, gold,
  facing, appearance, tile-property overrides, `worldIdle`, `bgmPlaying`, and
  extension predicates.
- **Commands**: the inspector shows the recursive command tree with indented
  `if`/`else`, choices/cancel, battle-result, scene done/cancel and loop-body
  branches.
  It can add, delete, copy and reorder commands, and edit every command kind
  in the current project schema, including movement control, presentation,
  shops, map animations, audio, extensions, battle processing and game
  scenes. The `autosave` entry is shown as `autosave / 自动存档` and inserts
  the parameterless command directly. In the add prompt, type an op such as `text`; with a selected
  parent, `text@then`, `text@else`, `text@option1`, `text@cancel`,
  `text@win`/`text@lose`/`text@escape` (battle), or `text@done`/`text@cancel`
  (scene), or `break@body` (a selected `loop`) inserts directly into that
  branch.
- **Undo/redo**: every edit is one `editor/api` operation and one history
  step, 64 steps deep. A paint drag previews cell by cell and commits as one
  `paint-cells` (or, for PASS-mode edges, `paint-edges`) operation when it
  ends; event, page, condition and command edits are `add-event`,
  `update-event`, `delete-event`, `add-page`, `update-page` or
  `delete-page`. Undo applies the step's reversible patch backwards and
  restores the exact earlier document; redo applies it forwards. A stroke on
  the upper or PASS layer stores its cells as sparse pairs when it commits,
  so a newly painted cell's pair follows the existing ones. An
  operation the protocol refuses (for example a resize that would leave the
  start position outside the map) changes nothing and shows
  `EDIT REFUSED: ...` in the status bar.
  **UNDO**/**REDO** in the header, or Cmd+Z / Cmd+Shift+Z / Cmd+Y (Cmd is
  Ctrl on Linux).
- **Compact and resizable layouts**: the editor follows live desktop and web
  viewport changes. At widths below 616 px the less-frequent document, map
  navigation, and play-state actions move behind **MORE**; at the 400 px web
  minimum, undo/redo move there too. Labels and dynamic values use the baked
  font's measured pixel width, long prose wraps or truncates at word
  boundaries, and the status bar keeps map, dimensions, layer, and selection
  visible before adding transient notices.
- **In-editor playtest (inline projects)**: **PLAY** starts the production `GameView` and
  reducer from the current in-memory document, including unsaved edits. The
  most recently selected canvas cell on the current map becomes the
  disposable preview start; if no cell was selected, the document's
  authored `start` is used. During play the hidden editor canvas and panels
  do not receive input. Click **STOP**, press Escape, or press **START** to
  return to the same editor state and undo/redo history.
- **Live debugger**: **DEBUG** (or **SELECT**) opens a panel for switches,
  variables, self switches on the current map, inventory, gold, and running
  event pages/fibers with their command addresses. Click a row's `-`/`+`
  controls to change only the disposable session; page conditions observe
  the new value on the next reducer step. Before PLAY, the **STATE** header
  button chooses **FRESH** or **LAST**. LAST carries only switches and
  variables from the previous run, leaving inventory, gold, self switches,
  map visit state, extension state, and RNG freshly initialized.
- **Preview fallbacks**: an amber in-play notice lists project capabilities
  for which the editor has no game registration. Unknown `ext` handlers are
  deterministic no-ops, battle commands open a visible preview scene
  (CIRCLE = win, CROSS = escape), unregistered scenes open a visible
  placeholder, and named screen backdrops receive a visible placeholder
  asset. These fallbacks affect only the editor bundle.
- **Maps (inline projects)**: **<** and **>** switch between the document's maps; the palette
  shows every cell of the sheets the current map declares. The **MAP** header
  button opens the map inspector:
  - **properties**: id (rename follows `start.map` and every transfer that
    names the old id), display name, width/height (resize expands with void
    or crops; events fully outside are cropped and listed in a persistent
    inspector notice, partially outside clamp — every resize is one undo
    step; a resize that would leave the start position outside the map is
    refused), and the sheet list. Unknown fields the schema adds later are
    preserved untouched.
  - **NEW** creates an empty map after the current one (20×14, its sheets,
    filled with cell 0 of its first declared sheet) and selects it; **DUP**
    copies the map with a unique
    `-copy` id (event ids are map-local, so the copy keeps them verbatim
    and intra-map `place`/`moveRoute` references stay valid); **DEL** refuses
    the only map and the start map, pages every transfer targeting the map
    with its source and recursive command address, and needs a second click
    to confirm. Crop warnings, save errors, and delete confirmation remain
    visible while the inspector is open.
- **Sharded maps**: the host sends the shell/catalog first and the editor asks
  for only the start or selected map payload. **MAP** opens a virtualized
  catalog: click or wheel, or use Arrow keys/Home/End and Enter; Escape closes
  it. `>` marks the active map, `*` marks dirty maps, and `LOADING` marks the
  outstanding request. Only visible rows plus four overscan rows are mounted.
  The resident cache retains at most four clean inactive maps by default;
  active and dirty maps are pinned, so that is a soft bound.
- **Passage overrides**: the LAYER button cycles GROUND → UPPER → **PASS** →
  EVENT. PASS mode paints per-cell `passage` overrides (PASS / BLOCK /
  CLEAR brushes, green/red corner markers) and toggles one-sided
  `dirEdges` on the sheet of the painted cell's ground tile (IN-*/OUT-*
  tools for enter/exit edges, CLR-EDGE to clear; blue arrows point into
  the cell, orange out). Both are undoable drag strokes. Per-map passage
  painting works in a shard; sheet-level edge tools are inline-only because
  they change project-global sheet data.
  Button-only navigation follows the visible two-column PASS tool grid, so
  every operation is reachable without changing the tile palette's layout.
- **Transfer picking (inline projects)**: a transfer command's inspector row has a **PICK**
  button. Click it, switch maps with **<**/**>**, click any cell, and the
  command's map/x/y/dir fill from the canvas. The map/x/y/dir fields stay
  text-editable, so `$variable` operands still work.
- **AI proposal review (inline desktop projects)**: **PROPOSALS** opens the
  validated sidecar queue.
  The list shows title, author, pending hunk count, and live conflict state.
  Selecting a proposal shows its rationale and hunks, locates the chosen hunk
  on its map, overlays proposed ground/upper tiles at partial opacity, and
  marks added events with translucent green boxes, deleted events in red,
  moved events in blue, and other event changes in amber. **ACCEPT**,
  **REJECT**, and **ALL** review
  hunks independently. Conflicting hunks cannot be accepted; an acceptance
  (including several hunks through ALL) is one undo step, while rejection does
  not touch the project.
  Agents create, list, inspect, and withdraw queue entries through the four
  proposal CLI/MCP operations documented in the
  [edit API reference](../docs/edit-api.md#ai-proposal-lifecycle).
- **Natural-language proposals (inline desktop projects)**: the top of **PROPOSALS** has a
  “Describe what to change” box. The desktop launcher can run TraeCLI,
  Claude Code, or a configured MCP-capable command. The request includes the
  current map and the last explicitly selected canvas cell plus the selected
  event/page, when present. The agent receives a proposal-only MCP server: it
  can inspect the project, run non-writing checks, and create a review
  proposal, but it cannot edit the project directly. Only one request runs at
  a time; **CANCEL** stops it, and a completed request automatically opens its
  first new proposal. Unsaved editor changes must be saved or reloaded first.
- **Open and save**: the document is parsed and checked against
  `src/data/schema.json` on load, and again before every save, which
  refuses an invalid export with the first schema error in the status bar.
  An unedited document saves back byte for byte. After an edit, unchanged
  source spans — including other event and map objects, their property order,
  and whitespace — are reused rather than reformatting the whole file.
  In a sharded project, switching or saving flushes the active map's edits
  into its shard workspace. Save emits canonical text for dirty shards only plus a
  refreshed index/checksum/manifest shell. Dirty state clears only after the
  host acknowledges that exact save; a failed or stale acknowledgement keeps
  unsaved and newer edits dirty.

## Event command and condition editing

The inspector owns every command and condition kind currently declared by
`src/data/schema.json`. Parameterless commands such as `stopBgm`, `saveBgm`,
`erase`, and `unlockInput` have no parameter rows, but can still be added,
copied, moved, and deleted. Each accepted field change is checked against the
same project schema before it enters editor state.

Field text uses these common spellings:

- Character targets are `player`, `this`, or `event:<id>`; camera targets may
  also be `tile:<x>,<y>`. Basic routes and direction sets use comma-separated
  values. Screen-fade colours and wander bounds use four comma-separated
  integers.
- `(unset)` removes an optional property. For nullable appearance, layer, and
  tile-property fields, `null` is different: it authors a reset to the runtime
  default. The inspector prevents removing the last field from commands or
  conditions whose schema requires at least one override.
- Fields labelled **JSON** accept JSON text. These include shop `goods`,
  extension `args`, extension-choice `write`, battle `setup`, and extension
  condition arguments. The edited command or condition must still satisfy the
  project schema.
- Project maps, items, sprites, animations, audio ids, common events,
  previously authored layer/variant names, animation instance ids, and
  extension calls appear as hints where relevant. They are suggestions, not a
  replacement for validation or for game-provided resources that the project
  document cannot enumerate.

Only authored command arrays form branches. `if`, ordinary `choices`, `battle`,
`scene` and `loop` expose their respective branch lists. Select a battle and use
`<op>@win`, `<op>@lose`, or `<op>@escape` to insert into its result branches;
select a scene and use `<op>@done` or `<op>@cancel`; select a `loop` and use
`<op>@body` to insert into its body. `break` has no fields. Text lines may hold
`{name}` and `{v:<id>}` tokens; the 52-character limit applies to the line as
written, before expansion.
`extChoice` is not an authored branch container: its rows come dynamically
from the registered extension provider, while `write` describes optional
result variables.

Not yet: common-event lists, asset import, sheet-level `dirBlock`/`defaultPassage`
editing (the PASS tools paint map `passage` overrides and sheet `dirEdges`
only), or structured controls for advanced object-shaped movement steps (the
existing payloads remain preserved).

## In the browser

Open the hosted editor at
<https://lfkdsk.github.io/pocketjs-rpgkit/editor/>. To run the same site
locally:

```sh
bun run build:wasm                      # once: build the WebAssembly core
bun run web                             # build the site in dist/web
python3 -m http.server -d dist/web 8000 # open http://localhost:8000/editor/
```

**Open…** reads a local `rpgkit-project/v1` JSON file. The **Sunstone** and
**Meadow** buttons open fresh copies of the two bundled examples. These
operations affect only the working document in the page; they do not change
the repository file or upload it anywhere.

**Save** validates the document and stores it in `localStorage` for the
current site. Reloading the editor on the same browser profile and site
origin restores that saved document. **Download** exports the current
document as a JSON file; use it for backups and to move work to another
browser or machine. Browser storage is local to the profile and origin, may
be cleared by the user or browser, and is not a replacement for a downloaded
copy. If storage is disabled, full, or otherwise unavailable, the page shows
the failure instead of claiming that the document was saved; editing and
Download remain available.

The browser editor uses the tile and character art bundled from Sunstone and
Meadow. It does not import new assets.

### Sharded packs

**Open…** also accepts a self-contained sharded pack:

```json
{
  "kind": "rpgkit-edit/sharded-pack-v1",
  "shell": "{ ...ProjectShell JSON text... }",
  "shards": { "maps/town.json": "{ ...MapDef JSON text... }" }
}
```

A pack may also carry an optional `assets` record of PNG images (project art
that [Studio](../docs/studio.md#art) draws). This editor does not draw them,
but keeps them: a pack saved or downloaded here still carries its assets.
The format and limits are in [the edit API docs](../docs/edit-api.md).

A pack must contain exactly the safe relative entries its shell indexes.
The browser sends the catalog first and answers individual map reads lazily.
SAVE updates only supplied dirty shards in the in-memory pack and stores the
complete replacement in origin-local browser storage; **Download** emits that
complete replacement pack. Reload restores the browser copy when storage is
available. Project data is not uploaded. Storage/quota failures are reported,
and the originally selected local file cannot be overwritten in place.

Sharded visual editing is intentionally limited to existing map payloads.
The UI does not add, duplicate, delete, rename, or structurally edit catalog
entries; pick cross-map transfer targets; edit global sheet edges; or run an
in-editor playtest. Proposal review and natural-language local agents are also
disabled with a visible
inline-only notice because proposal hunks use inline `/maps/...` paths and the
desktop bridge writes a single inline document. `rpgkit-edit` can rename an
indexed map and rewrite its
transfers, but patch-v1 keeps entry keys stable and does not add/remove map
shards. Switching away preserves unsaved map content, while reactivating a
map starts a fresh per-map undo history. The browser needs a self-contained
pack; a loose shell alone cannot answer map requests.

## Running on the desktop

```sh
bun run editor              # dist/editor/sunstone.json, a working copy
bun run editor meadow       # dist/editor/meadow.json
bun run editor sunstone --file my-map.json   # edit another file; seeded from
                                             # the example document if missing
                                             # (relative paths start at the
                                             # repository root)
bun run editor --agent traecli # built-in TraeCLI adapter (the default)
bun run editor --agent claude  # built-in Claude Code adapter
bun run editor --agent off     # proposal review only; do not launch an agent
bun run editor --agent-config editor/agent-config.example.json
bun run editor --file game/data/project.json # existing sharded ProjectShell
bun run editor --build-only # bundle + release host, no window
bun run editor meadow -- --quit-after 600    # extra host flags pass through
```

`tools/editor.ts` resolves `editor/pocket.json` for the desktop target
(macos-app on a Mac, linux-app elsewhere), builds the bundle into
`dist/<target>/editor.{js,pak}`, builds the Rust host with
`cargo build --release`, and starts it with the `rpgkit-editor` companion.
For an inline project it passes `--file`; the host forwards the real mouse and
keyboard and sends the file's text at boot. For this managed launcher, SAVE
(header button or Cmd+S) is handed to the bridge through `data.fs` rather than
sent to the generic host writer.

For inline projects, the launcher starts the local-agent companion before the
desktop host. Each launch uses a new 256-bit PKNT handshake token, so a process
that knows only the fixed app name cannot take over the loopback endpoint. This
does not protect against a same-account process that can inspect the desktop
host's command line. The built-in TraeCLI adapter uses an ephemeral, read-only
run with an isolated MCP registration; the Claude Code adapter uses print
mode, a strict MCP config, and an allowlist for `rpgkit-edit`. If the selected
executable is absent, the proposal panel reports that it is not installed
instead of starting a task.
The child inherits only the documented execution, locale, terminal, config
directory, and TLS environment baseline plus values explicitly authorized in
`agent-config.env`. It runs in a separate process group; cancel and timeout
signal the whole group and force it down after one second if needed. The
default timeout is 120 seconds. Sharded sessions use the file companion and do
not start a local agent. See
[`docs/edit-api.md`](../docs/edit-api.md#editor-local-agent-integration) for
the custom command/config format, protocol boundary, and manual checks.

The launcher derives the proposal queue at `<file>.proposals/`, snapshots its
validated pending JSON into the editor's project-specific `data.fs`, and
reconciles changes every 200 ms while the window is open. This preserves the
guest filesystem boundary: the PocketJS app never receives arbitrary host
paths. Review updates may add hunk decisions but cannot rewrite proposal
metadata or edit changes. Rejections are recorded without waiting for a
document save. For acceptance, the launcher rechecks the hunk against the
latest host file, applies it with a byte-checked atomic replacement, and then
records the decision; unrelated external edits are retained and target
conflicts are refused. Per-proposal locks merge independent reviewers, and an
interrupted archive move is repaired on the next load. Once every hunk is
accepted or rejected, the launcher moves the proposal to
`<file>.proposals/archive/`.

The bridge first writes an explicit managed-save capability marker, then a
separate, host-owned semantic-hash snapshot into the editor data root. After an
acceptance, SAVE stays disabled until that snapshot
confirms the expected host apply. Every managed SAVE carries the exact source
hash that the editor loaded; the bridge compares it and replaces the file while
holding the same project lock used by direct agent edits and proposal
acceptance. A stale save is rejected and asks for a reload, so the check and
write cannot straddle another cooperating writer. Dead locks are moved to
token-specific reaper tombstones so concurrent recovery cannot remove a new
owner's lock. If bridge initialization later fails, the marker makes SAVE fail
closed; a generic companion without the marker keeps its legacy save channel.

For a sharded shell (`mapIndex` without `maps`), the launcher instead starts
the confined file companion through `--svc-connect`: it sends only the shell
at boot and serves map reads on demand. Shard entries resolve relative to the
shell and must stay within its directory after symlink resolution. SAVE
validates the manifest, schema, checksums and stale bases, stages every
replacement, commits dirty shards in catalog order and the shell last, and
attempts rollback if a later rename fails. Oversized shell, shard, and save
messages are transparently split into bounded service frames. AI proposal
review is unavailable on this path; the header action explains the inline-only
limit without opening a misleading review panel.

**Working copies.** The examples author their projects in code
(`examples/sunstone/game-data.ts`, `examples/meadow/mini-project.ts`);
`data/*.json` is what their cookers emit, and the games themselves still
build from code. So by default the editor works on a copy in
`dist/editor/`, seeded from the example document the first time. Passing
`--file examples/sunstone/data/sunstone.json` edits the example document
itself, but `bun run gen-assets` rewrites it from code and drops the edits,
and `tests/editor-model.test.ts` notices a document that no longer matches
the editor's bundled copy.
Once the host file is open, the **DOC** button is disabled, so SAVE can
never write a different project into it.

Mouse wheel scrolls the palette, or the condition/command list under the
pointer while the event inspector is open. Text and numeric controls accept
normal typing and paste; Enter commits and Escape cancels. Enum and boolean
controls cycle on click. The arrow keys move the gamepad cursor, which pans
the view on maps larger than the 20×14-cell window.

### Without a file companion

The website provides its own `rpgkit-editor` channel. On a different host
without that channel, such as a bare wasm sim, the editor shows an amber
banner and runs entirely from buttons: the d-pad moves a cursor across
canvas, palette/event tools and header, **CIRCLE** paints, selects or
activates, **CROSS** erases/deletes, **SQUARE**/**TRIANGLE** undo/redo,
**L**/**R** switch maps, **SELECT** cycles the editing mode, and **START**
saves. **DOC** cycles the bundled documents. Detailed inspector field entry
uses a companion's pointer and keyboard; button-only mode can close the
inspector with CROSS. In proposal review, CIRCLE accepts,
CROSS rejects, START accepts all clean hunks, and SELECT returns to the queue.
On a host with `data.fs` a save goes to
`projects/<id>.json` under the app's data root and wins over the bundled
copy at the next boot; with neither channel the save is refused with a
visible notice.

The natural-language box is desktop-only. A static web build has no authority
to spawn a process on the viewer's computer, so it shows “Desktop companion
required”; proposal files created elsewhere can still be reviewed there.

## Building and testing

```sh
bun run build:editor        # dist/editor.{js,pak} for the sim tests
bun test tests/editor-model.test.ts tests/editor-api-equivalence.test.ts \
  tests/editor-sim.test.ts tests/editor-event-sim.test.ts \
  tests/editor-proposal-sim.test.ts tests/editor-agent-companion.test.ts \
  tests/editor-agent-sim.test.ts tests/editor-playtest-sim.test.ts
tools/editor-large-quickjs-bench.sh # real-QuickJS 100x100 interaction timing
tools/editor-sharded-quickjs-check.sh # real-QuickJS sharded open, paint, save
bun editor/gen-assets.ts    # regenerate the editor's baked inputs
```

`bun run build:example` builds the editor along with the examples, and
`bun run gen-assets` runs the editor cooker after the example cookers
(it reads their documents). The cooker is deterministic: two runs produce
identical bytes.

The sim suite drives both input modes on the wasm sim host with semantic
pixel checks (banner, palette art and selection, tile art, multi-cell event
selection, inspector controls at 480×272 and 720×480, and letterbox
hit-testing), svc save/load and typed-character lines, the data.fs store, a
byte-identical no-edit round trip, proposal ghost golden and per-hunk
accept/reject/undo/persistence flow, an offline fake agent that creates a
proposal through the real MCP server, the pre-launch hash recheck, scrubbed
environment, process-group timeout/cancel/unavailable paths, and authenticated
loopback handshakes, and a click-authored speaking NPC whose saved action page
is triggered by the runtime interpreter. The playtest sim
suite additionally exercises unsaved map art through the real `GameView`,
selected-cell starts, STOP/undo continuity, live page switching, LAST/FRESH
state, capability fallbacks, and reviewed play/debug PNG goldens.
The sharded suites cover a synthetic 263-map catalog with a 100×100 map,
bounded list nodes and clean-map residency, lazy reads, changed-shard-only
save, failed/successful acknowledgements, desktop path/conflict handling,
oversized service messages, browser replacement packs, and a fresh runtime
repository reload.

## Layout

```
editor/
  editor.tsx, app.tsx   entry and shell (header, palette, canvas, status)
  agent/types.ts        local-agent SVC protocol and validation
  agent-config.example.json custom MCP agent command/template example
  svc.ts                chunked shell/shard/save and local-agent channel
  store.ts              data.fs project documents (gamepad mode)
  proposals/model.ts    portable validation, conflict, apply and preview
  proposals/store.ts    data.fs proposal-session transport
  sources.ts            which example documents and sheets the cooker reads
  gen-assets.ts         the cooker (below)
  api/                  the editor-api package surface: file adapter,
                        operations, tool schemas and shared types (the
                        rpgkit-edit CLI/MCP server is a thin adapter over it)
  engine/document.ts    parse, schema-check, source-preserving serialize
  engine/model.ts       edit model: selection, stroke preview, undo/redo;
                        every change is an editor/api operation
  engine/edit-rules.ts  history-free edit rules the editor/api operations run
                        (strokes, event/page edits, maps, sheet edges)
  engine/commands.ts    recursive command addresses and immutable edits
  engine/event-fields.ts validated page/condition/command field adapters
  engine/event-layout.ts responsive inspector geometry and hit-testing
  engine/event-canvas.ts event footprint, selection and drag geometry
  engine/proposal-layout.ts proposal panel geometry and hit-testing
  engine/layout.ts      map/sidebar geometry and pointer hit-testing
  engine/map-list.ts    virtual catalog window geometry and hit-testing
  engine/map-layout.ts  map inspector geometry
  engine/sharded-workspace.ts lazy shard cache, dirty revisions and saves
  engine/service-chunks.ts bounded large-message transport
  engine/cursor.ts      buttons-mode cursor reducer
  engine/playtest.ts    preview snapshot, carry/debug state, diagnostics
  engine/playtest-layout.ts debug panel geometry and hit-testing
  engine/playtest-view.ts production GameView asset/fallback adapter
  engine/textures.ts    tile id -> baked image key
  ui/canvas.tsx         map window: tiles, event footprints and cursors
  ui/event-inspector.tsx pages, conditions and recursive command UI
  ui/proposal-panel.tsx queue, rationale, hunk states and review controls
  ui/map-inspector.tsx  map properties, sheets and map management
  ui/map-list.tsx       bounded-node sharded map catalog
  ui/pass-panel.tsx     PASS-mode brushes and one-way edge tools
  ui/playtest.tsx       GameView, STOP/DEBUG chrome and live state panel
  ui/panels.tsx         header, palette/event tools, gamepad banner
  pocket.json           manifest: dynamic 720x480 viewport, companion
tools/editor-files.ts   desktop sharded-project file companion
generated by gen-assets.ts (committed):
  assets/tile-<sheet>-<cell>.png   one 16x16 PNG per sheet cell
  images.json                      their PSM marks
  engine/tile-keys.ts              tile id -> pak image literal
  engine/sheets.ts                 sheet grids and source files
  assets/playtest/*.pkts           raw streamed sheet cells for GameView
  assets/playtest/{player,npc}-*.png preview actor frames
  engine/playtest-assets.ts        preview texture manifest
  pak.json                         raw TILESET pak entries
  engine/projects.ts               bundled documents + schema copy
```

## Art and licenses

The editor ships no art of its own. `assets/tile-*.png` and
`assets/playtest/*.pkts` are two encodings of the same 16×16 cells cut,
unaltered, from the examples' source sheets; `assets/playtest/player-*.png`
and `npc-*.png` copy the examples' generated preview frames:
`examples/sunstone/assets/src/town-tiles.png` (Kenney Tiny Town) and
`examples/sunstone/assets/src/dungeon-tiles.png` (Kenney Tiny Dungeon),
both CC0 1.0. Meadow's `town-tiles.png` is the same file byte for byte;
the cooker refuses two examples whose sheets share an id but differ. See
`examples/sunstone/ATTRIBUTION.md` and `examples/meadow/ATTRIBUTION.md`
for sources and license texts.
