# RPG Maker MV/MZ fixture projects

Two small projects in the public RPG Maker MV/MZ `data/*.json` layout, used to
test `tools/rpgmaker-import/`.

## Provenance

Both projects were authored for this repository and are MIT licensed like the
rest of it. Every file under `hollow-mz/` and `stage-mv/` is written by
`gen-fixtures.ts` (data and feature-specific procedural art) and `art.ts`
(shared procedural tile/character art):

    bun tests/fixtures/rpgmaker/gen-fixtures.ts [outDir]

The script is deterministic; `tests/rpgmaker-fixtures.test.ts` regenerates into
a temporary directory and compares every byte with the committed files. Edit
the generator, never the outputs.

No data, names, images or audio from any RPG Maker runtime package (RTP) or
from any third-party game are included. Only the public layout conventions are
followed: the A1..A5 and B..E sheet geometry and block placement, the
character sheet geometry (`$` single-character and `!` object prefixes), the
Balloon.png grid, and the JSON field names.

Audio is referenced by name only (`hollow-*`, `stage-*` BGM/BGS/ME/SE names).
The `audio/` directories are intentionally absent.

## Conventions

| | hollow-mz | stage-mv |
|---|---|---|
| Flavour | MZ: `System.tileSize` 16, `advanced` block, `game.rmmzproject` | MV: no `tileSize` or `advanced` (48 px), `Game.rpgproject` |
| Tile size | 16 px | 48 px (drawn at 16 px, scaled 3x nearest-neighbour, so a 48 -> 16 downscale is exact) |
| A1 / A2 / A3 / A4 / A5 / B | 256x192 / 256x192 / 256x128 / 256x240 / 128x256 / 256x256 | - / 768x576 / - / 768x720 / 384x768 / 768x768 |
| Characters | `People` (8 chars, 192x128), `!Things` (objects), `$Golem` (48x64) | `Cast` (8 chars, 576x384), `$Moth` (144x192) |
| Balloon.png | 8x15 frames of 16 px | 8x15 frames of 48 px |
| IconSet.png | 16x13 cells of 32 px; seven original occupied cells | same original sheet |
| Parallaxes | - | `StageClouds` and zero-parallax `!StageGlow`, 288x192 source -> 96x64 imported |
| MV animations | - | `Sparkle`, five original 192 px cells in a 960x192 sheet |
| Pictures | - | `Curtain` 816x624 (the MV screen) |

Both `System.json` files carry `versionId` (MV writes it too); flavour is
signalled by `tileSize` / `advanced`.

JSON layout follows the editors: keys in alphabetical order, database files one
record per line, maps with `data` and `events` last. `Map.data` holds six
planes, index `(z * height + y) * width + x`: z 0..3 tiles, z 4 shadow bits,
z 5 region ids. Autotiles are painted with any shape and passed through
`reshapeAutotiles`, so stored shapes match what the editor saves.

Show Choices with a cancel branch uses `cancelType` -2 and a `403 [6, null]`
When Cancel line. A Show Text immediately followed by Show Choices shares one
message window in RPG Maker (one Confirm picks the highlighted choice).

## hollow-mz: village, house/shop, cave, one battle

Maps (all `tilesetId` 1 "Hollow Field" mode 0, or 2 "Hollow Interior" mode 1;
both use the same six sheets and flags):

| Map | Name | Size | Tileset |
|---|---|---|---|
| 1 | Village ("Hollow") | 24x16 | 1 |
| 2 | House ("Elder's House", child of 1) | 13x10 | 2 |
| 3 | Cave ("Golem Cave") | 20x15 | 2 |

Tiles and flags (shape-0 ids; every shape of a kind shares its flag):

- A2 grass 2816 (kind 16), dirt paths 2864 (17, blobs with inner corners at
  the plaza), tall grass 2912 (18, bush 0x40 + terrain tag 1), table 3152 (23,
  0x80 table/counter + impassable) in the house at x 2..3, y 6..7.
- A1 pond 2048 (kind 0, animated, impassable, region 1) at x 2..5, y 10..13;
  cave waterfall 2288 (kind 5) at x 3..4, y 1..3 over a pool 2240 (kind 4).
