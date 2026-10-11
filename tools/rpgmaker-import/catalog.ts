// tools/rpgmaker-import/catalog.ts — every RPG Maker MV/MZ event command
// code, Conditional Branch subtype and move-route code, with what the kit
// would need to map the ones the importer cannot carry natively.
//
// `continuation` marks codes that never stand alone: the extra lines of a
// multi-line command (401 text, 405 scrolling text, 408 comment, 505 route
// display copy, 605 shop goods, 655 script, 657 MZ plugin arguments) and the
// branch markers of block commands (402/403/404 choices, 411/412 branch,
// 413 loop, 601..604 battle). Coverage counts the head command only.
//
// `sampleCommands(code)` builds a minimal, plausible list exercising one
// code (with its continuation lines and branch markers, indent 0 base). The
// tests feed every code through the converter with it, and the coverage
// report uses it to show each code's static disposition.

import type { RmAudio, RmCommand } from "./rm-types.ts";

export interface CommandInfo {
  code: number;
  name: string;
  /** Which editors write the code. 356 is the MV plugin command; MZ keeps
   *  executing it for converted projects but its editor no longer offers it. */
  flavor: "MV/MZ" | "MV" | "MZ";
  /** A continuation line or branch marker (never counted on its own). */
  continuation?: boolean;
  /** One line: what kit capability a native mapping would need, for codes
   *  the importer cannot map natively. */
  needsKit?: string;
}

