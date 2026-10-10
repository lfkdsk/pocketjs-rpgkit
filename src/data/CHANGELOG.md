# rpgkit-project format changelog

The format marker on every project document is the `format` string,
currently `"rpgkit-project/v1"` (`src/data/schema.json` is normative;
`src/engine/types.ts` carries the TypeScript types).

## Schema identities

Sharded shells (`mapSchemaHash`) and their saves (`content.schema`) record
the schema identity they were produced under: SHA-256 of canonical
`src/data/schema.json`, exported as `MAP_SCHEMA_HASH`. Every schema edit
produces a new identity. The runtime and the editor accept the current
identity and every identity in `MAP_SCHEMA_COMPATIBLE_HASHES`
(`src/engine/schema-identity.ts`); anything else is refused (`shell schema
hash mismatch`, save error code `content`). A session always records the
current identity, so the next save of an old game is rewritten under it.

A change is **additive** when every document valid under the previous schema
is still valid and behaves exactly as before: a new optional property, a new
command or condition, a new enum value, a loosened limit. The previous
identity then joins the compatible list. Anything else (a new required
field, a removed or narrowed value, an existing field whose behaviour
changes, even only for unusual values or alongside a new command) is
**breaking**: the list is cleared and older shells and saves are refused
until a migration exists. Compatibility carries across rows, so only the
identities at or after the most recent breaking row stay loadable. Each new
identity adds a row at the top of this table and a fixture under
`tests/fixtures/schema-compat`; a test keeps the table, the list and the
fixtures in step, and each breaking row keeps a counterexample recorded by
the release before it.

A shell without `mapSchemaHash` (written before sharded shells recorded
one, or by hand) is not checked against this table: it is read as the
current schema, validated like any other shell and saved under the current
identity.

The last column says whether shells and saves of the row below still load
under the row's schema.