- A3 roof 4352 (kind 48) over wall 4736 (kind 56): the house at x 9..13,
  y 2..5. Shadow bits 0b0101 at x 14, y 2..5.
- A4 house wall top 5888 / side 6272, cave wall top 5936 / side 6320.
- A5 1536 + n: wood floor 1537, cave floor 1538, doormat 1539, counter 1540
  (0x80 counter + impassable).
- B: tree top 1 (star 0x10, z 3) over trunk 9 (impassable, z 2), rock 2,
  fence 3 (0x01: blocks only crossing the tile's bottom edge), gate 4 (used as
  an event tile image), cave mouth 5 (passable), cliff 6, window 18 (star).
  `flags[0]` is star, as the editor writes it.

Switches: 1 QuestTaken, 2 GateOpen, 4 InCave, 10 BossDown, 11 Peace.
Variables: 1 Quest, 2 Luck, 3 Bonus, 5 Reward, 6 Escapes, 7 Defeats, 9 Ticks.
Items: 1 Potion (20 G), 2 Cave Pass (key item). Weapons: 1 Oak Staff (60),
2 Short Sword (100). Armors: 1 Cloth Vest (40). Actors: 1 Wren (party),
2 Moss (joins). Troop 1 "Golem".

Events that matter:

| Map | Id | Name | At | Trigger / pages |
|---|---|---|---|---|
| 1 | 1 | Intro | (0, 15) | autorun once: weather, plugin command, script, one text; self A |
| 1 | 2 | Elder | (13, 9) | action; p1 quest + choices; p2 (switch 1) branches on switch 10 / item 2 |
| 1 | 3 | House Door | (11, 5) | player touch, same priority (walk into it), on the house wall |
| 1 | 4 | Gate | (19, 6) | tile image, blocks; p2 (switch 2) passable, no image |
| 1 | 5 | Guard | (18, 7) | action; p2 (item 2 held); p3 (self A) |
| 1 | 6 | To Cave | (19, 0) | event touch, below characters (step on it) |
| 1 | 7 | Villager | (3, 3) | custom route, off the path |
| 1 | 9 | Bell | (0, 14) | parallel; the page body is one loop; Ticks += 1 per second until 5, then self B |
| 2 | 1 | Exit | (6, 9) | player touch, below (step on it) |
| 2 | 2 | Chest | (6, 3) | action; p1 branches on switch 1; p2 (self A) empty |
| 2 | 3 | Shopkeeper | (9, 4) | action, use the service opening at (9, 5) facing up |
| 3 | 1 | Exit | (10, 14) | player touch, below |
| 3 | 2 | Golem | (10, 4) | action; battle; p2 (switch 10) invisible, below |

Map 1 event 8 is deleted (`null` in the events array). Common events: 1 Chime
(trigger none, called by the chest), 2 Cave Drip (parallel while switch 4).

### Walkthrough (main path)

Moves are single tile steps; "bump" means pressing toward a blocking event,
which only turns the player (and fires a player-touch event). The player
faces down at the start.

1. Start on map 1 at (11, 9). The Intro autorun shows one text: **Confirm**.
2. **Right** -> (12, 9), facing the Elder at (13, 9). **Confirm** to talk.
   Text + choices ("I'll help" is the default): **Confirm**. "Bless you..."
   (shows Luck): **Confirm**. "My house is just north...": **Confirm**.
   Now switch 1 ON, Quest = 1, Luck = 1..6 (random), Bonus = 10 + Luck.
3. **Left**, **Up** x3 -> (11, 6). **Up** bumps the House Door (11, 5): door
   animation, transfer to map 2 (6, 8) facing up, black fade.
4. **Up** x4 -> (6, 4), facing the Chest at (6, 3). **Confirm**: lid opens,
   +2 Potion, +1 Cave Pass, +50 G, Quest = 2; text: **Confirm**; common event
   Chime (SE, 30-frame wait, text): **Confirm**.
   - Optional shop: **Down** x2, **Right** x3 -> (9, 6), **Up** (bumps the
     counter, turns up), **Confirm**: text, shop (Potion 20, Short Sword at a
     price override of 80, Cloth Vest 40), text. Return **Left** x3,
     **Up** x2. The main path buys nothing.
