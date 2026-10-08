# rpgkit engine

Pure-TS simulation core for Pocket RPG Kit. Every module here is a plain
reducer: no host imports, no wall clock, no `Math.random`. The host folds
`step(state, input) -> state` once per virtual frame and renders from
state.

## Modules

- `camera.ts` — free-scroll camera reducer, the follow camera, and the BTN
  mask mirror.
- `screen.ts` — sparse deterministic fade, named tint, flash, shake, scripted
  camera, character-balloon, and full-screen backdrop presentation state.
- `audio.ts` — sparse, saveable BGM/BGS/ME intent, fixed-reference-tick
  playback/fade clocks, and MV-style saved-BGM state. PCM and host handles
  deliberately stay outside the reducer.
- `viewport.ts` — centering offset for maps smaller than the host viewport.
- `start.ts` — camera placement derived from a project's start tile.
- `tiles.ts` — tile ids and the baked-chunk constants.
- `motion-clock.ts` — the fixed 60 Hz motion reference and how many
  reference ticks one host frame folds.
- `passability.ts`, `movement.ts` — tile collision (undirected `dirBlock`
  plus one-sided `dirEdges`, cooked into flat solid/edge masks with
  blocking bodies) and the grid mover.
- `pathfind.ts` — deterministic 4-neighbour BFS behind the `pathTo` /
  `approach` move steps (fixed neighbour order, respects all edge guards
  and bodies; the search is sliced across reference ticks to bound QuickJS
  frame cost).
- `interpreter.ts` — event pages, triggers, the 46-command interpreter
  (the v1 15 plus `lockInput` / `unlockInput` / `place` / `shop` / `ext` /
  `extChoice` / `battle` / `moveControl` / `appearance` / `layer` /
  `tileProperty` / `mapAnim` / `stopAnim` and seven screen-presentation
  commands), the typewriter clock, the seeded RNG, saveable switch state.
- `extensions.ts` — namespaced pure command/condition/dynamic-choice handlers,
  the opaque JSON extension slot, validation and save codecs.
- `battle.ts` — game-owned battle reducer and scene contracts.
- `chars.ts` — per-map character motion: page patrol routes, autonomous
  random/approach, command-forced routes, body collision (only
  `blocks: true` pages stop a character, as they stop the player).
- `session.ts` — the multi-map fold: transfer (map swap + fade), moveRoute
  completion and battle-scene lifecycle across mover/characters/interpreter.
- `state-metadata.ts` — bounded, frame-scoped identity metadata used by the
  opt-in immutable-state fast path; it never enters saves or replay hashes.
- `clone.ts` — host-portable deep copy (the desktop QuickJS realm has no
  `structuredClone`).
- `schema-validate.ts` — zero-dependency checker for the JSON schema
  subset `../data/schema.json` uses.
- `save.ts`, `save-validate.ts`, `save-restore.ts`, `save-menu.ts` —
  save envelope/codecs (snapshots include the current map's character
  table, player route and fade-in), structural validation, the map-aware
  restore gate with the structured `saveSession`/`loadSession`, and the
  save-menu navigation reducer.
- `deflate.ts` — raw DEFLATE for compressed save codes; no imports, built
  lazily so bundles that never decode a code drop it.
- `utf8.ts` — UTF-8 byte counting for size budgets (save envelope text,
  preview protocol strings); stops just past the budget.
- `attract.ts`, `tape.ts` — the attract/takeover/rewind controller over
  one unified u16 input stream, bounded runtime keyframes, and RLE/devtools
  tape helpers.
- `journey-search.ts` — A* over real reducer frames, for deterministic
  journey drivers on hosts whose frame spans several reference ticks.
- `types.ts` — the `rpgkit-project/v1` vocabulary (normative schema:
  `../data/schema.json`).

## P1② ↔ P1③ integration contract

The interpreter does not move the player. The host owns a mover (P1②'s
`stepMovement`) and feeds the interpreter the player's tile each frame.

```ts
import {
  createWorld, createInterpState, stepInterp, isBusy, messageHoldsPlayer,
  continueExternal, type InterpInput, type World, type InterpState,
} from "./interpreter.ts";

const world: World = createWorld(map, project.commonEvents ?? [], hz, {
  messageBlocksPlayer: project.system?.messageBlocksPlayer,
});
let interp = createInterpState();

// each virtual frame, AFTER the mover has run:
if (!isBusy(interp) && !messageHoldsPlayer(world, interp)) {
  // mover runs only while no blocking fiber owns the session (an open
  // dialog, a choices box, a wait, an autorun) and, when the project opts
  // in, no parallel page's box is open either.
  movement = stepMovement(movement, buttons, passageTable);
}
const input: InterpInput = {
  confirmEdge, cancelEdge, upEdge, downEdge,   // pressed-this-frame edges
  playerCell: { x: tileX, y: tileY },          // mover cell this frame
  prevCell: { x: prevTileX, y: prevTileY },    // mover cell last frame
  facing,                                      // 0 down, 1 left, 2 up, 3 right
};
interp = stepInterp(world, interp, input);

// P1④ hooks: when a fiber parks on a transfer or a waiting move route, the
// result carries exactly one pending* payload; perform the work, then resume:
if (interp.pendingTransfer) { /* swap map, move player; fade frames */ }
if (interp.pendingMoveRoute) { /* walk the route steps */ }
interp = continueExternal(interp, fiberKey);
```

Conventions:

- `facing` is the `Facing` index both the camera and mover emit:
  0 down, 1 left, 2 up, 3 right. Action-button events trigger on the event
  one tile **in front** of `playerCell` on that facing.
