// editor/api/catalogs.ts — project-global catalog reads, edits and references.

import type {
  Command,
  Condition,
  Item,
  PageCondition,
  Project,
  Sheet,
  SpriteDef,
  SwitchDef,
  VariableDef,
} from "../../src/engine/types.ts";
import { commandAddressKey, flattenCommands } from "../engine/commands.ts";

export const CATALOG_KINDS = [
  "item",
  "sprite",
  "audio",
  "sheet",
  "switch",
  "variable",
] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];
export type CatalogAction = "list" | "get" | "add" | "update" | "remove";

export interface CatalogCommandSpec {
  readonly kind: CatalogKind;
  readonly action: CatalogAction;
}

const CATALOG_COMMAND_PATTERN = /^(list|get|add|update|remove)-(item|items|sprite|sprites|audio|sheet|sheets|switch|switches|variable|variables)$/;

/** Return the catalog operation encoded by one edit command, if any. */
export function catalogCommandSpec(command: string): CatalogCommandSpec | undefined {
  const match = CATALOG_COMMAND_PATTERN.exec(command);
  if (!match) return undefined;
  const action = match[1] as CatalogAction;
  const noun = match[2]!;
  const kind: CatalogKind = noun === "item" || noun === "items"
    ? "item"
    : noun === "sprite" || noun === "sprites"
      ? "sprite"
      : noun === "audio"
        ? "audio"
        : noun === "sheet" || noun === "sheets"
          ? "sheet"
          : noun === "switch" || noun === "switches"
            ? "switch"
            : "variable";
  return { kind, action };
}

export class CatalogOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly expected?: unknown,
    readonly actual?: unknown,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CatalogOperationError";
  }
}

export type CatalogReferenceAccess = "read" | "write" | "readWrite" | "reference";

/** One known, statically typed use of a project-global catalog id. */
export interface CatalogReference {
  readonly address: string;
  readonly field: string;
  readonly access: CatalogReferenceAccess;
}

export interface CatalogEntry {
  readonly address: string;
  readonly id: string;
  readonly declared: boolean;
  readonly value: unknown;
  readonly referenceCount: number;
}

export interface CatalogEntryDetail extends CatalogEntry {
  readonly references: readonly CatalogReference[];
}

export interface CatalogMutation {
  readonly project: Project;
  readonly addresses: string[];
  readonly result: unknown;
}

type ReferenceIndex = Record<CatalogKind, Map<string, CatalogReference[]>>;

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const item = cloneJson((value as Record<string, unknown>)[key]);
      if (key === "__proto__") {
        Object.defineProperty(copy, key, { value: item, enumerable: true, configurable: true, writable: true });
      } else {
        copy[key] = item;
      }
    }
    return copy as T;
  }
  return value;
}

function encoded(id: string): string {
  return encodeURIComponent(id);
}

export function catalogAddress(kind: CatalogKind, id: string): string {
  return `${kind}:${encoded(id)}`;
}

export function catalogSelector(kind: CatalogKind): CatalogKind {
  return kind;
}

function emptyReferenceIndex(): ReferenceIndex {
  return {
    item: new Map(),
    sprite: new Map(),
    audio: new Map(),
    sheet: new Map(),
    switch: new Map(),
    variable: new Map(),
  };
}

function addReference(
  index: ReferenceIndex,
  kind: CatalogKind,
  id: string,
  address: string,
  field: string,
  access: CatalogReferenceAccess = "reference",
): void {
  const references = index[kind].get(id) ?? [];
  references.push({ address, field, access });
  index[kind].set(id, references);
}

function tileSheet(tile: string | null): string | undefined {
  if (tile === null) return undefined;
  const dot = tile.indexOf(".");
  return dot > 0 ? tile.slice(0, dot) : undefined;
}

function addTileReference(
  index: ReferenceIndex,
  tile: string | null,
  address: string,
  field: string,
): void {
  const sheet = tileSheet(tile);
  if (sheet !== undefined) addReference(index, "sheet", sheet, address, field);
}

function addConditionReferences(
  index: ReferenceIndex,
  condition: Condition,
  address: string,
  field: string,
): void {
  switch (condition.kind) {
    case "switch":
      addReference(index, "switch", condition.id, address, `${field}.id`, "read");
      break;
    case "variable":
      addReference(index, "variable", condition.id, address, `${field}.id`, "read");
      break;
    case "item":
      addReference(index, "item", condition.id, address, `${field}.id`);
      break;
    case "appearance":
      if (condition.sprite !== null) addReference(index, "sprite", condition.sprite, address, `${field}.sprite`);
      break;
    case "bgmPlaying":
      if (condition.id !== undefined) addReference(index, "audio", condition.id, address, `${field}.id`);
      break;
    default:
      break;
  }
}

