// src/engine/types.ts — data types for rpgkit-project/v1 (the schema
// in data/schema.json is normative). P1① carried the map/sheet subset; P1③
// widens to the event vocabulary the interpreter consumes (R2 report §2–3):
// pages, triggers, the command list, page conditions. The interpreter
// (interpreter.ts) is a pure fold over these types: no host imports. P1②
// adds the sheet dirBlock directional masks consumed by passability.ts.

import type { UiTextOverrides } from "./ui-text.ts";

export type Dir = "down" | "left" | "right" | "up";

/** Values which can cross the project/session/save boundary. Extension and
 * battle payloads deliberately stay inside this JSON subset: a reducer state
 * must not acquire host objects, functions, dates, NaN or undefined. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Event variables are numeric for the built-in arithmetic commands, but an
 * extension may also write a string. String values make MV-style variable
 * transfers useful with this format's string map ids and directions. */
export type VariableValue = number | string;

/** Read a command operand from the live variable bank. */
export interface VariableRef {
  variable: string;
}

export type TransferMap = string | VariableRef;
export type TransferCoordinate = number | VariableRef;
export type TransferDirection = Dir | "keep" | VariableRef;

/** Integer RGBA colour used by deterministic full-screen effects. Alpha is
 * the layer opacity: 0 is transparent and 255 is opaque. Keeping channels
 * numeric avoids host-specific CSS colour parsing in reducer state. */
export interface ScreenColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** RPG Maker picture colour tone. RGB channels are signed offsets
 * (-255..255); gray is a 0..255 desaturation amount. Keeping the authored
 * integers in reducer state makes picture tweens portable across hosts even
 * when a renderer has to approximate the tone operation. */
export interface PictureTone {
  r: number;
  g: number;
  b: number;
  gray: number;
}

export type PictureBlendMode = "normal" | "add" | "multiply" | "screen";
export type PictureOrigin = "topLeft" | "center";
export type PictureCoordinate = number | VariableRef;

/** Facing as an engine index: 0 down, 1 left, 2 up, 3 right. Matches the
 *  BTN-driven order the camera reducer emits and the hero atlas file order. */
export type Facing = 0 | 1 | 2 | 3;

/** A tile id "sheet.cell" (e.g. "grass.43"); null is a blocking void. */
export type TileId = string | null;

export interface Sheet {
  id: string;
  cols: number;
  rows: number;
  /** Cooked TILESET pak entry ("chunks" marks the P1① prebaked-chunk build,
   *  which owns no per-tile entry). */
  pak?: string;
  defaultPassage?: "pass" | "block";
  block?: number[];
  pass?: number[];
  /** Cell index (as string) -> directions of the edges that cell forbids
   *  crossing: the mask blocks LEAVING that cell through a named edge and
   *  ENTERING it through that same edge from outside (P1②, task-1206). */
  dirBlock?: Record<string, Dir[]>;
  /** Cell index (as string) -> per-edge DIRECTIONAL passage rules. Unlike
   *  `dirBlock` this is one-sided: a rule
   *  guards ONLY the edge of the cell it is authored on, so a ledge/one-way
   *  door can forbid "enter from the west" while leaving "leave to the
   *  west" open. `enter` lists directions from which the cell may NOT be
   *  entered (the step crosses that edge INTO the cell); `exit` lists
   *  directions in which the cell may NOT be left. `dirBlock` keeps its
   *  undirected meaning and the two combine (a crossing blocked by either
   *  is blocked). */
  dirEdges?: Record<string, { enter?: Dir[]; exit?: Dir[] }>;
}

// --- events ----------------------------------------------------------------

/** `eventTouch` is RPG Maker's Event Touch: on a blocking page it fires
 *  when the player's step is refused by the event's body (a bump) or when
 *  the event's own movement step is refused by the player's body; on a
 *  non-blocking page it fires on entry, like playerTouch. */
export type Trigger = "action" | "playerTouch" | "eventTouch" | "autorun" | "parallel";

/** A route target other than the mover itself: "player" or another map
 *  event by id (MV Set Movement Route on any event). */
export type RouteTarget = "player" | "this" | { event: string };

/** A character whose runtime walking appearance can be changed. */
export type AppearanceTarget = RouteTarget;

/** A viewport-independent camera focus. Character targets are sampled when
 * the command starts; `player` means smoothly return to live player follow. */
export type CameraTarget = "player" | "this" | { event: string } | { x: number; y: number };

/** Per-cell passage fields a runtime tileProperty command can replace.
 * Missing fields keep their authored value; an empty direction list
 * explicitly opens every edge in that half of the crossing. */
export interface TilePropertyOverride {
  passage?: "pass" | "block";
  enter?: Dir[];
  exit?: Dir[];
}

/** Target of a turn-toward / approach step: the player or a named event. */
export type CharTarget = "player" | { event: string };

/** RPG Maker-style per-character movement settings. Speed is the MV 1..6
 *  exponential level (5 is this runtime's legacy eight-tick step); running
 *  adds one effective level, capped at 6. Frequency is the MV 1..5
 *  autonomous-decision level. */
export type MoveSpeed = 1 | 2 | 3 | 4 | 5 | 6;
export type MoveFrequency = 1 | 2 | 3 | 4 | 5;
export type FacingMode = "followMovement" | "locked" | "scripted";

/** Inclusive tile rectangle used by runtime random wandering. */
export interface WanderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A persistent (for the current map/page visit) movement-setting change.
 *  A route step wraps one of these as `{control}` and applies it to its own
 *  actor; the standalone moveControl command names any actor.
 *  `routeSpeed` is the exception: it scopes a speed grade to exactly one
 *  forced route — latching onto the actor's active route, or held pending
 *  until the next forced route installs — and is gone when that route ends,
 *  so later routes and autonomous movement keep their resolved speed. */
export type MoveControl =
  | {
      kind: "wander";
      bounds?: WanderBounds;
      frequency?: MoveFrequency;
      /** Exact 60 Hz reference-tick interval between wander attempts.
       *  When present it takes precedence over the MV frequency grade. */
      intervalTicks?: number;
    }
  | { kind: "moveType"; value: "page" | "static" | "approach" }
  | { kind: "stop" }
  | { kind: "speed"; value: MoveSpeed }
  | { kind: "routeSpeed"; value: MoveSpeed }
  | { kind: "run"; value: boolean }
  | { kind: "frequency"; value: MoveFrequency }
  | { kind: "directionFix"; value: boolean }
  | { kind: "through"; value: boolean }
  | { kind: "facingMode"; value: FacingMode };