export const RM_COMMANDS: readonly CommandInfo[] = [
  { code: 0, name: "End", flavor: "MV/MZ", continuation: true },
  { code: 101, name: "Show Text", flavor: "MV/MZ", needsKit: "face graphics per message (portrait keyed by file/index, not speaker); inline icons, timing/gold-window controls and MZ \\PX/\\PY/\\FS presentation" },
  { code: 401, name: "Show Text (line)", flavor: "MV/MZ", continuation: true },
  { code: 102, name: "Show Choices", flavor: "MV/MZ", needsKit: "single-option lists and a default cursor row" },
  { code: 402, name: "When [Choice]", flavor: "MV/MZ", continuation: true },
  { code: 403, name: "When Cancel", flavor: "MV/MZ", continuation: true },
  { code: 404, name: "Choices End", flavor: "MV/MZ", continuation: true },
  { code: 103, name: "Input Number", flavor: "MV/MZ" },
  { code: 104, name: "Select Item", flavor: "MV/MZ" },
  { code: 105, name: "Show Scrolling Text", flavor: "MV/MZ", needsKit: "a scrolling credits-style text box" },
  { code: 405, name: "Show Scrolling Text (line)", flavor: "MV/MZ", continuation: true },
  { code: 108, name: "Comment", flavor: "MV/MZ" },
  { code: 408, name: "Comment (line)", flavor: "MV/MZ", continuation: true },
  { code: 109, name: "Skip", flavor: "MZ" },
  { code: 111, name: "Conditional Branch", flavor: "MV/MZ", needsKit: "conditions over actor stats, enemies, event facing and buttons" },
  { code: 411, name: "Else", flavor: "MV/MZ", continuation: true },
  { code: 412, name: "Branch End", flavor: "MV/MZ", continuation: true },
  { code: 112, name: "Loop", flavor: "MV/MZ" },
  { code: 413, name: "Repeat Above", flavor: "MV/MZ", continuation: true },
  { code: 113, name: "Break Loop", flavor: "MV/MZ" },
  { code: 115, name: "Exit Event Processing", flavor: "MV/MZ", needsKit: "a return-from-common-event command (exit ends the calling fiber)" },
  { code: 117, name: "Common Event", flavor: "MV/MZ" },
  { code: 118, name: "Label", flavor: "MV/MZ" },
  { code: 119, name: "Jump to Label", flavor: "MV/MZ" },
  { code: 121, name: "Control Switches", flavor: "MV/MZ" },
  { code: 122, name: "Control Variables", flavor: "MV/MZ", needsKit: "variable sources for actor, character, party and remaining game data" },
  { code: 123, name: "Control Self Switch", flavor: "MV/MZ", needsKit: "four independent self switches per event (the kit keeps one slot)" },
  { code: 124, name: "Control Timer", flavor: "MV/MZ" },
  { code: 125, name: "Change Gold", flavor: "MV/MZ", needsKit: "gold changes by variable and a 0 floor on losses" },
  { code: 126, name: "Change Items", flavor: "MV/MZ", needsKit: "item changes by variable and a 0 floor on losses" },
  { code: 127, name: "Change Weapons", flavor: "MV/MZ", needsKit: "equipment (equipped copies) and item changes by variable" },
  { code: 128, name: "Change Armors", flavor: "MV/MZ", needsKit: "equipment (equipped copies) and item changes by variable" },
  { code: 129, name: "Change Party Member", flavor: "MV/MZ", needsKit: "a party roster (the importer keeps one switch per actor)" },
  { code: 132, name: "Change Battle BGM", flavor: "MV/MZ", needsKit: "battle audio settings in the battle setup" },
  { code: 133, name: "Change Victory ME", flavor: "MV/MZ", needsKit: "battle audio settings in the battle setup" },
  { code: 134, name: "Change Save Access", flavor: "MV/MZ" },
  { code: 135, name: "Change Menu Access", flavor: "MV/MZ" },
  { code: 136, name: "Change Encounter", flavor: "MV/MZ", needsKit: "random encounters" },
  { code: 137, name: "Change Formation Access", flavor: "MV/MZ", needsKit: "a party formation menu" },
  { code: 138, name: "Change Window Color", flavor: "MV/MZ", needsKit: "a runtime UI theme command" },
  { code: 139, name: "Change Defeat ME", flavor: "MV/MZ", needsKit: "battle audio settings in the battle setup" },
  { code: 140, name: "Change Vehicle BGM", flavor: "MV/MZ", needsKit: "vehicles" },
  { code: 201, name: "Transfer Player", flavor: "MV/MZ", needsKit: "a white transfer fade colour" },
  { code: 202, name: "Set Vehicle Location", flavor: "MV/MZ" },
  { code: 203, name: "Set Event Location", flavor: "MV/MZ", needsKit: "place by variable coordinates and character exchange" },
  { code: 204, name: "Scroll Map", flavor: "MV/MZ" },
  { code: 205, name: "Set Movement Route", flavor: "MV/MZ", needsKit: "diagonal, jump, backward/away moves, relative turns, in-route switches/SE/image" },
  { code: 505, name: "Set Movement Route (line)", flavor: "MV/MZ", continuation: true },
  { code: 206, name: "Get on/off Vehicle", flavor: "MV/MZ" },
  { code: 211, name: "Change Transparency", flavor: "MV/MZ" },
  { code: 212, name: "Show Animation", flavor: "MV/MZ" },
  { code: 213, name: "Show Balloon Icon", flavor: "MV/MZ" },
  { code: 214, name: "Erase Event", flavor: "MV/MZ" },
  { code: 216, name: "Change Player Followers", flavor: "MV/MZ" },
  { code: 217, name: "Gather Followers", flavor: "MV/MZ" },
  { code: 221, name: "Fadeout Screen", flavor: "MV/MZ" },
  { code: 222, name: "Fadein Screen", flavor: "MV/MZ" },
  { code: 223, name: "Tint Screen", flavor: "MV/MZ", needsKit: "an additive colour-tone (and greyscale) screen filter" },
  { code: 224, name: "Flash Screen", flavor: "MV/MZ" },
  { code: 225, name: "Shake Screen", flavor: "MV/MZ" },
  { code: 230, name: "Wait", flavor: "MV/MZ" },
  { code: 231, name: "Show Picture", flavor: "MV/MZ" },
  { code: 232, name: "Move Picture", flavor: "MV/MZ" },
  { code: 233, name: "Rotate Picture", flavor: "MV/MZ" },
  { code: 234, name: "Tint Picture", flavor: "MV/MZ" },
  { code: 235, name: "Erase Picture", flavor: "MV/MZ" },
  { code: 236, name: "Set Weather Effect", flavor: "MV/MZ", needsKit: "rain/storm/snow weather particles" },
  { code: 241, name: "Play BGM", flavor: "MV/MZ", needsKit: "audio pan" },
  { code: 242, name: "Fadeout BGM", flavor: "MV/MZ" },
  { code: 243, name: "Save BGM", flavor: "MV/MZ" },
  { code: 244, name: "Resume BGM", flavor: "MV/MZ" },
  { code: 245, name: "Play BGS", flavor: "MV/MZ", needsKit: "audio pan" },
  { code: 246, name: "Fadeout BGS", flavor: "MV/MZ" },
  { code: 249, name: "Play ME", flavor: "MV/MZ", needsKit: "ME length from the decoded audio file (playMe needs an authored duration)" },
  { code: 250, name: "Play SE", flavor: "MV/MZ", needsKit: "audio pan" },
  { code: 251, name: "Stop SE", flavor: "MV/MZ" },
  { code: 261, name: "Play Movie", flavor: "MV/MZ", needsKit: "video playback" },
  { code: 281, name: "Change Map Name Display", flavor: "MV/MZ" },
  { code: 282, name: "Change Tileset", flavor: "MV/MZ", needsKit: "runtime tileset swaps (a ground/upper layer variant per tileset)" },
  { code: 283, name: "Change Battle Background", flavor: "MV/MZ", needsKit: "battle backgrounds in the battle setup" },
  { code: 284, name: "Change Parallax", flavor: "MV/MZ" },
  { code: 285, name: "Get Location Info", flavor: "MV/MZ" },
  { code: 301, name: "Battle Processing", flavor: "MV/MZ", needsKit: "an RPG Maker battle system (troops, actors, skills) behind the battle op" },
  { code: 601, name: "If Win", flavor: "MV/MZ", continuation: true },
  { code: 602, name: "If Escape", flavor: "MV/MZ", continuation: true },
  { code: 603, name: "If Lose", flavor: "MV/MZ", continuation: true },
  { code: 604, name: "Battle End", flavor: "MV/MZ", continuation: true },
  { code: 302, name: "Shop Processing", flavor: "MV/MZ" },
  { code: 605, name: "Shop Processing (goods)", flavor: "MV/MZ", continuation: true },
  { code: 303, name: "Name Input Processing", flavor: "MV/MZ" },
  { code: 311, name: "Change HP", flavor: "MV/MZ", needsKit: "actor stats" },
  { code: 312, name: "Change MP", flavor: "MV/MZ", needsKit: "actor stats" },
  { code: 326, name: "Change TP", flavor: "MV/MZ", needsKit: "actor stats" },
  { code: 313, name: "Change State", flavor: "MV/MZ", needsKit: "actor states" },
  { code: 314, name: "Recover All", flavor: "MV/MZ", needsKit: "actor stats" },
  { code: 315, name: "Change EXP", flavor: "MV/MZ", needsKit: "actor experience" },
  { code: 316, name: "Change Level", flavor: "MV/MZ", needsKit: "actor levels" },
  { code: 317, name: "Change Parameter", flavor: "MV/MZ", needsKit: "actor parameters" },
  { code: 318, name: "Change Skill", flavor: "MV/MZ", needsKit: "actor skills" },
  { code: 319, name: "Change Equipment", flavor: "MV/MZ", needsKit: "equipment slots" },
  { code: 320, name: "Change Name", flavor: "MV/MZ", needsKit: "runtime names for actors other than actor 1" },
  { code: 321, name: "Change Class", flavor: "MV/MZ", needsKit: "actor classes" },
  { code: 322, name: "Change Actor Images", flavor: "MV/MZ", needsKit: "per-actor walking/face/battler images (the player sprite can change via appearance)" },
  { code: 323, name: "Change Vehicle Image", flavor: "MV/MZ" },
  { code: 324, name: "Change Nickname", flavor: "MV/MZ", needsKit: "actor profiles" },
  { code: 325, name: "Change Profile", flavor: "MV/MZ", needsKit: "actor profiles" },
  { code: 331, name: "Change Enemy HP", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 332, name: "Change Enemy MP", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 342, name: "Change Enemy TP", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 333, name: "Change Enemy State", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 334, name: "Enemy Recover All", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 335, name: "Enemy Appear", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 336, name: "Enemy Transform", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 337, name: "Show Battle Animation", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 339, name: "Force Action", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 340, name: "Abort Battle", flavor: "MV/MZ", needsKit: "an RPG Maker battle system" },
  { code: 351, name: "Open Menu Screen", flavor: "MV/MZ" },
  { code: 352, name: "Open Save Screen", flavor: "MV/MZ" },
  { code: 353, name: "Game Over", flavor: "MV/MZ" },
  { code: 354, name: "Return to Title Screen", flavor: "MV/MZ" },
  { code: 355, name: "Script", flavor: "MV/MZ", needsKit: "hand-porting: arbitrary JavaScript has no kit equivalent" },
  { code: 655, name: "Script (line)", flavor: "MV/MZ", continuation: true },
  { code: 356, name: "Plugin Command (MV)", flavor: "MV", needsKit: "a per-plugin port (an ext handler)" },
  { code: 357, name: "Plugin Command (MZ)", flavor: "MZ", needsKit: "a per-plugin port (an ext handler)" },
  { code: 657, name: "Plugin Command (MZ, argument line)", flavor: "MZ", continuation: true },
];