function addPageConditionReferences(
  index: ReferenceIndex,
  condition: PageCondition | undefined,
  address: string,
  field = "condition",
): void {
  if (!condition) return;
  if (condition.switch !== undefined) addReference(index, "switch", condition.switch, address, `${field}.switch`, "read");
  if (condition.variable !== undefined) addReference(index, "variable", condition.variable.id, address, `${field}.variable.id`, "read");
  if (condition.item !== undefined) addReference(index, "item", condition.item, address, `${field}.item`);
  condition.all?.forEach((entry, at) => addConditionReferences(index, entry, address, `${field}.all[${at}]`));
}

const TEXT_VARIABLE_TOKEN = /\{v:([^{}]*)\}/g;

function addTextVariableReferences(
  index: ReferenceIndex,
  text: string,
  address: string,
  field: string,
): void {
  for (const match of text.matchAll(TEXT_VARIABLE_TOKEN)) {
    addReference(index, "variable", match[1]!, address, field, "read");
  }
}

function variableOperand(
  index: ReferenceIndex,
  operand: number | string | { variable: string } | undefined,
  address: string,
  field: string,
): void {
  if (operand !== null && typeof operand === "object" && "variable" in operand) {
    addReference(index, "variable", operand.variable, address, field, "read");
  }
}

function addCommandReferences(
  index: ReferenceIndex,
  commands: readonly Command[],
  rootAddress: string,
  textVariables: boolean,
): void {
  for (const row of flattenCommands(commands)) {
    const command = row.command;
    const address = `${rootAddress}/command:${commandAddressKey(row.address)}`;
    if (textVariables) {
      if (command.op === "text") {
        command.lines.forEach((line, at) => addTextVariableReferences(index, line, address, `lines[${at}]`));
      } else if (command.op === "choices") {
        addTextVariableReferences(index, command.prompt, address, "prompt");
        command.options.forEach((option, at) => addTextVariableReferences(index, option.text, address, `options[${at}].text`));
      } else if (command.op === "extChoice") {
        addTextVariableReferences(index, command.prompt, address, "prompt");
      }
    }
    switch (command.op) {
      case "switch":
        addReference(index, "switch", command.id, address, "id", "write");
        break;
      case "variable":
        addReference(index, "variable", command.id, address, "id", "write");
        if ("from" in command.set) addReference(index, "variable", command.set.from, address, "set.from", "read");
        break;
      case "if":
        addConditionReferences(index, command.if, address, "if");
        break;
      case "transfer":
        variableOperand(index, command.map, address, "map");
        variableOperand(index, command.x, address, "x");
        variableOperand(index, command.y, address, "y");
        variableOperand(index, command.dir, address, "dir");
        break;
      case "showPicture":
      case "movePicture":
        variableOperand(index, command.x, address, "x");
        variableOperand(index, command.y, address, "y");
        break;
      case "timer":
        if (command.action === "read") addReference(index, "variable", command.variable, address, "variable", "write");
        break;
      case "inputNumber":
        addReference(index, "variable", command.variable, address, "variable", "readWrite");
        break;
      case "selectItem":
        addReference(index, "variable", command.variable, address, "variable", "write");
        break;
      case "locationInfo":
        addReference(index, "variable", command.variable, address, "variable", "write");
        variableOperand(index, command.x, address, "x");
        variableOperand(index, command.y, address, "y");
        break;
      case "extChoice":
        if (command.write?.index !== undefined) addReference(index, "variable", command.write.index, address, "write.index", "write");
        if (command.write?.key !== undefined) addReference(index, "variable", command.write.key, address, "write.key", "write");
        if (command.write?.cancelled !== undefined) addReference(index, "variable", command.write.cancelled, address, "write.cancelled", "write");
        break;
      case "item":
        addReference(index, "item", command.item, address, "item");
        break;
      case "shop":
        command.goods.forEach((good, at) => {
          addReference(index, "item", good.item, address, `goods[${at}].item`);
          addPageConditionReferences(index, good.condition, address, `goods[${at}].condition`);
        });
        break;
      case "appearance":
        if (typeof command.sprite === "string") addReference(index, "sprite", command.sprite, address, "sprite");
        break;
      case "choices":
        command.options.forEach((option, at) => {
          if (option.icon) addReference(index, "sprite", option.icon.sprite, address, `options[${at}].icon.sprite`);
        });
        break;
      case "se":
        addReference(index, "audio", command.name, address, "name");
        break;
      case "playBgm":
      case "playBgs":
      case "playMe":
      case "playSe":
        addReference(index, "audio", command.id, address, "id");
        break;
      default:
        break;
    }
  }
}