/** A deterministic-path step. The expansion runs when the step
 *  STARTS, once:
 *  - turnTowardPlayer / {turnToward} — face a live character in place.
 *  - {pathTo} — deterministic 4-neighbour BFS to a tile. The BFS runs at
 *    the step's first boundary tick. An unreachable path or blocked next
 *    step waits a bounded interval, then recomputes from live state up to
 *    `retries` times (default 10) before the route continues.
 *  - {approach} — BFS to the adjacent tile on a character's side and face
 *    that character on arrival. `side` says which side of the target to
 *    stand on (a step from that side TOWARD the target enters it); default
 *    is the mover's current side; `distance` defaults to 1. */
export type PathStep =
  | "turnTowardPlayer"
  | { turnToward: CharTarget }
  | { pathTo: { x: number; y: number; retries?: number } }
  | { approach: { target: CharTarget; side?: Dir; distance?: number; retries?: number } };

export type MoveStep =
  | "moveDown" | "moveLeft" | "moveRight" | "moveUp"
  | "stepForward"
  | "faceDown" | "faceLeft" | "faceRight" | "faceUp"
  | "wait" | "turnRandom"
  | PathStep
  | { control: MoveControl };

export interface MoveRoute {
  steps: MoveStep[];
  repeat: boolean;
  skippable: boolean;
}

/** A condition inside an `if` command (compare against live reducer state).
 *  The same union backs PageCondition.all: a switch clause
 *  there may demand either value, unlike the bare page-condition `switch`
 *  field which only asks for ON. `facing` reads the live player facing and
 *  is meaningful only where a facing context exists (the trigger scan, an
 *  `if` folded on the map); elsewhere it evaluates false. `worldIdle` is
 *  likewise a runtime-only derived value: it is never stored in a project
 *  save, and low-level callers without a world-activity context cannot
 *  prove it true. `playerMoving` samples the player's interpolating-step
 *  state at the start of the current reference tick; it is likewise
 *  derived rather than saved. */
export type Condition =
  | { kind: "switch"; id: string; value?: boolean }
  | { kind: "variable"; id: string; op: ">=" | "<=" | "==" | "!="; value: number }
  | { kind: "selfSwitch"; key: "A" | "B" | "C" | "D"; value?: boolean }
  | { kind: "item"; id: string; count: number }
  | { kind: "gold"; amount: number }
  | { kind: "facing"; dir: Dir }
  /** Compare the character's effective walking-sprite key. null denotes
   *  the built-in player art or an event page with no sprite. */
  | { kind: "appearance"; target: AppearanceTarget; sprite: string | null }
  /** Compare explicitly authored runtime tile-property overrides. Every
   *  present field must match; null means that field has no override. */
  | {
      kind: "tileProperty";
      x: number;
      y: number;
      passage?: "pass" | "block" | null;
      enter?: Dir[] | null;
      exit?: Dir[] | null;
    }
  /** True only while the map world is the unobstructed top-level state.
   *  `negate` asks for any blocking world state instead. */
  | { kind: "worldIdle"; negate?: boolean }
  /** True while the player had a committed interpolating tile step at the
   *  start of this reference tick. `negate` asks for the resting state. */
  | { kind: "playerMoving"; negate?: boolean }
  /** True when the region id authored at cell (x, y) equals `id`. Cells
   *  without a region read 0, so `{kind:"region", x, y, id: 0}` matches
   *  unmarked cells. Coordinates are literals (like tileProperty); read a
   *  variable coordinate through the `locationInfo` command instead. */
  | { kind: "region"; x: number; y: number; id: number }
  /** True while a BGM is audibly advancing. A paused BGM or one suspended
   *  behind an ME is not playing. `id` omitted matches any BGM. */
  | { kind: "bgmPlaying"; id?: string; negate?: boolean }
  /** RPG Maker's timer branch. A stopped timer never matches; a running
   * timer compares its whole remaining seconds (floor(referenceTicks / 60)). */
  | { kind: "timer"; op: ">=" | "<="; seconds: number }
  /** Game-owned pure condition handler, registered on createSession(). */
  | { kind: "ext"; call: string; args: JsonValue };

export interface VariableSet {
  op: "set" | "add" | "sub";
  value: number;
}
export interface VariableRandom {
  op: "random";
  min: number;
  max: number;
}
/** T2-16: the operand is another variable's live value instead of a
 *  literal. "copy" assigns it outright; the arithmetic ops combine the
 *  target's current value with the source's (target OP source). Division
 *  and modulo by a source that reads 0 leave the variable unchanged rather
 *  than producing NaN/Infinity, keeping the saved bank plain finite JSON
 *  numbers. */
export interface VariableOpRef {
  op: "copy" | "add" | "sub" | "mul" | "div" | "mod";
  from: string;
}

/** Optional built-in result sinks for an extension-provided choice. All
 * values are variable ids. On selection they receive index/key/0; on cancel
 * they receive -1/""/1 respectively. */
export interface ExtensionChoiceWrite {
  index?: string;
  key?: string;
  cancelled?: string;
}

/** T2-10/B1: one row of a shop's goods list. `price` overrides the item's
 *  own catalog price for buying at THIS shop only, falling back to it when
 *  omitted. `sellPrice` overrides this shop's buy-back price for the item
 *  (independent of any other shop's `sellPrice` for the same item);
 *  omitted falls back to floor(item.price / 2) as before. `stock` is a
 *  finite quantity this shop carries: a purchase decrements it and a
 *  sell-back at this same shop increments it (persisted per shop `id` +
 *  item id); omitted means unlimited. `condition` reuses the page-
 *  condition clause shape (K1's `all`/flat fields): the row is hidden
 *  while it does not hold. */
export interface ShopGood {
  item: string;
  price?: number;
  sellPrice?: number;
  stock?: number;
  condition?: PageCondition;
}

/** One row of a `choices` box. `icon` draws a registered character sprite
 *  left of the label (see ChoiceIcon); without it the row is text only. */
export interface ChoiceOption {
  text: string;
  icon?: ChoiceIcon;
  commands: Command[];
}

/** A choice-row picture: one frame of a `project.sprites` entry. A static
 *  image sprite (`kind: "image"`) ignores `dir`/`frame`; a walker shows the
 *  `dir` facing (default down) in walk pose `frame` (0 idle, the default;
 *  1 left step; 2 right step). Render-only: the reducer copies it into the
 *  open choices modal and never reads it. */
export interface ChoiceIcon {
  sprite: string;
  dir?: Dir;
  frame?: 0 | 1 | 2;
}

/** Project/tape identity for map traversal timing. Missing means the legacy
 * transfer timeline, so content authored before seamless worlds is never
 * reinterpreted merely because it also has a WorldLayout. */