| Identity | Change | Older |
| --- | --- | --- |
| `9435a3b7f420c7e7876a7d211e8b2842bdc60e483c54c60cd550d7f5effc7d1c` | optional `worldLayout` opening `movementCapability`; documents that omit it retain the ordinary target-solid passage check | additive |
| `138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022` | optional `routeSpeed.tilesPerSecond` exact fixed-clock velocity; documents that omit it retain the existing MV speed grade, route lifetime and bytes | additive |
| `5eecc57a1acad4721139225b1bed1e35ae581706c29e611909d58b2c90efb41b` | optional `screenBackdrop.whenModalOpen: "ignore"` policy for sources whose state stack preserves a covered backdrop, plus optional `system.transferPresentation: "retain"` for world-owned map animations, camera focus and player balloons; documents without either field keep unconditional backdrop replacement and the original per-map presentation lifetime | additive |
| `70564328ea0fd8a8028ac6f360f82dda0973a068ad54f4a705fb3a3cd5531905` | optional `nameInput.random` ui-text word; optional `appearance.combatSheet` player battle back-sheet field with its `saveDefault` baseline; optional `system.characterNames` opt-in for `{char:player\|this\|eventId}` text; and `changeName` event targets/variable-fed names. Documents without the opt-in keep `{char:...}` literal, and older `changeName` commands retain their player/literal meaning | additive |
| `c5d8a3f0ed118bfd8d99f2a0b4dda7479918506c3728d09097f1ef662788af2c` | `playerMoving` condition, plus optional exact `intervalTicks` cadence for command-started wander; projects without either addition retain their existing behavior and MV frequency-grade cadence | additive |
| `e763f4898c37c59c111618d57feb35d93b4ba67932cfb2094406388f1efedb45` | optional `uiText` entries for manual-save refusal, save/load progress, success and failure feedback; documents without them keep the English defaults | additive |
| `11227c99d75fe0ec833b77499bec30022f046383c4eeb9349a3f590bbc4ce801` | optional switch declaration `writtenBy: "host"` — marks a switch the host or an extension writes at runtime, so the static checker does not flag it as read-never-set; declarations without the marker are still checked | additive |
| `dddabaa88780fa1e117a911c88e191b5958bd390b41739e8b6bc1fd0f41ed4e0` | `routeSpeed` moveControl variant: a speed grade scoped to one forced route (latches onto the active route or is held pending for the next, and is gone when the route ends); documents that never use it move unchanged | additive |
| `a749a871f1eb32969ae58ff186871e21ff1ca4fb26390088512ee2bca927f82a` | optional editor-facing `switches` and `variables` declaration directories; undeclared ids retain the same sparse runtime semantics | additive |
| `1127febbfb43f2f33b1bd7a2df8c554efbbdc56e1e9a35f26558dbda4f8261b9` | optional `text` layout fields: `position` (top/center/bottom, the four corners, left/right), `align`, `valign` and `background` (window/dim/transparent); a text without them draws the same box as before | additive |
| `5f14109a6414a63f6a4eaaa25c586aca61218b3a8e53f4f3776853a9573e7349` | `autosave` command; optional `save.autosave` interface label | additive |
| `c0e962138a1f12dc5627590869b99f7c9b2ced3040e3d05ed0ebd663142d4857` | optional `system.textTokens` — declaring it is the explicit opt-in that switches `{x:<key>}` text-token expansion on (the allowlist of keys the game's session resolver answers); a document without it keeps the pre-`{x:}` literal behavior | additive |
| `3315cbf7af3ceb5f6690824bf7fe0d0d7ac90f080fd741c7e24159a2b3e99ddb` | optional label `ord` (the label's position in the original flat RPG Maker source list, so a `jumpLabel` resolves the first label in source order even when the importer reordered branches) | additive |
| `1b66bce2dff2f3f8476a9dcc3212ee826053447c5a7683c9942adbcfd122fc12` | optional map `tiles` (four raw RPG Maker tile layers for Get Location Info), optional item `kind` (weapon/armor), `locationInfo` layer 0..3 | additive |
| `3a57e757f9f5d4f3da13529cd376ceb8ef50a354a3a618e45a8fa41641b84562` | the merged KRM3 and KRM3V batches together: `label`/`jumpLabel`, `selectItem`, `menuAccess`/`saveAccess`, `locationInfo`, `stopSe`, the `region` condition, map `regions`/`terrain` and item `type`, plus map parallax/`changeParallax` and animation sound/flash timings | additive |
| `0e510772cbf540414553fd8f4204e0cecba80f4d8c844146e3be46d23841daae` | optional map parallax data and `changeParallax`; optional animation sound/flash timings; `mapAnim` may target the issuing event as `this` | additive |
| `3ac9e23fa3289a6021dfe4e0141e732b303aefad37c2ba70538423701f00156e` | `label`/`jumpLabel`, `selectItem`, `menuAccess`/`saveAccess`, `locationInfo`, `stopSe` commands; `region` condition; optional map `regions`/`terrain`; optional item `type` | additive |
| `49d96a259da5a5bae6f15eb0c3e7184e8f874de1b0f13a8ba161586f4c0149a1` | optional project `worldTraversal` identity and optional transfer `handoff` opening provenance; absent fields retain the legacy transfer timeline | additive |
| `bc4e72429a7ed9f491dcddf7a9b6bbd5ef8216d2521721ad1c078cabccf26906` | optional root `uiText` (the kit's interface words, including the demo error sentence templates) | additive |
| `4a9a831002d95a662f16c83de31dea57998ae72b7c2183d5433eabd932f4c4a1` | `scrollMap`; `showPicture` / `movePicture` / `rotatePicture` / `tintPicture` / `erasePicture`; `timer`; `inputNumber`; `openMenu` / `openSave` / `gameOver` / `returnTitle`; `changeName`; `mapNameDisplay`; `timer` condition; optional `system.mapNameDisplay` | additive |
| `ff6b923750b1078d15a8d2443251d14a5b5b17055b88445515a9b34e38056611` | `loop` / `break` commands, `eventTouch` trigger, `system.textVariables` | additive |
| `ed562c6fa8e20c0d0d20a755e19b49581b49127328343c87231801a19f297de2` | optional `worldLayout` with topology identity, connected components, placements, seams and per-portal opening compatibility | additive |
| `c0588207c28d2ffcec9e2ac981f9859ca55576fb7dc53f221466c249d07bfa06` | optional `icon` on `choices` options | additive |
| `0b9fff5b478b87e0dcae1f37044a444043c735339ca45245bdbbb9e2e36e7ab5` | `scene` command; a battle queued by a parallel page is dropped when that page stops being active before the battle starts (it used to start anyway) | breaking |
| `47cf3d8ffdb35044fb6b099d98455368123db4710bc8516875a0bc06902c6d59` | `audio` entries may also name QOA streams | additive |
| `8ffba1d4305ed2fa7ea0a2421e2982a98eff38a228ee59b0726fd8865fb816f1` | root `audio`, audio commands, `bgmPlaying` condition | additive |
| `2d99dc69aff70a2e5eb690963f094c9d5e06d766c3af7b8c09796bbcce41ea04` | screen, camera and balloon commands | additive |
| `cc709a6fa4f1a2597d2128649c632f72dee10998823533380cba012b3e1ee0b6` | root `animations`, `mapAnim` / `stopAnim` | additive |
| `37e18dede0ca663db3decd895f5ddf4a754b563a4734d9e2de817c97366d6f1f` | page movement fields, `moveControl`, `control` move step, `player` place target | additive |
| `9553e885ee1aca527679ba74ce348290a51bdf2b5714a5533aeca43edc7e99b5` | `appearance`, `layer`, `tileProperty` commands and conditions | additive |
| `96239876deaca61c4db65417c05a3e5c009c7141aae100276bbf853845670d5b` | `extChoice` command | additive |
| `0ff7c248ce6b0e4ba42f815b41f869ce333ffa2b748acb69d712e3441a30692c` | `worldIdle` condition | additive |
| `c27e2e51e0256f25fc7c6850b83273dab8bab9664e249a72c0a38d8940939157` | inventory and `shop`, larger `choices` limits, variable `from` operations; numeric variable writes clamp to safe integers and saves holding larger numbers are refused | breaking |
| `462299c3e20212f9a5a092a88fc563164a87bd4e473214c1e909389baa12cc90` | `ext` and `battle` commands, `ext` condition, variable transfer targets; a transfer to an unknown map enters the content-error state instead of throwing | breaking |
| `c8ca2ce77e5bff0af2d15f33863014d51dfb4acf4cef14fb678a17f7dc1ecba3` | `system.messageBlocksPlayer`; moving characters are stopped only by `blocks: true` pages | breaking |
| `9570c570df1ddb497b6f5a0c9d1f1a0a265e22cf1ae83e8da8dcd5310e9f2a21` | first sharded generation (`mapIndex`) | first |

## Manifest identity

A sharded shell's `mapManifestHash` is SHA-256 over the canonical shell
with `mapManifestHash` and `mapSchemaHash` removed. It identifies the
content build a save belongs to: a save names it (`content.manifest`) and
is refused when the live shell's manifest differs (save error code
`content`).

Root fields that are **presentation only** are excluded from this hash:
they are proven never to reach the reducer, the session, the interpreter
or the save codec, so changing them cannot alter a save, a tape or a
replay. The current list is just `uiText` (the kit's interface words):
the engine never reads it — only UI components do, through GameView's /
a component's `uiText` prop — so a save taken in one language loads into
another language's shard. Per-language map content (dialogue written in
events, item names, and so on) is hashed through `mapIndex` and still
changes the identity. The exclusion list lives in
`src/engine/map-repository.ts` (`MANIFEST_EXCLUDED_ROOT_FIELDS`); a field
joins it only with a test that a save survives the field's change
(`tests/map-repository.test.ts`).

## v1 — 2026-09-23 (component extraction release 0.1.0)

First frozen release of the format, extracted from the PocketJS app
`apps/rpgkit` integration branch I3 (`pocketjs@780218d7` plus the merged
P1①–P1⑤ runtime work).

- Project: `format`, `title`, `tileSize` (16), `start` (map/x/y/dir),
  optional `initialGold`, `sheets`, `items`, optional `sprites`,
  `commonEvents`, `maps`.
- Maps: dense row-major `ground` tile ids (`"sheet.cell"`, `null` is a
  blocking void), sparse `upper` star layer, sparse `passage` overrides,
  `events`.
- Sheets: 16px-cell grids with `defaultPassage`, `block`/`pass` cell lists,
  and per-cell `dirBlock` edge masks (see the 2026-09-27 amendment).
- Events: ordered pages; each page has one trigger
  (`action` | `playerTouch` | `autorun` | `parallel`), an optional
  condition (`switch` | `selfSwitch` | `variable` | `item`), an optional
  static `sprite`, `blocks`, autonomous `moveType`
  (`static` | `random` | `approach`) or an authored `moveRoute`, and a
  command list.
- Commands, 15: `text`, `choices`, `switch`, `variable`, `selfSwitch`,
  `if`, `transfer`, `moveRoute`, `wait`, `gold`, `item`, `se`, `erase`,
  `exit`, `common`.

## v1 amendment — 2026-09-27 (release 0.2.0)

Two changes landed in the PocketJS working copy after the extraction and
are folded into v1 here, while the only v1 documents are this
repository's own examples:

- `dirBlock` follows RPG Maker MV's directional passage: an entry bars
  its edge in **both** directions (leaving the cell through that edge and
  entering it through that edge from outside). A step is refused when the
  source cell bars the step direction or the target cell bars the reverse
  one. v1.0 read the mask as exit-only; a document that relied on a
  one-way exit must now use a `passage` override instead.
- Event ids, and `switch`/`variable` ids, may contain uppercase letters
  (`^[A-Za-z0-9_-]+$`, `^[A-Za-z0-9_.-]+$`). Every document valid under
  v1.0 stays valid.

## v1 amendment — 2026-09-29 (K1 event-model extension)

Six optional, backwards-compatible event-model additions (T2-1, T2-2,
T2-3, T2-6, T2-7, T2-8). Every v1.0/v1.1 document stays valid; all new
fields and commands are optional and the v1 spellings keep their meaning.

- **Event areas (T2-1):** an event may occupy a rectangle with optional
  `w` / `h` (default 1×1; minimum 1). A `playerTouch` page fires when the
  player enters ANY cell of the rectangle (each step onto a fresh area
  cell is a new entry), and an `action` page fires when the player
  confirms while the faced tile OR the occupied tile lies inside it.
- **Compound page conditions (T2-2):** a page condition may carry
  `all: Condition[]`, an AND of existing switch (either value), variable,
  self-switch, item and gold conditions. It ANDs with the flat
  `switch` / `selfSwitch` / `variable` / `item` fields when both are used.
- **Facing conditions (T2-3):** a new `{ kind: "facing", dir }` condition
  (usable in `if` and in `condition.all`) tests the live player facing. A
  `playerTouch` page whose condition reads facing also re-fires when the
  player turns in place while standing inside its area — modelling a
  door/exit mat that only opens when faced, not when crossed sideways.
- **Per-visit `local.` variables (T2-6):** any switch or variable whose id
  starts with `local.` is reset on every map entry (it does not survive a
  transfer). Non-`local.` ids remain project-wide.
- **Place event and initial facing (T2-7):** a `place` command
  (`{ op: "place", target, x, y, dir? }`, target `"this"` or
  `{ event: id }`) relocates an event to a tile, optionally facing a
  direction (MV Set Event Location). A page may also set `dir` for the
  facing its character shows when that page spawns it (and after a page
  switch).
- **Cross-event input lock (T2-8):** `{ op: "lockInput" }` and
  `{ op: "unlockInput" }`. While the lock is held the mover ignores the
  d-pad and action presses start no event; `autorun` / `parallel` pages
  keep running. The lock is per map visit (a transfer clears it) and its
  held state is preserved by a save.

## v1 amendment — 2026-09-29 (player name, tall walkers)

- `playerName` optionally supplies the fresh-session value substituted for
  `{name}` in text and choice prompts. The value lives in save state after
  startup.
- A `walker` sprite may name a build-time source `sheet` id/path with optional `h`, `cols` and
  `rows`. The default is a 3-column by 4-row sheet of 16×32 frames; the asset
  cooker slices it into idle/left-step/right-step images for four facings.
  The original per-direction `atlases` walker declaration remains valid.

## v1 amendment — 2026-09-29 (movement extensions)

- **One-sided passage edges:** a sheet may declare `dirEdges`, keyed by
  cell, with optional `enter` and `exit` direction lists. `enter` refuses
  stepping into the cell across that edge; `exit` refuses leaving it across
  that edge. The existing `dirBlock` keeps its symmetric meaning (both
  leaving and entering through the edge).
- **Routes on any event:** `moveRoute` takes an optional `target`
  (`"player"`, `"this"` or `{ event: id }`) with the existing `wait`
  semantics.
- **Turn and path steps:** route steps `turnTowardPlayer`,
  `{ turnToward: target }`, `{ pathTo: { x, y, retries? } }` and
  `{ approach: { target, retries? } }`. Path searches are deterministic
  breadth-first searches split across reference ticks (independent of the
  host rate); a blocked step waits and replans at most `retries` times
  before the route ends.

## v1 amendment — 2026-09-29 (on-demand map entries)

- A project may retain the original inline `maps` array or replace it with a
  `mapIndex`. Each index entry identifies one independently addressable map by
  `id`, `width`, `height`, `entry` and canonical-JSON `sha256`; optional
  `mapManifestHash` and `mapSchemaHash` bind saves to the exact content build.
  Existing inline documents and saves keep their original behavior.
- `ProjectShell` plus `MapRepository` loads only the starting map and the
  destination of each transfer. Parsed map data, compiled interpreter worlds,
  passage tables and render residency are derived caches, not project state or
  save data. A restore reacquires its saved map; a manifest/schema mismatch is
  rejected before map acquisition.
- An async-backed repository may prepare missing bytes outside the reducer.
  The UI pauses and retries the same input frame after preparation, so network
  timing cannot alter the simulation timeline.

## v1 amendment — 2026-09-29 (K4: shop, scrolling choices, variable arithmetic)

Three optional, backwards-compatible additions from Scout S1 §5–6
(T2-9, T2-10, T2-16). Every existing v1 document stays valid.

- **Shop (T2-10, extended for B1):** a new `shop` command
  (`{ op: "shop", id, goods: ShopGood[], sell?, sellList? }`, MV Shop
  Processing). `id` namespaces this shop's persisted stock counters and
  must be stable across saves. `goods` is the buy list; each entry is
  `{ item, price?, sellPrice?, stock?, condition? }`: `price` overrides
  the item's own catalog price for buying at this shop only (falling
  back to it when omitted); `sellPrice` overrides this shop's buy-back
  price for the item (falling back to floor(item.price / 2)); `stock` is
  a finite quantity this shop carries — a buy decrements it and a
  sell-back at this same shop increments it, persisted per shop `id` +
  item id — omitted means unlimited; `condition` reuses the
  page-condition clause shape (switch/selfSwitch/variable/item/`all`)
  and hides the row while it does not hold. `sell` (default true) shows
  a sell tab for the player's whole inventory. `sellList` (default
  `"disable"`) governs an unsellable row (Item.sellable:false, or an
  effective sell price of 0): `"disable"` lists it dimmed and
  unconfirmable (MV parity); `"hide"` omits it (Tuxemon parity, only
  resellable items). Item gains optional `price` (shop price) and
  `sellable` (default: sellable whenever its effective sell price is >
  0) fields. Project gains an optional `system.inventory` block:
  `maxPerItem` (default 99, the prior fixed cap) and `maxKinds`
  (default unlimited) bound the backpack; a purchase that would exceed
  either, or that the player cannot afford, or that has no stock left,
  is refused (the row stays selectable, just inert).