5. **Down** x5: the last step lands on the Exit (6, 9) -> map 1 (11, 6),
   facing down, black fade.
6. **Down** x4 -> (11, 10), **Right** x8 -> (19, 10), **Up** x3 -> (19, 7).
   **Left** bumps the Guard at (18, 7) (turns left). **Confirm**: "The
   elder's pass!": **Confirm**; Moss joins (129); text + choices ("Keep" is
   the default and the cancel choice): **Confirm**; switch 2 ON (the Gate
   opens), the guard turns; "The gate is open...": **Confirm**.
7. **Up** x7 -> (19, 0) through the open gate onto To Cave: switch 4 ON,
   transfer to map 3 (10, 13) facing up, white fade.
8. **Up** x8 -> (10, 5), facing the Golem at (10, 4). **Confirm**: text:
   **Confirm**; timer starts (90 s); battle with troop 1 (can escape, can
   lose). **Win**: timer stops, switch 10 ON, Reward = 100, +100 G; text:
   **Confirm**. (Escape: Escapes += 1; lose: Defeats += 1; the golem stays.)
9. **Down** x9: the last step lands on the Exit (10, 14): switch 4 OFF,
   map 1 (19, 1) facing down, no fade.
10. **Down** x9 -> (19, 10), **Left** x6 -> (13, 10). **Up** bumps the Elder
    at (13, 9) (turns up). **Confirm**: "The golem is dust!": **Confirm**.
    Switch 11 ON, Quest = 3.

Inputs: 71 direction presses (including the three bumps), the battle, and 17
Confirms.

Expected final state:

| | RPG Maker | kit id (`ids.ts`) |
|---|---|---|
| Map, position | map 1, (13, 10), facing up | `map001` |
| Switches ON | 1, 2, 10, 11 (4 is OFF) | `s001`, `s002`, `s010`, `s011` |
| Variables | Quest 3, Reward 100, Ticks 5, Escapes 0, Defeats 0; Luck 1..6, Bonus = 10 + Luck | `v001`, `v005`, `v009`, `v006`, `v007`, `v002`, `v003` |
| Items | Potion x2, Cave Pass x1 | `item001`, `item002` |
| Gold | 150 | |
| Party | actors 1, 2 (actor 2 still named "Moss") | `party-actor002` ON |
| Self switches | map 1 ev 1 A, map 1 ev 5 A, map 1 ev 9 B, map 2 ev 2 A | |

Ticks reaches 5 about 300 frames after the start (one per 60-frame wait), long
before the path ends.

## stage-mv: autorun opening cutscene

One map: map 1 "Stage" ("Lantern Stage"), 17x13, tileset 1 "Stage" (mode 1:
A2, A4, A5, B). It starts with the horizontally looping `StageClouds`
parallax at speed 2. The stage is y 2..5, a stage lip at y 6 (stairs at x 3
and x 8), the audience y 7..11 with chair rows at y 9 and y 11 (x 1..6,
x 10..15) and a center aisle at x 7..9. The fan's pen x 11..15, y 7..8 is
sealed by the lip, the chairs and a rail at x 10.

Switches: 1 SceneDone, 2 LeadBowed, 3 Smoke, 4 StagehandGo.
Variables: 1 Claps, 2 Encore. Actor 1 Ivy. Animation 1 "Sparkle" uses five
visible source cells, including translated/scaled/rotated/mirrored and
partially transparent cells; frame 0 has a sound plus target flash and frame
2 has a screen flash.

