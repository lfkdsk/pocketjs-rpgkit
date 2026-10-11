# Importing RPG Maker MV/MZ projects

`tools/rpgmaker-import` converts an RPG Maker MV or MZ project's
`data/*.json` files, referenced images and unencrypted Ogg/M4A media into an
`rpgkit-project/v1` document plus generated art and QOA audio. It is a
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
| `audio-media.json` | Stable per-track source/output byte counts, source format, decoded channels/rate/frames and 60 Hz duration; missing/corrupt media includes its reason. |
| `coverage.md` | What happened to every construct in this project, followed by the table of every MV/MZ command. |
| `coverage.json` | The machine-readable per-project construct counts (the static command table is Markdown-only). |

`--placeholders silent` drops the visible text boxes that stand in for
plugin and script commands (they still count as Placeholder).

Importing the same project twice writes the same bytes.

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
item-icon row, a placeholder battle and the kit's name-input scene. Production
games use `pocket-rpgkit/ui/audio`, `pocket-rpgkit/ui/parallax` and
`pocket-rpgkit/ui/item-icons` the same way; omitting an opt-in entry keeps its
concrete implementation out of the bundle.

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
- Control Variables can read Game Data → Other → Steps, and a script
  condition consisting only of `$gameParty.steps()` compared with a safe
  integer maps to the native Steps condition. Arbitrary JavaScript remains a
  visible placeholder.
- Commands map to kit commands where one exists; where the kit has a
  narrower command the importer lowers it (for example a comparison
  between two variables goes through a scratch variable; a transfer to a
  map held in a variable becomes a chain of `if` branches over the map
  ids).
- Plugin commands (356, 357) and Script (355) are never ported: each
  becomes a visible text box naming it (or nothing with
  `--placeholders silent`) and is counted as Placeholder.
- Battle Processing becomes the kit's `battle` command with
  `{ troop, name, canEscape, canLose }` and the If Win / If Escape /
  If Lose branches. The kit has no RPG Maker battle system; the test
  fixture registers a placeholder battle that lets the player choose the
  outcome.

## Command table