export type WorldTraversalMode = "legacy-transfer" | "seamless-v1";

/** Stable importer provenance for one transfer that may use an authored
 * world opening. Both the project mode and this marker must opt in. When the
 * opening proof succeeds, its visible crossing replaces any authored transfer
 * fade; a failed proof preserves the complete legacy transfer, including fade. */
export interface TransferHandoff {
  mode: "seamless-v1";
  portalId: string;
}

/** Where a text window sits on the screen. `top`, `center` and `bottom`
 *  span the screen width; the corners and the sides (`left`, `right`) are a
 *  narrower window (four fifths of the screen) against that edge. */
export type TextBoxPosition =
  | "top" | "center" | "bottom"
  | "topLeft" | "topRight" | "bottomLeft" | "bottomRight"
  | "left" | "right";

/** Optional layout of a `text` command's window. Every field absent is the
 *  default box (bottom, words left/top aligned, framed window). */
export interface TextBoxLayout {
  /** The window's place on screen; default "bottom". */
  position?: TextBoxPosition;
  /** Each row's horizontal place in the text column; default "left". */
  align?: "left" | "center" | "right";
  /** The page's rows as a block in the box's text area (four rows in a
   *  band, fewer in a corner or side box); default "top". */
  valign?: "top" | "center" | "bottom";
  /** "window" the framed panel (default), "dim" a translucent fill of the
   *  panel colour without the frame, "transparent" the words alone. */
  background?: "window" | "dim" | "transparent";
}