export const RM_COMMAND_BY_CODE: ReadonlyMap<number, CommandInfo> = new Map(
  RM_COMMANDS.map((c) => [c.code, c]),
);

/** Conditional Branch (111) subtypes, `parameters[0]`. `key` is the
 *  coverage key in the "condition" section. */
export const RM_CONDITION_TYPES: readonly { type: number; key: string; name: string }[] = [
  { type: 0, key: "switch", name: "Switch" },
  { type: 1, key: "variable", name: "Variable" },
  { type: 2, key: "selfSwitch", name: "Self Switch" },
  { type: 3, key: "timer", name: "Timer" },
  { type: 4, key: "actor", name: "Actor" },
  { type: 5, key: "enemy", name: "Enemy" },
  { type: 6, key: "character", name: "Character" },
  { type: 7, key: "gold", name: "Gold" },
  { type: 8, key: "item", name: "Item" },
  { type: 9, key: "weapon", name: "Weapon" },
  { type: 10, key: "armor", name: "Armor" },
  { type: 11, key: "button", name: "Button" },
  { type: 12, key: "script", name: "Script" },
  { type: 13, key: "vehicle", name: "Vehicle" },
];

/** Move route command codes (Game_Character.ROUTE_*). `key` is the coverage
 *  key in the "route" section. */
