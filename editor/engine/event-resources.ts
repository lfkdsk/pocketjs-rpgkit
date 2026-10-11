// Project-derived choices used by the event field model.  The project
// format intentionally does not prescribe every presentation asset (layer
// variants are supplied by a game's GameAssets object), so authored values
// are included alongside resources declared directly by the project.

import type { Command, Condition, MapDef, PageCondition, Project } from "../../src/engine/types.ts";
import { flattenCommands } from "./commands.ts";

export interface EventEditorResources {
  readonly maps: readonly string[];
  readonly items: readonly string[];
  readonly sprites: readonly string[];
  readonly vehicles: readonly string[];
  readonly animations: readonly string[];
  readonly parallaxes: readonly string[];
  readonly audio: readonly string[];
  readonly commonEvents: readonly string[];
  readonly events: readonly string[];
  readonly layers: readonly string[];
  readonly layerVariants: Readonly<Record<string, readonly string[]>>;
  readonly animationInstances: readonly string[];
  readonly extensionCalls: readonly string[];
}

export const EMPTY_EVENT_EDITOR_RESOURCES: EventEditorResources = Object.freeze({
  maps: Object.freeze([]),
  items: Object.freeze([]),
  sprites: Object.freeze([]),
  vehicles: Object.freeze([]),
  animations: Object.freeze([]),
  parallaxes: Object.freeze([]),
  audio: Object.freeze([]),
  commonEvents: Object.freeze([]),
  events: Object.freeze([]),
  layers: Object.freeze([]),
  layerVariants: Object.freeze({}),
  animationInstances: Object.freeze([]),
  extensionCalls: Object.freeze([]),
});

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function collectCondition(condition: Condition, extensionCalls: Set<string>): void {
  if (condition.kind === "ext") extensionCalls.add(condition.call);
}

function collectPageCondition(condition: PageCondition | undefined, extensionCalls: Set<string>): void {
  for (const clause of condition?.all ?? []) collectCondition(clause, extensionCalls);
}

function allCommands(project: Project): Command[] {
  const roots: Command[][] = [];
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) roots.push(page.commands);
    }
  }
  for (const common of project.commonEvents ?? []) roots.push(common.commands);
  return roots.flatMap((commands) => flattenCommands(commands).map((row) => row.command));
}

/** Build deterministic resource suggestions for the editor UI and edit API. */
export function eventEditorResources(project: Project, map?: MapDef): EventEditorResources {
  const layers = new Set<string>();
  const variants = new Map<string, Set<string>>();
  const animationInstances = new Set<string>();
  const extensionCalls = new Set<string>();
  const parallaxes = new Set<string>();
  const sprites = new Set(Object.keys(project.sprites ?? {}));

  for (const follower of project.followers?.members ?? []) sprites.add(follower.sprite);
  for (const vehicle of project.vehicles ?? []) sprites.add(vehicle.sprite);

  for (const projectMap of project.maps) {
    if (projectMap.parallax?.image) parallaxes.add(projectMap.parallax.image);
  }

  const addVariant = (layer: string, variant: string | null | undefined): void => {
    layers.add(layer);
    if (typeof variant !== "string") return;
    const values = variants.get(layer) ?? new Set<string>();
    values.add(variant);
    variants.set(layer, values);
  };

  for (const command of allCommands(project)) {
    switch (command.op) {
      case "layer":
      case "screenBackdrop":
      case "showPicture":
        addVariant(command.layer, command.variant);
        break;
      case "screenTint":
        layers.add(command.layer);
        break;
      case "mapAnim":
        animationInstances.add(command.id);
        break;
      case "changeParallax":
        if (command.image) parallaxes.add(command.image);
        break;
      case "appearance":
        if (command.sprite) sprites.add(command.sprite);
        break;
      case "setVehicleImage":
        sprites.add(command.sprite);
        break;
      case "ext":
      case "extChoice":
        extensionCalls.add(command.call);
        break;
      case "if":
        collectCondition(command.if, extensionCalls);
        break;
    }
    if (command.op === "shop") {
      for (const good of command.goods) collectPageCondition(good.condition, extensionCalls);
    }
  }
  for (const projectMap of project.maps) {
    for (const event of projectMap.events ?? []) {
      for (const page of event.pages) collectPageCondition(page.condition, extensionCalls);
    }
  }

  const layerVariants: Record<string, readonly string[]> = {};
  for (const layer of sorted(variants.keys())) layerVariants[layer] = sorted(variants.get(layer)!);

  return {
    maps: sorted(project.maps.map((entry) => entry.id)),
    items: sorted(project.items.map((entry) => entry.id)),
    sprites: sorted(sprites),
    vehicles: sorted((project.vehicles ?? []).map((entry) => entry.id)),
    animations: sorted((project.animations ?? []).map((entry) => entry.id)),
    parallaxes: sorted(parallaxes),
    audio: sorted(Object.keys(project.audio ?? {})),
    commonEvents: sorted((project.commonEvents ?? []).map((entry) => entry.id)),
    events: sorted((map?.events ?? project.maps.flatMap((entry) => entry.events ?? [])).map((entry) => entry.id)),
    layers: sorted(layers),
    layerVariants,
    animationInstances: sorted(animationInstances),
    extensionCalls: sorted(extensionCalls),
  };
}
