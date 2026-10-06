// editor/api/tools.ts — MCP-visible descriptions for the edit operations.

import { EDIT_COMMANDS, type EditCommandName } from "./types.ts";

export interface EditToolDefinition {
  kind: "edit";
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  command: EditCommandName;
  mutates: boolean;
}

const file = {
  type: "string",
  minLength: 1,
  description: "Path inside --root to an inline rpgkit-project/v1 document or ProjectShell. Relative paths resolve from the server working directory; shell shard entries must also remain inside --root.",
};
const map = { type: "string", minLength: 1, description: "Stable map id returned by rpgkit_maps_list." };
const event = { type: "string", minLength: 1, description: "Stable map-local event id returned by rpgkit_events_list." };
const page = { type: "integer", minimum: 0, description: "Zero-based page index returned by rpgkit_pages_list." };
const item = { type: "string", minLength: 1, description: "Stable item id returned by rpgkit_items_list." };
const sprite = { type: "string", minLength: 1, description: "Stable sprite id returned by rpgkit_sprites_list." };
const audio = { type: "string", minLength: 1, description: "Stable logical audio id returned by rpgkit_audio_list." };
const sheet = { type: "string", minLength: 1, description: "Stable tile-sheet id returned by rpgkit_sheets_list." };
const switchId = { type: "string", minLength: 1, description: "Switch id returned by rpgkit_switches_list." };
const variable = { type: "string", minLength: 1, description: "Variable id returned by rpgkit_variables_list." };
const tile = { type: ["string", "null"], description: "Tile id such as town.43, or null to erase." };
const layer = { type: "string", enum: ["ground", "upper"], default: "ground" };
const mapChanges = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_-]+$" },
    name: { type: "string", minLength: 1, maxLength: 40 },
    width: { type: "integer", minimum: 1, maximum: 256 },
    height: { type: "integer", minimum: 1, maximum: 256 },
    sheets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
  },
};
const passage = { type: ["string", "null"], enum: ["pass", "block", null], description: "Per-cell passage override, or null to clear it." };
const rectLayer = { type: "string", enum: ["ground", "upper", "passage"], default: "ground" };
const roomDoors = {
  type: "array",
  uniqueItems: true,
  description: "Absolute [x, y] cells on the rectangle border. A room template paints each door passable; omitted means a sealed room.",
  items: {
    type: "array",
    minItems: 2,
    maxItems: 2,
    prefixItems: [
      { type: "integer", minimum: 0, description: "Column." },
      { type: "integer", minimum: 0, description: "Row." },
    ],
    items: { type: "integer", minimum: 0 },
  },
};
const cells = {
  type: "array",
  minItems: 1,
  description: "Free-form brush path of [x, y] cells, painted in order as one stroke. Every cell must be in bounds; duplicates are harmless; at most width*height entries.",
  items: {
    type: "array",
    minItems: 2,
    maxItems: 2,
    prefixItems: [
      { type: "integer", minimum: 0, description: "Column." },
      { type: "integer", minimum: 0, description: "Row." },
    ],
    items: { type: "integer", minimum: 0 },
  },
};
const paintLayer = { type: "string", enum: ["ground", "upper", "passage"], default: "ground" };
const paintValue = {
  type: ["string", "null"],
  description: "For ground/upper: a tile id such as town.43 declared by the map, or null to erase. For passage: pass, block, or null to clear the override.",
};
const paintValues = {
  type: "array",
  minItems: 1,
  description: "One paint value per cells entry, in the same order. Use this instead of value for a patterned stroke.",
  items: paintValue,
};
const edgeBrush = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "dir"],
      properties: {
        kind: { enum: ["enter", "exit"], description: "Toggle a one-way enter/exit edge on each touched sheet cell." },
        dir: { enum: ["up", "down", "left", "right"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "clear", description: "Remove each touched sheet cell's dirEdges entry." } },
    },
  ],
};
const dryRun = { type: "boolean", default: false, description: "Compute and validate the edit, diff and reversible patch without writing the file." };
const address = {
  type: "object",
  additionalProperties: false,
  required: ["path", "index"],
  properties: {
    path: {
      type: "array",
      description: "Recursive command-list path. Use the commandAddress returned by rpgkit_commands_list; [] is the page root.",
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "if" }, index: { type: "integer", minimum: 0 }, branch: { enum: ["then", "else"] } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch", "option"], properties: { kind: { const: "choices" }, index: { type: "integer", minimum: 0 }, branch: { const: "option" }, option: { type: "integer", minimum: 0 } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "choices" }, index: { type: "integer", minimum: 0 }, branch: { const: "cancel" } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "battle" }, index: { type: "integer", minimum: 0 }, branch: { enum: ["win", "lose", "escape"] } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "scene" }, index: { type: "integer", minimum: 0 }, branch: { enum: ["done", "cancel"] } } },
          { type: "object", additionalProperties: false, required: ["kind", "index", "branch"], properties: { kind: { const: "loop" }, index: { type: "integer", minimum: 0 }, branch: { const: "body" } } },
        ],
      },
    },
    index: { type: "integer", minimum: 0, description: "Command index, or insertion slot when inserting." },
  },
};