/** Collect every reference the built-in project schema can type. Extension
 * args/setup remain opaque JSON and deliberately are not guessed. */
export function scanCatalogReferences(project: Project): ReferenceIndex {
  const index = emptyReferenceIndex();
  project.items.forEach((item, at) => addTileReference(index, item.sprite, catalogAddress("item", item.id), `items[${at}].sprite`));
  const actors = (project as unknown as { actors?: Array<{ id: string; sprite: string }> }).actors ?? [];
  actors.forEach((actor, at) => addReference(index, "sprite", actor.sprite, `actor:${encoded(actor.id)}`, `actors[${at}].sprite`));
  (project.animations ?? []).forEach((animation, animationAt) => {
    animation.timings?.forEach((timing, timingAt) => {
      if (timing.se) addReference(index, "audio", timing.se.id, `animation:${encoded(animation.id)}`, `animations[${animationAt}].timings[${timingAt}].se.id`);
    });
  });

  const textVariables = project.system?.textVariables === true;
  project.maps.forEach((map) => {
    const mapAddress = `map:${encoded(map.id)}`;
    map.sheets?.forEach((sheet, at) => addReference(index, "sheet", sheet, mapAddress, `sheets[${at}]`));
    // A large map can contain tens of thousands of cells from one sheet.
    // One map-level tile reference per sheet is enough to block deletion and
    // keeps RESOURCE_IN_USE responses bounded and reviewable.
    const tiledSheets = new Set<string>();
    for (const tile of map.ground) {
      const sheet = tileSheet(tile);
      if (sheet !== undefined) tiledSheets.add(sheet);
    }
    for (const [, tile] of map.upper ?? []) {
      const sheet = tileSheet(tile);
      if (sheet !== undefined) tiledSheets.add(sheet);
    }
    for (const sheet of [...tiledSheets].sort()) addReference(index, "sheet", sheet, mapAddress, "tiles");
    (map.events ?? []).forEach((event) => {
      event.pages.forEach((page, pageAt) => {
        const pageAddress = `${mapAddress}/event:${encoded(event.id)}/page:${pageAt}`;
        addPageConditionReferences(index, page.condition, pageAddress);
        if (typeof page.sprite === "string") addReference(index, "sprite", page.sprite, pageAddress, "sprite");
        addCommandReferences(index, page.commands, pageAddress, textVariables);
      });
    });
  });
  (project.commonEvents ?? []).forEach((common) => {
    const address = `common:${encoded(common.id)}`;
    if (common.conditionSwitch !== undefined) addReference(index, "switch", common.conditionSwitch, address, "conditionSwitch", "read");
    addCommandReferences(index, common.commands, address, textVariables);
  });
  return index;
}

function declaredCatalog(project: Project, kind: CatalogKind): Array<{ id: string; value: unknown }> {
  switch (kind) {
    case "item":
      return project.items.map((value) => ({ id: value.id, value }));
    case "sheet":
      return project.sheets.map((value) => ({ id: value.id, value }));
    case "switch":
      return (project.switches ?? []).map((value) => ({ id: value.id, value }));
    case "variable":
      return (project.variables ?? []).map((value) => ({ id: value.id, value }));
    case "sprite":
      return Object.keys(project.sprites ?? {}).sort().map((id) => ({ id, value: project.sprites![id]! }));
    case "audio":
      return Object.keys(project.audio ?? {}).sort().map((id) => ({ id, value: project.audio![id]! }));
  }
}

function catalogEntries(project: Project, kind: CatalogKind, references: ReferenceIndex): CatalogEntry[] {
  const declared = declaredCatalog(project, kind);
  const seen = new Set(declared.map((entry) => entry.id));
  const rows: CatalogEntry[] = declared.map((entry) => ({
    address: catalogAddress(kind, entry.id),
    id: entry.id,
    declared: true,
    value: cloneJson(entry.value),
    referenceCount: references[kind].get(entry.id)?.length ?? 0,
  }));
  if (kind === "switch" || kind === "variable") {
    for (const id of [...references[kind].keys()].sort()) {
      if (seen.has(id)) continue;
      rows.push({
        address: catalogAddress(kind, id),
        id,
        declared: false,
        value: { id },
        referenceCount: references[kind].get(id)!.length,
      });
    }
  }
  return rows;
}