- **More than 4 choices (T2-9, extended for B2):** `choices.options`
  widens from 2-4 to 2-8 entries, and an option's `text` from 24 to 64
  characters. The box still shows 4 rows at a time; past 4 options it
  scrolls a window that follows the live cursor, and a label longer
  than the box truncates with a trailing ellipsis instead of
  overflowing it. (A runtime change since, with no schema change: the
  kit's boxes now wrap such a label onto more rows instead of cutting
  it.)
- **Variable-operand arithmetic (T2-16, extended for B3):** `variable`'s
  `set` accepts a third shape, `{ op: "copy" | "add" | "sub" | "mul" |
  "div" | "mod", from: id }`, reading another variable's live value
  instead of a literal (`target OP source`; `copy` assigns it
  outright). Every variable write — this shape and the literal
  `set`/`add`/`sub`/`random` shapes alike — lands as a finite integer
  clamped to `[-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`; a
  non-integer result (a division quotient) floors toward negative
  infinity (`-7 / 2 = -4`, matching MV's `Math.floor` and Tuxemon's
  `//`, not the prior `Math.trunc`). Division and modulo by a source
  that currently reads 0 leave the variable unchanged (Tuxemon's
  `safe_floordiv` returns the left operand; MV would write a
  non-finite result, which this format does not follow), so the saved
  variable bank stays plain finite JSON numbers even for an
  authoring-time value schema accepts but arithmetic would otherwise
  overflow (`1e308 * 1e308` clamps instead of becoming `Infinity`).