Every MV/MZ event command code and what the importer does with a minimal
use of it: 68 of the 107 commands map natively, 1 runs degraded, 4 become
placeholders (Battle Processing, Script and the two plugin commands) and
34 are dropped, many of them actor, enemy and battle-only commands. "Needs
kit" names the runtime capability a native mapping would take; it is the
list of what the kit would need to import an RPG Maker game completely.
`tests/rpgmaker-import.test.ts` keeps this table in step with the
importer. Each import also writes the same table, plus per-construct counts
for that project, to `coverage.md`.

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
| 124 | Control Timer | MV/MZ | Native |  |  |
| 125 | Change Gold | MV/MZ | Native |  | gold changes by variable and a 0 floor on losses |
| 126 | Change Items | MV/MZ | Native |  | item changes by variable and a 0 floor on losses |
| 127 | Change Weapons | MV/MZ | Native |  | equipment (equipped copies) and item changes by variable |
| 128 | Change Armors | MV/MZ | Native |  | equipment (equipped copies) and item changes by variable |
| 129 | Change Party Member | MV/MZ | Native |  | a party roster (the importer keeps one switch per actor) |
| 132 | Change Battle BGM | MV/MZ | Dropped |  | battle audio settings in the battle setup |
| 133 | Change Victory ME | MV/MZ | Dropped |  | battle audio settings in the battle setup |
| 134 | Change Save Access | MV/MZ | Native |  |  |
| 135 | Change Menu Access | MV/MZ | Native |  |  |
| 136 | Change Encounter | MV/MZ | Dropped |  | random encounters |
| 137 | Change Formation Access | MV/MZ | Dropped |  | a party formation menu |
| 138 | Change Window Color | MV/MZ | Dropped |  | a runtime UI theme command |
| 139 | Change Defeat ME | MV/MZ | Dropped |  | battle audio settings in the battle setup |
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
| 223 | Tint Screen | MV/MZ | Degraded | colour tone approximated as an overlay colour | an additive colour-tone (and greyscale) screen filter |
| 224 | Flash Screen | MV/MZ | Native |  |  |
| 225 | Shake Screen | MV/MZ | Native |  |  |
| 230 | Wait | MV/MZ | Native |  |  |
| 231 | Show Picture | MV/MZ | Native |  |  |
| 232 | Move Picture | MV/MZ | Native |  |  |
| 233 | Rotate Picture | MV/MZ | Native |  |  |
| 234 | Tint Picture | MV/MZ | Native |  |  |
| 235 | Erase Picture | MV/MZ | Native |  |  |
| 236 | Set Weather Effect | MV/MZ | Dropped |  | rain/storm/snow weather particles |
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
| 281 | Change Map Name Display | MV/MZ | Native |  |  |
| 282 | Change Tileset | MV/MZ | Dropped |  | runtime tileset swaps (a ground/upper layer variant per tileset) |
| 283 | Change Battle Background | MV/MZ | Dropped |  | battle backgrounds in the battle setup |
| 284 | Change Parallax | MV/MZ | Native |  |  |
| 285 | Get Location Info | MV/MZ | Native |  |  |
| 301 | Battle Processing | MV/MZ | Native |  | an RPG Maker battle system (troops, actors, skills) behind the battle op |
| 302 | Shop Processing | MV/MZ | Native |  |  |
| 303 | Name Input Processing | MV/MZ | Native |  |  |
| 311 | Change HP | MV/MZ | Dropped |  | actor stats |
| 312 | Change MP | MV/MZ | Dropped |  | actor stats |
| 326 | Change TP | MV/MZ | Dropped |  | actor stats |
| 313 | Change State | MV/MZ | Dropped |  | actor states |
| 314 | Recover All | MV/MZ | Dropped |  | actor stats |
| 315 | Change EXP | MV/MZ | Dropped |  | actor experience |
| 316 | Change Level | MV/MZ | Dropped |  | actor levels |
| 317 | Change Parameter | MV/MZ | Dropped |  | actor parameters |
| 318 | Change Skill | MV/MZ | Dropped |  | actor skills |
| 319 | Change Equipment | MV/MZ | Dropped |  | equipment slots |
| 320 | Change Name | MV/MZ | Native |  | runtime names for actors other than actor 1 |
| 321 | Change Class | MV/MZ | Dropped |  | actor classes |
| 322 | Change Actor Images | MV/MZ | Dropped |  | per-actor walking/face/battler images (the player sprite can change via appearance) |
| 323 | Change Vehicle Image | MV/MZ | Native |  |  |
| 324 | Change Nickname | MV/MZ | Dropped |  | actor profiles |
| 325 | Change Profile | MV/MZ | Dropped |  | actor profiles |
| 331 | Change Enemy HP | MV/MZ | Dropped |  | an RPG Maker battle system |
| 332 | Change Enemy MP | MV/MZ | Dropped |  | an RPG Maker battle system |
| 342 | Change Enemy TP | MV/MZ | Dropped |  | an RPG Maker battle system |
| 333 | Change Enemy State | MV/MZ | Dropped |  | an RPG Maker battle system |
| 334 | Enemy Recover All | MV/MZ | Dropped |  | an RPG Maker battle system |
| 335 | Enemy Appear | MV/MZ | Dropped |  | an RPG Maker battle system |
| 336 | Enemy Transform | MV/MZ | Dropped |  | an RPG Maker battle system |
| 337 | Show Battle Animation | MV/MZ | Dropped |  | an RPG Maker battle system |
| 339 | Force Action | MV/MZ | Dropped |  | an RPG Maker battle system |
| 340 | Abort Battle | MV/MZ | Dropped |  | an RPG Maker battle system |
| 351 | Open Menu Screen | MV/MZ | Native |  |  |
| 352 | Open Save Screen | MV/MZ | Native |  |  |
| 353 | Game Over | MV/MZ | Native |  |  |
| 354 | Return to Title Screen | MV/MZ | Native |  |  |
| 355 | Script | MV/MZ | Placeholder | script not ported | hand-porting: arbitrary JavaScript has no kit equivalent |
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
  `\P[n]` follows the imported initial party order. MZ `\PX`/`\PY`/`\FS`,
  inline icons, font-size shorthands, timing controls and the gold-window
  control remain byte-for-byte present and are reported Degraded, but their
  visual effects are not interpreted. Unknown/plugin escapes also remain
  visible instead of being silently deleted.
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

- **Plugins and scripts are not ported.** Plugin commands, Script
  commands, script conditions and script variable operands become
  placeholders. Plugin parameters in `js/plugins.js` are not read.
- **RTP assets.** The RPG Maker runtime package (RTP) art and audio is
  licensed for use in RPG Maker games only. The importer reads whatever
  images a project folder holds and does not ship or fetch any; do not
  redistribute RTP art in a kit game unless your license allows it.
- **Encrypted projects are refused.** A deployed game with encrypted images
  or audio (`hasEncryptedImages` / `hasEncryptedAudio`) is not decrypted.
- **Missing or corrupt audio is omitted.** The reference remains in event
  intent but no `project.audio` entry or QOA file is emitted; `coverage.md`,
  `coverage.json`, `audio-media.json` and the CLI warning carry the reason.
- **No battle system or dynamic actor simulation.** Actor ids, database names,
  initial class/skills/equipment/states and their conditions are imported, but
  actor stats, later class/skill/equipment/state mutations, enemy conditions
  and battle-only state are not modelled; Battle Processing is a placeholder.
  A `\P[n]` lookup uses the initial party order rather than later Change Party
  Member results.
- **Maps are capped at 256 × 256**, the kit's limit.
- Region ids and terrain tags are carried over as sparse per-cell map data
  (Get Location Info, the `region` condition and authored region-crossing
  pages read them); damage floors, encounter region sets and map encounters
  are not. RPG Maker has no stock region-enter/leave event trigger for the
  importer to synthesize. Ladders, bushes and counters keep their passage but
  not their special behaviour.
- Import-time message wrapping protects complete escape spellings but still
  budgets the raw source length, not the final visible pixel width after
  expansion. Runtime pagination then wraps the expanded visible text safely.
- MZ Effekseer animations are not converted. MV target-only flash, temporary
  target hiding and blend interaction with the map are reported as degraded,
  while their remaining animation still imports.