export function readCatalog(
  project: Project,
  kind: CatalogKind,
  action: "list" | "get",
  id?: string,
): CatalogEntry[] | CatalogEntryDetail {
  const references = scanCatalogReferences(project);
  const entries = catalogEntries(project, kind, references);
  if (action === "list") return entries;
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new CatalogOperationError(
      "RESOURCE_NOT_FOUND",
      `${kind} ${JSON.stringify(id)} does not exist`,
      `$.${kind}`,
      `existing ${kind} id`,
      id,
    );
  }
  return { ...entry, references: cloneJson(references[kind].get(entry.id) ?? []) };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogOperationError("INVALID_ARGUMENT", `${path.slice(2)} must be a JSON object`, path, "object", value);
  }
  return value as Record<string, unknown>;
}

function requireId(value: Record<string, unknown>, path: string): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new CatalogOperationError("INVALID_ARGUMENT", "catalog id must be a non-empty string", `${path}.id`, "non-empty string", value.id);
  }
  return value.id;
}

function duplicate(kind: CatalogKind, id: string): never {
  throw new CatalogOperationError(
    "DUPLICATE_RESOURCE",
    `${kind} ${JSON.stringify(id)} already exists`,
    `$.${kind}`,
    `new ${kind} id`,
    id,
  );
}

function missing(kind: CatalogKind, id: string): never {
  throw new CatalogOperationError(
    "RESOURCE_NOT_FOUND",
    `${kind} ${JSON.stringify(id)} is not declared`,
    `$.${kind}`,
    `declared ${kind} id`,
    id,
  );
}

function updatedObject(
  before: Record<string, unknown>,
  changesValue: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const changes = requireObject(changesValue, "$.changes");
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    throw new CatalogOperationError("INVALID_ARGUMENT", "changes must include at least one field", "$.changes", allowed, keys);
  }
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new CatalogOperationError("INVALID_ARGUMENT", `unsupported catalog field(s): ${unknown.join(", ")}`, "$.changes", allowed, unknown);
  }
  const after = cloneJson(before);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null && !required.includes(key)) delete after[key];
    else if (value === null) {
      throw new CatalogOperationError("INVALID_ARGUMENT", `${key} is required and cannot be removed`, `$.changes.${key}`, "non-null value", value);
    } else after[key] = cloneJson(value);
  }
  return after;
}

function removeRefusal(project: Project, kind: CatalogKind, id: string): void {
  const references = scanCatalogReferences(project)[kind].get(id) ?? [];
  if (references.length > 0) {
    throw new CatalogOperationError(
      "RESOURCE_IN_USE",
      `${kind} ${JSON.stringify(id)} is referenced ${references.length} time(s) and cannot be removed`,
      `$.${kind}`,
      "unreferenced catalog entry",
      id,
      { resource: { kind, id }, references: cloneJson(references) },
    );
  }
}

function addArrayEntry<T extends { id: string }>(
  project: Project,
  kind: CatalogKind,
  values: readonly T[],
  value: T,
  assign: (next: T[]) => Project,
): CatalogMutation {
  if (values.some((entry) => entry.id === value.id)) duplicate(kind, value.id);
  const next = assign([...values, cloneJson(value)]);
  const address = catalogAddress(kind, value.id);
  return { project: next, addresses: [address], result: cloneJson(value) };
}

function updateArrayEntry<T extends { id: string }>(
  project: Project,
  kind: CatalogKind,
  values: readonly T[],
  id: string,
  changes: unknown,
  allowed: readonly string[],
  required: readonly string[],
  assign: (next: T[]) => Project,
): CatalogMutation {
  const at = values.findIndex((entry) => entry.id === id);
  if (at < 0) missing(kind, id);
  const after = updatedObject(values[at] as unknown as Record<string, unknown>, changes, allowed, required) as unknown as T;
  const nextValues = values.slice();
  nextValues[at] = after;
  const address = catalogAddress(kind, id);
  return { project: assign(nextValues), addresses: [address], result: cloneJson(after) };
}

function removeArrayEntry<T extends { id: string }>(
  project: Project,
  kind: CatalogKind,
  values: readonly T[],
  id: string,
  assign: (next: T[]) => Project,
): CatalogMutation {
  const at = values.findIndex((entry) => entry.id === id);
  if (at < 0) missing(kind, id);
  removeRefusal(project, kind, id);
  const deleted = values[at]!;
  const nextValues = values.slice();
  nextValues.splice(at, 1);
  const address = catalogAddress(kind, id);
  return { project: assign(nextValues), addresses: [address], result: { deleted: cloneJson(deleted), references: [] } };
}