export const RM_ROUTE_CODES: readonly { code: number; key: string; name: string }[] = [
  { code: 0, key: "end", name: "End of Route" },
  { code: 1, key: "moveDown", name: "Move Down" },
  { code: 2, key: "moveLeft", name: "Move Left" },
  { code: 3, key: "moveRight", name: "Move Right" },
  { code: 4, key: "moveUp", name: "Move Up" },
  { code: 5, key: "moveLowerLeft", name: "Move Lower Left" },
  { code: 6, key: "moveLowerRight", name: "Move Lower Right" },
  { code: 7, key: "moveUpperLeft", name: "Move Upper Left" },
  { code: 8, key: "moveUpperRight", name: "Move Upper Right" },
  { code: 9, key: "moveRandom", name: "Move at Random" },
  { code: 10, key: "moveTowardPlayer", name: "Move toward Player" },
  { code: 11, key: "moveAwayFromPlayer", name: "Move away from Player" },
  { code: 12, key: "moveForward", name: "1 Step Forward" },
  { code: 13, key: "moveBackward", name: "1 Step Backward" },
  { code: 14, key: "jump", name: "Jump" },
  { code: 15, key: "wait", name: "Wait" },
  { code: 16, key: "turnDown", name: "Turn Down" },
  { code: 17, key: "turnLeft", name: "Turn Left" },
  { code: 18, key: "turnRight", name: "Turn Right" },
  { code: 19, key: "turnUp", name: "Turn Up" },
  { code: 20, key: "turn90Right", name: "Turn 90° Right" },
  { code: 21, key: "turn90Left", name: "Turn 90° Left" },
  { code: 22, key: "turn180", name: "Turn 180°" },
  { code: 23, key: "turn90RightOrLeft", name: "Turn 90° Right or Left" },
  { code: 24, key: "turnRandom", name: "Turn at Random" },
  { code: 25, key: "turnTowardPlayer", name: "Turn toward Player" },
  { code: 26, key: "turnAwayFromPlayer", name: "Turn away from Player" },
  { code: 27, key: "switchOn", name: "Switch ON" },
  { code: 28, key: "switchOff", name: "Switch OFF" },
  { code: 29, key: "changeSpeed", name: "Change Speed" },
  { code: 30, key: "changeFrequency", name: "Change Frequency" },
  { code: 31, key: "walkingAnimationOn", name: "Walking Animation ON" },
  { code: 32, key: "walkingAnimationOff", name: "Walking Animation OFF" },
  { code: 33, key: "steppingAnimationOn", name: "Stepping Animation ON" },
  { code: 34, key: "steppingAnimationOff", name: "Stepping Animation OFF" },
  { code: 35, key: "directionFixOn", name: "Direction Fix ON" },
  { code: 36, key: "directionFixOff", name: "Direction Fix OFF" },
  { code: 37, key: "throughOn", name: "Through ON" },
  { code: 38, key: "throughOff", name: "Through OFF" },
  { code: 39, key: "transparentOn", name: "Transparent ON" },
  { code: 40, key: "transparentOff", name: "Transparent OFF" },
  { code: 41, key: "changeImage", name: "Change Image" },
  { code: 42, key: "changeOpacity", name: "Change Opacity" },
  { code: 43, key: "changeBlendMode", name: "Change Blend Mode" },
  { code: 44, key: "playSe", name: "Play SE" },
  { code: 45, key: "script", name: "Script" },
];