export type Command =
  /** Lines may hold `{name}` (the player's name), and, when the project sets
   *  `system.textVariables`, `{v:<id>}` (variable `id`'s value). A project
   *  that declares `system.textTokens` may also use `{x:<key>}`, answered by
   *  the session's resolver (see SessionOptions.textTokens). Tokens are
   *  expanded when the box opens. The optional layout fields
   *  (TextBoxLayout) place the window and the words in it; a text without
   *  them draws the default box: docked to the bottom, framed, words from
   *  the top left. */
  | ({ op: "text"; lines: string[]; cps?: number } & TextBoxLayout)
  | {
      op: "choices";
      prompt: string;
      options: ChoiceOption[];
      cancel?: { commands: Command[] };
    }
  | { op: "switch"; id: string; value: boolean }
  | { op: "variable"; id: string; set: VariableSet | VariableRandom | VariableOpRef }
  | { op: "selfSwitch"; key: "A" | "B" | "C" | "D"; value: boolean }
  | { op: "if"; if: Condition; then: Command[]; else?: Command[] }
  | {
      op: "transfer";
      map: TransferMap;
      x: TransferCoordinate;
      y: TransferCoordinate;
      dir?: TransferDirection;
      fade?: number;
      handoff?: TransferHandoff;
    }
  | { op: "moveRoute"; target: RouteTarget; wait?: boolean; route: MoveRoute }
  | { op: "moveControl"; target: RouteTarget; control: MoveControl }
  /** Change a walking character's image/opacity/visibility. null resets one
   *  field. Event changes last until that event changes page; player changes
   *  cross maps. `saveDefault` makes a player sprite the reset baseline. */
  | {
      op: "appearance";
      target: AppearanceTarget;
      sprite?: string | null;
      opacity?: number | null;
      visible?: boolean | null;
      saveDefault?: boolean;
    }
  /** Change one named visual layer for this map visit. A null field restores
   *  its asset default; variant names resolve through GameAssets. */
  | { op: "layer"; layer: string; visible?: boolean | null; variant?: string | null }
  /** Replace the current map parallax. A null image removes it. A looping
   *  axis scrolls by speed/4 kit pixels per reference tick (signed); the
   *  RPG Maker importer converts MV/MZ speeds from source-tile pixels. */
  | {
      op: "changeParallax";
      image: string | null;
      loopX: boolean;
      loopY: boolean;
      sx: number;
      sy: number;
      zero?: boolean;
    }
  /** Override passage and/or one-sided blocked edges at one map cell for
   *  this visit. null clears that field back to the authored map value. */
  | {
      op: "tileProperty";
      x: number;
      y: number;
      passage?: "pass" | "block" | null;
      enter?: Dir[] | null;
      exit?: Dir[] | null;
    }
  /** Fade the complete presentation independently of map transfer. Fade-out
   * retains its final colour until a later fade-in removes it. */
  | {
      op: "screenFade";
      direction: "out" | "in";
      duration: number;
      color?: ScreenColor;
      wait?: boolean;
    }
  /** Tween one named, composable full-screen colour layer. A target with
   * alpha 0 removes the layer when the tween completes. */
  | { op: "screenTint"; layer: string; color: ScreenColor; duration: number; wait?: boolean }
  /** Replace the transient flash. `intensity` scales colour alpha (0..255). */
  | { op: "screenFlash"; color: ScreenColor; intensity: number; duration: number; wait?: boolean }
  /** Deterministic horizontal shake. Strength is pixels and speed is cycles
   * per virtual second; the reference-tick triangle wave uses no RNG. */
  | { op: "screenShake"; strength: number; speed: number; duration: number; wait?: boolean }
  /** Scroll the viewport focus to a tile/character, or return to live player
   * follow. The reducer stores world focus, never resolution-specific clamp. */
  | { op: "camera"; target: CameraTarget; duration: number; wait?: boolean }
  /** RPG Maker Scroll Map: move the current camera focus by `distance`
   * tiles. `speed` is the MV/MZ 1..6 exponential scroll level. Camera
   * projection remains clamped by the active map/viewport; use the existing
   * `{op:"camera", target:"player"}` command to return to live follow. */
  | { op: "scrollMap"; direction: Dir; distance: number; speed: MoveSpeed; wait?: boolean }
  /** Show one project animation above a character, replacing that target's
   * previous balloon. Omit `icon` to clear it. With duration omitted it
   * persists (and loops) until cleared; a waited balloon needs a duration. */
  | { op: "balloon"; target: RouteTarget; icon?: string; duration?: number; wait?: boolean }
  /** Persistent full-screen cutscene backdrop, rendered below dialogs and
   * retained across transfers. The named asset must be a screen layer;
   * omitting/nulling variant closes the backdrop. */
  | { op: "screenBackdrop"; layer: string; variant?: string | null }
  /** Numbered viewport pictures. Coordinates are viewport pixels and can be
   * read from variables when the command executes. Percent scales use 100 as
   * identity; opacity is 0..255. */
  | {
      op: "showPicture";
      id: number;
      layer: string;
      variant: string;
      origin?: PictureOrigin;
      x: PictureCoordinate;
      y: PictureCoordinate;
      scaleX?: number;
      scaleY?: number;
      opacity?: number;
      blend?: PictureBlendMode;
    }
  /** Tween position/scale/opacity (and, on MZ imports, blend selection).
   * Duration is virtual seconds and therefore Hz-portable. */
  | {
      op: "movePicture";
      id: number;
      origin?: PictureOrigin;
      x: PictureCoordinate;
      y: PictureCoordinate;
      scaleX: number;
      scaleY: number;
      opacity: number;
      blend?: PictureBlendMode;
      duration: number;
      wait?: boolean;
      easing?: "linear" | "easeIn" | "easeOut" | "easeInOut";
    }
  /** Set continuous clockwise rotation in degrees per reference tick.
   * RPG Maker's Rotate Picture speed maps exactly to speed / 2. */
  | { op: "rotatePicture"; id: number; speed: number }
  | { op: "tintPicture"; id: number; tone: PictureTone; duration: number; wait?: boolean }
  | { op: "erasePicture"; id: number }
  /** One global RPG Maker-style countdown. `read` writes whole remaining
   * seconds to a normal event variable (0 when stopped). */
  | { op: "timer"; action: "start"; seconds: number }
  | { op: "timer"; action: "stop" }
  | { op: "timer"; action: "read"; variable: string }
  /** Built-in digit editor. The scene host writes the committed non-negative
   * integer to `variable` and parks this event until confirmation. */
  | { op: "inputNumber"; variable: string; digits: number }
  /** Built-in item picker (RPG Maker 104 Select Item). The scene lists only
   *  items the party currently holds, of `itemType` and item kind (weapons
   *  and armour are excluded, MV's Window_EventItem), and writes the chosen
   *  item's numeric id (the trailing integer of its id, MV's database id)
   *  to `variable`; cancelling or an empty list writes 0. Items without a
   *  `type` are "regular". */
  | { op: "selectItem"; variable: string; itemType: "regular" | "key" | "hiddenA" | "hiddenB" }
  /** Host-owned scene transitions. They publish a one-frame callback request;
   * without a registered host callback they are deterministic no-ops. */
  | { op: "openMenu" }
  | { op: "openSave" }
  /** Silently write the exact command-tick snapshot to the host's dedicated
   * read-only autosave slot. This is independent of manual save access. */
  | { op: "autosave" }
  | { op: "gameOver" }
  | { op: "returnTitle" }
  /** Change the player name used by the `{name}` text token. */
  | { op: "changeName"; name: string }
  /** Enable/disable automatic map-name banners on subsequent map entries. */
  | { op: "mapNameDisplay"; visible: boolean }
  /** Enable/disable the host's menu entry (RPG Maker 135). Default enabled;
   *  a disabled menu makes openMenu a no-op and the host shows the entry
   *  disabled. See SwitchState.menuAccess. */
  | { op: "menuAccess"; enabled: boolean }
  /** Enable/disable the host's save entry (RPG Maker 134). Default enabled;
   *  a disabled save makes openSave a no-op and the host shows the entry
   *  disabled. See SwitchState.saveAccess. */
  | { op: "saveAccess"; enabled: boolean }
  /** Write a fact about one map cell to a variable (RPG Maker 285 Get
   *  Location Info). The coordinate is a literal or a variable read at
   *  execution. `kind` selects the fact:
   *  - "terrain": the cell's terrain tag (0 when none; the importer derives
   *    it from the tileset flags, MV parity).
   *  - "event": the numeric id of the lowest-id event on the cell, 0 when
   *    the cell is empty (the trailing integer of the kit's event id). The
   *    event's LIVE position is read, so a moved event is found.
   *  - "tile": the cell's tile id on layer 0..3 (RPG Maker's four tile
   *    layers). Imported maps carry the raw RPG Maker tile ids in `tiles`,
   *    so this returns exactly what RPG Maker would; a hand-authored map
   *    without that data returns the ground/upper cell's sheet index for
   *    layers 0/1 and 0 for layers 2/3.
   *  - "region": the cell's region id (0 when none).
   *  An out-of-bounds cell writes 0. */
  | {
      op: "locationInfo";
      variable: string;
      x: number | VariableRef;
      y: number | VariableRef;
      kind: "terrain" | "event" | "tile" | "region";
      layer?: 0 | 1 | 2 | 3;
    }
  | { op: "wait"; seconds: number }
  | { op: "gold"; set: "add" | "sub"; amount: number }
  | { op: "item"; item: string; set: "add" | "sub"; count: number }
  | { op: "se"; name: string; volume?: number; pitch?: number }
  | { op: "playBgm"; id: string; volume?: number; pitch?: number }
  | { op: "fadeoutBgm"; duration: number }
  | { op: "stopBgm" }
  | { op: "pauseBgm" }
  | { op: "resumeBgm" }
  | { op: "playBgs"; id: string; volume?: number; pitch?: number }
  | { op: "fadeoutBgs"; duration: number }
  /** ME is a deterministic one-shot. `duration` is virtual seconds; when
   *  it expires, an unpaused BGM resumes from its held position. */
  | { op: "playMe"; id: string; duration: number; volume?: number; pitch?: number }
  | { op: "playSe"; id: string; volume?: number; pitch?: number }
  /** Stop every sound effect currently playing (RPG Maker 251). A
   *  one-shot side effect: it appends a stop entry to the deterministic
   *  cue sequence the host audio bridge drains, and is never saved. */
  | { op: "stopSe" }
  | { op: "saveBgm" }
  | { op: "replayBgm" }
  | { op: "erase" }
  | { op: "exit" }
  /** Run `commands` again and again until a `break` inside them (at any
   *  depth of if/choices/battle/scene blocks, but not inside a called common
   *  event) leaves the loop. A pass that reaches no waiting command still
   *  yields to the next frame after a bounded amount of work, so a loop
   *  never stalls the host. */
  | { op: "loop"; commands: Command[] }
  /** Leave the innermost enclosing `loop`; outside any loop it ends the
   *  current page or common event. */
  | { op: "break" }
  /** A named position in this page or common event (RPG Maker 118). Labels
   *  are scoped to the list that contains them — the whole page or common
   *  event tree, branches included — and a `jumpLabel` finds the FIRST label
   *  with this name anywhere in that tree, at any nesting depth. A label is
   *  a no-op when execution reaches it.
   *
   *  `ord` is the label's position in the original flat RPG Maker source
   *  list (set by the importer). MV's jumpTo scans that flat list top-down
   *  and stops at the first match, so the "first" label is the one with the
   *  lowest `ord` — not the first one a nested-tree walk happens to visit.
   *  Hand-authored lists omit it and fall back to tree-walk order. */
  | { op: "label"; name: string; ord?: number }
  /** Jump to the first `label` with this name in the same page or common
   *  event (RPG Maker 119). The label may sit inside an if/choices/battle/
   *  scene branch: jumping out of a block abandons it like MV's flat-list
   *  jumpTo, and jumping into one enters that branch unconditionally (its
   *  choice/battle/scene is not replayed; the branch simply runs from the
   *  label and completes normally). A name with no label does nothing, like
   *  MV. A backward jump that never reaches a label again is stopped by the
   *  same per-frame step budget that bounds loops. */
  | { op: "jumpLabel"; name: string }
  | { op: "common"; id: string }
  /** T2-10 shop: a goods list plus buy/sell. `id` namespaces this shop's
   *  persisted stock counters (SessionState.sw.shopStock) so two shops
   *  selling the same item track independent inventories; it must be
   *  stable across saves (like an event id). `sell` (default true) is
   *  MV's "purchase only" flag inverted: false hides the sell tab
   *  entirely. `sellList` governs how an unsellable row (ShopGood or the
   *  Item itself, see ShopGood/Item) appears in the sell tab: "disable"
   *  (default, MV parity) lists it dimmed and unconfirmable; "hide"
   *  (Tuxemon parity, only resellable items) omits it. */
  | { op: "shop"; id: string; goods: ShopGood[]; sell?: boolean; sellList?: "disable" | "hide" }
  /** Play a frame animation on the map (Tuxemon play_map_animation /
   *  play_tile_animation, RPG Maker Show Animation). The instance is
   *  reducer state keyed by `id`: it starts on the tick the command runs
   *  with the saved frame clock as its origin, so playback is identical
   *  under rewind and after a save/load. A replay with a live instance of
   *  the same `id` replaces it. Position is EITHER a tile (`x`/`y`, both
   *  required) OR a character to follow (`target`: "player" or a map
   *  event by id); a bound instance keeps painting on the character's
   *  live pixel position as it moves. `follow:false` with a `target`
   *  snapshots the character's tile at execution and pins the instance
   *  there (Tuxemon play_map_animation parity: it reads character.tile_pos
   *  once and stores the coordinates, never a live reference). An event
   *  target must name a live character: one that is erased, on an inactive
   *  page, or never spawned has no live position, so the command plays
   *  nothing (a content error) instead of falling back to the event's
   *  authored x/y (Tuxemon get_npc looks up the live _on_map set only). A
   *  following instance whose target leaves the map mid-playback keeps
   *  playing, pinned to the target's last live cell. `layer`
   *  "above" (default, Tuxemon layer 4) paints over characters, "below"
   *  under them. `loop` overrides the AnimationDef default. `wait` parks
   *  the fiber until one playthrough completes for a one-shot animation,
   *  or until `stopAnim` stops the instance for a looping one; stopping
   *  the instance releases the wait early either way. Animations are
   *  per-map-visit state: a transfer clears them. */
  | {
      op: "mapAnim";
      id: string;
      anim: string;
      x?: number;
      y?: number;
      /** `this` resolves against the issuing page fiber, including while it
       * is executing a called common event. */
      target?: "player" | "this" | { event: string };
      follow?: boolean;
      layer?: "below" | "above";
      loop?: boolean;
      wait?: boolean;
    }
  /** Stop map animations: one instance by `id`, every instance of one
   *  animation by `anim`, or every live map animation when neither is
   *  given. A fiber parked on a stopped instance's `wait` resumes. */
  | { op: "stopAnim"; id?: string; anim?: string }
  /** Cross-event input lock. While the lock is held the mover
   *  ignores the d-pad and action presses cannot start an event; autorun
   *  and parallel fibers keep folding. MV lock_controls/unlock_controls. */
  | { op: "lockInput" }
  | { op: "unlockInput" }
  /** Relocate the player or an event to a tile (MV Set Event Location).
   *  Event placement is durable for this map visit; player placement takes
   *  effect at the same end-of-tick session boundary. */
  | { op: "place"; target: RouteTarget; x: number; y: number; dir?: Dir }
  /** Game-owned pure command handler, registered on createSession(). */
  | { op: "ext"; call: string; args: JsonValue }
  /** A choice list supplied from live state by a registered pure extension.
   * The optional resolver may update extension/built-in state after a pick. */
  | {
      op: "extChoice";
      call: string;
      args: JsonValue;
      prompt: string;
      cancel?: boolean;
      write?: ExtensionChoiceWrite;
    }
  /** MV-style Battle Processing. The game assigns meaning to setup and owns
   * the pure battle reducer; the interpreter only parks/resumes the fiber. */
  | {
      op: "battle";
      setup: JsonValue;
      onWin?: Command[];
      onLose?: Command[];
      onEscape?: Command[];
    }
  /** Open a game-registered full-screen scene by id (PC, journal, name
   *  input, …). The game owns the pure SceneRules reducer and the UI
   *  component; the interpreter parks the fiber until the scene completes,
   *  then runs onDone (or onCancel when the player cancelled). The scene
   *  can write variables, switches, items, gold, the player name, ext
   *  state, and (rarely) transfer the player. */
  | {
      op: "scene";
      id: string;
      args?: JsonValue;
      onDone?: Command[];
      onCancel?: Command[];
    };