| Id | Name | At | Notes |
|---|---|---|---|
| 1 | Director | (0, 12) | autorun cutscene; p2 (self A) inert |
| 2 | Lead | (8, 3) | same priority; p2 (switch 2) uses Cast index 5 |
| 3 | Dancer | (4, 4) | custom move type, repeating route (not skippable) |
| 4 | Fan | (13, 8) | random move type, inside the sealed pen; its text is dim at the top |
| 5 | Stagehand | (12, 3) | p2 (switch 4) parallel: walks right 2 / left 2, Claps += 1, switch 4 OFF at 3 |
| 6 | Moth | (2, 8) | approach move type, above characters, through, empty list |
| 7 | Smoke | (6, 5) | p2 (switch 3) parallel, above characters, tile image: SE, wait 45, erase event |
| 8 | Spotlight | (8, 5) | below characters, tile image; its text is transparent in the middle |
| 9 | Usher | (14, 10) | p1 "wait"; p2 (switch 1 and Claps >= 3) checks Claps == 3, Encore = 1 |

### Walkthrough

1. Start at (8, 10), facing down. The Director autorun runs at once: the
   player turns transparent, fade out, BGM + BGS, the Curtain picture, fade
   in, a 30-frame wait, then text 1: **Confirm** (about 90 frames in).
2. The scene continues on its own: BGS fade, the curtain moves up and is
   erased, the player reappears, Change Parallax selects the non-looping
   zero-parallax `!StageGlow`, then an MV plugin command (356), a dusk tint,
   ME, a flash, a "!" balloon on the player, the player's route (**Up** x2
   and a turn up -> (8, 8), not skippable), the Sparkle animation on the Lead, the
   Lead's long route (skippable; it turns switch 2 ON and changes the Lead's
   image), Set Event Location puts the Lead back at (8, 3) facing down, a
   heart balloon on the Lead, then text 2: **Confirm** (roughly 10 s after
   text 1).
3. Switch 3 ON (the smoke puffs and erases itself), a shake, switch 4 ON. The
   Director loops (10-frame polls) until Claps >= 3 while the Stagehand walks
   three laps; then applause SE, a note balloon on the Fan, the tint clears,
   text 3: **Confirm** (roughly 8 s after text 2). Switch 1 ON, self switch A
   ON: control returns.
4. From (8, 8) facing up: **Down** x2 -> (8, 10), **Right** x5 -> (13, 10).
   **Right** bumps the Usher at (14, 10) (turns right). **Confirm**: "Three
   claps exactly! Bravo, Ivy.": **Confirm**. Encore = 1, heart balloon.

Inputs: 8 moves and 5 Confirms (a tape should wait for each message window;
the cutscene timings above are approximate).

Expected final state: map 1 (`map001`) at (13, 10) facing right; switches 1, 2,
3 ON and 4 OFF (`s001`..`s004`); Claps 3, Encore 1 (`v001`, `v002`); self
switch A of event 1 ON; event 7 erased; the Lead at (8, 3) on page 2.

## Command coverage

Counts include nested end-of-body `0` lines; route codes count both
Set Movement Route lists and custom move-type routes.

hollow-mz commands: 101 x27 (MZ speaker names), 401 x32, 102 x2, 402 x4,
403 x1, 404 x2, 108/408, 111 x6 (switch, variable, item), 411 x4, 412 x6,
112/113/413 x1, 117 x1, 121 x6, 122 x10 (set, add constant, add variable,
random), 123 x4, 124 x4, 125 x2, 126 x2, 129 x1, 201 x4 (fades 0, 1, 2),
205 x3 + 505 x17, 230 x4, 236 x2, 250 x7, 301 x1 with 601/602/603/604,
302 x1 + 605 x2 (one price override), 303 x1, 355 + 655, 357 + 657 x2.
Route codes 2, 3, 15, 16, 17, 18, 19, 35, 36.

stage-mv commands: 101 x12 (MV, four parameters), 401 x14, 108, 111 x3,
411/412, 112/113/413, 121 x4, 122 x2, 123, 203, 205 x3 + 505 x44, 211 x2,
212, 213 x4, 214, 221, 222, 223 x2, 224, 225, 230 x3, 231, 232, 235, 241,
245, 246, 249, 250 x3, 356. Route codes 1-10, 12, 14-16, 19-22, 24-27,
29-31, 33, 35-38, 41, 42, 44. Change Parallax 284 x1.

Expected to have no kit equivalent (placeholder or dropped): 236 weather,
124 timer, 355/655 script, 356/357 plugin commands, 303 name input (only on
the optional "Rename" branch).