## v1 amendment — 2026-09-29 (message hold, character bodies)

- **Message hold (optional):** a project may carry
  `system: { messageBlocksPlayer: true }`. While any text or choices box
  is open — including one a `parallel` page shows — the player cannot move
  and no `action` or `playerTouch` page starts, so the confirm press that
  advances the box never also starts the faced event. `autorun` and
  `parallel` pages keep running. The option defaults to `false`, and a
  document without it behaves exactly as before: only a blocking
  (`action` / `playerTouch` / `autorun`) fiber or a choices box holds the
  player, and a parallel page's text line does not.
- **Character bodies follow `blocks`:** a moving character (page
  `moveRoute`, `random` / `approach` motion, a `moveRoute` command, and the
  `pathTo` / `approach` searches) is now stopped only by pages with
  `blocks: true` (and by the player), the rule the player's own movement
  already followed. Before, every event with an active page stopped a
  character, so a sprite-less `blocks: false` marker such as a transfer mat
  could hold a non-skippable cutscene route forever. The player's own
  `pathTo` / `approach` search no longer routes around `blocks: false`
  events either. A document that relied on a `blocks: false` event to stop
  a character must give that page `blocks: true`. This repository's
  examples and goldens are unchanged.

## v1 amendment — 2026-09-29 (on-demand map loading performance)

- The standard JSON map repository skips redundant entry SHA-256 work for
  trusted synchronous package sources and uses compilation-critical structural
  validation by default. Async-prepared sources still verify checksums by
  default, and callers can explicitly request checksum or full schema checks.
- Split map entries are fully schema-validated at build time, emitted as stable
  ASCII JSON, and may be read as bytes through the bounded fast decoder.
- Map entry sources may expose an optional `readText` method. The repository
  prefers it over `read`, while old byte sources keep their existing decode,
  checksum, missing-entry, and preparation behavior.
- Non-zero transfer fades may prepare a destination in fixed deterministic
  units before the original map-swap tick. Preparation remains derived cache
  data; zero-fade transfers retain their all-at-once behavior.
- Filesystem save helpers accept the shell content identity for writing,
  loading and listing slots, so a different map manifest or schema is rejected.
- A splitter-emitted shell manifest is used directly as the content/save
  identity for trusted application packages, avoiding a redundant synchronous
  SHA-256 during startup. Shells without a declared manifest are still hashed;
  untrusted declared manifests can opt into recomputation with
  `verifyMapManifest: true`. Map-index structure is always validated.

## v1 amendment — 2026-09-29 (extension state and Battle Processing)

- **Plugin commands and conditions:** `{ "op": "ext", "call":
  "namespace.name", "args": <json> }` and `{ "kind": "ext", ... }` invoke
  pure game handlers registered in `createSession` options. Unknown calls are
  rejected up front; an explicit preview mode may treat them as command
  no-ops / false conditions.
- **Extension state:** `SessionState.ext` is an opaque JSON slot, defaulting
  to `null`, with optional game validator and save codec. Saves, checksums and
  rewind include it. Checksum-valid older v1 saves that omit the slot hydrate
  it as `null`.
- **Variable transfer operands:** `transfer.map`, `x`, `y` and `dir` may use
  `{ "variable": "id" }` instead of a literal. They resolve from the live
  variable bank when the command executes. Unset/wrong-typed operands and
  unknown resolved maps now enter the fatal content-error state (frozen,
  visible in `GameView`, and non-saveable) instead of throwing from the host
  frame loop.
- **Battle Processing:** `{ "op": "battle", "setup": <json>, "onWin"?,
  "onLose"?, "onEscape"? }` parks its event fiber in a game-owned pure battle
  scene. The scene is seeded from one saved session RNG draw, advances in
  fixed reference ticks, writes extension/variable state on completion and
  resumes through the matching branch. A completion transfer follows the
  branch. Active battles cannot be saved but are included in attract rewind.
- **Battle queue and world policy:** concurrent requests now queue in
  deterministic main-then-parallel-key order instead of overwriting a parked
  fiber. This ordering applies only while appending newly emitted battle
  requests; the established generic fold remains parallel-key-first and main
  last. The next battle starts on the reference tick after completion.
  Battles freeze page sync, movement, and map fibers by default; games may
  explicitly choose `scene.worldContinues`. Active scenes and non-empty
  queues are both non-saveable, and authored requests during a scene no
  longer throw.
- **Battle result switches:** `BattleCompletion.switches` atomically writes
  boolean switches alongside extension state and variable `writes`.
- The editor's schema-backed raw JSON model validates and round-trips both
  additions without requiring a specialized form. Existing projects and
  saves retain their prior behavior and defaults.

## v1 amendment — 2026-09-29 (K4 fix 3: finite-state construction/restore/ext/battle)

- **Shared finite-integer normalization now covers construction and
  restore, not just runtime writes:** `createSwitchState`'s public
  constructor clamps `gold`/`items`/`variables`/`shopStock` through the
  same normalizer every authored command write already used; both
  `createInterpState` (fresh session) and `restoreSessionSnapshot` (loaded
  save) route through it, so a hand-built initial state or a
  checksum-valid saved bank cannot carry a value outside
  `[-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]`. An extension
  command's `result.writes` and a `BattleCompletion.writes` numeric entry
  clamp the same way on their way into the live variable bank.
  `save-validate.ts` now requires these four banks to be
  `Number.isSafeInteger`, not merely finite, rejecting a hand-crafted
  envelope with a typed `SaveError` instead of silently restoring an
  out-of-range value.

## v1 amendment — 2026-09-29 (shared battle and extension inventory)

- `BattleRules.start` receives a fourth read-only context containing the live
  extension state, switches, variables, items and gold. The session always
  supplies it; existing three-parameter JavaScript/TypeScript implementations
  remain compatible and ignore the extra argument.
- `ExtensionCommandResult` and `BattleCompletion` may return `items` and
  `gold` replacements. They update the same `SessionState.sw` backpack and
  wallet used by item/gold commands and shops, atomically with extension,
  variable and switch writes and before a subsequent command or battle-result
  branch.