- **Event areas:** an event with `w`/`h` occupies a rectangle from
  `(x,y)` (default 1×1). `playerTouch` fires on the frame the player's
  cell **enters** any cell of that rectangle — stepping from one area cell
  to another re-fires; standing still never does, and leaving clears the
  latch. `action` fires when the faced tile or the player's own tile is
  inside the rectangle.
- **Event Touch (`eventTouch`, RPG Maker MV parity):** a *contact* is (a) a
  player step refused because this event's character body holds the
  target cell — the d-pad mover, or a player move route / pathTo /
  approach step — or (b) this event's own step (route, path, approach
  movement, random step) refused because the player's body holds the
  target cell. Only the body counts: a wall or dirBlock edge that would
  refuse the step anyway is no contact, and a `through` mover never makes
  one. Contacts are detected in the movement phase of a reference tick
  (mover, then characters, then the player route) and passed as
  `InterpInput.touchContacts`; the interpreter phase of the **same** tick
  starts the page. Any `eventTouch` page of a contacting event fires on a
  contact; a non-blocking (`blocks` not true) page additionally fires on
  entry exactly like `playerTouch` (same per-cell latch, same facing turn
  edge). Gates are playerTouch's: no running main fiber and no box
  holding the player. Contacts join the event-id-ordered scan with every
  other blocking trigger, so the first qualifying page starts the single
  main fiber. Contacts are not latched: a direction held into a blocking
  eventTouch NPC bumps again — and re-fires — once its page's fiber ends.
  `playerTouch` is unchanged (a blocking playerTouch page never fires on a
  bump). Contacts are per-tick input, never state, so saves are unaffected;
  `createWorld` sets `World.hasEventTouch` and the session skips detection
  on maps without an eventTouch page. Wander exits (`control: wander`) are
  filtered, not attempted, so they make no contact.
- **Compound and facing conditions:** a page condition's
  `all: Condition[]` is an AND of the same conditions `if` accepts
  (including a switch demanded OFF and a `{kind:"facing", dir}` test); it
  ANDs with the flat condition fields. A `playerTouch` page whose `all`
  reads facing also fires on a **turn in place** (`prevFacing !== facing`)
  while the player stands in its area, so an exit mat gated on "facing
  up" does not open when crossed sideways. Character synchronization,
  parallel-fiber cancellation, trigger arbitration, and the UI all select
  pages against the same live facing.
- **World-idle conditions:** `{kind:"worldIdle", negate?}` is shared by
  `condition.all` and `if`. It is true only when the current map has no
  blocking main fiber, `inputLocked`, modal, fatal error, player route,
  pending transfer/battle, fade, active scene, or host-owned menu. A
  PARALLEL fiber or NPC route alone does not remove player control and does
  not block it. The value is derived at each read and is absent from saves.
  Trigger/page selection samples it before fibers run; an `if` instruction
  recomputes it from the live working state, so later fibers see locks,
  modals and external requests published earlier in that same tick.
- **Live player movement conditions:** `{kind:"playerMoving", negate?}` is
  shared by `condition.all` and `if`. It reads whether a tile step was
  already interpolating at the start of this reference tick. Sampling before
  the movement fold means the press that commits a new step is still false,
  while the tick that lands an existing step remains true. The value is
  derived, never saved, and maps without this condition do not build or pass
  its context.
- **Per-visit locals:** a switch or variable id prefixed `local.`
  is reset on every map entry; it never survives a transfer.
- **Runtime appearance:** `appearance` changes the effective player/event
  walking sprite, 0..255 opacity, or visibility. Player state is project-wide
  and saveable; `saveDefault:true` replaces its reset baseline. Event state is
  tied to the issuing page and is removed on page change. The matching
  condition compares the effective sprite key.
- **Runtime visual layers:** `layer` stores a named layer's visibility and/or
  prepackaged variant for this map visit. The UI resolves those names through
  immutable `GameAssets.layers`; every transfer clears the selections.
- **Runtime tile properties:** `tileProperty` sparsely replaces one cell's
  passage and entry/exit masks. `sessionPassageTable()` derives and caches the
  collision table by reducer-record identity, so player, NPC and pathfinding
  agree without mutating `Session.tables`. Standalone interpreter/mover hosts
  should call `withTilePropertyOverrides(authored, interp.tileProperties)`.
  The corresponding condition compares explicit override fields; `null`
  means that field is absent.