const commandValue = {
  type: "object",
  required: ["op"],
  properties: { op: { type: "string", minLength: 1 } },
  description: "Complete Command object. Nested payloads are checked against the project schema before write.",
};

const pageValue = {
  type: "object",
  additionalProperties: false,
  required: ["trigger", "commands"],
  properties: {
    condition: { type: "object", description: "PageCondition object." },
    trigger: { enum: ["action", "playerTouch", "eventTouch", "autorun", "parallel"] },
    sprite: { type: ["string", "null"] },
    blocks: { type: "boolean" },
    moveType: { enum: ["static", "random", "approach"] },
    moveRoute: { type: "object" },
    moveSpeed: { type: "integer", minimum: 1, maximum: 6 },
    moveFrequency: { type: "integer", minimum: 1, maximum: 5 },
    directionFix: { type: "boolean" },
    through: { type: "boolean" },
    facingMode: { enum: ["followMovement", "locked", "scripted"] },
    dir: { enum: ["down", "left", "right", "up"] },
    commands: { type: "array", items: commandValue },
  },
};

const eventValue = {
  type: "object",
  additionalProperties: false,
  required: ["id", "x", "y", "pages"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    name: { type: "string" },
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    w: { type: "integer", minimum: 1 },
    h: { type: "integer", minimum: 1 },
    pages: { type: "array", minItems: 1, items: pageValue },
  },
};

const itemValue = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "sprite"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9_-]+$" },
    name: { type: "string", minLength: 1, maxLength: 24 },
    sprite: { type: "string", pattern: "^[a-z0-9_-]+\\.[0-9]+$" },
    usable: { type: "boolean" },
    price: { type: "integer", minimum: 0 },
    sellable: { type: "boolean" },
    type: { enum: ["regular", "key", "hiddenA", "hiddenB"] },
    kind: { enum: ["item", "weapon", "armor"] },
  },
};

const itemChanges = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: itemValue.properties.name,
    sprite: itemValue.properties.sprite,
    usable: { type: ["boolean", "null"] },
    price: { type: ["integer", "null"], minimum: 0 },
    sellable: { type: ["boolean", "null"] },
    type: { type: ["string", "null"], enum: ["regular", "key", "hiddenA", "hiddenB", null] },
    kind: { type: ["string", "null"], enum: ["item", "weapon", "armor", null] },
  },
};