- `items` replaces only listed ids. Each finite count is floored through
  `clampFiniteVar`, clamped to `[0, system.inventory.maxPerItem]`, and a zero
  result removes the id. Removals and replacements of currently held kinds
  happen first; previously unheld positive ids are then admitted in lexical
  id order until `system.inventory.maxKinds`, and excess ids are discarded.
  `gold` is likewise floored/clamped to a safe integer and then to zero or
  above. This ordering is deterministic regardless of object insertion order.
- The values use the existing save/snapshot/rewind path and fixed-rate fold.
  `canSave` is unchanged: an active battle or queued external work is still
  not a save point.

## v1 amendment — 2026-09-30 (shell manifest freshness check)

- `assertShellManifestFresh(shell)` exports the build/test-time freshness
  check for a packaged shell's declared `mapManifestHash`: it recomputes the
  manifest hash over the shell content and throws with both the declared and
  computed digests on mismatch, and likewise rejects a missing or malformed
  declaration. The runtime trust default is unchanged, so an application that
  packages a `ProjectShell` must call this in its build or test pipeline
  after writing the shell. `splitProjectMaps` self-checks its own output.

## v1 amendment — 2026-09-30 (derived world-idle condition)

- `{ "kind": "worldIdle", "negate"?: boolean }` is available in both an
  event page's `condition.all` and an `if` command. It is true only in the
  freely controllable map state: no blocking main event, input lock, modal,
  player route, transfer/fade, pending or active scene, fatal overlay, or
  host-owned menu. Parallel fibers and NPC routes alone do not block it.
- Evaluation is point-in-time. Page gates sample before that reference tick's
  fibers run; an `if` reads the live working state, including locks, modals,
  transfers and battle requests published by an earlier fiber in the tick.
  `negate:true` inverts the sampled result.
- The value is derived from existing reducer/session fields. It adds no project
  defaults or save fields, so existing v1 project documents and save payload
  shapes do not change. The normative schema identity is refreshed as usual;
  attract replay/rewind re-derives the value from restored state.

## v1 amendment — 2026-09-30 (runtime movement controls)

- Pages gain optional movement defaults: `moveSpeed` (MV grade 1-6, default
  5), `moveFrequency` (MV grade 1-5, default 5), `directionFix` (default
  false), `through` (default false), and `facingMode` (`followMovement`,
  `locked`, or `scripted`; default `followMovement`). `run` raises the
  effective speed grade by one, capped at 6. Frequency cadence is measured on
  the fixed reference-tick clock using the MV grade: grade `n` waits
  `30 × (5 - n)` reference ticks between autonomous decisions.
- The new `MoveControl` union selects bounded random `wander` (optional
  non-empty `{x,y,width,height}` bounds and frequency), page/static/approach
  autonomous motion, `stop`, speed, run, frequency, direction fix, through,
  or facing mode. `{ op: "moveControl", target, control }` applies one to the
  player, the running event, or a named event. A move route may apply the same
  control to its actor with a `{ control }` step.
- All runtime settings, including `stop`, persist for the current map visit
  and round-trip through saves. An NPC page switch clears every movement
  override for that actor; a map transfer clears overrides for the player and
  every NPC. Motion priority is forced route, runtime autonomous override,
  page patrol, then page autonomous motion. `stop` cancels the active route
  and suppresses page patrol; `moveType:"static"` stops wandering.
- `through` crosses terrain and character bodies, but never map bounds, and
  touch triggers still fire. `directionFix` prevents all facing changes.
  Tuxemon's `locked` and `scripted` facing modes both prevent only automatic
  movement turns here; explicit face steps remain effective.
- Player wander makes the derived `worldIdle` condition false; NPC wander does
  not. Input lock or any dialog pauses player wander, and any dialog pauses
  runtime NPC wander. This dialog rule does not depend on the optional
  `system.messageBlocksPlayer` setting.
- `place.target` now reuses `RouteTarget`, so Set Location can relocate the
  player as well as `"this"` or a named event.

## v1 amendment — 2026-09-30 (extension-provided dynamic choices)

- **Dynamic extension choices:** `{ "op": "extChoice", "call":
  "namespace.name", "args": <json>, "prompt": "...", "cancel"?: boolean,
  "write"?: { "index"?, "key"?, "cancelled"? } }` opens the existing
  scrolling choice modal from a registered `ExtensionOptions.choices` handler.
  Its pure `options` function returns `{key,label,enabled?,data?}` rows from
  the live read-only extension and built-in banks on every reference tick.
- Keys are unique stable logical identities and preserve the cursor across
  reorderings. A removed key clamps the old index and suppresses confirmation
  for that refresh tick. Disabled rows remain visible and navigable but cannot
  be confirmed. Row data is opaque finite JSON, defaults to `null`, and is
  cloned into the selection result. A non-cancellable list must retain an
  enabled row; only a cancellable list may be empty.
- Confirm/cancel optionally write result fields to distinct variable ids:
  selection writes its zero-based index, key, and `cancelled=0`; cancellation
  writes `-1`, `""`, and `cancelled=1`. The optional `resolve` callback receives
  either `{kind:"select",index,key,data}` or `{kind:"cancel"}` and may return
  the same extension/variable/item/gold replacements as an `ext` command.
  Direct destinations and resolver writes may not overlap; all results validate
  before one atomic commit visible to the next same-tick instruction.
- Row generation has no random API. Only `resolve` can draw the saved session
  RNG, and only on a selection/cancel edge, so idle modal ticks consume no
  entropy. Unknown handlers are rejected during inline-project creation or
  sharded-map acquisition; explicit preview `allowUnknown` treats the command
  as a no-op.
- The modal captures directional input, blocks its owning fiber and makes
  `worldIdle` false. Existing safe-point policy forbids saving while it is open;
  rewind reconstructs it through the ordinary pure reducer, and per-reference-
  tick refresh preserves behavior across supported host rates. Existing
  projects and save payloads keep their prior behavior. The normative schema
  identity is refreshed as usual.

## v1 amendment — 2026-09-30 (runtime appearance, visual layers, tile properties)

- **Change Character Appearance:** `appearance` targets the player, the
  running event, or a named event and may replace its walking `sprite`,
  0..255 `opacity`, and/or `visible` flag. `null` restores a field's default.
  Player appearance is project-wide and `saveDefault:true` records a new
  sprite reset baseline; event appearance lasts only until that event changes
  page. `{ kind: "appearance", target, sprite }` compares the effective key.
- **Prepackaged visual layers:** `layer` changes `visible` and/or `variant`
  for a named `GameAssets.layers` entry. Reserved `ground`/`upper` bands,
  additional below/above world bands, and viewport-space screen overlays are
  supported by both eager and streamed map sources. Art remains immutable and
  build-time cooked; switching rebinds stable nodes or resident streamed
  textures instead of baking a map at runtime.