/** A page's activation gate. Every present clause must hold (AND). The
 *  four flat fields stay the v1 spelling; `all` is the compound
 *  spelling: every Condition in the list must hold, and it ANDs with the
 *  flat fields when both are authored. An `all` entry of kind "facing"
 *  additionally makes a playerTouch page re-fire when the
 *  player turns while standing in its area. */
export interface PageCondition {
  switch?: string;
  selfSwitch?: "A" | "B" | "C" | "D";
  variable?: { id: string; op: ">=" | "<=" | "==" | "!="; value: number };
  item?: string;
  all?: Condition[];
}

export interface Page {
  condition?: PageCondition;
  trigger: Trigger;
  sprite?: string | null;
  blocks?: boolean;
  /** Autonomous motion (MV moveType): "static" stands still, "random"
   *  wanders on the seeded RNG, "approach" takes one step toward the
   *  player on a timer. An explicit moveRoute overrides all three. */
  moveType?: "static" | "random" | "approach";
  /** MV page defaults. Runtime overrides reset when this event changes
   *  page, and all overrides reset on map entry. */
  moveSpeed?: MoveSpeed;
  moveFrequency?: MoveFrequency;
  directionFix?: boolean;
  through?: boolean;
  facingMode?: FacingMode;
  moveRoute?: MoveRoute;
  /** Facing the character shows when the page spawns it (the
   *  first page that creates the CharState, and again after a page
   *  switch). Defaults to down. */
  dir?: Dir;
  commands: Command[];
}