const spriteValue = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "src"],
      properties: { kind: { const: "image" }, src: { type: "string", minLength: 1 } },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "atlases", "frames", "step"],
      properties: {
        kind: { const: "walker" },
        atlases: {
          type: "object", additionalProperties: false, required: ["down", "left", "right", "up"],
          properties: {
            down: { type: "string", minLength: 1 }, left: { type: "string", minLength: 1 },
            right: { type: "string", minLength: 1 }, up: { type: "string", minLength: 1 },
          },
        },
        frames: { type: "integer", minimum: 1, maximum: 8 },
        step: { type: "integer", minimum: 1, maximum: 60 },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "sheet"],
      properties: {
        kind: { const: "walker" }, sheet: { type: "string", minLength: 1 },
        h: { type: "integer", enum: [16, 32] }, cols: { type: "integer", minimum: 3, maximum: 32 },
        rows: { type: "integer", minimum: 4, maximum: 32 },
      },
    },
  ],
};

const audioValue = { type: "string", pattern: "^audio:(wav|qoa)\\..+$" };
const directionList = { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["down", "left", "right", "up"] } };
const sheetFields = {
  pak: { type: "string", minLength: 1 },
  cols: { type: "integer", minimum: 1, maximum: 256 },
  rows: { type: "integer", minimum: 1, maximum: 256 },
  defaultPassage: { enum: ["pass", "block"] },
  block: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 0 } },
  pass: { type: "array", uniqueItems: true, items: { type: "integer", minimum: 0 } },
  dirBlock: { type: "object", additionalProperties: directionList },
  dirEdges: {
    type: "object",
    additionalProperties: {
      type: "object", additionalProperties: false,
      properties: { enter: directionList, exit: directionList },
    },
  },
};
const sheetValue = {
  type: "object", additionalProperties: false, required: ["id", "pak", "cols", "rows"],
  properties: { id: { type: "string", pattern: "^[a-z0-9_-]+$" }, ...sheetFields },
};
const nullable = (value: Record<string, unknown>): Record<string, unknown> => ({
  ...value,
  type: Array.isArray(value.type) ? [...value.type, "null"] : [value.type, "null"],
  ...(value.enum === undefined ? {} : { enum: [...value.enum as unknown[], null] }),
});
const sheetChanges = {
  type: "object", additionalProperties: false, minProperties: 1,
  properties: {
    pak: sheetFields.pak,
    cols: sheetFields.cols,
    rows: sheetFields.rows,
    defaultPassage: { type: ["string", "null"], enum: ["pass", "block", null] },
    block: nullable(sheetFields.block),
    pass: nullable(sheetFields.pass),
    dirBlock: nullable(sheetFields.dirBlock),
    dirEdges: nullable(sheetFields.dirEdges),
  },
};
const catalogNameValue = {
  type: "object", additionalProperties: false, required: ["id"],
  properties: { id: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" }, name: { type: "string", minLength: 1, maxLength: 80 } },
};
const catalogNameChanges = {
  type: "object", additionalProperties: false, minProperties: 1,
  properties: { name: { type: ["string", "null"], minLength: 1, maxLength: 80 } },
};

const patchSide = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["exists"], properties: { exists: { const: false } } },
    { type: "object", additionalProperties: false, required: ["exists", "value"], properties: { exists: { const: true }, value: {} } },
  ],
};

const patchValue = {
  type: "object",
  additionalProperties: false,
  required: ["format", "beforeHash", "afterHash", "changes"],
  properties: {
    format: { const: "rpgkit-edit/patch-v1" },
    beforeHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    afterHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "before", "after"],
        properties: { path: { type: "string" }, before: patchSide, after: patchSide },
      },
    },
  },
};

const batchOperation = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: {
      type: "string",
      enum: EDIT_COMMANDS.filter((name) => name !== "batch" && name !== "save" && name !== "open" &&
        !name.startsWith("list-") && name !== "validate"),
      description: "An editing operation to run inside the transaction. Read commands, save and nested batch are not allowed.",
    },
    args: { type: "object", description: "The operation's arguments, as for the standalone command." },
  },
};

const envelope = {
  type: "string",
  enum: ["full", "compact"],
  default: "full",
  description: "full (default): structural diff and reversible patch. compact: omit both and return a smaller semanticDiff summary (array inserts/removes/moves, per-cell passage changes).",
};