/** Apply one catalog mutation. Payload shapes intentionally match the public
 * commands: array catalogs add complete objects and update with `changes`;
 * keyed catalogs add/update with selector + complete `value`. */
export function mutateCatalog(
  project: Project,
  kind: CatalogKind,
  action: "add" | "update" | "remove",
  args: Record<string, unknown>,
): CatalogMutation {
  if (kind === "item") {
    if (action === "add") {
      const value = cloneJson(requireObject(args.item, "$.item")) as unknown as Item;
      requireId(value as unknown as Record<string, unknown>, "$.item");
      return addArrayEntry(project, kind, project.items, value, (items) => ({ ...project, items }));
    }
    const id = args.item as string;
    if (action === "update") {
      return updateArrayEntry(project, kind, project.items, id, args.changes,
        ["name", "sprite", "usable", "price", "sellable", "type", "kind"], ["name", "sprite"],
        (items) => ({ ...project, items }));
    }
    return removeArrayEntry(project, kind, project.items, id, (items) => ({ ...project, items }));
  }

  if (kind === "sheet") {
    if (action === "add") {
      const value = cloneJson(requireObject(args.sheet, "$.sheet")) as unknown as Sheet;
      requireId(value as unknown as Record<string, unknown>, "$.sheet");
      return addArrayEntry(project, kind, project.sheets, value, (sheets) => ({ ...project, sheets }));
    }
    const id = args.sheet as string;
    if (action === "update") {
      return updateArrayEntry(project, kind, project.sheets, id, args.changes,
        ["pak", "cols", "rows", "defaultPassage", "block", "pass", "dirBlock", "dirEdges"], ["pak", "cols", "rows"],
        (sheets) => ({ ...project, sheets }));
    }
    return removeArrayEntry(project, kind, project.sheets, id, (sheets) => ({ ...project, sheets }));
  }

  if (kind === "switch" || kind === "variable") {
    const key = kind === "switch" ? "switches" : "variables";
    const selector = args[kind] as string;
    const values = (project[key] ?? []) as readonly (SwitchDef | VariableDef)[];
    const assign = (next: (SwitchDef | VariableDef)[]): Project => {
      const copy = { ...project };
      if (next.length === 0) delete copy[key];
      else Object.assign(copy, { [key]: next });
      return copy;
    };
    if (action === "add") {
      const value = cloneJson(requireObject(args[kind], `$.${kind}`)) as unknown as SwitchDef | VariableDef;
      requireId(value as unknown as Record<string, unknown>, `$.${kind}`);
      return addArrayEntry(project, kind, values, value, assign);
    }
    if (action === "update") {
      // `writtenBy` is a switch-only declaration (the host/extension writes
      // the switch at runtime); variables stay name-only.
      return updateArrayEntry(project, kind, values, selector, args.changes,
        kind === "switch" ? ["name", "writtenBy"] : ["name"], [], assign);
    }
    return removeArrayEntry(project, kind, values, selector, assign);
  }

  const key = kind === "sprite" ? "sprites" : "audio";
  const id = args[kind] as string;
  const before = project[key] ?? {};
  if (action === "add") {
    if (Object.prototype.hasOwnProperty.call(before, id)) duplicate(kind, id);
    const nextValues = { ...before, [id]: cloneJson(args.value) } as Record<string, SpriteDef> & Record<string, string>;
    const next = { ...project, [key]: nextValues };
    const address = catalogAddress(kind, id);
    return { project: next, addresses: [address], result: cloneJson(args.value) };
  }
  if (!Object.prototype.hasOwnProperty.call(before, id)) missing(kind, id);
  if (action === "update") {
    const nextValues = { ...before, [id]: cloneJson(args.value) } as Record<string, SpriteDef> & Record<string, string>;
    const next = { ...project, [key]: nextValues };
    const address = catalogAddress(kind, id);
    return { project: next, addresses: [address], result: cloneJson(args.value) };
  }
  removeRefusal(project, kind, id);
  const deleted = before[id];
  const nextValues = { ...before } as Record<string, unknown>;
  delete nextValues[id];
  const next = { ...project };
  if (Object.keys(nextValues).length === 0) delete next[key];
  else Object.assign(next, { [key]: nextValues });
  const address = catalogAddress(kind, id);
  return { project: next, addresses: [address], result: { deleted: cloneJson(deleted), references: [] } };
}