- **Runtime tile passage:** `tileProperty` sparsely replaces one current-map
  cell's `passage`, one-sided `enter`, and/or `exit` masks. `null` restores the
  authored field and an empty edge list explicitly opens that half. Player
  movement, NPC movement and path search share the derived table. The matching
  condition checks requested explicit fields, including absence via `null`.
- Layer, event-appearance and tile-property records are per map visit and are
  cleared by every transfer (including same-map); player appearance crosses
  maps. All records participate in save validation, save restore, attract
  rewind and fixed-rate replay. Older v1 documents and saves may omit every
  new field and retain their previous behavior.

## v1 runtime note — 2026-09-30 (bounded rewind keyframes)

- `AttractController` now retains process-local full-state keyframes every
  3,600 reducer/source frames and at map/battle boundaries. Rewind restores the
  newest retained snapshot and folds only its suffix; capture positions remain
  independent of the 60/30/20/4 Hz host rate.
- `keyframeIntervalFrames` and `keyframeMaxBytes` configure the interval and
  default 8 MiB estimated-payload cap. Oldest snapshots are evicted first, with
  a frame-zero fallback outside the retained window. Diagnostics expose the
  current estimate and most recent suffix length.
- Keyframes are runtime acceleration data only. Neither `rpgkit-project/v1`
  nor the `rpgkit-save/v1` envelope changed.

## v1 amendment — 2026-09-30 (map animations: mapAnim / stopAnim)

- `project.animations` lists frame animations: `{ id, sheet, frameDuration,
  frames | count, frameW?, frameH?, cols?, loop? }`. The cooker slices each
  sheet into one static baked image per frame; a missing sheet is a build
  error. `frameDuration` is seconds of virtual time, compiled to reference
  ticks with the world's hz, so the same virtual instant shows the same
  frame at 60/30/20/4 Hz.
- `mapAnim` plays an instance on a tile (`x`/`y`) or following the player or
  a named event (`target`), `layer` "above" (default) or "below" characters,
  with `loop` overriding the definition default and optional `wait` parking
  the fiber until one playthrough completes (one-shot) or until `stopAnim`
  stops the instance (looping). `stopAnim` stops one instance by `id`,
  every instance of an animation name, or all live instances.
- Instances are interpreter state keyed by `id` with the saved frame clock as
  their origin: playback is identical under rewind and after a save/load, a
  same-id replay restarts the instance, and a transfer rebases live instances
  onto the fresh map clock without changing their visible phase. Event-bound
  instances pin to their last source-map cell; player-bound instances keep
  following the player. A playing (non-waited) animation does not make the world
  busy; stopping a waited instance resumes its fiber. Older saves without the
  field keep it absent (no `anims` key), not an empty list. The normative
  schema identity is refreshed as usual.
- `mapAnim` gains `follow:false` to snapshot a target's tile at execution
  and pin the instance there (Tuxemon `play_map_animation` parity); the
  default `follow:true` tracks the character's live interpolated pixel
  position. A `wait:true` on a looping animation now blocks until `stopAnim`
  stops the instance (MV "Wait for Completion" parity), not one cycle. A
  default-frozen battle shifts every live instance's `start` and every
  `animWait` fiber's `since` by the paused duration so playback resumes from
  the same visual frame. Frames taller than one tile shift up by half their
  height, matching Tuxemon's map view anchor.

## v1 amendment — 2026-09-30 (game scenes and name input)

One optional, backwards-compatible command plus one built-in scene. Every
v1.0/v1.1 document stays valid; the new command is optional.

- **`scene` command:** `{ op:"scene", id, args?, onDone?, onCancel? }` opens
  a game-registered full-screen scene by namespaced id (a PC, journal,
  trading screen, name input). The game supplies a pure `SceneRules`
  reducer (`start`/`step`/`done`, same contract as `BattleRules`) and a UI
  component; the event fiber parks until the scene completes, then runs
  `onDone` (or `onCancel`). A completion can write `ext`, variables,
  switches, item counts, gold, the player name, and (rarely) transfer the
  player. Scenes use the same main-first, parallel-after publication ordering as
  battles (within one tick the session consumes battle requests before scene
  requests), frozen-world
  default (`scene.worldContinues` opts out), save-point exclusion, rewind
  keyframing, and 60/30/20/4 Hz parity; `worldIdle` is false while a scene
  is queued or active. Runtime gains a `pendingScenes` queue that must be
  empty at a save point; the field is runtime-only and is dropped from
  snapshots rather than serialized (older saves without the field load
  fine). The normative schema identity is refreshed as usual.
- **Built-in name input scene** (`rpgkit.nameInput`): a generic MV-style
  name entry, not a byte-for-byte port of MV or Tuxemon. Args `{ variable?,
  maxLength?, default?, title?, charset?, columns?, allowEmpty?,
  swallowCancel? }`; without `variable` the committed name replaces the
  player name, with one it writes that variable. The buffer prefills from
  the live value; an empty commit is refused unless `allowEmpty` is set with
  a variable target. `maxLength` clamps to 1..24 (default 8; Tuxemon uses
  15), a custom `charset` keeps only printable single code units (every
  non-printable code point is dropped — controls, format characters such as
  zero-width/BOM, line/paragraph separators, private-use, unassigned and
  surrogate code units; space separators such as U+00A0 render a cell and
  stay), and
  `swallowCancel: true` swallows the cancel key to match Tuxemon's
  `escape_key_exits=False` (default: cancel closes and runs `onCancel`).
  Held-key repeat is 0.50 s / 0.10 s on the reference clock (Tuxemon
  0.50 s / 0.08 s), identical at 60/30/20/4 Hz for the same virtual time.
  MV's back-key-deletes-char and empty-confirm-restores-default are not
  implemented; Tuxemon's empty player initial and species-name monster
  initial are reached by passing `default`.
## v1 amendment — 2026-09-30 (screen presentation commands)

- `screenFade` independently fades the complete presentation out to an
  optional RGBA colour or back in. Durations are virtual seconds, `wait:true`
  parks only the issuing fiber, and a completed fade-out persists until a
  fade-in clears it.
- `screenTint` tweens one named RGBA overlay. Named layers coexist and compose
  in stable lexical order; reaching alpha zero removes that layer. This keeps
  daylight, weather, and game extensions independent without prescribing
  their policy. `screenFlash` applies a transient colour/intensity overlay,
  and `screenShake` applies a deterministic horizontal triangle wave with
  pixel strength and cycles-per-second speed. Neither uses host time or RNG.
- `camera` scrolls world focus to a tile, player, running event, or named event;
  targeting the player restores live follow. The reducer stores world focus,
  while the renderer clamps against its current resolution before adding
  shake. `balloon` shows a `project.animations` entry over a character, either
  for a finite duration or persistently until cleared by omitting `icon`.