export const RM_ROUTE_BY_CODE: ReadonlyMap<number, { code: number; key: string; name: string }> = new Map(
  RM_ROUTE_CODES.map((r) => [r.code, r]),
);

const AUDIO: RmAudio = { name: "Sample", volume: 90, pitch: 100, pan: 0 };
const cmd = (code: number, indent: number, parameters: unknown[]): RmCommand => ({ code, indent, parameters });
const END = (indent: number): RmCommand => cmd(0, indent, []);

/** A minimal, plausible command list exercising `code`, ending with the
 *  list terminator. [] for continuation lines and branch markers. */
export function sampleCommands(code: number): RmCommand[] {
  const info = RM_COMMAND_BY_CODE.get(code);
  if (!info || info.continuation) return [];
  const body = sampleBody(code);
  return [...body, END(0)];
}

function sampleBody(code: number): RmCommand[] {
  switch (code) {
    case 101: return [cmd(101, 0, ["", 0, 0, 2]), cmd(401, 0, ["Hello there."])];
    case 102:
      return [
        cmd(102, 0, [["Yes", "No"], 1, 0, 2, 0]),
        cmd(402, 0, [0, "Yes"]), END(1),
        cmd(402, 0, [1, "No"]), END(1),
        cmd(404, 0, []),
      ];
    case 103: return [cmd(103, 0, [1, 2])];
    case 104: return [cmd(104, 0, [1, 2])];
    case 105: return [cmd(105, 0, [2, false]), cmd(405, 0, ["Long ago..."])];
    case 108: return [cmd(108, 0, ["A note"]), cmd(408, 0, ["more"])];
    case 109: return [cmd(109, 0, [])];
    case 111: return [cmd(111, 0, [0, 1, 0]), END(1), cmd(412, 0, [])];
    case 112: return [cmd(112, 0, []), cmd(230, 1, [60]), END(1), cmd(413, 0, [])];
    case 113: return [cmd(112, 0, []), cmd(113, 1, []), END(1), cmd(413, 0, [])];
    case 115: return [cmd(115, 0, [])];
    case 117: return [cmd(117, 0, [1])];
    case 118: return [cmd(118, 0, ["Top"])];
    case 119: return [cmd(119, 0, ["Top"])];
    case 121: return [cmd(121, 0, [1, 1, 0])];
    case 122: return [cmd(122, 0, [1, 1, 0, 0, 5])];
    case 123: return [cmd(123, 0, ["A", 0])];
    case 124: return [cmd(124, 0, [0, 60])];
    case 125: return [cmd(125, 0, [0, 0, 100])];
    case 126: return [cmd(126, 0, [1, 0, 0, 1])];
    case 127: return [cmd(127, 0, [1, 0, 0, 1, false])];
    case 128: return [cmd(128, 0, [1, 0, 0, 1, false])];
    case 129: return [cmd(129, 0, [2, 0, false])];
    case 132: return [cmd(132, 0, [AUDIO])];
    case 133: return [cmd(133, 0, [AUDIO])];
    case 134: return [cmd(134, 0, [0])];
    case 135: return [cmd(135, 0, [0])];
    case 136: return [cmd(136, 0, [0])];
    case 137: return [cmd(137, 0, [0])];
    case 138: return [cmd(138, 0, [[0, 0, 0, 0]])];
    case 139: return [cmd(139, 0, [AUDIO])];
    case 140: return [cmd(140, 0, [0, AUDIO])];
    case 201: return [cmd(201, 0, [0, 1, 5, 5, 2, 0])];
    case 202: return [cmd(202, 0, [0, 0, 1, 5, 5])];
    case 203: return [cmd(203, 0, [0, 0, 5, 5, 2])];
    case 204: return [cmd(204, 0, [2, 3, 4, true])];
    case 205: {
      const route = { list: [{ code: 1, indent: null }, { code: 0 }], repeat: false, skippable: false, wait: true };
      return [cmd(205, 0, [-1, route]), cmd(505, 0, [{ code: 1, indent: null }])];
    }
    case 206: return [cmd(206, 0, [])];
    case 211: return [cmd(211, 0, [0])];
    case 212: return [cmd(212, 0, [-1, 1, false])];
    case 213: return [cmd(213, 0, [-1, 1, false])];
    case 214: return [cmd(214, 0, [])];
    case 216: return [cmd(216, 0, [0])];
    case 217: return [cmd(217, 0, [])];
    case 221: return [cmd(221, 0, [])];
    case 222: return [cmd(222, 0, [])];
    case 223: return [cmd(223, 0, [[-68, -68, 0, 68], 60, true])];
    case 224: return [cmd(224, 0, [[255, 255, 255, 170], 60, true])];
    case 225: return [cmd(225, 0, [5, 5, 60, true])];
    case 230: return [cmd(230, 0, [60])];
    case 231: return [cmd(231, 0, [1, "Sample", 1, 1, 2, 3, 150, 75, 128, 2])];
    case 232: return [cmd(232, 0, [1, 0, 1, 1, 2, 3, 150, 75, 128, 2, 60, true, 3])];
    case 233: return [cmd(233, 0, [1, -10])];
    case 234: return [cmd(234, 0, [1, [-68, 34, 0, 128], 60, true])];
    case 235: return [cmd(235, 0, [1])];
    case 236: return [cmd(236, 0, ["rain", 5, 60, false])];
    case 241: return [cmd(241, 0, [AUDIO])];
    case 242: return [cmd(242, 0, [3])];
    case 243: return [cmd(243, 0, [])];
    case 244: return [cmd(244, 0, [])];
    case 245: return [cmd(245, 0, [AUDIO])];
    case 246: return [cmd(246, 0, [3])];
    case 249: return [cmd(249, 0, [AUDIO])];
    case 250: return [cmd(250, 0, [AUDIO])];
    case 251: return [cmd(251, 0, [])];
    case 261: return [cmd(261, 0, ["Opening"])];
    case 281: return [cmd(281, 0, [0])];
    case 282: return [cmd(282, 0, [1])];
    case 283: return [cmd(283, 0, ["", ""])];
    case 284: return [cmd(284, 0, ["", false, false, 0, 0])];
    case 285: return [cmd(285, 0, [1, 0, 0, 0, 0])];
    case 301:
      return [
        cmd(301, 0, [0, 1, true, true]),
        cmd(601, 0, []), END(1),
        cmd(602, 0, []), END(1),
        cmd(603, 0, []), END(1),
        cmd(604, 0, []),
      ];
    case 302: return [cmd(302, 0, [0, 1, 0, 0, false]), cmd(605, 0, [1, 1, 1, 500])];
    case 303: return [cmd(303, 0, [1, 8])];
    case 311: return [cmd(311, 0, [0, 1, 0, 0, 10, false])];
    case 312: return [cmd(312, 0, [0, 1, 0, 0, 10])];
    case 326: return [cmd(326, 0, [0, 1, 0, 0, 10])];
    case 313: return [cmd(313, 0, [0, 1, 0, 1])];
    case 314: return [cmd(314, 0, [0, 1])];
    case 315: return [cmd(315, 0, [0, 1, 0, 0, 10, false])];
    case 316: return [cmd(316, 0, [0, 1, 0, 0, 1, false])];
    case 317: return [cmd(317, 0, [0, 1, 0, 0, 0, 10])];
    case 318: return [cmd(318, 0, [0, 1, 0, 1])];
    case 319: return [cmd(319, 0, [1, 1, 1])];
    case 320: return [cmd(320, 0, [1, "Hero"])];
    case 321: return [cmd(321, 0, [1, 1, false])];
    case 322: return [cmd(322, 0, [1, "Actor1", 0, "Actor1", 0, "Actor1_1"])];
    case 323: return [cmd(323, 0, [0, "Vehicle", 0])];
    case 324: return [cmd(324, 0, [1, "Nick"])];
    case 325: return [cmd(325, 0, [1, "Profile"])];
    case 331: return [cmd(331, 0, [0, 0, 0, 10, false])];
    case 332: return [cmd(332, 0, [0, 0, 0, 10])];
    case 342: return [cmd(342, 0, [0, 0, 0, 10])];
    case 333: return [cmd(333, 0, [0, 0, 1])];
    case 334: return [cmd(334, 0, [0])];
    case 335: return [cmd(335, 0, [0])];
    case 336: return [cmd(336, 0, [0, 1])];
    case 337: return [cmd(337, 0, [0, 1, false])];
    case 339: return [cmd(339, 0, [0, 0, 1, -1])];
    case 340: return [cmd(340, 0, [])];
    case 351: return [cmd(351, 0, [])];
    case 352: return [cmd(352, 0, [])];
    case 353: return [cmd(353, 0, [])];
    case 354: return [cmd(354, 0, [])];
    case 355: return [cmd(355, 0, ["$gameVariables.setValue(1, 2);"]), cmd(655, 0, ["console.log(1);"])];
    case 356: return [cmd(356, 0, ["ShowMap 1"])];
    case 357: return [cmd(357, 0, ["SamplePlugin", "show", "Show", { id: "1" }]), cmd(657, 0, ["Id = 1"])];
    default: return [cmd(code, 0, [])];
  }
}