export interface GameEvent {
  id: string;
  name?: string;
  x: number;
  y: number;
  /** The event occupies the w×h rectangle with (x,y) as its
   *  top-left corner. playerTouch fires when the player enters ANY cell of
   *  the rectangle; action fires when the player confirms facing any cell
   *  of it (or stands in it). Defaults to 1×1; the schema requires >= 1. */
  w?: number;
  h?: number;
  pages: Page[];
}

export interface ParallaxDef {
  image: string | null;
  loopX: boolean;
  loopY: boolean;
  /** Signed scroll speed of a looping axis: speed/4 kit pixels per
   *  reference tick. Ignored on a non-looping axis. */
  sx: number;
  sy: number;
  zero?: boolean;
  showInEditor?: boolean;
}

export interface MapDef {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Sheet ids this map draws from. */
  sheets?: string[];
  /** Row-major, length width*height; null is a void (nothing baked). */
  ground: TileId[];
  /** Sparse star layer drawn above characters: [row-major index, tile id]. */
  upper?: [number, TileId][];
  /** Per-cell passage overrides: [index, "pass"|"block"]. */
  passage?: [number, "pass" | "block"][];
  /** Optional map backdrop and its reference-tick scroll configuration. */
  parallax?: ParallaxDef;
  /** Sparse RPG Maker region ids: [row-major index, region id]. Only cells
   *  with a nonzero region are listed; a map without them carries no data.
   *  Read by the `locationInfo` command and the `region` condition. */
  regions?: [number, number][];
  /** Sparse RPG Maker terrain tags: [row-major index, tag]. Only cells with
   *  a nonzero tag are listed; the importer derives each cell's tag from its
   *  tileset flags (the topmost tile with a tag, like MV's terrainTag). */
  terrain?: [number, number][];
  /** Sparse RPG Maker raw tile ids per cell: [row-major index, [z0, z1, z2,
   *  z3]]. Only cells with a nonzero tile in any of the four layers are
   *  listed; the importer carries the map's four raw tile-data planes so the
   *  `locationInfo` tile kind returns exactly what RPG Maker would. A
   *  hand-authored map without it answers layers 0/1 from ground/upper and
   *  layers 2/3 as 0. Order does not matter: the runtime builds a cell-index
   *  map, and a duplicate index keeps the last entry. */
  tiles?: [number, [number, number, number, number]][];
  /** Interactive events (P1③: page selection + interpretation). */
  events?: GameEvent[];
}

/** Why an event that could paint a character is not previewed. Stable codes
 * for coverage reports; each event reports the first applicable reason in
 * this declaration order. */
export type WorldPreviewRejectReason =
  /** Two events share one id and therefore one runtime character. */
  | "duplicate-id"
  /** An entry-time autorun/parallel program contains a command whose effect
   * cannot be bounded statically (extension command or choice, battle,
   * scene, shop, transfer, host menu), so no event on the map is previewed. */
  | "entry-opaque-command"
  /** A page that could be selected reads the live player facing, which on
   * entry depends on the opening used. */
  | "facing-condition"
  /** A page that could be selected reads a time- or activity-derived value
   * (worldIdle, bgmPlaying, timer). */
  | "runtime-condition"
  /** A page that could be selected reads a game extension predicate. */
  | "extension-condition"
  /** A page that could be selected reads per-visit map state (another
   * event's appearance, a runtime tile property, a region cell). */
  | "visit-condition"
  /** An entry-time autorun/parallel program moves, relocates, re-skins or
   * erases this event's character. */
  | "entry-actor-command"
  /** An entry-time autorun/parallel program writes state that this event's
   * page selection reads. */
  | "entry-state-write";

/** Why the sandboxed-entry preview (world-preview-sandbox.ts) does not show
 * an event that paints in at least one probe run. Stable codes for coverage
 * reports; each event reports the first applicable reason in this
 * declaration order. Map-wide reasons reject every event on the map that
 * could paint. */
export type SandboxPreviewRejectReason =
  /** Event: two events share one id and therefore one runtime character. */
  | "duplicate-id"
  /** Map: the base entry transferred away (or began a seamless handoff or a
   * transfer fade) before the snapshot tick. */
  | "entry-transfer"
  /** Map: the base entry started (or queued) a battle or a game scene. */
  | "entry-scene"
  /** Map: the base entry raised an interpreter error or threw. */
  | "entry-error"
  /** Map: an autorun/parallel page, or a common event it calls, branches on
   * the player's facing, the timer or the playing BGM, which the probes
   * cannot vary completely. */
  | "entry-runtime-branch"
  /** Event: the winning page or a page above it reads the player's facing. */
  | "facing-condition"
  /** Event: the winning page or a page above it reads the timer or BGM. */
  | "runtime-condition"
  /** Probe: the snapshot changes when the player arrives elsewhere and faces
   * the other way. */
  | "player-dependent"
  /** Probe: the snapshot changes with the random cursor. */
  | "random-dependent"
  /** Probe: the snapshot changes when the game's `perturbExt` hook moves the
   * extension state its preview key leaves out. */
  | "volatile-dependent";

/** One map's immutable placement in a world/component tile coordinate space.
 * Origins may be negative; width and height are the authoritative MapDef
 * dimensions rather than metadata copied from an external layout editor. */
export interface WorldPlacement {
  mapId: string;
  originTileX: number;
  originTileY: number;
  width: number;
  height: number;
}

/** Inclusive/exclusive interval on an opening's tangent tile axis. */
export interface WorldTileSpan {
  start: number;
  end: number;
}

export type WorldSide = "north" | "east" | "south" | "west";
export type WorldAxis = "x" | "y";

/** One side of an authored opening, qualified by its owning map. */
export interface WorldOpeningEndpoint {
  mapId: string;
  side: WorldSide;
  span: WorldTileSpan;
}

/** An authored map-edge portal. `offset` maps the source tangent coordinate
 * to the target tangent coordinate. Only `coordinate-preserving` openings
 * are eligible for a future seamless handoff; `portal-only` must retain the
 * project's ordinary transfer semantics. */
export interface WorldOpening {
  portalId: string;
  source: WorldOpeningEndpoint;
  target: WorldOpeningEndpoint;
  axis: WorldAxis;
  offset: number;
  compatibility: "coordinate-preserving" | "portal-only";
}

/** One evidence-approved geometric edge shared by two placements. The
 * tangent mapping is `mapB = mapA + offsetAtoB`; a seam with no opening is
 * descriptive only and does not authorize crossing. */
