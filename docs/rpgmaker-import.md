# Importing RPG Maker MV/MZ projects

`tools/rpgmaker-import` converts an RPG Maker MV or MZ project's
`data/*.json` files, referenced images and Ogg/M4A media into an
`rpgkit-project/v1` document plus generated art and QOA audio. Plain projects
and deployments using RPG Maker's standard encrypted-media format are both
supported. It is a
prototype: it shows how much of an
RPG Maker game maps onto the kit directly, and lists what is still missing.

The importer is a build-time tool. Nothing in it is imported by the
runtime, so games that do not use it carry none of its code.

## RPG Maker parity anchors

The mappings are checked against the official MV core at commit
[`182e3144`](https://github.com/rpgtkoolmv/corescript/tree/182e31449707ba7e406db0485c44c2a9d11e2dcd):

- commands 105/405 and the continuous speed/fast-forward rules come from
  [`Game_Interpreter.command105`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L412-L424)
  and
  [`Window_ScrollText`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_windows/Window_ScrollText.js#L56-L82);
- the actor party/name/class/skill/weapon/armour/state subtypes follow the
  [`command111` actor block](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L487-L515);
- audio event commands and their volume/pitch/pan records follow
  [`command241` through `command250`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L1247-L1293)
  and
  [`AudioManager`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_managers/AudioManager.js#L81-L133).
  Its ME path pauses BGM, resumes it when the decoded buffer stops, and fades
  it in for 0.5 seconds; see
  [`playMe`/`stopMe`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_managers/AudioManager.js#L235-L268).
- Formation and window colour follow
  [`command137`/`command138`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L944-L958),
  including the two-selection
  [`swapOrder`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_scenes/Scene_Menu.js#L106-L127)
  flow. RPG Maker windows consume only the saved tone's RGB channels
  ([`Window_Base.updateTone`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_windows/Window_Base.js#L85-L88)).
- Screen tone and weather commands, including their optional waits, follow
  [`command223`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L1149-L1156),
  [`command236`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L1236-L1245)
  and the weighted interpolation in
  [`Game_Screen`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Screen.js#L214-L220).
  Particle count, stock white shapes, direction, fade and respawn ranges come
  from
  [`Weather`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_core/Weather.js#L64-L70)
  and its
  [update rules](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_core/Weather.js#L95-L108).
- Change Tileset waits for its images and refreshes the map through
  [`command282`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Interpreter.js#L1333-L1352)
  and
  [`Game_Map.changeTileset`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Map.js#L692-L695).

The public MZ v1.1.0 mirror at commit
[`5ecc09ae`](https://github.com/stak/rmmz-corescript/tree/5ecc09ae5170c6aee71c7d9513e553e3dbea116b)
has the same
[`command105`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L9855-L9867),
[`actor predicates`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L9931-L9959),
[`scrolling window`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_windows.js#L5199-L5252),
and
[`ME/BGM lifecycle`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_managers.js#L1254-L1291).
The mirror is corroborating source, not an official repository.

## Usage

```sh
bun tools/rpgmaker-import <project-dir> --out <dir> [--shard] [--placeholders visible|silent]
```

`<project-dir>` is the folder holding `data/System.json` (MV deployments
with a `www/` folder work too). The output folder receives:

| File | Contents |
| --- | --- |
| `project.json` | The `rpgkit-project/v1` document. With `--shard`, a `ProjectShell` plus one `maps/<id>.json` per map. |
| `tiles/ts<N>.png` | One generated 16 px tile sheet per RM tileset (every distinct composed cell, see [Tiles](#tiles-and-autotiles)). |
| `tiles/iconset.png` | `IconSet.png` scaled from 32 px cells to the kit's 16 px item cells, when present. |
| `sprites/*.png` | Character blocks (3 × 4 walking frames) and tile-image events. |
| `animations/*.png` | Imported MV `Animations.json` timelines, flattened into one deterministic multi-cell sheet per animation. |
| `parallaxes/*.png` | Referenced map and Change Parallax images, scaled by the same map-to-16-px factor as tiles. |
| `pictures/*.png` | Pictures used by Show Picture, copied unchanged. |
| `audio/*.qoa` | Referenced BGM/BGS/ME/SE, decoded to signed 16-bit stereo at 44.1 kHz and encoded with the kit's deterministic QOA encoder. |
| `system/balloon.png` | The balloon sheet, when Show Balloon Icon is used. |
| `assets.json` | The render manifest an asset cooker bakes: sheets (including item cells), sprites, animations, parallaxes, pictures, audio, animated water cells per map, the balloon sheet, and the player's sprite. |
| `battle.json` | Normalized actors, classes, enemies, troops, skills, items, states, terms and map encounters for the opt-in front-view battle module. |
| `audio-media.json` | Stable per-track source/output byte counts, source format, decoded channels/rate/frames and 60 Hz duration; missing/corrupt media includes its reason. |
| `coverage.md` | What happened to every construct in this project, the code-side RPG Maker capabilities the application must register, and the table of every MV/MZ command. |
| `coverage.json` | The machine-readable per-project construct counts (the static command table is Markdown-only). |

`--placeholders silent` drops the visible text boxes that stand in for
plugin and script commands (they still count as Placeholder).

Importing the same project twice writes the same bytes.

### Importing in Studio

Studio exposes the same conversion as **Open → Import RPG Maker MV/MZ…** in
English and Chinese. It asks for a project folder, shows progress, then shows
the exact Native / Degraded / Placeholder / Dropped totals, every
Placeholder/Dropped reason and warnings. The converted project is not opened
until **Open result** is pressed, so the current document remains available
while the report is reviewed. A failed import keeps the current document and
shows a readable error.

- In Chrome and Edge, the browser directory picker requests read-only access.
  Conversion stays in the page and the result is a self-contained sharded
  pack. Maps and images, including standard encrypted deployment images, are
  imported; referenced Ogg/M4A is reported Dropped because a browser page has
  no ffmpeg/QOA conversion host. The ordinary Studio pack and image limits
  are checked before the result can be opened.
- The desktop app uses native dialogs for the source folder and destination
  parent. A helper runs the full importer, including audio conversion. It
  writes a hidden sibling staging folder, refuses an existing destination,
  removes staging on failure or cancellation, and publishes the completed
  folder with one rename before opening it through Studio's opaque folder
  token. It never overwrites an existing project.

### Running an imported project

`project.json` runs on the kit's engine like any other project; the art has
to be baked by a cooker as for any game. `tests/fixtures/rmi-play` is a
complete example: its `gen-assets.ts` imports two test projects, bakes the
512 px map chunks from the generated tile sheets, slices each character
block into the twelve walker frames, cooks animated water into sprite
atlases, slices balloons and animations, carries parallaxes and item cells,
fits pictures into a screen layer, packs imported QOA under the generated
audio keys, and writes the `GameAssets` manifest. Its `rmi-play.tsx` mounts
`GameView` with `createAudioEffects`, the opt-in parallax renderer and
item-icon row, the RPG Maker battle reducer and front-view scene, and the kit's
name-input scene. Production games use `pocket-rpgkit/rpgmaker-battle` and
`pocket-rpgkit/ui/rpgmaker-battle` to wire the generated `battle.json` into
`GameView`'s `extensions`, `battle` and `battleScene` props. The battle module,
audio, parallax and item-icon renderers all have separate entry points. A game
that wants the minimal party-order menu also passes
`createRpgMakerFormation()` from `pocket-rpgkit/ui/rpgmaker-formation` as its
`GameView` overlay. Formation is therefore absent from games that do not opt
in. Omitting any of these entry points keeps its implementation out of the
bundle.

The generated `coverage.md` has a **Required application capabilities**
section derived from the commands this import actually uses. Tone and weather
require the `rpgMakerText` runtime registration; tone, weather, numbered
pictures, the timer and map-name banners also require `GameView`'s
`screenPresentation` registration (normally `krm2ScreenPresentation`). Session
loading scans common events and every nested branch, and repeats the check when
a sharded map is acquired. A rendering host that omits a required registration
gets a readable load error instead of waiting on an invisible effect. Headless
reducers may omit the presentation policy when they intentionally inspect only
saved state.

## Ids

| RPG Maker | Kit |
| --- | --- |
| Map 1 | map `map001` |
| Event 7 | event `ev007` on its map |
| Common event 2 | common event `ce002` |
| Switch 1, variable 1 | switch `s001`, variable `v001` |
| Item / weapon / armor 1 | items `item001`, `weapon001`, `armor001` (one bank) |
| Actor 3 / party membership | actor `actor003` with `databaseId: 3`; switch `party-actor003` (stored inverted as `party-out-actor003` for actors in the starting party) |
| Tileset 1 | tile sheet `ts1` |

## Tiles and autotiles

The kit draws one ground tile and one optional "star" tile (above
characters) per cell, from 16 px sheets. RPG Maker stacks four tile layers,
a shadow layer and a region layer per cell, and draws autotiles from
quarter-tile pieces. The importer therefore composes every cell at import
time:

1. The four layers are split by the tileset's star flag (`0x10`): non-star
   tiles, bottom to top with the shadow drawn after layers 0–1 as MV does,
   form the ground cell; star tiles form the upper cell.
2. Each tile is drawn exactly like MV/MZ's `Tilemap`: A5 and B–E tiles are
   plain cuts; autotiles (A1–A4) pick four quarter pieces from their source
   block through the floor (47 shapes + the isolated preview), wall/roof
   (16 shapes) or waterfall (4 shapes) table, with the A1 water and A2
   table-tile special cases.
3. Each distinct stack becomes one cell of the generated sheet. Cells are
   keyed by tile ids, not pixels, so two stacks that look the same but pass
   differently stay separate.
4. Passage follows `Game_Map.checkPassage`: per direction, the top non-star
   tile decides (bit clear = passable); a cell with no deciding tile blocks.
   The four direction bits become the sheet's undirected `dirBlock` edges
   (MV checks the source cell's bit and the destination cell's reverse bit,
   which is exactly `dirBlock`); all four blocked becomes a `block` cell.
5. Animated autotiles (A1 water: steps 0, 1, 2, 1 every 0.5 s; waterfalls:
   three steps) produce one cell per step of the whole stack; the manifest
   lists them per map and the cooker turns them into animated tile sprites.
6. Projects whose tiles are larger than 16 px (MV is always 48 px; MZ stores
   `tileSize`) are composed at their own size and averaged down by an
   integer factor.

The editor stores each autotile's shape in the map data, so the runtime
never computes it. `reshapeAutotiles` reproduces the editor's rule (eight
neighbours, the map edge counts as joined) for hand-written maps such as the
test projects.

Change Tileset references are discovered in map, common-event and troop-event
lists. For every referenced map/tileset pair, the importer precomposes the
ground, upper, passage, vehicle-passage, terrain and animated-cell variants.
The reducer selects the complete variant atomically. In a connected world the
selection is scoped to the active map, so visible neighbours keep their own
art. A transfer clears the visit-local selection and uses the destination's
authored tileset. A tile-image event keeps its page and reducer state, while a
render-only lookup selects the cell cut from the active tileset. Thus changing
the tileset repaints both the map and those events; switching back restores the
original pixels.

## Events

See the coverage table in [the report](#coverage) for every command code.
In short:

- Pages keep their order; the kit, like MV, runs the highest-numbered page
  whose conditions hold. RPG Maker Event Touch maps to `eventTouch`.
  Non-blocking Player Touch maps to `playerTouch`; blocking Player Touch
  maps to `eventTouch` so walking into the event still starts it, with the
  documented caveat that a moving event can also initiate that contact.
- Conditions on switches, variables (≥), self switches, items and party
  members map directly. Actor name uses the live saved name. Actor class,
  skill, weapon, armour and state tests execute against imported initial
  database facts and are reported Degraded because later actor mutations are
  not modelled.
- Control Variables can read Game Data → Other → Steps. Conditional Branch
  Script can also lower exact comparisons over variables, inventory counts,
  player direction and Steps, plus exact switch and item-presence tests.
  Player-coordinate comparisons are recognized but remain Placeholder because
  the event condition vocabulary has no live-coordinate predicate.
- Commands map to kit commands where one exists; where the kit has a
  narrower command the importer lowers it (for example a comparison
  between two variables goes through a scratch variable; a transfer to a
  map held in a variable becomes a chain of `if` branches over the map
  ids).
- Plugin commands (356, 357) remain placeholders. Script (355/655) uses the
  bounded import-time subset below; a block outside that subset becomes a
  visible text box (or nothing with `--placeholders silent`) and is counted
  as Placeholder.
- Battle Processing becomes the kit's `battle` command with
  `{ troop, name, canEscape, canLose }`, a hash binding it to `battle.json`,
  and real If Win / If Escape / If Lose branches. Fixed troops, variable troop
  ids and random map encounters all resolve through the opt-in module. A win
  grants deterministic experience, levels, gold and drops; a disallowed loss
  follows the ordinary Game Over path.

### Import-time safe Script subset

RPG Maker stores Script fields as JavaScript. The importer never evaluates
that source. It joins a 355 command and its 655 continuation lines as RPG
Maker does, tokenizes at most 2,048 characters / 512 tokens into a bounded
AST, and accepts only the exact shapes below. Every statement in a block must
be accepted; one extra call or expression rejects the whole block. Rejection
reasons and coverage use source-free shape names rather than copying project
Script into the report.

| Accepted shape | Import result and limits |
|---|---|
| `$gameMap.requestRefresh()` | Native no-op: kit pages already re-evaluate from live state every reducer tick |
| `$gameVariables.setValue(id, expression)` | Native when the literal target id exists and the safe numeric formula lowers to variable commands; live division/modulo is Degraded because native variable arithmetic floors intermediate values |
| `$gameSwitches.setValue(id, boolean)` | Native for an existing literal switch id and a boolean literal |
| `$gameSelfSwitches.setValue([map,event,key], boolean)` | Native only for the issuing event's own map/event and one of A–D; kit's single active letter makes multi-letter event use Degraded |
| `$gameParty.gainItem/loseItem`, `gainGold/loseGold` | Literal database references plus safe numeric amounts lower to ordinary inventory/gold commands; inventory caps, equipped-copy removal and unguarded flooring differences are reported Degraded |
| `$gamePlayer.locate`, `reserveTransfer` | Transfer is Native when its operands and direction are representable; `locate` is Degraded because it does not reproduce stock camera, follower, vehicle and encounter-reset side effects |
| `$gameMap.event(id).setPosition/setDirection` | Literal event targets lower to placement or movement commands; direction is Degraded because stock direction-fix/stop-count details differ |
| `AudioManager.playSe/playBgm` | A literal object containing only `name`, `volume`, `pitch` and `pan`; omitted numeric fields remain zero as in the Script API |
| `$gameMessage.add(string)` | A bounded string literal becomes native message text |
| Exact variable/item-count/direction/Steps comparisons and switch/item-presence tests | Native when the referenced project data and integer comparison are representable; item equipment inclusion is Degraded, and live player x/y comparisons remain Placeholder |

Numeric expressions reuse the safe formula AST: finite literals,
`$gameVariables.value(id)`, arithmetic, selected `Math` constants and
functions. Constant expressions fold during import; no runtime JavaScript
interpreter is emitted. Prototype access, `constructor`, `globalThis`,
`require`, dynamic import, declarations/control flow, unknown calls,
over-budget input and mixed safe/unsafe statements all fail closed.

## Screen and system commands

- **Tint Screen (223)** retains signed red/green/blue and gray channels and
  uses the fixed reference clock for the authored duration and optional wait.
  The state, including an in-progress tween, survives save/load and rewind and
  paints on maps and battles below numbered pictures and battle windows.
  PocketJS does not expose a portable colour-matrix primitive, so the renderer
  uses a deterministic source-over approximation: gray first, complementary
  darkening second, positive-channel brightening last. The exact authored
  descriptor remains in reducer state and saves.
- **Set Weather Effect (236)** supports rain, storm and snow, power 1–9,
  duration and wait. It draws `floor(power * 10)` stock-shaped particles and
  the stock dimmer, with a serialized seed and clock replacing upstream's
  ambient random calls. The result is identical after save/load, rewind and
  at 60/30/20 Hz. Existing weather remains visible when a battle opens.
- **Change Tileset (282)** selects the precomposed variant described above,
  changing ground, upper layer, passage, vehicle passage, terrain and animated
  cells together. Tile-image events resolve their art against that same active
  tileset. The active visit is saved and rewound.
- **Change Window Color (138)** accepts the editor's three-channel RGB tone
  (and four-channel data from compatible tools), defaulting an omitted gray
  channel to zero. Like RPG Maker, presentation consumes RGB only; the kit
  projects those channels onto its theme's message, choice, menu and
  battle-window chrome. A supplied gray channel remains serialized for
  lossless round-tripping. This palette projection
  is reported Degraded because it is not a per-pixel windowskin tone.
- **Change Formation Access (137)** gates the optional formation overlay.
  Its two-confirm flow swaps any pair, including index 0, and the order drives
  followers and front-view battle slots. The saved order is reconciled with
  the current party before every swap. The map player's walking artwork stays
  fixed because `GameView` has one project-level player sprite, so this command
  is reported Degraded.

When a registered RPG Maker battle really opens, the kit applies the pinned
`Game_Screen.onBattleStart` boundary: active fade, flash and shake are cleared,
while tone and weather survive and continue on the stock battle clock. This is
the exact clear list in
[MV `Game_Screen.js:25-31`](https://github.com/rpgtkoolmv/corescript/blob/182e31449707ba7e406db0485c44c2a9d11e2dcd/js/rpg_objects/Game_Screen.js#L25-L31)
and
[MZ `rmmz_objects.js:782-788`](https://github.com/stak/rmmz-corescript/blob/5ecc09ae5170c6aee71c7d9513e553e3dbea116b/rmmz_objects.js#L782-L788).
Stock also clears its zoom bank and stale battle-picture bank. The kit has
neither: `camera` is map-owned rather than RPG Maker zoom, and numbered
pictures use one live map bank, so both remain intact. A battle reducer that
declines entry by returning `null` does not run this boundary. Projects that do
not register the RPG Maker runtime retain the existing kit-native battle
behavior byte-for-byte.

## Command table

Every MV/MZ event command code and what the importer does with a minimal
use of it: 95 of the 107 commands map natively, 9 run degraded, 2 become
placeholders (the two plugin commands) and 1 is dropped. Script's minimal
entry is the exact native refresh no-op above; other shapes are classified
per use. "Needs kit" names the remaining or presentation-only runtime capability. The
static table sends troop-only commands through the same troop converter as a
real import, rather than treating them as map commands.
`tests/rpgmaker-import.test.ts` keeps this table in step with the
importer. Each import also writes the same table, plus per-construct counts
for that project, to `coverage.md`.

The two self-written fixtures currently measure as follows; these are source
uses, not the 107-row capability catalogue:

| Fixture | Command uses | Native | Degraded | Placeholder | Dropped | Native |
|---|---:|---:|---:|---:|---:|---:|
| Hollow MZ | 124 | 112 | 10 | 2 | 0 | 90.3% |
| Stage MV | 61 | 51 | 9 | 1 | 0 | 83.6% |
| Combined | 185 | 163 | 19 | 3 | 0 | 88.1% |

The importer is also exercised against three complete public games at pinned
revisions. They are fetched only into a temporary test directory; no project
file, asset or dialogue from them is committed here.

| Project | Engine and pinned source | Local-use terms | Event command uses | Native | Degraded | Placeholder | Dropped |
|---|---|---|---:|---:|---:|---:|---:|
| GameDev: The Beginning | MV 1.6.2, [`a3c3ec7`](https://github.com/yancharkin/game_jams/tree/a3c3ec739071ca285045025f9b619d17877a7193/%5Bigmc_2017%5D_gamedev_the_beginning) | MIT code, CC BY-SA 4.0 assets | 1,718 | 1,395 | 106 | 161 | 56 |
| The Basement | MV 1.5.2, [`0aea825`](https://github.com/fluxrider/The_Basement/tree/0aea82564bf84299441c6b285e04977f5f11a68a) | MIT repository license | 31 | 20 | 11 | 0 | 0 |
| Strange Sea: Before | MZ 1.0.0, [`103d87c`](https://github.com/ShrLeeKNsword/strange_sea_before/tree/103d87c00c8903db841b9aad23dea30e26d6b1a8/ver_0.0.1) | Apache-2.0 file; README additionally limits use to study/education and forbids copying or republication, so validation was local only | 197 | 151 | 46 | 0 | 0 |

<!-- rpgmaker-commands:begin -->
| Code | Command | Flavor | Handling | Notes | Needs kit |
|---:|---|---|---|---|---|
| 101 | Show Text | MV/MZ | Native |  | face graphics per message (portrait keyed by file/index, not speaker); inline icons, timing/gold-window controls and MZ \PX/\PY/\FS presentation |
| 102 | Show Choices | MV/MZ | Native |  | single-option lists and a default cursor row |
| 103 | Input Number | MV/MZ | Native |  |  |
| 104 | Select Item | MV/MZ | Native |  |  |
| 105 | Show Scrolling Text | MV/MZ | Native |  |  |
| 108 | Comment | MV/MZ | Native |  |  |
| 109 | Skip | MZ | Native |  |  |
| 111 | Conditional Branch | MV/MZ | Native |  | conditions over actor stats, enemies, event facing and buttons |
| 112 | Loop | MV/MZ | Native |  |  |
| 113 | Break Loop | MV/MZ | Native |  |  |
| 115 | Exit Event Processing | MV/MZ | Native |  | a return-from-common-event command (exit ends the calling fiber) |
| 117 | Common Event | MV/MZ | Native |  |  |
| 118 | Label | MV/MZ | Native |  |  |
| 119 | Jump to Label | MV/MZ | Native |  |  |
| 121 | Control Switches | MV/MZ | Native |  |  |
| 122 | Control Variables | MV/MZ | Native |  | variable sources for actor, character, party and remaining game data |
| 123 | Control Self Switch | MV/MZ | Native |  | four independent self switches per event (the kit keeps one slot) |
| 124 | Control Timer | MV/MZ | Native |  | the screenPresentation capability |
| 125 | Change Gold | MV/MZ | Native |  | gold changes by variable and a 0 floor on losses |
| 126 | Change Items | MV/MZ | Native |  | item changes by variable and a 0 floor on losses |
| 127 | Change Weapons | MV/MZ | Native |  | equipment (equipped copies) and item changes by variable |
| 128 | Change Armors | MV/MZ | Native |  | equipment (equipped copies) and item changes by variable |
| 129 | Change Party Member | MV/MZ | Native |  | a party roster (the importer keeps one switch per actor) |
| 132 | Change Battle BGM | MV/MZ | Degraded | battle BGM setting persists, but the current battle audio lifecycle does not play it | battle audio settings in the battle setup |
| 133 | Change Victory ME | MV/MZ | Degraded | victory ME setting persists, but the current battle audio lifecycle does not play it | battle audio settings in the battle setup |
| 134 | Change Save Access | MV/MZ | Native |  |  |
| 135 | Change Menu Access | MV/MZ | Native |  |  |
| 136 | Change Encounter | MV/MZ | Native |  | random encounters |
| 137 | Change Formation Access | MV/MZ | Degraded | formation reorders followers and battle slots but keeps the walking leader fixed |  |
| 138 | Change Window Color | MV/MZ | Degraded | window tone is retained exactly and projected onto the kit theme palette |  |
| 139 | Change Defeat ME | MV/MZ | Degraded | defeat ME setting persists, but the current battle audio lifecycle does not play it | battle audio settings in the battle setup |
| 140 | Change Vehicle BGM | MV/MZ | Native |  |  |
| 201 | Transfer Player | MV/MZ | Native |  | a white transfer fade colour |
| 202 | Set Vehicle Location | MV/MZ | Native |  |  |
| 203 | Set Event Location | MV/MZ | Native |  | place by variable coordinates and character exchange |
| 204 | Scroll Map | MV/MZ | Native |  |  |
| 205 | Set Movement Route | MV/MZ | Native |  | diagonal, jump, backward/away moves, relative turns, in-route switches/SE/image |
| 206 | Get on/off Vehicle | MV/MZ | Native |  |  |
| 211 | Change Transparency | MV/MZ | Native |  |  |
| 212 | Show Animation | MV/MZ | Native |  |  |
| 213 | Show Balloon Icon | MV/MZ | Native |  |  |
| 214 | Erase Event | MV/MZ | Native |  |  |
| 216 | Change Player Followers | MV/MZ | Native |  |  |
| 217 | Gather Followers | MV/MZ | Native |  |  |
| 221 | Fadeout Screen | MV/MZ | Native |  |  |
| 222 | Fadein Screen | MV/MZ | Native |  |  |
| 223 | Tint Screen | MV/MZ | Degraded | signed tone is retained exactly; portable rendering approximates additive colour and desaturation | the rpgMakerText runtime and screenPresentation capability |
| 224 | Flash Screen | MV/MZ | Native |  |  |
| 225 | Shake Screen | MV/MZ | Native |  |  |
| 230 | Wait | MV/MZ | Native |  |  |
| 231 | Show Picture | MV/MZ | Native |  | the screenPresentation capability |
| 232 | Move Picture | MV/MZ | Native |  | the screenPresentation capability |
| 233 | Rotate Picture | MV/MZ | Native |  | the screenPresentation capability |
| 234 | Tint Picture | MV/MZ | Native |  | the screenPresentation capability |
| 235 | Erase Picture | MV/MZ | Native |  | the screenPresentation capability |
| 236 | Set Weather Effect | MV/MZ | Native |  | the rpgMakerText runtime and screenPresentation capability |
| 241 | Play BGM | MV/MZ | Native |  |  |
| 242 | Fadeout BGM | MV/MZ | Native |  |  |
| 243 | Save BGM | MV/MZ | Native |  |  |
| 244 | Resume BGM | MV/MZ | Native |  |  |
| 245 | Play BGS | MV/MZ | Native |  |  |
| 246 | Fadeout BGS | MV/MZ | Native |  |  |
| 249 | Play ME | MV/MZ | Native |  |  |
| 250 | Play SE | MV/MZ | Native |  |  |
| 251 | Stop SE | MV/MZ | Native |  |  |
| 261 | Play Movie | MV/MZ | Dropped |  | video playback |
| 281 | Change Map Name Display | MV/MZ | Native |  | the screenPresentation capability |
| 282 | Change Tileset | MV/MZ | Native |  |  |
| 283 | Change Battle Background | MV/MZ | Degraded | battle background names persist, but battle backgrounds are not presented | battle backgrounds in the battle setup |
| 284 | Change Parallax | MV/MZ | Native |  |  |
| 285 | Get Location Info | MV/MZ | Native |  |  |
| 301 | Battle Processing | MV/MZ | Native |  |  |
| 302 | Shop Processing | MV/MZ | Native |  |  |
| 303 | Name Input Processing | MV/MZ | Native |  |  |
| 311 | Change HP | MV/MZ | Native |  | actor stats |
| 312 | Change MP | MV/MZ | Native |  | actor stats |
| 326 | Change TP | MV/MZ | Native |  | actor stats |
| 313 | Change State | MV/MZ | Native |  | actor states |
| 314 | Recover All | MV/MZ | Native |  | actor stats |
| 315 | Change EXP | MV/MZ | Native |  | actor experience |
| 316 | Change Level | MV/MZ | Native |  | actor levels |
| 317 | Change Parameter | MV/MZ | Native |  | actor parameters |
| 318 | Change Skill | MV/MZ | Native |  | actor skills |
| 319 | Change Equipment | MV/MZ | Native |  | equipment slots |
| 320 | Change Name | MV/MZ | Native |  | runtime names for actors other than actor 1 |
| 321 | Change Class | MV/MZ | Native |  | actor classes |
| 322 | Change Actor Images | MV/MZ | Degraded | actor images persist, but map, face, and side-view presentation do not update live | per-actor walking/face/battler images (the player sprite can change via appearance) |
| 323 | Change Vehicle Image | MV/MZ | Native |  |  |
| 324 | Change Nickname | MV/MZ | Native |  | actor profiles |
| 325 | Change Profile | MV/MZ | Native |  | actor profiles |
| 331 | Change Enemy HP | MV/MZ | Native |  | an RPG Maker battle system |
| 332 | Change Enemy MP | MV/MZ | Native |  | an RPG Maker battle system |
| 342 | Change Enemy TP | MV/MZ | Native |  | an RPG Maker battle system |
| 333 | Change Enemy State | MV/MZ | Native |  | an RPG Maker battle system |
| 334 | Enemy Recover All | MV/MZ | Native |  | an RPG Maker battle system |
| 335 | Enemy Appear | MV/MZ | Native |  | an RPG Maker battle system |
| 336 | Enemy Transform | MV/MZ | Native |  | an RPG Maker battle system |
| 337 | Show Battle Animation | MV/MZ | Degraded | battle animation keeps its numeric database id because no cooked animation id is available | an RPG Maker battle system |
| 339 | Force Action | MV/MZ | Native |  | an RPG Maker battle system |
| 340 | Abort Battle | MV/MZ | Native |  | an RPG Maker battle system |
| 351 | Open Menu Screen | MV/MZ | Native |  |  |
| 352 | Open Save Screen | MV/MZ | Native |  |  |
| 353 | Game Over | MV/MZ | Native |  |  |
| 354 | Return to Title Screen | MV/MZ | Native |  |  |
| 355 | Script | MV/MZ | Native |  | hand-porting for JavaScript outside the import-time safe subset |
| 356 | Plugin Command (MV) | MV | Placeholder | plugin command not ported | a per-plugin port (an ext handler) |
| 357 | Plugin Command (MZ) | MZ | Placeholder | plugin command not ported | a per-plugin port (an ext handler) |
<!-- rpgmaker-commands:end -->

Besides the commands, the report counts conditional branch types, page
conditions, triggers, movement route steps, message escape codes and tile
constructs. It also records every referenced audio file's source and encoded
size, decoded duration/format, or the exact missing/corrupt reason. Of note:

- **Touch events that block** (same-as-characters priority) keep blocking
  and use `eventTouch`, so walking into them starts the page without moving
  onto their cell. For a door embedded in an impassable wall, the importer
  opens the underlying terrain edge while the event body remains the
  blocker. Blocking RPG Maker Player Touch is counted Degraded because a
  moving event can also initiate the kit contact; direct Event Touch is
  counted Native. Non-blocking Player Touch remains `playerTouch`.
- **Loops** use the kit's structured `loop` and `break` commands for every
  shape, including a loop that occupies an entire autorun or parallel page.
  The loop back-edge does not re-evaluate page conditions; conditions are
  checked again only after the page program ends and is eligible to start
  anew. A Break Loop outside a parsed loop ends that page or common event
  and is conservatively counted Degraded for malformed flat command lists.
  Label and Jump to Label map natively: a jump goes to the first label with
  that name anywhere in the same page or common event, at any nesting depth,
  entering or leaving branch blocks unconditionally like MV's flat-list
  jumpTo. A jump to a name with no label does nothing. See
  [Loops and labels](../src/engine/README.md#loops-and-labels).
- **Self switches**: the kit keeps one self-switch letter per event, so an
  event that sets B after A loses A (counted Degraded where it happens).
- **Waited movement routes** that change a switch, the character's
  image, opacity or transparency, or play a sound in the middle are split
  at those steps into route, command, route — exact, because the event
  waits for the route anyway. Unwaited or repeating routes drop those
  steps.
- **Escape codes**: message and choice strings retain their source spelling.
  The generated actor catalogue and `system.rpgMakerText` configuration let
  the runtime expand `\N[n]`, `\P[n]`, `\V[n]`, `\G` and `\\`, and apply
  `\C[n]` colour spans when the box opens. Expansion is one left-to-right
  pass; replacement values containing another escape are not rescanned.
  `\P[n]` follows the imported party order. In Show Text, MZ `\PX` and `\PY`
  set a cursor position scaled into the kit's message content box, and `\FS`
  selects the nearest baked font slot. Those three remain Degraded because the
  coordinate/font metrics are an approximation and choice-list layout does not
  consume them. Inline icons, font-size shorthands, timing controls and the
  gold-window control remain byte-for-byte present without a visual effect.
  Unknown/plugin escapes also remain visible instead of being silently
  deleted.
- **Parallaxes**: `parallaxName`, both loop flags, signed `parallaxSx/Sy`,
  editor visibility and the leading-`!` zero-camera convention become the
  map's authored parallax. Change Parallax (284) replaces or clears the same
  state. Source pixels, scroll speeds included, are divided by the map scale
  exactly as tiles are, so a looping axis scrolls at MV's on-screen rate.
  The runtime repeats loop axes, proportionally follows non-loop axes (MV
  pins an ordinary non-looping parallax to the screen; following the map
  keeps parallax-mapped scenes aligned with their events), and clips the
  result to the active map in a connected world. Painting is an
  explicit `GameView parallax={ParallaxLayer}` opt-in from
  `pocket-rpgkit/ui/parallax`.
- **Show Animation (212)**: legacy MV cell animations are composited at
  import time, including every cell's translation, scale, rotation, mirror,
  opacity, hue and blend. The command follows its player/event target and may
  wait. Head, centre and feet positions are measured from a one-tile
  character (MV measures the target sprite, so tall `$` characters sit
  differently); the screen-centre position is dropped with a coverage
  reason. SE and full-screen-flash timing rows are retained. Target-local flash
  and temporary target hiding are omitted; non-normal blending is exact among
  cells in the flattened frame but cannot interact with the map below it.
  MZ Effekseer animation records have no compatible cell timeline and are
  dropped with an explicit coverage reason.
- **Item icons**: a valid 32 px `IconSet.png` becomes a 16 px `iconset` sheet;
  each item, weapon and armour keeps its `iconIndex` as `sprite` when that cell
  exists. The runtime shop draws it only when the game opts into
  `pocket-rpgkit/ui/item-icons`; other games keep the old text-only bundle and
  layout.
- **Audio media**: logical names are matched case-insensitively under
  `audio/{bgm,bgs,me,se}`. Ogg is preferred when both deployment formats are
  present; a corrupt preferred file is reported rather than silently changing
  source. `ffmpeg` decodes the selected stream to stable 44.1 kHz stereo
  signed-16 PCM and the repository QOA encoder writes the final bytes. The
  decoded ME frame count supplies `playMe.duration` at 60 reference ticks per
  second. Volume, pitch and pan (-100..100) are retained on every audio
  command. `ffmpeg` must be on `PATH` while importing.

## Known limitations

- **Plugins and arbitrary scripts are not ported.** The exact import-time
  Script subset above lowers without executing source. Everything else in
  Script commands, Script conditions and script variable operands becomes a
  placeholder; plugin commands always do. Plugin parameters in
  `js/plugins.js` are not read.
- **RTP assets.** The RPG Maker runtime package (RTP) art and audio is
  licensed for use in RPG Maker games only. The importer reads whatever
  images a project folder holds and does not ship or fetch any; do not
  redistribute RTP art in a kit game unless your license allows it.
- **Standard encrypted deployment media is supported.** When `System.json`
  enables encrypted images or audio and carries a valid 32-hex-digit key, the
  importer strips the RPG Maker deployment header and decrypts the encrypted
  prefix before decoding PNG/Ogg/M4A bytes. A missing/malformed key, invalid
  header or encrypted suffix that disagrees with `System.json` fails with a
  specific error. This is media decryption only; plugins and arbitrary scripts
  are still not ported.
- **Missing or corrupt audio is omitted.** The reference remains in event
  intent but no `project.audio` entry or QOA file is emitted; `coverage.md`,
  `coverage.json`, `audio-media.json` and the CLI warning carry the reason.
- **RPG Maker battle support is opt-in and partial.** The deterministic
  front-view module imports actor/class parameter curves, enemy action patterns,
  troops and positions, skills/items, states, rewards, weighted region-aware
  map encounters, and the common turn/enemy-HP/switch troop-page conditions.
  Troop pages additionally execute enemy HP/MP/TP/state changes, recovery,
  appear, transform, forced actions and abort in source order. MV side-view
  projects intentionally render in front view. Numeric Show Battle Animation
  ids are retained but cannot paint without a cooked animation id. Battle
  BGM/ME records and per-map battleback names persist, but the current battle
  presentation does not consume them. Encounter Disable works; Encounter Half
  halves progress, ships halve it again, boats keep the walking rate and
  airships freeze the saved countdown. Stock bush doubling is not modelled.
  One targeting edge intentionally differs from stock: MV/MZ can resolve an
  explicitly indexed hidden-but-living troop member because hiding does not
  change `isAlive()`, while the kit redirects that explicit target to the first
  visible eligible member until an Appear command reveals it.
- **Trait execution is intentionally bounded.** The battle reducer consumes
  parameter, element, state, hit/evasion/critical, recovery/cost/damage,
  targeting, attack-element/state/speed/times/skill, added-skill, Guard and
  reward-multiplier traits. Other normalized trait records remain Degraded:
  debuff rates; skill-type add/seal and skill seal; equipment lock and slot
  type changes after import; Action Times+; Auto Battle, Substitute and
  Preserve TP special flags; and collapse types. They stay in `battle.json`
  for a later reducer extension rather than being guessed.
- **Damage formulas use a safe subset, never `eval`.** Battler parameters
  (`a.atk`, `b.def`, and the other basic parameters), literal `v[n]`, arithmetic,
  comparisons, boolean operators, ternaries and common `Math` functions are
  parsed into a bounded JSON tree. A formula outside that subset is reported as
  Degraded and deterministically falls back to
  `Math.max(0, a.atk * 4 - b.def * 2)`.
- **Event-time actor simulation is still incomplete.** Map events can change
  actor HP/MP/TP, states, recovery, EXP, level, parameter bonuses, skills,
  equipment, class, images, nickname and profile; the saved extension state is
  also the next battle's source and rewinds with the session. Show Level Up
  messages and changed actor-image presentation are not drawn. Actor event
  conditions for class, skill, equipment and state still read imported initial
  facts. A `\P[n]` lookup uses the initial party order rather than later Change
  Party Member results.
- **Maps are capped at 256 × 256**, the kit's limit.
- Region ids and terrain tags are carried over as sparse per-cell map data
  (Get Location Info, the `region` condition and authored region-crossing
  pages read them). The opt-in battle module consumes encounter region sets
  and map encounters; damage floors are not modelled. RPG Maker has no stock
  region-enter/leave event trigger for the importer to synthesize. Ladders,
  bushes and counters keep their passage but not their special behaviour.
- Import-time message wrapping protects complete escape spellings but still
  budgets the raw source length, not the final visible pixel width after
  expansion. Runtime pagination then wraps the expanded visible text safely.
- MZ Effekseer animations are not converted. MV target-only flash, temporary
  target hiding and blend interaction with the map are reported as degraded,
  while their remaining animation still imports.