function schema(
  properties: Record<string, unknown>,
  required: string[],
  mutates = false,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["file", ...required],
    properties: { file, ...properties, ...(mutates ? { dryRun, envelope } : {}) },
  };
}

function tool(
  name: string,
  title: string,
  command: EditCommandName,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  mutates = false,
): EditToolDefinition {
  return { kind: "edit", name, title, command, description, inputSchema: schema(properties, required, mutates), mutates };
}

function exactlyOneOf(
  definition: EditToolDefinition,
  first: string,
  second: string,
): EditToolDefinition {
  definition.inputSchema.oneOf = [{ required: [first] }, { required: [second] }];
  return definition;
}

function withVariants(
  definition: EditToolDefinition,
  variants: readonly Record<string, unknown>[],
): EditToolDefinition {
  definition.inputSchema.oneOf = variants;
  return definition;
}

/** Ordered registry used for both tools/list and tools/call dispatch. */
export const EDIT_TOOLS: readonly EditToolDefinition[] = [
  tool("rpgkit_project_open", "Open RPG Kit project", "open", "Validate and summarize an inline project or editable ProjectShell. Opening a shell reads no map shards."),
  tool("rpgkit_maps_list", "List maps", "list-maps", "List maps with deterministic map:<id> addresses. ProjectShell map indexes are supported without loading their shards."),
  tool("rpgkit_events_list", "List map events", "list-events", "List every event on the selected map with stable map/event addresses and page counts. A shell loads only that map's shard.", { map }, ["map"]),
  tool("rpgkit_pages_list", "List event pages", "list-pages", "List pages in priority order with stable map/event/page addresses, conditions, triggers and command counts. A shell loads only the selected map's shard.", { map, event }, ["map", "event"]),
  tool("rpgkit_commands_list", "List command tree", "list-commands", "Flatten one page's recursive command tree. Each row includes a reusable structured commandAddress, stable text address, branch, summary and read-only flag. A shell loads only the selected map's shard.", { map, event, page }, ["map", "event", "page"]),
  tool("rpgkit_items_list", "List items", "list-items", "List item definitions and known reference counts in author order."),
  tool("rpgkit_item_get", "Get item", "get-item", "Read one item definition and every statically typed project reference.", { item }, ["item"]),
  tool("rpgkit_item_add", "Add item", "add-item", "Append one complete item definition to the project catalog.", { item: itemValue }, ["item"], true),
  tool("rpgkit_item_update", "Update item", "update-item", "Update fields of an item without changing its stable id. null removes an optional field.", { item, changes: itemChanges }, ["item", "changes"], true),
  tool("rpgkit_item_remove", "Remove item", "remove-item", "Remove an unreferenced item. RESOURCE_IN_USE returns every known reference without changing the project.", { item }, ["item"], true),
  tool("rpgkit_sprites_list", "List sprites", "list-sprites", "List sprite definitions and known reference counts in id order."),
  tool("rpgkit_sprite_get", "Get sprite", "get-sprite", "Read one sprite definition and every statically typed project reference.", { sprite }, ["sprite"]),
  tool("rpgkit_sprite_add", "Add sprite", "add-sprite", "Add one keyed sprite definition.", { sprite, value: spriteValue }, ["sprite", "value"], true),
  tool("rpgkit_sprite_update", "Update sprite", "update-sprite", "Replace one sprite definition without changing its stable id.", { sprite, value: spriteValue }, ["sprite", "value"], true),
  tool("rpgkit_sprite_remove", "Remove sprite", "remove-sprite", "Remove an unreferenced sprite. RESOURCE_IN_USE returns every known reference without changing the project.", { sprite }, ["sprite"], true),
  tool("rpgkit_audio_list", "List audio", "list-audio", "List logical audio ids, pak values and known reference counts in id order."),
  tool("rpgkit_audio_get", "Get audio", "get-audio", "Read one logical audio entry and every statically typed project reference.", { audio }, ["audio"]),
  tool("rpgkit_audio_add", "Add audio", "add-audio", "Add one logical audio id and WAV/QOA pak value.", { audio, value: audioValue }, ["audio", "value"], true),
  tool("rpgkit_audio_update", "Update audio", "update-audio", "Replace one logical audio pak value without changing its stable id.", { audio, value: audioValue }, ["audio", "value"], true),
  tool("rpgkit_audio_remove", "Remove audio", "remove-audio", "Remove an unreferenced logical audio entry. RESOURCE_IN_USE returns every known reference without changing the project.", { audio }, ["audio"], true),
  tool("rpgkit_sheets_list", "List tile sheets", "list-sheets", "List tile-sheet definitions and known reference counts in author order."),
  tool("rpgkit_sheet_get", "Get tile sheet", "get-sheet", "Read one tile-sheet definition and every map, tile and item reference.", { sheet }, ["sheet"]),
  tool("rpgkit_sheet_add", "Add tile sheet", "add-sheet", "Append one complete tile-sheet definition to the project catalog.", { sheet: sheetValue }, ["sheet"], true),
  tool("rpgkit_sheet_update", "Update tile sheet", "update-sheet", "Update fields of a tile sheet without changing its stable id. null removes an optional field.", { sheet, changes: sheetChanges }, ["sheet", "changes"], true),
  tool("rpgkit_sheet_remove", "Remove tile sheet", "remove-sheet", "Remove an unreferenced tile sheet. RESOURCE_IN_USE returns every known reference without changing the project.", { sheet }, ["sheet"], true),
  tool("rpgkit_switches_list", "List switches", "list-switches", "List declared switch names plus ids used implicitly by event content."),
  tool("rpgkit_switch_get", "Get switch", "get-switch", "Read one declared or implicit switch and every known read/write reference.", { switch: switchId }, ["switch"]),
  tool("rpgkit_switch_add", "Add switch", "add-switch", "Add an optional named switch declaration; runtime switch ids remain sparse.", { switch: catalogNameValue }, ["switch"], true),
  tool("rpgkit_switch_update", "Update switch", "update-switch", "Update the name of a declared switch without renaming its id. null removes the name.", { switch: switchId, changes: catalogNameChanges }, ["switch", "changes"], true),
  tool("rpgkit_switch_remove", "Remove switch", "remove-switch", "Remove an unreferenced switch declaration. RESOURCE_IN_USE returns every known reference without changing the project.", { switch: switchId }, ["switch"], true),
  tool("rpgkit_variables_list", "List variables", "list-variables", "List declared variable names plus ids used implicitly by event content."),
  tool("rpgkit_variable_get", "Get variable", "get-variable", "Read one declared or implicit variable and every known read/write reference.", { variable }, ["variable"]),
  tool("rpgkit_variable_add", "Add variable", "add-variable", "Add an optional named variable declaration; runtime variable ids remain sparse.", { variable: catalogNameValue }, ["variable"], true),
  tool("rpgkit_variable_update", "Update variable", "update-variable", "Update the name of a declared variable without renaming its id. null removes the name.", { variable, changes: catalogNameChanges }, ["variable", "changes"], true),
  tool("rpgkit_variable_remove", "Remove variable", "remove-variable", "Remove an unreferenced variable declaration. RESOURCE_IN_USE returns every known reference without changing the project.", { variable }, ["variable"], true),
  tool("rpgkit_map_update", "Update map properties", "update-map", "Rename a map or update its display name, size and sheet list through the editor model. For a shell, ordinary changes load one shard; an id rename scans all shards to rewrite literal transfers but writes only changed shards.", { map, changes: mapChanges }, ["map", "changes"], true),
  tool("rpgkit_map_add", "Add map", "add-map", "Create an empty map through the editor model, inserted after `after` (default: the last map). `map` is a preferred id; a taken or unsafe id is made unique, so read the created MapDef from the result. Sheets default to the anchor map's sheets; fill defaults to void. Inline projects only.", { map: { type: "string", minLength: 1, description: "Preferred new map id; the model makes it schema-safe and unique." }, name: { type: "string", maxLength: 40 }, width: { type: "integer", minimum: 1, maximum: 256, default: 20 }, height: { type: "integer", minimum: 1, maximum: 256, default: 14 }, sheets: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, fill: { type: ["string", "null"], description: "Ground tile for every cell, such as town.0, or null for void." }, after: { type: "string", minLength: 1, description: "Existing map id to insert after." } }, [], true),
  tool("rpgkit_map_duplicate", "Duplicate map", "duplicate-map", "Copy a map (events keep their map-local ids) directly after it under a unique <id>-copy id. Inline projects only.", { map }, ["map"], true),
  tool("rpgkit_map_delete", "Delete map", "delete-map", "Delete a map. Refuses the only map and the start map with MAP_DELETE_REFUSED. Literal transfers into the map are kept and listed in result.references. Inline projects only.", { map }, ["map"], true),
  tool("rpgkit_map_move", "Move map", "move-map", "Move a map to a zero-based final position in the map list. Ids are unchanged, so the start map and transfers are unaffected; the same index succeeds with changed:false. Inline projects only.", { map, index: { type: "integer", minimum: 0, description: "Final zero-based position of the map in the project's map list." } }, ["map", "index"], true),
  tool("rpgkit_tile_paint", "Paint one tile", "paint-tile", "Paint or erase one ground/upper cell using the editor stroke model. The tile must belong to a sheet declared by the map.", { map, layer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, tile }, ["map", "x", "y", "tile"], true),
  withVariants(tool("rpgkit_tile_rect", "Paint rectangle", "paint-rect", "Paint or erase a complete in-bounds ground, upper or passage rectangle as one editor stroke and one reversible patch. Passage rectangles accept a uniform value, or template:room with optional border door cells.", { map, layer: rectLayer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, tile, value: passage, template: { const: "room" }, doors: roomDoors }, ["map", "x", "y", "width", "height"], true), [
    {
      required: ["tile"],
      properties: { layer: { enum: ["ground", "upper"] } },
      not: { anyOf: [{ required: ["value"] }, { required: ["template"] }, { required: ["doors"] }] },
    },
    {
      required: ["layer", "value"],
      properties: { layer: { const: "passage" } },
      not: { anyOf: [{ required: ["tile"] }, { required: ["template"] }, { required: ["doors"] }] },
    },
    {
      required: ["layer", "template"],
      properties: { layer: { const: "passage" }, template: { const: "room" } },
      not: { anyOf: [{ required: ["tile"] }, { required: ["value"] }] },
    },
  ]),
  tool("rpgkit_tile_fill", "Flood-fill tile region", "fill-region", "Four-way flood-fill the contiguous region containing x,y on ground or upper. null erases the region.", { map, layer, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, tile }, ["map", "x", "y", "tile"], true),
  tool("rpgkit_passage_paint", "Paint passage override", "paint-passage", "Set one map cell's passage override to pass or block, or clear it with null, through the editor stroke model.", { map, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, value: passage }, ["map", "x", "y", "value"], true),
  exactlyOneOf(tool("rpgkit_cells_paint", "Paint brush stroke", "paint-cells", "Paint an arbitrary list of cells on the ground, upper or passage layer as one editor stroke and one reversible patch. Pass one value for a uniform stroke, or a parallel values array for a patterned stroke. Ground/upper take tile ids or null; passage takes pass, block or null.", { map, layer: paintLayer, cells, value: paintValue, values: paintValues }, ["map", "cells"], true), "value", "values"),
  tool("rpgkit_edges_paint", "Paint sheet edges", "paint-edges", "Toggle or clear one-way passage edges (sheet dirEdges) for the ground tiles under the given cells, as one stroke. Edges are project-global: every map using that tile is affected, void cells are skipped, and each sheet cell toggles at most once per call. Inline projects only.", { map, cells, brush: edgeBrush }, ["map", "cells", "brush"], true),
  tool("rpgkit_event_add", "Add event", "add-event", "Add a complete schema-shaped event through the editor event transaction model, optionally at a zero-based index in the map's event list (default: append). IDs must be unique on the map and the footprint must fit.", { map, event: eventValue, index: { type: "integer", minimum: 0 } }, ["map", "event"], true),
  tool("rpgkit_event_update", "Update event fields", "update-event", "Update event id/name/x/y/w/h. Use null to remove optional name/w/h; page content is edited with page tools.", { map, event, changes: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]+$" }, name: { type: ["string", "null"] }, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, w: { type: ["integer", "null"], minimum: 1 }, h: { type: ["integer", "null"], minimum: 1 } } } }, ["map", "event", "changes"], true),
  tool("rpgkit_event_delete", "Delete event", "delete-event", "Delete one map-local event and return its old value in the structured result.", { map, event }, ["map", "event"], true),
  tool("rpgkit_page_add", "Add event page", "add-page", "Add a complete schema-shaped page, optionally at a zero-based index. Higher indexes have higher runtime priority.", { map, event, page: pageValue, index: { type: "integer", minimum: 0 } }, ["map", "event", "page"], true),
  tool("rpgkit_page_update", "Replace event page", "update-page", "Replace one page with a complete schema-shaped Page value through the editor page transaction model.", { map, event, page, value: pageValue }, ["map", "event", "page", "value"], true),
  tool("rpgkit_page_delete", "Delete event page", "delete-page", "Delete one page. The operation refuses to remove an event's final page.", { map, event, page }, ["map", "event", "page"], true),
  tool("rpgkit_command_insert", "Insert command", "insert-command", "Insert a schema-valid command at a root or recursive branch slot. Opaque runtime commands are inserted intact; obtain nested paths from rpgkit_commands_list.", { map, event, page, address, command: commandValue }, ["map", "event", "page", "address", "command"], true),
  tool("rpgkit_command_delete", "Delete command", "delete-command", "Delete any command at a commandAddress, including an opaque command as one intact value.", { map, event, page, address }, ["map", "event", "page", "address"], true),
  tool("rpgkit_command_update", "Update command field", "update-command", "Edit one supported command field using the editor's validated text adapter. Errors name legal fields and accepted values.", { map, event, page, address, field: { type: "string", minLength: 1 }, value: { type: "string", description: "Editor text spelling, for example 10, true, or newline-separated text lines." } }, ["map", "event", "page", "address", "field", "value"], true),
  tool("rpgkit_project_validate", "Validate project", "validate", "Validate a document against rpgkit-project/v1. Pass map to scope a shell validation to that one shard; otherwise every indexed shard is read and verified. Invalid content is returned as valid:false with field paths and messages.", { map }),
  tool("rpgkit_project_save", "Apply reversible patch", "save", "Apply a patch forward or reverse after checking its semantic SHA-256 base. For a shell, read only patch-addressed shards, stage and conflict-check all outputs, publish shards before the shell, and use best-effort rollback.", { patch: patchValue, direction: { type: "string", enum: ["forward", "reverse"], default: "forward" } }, ["patch"], true),
  tool("rpgkit_project_batch", "Batch edit transaction", "batch", "Run several editing operations as one all-or-nothing transaction: one dry-run, one schema gate, one reversible patch, one publish. Operations apply in order; a failure in any of them changes nothing. Inline projects and sharded ProjectShells are both supported (a shell writes only the affected shards). Structural shell commands (add-map and friends) stay proposal-only. The result lists each operation's result in order.", { operations: { type: "array", minItems: 1, items: batchOperation } }, ["operations"], true),
] as const;

export const EDIT_TOOL_BY_NAME: ReadonlyMap<string, EditToolDefinition> = new Map(
  EDIT_TOOLS.map((definition) => [definition.name, definition]),
);