export interface WorldSeam {
  mapA: string;
  sideA: WorldSide;
  spanA: WorldTileSpan;
  mapB: string;
  sideB: WorldSide;
  spanB: WorldTileSpan;
  axis: WorldAxis;
  offsetAtoB: number;
  openingIds: readonly string[];
}

/** Exclusive tile bounds for one connected component. */
export interface WorldComponentBounds {
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
}

/** A connected set of placements. `worldId` and `componentId` together are
 * the namespace for every world coordinate in this component. */
export interface WorldComponent {
  worldId: string;
  componentId: string;
  bounds: WorldComponentBounds;
  placements: readonly WorldPlacement[];
  seams: readonly WorldSeam[];
  openings: readonly WorldOpening[];
}

/** Optional immutable project layout. The topology hash binds the projected
 * geometry and opening safety decisions to the project's content identity. */
export interface WorldLayout {
  topologyHash: string;
  components: readonly WorldComponent[];
}

/** A tile coordinate in either a map-local or component-world namespace. */
export interface WorldTilePoint {
  x: number;
  y: number;
}

export interface Item {
  id: string;
  name: string;
  sprite: string;
  usable?: boolean;
  /** T2-10: the item's own shop price. A shop's `goods` entry may override
   *  it per-shop for buying, and override its own sellPrice per-shop for
   *  selling; a shop with no such override sells this item at
   *  floor(price / 2). */
  price?: number;
  /** T2-10/B4: whether this item can be sold for gold at all. Absent
   *  defaults to true whenever its effective sell price (a shop's
   *  ShopGood.sellPrice override, else floor(price/2)) is > 0; an item
   *  whose effective sell price is 0 is never sellable regardless of this
   *  flag. An unsellable row still lists in the sell tab (disabled) unless
   *  the shop's `sellList` is "hide". */
  sellable?: boolean;
  /** RPG Maker item type (MV itypeId): 1 regular, 2 key, 3 hidden A,
   *  4 hidden B. Absent defaults to "regular". The select-item scene
   *  filters on this; key items are also unsellable by default on import. */
  type?: "regular" | "key" | "hiddenA" | "hiddenB";
  /** RPG Maker database kind. Absent defaults to "item". The select-item
   *  scene only lists kind "item" (MV parity: weapons and armors are never
   *  offered by Select Item, even when the party holds them). */
  kind?: "item" | "weapon" | "armor";
}

/** Optional editor-facing declaration for an event switch. Switch ids remain
 * valid when they are only referenced by event content; this catalog gives
 * tools a stable place for human-readable names and unused planned ids. */
export interface SwitchDef {
  id: string;
  name?: string;
  /** Declares that this switch is written into the switch bank by the host
   *  or an extension at runtime, never by a document command (a sim seeding
   *  growth state, a host bridging native code, …). The static checker then
   *  does not flag it as read-never-set. A bare catalog declaration without
   *  this marker is still checked — the directory alone does not prove the
   *  switch is ever written, so typos still surface. */
  writtenBy?: "host";
}

/** Optional editor-facing declaration for an event variable. Variable ids
 * remain valid when undeclared, matching the reducer's sparse value bank. */
export interface VariableDef {
  id: string;
  name?: string;
}

export interface CommonEvent {
  id: string;
  name?: string;
  trigger: "none" | "parallel";
  conditionSwitch?: string;
  commands: Command[];
}

/** A static character painted from one baked image (16x16). Page.sprite
 *  resolves through the image map. */
export interface ImageSpriteDef {
  kind: "image";
  src: string;
}

/** A grid walker sheet the asset cooker slices into twelve static frames
 *  (four facings x idle/step-L/step-R). Defaults describe the Tuxemon
 *  character sheet: 3 columns (walk-L, idle, walk-R) x 4 rows
 *  (down, left, right, up) of 16x32 cells; see tools/lib/bake.ts
 *  TUXEMON_WALKER_LAYOUT for the engine facing-row remap. The runtime draws
 *  the frame chosen from the saved CharState facing + mover phase, never a
 *  host auto-play clock, so saves stay deterministic. */
export interface WalkerSheetSpriteDef {
  kind: "walker";
  /** Build-time source sheet id/path. The runtime does not load it. */
  sheet: string;
  /** Frame height in px: 32 (default) for a 16x32 sheet whose top row
   *  overflows upward, or 16 for a square sheet. */
  h?: 16 | 32;
  /** Sheet columns (default 3: walk-L, idle, walk-R). */
  cols?: number;
  /** Sheet rows (default 4: down, left, right, up). */
  rows?: number;
}

/** Legacy v1 walker declaration retained for documents that already point
 *  at one animated atlas per direction. New importers should prefer a
 *  WalkerSheetSpriteDef and cook deterministic static frames. */
export interface WalkerAtlasSpriteDef {
  kind: "walker";
  atlases: { down: string; left: string; right: string; up: string };
  frames: number;
  step: number;
}

export type WalkerSpriteDef = WalkerSheetSpriteDef | WalkerAtlasSpriteDef;

/** Page.sprite resolves through this map: a static image or a walker sheet
 *  the cooker slices into per-facing/pose frames. */
export type SpriteDef = ImageSpriteDef | WalkerSpriteDef;

/** A deterministic cue attached to one authored animation frame. Target-
 * local flashes are intentionally not represented: importers either bake
 * them or report the semantic loss. */
export interface AnimationTimingDef {
  frame: number;
  se?: { id: string; volume?: number; pitch?: number };
  flash?: { color: ScreenColor; intensity: number; duration: number };
}

/** A frame animation a `mapAnim` command plays on the map. The sheet is
 *  cooked into one static baked image per authored frame (the same pipeline
 *  as walker sheets), so the runtime frame index is a pure function of the
 *  saved reference tick: rewind and save/load reproduce pixels exactly,
 *  and no host auto-play clock is involved. */
export interface AnimationDef {
  id: string;
  /** Build-time source sheet. The asset cooker slices it into frames; the
   *  runtime never loads it. A sheet the cooker cannot find is a build
   *  error (the importer references animations by name). */
  sheet: string;
  /** Frame size in px; defaults to 16x16 (one tile). A taller frame is
   *  anchored to its tile's bottom edge, like a 16x32 walker. */
  frameW?: number;
  frameH?: number;
  /** Sheet columns for row-major frame indexing; the cooker's own sheet
   *  metadata applies when omitted. */
  cols?: number;
  /** Frame indices into the sheet (row-major), in play order. Defaults to
   *  0..`count`-1 when `count` is given instead. */
  frames?: number[];
  /** Frame count when `frames` is omitted (sequential play order). */
  count?: number;
  /** Duration of each frame in virtual seconds. Compiled to reference
   *  ticks with the world's hz, so the same virtual instant shows the same
   *  frame at 60/30/20/4 Hz. */
  frameDuration: number;
  /** Default loop behavior; a `mapAnim` command's `loop` overrides it. */
  loop?: boolean;
  /** Sound and full-screen flash cues fired when their frame begins. The
   * timeline is folded from the saved animation start tick, including for
   * non-waited and looping playback. */
  timings?: AnimationTimingDef[];
}