- `screenBackdrop` selects or closes a named `placement:"screen"` layer
  variant. A non-null selection replaces the current backdrop by default.
  The optional `whenModalOpen:"ignore"` policy instead preserves an existing
  backdrop under an active modal, while still replacing when no modal is
  open. Backdrop/tint/flash are below dialogs and independent fade is above
  dialogs. A backdrop
  blocks player movement and action (`worldIdle` is false) while autorun and
  parallel events continue, allowing scripted closure.
- Fade, tint and backdrop survive transfer. With
  `system.transferPresentation:"retain"`, live map animations, fixed camera
  focus and the player's balloon survive too; without that explicit opt-in
  they keep their original per-map lifetime. Flash, shake and event balloons
  are always scoped to the current map visit. All
  state is saveable and rewound by the
  ordinary pure reducer history. Default-frozen battle scenes pause these
  clocks and own the visible frame; `scene.worldContinues:true` keeps them
  advancing in the hidden background. Existing documents and saves omit the
  new commands/state and retain their prior behavior.

## v1 amendment — 2026-10-01 (deterministic audio intent and host assets)

- Projects may map logical audio ids to complete `audio:wav.*` or
  `audio:qoa.*` pak keys through the optional `audio` record. Playback is an
  opt-in presentation adapter; projects without it keep the same reducer and
  bundle behavior, and unsupported hosts degrade to silence.
- `playBgm`, `fadeoutBgm`, `stopBgm`, `pauseBgm`, `resumeBgm`, `playBgs`,
  `fadeoutBgs`, `playMe`, `playSe`, `saveBgm`, and `replayBgm` add persistent
  BGM/BGS/ME state and ordered sound cues. Audio positions, fades, authored ME
  durations, save/restore, and rewind use the fixed 60 Hz reference clock.
- WAV and QOA use the same playback semantics. QOA is decoded incrementally
  as host ring credit becomes available; the build helper deterministically
  encodes interleaved signed 16-bit PCM using the mono/stereo sample formats
  accepted by PocketJS.

## v1 amendment — 2026-10-01 (choice row icons)

- Each `choices` option may carry an optional `icon`
  (`{ sprite, dir?, frame? }`): one frame of a `project.sprites` entry drawn
  left of the option label. `sprite` is a non-empty `project.sprites` key;
  `dir` (`down` | `left` | `right` | `up`, default `down`) and `frame`
  (`0` idle, the default; `1` left step; `2` right step) pick the walker
  pose, and a static `kind: "image"` sprite ignores both. No other keys are
  allowed.
- Render-only: the reducer copies the icons into the open choices modal
  (`ChoiceModal.icons`, one entry per option, `null` on rows without an
  icon) and never reads them, so selection, branching, saves and replays
  are unchanged. A box with no icons builds exactly the modal and compiled
  program it did before (no `icons` key at all). Extension choices never
  carry icons.
- `rpgkit-check` reports an `icon.sprite` that is not in `project.sprites`
  as `lint/sprite-missing` (error), located at the option
  (`commandPath: [..., "options", i, "icon"]`).