- **Place and initial facing:** the `place` command relocates the player,
  `"this"`, or `{event}` to a tile (and optional facing); a page `dir` sets
  the facing the character shows when that page spawns it or on a page
  switch. Routes and turns published after a `place` on the same tick are
  kept (see the session fold's same-tick order below).
- **Movement controls:** page defaults are `moveSpeed:5` (MV grade 1-6),
  `moveFrequency:5` (MV grade 1-5 on the fixed reference-tick clock),
  `directionFix:false`, `through:false`, and
  `facingMode:"followMovement"`. A `moveControl` command targets the player,
  `"this"`, or `{event}`; a `{control: MoveControl}` route step applies the
  same change to its route actor. Controls select bounded random `wander`,
  page/static/approach autonomous motion, `stop`, speed, run, frequency,
  direction fix, through, or facing mode. `run` raises the effective speed
  grade by one, capped at 6. Frequency grade `n` waits `30 × (5 - n)`
  reference ticks between autonomous decisions. A `wander` control may carry
  `intervalTicks` instead for a positive reference-tick interval; it takes
  precedence over the frequency grade. NPCs run that clock continuously;
  player wander retains its existing pause-while-held clock.
- **Control lifetime and priority:** settings and `stop` persist for the map
  visit and round-trip through saves. An NPC page switch clears all of that
  actor's overrides; a map transfer clears both player and NPC overrides.
  Forced routes win over a runtime autonomous override, which wins over page
  patrol, which wins over page autonomous motion. `stop` cancels the active
  route and suppresses page patrol until another route or motion-mode control;
  `moveType:"static"` is the explicit way to stop wandering.
- **Control collision and facing:** `through` ignores terrain and body
  collision but not map bounds; player-touch checks still observe the
  resulting steps. `directionFix` blocks all facing changes. Both `locked`
  and `scripted` use the Tuxemon behavior of blocking movement-driven turns
  while allowing an explicit face step; `followMovement` turns with a step.
- **Wander holds:** player wander makes `worldIdle` false, while NPC wander
  does not. Input lock or any dialog pauses player wander. Runtime NPC wander
  makes no new step while a dialog is open or while the player is cardinally
  adjacent and facing that NPC, independently of `system.messageBlocksPlayer`.
  Its attempt clock still advances through those holds, committed movement,
  forced routes and blocked attempts; skipped attempts consume no RNG.
- **Input lock:** `lockInput`/`unlockInput` are a cross-event lock:
  while held the mover ignores the d-pad and confirm starts no action
  event, but `autorun`/`parallel` fibers still fold. The lock is per map
  visit and its held state round-trips through a save.
- **Message hold:** `createWorld(..., { messageBlocksPlayer: true })`
  (from `project.system.messageBlocksPlayer`) makes any open text/choices
  box hold the player, a PARALLEL page's included:
  `messageHoldsPlayer(world, state)` is then true, the mover must not run,
  and the trigger scan starts no action, playerTouch or eventTouch page, so the
  confirm that advances the box never also starts the faced event.
  `autorun`/`parallel` pages keep running. Off by default (v1).
- **Screen presentation:** `screenFade`, `screenTint`, `screenFlash`,
  `screenShake`, `camera`, `scrollMap`, `balloon`, `screenBackdrop`, and the
  numbered-picture commands write sparse state in `InterpState.screen`. All
  durations are authored in virtual seconds and compile to the fixed 60 Hz
  reference clock; optional `wait:true` parks only the issuing fiber. A
  completed fade-out stays opaque until a fade-in;
  tint layers are keyed by stable game-chosen ids and composited in sorted-id
  order, so daylight/weather/custom layers can be driven independently.
  Flash decays to transparent. Shake is a deterministic horizontal triangle
  wave (no RNG) applied after viewport clamp to the world plane only.
- **Camera and balloons:** camera targets are an absolute tile, the player,
  `"this"`, or `{event:id}`. The reducer stores resolution-independent world
  focus; `GameView` clamps it for the live viewport. Targeting the player
  returns smoothly to live follow. A balloon targets the same character forms
  and names a `project.animations` entry; it loops above the live character
  anchor for a finite duration or until a command with no `icon` clears it.
  A waited balloon must name an icon and a positive finite duration.
- **Relative map scroll:** `scrollMap` starts from the current player/fixed
  focus and moves by `distance` tiles. Speed grade `n` takes
  `distance × 256 / 2^n` reference ticks, matching MV/MZ; projection uses the
  existing viewport clamp. A zero distance is an immediate no-op and does not
  replace player follow with a fixed camera. Its endpoint remains a fixed
  camera. A subsequent `{op:"camera", target:"player"}` returns to live
  follow.
- **Numbered pictures:** ids 1..100 are sparse and paint in numeric order.
  Coordinates may be literals or variables sampled at command execution.
  A coordinate variable that does not hold a finite number is a fatal content
  error rather than RPG Maker's implicit zero, following the kit's strict
  operand contract.
  Move/tint tween state, easing, continuous rotation, origin, scale, opacity,
  retained blend intent and tone all save and rewind; pictures survive map
  transfer. The PocketJS view currently renders blend as normal source-over
  and uses a deterministic overlay approximation for RPG Maker tone because
  the host has no portable per-image blend/colour-matrix primitive.
- **Backdrop, layering, and lifetime:** `screenBackdrop` selects a
  `GameAssets.layers` entry with `placement:"screen"`; omitting/nulling its
  variant closes it. Backdrop, tint, and flash render over the map but below
  dialogs; independent fade renders above dialogs. A backdrop prevents free
  movement/action and keeps `worldIdle` false, while autorun/parallel fibers
  still run. Transfer retains fade, tints, and backdrop, but clears transient
  flash/shake, scripted camera, and balloons. Default-frozen battles pause all
  screen-effect clocks and hide the map presentation; `worldContinues:true`
  advances it behind the battle scene.
- **Audio state:** `playBgm`, `fadeoutBgm`, `stopBgm`, `pauseBgm`,
  `resumeBgm`, `playBgs`, `fadeoutBgs`, `playMe`, `playSe`, `saveBgm`, and
  `replayBgm` write sparse `InterpState.audio`. BGM/BGS/ME position and fade
  counters advance on the fixed 60 Hz reference clock. ME suspends BGM until
  its authored duration ends; BGS continues independently. `{kind:
  "bgmPlaying", id?, negate?}` is false while BGM is paused or suspended by
  ME. Persistent audio intent round-trips through saves and attract rewind;
  SE remains an ordered, one-tick cue and never enters a save. A game may
  return `BattleStart.audio` to suspend that complete state, play one battle
  BGM (or silence), and restore the exact map mix in the completion fold;
  omitting it preserves the legacy continue-through behavior.
- **Persistence:** in-flight tween endpoints and remaining reference ticks,
  camera focus, balloon frame age, numbered pictures, map-name banner phase,
  and persistent layers all round-trip in saves and attract rewind. Older
  saves omit `screen` and retain the zero-cost path: `session.ts` skips screen
  advancement entirely while it is absent.
- **Global timer:** `timer start` installs one fixed-60-Hz countdown,
  `timer read` writes floored whole seconds, and `timer stop` removes it. It
  keeps advancing during transfer fades, fatal interpreter state and a
  default-frozen battle/game scene. A timer guard is false when stopped and
  can observe the retained running `00:00` state after expiry. RPG Maker's
  battle-abort `onExpire` hook is deliberately not implicit; an event guard
  or game extension chooses the consequence. Its HUD, numbered pictures and
  map-name banner paint only when a game passes the explicit
  `pocket-rpgkit/ui/krm2` presentation to `GameView`; reducer-only projects
  carry no KRM2 presentation nodes.
- **Number input and host lifecycle:** `inputNumber` compiles to the explicit
  `rpgkit.numberInput` scene and therefore requires games to register both
  `numberInputRules` and `NumberInputScene`; it never registers UI through the
  base session or `GameView`. `openMenu`, `openSave`, `gameOver` and
  `returnTitle` emit ordered one-frame `hostActions`; `GameView` dispatches
  them to optional callbacks after the reducer frame, and absent callbacks do
  nothing. Unlike RPG Maker 351/352, menu/save requests do not park their
  event fiber; the game-owned host screen must provide any pause. Host actions
  are drained before a save and never enter snapshot or
  replay hashes. `autosave` instead advances its fiber and yields at a
  reference-tick boundary. If v1 can resume the whole reducer state, its effect
  carries that tick's normalized snapshot directly to `hostActions.autosave`.
  Open text/choices/shop modals, running fibers, movement and waited routes are
  resumable. Active battle/game scenes, seamless handoffs, fade-out, fatal
  interpreter state and unconsumed transfer/battle/scene requests are not: the
  sparse session request stays pending, further autosaves coalesce, and one
  effect is published at the first resumable reference tick. The pending bit is
  not save data; manual save returns `not-safe-point` until it clears. Attract
  forward folds preserve the effect, while rewind/refold and a hostless session
  perform no write. The selected reference tick and bytes agree at 20/30/60 Hz.
  Manual saves keep their tile-boundary gate. Autosave is independent of the
  player-facing `saveAccess` flag.
- **Names and map banners:** `changeName` writes the saved player name used by
  later `{name}` expansion. `system.mapNameDisplay:true` seeds a persistent
  flag; each map entry starts a saved 180-tick banner from `MapDef.name`.
  `mapNameDisplay:false` clears the flag and dismisses the current banner.
- `isBusy(state)` is true while a blocking (action / playerTouch / eventTouch / autorun)
  fiber runs. The mover freezes for its whole duration. PARALLEL pages run
  concurrently and never set busy (only the message hold above can make
  their box hold the player).
- Edges are one frame wide: the host computes `pressed = buttons & ~prev`
  for CIRCLE (confirm), CROSS (cancel), UP and DOWN and passes booleans.
- `state.cues` lists sound effects emitted by commands on the latest step;
  drain it after every step (it is cleared at the top of the next one). A
  session whose project declares `audio` preserves all reference-tick cues
  when a low-Hz host frame folds several ticks; projects without that table
  retain the original last-tick-only fold and dormant allocation path.
- All switch/variable/item/gold values and the mulberry32 RNG cursor live
  in `state.sw`, a plain JSON-serializable object: the P1⑤ save snapshot.
- **Invariant: every write into `state.sw`'s numeric banks (`gold`,
  `items`, `shopStock`, `variables`, and the project's `initialGold` seed)
  goes through `clampFiniteVar`.** JSON Schema's `integer` only rejects a
  fractional part, so an authored value like `1e308` (a legal double with
  none) passes schema validation while landing far outside a safe integer;
  unclamped arithmetic on it (a shop sale, `gold add`, `1e308 * 1e308`, …)
  can overflow to `Infinity`, which `JSON.stringify` turns into `null` and
  the save loader then refuses to read back. Any future numeric write
  into `state.sw` — battle rewards, an `ext` command's bank, anything else
  that must survive a save round-trip — must clamp through the same
  function instead of writing raw arithmetic. This covers every entry
  point, not just authored commands: `createSwitchState`'s public
  constructor normalizes a hand-built bank the same way, and both
  `createInterpState` (fresh session) and `save-restore.ts`'s
  `restoreSessionSnapshot` (loaded save) route through it; an extension
  command's `result.writes` and a `BattleCompletion.writes` numeric entry
  clamp on their way into `state.sw.variables` too. `cloneInterp` itself
  stays a plain field copy — it also runs on every live step, where a
  content-error check (e.g. `resolveTransfer`'s non-integer coordinate
  guard) must still see an out-of-range value a bug introduced mid-frame,
  not have it silently floored away first. `save-validate.ts` backs the
  restore path up structurally: a decoded envelope whose
  `gold`/`items`/`shopStock`/numeric `variables` entries are not
  `Number.isSafeInteger` is refused with a typed `SaveError` before
  `restoreSessionSnapshot` ever runs, so a hand-crafted file cannot
  reintroduce a value normal play can no longer produce.

## Event Touch, loops and text tokens

### Event Touch

The trigger's contract is the **Event Touch** bullet under the conventions
above: contacts come from the movement phase of a reference tick and start
the page in the same tick's trigger scan, in event-id order with the other
blocking triggers.

### Loops and labels

`compile` lowers `loop` inline: the body, then a `repeat` back-edge to the
body's first instruction (the only backward jump the bytecode has). A
`break` in the same program frame as its loop is a forward `jmp` to the
loop end. A `break` inside a branch program (a `choices` option or cancel,
a `battle` result, a `scene` result: each runs as its own stack frame) is
`{ op: "break", up, to }`: pop `up` frames, then set the loop frame's pc to
`to`. A `break` outside any loop is `{ up: depth, to: null }`, which ends the
page or common-event body. Common events compile on their own, so a
`break` never crosses a `common` call. When a `break` leaves a battle or
scene result branch, the completion transfer hung on that frame (its
`onDone` queue) still runs: the popped frames' completions are collected,
innermost first, and fired in order — a branch parked at its program's
end because its last command pushed a child frame is collected all the
same. See Labels below for the cross-map and `exit`/`erase` boundaries.

At a `repeat` the fiber yields to the next tick, staying in `run` mode at
the loop start, once it has taken `LOOP_YIELD_STEPS` (1,000) steps in this
tick or the shared `RUNAWAY_STEP_LIMIT` budget is down to that many. A loop
alone therefore never records the runaway error. Programs without a loop
pay nothing: the check runs only at a `repeat`. `save-validate.ts` accepts
`repeat` only as a backward (or self) jump and checks `break`'s shape; the
runtime refuses a `break` that would pop past the fiber's stack.

Labels and jump-to-label (RPG Maker 118/119) are supported. A `label` is a
no-op position marker; a `jumpLabel` continues at the first label with that
name anywhere in the same page or common event, at any nesting depth. The
label table is built per compiled program and cached. A jump whose target
sits in an ancestor frame pops the frames above it; a jump into a branch
program not on the stack pushes the frames to enter it, so the branch runs
from the label and completes normally. Either way, a jump that leaves a
battle/scene result branch keeps that branch's completion transfer: it
hangs on the frame as an ordered `onDone` queue, and a jump that pops the
frame relocates the queue to the landing frame (ahead of any completion
it already carries), so completions fire innermost first however the
branch is left — a branch parked at its program's end because its last
command pushed a child frame is collected all the same (a frame that
already fired a completion is parked in external mode, which a jump
never pops). Two boundaries apply. First, a cross-map transfer rebuilds
the interpreter for the new map: the old map's fibers end, so any
completions still queued on them are discarded — of nested cross-map
completions only the innermost takes effect (unlike RPG Maker MV, whose
interpreter keeps running across a map swap). Second, `exit` or `erase`
inside a result branch ends the whole event, abandoning the queued
completion with the fiber. A jump to a name with no label does nothing
(MV parity). Common events are their own label scope (MV's child interpreter):
a jump inside one never sees the caller's labels, and vice versa. A
backward jump that never reaches a label again is bounded by the same
per-frame step budget as loops. The `unit` frame marker that names a scope
root is a plain enumerable frame property, saved and restored like the rest
of the frame; a save taken before the field existed is rebuilt on restore
(the bottom frame is the page root, a `common` call's frame is its own
scope), so a jumpLabel after resume resolves in the same scope it would
have when the save was taken.

### Text tokens

`player-name.ts` expands `{name}` and, when `World.textVariables` is set
from `project.system.textVariables`, `{v:<id>}` in one left-to-right pass
that never rescans its output. A world whose project declares
`system.textTokens` (the key allowlist) may also carry a `textTokens`
resolver (from `SessionOptions.textTokens`): `{x:<key>}` then expands to
the resolver's answer for `key`, handed a read-only view of the state at
box open (player name, variables, gold, map id, and a frozen snapshot of
the game's own `ext` state, built only if the resolver reads it). The
declaration is the explicit opt-in: a world without it takes the pre-`{x:}`
path and the braces print verbatim. The resolver must be a pure function of
that view — the expanded strings enter the modal and have to survive
saves, rewind and rate changes. An unanswered token (no resolver, or
`undefined`) shows `???`. The interpreter expands a text box's lines and a
choice box's prompt and rows once, when the box opens; while it stays up
the modal keeps those strings, so the typewriter total, the reveal and the
dialog's wrapping all work on the expanded text. An `extChoice` prompt is
expanded once too, when its box opens: while the box stays up the modal
keeps that prompt and only the extension's dynamic rows, keys and enabled
flags refresh, so the resolver runs once per open, not per tick. A line
with no `{x:}`, a session with no resolver and a project without the
declaration all take the pre-`{x:}` path, so games that never use the
token pay nothing.

## P1④ session (multi-map) fold

For a multi-map game the host does not drive the mover and interpreter by
hand; `session.ts` folds all three reducers per virtual frame:

```ts
import { createSession, startSession, stepSession } from "./session.ts";

const session = createSession(project);        // maps, worlds, passage tables
let state = startSession(project, session);    // project.start position/dir
state = stepSession(session, state, {          // once per virtual frame
  buttons, confirmEdge, cancelEdge, upEdge, downEdge,
});
```

`stepSession` owns the frame order:

1. **characters.syncPages** — reconcile NPCs with active pages; a page
   switch aborts a forced route and resumes its parked waiter.
2. **mover** — frozen while a blocking fiber runs, a choices box is
   open, the input lock is held, the message hold applies, or the
   player's own command route is driving; collision adds blocking
   (`blocks: true`) character bodies.
3. **characters.stepChars** — patrol / random / approach / forced motion.
4. **interpreter.stepInterp** — fed the live NPC cells for trigger scans.
5. **external requests** — a `transfer` swaps map/fresh-interp/characters
   while keeping `state.sw`; an eligible connected-world transfer instead
   starts a source-owned one-tile handoff and performs that same swap
   atomically at its boundary, recording the left map's painted characters
   in the sparse, presentation-only `state.leftMap`; `moveRoute` installs on an NPC (or the player)
   and resumes its fiber when the route lands; `battle` derives one seed from
   `state.sw.rng` and parks its fiber in `state.scene`.

Same-tick `place` / `moveRoute` / `moveControl` order:

- The requests a tick's fold published apply in command order, across
  fibers. A `place` stops (and resumes the waiter of) the route its target
  was running or was given *before* the `place`; a route, turn, or control
  published *after* it is installed on the placed character and is kept.
  So `place` → `moveRoute` (waited or not) walks from the new cell, and
  `place` → face turns the placed character, for the player and for events.
- A request aimed at an event whose page the same fold switched on (for
  example: set the variable that enables an NPC's page, `place` it, route
  it) is applied after moving the character onto that page, so the next
  tick's page sync does not tear the route down again. A request published
  while the old page was still active (the fiber flips the page
  afterwards) keeps the old rule: the page switch on the next tick resets
  it.
- These requests exist only within the tick that published them: a save
  point never contains them, and rewind and every host rate (60/30/20 Hz)
  replay them identically.

`SessionOptions.immutableState` is an opt-in ownership contract. When true,
every published `SessionState` is read-only: the fold copy-on-writes only the
banks and character records it changes, and identity-based caches may reuse
page selection, trigger scans, displaced cells, and active-character lists.
Frame-local ownership metadata is removed at the end of the outer fold, and
derived revision caches have a fixed entry bound; neither changes serialized
state. Maps using appearance, tile-property, BGM, or uncontracted extension
conditions stay on the conservative page-selection path. Installing
`onFiberStart` likewise keeps trigger scanning observable instead of sleeping
an unchanged scan. With the option omitted, the engine retains its defensive
copying and evaluation behavior.

Transfer semantics:

- A transfer rebuilds the map interpreter and returns every character to
  its authored cell (MV map-load semantics); switches, items, variables,
  gold and the RNG cursor in `state.sw` survive. Same-map transfers reset
  the same way.
- `fade > 0` freezes gameplay for the fade: fade-out half, swap on the
  first fully-black frame, fade-in half (`fadeOpacity(state.fade)` is the
  overlay alpha the UI binds).
- `worldTraversal: "seamless-v1"` plus a marked direct `playerTouch`
  transfer may replace that instant swap with one eight-reference-tick
  crossing, but only when the injected immutable-layout resolver proves the
  exact coordinate-preserving opening and the base passage tables admit it.
  An accepted crossing is the transition and therefore replaces any authored
  transfer fade. A failed proof leaves the command untouched, including its
  original fade duration, on the legacy timeline.
  The source remains the sole page/NPC/collision owner until the final tick;
  target pages start one tick after atomic entry. The ordinary landing on the
  source edge runs `playerStep` once; the crossing's atomic target placement
  is not another step. A fatal source-map content error cancels the crossing,
  snaps the player to that source edge and freezes there. The in-flight state
  participates in attract rewind and blocks saves; it is removed by entry or
  fatal cancellation, so v1 snapshots remain unchanged.
- The render structure that makes a transfer cheap is one ground and one
  upper `Image` per **current** map plus per-map NPC containers: a swap is
  an `Image` src change and a container `display` toggle — O(maps), not the
  1998-op sliding-chunk burst the R1 review measured.

## Host map source (on-demand maps)

Large projects keep map payloads out of the inline document and hand
`createSession` a `MapRepository` through `options.maps`. The default
repository, `createJsonMapRepository(entries, source, options?)`, loads map
entries through a host-provided `MapEntrySource`:

```ts
interface MapEntrySource {
  read(entry: string): string | Uint8Array | undefined;
  readText?(entry: string): string | undefined;
  prepare?(entry: string): Promise<void>;
}
```

`read` returns the entry's text or bytes, or `undefined` when the entry is
missing or not ready yet. `readText` is an optional fast path for text hosts;
when present it is authoritative — its `undefined` means missing or not
ready exactly like `read`. A source that exposes `prepare` is asynchronous:
a cache miss calls `prepare` and the acquire fails with `MapNotReadyError`,
which the session catches to pause and retry the same logical input frame on
a later reference tick (the session drives this during a non-zero transfer
fade). Repository options: `verify` recomputes each entry's build-time
SHA-256 before parsing and defaults to true only for sources that expose
`prepare`; `validate` defaults to `"structure"` (the splitter already ran the
full schema) and `"full"` revalidates every acquired map. The repository
caches parsed maps; `releaseExcept(ids)` evicts every other entry.

Despite its historical name, `createJsonMapRepository` accepts both ordinary
MapDef JSON and self-identifying `rpgkit-map/1` compact entries; new code may
use its format-neutral `createMapRepository` alias. The compact transport is
decoded to the ordinary MapDef before the same structure/full validation and
metadata checks. The index SHA-256 always covers the entry's exact encoded
bytes, so JSON and compact builds naturally have different package identities
without changing `MAP_SCHEMA_HASH`.

## Extensions and battle scenes

`createSession(project, hz, options)` accepts these options:

| option | type | default | purpose |
| --- | --- | --- | --- |
| `maps` | `MapRepository` | — | required when the project is a sharded `ProjectShell` (see "Host map source" below); ignored for inline documents |
| `extensions` | `ExtensionOptions` | none | registered `ext` commands, conditions, `extChoice` providers, and an optional completed-player-tile hook |
| `battle` | `BattleRules` | `null` | the game-owned scene reducer; a project that uses battle commands without one fails at `createSession` |
| `scene` | `{ worldContinues?: boolean }` | `{ worldContinues: false }` | let map fibers keep folding while a scene owns the screen |
| `verifyMapManifest` | `boolean` | `false` | recompute a sharded shell's declared content hash for untrusted inputs |
| `onFiberStart` | `(key: string, pageIndex: number, parallel: boolean) => void` | none | page-fiber start trace; see below |
| `onInstruction` | `(key: string, pageIndex: number, ins: Instr) => void` | none | per-instruction execution trace; see below |

The former bare-repository third argument remains accepted for v1 callers.
Packaged splitter output uses its build-time content hash directly, and
startup never recomputes it; `verifyMapManifest` opts into the recompute for
untrusted inputs. A shell that declares `mapSchemaHash` must name the kit's
baked `MAP_SCHEMA_HASH` or one of `MAP_SCHEMA_COMPATIBLE_HASHES` (earlier
schemas that differ only by additive changes) or `createSession` throws with
a message naming the refused and accepted identities; save envelopes follow
the same rule, and the session always stamps new saves with
the current identity.
`assertShellManifestFresh(shell)` exports the matching build/test-time check:
an application that packages a shell calls it after writing the shell to disk,
so a stale or hand-edited declared hash fails the build instead of shipping.

`onFiberStart` fires once when a page fiber starts, for every trigger:
`parallel` fibers report `parallel: true`; `autorun`, `action`,
`playerTouch`, and `eventTouch` fibers report `false`. The arguments are the event key, the
selected page's index, and that flag. It fires in the same tick the fiber
starts — including fibers that begin and end inside one tick — so a coverage
tool can observe instant pages that leave no residual fiber. Pages with zero
commands never create a fiber and do not fire the trace. The callback costs
nothing when omitted. `AttractController` does not currently accept or forward
it, so attract/rewind sessions cannot install the trace through the
controller.

`onInstruction` fires once for every event instruction that executes, right
before it runs, on the fiber that runs it — the event key, the selected
page's index, and the instruction. A called common event's instructions run
as stacked frames on the calling page's fiber, so they are attributed to
that page. Because it fires at execution time, a coverage tool observes the
commands a simulation actually reached, including ones in branches that
were taken, and never the ones in branches that were not. The callback
costs nothing when omitted (one optional dispatch in the run loop), and the
idle-scan cache stays enabled when it is not installed.

An `ext` command handler receives cloned JSON arguments, read-only built-in
banks and `random()`, the only permitted entropy source. It returns a new
`ext` value and/or finite number/string variable replacements, per-item count
replacements, and a wallet replacement. All returned banks validate before
any commit, and later instructions in the same interpreter tick see the new
items and gold. An `ext` condition is read-only and cannot draw randomness.
`SessionState.ext` defaults to `null`; its validator runs on every boundary,
its optional codec wraps save/restore bytes, and save checksums cover the
encoded form. Inline projects validate every namespaced call at
`createSession`; sharded projects also validate each acquired map.
`allowUnknown` is an explicit preview-only escape hatch.

`ExtensionOptions.playerStep` names one registered extension command and
optional JSON arguments. The session runs it once after every completed
player tile, whether input, a forced route, pathfinding or autonomous motion
drove the landing. For seamless handoff, the source-edge landing counts once
and the later atomic target placement does not; legacy transfers, blocked
attempts and `place` do not count. The handler uses the ordinary extension
command's saved RNG and atomic publication path. When omitted, the session
performs only a null check and allocates no hook state.

Condition handlers normally receive defensive clones and are evaluated on
every relevant read. Setting both `immutableConditions` and
`deterministicConditions` on `ExtensionOptions` opts them into identity-based
memoization: handlers must not mutate the context, extension tree, or authored
arguments, and must have no result or side effect beyond their returned
boolean. Supplying only `immutableConditions` avoids those input clones but
does not permit result reuse. These flags do not change command, choice,
codec, or validator contracts.

`{ op:"extChoice", call, args, prompt, cancel?, write? }` uses a registered
`options.extensions.choices[call]` handler. Its pure
`options(readContext, args)` function receives no RNG and returns live rows
`{ key, label, enabled?, data? }`; the interpreter recomputes them every
reference tick while the modal is open. Keys are non-empty, unique stable
logical identities. A surviving key preserves the cursor through reordering;
if it disappears, the old index is clamped and the replacement row cannot be
confirmed until the following tick. Disabled rows remain navigable and render
dimmed but ignore confirm. Data defaults to `null`, must be JSON, and is cloned
for the resolver. A non-cancellable list must expose at least one enabled row;
only a cancellable list may be empty.

On confirm, the optional `resolve` callback receives the current command
context and `{ kind:"select", index, key, data }`; on an enabled cancel it
receives `{ kind:"cancel" }`. The resolver alone has the saved-RNG `random()`
function, so opening, refreshing, or navigating the modal consumes no entropy.
The command's optional `write` record names distinct variable destinations:
selection writes zero-based index/key/`0`, while cancel writes `-1`/`""`/`1`.
Those values and the resolver's `ExtensionCommandResult` publish atomically,
and a resolver write targeting the same id is rejected instead of receiving
an implicit precedence. The next instruction sees the committed result on the
same reference tick.

The dynamic list reuses the authored-choice modal and four-row scroll window,
so it captures the d-pad, blocks its owning fiber, and makes `worldIdle` false.
Manual saves reject it while it is open; an automatic save carries both the
modal and its owning fiber and can resume it. Modal state remains plain JSON
and rewind rebuilds it through the ordinary pure fold; reference-tick option
refresh and input edges therefore remain identical across supported host
rates. Unknown choice calls are rejected with other missing extension
registrations, or become immediate no-ops only under the explicit preview
`allowUnknown` option.

A `battle` command parks its fiber and publishes a setup JSON value. General
interpreter execution remains parallel fibers (ascending event key) before the
blocking main fiber, preserving same-tick visibility for every other command.
Battle publication is ordered separately: requests newly emitted in a tick
are staged and appended to the persistent queue main first, then parallel
fibers by ascending event key. The queue head starts immediately when the
scene slot is free. After a scene completes and resumes its owner, the next
queued request starts on the next reference tick. A `start()` result of
`null` resumes that fiber immediately and consumes no scene slot.
`BattleRules.start(ext, setup, seed, context)` may decline with `null`;
otherwise its returned JSON state becomes `SessionState.scene.state`.
`context` is a read-only snapshot of the session's ext, switches, variables,
items and gold at battle entry. Existing three-parameter implementations stay
compatible because the additional argument may be ignored.
Its result may also include
`audio: { bgm: { id, volume?, pitch? } | null }`. Presence snapshots the
complete map audio state, replaces it with only the battle track (or silence),
and restores the snapshot atomically when `done` completes; omission leaves
audio untouched. Invalid track fields are game-code contract errors.
`BattleRules.step(state, input, ticks)` receives only scene input, once per
host frame, with fixed-reference `ticks`. `done` returns ext, a
win/lose/escape/draw result, optional variable/switch/item/gold replacements,
and an optional transfer. Completion validates every value before committing
any of them, runs the result branch, then runs the transfer; the transfer can
therefore rebuild the map interpreter without discarding branch effects.

By default battle callbacks receive and return defensive JSON clones.
`BattleRules.immutableState: true` instead promises persistent battle state:
callbacks must never mutate a value previously published by another callback
or by the engine. The engine validates each newly returned tree and can then
share it across unchanged frames. Suspended map audio remains privately
cloned, so battle BGM restoration is independent of this opt-in contract.

`ExtensionCommandResult.items` and `BattleCompletion.items` replace only the
listed ids. Counts are floored through `clampFiniteVar`, clamped non-negative
and to `system.inventory.maxPerItem`, with zero removing an id. Removals and
updates to already-held kinds happen first. New positive kinds are considered
in lexical id order until `system.inventory.maxKinds`; excess kinds are
dropped. `gold` similarly replaces the wallet after finite-integer and
non-negative clamping. Both paths write `SessionState.sw`, the same backpack
and wallet used by shops and authored commands. The values therefore retain
the existing save, rewind and multi-Hz behavior; the save gate itself is
unchanged, so an active battle remains non-saveable.

Scene-time map behavior freezes the map by default, matching RPG Maker MV and
Tuxemon:

- manual player input is routed only to the battle reducer;
- page synchronization, player/NPC autonomous or forced movement, and every
  map interpreter fiber stay frozen;
- the absolute interpreter clock remains rate-stable while relative wait and
  typewriter timers are shifted with it, so paused commands do not elapse;
- `GameView` keeps the map/dialog tree mounted but hides it, and renders the
  registered battle component from `{ state, width, height, active }` only;
  `active` is false while the once-mounted scene is hidden so it can release
  scoped resources. A parked map modal remains in reducer state, but the scene
  owns confirm/cancel until it closes. The optional effects component stays
  mounted outside both scene visibility gates.

Pass `scene: { worldContinues: true }` to `createSession`, `GameView`, or
`AttractController` to opt into background map simulation. Any battle request
published in that mode joins the same FIFO instead of replacing a request or
throwing because another scene is active. Invalid registered `BattleRules`
return values remain programmer-contract errors; authored combinations of
battle events do not throw from `stepSession`.

A variable-addressed `transfer` resolves against the live variable bank. An
unset/wrong-typed map, coordinate, or direction operand, and a resolved map id
that the project does not own, record a fatal content error instead of
throwing from `stepSession`. The playfield then remains frozen, `GameView`
shows the error message, and the save gate rejects the state. Extension and
`BattleRules` callback return-shape assertions are different: they are
registered game-code contract failures and intentionally still throw.

An active scene or a non-empty battle queue is not a save point. Scene and
queue state still live in the ordinary reducer snapshot used by attract
rewind, so a refold may cross map/queue/battle boundaries byte-for-byte. The
controller takes a full `SessionState` keyframe after each map or
battle-scene boundary and every 3,600 reducer/source frames by default. A keyframe also carries the held
mask, tape/divergence cursors, display stage and type/read-hold clocks needed to
restore the controller exactly; display-only ticks do not move the periodic
counter. Consequently capture positions depend on the source stream, not the
host's 60/30/20/4 Hz paint rate.

Rewind chooses the newest retained keyframe at or before its target and folds
only subsequent reducer inputs. `keyframeIntervalFrames` changes the interval;
`0` disables the periodic captures while boundary captures still occur.
`keyframeMaxBytes` defaults to 2 MiB and `keyframeMaxCount` to 64; whichever
limit is reached first evicts oldest snapshots. A single keyframe whose
serialized payload exceeds the byte budget is skipped. A zero budget or count
disables snapshots, and a target older than the retained window falls back to
the clean frame-zero replay. `keyframeStats()`, `keyframeEstimatedBytes`, and
`rewindHistoryEstimatedBytes` expose the bounded serialized-payload estimate
and last suffix length for tests/devtools. Under `immutableState` a keyframe
and the clean origin hold the published state by reference (consecutive
keyframes share unchanged subtrees, so the estimate, which charges each one its
full serialized size, is an upper bound); otherwise they are deep copies.
Actual JS object overhead is host-specific. These snapshots are transient
controller state and are not written to save envelopes.

`worldIdle` treats any non-null scene as busy even when
`scene.worldContinues:true` lets map fibers keep folding. Transfer fades and
the session's player route are likewise supplied to condition evaluation as
derived blockers. The save menu remains host-owned: while it is displayed the
host pauses the session fold, and `isSessionWorldIdle(state, true)` reports the
same state as busy without adding menu data to `SessionState`. Attract mode is
an input/presentation controller rather than another game scene, so the phase
itself is not a blocker; source frames evaluate ordinary session state, while
display-only read/end holds do not fold conditions at all. Rewind restores a
snapshot and re-derives the value, preserving byte-identical replay.

An old v1 snapshot with `pendingBattle: null` hydrates to an empty queue; a
populated legacy slot is explicitly rejected because it represents queued
external work, which has never been a legal save point.