/** Project-wide runtime options (RPG Maker's System settings). Every field
 *  is optional and its absence keeps the v1 behavior. */
export interface ProjectSystem {
  /** While ANY fiber's text or choices box is open — a parallel page's
   *  included — the player cannot move and no action, playerTouch or
   *  eventTouch page starts, so the confirm that advances the box never also talks to the
   *  faced event (MV $gameMessage.isBusy, Tuxemon's dialog state swallows
   *  input). autorun and parallel pages keep running. Default false: v1
   *  holds the player only for a blocking fiber or a choices box. */
  messageBlocksPlayer?: boolean;
  /** Expand `{v:<id>}` tokens in text lines and choice prompts/rows with the
   *  live value of variable `id` (0 when unset). Off by default, so text
   *  authored before the token existed keeps showing its braces verbatim. */
  textVariables?: boolean;
  /** Allowlist of `{x:<key>}` text-token keys the game's session resolver
   *  answers. Declaring it is the explicit opt-in that switches `{x:}`
   *  expansion on (like `textVariables`): without it the braces print
   *  verbatim, so text authored before the token existed is unchanged. With
   *  it, `rpgkit-check` warns on any `{x:}` key not listed; the resolver
   *  itself is code-side (`SessionOptions.textTokens`), so the checker
   *  cannot see it; an unanswered token shows `???` at runtime. */
  textTokens?: string[];
  /** Show MapDef.name in the built-in banner on map entry. Default false so
   * projects authored before the banner keep byte/pixel-identical output. */
  mapNameDisplay?: boolean;
  /** Engine-level backpack tunables (T2-10/B1). */
  inventory?: {
    /** Max count of a single item id the backpack holds; default 99
     *  (SHOP_ITEM_CAP). A buy that would exceed it is refused. */
    maxPerItem?: number;
    /** Max number of DISTINCT item ids the backpack holds; absent means
     *  unlimited. A buy that would introduce a new kind past this cap is
     *  refused even with room under maxPerItem/gold. */
    maxKinds?: number;
  };
}

export interface Project {
  format: "rpgkit-project/v1";
  title: string;
  tileSize: 16;
  start: { map: string; x: number; y: number; dir: Dir };
  /** Runtime options; see ProjectSystem. */
  system?: ProjectSystem;
  /** Map-transfer timeline identity. Missing means legacy-transfer. */
  worldTraversal?: WorldTraversalMode;
  initialGold?: number;
  /** Default name substituted for the {name} text token in a fresh
   *  playthrough. Stored in the switch bank after that, so a rename (a future
   *  op) survives saves and transfers. */
  playerName?: string;
  /** Replacements for the kit's own interface words (engine/ui-text.ts):
   *  any subset of keys, English for the rest. Presentation only — never in
   *  session state or saves. */
  uiText?: UiTextOverrides;
  sheets: Sheet[];
  items: Item[];
  /** Named switch directory for authoring tools. Event references to an id
   * that is absent here keep their existing sparse-bank runtime semantics. */
  switches?: SwitchDef[];
  /** Named variable directory for authoring tools. Event references to an id
   * that is absent here keep their existing sparse-bank runtime semantics. */
  variables?: VariableDef[];
  /** Page.sprite key -> static character image. */
  sprites?: Record<string, SpriteDef>;
  /** Frame animations playable with the `mapAnim` command, by id. */
  animations?: AnimationDef[];
  /** Logical audio id -> WAV or QOA pak key (`audio:wav.*` / `audio:qoa.*`).
   *  Host playback is opt-in; the reducer remains fully functional when this
   *  is absent. */
  audio?: Record<string, string>;
  commonEvents?: CommonEvent[];
  /** Optional world-space placement data. It is descriptive until a renderer
   * or transfer implementation explicitly opts into it. */
  worldLayout?: WorldLayout;
  maps: MapDef[];
}

/** One independently addressable map payload in a sharded project. The
 * checksum is SHA-256 over the entry's exact UTF-8 bytes. Entries may be
 * canonical MapDef JSON or the self-describing compact transport; the path
 * intentionally does not select the decoder. */
export interface MapIndexEntry {
  id: string;
  width: number;
  height: number;
  entry: string;
  sha256: string;
}

/** A large-project document keeps global data inline but moves MapDef
 * payloads into independently addressable entries. The optional hashes are
 * emitted by the kit splitter and become the runtime/save content identity.
 * Hand-built shells without a manifest remain usable because the runtime
 * computes one; untrusted declared manifests can be explicitly rechecked. */
export interface ProjectShell extends Omit<Project, "maps"> {
  mapIndex: readonly MapIndexEntry[];
  mapManifestHash?: string;
  mapSchemaHash?: string;
}

export type ProjectSource = Project | ProjectShell;

/** Synchronous map acquisition at the simulation boundary. A browser-backed
 * implementation may expose prepare(); acquire() then throws MapNotReadyError
 * until those bytes are resident. Callers pause and retry the same logical
 * input frame after prepare() resolves. */
export interface MapRepository {
  meta(id: string): MapIndexEntry | undefined;
  /** Return a runtime-validated MapDef. Implementations that decode untyped
   * bytes should validate before returning; createJsonMapRepository checks
   * compilation-critical structure by default and offers full schema
   * validation. Session additionally verifies repository metadata and
   * payload dimensions against mapIndex. */
  acquire(id: string): MapDef;
  /** Optional deterministic preparation unit for synchronous repositories.
   * One call performs at most one implementation-defined unit and returns
   * the map only once repository work is complete. Session uses this during
   * a non-zero transfer fade; acquire() still completes all remaining work. */
  acquireStep?(id: string): MapDef | undefined;
  releaseExcept(ids: readonly string[]): void;
  /** Optional residency counters, for cache-boundedness diagnostics. */
  stats?(): { cached: number; pending: number };
  prepare?(id: string): Promise<void>;
}

/** Pure simulation state for the camera slice. Position is the world-space
 *  top-left of the camera in pixels; the player focus stays screen-centered
 *  (its world position is cam + viewport center). */
export interface CameraState {
  x: number;
  y: number;
  facing: Facing;
}