- Every existing document stays valid and renders identically. The schema
  identity changed; the change is additive, so existing sharded shells and
  their saves keep loading without a rebuild (see
  [Schema identities](#schema-identities)).

## v1 amendment — 2026-10-01 (loops, Event Touch, variable text tokens)

- New commands `loop` (`{ op: "loop", commands: Command[] }`) and `break`
  (`{ op: "break" }`). `break` leaves the innermost enclosing loop from any
  depth of `if`, `choices`, `battle` and `scene` blocks inside its body; it
  does not cross a `common` call; outside any loop it ends the current page
  or common event (RPG Maker Break Loop). A loop pass that never waits
  yields its fiber to the next tick once the fiber has taken 1,000
  interpreter steps in a tick, so a loop never records the runaway error.
  Compiled programs gain the `repeat` (loop back-edge) and `break`
  instructions, which saves taken inside a loop carry; the result-branch
  completion transfer a session appends after a battle or scene carries
  `completion: true`. Older runtimes refuse saves holding either.
- New page trigger `eventTouch` (RPG Maker Event Touch). On a
  `blocks: true` page it fires when a player step (d-pad, player move route,
  path step) is refused by the event's body, or the event's own step
  (route, path, approach or random movement) is refused by the player's
  body; terrain that would refuse the step anyway is no contact. On a
  non-blocking page it fires on entry exactly like `playerTouch`. Contacts
  start the page in the same reference tick, in event-id order with the
  other blocking triggers, under the `playerTouch` gates. They are not
  latched (a held direction re-fires after the page ends) and are never
  saved. `playerTouch` is unchanged.
- New optional `system.textVariables`: text lines, `choices` prompts and
  rows and `extChoice` prompts expand `{v:<id>}` to variable `id`'s value
  (`0` when unset), in one pass with `{name}`, once when the box opens.
  Without the option the braces show verbatim, as before.
- Every existing document stays valid and behaves identically. The schema
  identity changed; the change is additive, so existing sharded shells and
  their saves keep loading (see [Schema identities](#schema-identities)).

## v1 amendment — 2026-10-01 (compatible schema identities)

- Sharded shells and saves that name a listed earlier schema identity
  (`MAP_SCHEMA_COMPATIBLE_HASHES`) load in the runtime and the editor instead
  of being refused. Only identities at or after the most recent breaking
  change are listed (today that is the single previous identity); older
  shells and saves are refused. Saves taken after loading are
  stamped with the current identity, and the manifest binding is unchanged.
  The rules and the full list are under
  [Schema identities](#schema-identities).

## v1 runtime fix — 2026-10-01 (same-tick `place` and move routes)

No format change. Behavior fix in the session fold:

- `place` and the `moveRoute` / `moveControl` requests published on the same
  reference tick now apply in command order. Previously every route was
  installed first and every `place` applied afterwards, so a `place`
  followed on the same tick by a route or a turn for the same character
  (event or player) discarded that route and resumed its waiter at once.
  A `place` still stops a route that was running or was queued before it.
- A route, turn, control, or `place` aimed at an event whose page the same
  tick switched on (a fiber sets the variable that enables an NPC's page,
  places it, and routes it) is applied on that new page; previously the
  next tick's page sync tore the route down. Requests published before the
  page flip keep the reset-on-page-switch rule.
- Projects that never publish a `place` together with a route for the same
  character on one tick are unaffected: Sunstone, Meadow, Grow, Wander, and
  the showcase reproduce their previous character and movement states.
  Content that does, such as an imported cutscene that spawns an NPC and
  walks it in, now plays the walk, so recorded journeys and tapes covering
  such scenes need to be re-recorded.
- The schema identity is unchanged. The fix applies to every accepted
  identity alike, so `MAP_SCHEMA_COMPATIBLE_HASHES` is unaffected.

## v1 amendment — 2026-10-01 (saves keep the current map's characters)

- Save snapshots gain the optional `mapRuntime`: the current map's character
  table (cells, facing, step in progress, running and patrol move routes with
  their progress and any path search in flight, the wander RNG), a move route
  running on the player and a fade-in after a transfer. A load continues
  frame for frame like the game that never stopped. The envelope stays
  `rpgkit-save/v1`: saves without the field load as before (characters start
  again from the map on the next tick). An older runtime ignores the field
  on any save its own checks accept; it refuses a save whose parallel event
  is waiting on a move route (see below).
- A parallel event waiting on a move route can now be saved and loaded: its
  route travels with the save and resumes it. Without the route (an older
  save) such a fiber is still refused.
- Save codes are DEFLATE-compressed by default (`z1` prefix); uncompressed
  codes still decode and `encodeSaveCode(..., { compress: false })` still
  writes them. Older runtimes read only the uncompressed form.
- Loads check the saved characters' motion fields together: a character at
  rest sits on its tile, one mid-step lies between its tile and the next
  along its step direction at a speed the runtime can produce, and the step
  lands inside the map. Save codes longer than a 16 MiB envelope can encode
  to, envelope text over 16 MiB in UTF-8 bytes (non-ASCII characters count
  their full encoded width) and data nested deeper than 128 levels are
  refused before parsing; every decode failure is a typed `SaveError`.
- The project format and `schema.json` are unchanged, so the schema identity
  (`MAP_SCHEMA_HASH`) is unchanged and no row is added to
  [Schema identities](#schema-identities).

## v1 amendment — 2026-10-02 (rewind keyframe contract corrected)

- The 2026-09-30 "bounded rewind keyframes" note named an 8 MiB default
  payload cap and no count cap. The shipped contract is a 2 MiB
  `keyframeMaxBytes` default and a `keyframeMaxCount` default of 64; the
  oldest keyframes are evicted first under either limit, and zero bytes or
  zero count disables keyframes for the from-frame-zero fallback.
- `DemoOptions.rewind` forwards only `rewindSeconds`,
  `keyframeIntervalFrames`, `keyframeMaxBytes` and `keyframeMaxCount`;
  arrays and unknown keys are rejected, and `GameView` forwards those four
  fields explicitly, so a rewind record cannot overwrite the trusted host
  options (`hz`, `maps`, `immutableState`, ...).
- With `immutableState`, a keyframe keeps the published state itself and
  consecutive keyframes share the subtrees the reducer did not rebuild, so
  the retained heap is far below the byte estimate. The repository rollback
  checkpoint is created lazily and reused, and resyncs its heavy references
  after a successful fold so an evicted keyframe generation is not kept
  alive by a stale rollback snapshot.
- The project format and `schema.json` are unchanged.

## v1 amendment — 2026-10-03 (frozen snapshot of the map a seamless handoff left)

- `SessionState` gains the sparse `leftMap`: on the tick a `seamless-v1`
  handoff commits, the session records the characters of the map it leaves
  as the actor pool painted them (pixel position, facing, walk pose,
  effective sprite and opacity; erased and invisible characters are left
  out) plus that map's rectangle in the new map's tile space. The connected
  world renderer paints it instead of that map's map-entry preview. It is
  presentation only: no collision, trigger or condition reads it.
- Every other map entry removes it (an ordinary transfer with or without
  fade, and the next seamless commit, including one back into that map,
  which records the map it leaves instead), and so does the player standing more than
  `LEFT_MAP_RING_TILES` (64) tiles from that map's rectangle, checked on
  every reference tick. Projects that never commit a seamless handoff never
  hold the field, so their states, saves and checksums are unchanged.
- Save snapshots carry it as the optional `mapRuntime.leftMap`, validated on
  load (a non-empty map id other than the save's map, integer origin,
  positive size, and per character an event id, finite pixels, facing 0..3,
  walk pose 0..2, a sprite key and an integer opacity 0..255). A save
  without it loads as before and shows that map's map-entry preview. The
  envelope stays `rpgkit-save/v1`; an older runtime ignores the field.
- `sessionStateFingerprint` leaves it out, like character positions.
- The project format and `schema.json` are unchanged, so the schema identity
  (`MAP_SCHEMA_HASH`) is unchanged and no row is added to
  [Schema identities](#schema-identities).

## v1 amendment — 2026-10-04 (text box layout)

- The `text` command gains four optional fields: `position` (`top`,
  `center`, `bottom`, `topLeft`, `topRight`, `bottomLeft`, `bottomRight`,
  `left`, `right`), `align` (`left`, `center`, `right`), `valign` (`top`,
  `center`, `bottom`) and `background` (`window`, `dim`, `transparent`).
  Absent, each means the box every earlier text drew (bottom, left, top,
  window), so the change is additive: the previous identity stays loadable.
- The compiled `text` instruction and the open text modal carry the
  non-default fields as an optional `box`; a text without layout (or with
  every default spelled out) carries none, so its states, saves and
  checksums are unchanged. A saved instruction's `box` is validated on load
  (a non-empty record of the fields above with their values).
- `TextPaginator` receives the layout as an optional second argument; a
  corner or side box is narrower, so its pages are cut at its own width.

## v1 amendment — 2026-10-04 (autosave resumability boundary)

- An automatic save now accepts every state the existing v1 payload can
  resume, including an open text/choices/shop modal with its owning fiber,
  other running fibers, movement in progress and waited move routes. The
  modal owner and parked instruction/route still pass structural validation
  when the envelope is loaded.
- A request made during state v1 omits or cannot resume—an active battle/game
  scene, seamless handoff, fade-out, fatal interpreter state, or an
  unconsumed transfer/battle/scene request—is retained until the first
  resumable reference tick. Further requests coalesce and the host receives
  one snapshot. Snapshot encoding or validation failure remains pending and
  cannot throw through the reducer.
- The pending bit belongs to the live session and is not serialized. Manual
  saves return `not-safe-point` while it is present, so it cannot be lost
  across a save/load boundary. Hostless and rewind/refold execution performs
  no host write.
- The project format and `schema.json` are unchanged, so the schema identity
  (`MAP_SCHEMA_HASH`) is unchanged and no row is added to
  [Schema identities](#schema-identities).

## v1 amendment — 2026-10-09 (capability-gated seamless openings)

- A `worldLayout` opening may name an optional non-empty
  `movementCapability`. The name comes only from the validated immutable
  opening; transfer commands cannot supply or override it.
- `SessionOptions.handoffCapability` is a pure game callback over that name
  and the live session state. When it returns true, a proven seamless
  crossing may ignore the target cell's cooked solid-terrain bit. Map bounds,
  the authored source exit edge, target entry edge, blocking event bodies,
  opening geometry, dimensions and topology identity remain mandatory.
  `GameView` and `AttractController` forward the same callback so live play,
  playback and rewind/refold use one rule.
- The field and callback are both optional. Older documents have no
  capability and therefore retain the complete pre-existing passage check;
  the outgoing schema identity remains compatible.

Breaking changes to any of the above require a new marker
(`rpgkit-project/v2`) and a new entry here.
