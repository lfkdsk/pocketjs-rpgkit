/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// editor/studio/main.ts — Studio entry: builds the toolbar, panels, status
// bar and dialogs around the shared StudioApp state and wires shortcuts.
// Files, storage, checks and preferences go through the StudioHost
// (host.ts). The web page runs on the browser host; the desktop app's entry
// (main-desktop.ts) builds its host first and leaves it in globalThis.

import { AgentReview } from "./agent-model.ts";
import { mountAgentPanel } from "./agent-panel.ts";
import { StudioApp, type PaintLayer, type Tool } from "./app.ts";
import { cropGrid, gridCount, pngGridProblem, pngImportProblem, type PngGrid, type PngImportKind } from "../api/png-import.ts";
import { BROWSER_RPGMAKER_IMAGE_CODEC } from "./rpgmaker-import-browser-io.ts";
import { ArtRegistry, parseTileId } from "./art.ts";
import { MapCanvas, isTyping } from "./canvas.ts";
import { CommandPalette, type StudioCommand } from "./command-palette.ts";
import { emptyState, h, icon, iconButton, MOD, replace } from "./dom.ts";
import { StudioFiles } from "./files.ts";
import type {
  HostCommand,
  HostFeature,
  RpgMakerImportDisposition,
  RpgMakerImportOutcome,
  RpgMakerImportProgress,
  StudioHost,
  ThemeChoice,
} from "./host.ts";
import { BrowserHost } from "./host-browser.ts";
import { rpgMakerImportLocale, rpgMakerImportText, type RpgMakerImportLocale } from "./import-i18n.ts";
import { mountInspector } from "./inspector.ts";
import { eventCopyOp, insertionAddress, insertCommandOp, opLabel, PICKER_ENTRIES, type CommandRef } from "./inspector-model.ts";
import { defaultCommand, flattenCommands } from "../engine/commands.ts";
import { uniqueEventId } from "../engine/model.ts";
import { mountLayersPanel } from "./layers-panel.ts";
import { mountMinimap } from "./minimap.ts";
import { mountEventHoverCard } from "./event-hover-card.ts";
import { PlayTest } from "./preview.ts";
import { mountPlayTestPanel } from "./preview-panel.ts";
import { mountMapTree } from "./map-tree.ts";
import { mountPalette } from "./palette.ts";
import { keyLabel, SHORTCUT_GROUPS } from "./shortcuts.ts";
import { doctorProblems, mergeCheckAndDoctor, schemaProblems, type StudioProblem } from "./problems.ts";
import { LintScheduler } from "./problem-lint.ts";
import type { Command, VehicleDef, VehicleKind } from "../../src/engine/types.ts";

const host: StudioHost = (globalThis as { studioHost?: StudioHost }).studioHost ?? new BrowserHost();
const app = new StudioApp();
const art = new ArtRegistry();
const files = new StudioFiles(app, art, host);
const can = (feature: HostFeature) => host.capabilities()[feature];
let importLocale: RpgMakerImportLocale = rpgMakerImportLocale(
  typeof navigator === "undefined" ? undefined : navigator.languages.length > 0 ? navigator.languages : navigator.language,
);
app.loadPreferences(host.preferences(), host.systemPrefersReducedMotion());
document.documentElement.dataset.motion = app.reducedMotion ? "reduced" : "full";
host.onSystemMotionChange(() => {
  app.systemReducedMotion = host.systemPrefersReducedMotion();
  document.documentElement.dataset.motion = app.reducedMotion ? "reduced" : "full";
  app.emit("view");
});

const $ = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`studio page has no #${id}`);
  return element;
};

// ---- theme ---------------------------------------------------------------------

let themeChoice: ThemeChoice = host.theme();

function effectiveTheme(): "light" | "dark" {
  return themeChoice === "system" ? (host.systemPrefersDark() ? "dark" : "light") : themeChoice;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = effectiveTheme();
  canvas?.readTheme();
  app.emit("theme");
}

function toggleTheme(): void {
  themeChoice = effectiveTheme() === "dark" ? "light" : "dark";
  host.setTheme(themeChoice);
  applyTheme();
}
host.onSystemThemeChange(() => { if (themeChoice === "system") applyTheme(); });

// ---- layout ----------------------------------------------------------------------

let canvas: MapCanvas | null = null;
applyTheme();
canvas = new MapCanvas($("canvas-host"), app, art);
const layersPanel = h("section", { id: "studio-layers", "aria-label": "Map layers" });
$("canvas-host").appendChild(layersPanel);
mountLayersPanel(layersPanel, app);
const minimapRoot = h("div", { id: "studio-minimap", "aria-label": "Map overview" });
$("canvas-host").appendChild(minimapRoot);
const minimap = mountMinimap(minimapRoot, app, canvas, art);
const hoverCardRoot = h("aside", { id: "studio-event-hover", "aria-label": "Event summary" });
$("canvas-host").appendChild(hoverCardRoot);
const hoverCard = mountEventHoverCard(hoverCardRoot, app, canvas, art);
mountMapTree($("maps"), app);
mountPalette($("palette"), app, art);
mountInspector($("inspector"), app);
const play = new PlayTest(app, host, () => files.examples);
// The game gets the project's own art and the user's picks (bundled
// example art is already in the game). The registry includes tile sheets,
// sprites, cooked animations and parallaxes; item icons are cells of the
// same supplied sheets.
play.setArtProvider(async () => {
  return app.session ? art.previewImages() : [];
});
const playPanel = mountPlayTestPanel($("playtest"), app, play, () => canvas?.canvas.focus());
const agent = new AgentReview(app, host);
const agentPanel = mountAgentPanel($("agent"), agent, () => {
  // The agent and play-test panels share the right-hand dock: one at a time.
  if (agentPanel.isOpen && play.open) playPanel.close();
  renderToolbar();
  // Like the play-test panel: show the whole map once the canvas has resized.
  requestAnimationFrame(() => requestAnimationFrame(() => canvas?.fit()));
});
const commandPalette = new CommandPalette(app, studioCommands);

const TOOLS: [Tool, string, string, string][] = [
  ["select", "select", "Select / move events", "V"],
  ["pencil", "pencil", "Brush", "B"],
  ["rect", "rect", "Rectangle", "R"],
  ["fill", "fill", "Fill", "F"],
  ["eraser", "eraser", "Eraser", "E"],
  ["picker", "picker", "Eyedropper", "I"],
  ["event", "event", "Events: click to create or select", "N"],
];
const LAYERS: [PaintLayer, string, string][] = [
  ["ground", "Ground", "1"],
  ["upper", "Upper", "2"],
  ["passage", "Passage", "3"],
  ["regions", "Regions", "4"],
  ["edges", "Edges", "5"],
];

function addEventFromPalette(): void {
  const map = app.currentMap();
  if (!map) return;
  const selection = app.selection;
  if (selection.kind !== "cell") {
    app.setTool("event");
    app.notify("info", "Event tool active — click an empty map cell to create the event.");
    canvas?.canvas.focus();
    return;
  }
  const id = uniqueEventId(map.events ?? []);
  const response = app.run("add-event", {
    map: map.id,
    event: { id, x: selection.x, y: selection.y, pages: [{ trigger: "action", commands: [] }] },
  }, `New event ${id}`);
  if (response?.ok) {
    app.select({ kind: "event", eventId: id, page: 0 });
    selectTab("inspector");
  }
}

function addCommandFromPalette(op: string): void {
  const selection = app.selection;
  let commands: readonly Command[];
  let ref: CommandRef;
  if (selection.kind === "common") {
    const common = app.session?.globals().commonEvents?.find((item) => item.id === selection.commonId);
    if (!common) return;
    commands = common.commands;
    ref = { common: common.id };
  } else if (selection.kind === "event") {
    const map = app.currentMap();
    const event = map?.events?.find((item) => item.id === selection.eventId);
    const page = event?.pages[selection.page];
    if (!map || !event || !page) return;
    commands = page.commands;
    ref = { map: map.id, event: event.id, page: selection.page };
  } else {
    return;
  }
  const address = insertionAddress(commands, selection.command);
  if (!address) return;
  const operation = insertCommandOp(ref, address, defaultCommand(op as Parameters<typeof defaultCommand>[0]));
  const response = app.run(operation.command, operation.args ?? {}, `Add ${op} command`);
  if (response?.ok) {
    app.select({ ...selection, command: address });
    selectTab("inspector");
  }
}

function addCommonEventFromPalette(): void {
  const commonEvents = app.session?.globals().commonEvents ?? [];
  const used = new Set(commonEvents.map((common) => common.id));
  let suffix = 1;
  while (used.has(`common-${suffix}`)) suffix++;
  const commonEvent = { id: `common-${suffix}`, trigger: "none" as const, commands: [] };
  const response = app.run("add-common-event", { commonEvent }, `New common event ${commonEvent.id}`);
  if (response?.ok) {
    app.select({ kind: "common", commonId: commonEvent.id });
    selectTab("inspector");
  }
}

/** Build only from the open map. In a sharded project this never parses an
 * unopened shard merely because the palette opened. */
function studioCommands(): StudioCommand[] {
  const session = app.session;
  const map = app.currentMap();
  const selection = app.selection;
  const noDocument = session ? undefined : "Open a project first";
  const commands: StudioCommand[] = [
    { id: "file:open", label: "Open project…", detail: "Open a file", keywords: "file folder project", shortcut: `${MOD}+O`, section: "Actions", run: () => files.openFile() },
    { id: "file:save", label: "Save", detail: saveLabel(), shortcut: `${MOD}+S`, section: "Actions", disabled: noDocument, run: () => void files.save() },
    { id: "file:download", label: "Download export", detail: "Export the current project", shortcut: `${MOD}+Shift+E`, section: "Actions", disabled: noDocument, run: () => void files.download() },
    { id: "edit:undo", label: "Undo", shortcut: `${MOD}+Z`, section: "Actions", disabled: session?.canUndo() ? undefined : "Nothing to undo", run: () => app.undo() },
    { id: "edit:redo", label: "Redo", shortcut: `${MOD}+Shift+Z`, section: "Actions", disabled: session?.canRedo() ? undefined : "Nothing to redo", run: () => app.redo() },
    { id: "event:new", label: "New event", detail: selection.kind === "cell" ? `At (${selection.x}, ${selection.y})` : "Activate the event tool", keywords: "create npc", shortcut: "N", section: "Actions", disabled: noDocument, run: addEventFromPalette },
    { id: "common:new", label: "New common event", detail: "Reusable project-wide command list", keywords: "create common event", section: "Actions", disabled: noDocument, run: addCommonEventFromPalette },
    { id: "view:fit", label: "Fit map", detail: "Center the whole map", shortcut: "0", section: "Actions", disabled: noDocument, run: () => canvas?.fit() },
    { id: "view:settings", label: "View settings", detail: "Motion and camera behavior", section: "Actions", run: openViewSettings },
    { id: "project:mobility", label: "Followers & vehicles…", detail: "Party trail and vehicle starts", keywords: "project followers boat ship airship", section: "Actions", disabled: noDocument, run: openMobilitySettings },
    { id: "view:theme", label: `Use ${effectiveTheme() === "dark" ? "light" : "dark"} theme`, keywords: "appearance color", section: "Actions", run: toggleTheme },
    { id: "view:art", label: "Manage project art…", keywords: "image png sheet sprite", section: "Actions", disabled: noDocument, run: openArtDialog },
    { id: "play:start", label: "Play-test", detail: "Run from the selected cell", shortcut: `${MOD}+Enter`, section: "Actions", disabled: !session ? "Open a project first" : can("preview").available ? undefined : can("preview").reason, run: () => playPanel.open() },
    ...TOOLS.map(([tool, , label, shortcut]): StudioCommand => ({
      id: `tool:${tool}`, label, detail: "Select editing tool", shortcut, section: "Actions", disabled: noDocument, run: () => app.setTool(tool),
    })),
    ...LAYERS.map(([layer, label, shortcut]): StudioCommand => ({
      id: `layer:${layer}`, label: `Edit ${label} layer`, detail: "Change the active editing layer", shortcut, section: "Actions", disabled: noDocument, run: () => app.setLayer(layer),
    })),
    ...(["ground", "upper", "passage", "regions", "events"] as const).map((layer, index): StudioCommand => ({
      id: `visibility:${layer}`, label: `${app.visible[layer] ? "Hide" : "Show"} ${layer} layer`, detail: "Canvas visibility", shortcut: `Shift+${index + 1}`, section: "Actions", disabled: noDocument,
      run: () => { app.visible[layer] = !app.visible[layer]; app.emit("view"); renderToolbar(); },
    })),
  ];
  if (!session) return commands;

  commands.push(...session.maps().map((item): StudioCommand => ({
    id: `map:${item.id}`, label: item.name ?? item.id, detail: `${item.id} · ${item.width}×${item.height}`, keywords: `map ${item.id}`, section: "Maps",
    run: () => { app.openMap(item.id); canvas?.canvas.focus(); },
  })));
  commands.push(...(session.globals().commonEvents ?? []).map((common): StudioCommand => ({
    id: `common:${common.id}`,
    label: common.name ?? common.id,
    detail: `${common.id} · ${common.commands.length} command${common.commands.length === 1 ? "" : "s"} · ${common.trigger === "parallel" ? "parallel" : "called"}`,
    keywords: `common event ${common.id}`,
    section: "Common events",
    run: () => { app.select({ kind: "common", commonId: common.id }); selectTab("inspector"); },
  })));
  if (!map) return commands;
  commands.push(...(map.events ?? []).map((event): StudioCommand => ({
    id: `event:${map.id}:${event.id}`, label: event.name ?? event.id, detail: `${event.id} · (${event.x}, ${event.y}) · ${event.pages.length} page${event.pages.length === 1 ? "" : "s"}`, keywords: "event npc", section: "Events",
    run: () => {
      app.select({ kind: "event", eventId: event.id, page: 0 });
      selectTab("inspector");
      canvas?.reveal({ x: event.x, y: event.y, w: event.w, h: event.h });
    },
  })));

  if (selection.kind === "event") {
    const event = map.events?.find((item) => item.id === selection.eventId);
    const page = event?.pages[selection.page];
    if (event && page) {
      commands.push(...flattenCommands(page.commands).map((row): StudioCommand => ({
        id: `command:${map.id}:${event.id}:${selection.page}:${row.key}`,
        label: opLabel(String(row.command.op)),
        detail: `${event.name ?? event.id} · ${row.summary}`,
        keywords: `existing command ${String(row.command.op)} ${row.branchLabel ?? ""}`,
        section: "Commands",
        run: () => { app.select({ ...selection, command: row.address }); selectTab("inspector"); },
      })));
      commands.push(...PICKER_ENTRIES.map((entry): StudioCommand => ({
        id: `command:add:${entry.op}`, label: `Add ${entry.label}`, detail: entry.description,
        keywords: `${entry.op} ${entry.category} insert`, section: "Commands", run: () => addCommandFromPalette(entry.op),
      })));
    }
  } else if (selection.kind === "common") {
    const common = session.globals().commonEvents?.find((item) => item.id === selection.commonId);
    if (common) {
      commands.push(...flattenCommands(common.commands).map((row): StudioCommand => ({
        id: `command:common:${common.id}:${row.key}`,
        label: opLabel(String(row.command.op)),
        detail: `${common.name ?? common.id} · ${row.summary}`,
        keywords: `existing common command ${String(row.command.op)} ${row.branchLabel ?? ""}`,
        section: "Commands",
        run: () => { app.select({ ...selection, command: row.address }); selectTab("inspector"); },
      })));
      commands.push(...PICKER_ENTRIES.map((entry): StudioCommand => ({
        id: `command:add:${entry.op}`, label: `Add ${entry.label}`, detail: entry.description,
        keywords: `${entry.op} ${entry.category} insert`, section: "Commands", run: () => addCommandFromPalette(entry.op),
      })));
    }
  }
  return commands;
}

/** Menu rows: label, action, shortcut hint, and the reason when disabled. */
type MenuItem = [string, () => void, string?, string?];

function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = h("div", { class: "menu", role: "menu", style: `left:${rect.left}px;top:${rect.bottom + 4}px` },
    items.map(([label, run, hint, disabled]) => h("button", {
      type: "button",
      role: "menuitem",
      dataset: { menu: label },
      disabled: disabled !== undefined,
      title: disabled,
      onclick: () => { closeMenus(); run(); },
    }, h("span", null, label), hint ? h("kbd", null, hint) : disabled ? h("span", { class: "muted" }, "unavailable") : null)));
  document.body.appendChild(menu);
  (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
}

function closeMenus(): void {
  for (const menu of document.querySelectorAll(".menu")) menu.remove();
}
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest(".menu, [data-opens-menu]")) closeMenus();
});

function renderToolbar(): void {
  const session = app.session;
  const openButton = iconButton("open", "Open", () => {
    const folder = can("openDirectory");
    const importer = can("rpgMakerImport");
    openMenu(openButton, [
      ["Open file…", () => files.openFile(), `${MOD}+O`],
      ["Open folder…", () => void files.openDirectory(), undefined, folder.available ? undefined : folder.reason],
      [rpgMakerImportText(importLocale).menu, () => openRpgMakerImportDialog(), undefined, importer.available ? undefined : importer.reason],
      ...files.examples.map((example): MenuItem => [`Example: ${example.title}`, () => void files.openExample(example.id)]),
    ]);
  }, { shortcut: `${MOD}+O`, id: "studio-open", text: true });
  openButton.dataset.opensMenu = "1";
  const toolButtons = TOOLS.map(([tool, iconName, label, key]) => {
    const button = iconButton(iconName, label, () => app.setTool(tool), { shortcut: key, pressed: app.tool === tool });
    button.dataset.tool = tool;
    return button;
  });
  const layerButtons = LAYERS.map(([layer, label, key]) => h("button", {
    type: "button",
    class: app.layer === layer ? "active" : "",
    "aria-pressed": String(app.layer === layer),
    title: `${label} layer (${key})`,
    dataset: { layer },
    onclick: () => app.setLayer(layer),
  }, label));
  const toggle = (key: keyof typeof app.visible, iconName: string, label: string, shortcut?: string) => {
    const button = iconButton(iconName, label, () => { app.visible[key] = !app.visible[key]; app.emit("view"); renderToolbar(); }, { pressed: app.visible[key], ...(shortcut ? { shortcut } : {}) });
    button.dataset.toggle = key;
    return button;
  };
  replace($("toolbar"),
    h("div", { class: "brand", title: "Pocket RPG Kit Studio" }, h("span", { class: "logo" }, "◆"), h("span", null, "Studio")),
    h("div", { class: "group" },
      iconButton("search", "Command palette", () => commandPalette.open(), { shortcut: `${MOD}+K`, id: "studio-command-palette", text: true })),
    h("div", { class: "group" },
      openButton,
      iconButton("save", saveLabel(), () => void files.save(), { shortcut: `${MOD}+S`, disabled: !session || files.saving > 0 || (!files.target && !can("storage").available), id: "studio-save" }),
      iconButton("download", "Download", () => void files.download(), { shortcut: `${MOD}+Shift+E`, disabled: !session, id: "studio-download" })),
    h("div", { class: "group" },
      iconButton("undo", "Undo", () => app.undo(), { shortcut: `${MOD}+Z`, disabled: !session?.canUndo(), id: "studio-undo" }),
      iconButton("redo", "Redo", () => app.redo(), { shortcut: `${MOD}+Shift+Z`, disabled: !session?.canRedo(), id: "studio-redo" })),
    h("div", { class: "group tools", role: "toolbar", "aria-label": "Tools" }, toolButtons),
    h("div", { class: "segmented", role: "group", "aria-label": "Layer" }, layerButtons),
    h("div", { class: "group" },
      toggle("grid", "grid", "Grid", "G"),
      toggle("upper", "layers", "Show upper layer"),
      toggle("events", "event", "Show events"),
      toggle("passage", "pass", "Passage overlay", "P"),
      toggle("regions", "grid", "Region overlay")),
    h("div", { class: "group zoom" },
      iconButton("zoomOut", "Zoom out", () => canvas?.zoomStep(-1), { shortcut: "-" }),
      h("button", { type: "button", class: "zoom-label", title: "Fit map (0)", id: "studio-zoom", onclick: () => canvas?.fit() }, `${Math.round(app.view.zoom * 100)}%`),
      iconButton("zoomIn", "Zoom in", () => canvas?.zoomStep(1), { shortcut: "=" })),
    h("div", { class: "spacer" }),
    h("div", { class: "group" },
      iconButton("map", "Followers & vehicles", () => openMobilitySettings(), { disabled: !session, id: "studio-mobility" }),
      iconButton("image", "Art…", () => openArtDialog(), { disabled: !session, id: "studio-art", text: true }),
      iconButton("play", can("preview").available ? "Play-test the open document" : `Play-test: ${can("preview").reason}`, () => playPanel.open(), { shortcut: `${MOD}+Enter`, disabled: !session || !can("preview").available, id: "studio-play", pressed: play.open }),
      iconButton("agent", can("agent").available ? "Ask an agent" : `Agent: ${can("agent").reason}`, () => agentPanel.toggle(), { disabled: !session || !can("agent").available, id: "studio-agent", pressed: agentPanel.isOpen }),
      iconButton("settings", "View settings", () => openViewSettings(), { id: "studio-view-settings" }),
      iconButton(effectiveTheme() === "dark" ? "sun" : "moon", effectiveTheme() === "dark" ? "Light theme" : "Dark theme", toggleTheme, { id: "studio-theme" }),
      iconButton("help", "Keyboard shortcuts", () => openShortcuts(), { shortcut: "?" })),
  );
}

let playWasOpen = false;
play.on(() => {
  if (play.open === playWasOpen) return;
  playWasOpen = play.open;
  if (play.open && agentPanel.isOpen) agentPanel.close();
  renderToolbar();
  // The canvas just gained or lost the panel's width: show the whole map
  // once it has been resized (the resize lands after the next frame).
  requestAnimationFrame(() => requestAnimationFrame(() => canvas?.fit()));
});

function saveLabel(): string {
  if (files.saving > 0) return `Saving${files.savingTo ? ` to ${files.savingTo}` : ""}…`;
  if (files.target) return `Save to ${files.target.name}`;
  const storage = can("storage");
  return storage.available ? (host.name === "browser" ? "Save in browser" : "Save") : `Save: ${storage.reason}`;
}

/** Open the Agent panel at its request box. The host runs the local agent
 * (desktop hosts only); the panel reviews the proposals it returns. */
function askAgent(): void {
  if (!app.session || !can("agent").available) return;
  agentPanel.open();
}

// ---- status bar and problems ---------------------------------------------------------

let problems: StudioProblem[] = [];
let problemsOpen = false;
/** The debounced async rpgkit-check lint. pending stays true from a schedule
 *  until the latest generation's run has rendered, so a capture can wait for
 *  the problems count in the status bar to stop changing. */
const lintScheduler = new LintScheduler({
  run: recomputeProblems,
  commit: (next) => {
    problems = next;
    renderStatus();
    renderProblems();
  },
});

async function recomputeProblems(): Promise<StudioProblem[]> {
  const session = app.session;
  if (!session) return [];
  const project = session.kind === "inline" ? session.project() : null;
  const schema = schemaProblems(project, app.problems);
  let checks: StudioProblem[] = [];
  if (project && schema.length === 0) {
    const outcome = await host.runChecks({ project, mode: "lint" });
    checks = outcome.ok ? outcome.problems : [{ severity: "warning", source: "check", code: "rpgkit-check", message: outcome.message }];
  }
  // The doctor's fixable findings run on the inline project (the edit
  // operations its fixes use need the whole document). Where a doctor
  // finding restates a lint finding at the same location, the fix is
  // attached to the lint line instead of adding a duplicate row.
  const doctor = project && schema.length === 0 ? doctorProblems(project) : [];
  return [...schema, ...mergeCheckAndDoctor(checks, doctor)];
}

function scheduleProblems(): void {
  lintScheduler.schedule();
}

function locate(problem: StudioProblem): void {
  if (problem.common) {
    app.select({ kind: "common", commonId: problem.common, ...(problem.command ? { command: problem.command } : {}) });
    app.pulse = true;
    selectTab("inspector");
    app.emit("selection");
    return;
  }
  if (problem.map) app.openMap(problem.map);
  const event = problem.event ? app.currentMap()?.events?.find((item) => item.id === problem.event) : undefined;
  if (problem.event) app.select({ kind: "event", eventId: problem.event, page: problem.page ?? 0 });
  // Glide to the event and pulse it; the inspector flashes the event too.
  if (event) {
    app.pulse = true;
    requestAnimationFrame(() => canvas?.reveal({ x: event.x, y: event.y, w: event.w, h: event.h }));
  }
  app.emit("selection");
}

/** Apply a doctor fix: one undoable transaction, then refresh the list. */
function applyDoctorFix(problem: StudioProblem): void {
  if (!problem.fix) return;
  const response = app.transaction(problem.fix.label, problem.fix.ops);
  if (response && !response.ok) {
    app.notify("error", `Fix refused: ${response.error.message}`);
    return;
  }
  scheduleProblems();
}

function renderProblems(): void {
  const panel = $("problems");
  panel.hidden = !problemsOpen;
  if (!problemsOpen) return;
  const errors = problems.filter((problem) => problem.severity === "error").length;
  replace(panel,
    h("div", { class: "panel-header" },
      h("span", { class: "panel-title" }, "Problems"),
      h("span", { class: "muted" }, `${errors} error${errors === 1 ? "" : "s"}, ${problems.length - errors} other`),
      h("div", { class: "spacer" }),
      app.session?.kind === "pack"
        ? h("button", { type: "button", class: "text-button", onclick: () => { app.validateNow(); scheduleProblems(); } }, "Validate all shards")
        : null,
      h("button", {
        type: "button",
        class: "text-button",
        id: "studio-engine-checks",
        disabled: !can("dynamicChecks").available,
        title: can("dynamicChecks").reason,
        onclick: () => void runEngineChecks(),
      }, "Run engine checks"),
      iconButton("chevron", "Close problems", () => { problemsOpen = false; renderProblems(); renderStatus(); })),
    problems.length === 0
      ? emptyState("check", "No problems", "Schema validation and rpgkit-check found nothing to fix.")
      : h("ul", { class: "problem-list" }, problems.map((problem) => h("li", null,
        h("button", {
          type: "button",
          class: `problem ${problem.severity}`,
          title: problem.code,
          onclick: () => locate(problem),
        },
        h("span", { class: `sev ${problem.severity}` }, problem.severity),
        h("span", { class: "problem-message" }, problem.message),
        h("span", { class: "problem-where" }, [problem.common ? `common ${problem.common}` : problem.map, problem.event, problem.page === undefined ? undefined : `page ${problem.page + 1}`].filter(Boolean).join(" › ") || problem.code)),
        problem.fix
          ? h("button", {
              type: "button",
              class: "problem-fix",
              title: problem.fix.description,
              onclick: () => applyDoctorFix(problem),
            }, icon("check"), problem.fix.label)
          : null))),
  );
}

async function runEngineChecks(): Promise<void> {
  const session = app.session;
  if (!session || session.kind !== "inline") return;
  const outcome = await host.runChecks({ project: session.project(), mode: "dynamic" });
  if (!outcome.ok) {
    app.notify("error", outcome.message);
    return;
  }
  // Keep the schema, lint and doctor findings (recomputed from the current
  // document) and add the dynamic engine-check findings on top, so running
  // engine checks no longer clears the fixable problems.
  const staticProblems = await recomputeProblems();
  problems = [...staticProblems, ...outcome.problems];
  renderStatus();
  renderProblems();
}

function renderStatus(): void {
  const session = app.session;
  const map = app.currentMap();
  const hover = app.hover;
  let hoverText = "—";
  if (hover && map) {
    const index = hover.y * map.width + hover.x;
    const ground = map.ground[index] ?? "void";
    const upper = (map.upper ?? []).findLast(([cell]) => cell === index)?.[1];
    const region = (map.regions ?? []).findLast(([cell]) => cell === index)?.[1];
    hoverText = `(${hover.x}, ${hover.y}) ${ground}${upper ? ` / ${upper}` : ""}${region ? ` · region ${region}` : ""}`;
  }
  const selection = app.selection;
  const selectionText = selection.kind === "event"
    ? `event ${selection.eventId} · page ${selection.page + 1}`
    : selection.kind === "common"
      ? `common event ${selection.commonId}`
      : selection.kind === "cell" ? `cell (${selection.x}, ${selection.y})` : "nothing selected";
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  const dirty = session?.isDirty();
  replace($("statusbar"),
    h("span", { class: "status-item", id: "status-map" }, map ? `${map.name ? `${map.name} · ` : ""}${map.id} ${map.width}×${map.height}` : "No document"),
    h("span", { class: "status-item", id: "status-layer" }, `layer ${app.layer}${app.layer === "regions" ? ` · brush ${app.regionBrush || "erase"}` : ""}`),
    h("span", { class: "status-item mono", id: "status-hover" }, hoverText),
    h("span", { class: "status-item", id: "status-selection" }, selectionText),
    h("span", { class: "spacer" }),
    session?.kind === "pack" ? h("span", { class: "status-item", title: "Shards parsed so far / total" }, `shards ${session.loadedEntries().length}/${session.maps().length} loaded`) : null,
    h("span", { class: "status-item mono", title: "Last protocol operation" }, app.lastOpMs ? `op ${app.lastOpMs.toFixed(0)} ms` : ""),
    h("span", { class: `status-item ${files.saving > 0 ? "saving" : dirty ? "unsaved" : "saved"}`, id: "status-saved", "aria-live": "polite" }, !session ? "" : files.saving > 0 ? "saving…" : dirty ? "● unsaved" : savedText()),
    h("button", {
      type: "button",
      class: `status-problems${errors ? " has-errors" : warnings ? " has-warnings" : ""}`,
      id: "status-problems",
      "aria-expanded": String(problemsOpen),
      onclick: () => { problemsOpen = !problemsOpen; renderProblems(); renderStatus(); },
    }, icon(errors ? "warn" : "check"), ` ${errors} error${errors === 1 ? "" : "s"} · ${warnings} warning${warnings === 1 ? "" : "s"}`),
  );
}

function savedText(): string {
  if (!files.lastSavedAt) return "no changes";
  if (files.lastSavedWhere === "storage") return host.name === "browser" ? "saved in browser" : "saved";
  return `saved to ${files.target?.name ?? "disk"}`;
}

const noticeNodes = new Map<number, HTMLElement>();

function renderNotices(): void {
  const root = $("notices");
  const live = new Set(app.notices.map((notice) => notice.id));
  for (const [id, node] of noticeNodes) {
    if (live.has(id)) continue;
    node.remove();
    noticeNodes.delete(id);
  }
  for (const notice of app.notices) {
    let node = noticeNodes.get(notice.id);
    if (!node) {
      node = h("div", {
        class: `notice ${notice.level}`,
        role: notice.level === "error" ? "alert" : "status",
        dataset: { noticeId: String(notice.id) },
      },
      h("span", null, notice.text),
      h("button", { type: "button", class: "icon-button tiny", "aria-label": "Dismiss", onclick: () => app.dismiss(notice.id) }, "×"));
      noticeNodes.set(notice.id, node);
    }
    // appendChild also establishes chronological order without recreating an
    // existing toast (and therefore without replaying its entrance animation).
    root.appendChild(node);
  }
}

// ---- history ---------------------------------------------------------------------------

function renderHistory(): void {
  const session = app.session;
  const panel = $("history");
  if (!session) {
    replace(panel);
    return;
  }
  const done = session.history();
  const future = session.future();
  const rows = [
    done.length === 0 && future.length === 0 ? h("li", null, emptyState("history", "No edits yet", "Every edit becomes one step here; click a step to go back to it.")) : null,
    h("li", null, h("button", { type: "button", class: `history-row${done.length === 0 ? " current" : ""}`, onclick: () => app.jumpTo(0) }, h("span", { class: "muted" }, "Opened document"))),
    ...done.map((entry, index) => h("li", null, h("button", {
      type: "button",
      class: `history-row${index === done.length - 1 ? " current" : ""}`,
      title: `${entry.commands.join(" + ")} · ${entry.patch.changes.length} change${entry.patch.changes.length === 1 ? "" : "s"}`,
      onclick: () => app.jumpTo(index + 1),
    }, entry.label))),
    ...[...future].reverse().map((entry, offset) => h("li", null, h("button", {
      type: "button",
      class: "history-row undone",
      title: `${entry.commands.join(" + ")} (undone)`,
      onclick: () => app.jumpTo(done.length + offset + 1),
    }, entry.label))),
  ];
  replace(panel, h("p", { class: "hint" }, "Every step is a reversible rpgkit-edit patch. Click a step to go back or forward to it."), h("ol", { class: "history-list" }, rows));
}

// ---- dialogs ---------------------------------------------------------------------------

function dialog(title: string, ...content: (Node | null)[]): HTMLDialogElement {
  const element = h("dialog", { class: "studio-dialog", "aria-label": title },
    h("div", { class: "dialog-header" }, h("h2", null, title), h("button", { type: "button", class: "icon-button tiny", "aria-label": "Close", onclick: () => element.close() }, "×")),
    ...content);
  element.addEventListener("close", () => element.remove());
  document.body.appendChild(element);
  element.showModal();
  return element;
}

const IMPORT_DISPOSITIONS: readonly RpgMakerImportDisposition[] = ["Native", "Degraded", "Placeholder", "Dropped"];

/** Source folder -> visible progress -> coverage review -> explicit open.
 * The host owns both pickers and conversion; this dialog only renders plain
 * progress/result data from host.ts. */
function openRpgMakerImportDialog(): void {
  let placeholders: "visible" | "silent" = "visible";
  let progress: RpgMakerImportProgress | null = null;
  let outcome: RpgMakerImportOutcome | null = null;
  let running = false;
  const body = h("div", { class: "import-rpgmaker", dataset: { role: "rpgmaker-import" } });
  let element: HTMLDialogElement;

  const localizedDisposition = (disposition: RpgMakerImportDisposition): string => {
    const translated = rpgMakerImportText(importLocale)[disposition];
    return importLocale === "zh" ? `${translated} / ${disposition}` : translated;
  };

  const start = async (): Promise<void> => {
    running = true;
    outcome = null;
    progress = { token: "pending", phase: "selecting" };
    render();
    const result = await files.importRpgMaker(placeholders, (next) => {
      if (!element.isConnected) return;
      progress = next;
      render();
    }, rpgMakerImportText(importLocale).discardChanges);
    if (!element.isConnected) return;
    running = false;
    progress = null;
    if (result === null) {
      element.close();
      return;
    }
    outcome = result;
    render();
  };

  const cancel = (): void => {
    void files.cancelRpgMakerImport();
    element.close();
  };

  const languageControl = () => {
    const t = rpgMakerImportText(importLocale);
    return h("label", { class: "import-language" },
      h("span", null, t.language),
      h("select", {
        dataset: { action: "import-language" },
        value: importLocale,
        onchange: (event: Event) => {
          importLocale = (event.currentTarget as HTMLSelectElement).value as RpgMakerImportLocale;
          renderToolbar();
          render();
        },
      },
      h("option", { value: "en", selected: importLocale === "en" }, "English"),
      h("option", { value: "zh", selected: importLocale === "zh" }, "中文")));
  };

  const initialView = () => {
    const t = rpgMakerImportText(importLocale);
    return h("div", { class: "import-start" },
      h("div", { class: "import-lead" }, icon("open"),
        h("div", null, h("p", null, t.intro), h("p", { class: "muted" }, t.destination))),
      h("fieldset", { class: "import-placeholder-mode" },
        h("legend", null, t.placeholderMode),
        h("label", null,
          h("input", {
            type: "radio", name: "rpgmaker-placeholders", value: "visible", checked: placeholders === "visible",
            onchange: () => { placeholders = "visible"; render(); },
          }),
          h("span", null, h("strong", null, t.visiblePlaceholders), h("small", null, t.visiblePlaceholdersHint))),
        h("label", null,
          h("input", {
            type: "radio", name: "rpgmaker-placeholders", value: "silent", checked: placeholders === "silent",
            onchange: () => { placeholders = "silent"; render(); },
          }),
          h("span", null, h("strong", null, t.silentPlaceholders), h("small", null, t.silentPlaceholdersHint)))),
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "text-button", onclick: () => element.close() }, t.close),
        h("button", { type: "button", class: "primary-button", dataset: { action: "choose-rpgmaker-source" }, onclick: () => void start() }, t.chooseSource)));
  };

  const progressView = () => {
    const t = rpgMakerImportText(importLocale);
    const phase = progress?.phase ?? "selecting";
    const determinate = progress?.completed !== undefined && progress.total !== undefined && progress.total > 0;
    const value = determinate ? Math.max(0, Math.min(progress!.completed!, progress!.total!)) : undefined;
    return h("div", { class: "import-running", "aria-live": "polite" },
      h("div", { class: "import-running-mark" }, h("span", { class: "import-spinner", "aria-hidden": "true" }), icon("open")),
      h("h3", null, t.importing),
      h("p", { class: "import-phase" }, t.phase[phase]),
      progress?.message ? h("p", { class: "import-detail" }, progress.message) : null,
      determinate
        ? h("progress", { max: progress!.total!, value, "aria-label": t.phase[phase] })
        : h("div", { class: "import-progress-indeterminate", "aria-hidden": "true" }, h("span", null)),
      determinate ? h("p", { class: "import-progress-count" }, `${value} / ${progress!.total}`) : null,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "text-button", dataset: { action: "cancel-rpgmaker-import" }, onclick: cancel }, t.cancel)));
  };

  const resultView = (result: RpgMakerImportOutcome) => {
    const t = rpgMakerImportText(importLocale);
    if (!result.ok) {
      const cancelled = result.code === "CANCELLED";
      return h("div", { class: "import-result" },
        h("div", { class: `import-callout ${cancelled ? "cancelled" : "error"}`, role: cancelled ? "status" : "alert" },
          icon(cancelled ? "stop" : "warn"),
          h("div", null, h("strong", null, cancelled ? t.cancelled : t.failure),
            cancelled ? null : h("p", null, result.message))),
        h("div", { class: "dialog-actions" },
          h("button", { type: "button", class: "text-button", onclick: () => element.close() }, t.close),
          h("button", { type: "button", class: "primary-button", dataset: { action: "retry-rpgmaker-import" }, onclick: () => void start() }, t.retry)));
    }

    const limitations = result.coverage.rows.filter((row) => row.counts.Placeholder > 0 || row.counts.Dropped > 0);
    return h("div", { class: "import-result" },
      h("div", { class: "import-callout ready", role: "status" }, icon("check"), h("strong", null, t.ready)),
      h("section", { class: "import-coverage", "aria-label": t.coverage },
        h("div", { class: "import-section-heading" }, h("h3", null, t.coverage), h("p", null, t.coverageHint)),
        h("dl", { class: "import-metrics" }, IMPORT_DISPOSITIONS.map((disposition) =>
          h("div", { class: `import-metric ${disposition.toLowerCase()}` },
            h("dt", null, localizedDisposition(disposition)),
            h("dd", null, result.coverage.totals[disposition]),
            h("small", null, t.uses))))),
      h("section", { class: "import-limitations" },
        h("div", { class: "import-section-heading" }, h("h3", null, t.limitations), h("p", null, t.limitationHint)),
        limitations.length === 0
          ? h("p", { class: "import-none" }, t.noLimitations)
          : h("ul", null, limitations.map((row) => h("li", null,
              h("div", { class: "import-limitation-head" },
                h("code", null, `${row.section} · ${row.key}`),
                h("span", { class: "import-limitation-counts" },
                  row.counts.Placeholder > 0 ? `${localizedDisposition("Placeholder")} ${row.counts.Placeholder}` : null,
                  row.counts.Placeholder > 0 && row.counts.Dropped > 0 ? " · " : null,
                  row.counts.Dropped > 0 ? `${localizedDisposition("Dropped")} ${row.counts.Dropped}` : null)),
              h("p", null, h("strong", null, `${t.reasons}: `), row.reasons.length > 0 ? row.reasons.join("; ") : "—"))))),
      result.warnings.length > 0
        ? h("details", { class: "import-warnings" },
            h("summary", null, `${t.warnings} (${result.warnings.length})`),
            h("ul", null, result.warnings.map((warning) => h("li", null, warning))))
        : null,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "text-button", onclick: () => element.close() }, t.close),
        h("button", {
          type: "button", class: "primary-button", dataset: { action: "open-rpgmaker-result" },
          onclick: () => { if (files.openRpgMakerResult(result)) element.close(); },
        }, t.openResult)));
  };

  const render = (): void => {
    const t = rpgMakerImportText(importLocale);
    element.lang = importLocale === "zh" ? "zh-CN" : "en";
    const title = element.querySelector(".dialog-header h2");
    if (title) title.textContent = t.title;
    const close = element.querySelector<HTMLButtonElement>(".dialog-header button");
    if (close) close.setAttribute("aria-label", t.close);
    replace(body, languageControl(), running ? progressView() : outcome ? resultView(outcome) : initialView());
  };

  element = dialog(rpgMakerImportText(importLocale).title, body);
  element.classList.add("import-rpgmaker-dialog");
  element.addEventListener("close", () => { if (running) void files.cancelRpgMakerImport(); });
  render();
}

function openViewSettings(): void {
  const choices = [
    ["system", "Follow system", "Reduce motion when the operating system asks for it."],
    ["full", "Full motion", "Use smooth zoom, camera glides and pan inertia."],
    ["reduced", "Reduced motion", "Move the camera immediately and disable inertia."],
  ] as const;
  dialog("View settings",
    h("fieldset", { class: "view-settings", "data-role": "motion-settings" },
      h("legend", null, "Camera motion"),
      choices.map(([value, label, hint]) => h("label", { class: "view-setting" },
        h("input", {
          type: "radio",
          name: "studio-motion",
          value,
          checked: app.motion === value,
          onchange: () => app.setMotion(value),
        }),
        h("span", null, h("strong", null, label), h("small", null, hint)))),
      h("p", { class: "hint" }, `System currently ${app.systemReducedMotion ? "prefers reduced motion" : "allows motion"}.`)),
  );
}

const VEHICLE_KINDS: readonly VehicleKind[] = ["boat", "ship", "airship"];
const VEHICLE_DIRECTIONS: readonly VehicleDef["start"]["dir"][] = ["down", "left", "right", "up"];

function openMobilitySettings(): void {
  const session = app.session;
  if (!session) return;
  const globals = session.globals();
  const maps = session.maps();
  const byKind = new Map((globals.vehicles ?? []).map((vehicle) => [vehicle.kind, vehicle]));
  const followerToggle = h("input", {
    type: "checkbox",
    checked: globals.followers?.enabled ?? false,
    dataset: { mobilityFollowers: "enabled" },
  });
  const spriteIds = [...new Set([
    ...Object.keys(session.sprites()),
    ...(globals.vehicles ?? []).map((vehicle) => vehicle.sprite),
  ])].sort((a, b) => a.localeCompare(b));
  const spriteListId = `mobility-sprites-${Date.now()}`;
  const spriteList = h("datalist", { id: spriteListId }, spriteIds.map((id) => h("option", { value: id })));

  const selected = app.selection.kind === "cell"
    ? { map: app.mapId, x: app.selection.x, y: app.selection.y }
    : undefined;
  const fallbackMap = maps.find((map) => map.id === globals.start.map) ?? maps[0];
  const fallback = selected ?? {
    map: fallbackMap?.id ?? globals.start.map,
    x: fallbackMap?.id === globals.start.map ? globals.start.x : 0,
    y: fallbackMap?.id === globals.start.map ? globals.start.y : 0,
  };

  type VehicleControls = {
    kind: VehicleKind;
    enabled: HTMLInputElement;
    id: HTMLInputElement;
    sprite: HTMLInputElement;
    map: HTMLSelectElement;
    x: HTMLInputElement;
    y: HTMLInputElement;
    dir: HTMLSelectElement;
  };
  const controls: VehicleControls[] = [];
  const rows = VEHICLE_KINDS.map((kind) => {
    const existing = byKind.get(kind);
    const start = existing?.start ?? { ...fallback, dir: "down" as const };
    const enabled = h("input", { type: "checkbox", checked: existing !== undefined, "aria-label": `Configure ${kind}` });
    const id = h("input", { value: existing?.id ?? kind, pattern: "[A-Za-z0-9_-]+", "aria-label": `${kind} id` });
    const sprite = h("input", { value: existing?.sprite ?? spriteIds[0] ?? "", list: spriteListId, "aria-label": `${kind} sprite` });
    const map = h("select", { "aria-label": `${kind} start map` },
      maps.map((entry) => h("option", { value: entry.id, selected: entry.id === start.map }, entry.name ?? entry.id)),
      maps.some((entry) => entry.id === start.map) ? null : h("option", { value: start.map, selected: true }, `${start.map} (missing)`),
    );
    const x = h("input", { type: "number", min: 0, step: 1, value: start.x, "aria-label": `${kind} start x` });
    const y = h("input", { type: "number", min: 0, step: 1, value: start.y, "aria-label": `${kind} start y` });
    const dir = h("select", { "aria-label": `${kind} start direction` },
      VEHICLE_DIRECTIONS.map((value) => h("option", { value, selected: value === start.dir }, value)),
    );
    const syncBounds = () => {
      const selectedMap = maps.find((entry) => entry.id === map.value);
      x.max = selectedMap ? String(selectedMap.width - 1) : "";
      y.max = selectedMap ? String(selectedMap.height - 1) : "";
    };
    map.addEventListener("change", syncBounds);
    syncBounds();
    const placeHere = h("button", {
      type: "button",
      class: "text-button mobility-place",
      disabled: selected === undefined,
      title: selected ? `Use selected cell (${selected.x}, ${selected.y}) on ${selected.map}` : "Select a map cell first",
      onclick: () => {
        if (!selected) return;
        map.value = selected.map;
        x.value = String(selected.x);
        y.value = String(selected.y);
        syncBounds();
      },
    }, "Place here");
    controls.push({ kind, enabled, id, sprite, map, x, y, dir });
    return h("tr", { dataset: { vehicleKind: kind } },
      h("th", { scope: "row" }, h("label", null, enabled, h("span", null, kind))),
      h("td", null, id),
      h("td", null, sprite),
      h("td", null, map),
      h("td", { class: "mobility-coordinate" }, x),
      h("td", { class: "mobility-coordinate" }, y),
      h("td", null, dir),
      h("td", null, placeHere),
    );
  });

  let element: HTMLDialogElement;
  const apply = () => {
    const ids = new Set<string>();
    const vehicles: VehicleDef[] = [];
    for (const row of controls) {
      if (!row.enabled.checked) continue;
      const id = row.id.value.trim();
      const sprite = row.sprite.value.trim();
      const mapId = row.map.value;
      const map = maps.find((entry) => entry.id === mapId);
      const x = Number(row.x.value);
      const y = Number(row.y.value);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        app.notify("error", `${row.kind} id needs only letters, digits, underscore or hyphen.`);
        row.id.focus();
        return;
      }
      if (ids.has(id)) {
        app.notify("error", `Vehicle id “${id}” is used more than once.`);
        row.id.focus();
        return;
      }
      ids.add(id);
      if (!sprite) {
        app.notify("error", `${row.kind} needs a sprite id.`);
        row.sprite.focus();
        return;
      }
      if (!map || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= map.width || y >= map.height) {
        app.notify("error", `${row.kind} start must be an in-bounds cell on an existing map.`);
        (map ? row.x : row.map).focus();
        return;
      }
      vehicles.push({
        id,
        kind: row.kind,
        sprite,
        start: { map: map.id, x, y, dir: row.dir.value as VehicleDef["start"]["dir"] },
        ...(Object.prototype.hasOwnProperty.call(byKind.get(row.kind) ?? {}, "bgm")
          ? { bgm: byKind.get(row.kind)!.bgm === null ? null : { ...byKind.get(row.kind)!.bgm! } }
          : {}),
      });
    }
    const response = app.run("update-mobility", {
      followersEnabled: followerToggle.checked,
      vehicles,
    }, "Update followers & vehicles");
    if (response?.ok) element.close();
  };

  element = dialog("Followers & vehicles",
    h("div", { class: "mobility-settings", dataset: { role: "mobility-settings" } },
      h("label", { class: "mobility-followers" }, followerToggle,
        h("span", null, h("strong", null, "Followers enabled"), h("small", null, "Show the configured party trail at the start of a game."))),
      spriteList,
      h("div", { class: "mobility-table-wrap" }, h("table", { class: "mobility-table" },
        h("thead", null, h("tr", null,
          h("th", null, "Kind"), h("th", null, "ID"), h("th", null, "Sprite"), h("th", null, "Start map"),
          h("th", null, "X"), h("th", null, "Y"), h("th", null, "Dir"), h("th", null, ""))),
        h("tbody", null, rows))),
      h("p", { class: "hint" }, "Enable a row to configure that vehicle. IDs must be unique; starts must be inside the selected map."),
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "text-button", onclick: () => element.close() }, "Cancel"),
        h("button", { type: "button", class: "primary-button", dataset: { action: "save-mobility" }, onclick: apply }, "Apply"))),
  );
}

function openPngImportDialog(): void {
  const session = app.session;
  if (!session) return;
  let picked: Awaited<ReturnType<StudioHost["pickImage"]>> = null;
  let closed = false;
  const image = new Image();
  const preview = h("canvas", { class: "png-import-preview", width: 384, height: 256 }) as HTMLCanvasElement;
  const message = h("p", { class: "hint png-import-status", role: "status" }, "Choose a PNG to preview its grid.");
  const kind = h("select", { "aria-label": "Import kind" }, h("option", { value: "sheet" }, "Tile sheet"), h("option", { value: "walker" }, "Walker sheet")) as HTMLSelectElement;
  const id = h("input", { type: "text", placeholder: "asset_id", "aria-label": "Asset id" }) as HTMLInputElement;
  const labels = { cellWidth: "Cell width", cellHeight: "Cell height", offsetX: "Offset X", offsetY: "Offset Y", spacingX: "Spacing X", spacingY: "Spacing Y" } as const;
  const fields = (Object.keys(labels) as (keyof typeof labels)[]).map((key) => {
    const input = h("input", { type: "number", min: key.startsWith("cell") ? 1 : 0, step: 1, value: key.startsWith("cell") ? 16 : 0, "aria-label": key }) as HTMLInputElement;
    return { key, input, row: h("label", { class: "png-import-field" }, h("span", null, labels[key]), input) };
  });
  const grid = (): PngGrid => Object.fromEntries(fields.map(({ key, input }) => [key, input.valueAsNumber])) as unknown as PngGrid;
  const redraw = () => {
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, preview.width, preview.height);
    if (!image.naturalWidth) return;
    const scale = Math.min(preview.width / image.naturalWidth, preview.height / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    ctx.drawImage(image, 0, 0, w, h);
    const g = grid();
    const problem = pngGridProblem(image.naturalWidth, image.naturalHeight, g, kind.value as PngImportKind);
    if (problem) { message.textContent = problem; return; }
    const cols = gridCount(image.naturalWidth, g.cellWidth, g.offsetX, g.spacingX);
    const rows = gridCount(image.naturalHeight, g.cellHeight, g.offsetY, g.spacingY);
    ctx.strokeStyle = "#ffdb50";
    ctx.lineWidth = 1;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      ctx.strokeRect((g.offsetX + x * (g.cellWidth + g.spacingX)) * scale,
        (g.offsetY + y * (g.cellHeight + g.spacingY)) * scale, g.cellWidth * scale, g.cellHeight * scale);
    }
    message.textContent = `${cols} × ${rows} cells · ${image.naturalWidth} × ${image.naturalHeight} PNG`;
  };
  const choose = async () => {
    const next = await host.pickImage();
    if (closed || app.session !== session) {
      if (next && !("error" in next)) next.release();
      return;
    }
    if (!next) return;
    if ("error" in next) { app.notify("error", next.error); return; }
    if (picked && !('error' in picked)) picked.release();
    picked = next;
    id.value = next.name.replace(/\.png$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "imported";
    image.src = next.url;
    try {
      await image.decode();
      if (!closed && picked === next) redraw();
    } catch {
      if (!closed && picked === next) message.textContent = "Could not preview this PNG.";
    }
  };
  const importNow = async () => {
    if (!picked || "error" in picked || !image.naturalWidth) { message.textContent = "Choose a valid PNG first."; return; }
    const selectedKind = kind.value as PngImportKind;
    const g = grid();
    const problem = pngImportProblem({ kind: selectedKind, id: id.value, sourceName: picked.name, bytes: picked.bytes, grid: g });
    if (problem) { message.textContent = problem; return; }
    const existing = selectedKind === "sheet" ? session.sheets().some((sheet) => sheet.id === id.value) : !!session.sprites()[id.value];
    if (existing && !await host.confirm(`Replace existing ${selectedKind} ${id.value}?`)) return;
    if (closed || app.session !== session) { message.textContent = "Project changed; reopen PNG import for the current project."; return; }
    const source = picked;
    try {
      const decoded = await BROWSER_RPGMAKER_IMAGE_CODEC.decode(source.bytes);
      const cropped = cropGrid(decoded.data, decoded.width, decoded.height, g);
      const cooked = await BROWSER_RPGMAKER_IMAGE_CODEC.encode({ width: cropped.width, height: cropped.height, data: cropped.rgba });
      if (closed || app.session !== session || picked !== source) { message.textContent = "Project or PNG changed; reopen import for the current selection."; return; }
      const result = app.importPng({ kind: selectedKind, id: id.value, sourceName: source.name, bytes: source.bytes, grid: g,
        ...(selectedKind === "sheet" && app.currentMap() ? { map: app.currentMap()!.id } : {}), replace: existing }, cooked);
      if (result.ok) { app.notify("ok", result.message); window.close(); }
      else message.textContent = result.message;
    } catch (error) { message.textContent = `PNG import failed: ${error instanceof Error ? error.message : String(error)}`; }
  };
  kind.addEventListener("change", redraw);
  for (const { input } of fields) input.addEventListener("input", redraw);
  const window = dialog("Import PNG",
    h("div", { class: "png-import" },
      h("p", { class: "hint" }, "Import a PNG into this project. Tile sheets attach to the current map; walkers use three columns and four directional rows."),
      h("button", { type: "button", class: "text-button png-import-pick", onclick: () => void choose() }, "Choose PNG…"),
      h("div", { class: "png-import-meta" },
        h("label", { class: "png-import-field" }, h("span", null, "Kind"), kind),
        h("label", { class: "png-import-field" }, h("span", null, "Asset id"), id)),
      h("div", { class: "png-import-grid" }, ...fields.map(({ row }) => row)),
      preview, message,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "primary-button", onclick: () => void importNow() }, "Import into project"))));
  window.addEventListener("close", () => {
    closed = true;
    if (picked && !("error" in picked)) picked.release();
    picked = null;
    image.removeAttribute("src");
  });
}

function openArtDialog(): void {
  const session = app.session;
  if (!session) return;
  const body = h("div", { class: "art-list" });
  const localArt = can("localArt");
  const render = () => {
    const sheetRows = session.sheets().map((sheet) => {
      const status = art.sheetStatus(sheet.id);
      const choose = async () => {
        const picked = await host.pickImage();
        if (!picked) return;
        if ("error" in picked) {
          app.notify("error", picked.error);
          return;
        }
        await art.setLocalSheet(sheet.id, picked);
        const loaded = art.sheetStatus(sheet.id);
        if (loaded.width && (loaded.width < sheet.cols * 16 || loaded.height < sheet.rows * 16)) {
          app.notify("error", `${picked.name} is ${loaded.width}×${loaded.height}; sheet ${sheet.id} needs ${sheet.cols * 16}×${sheet.rows * 16}. Cells outside the image draw empty.`);
        }
        render();
      };
      return h("tr", null,
        h("td", null, h("code", null, sheet.id)), h("td", null, "tile sheet"),
        h("td", null, `${sheet.cols}×${sheet.rows} cells`),
        h("td", { class: `art-status ${status.source}` }, status.source === "missing" ? "placeholder" : status.source, status.from ? h("span", { class: "muted" }, ` ${status.source === "project" ? status.from : status.from.split("/").pop()}`) : null),
        h("td", null, h("button", { type: "button", class: "text-button", dataset: { artSheet: sheet.id }, disabled: !localArt.available, title: localArt.reason, onclick: () => void choose() }, "Choose PNG…")));
    });
    const spriteRows = Object.entries(session.sprites()).map(([id, def]) => {
      const status = art.spriteStatus(id);
      const choose = async () => {
        const picked = await host.pickImage();
        if (!picked) return;
        if ("error" in picked) {
          app.notify("error", picked.error);
          return;
        }
        await art.setLocalSprite(id, picked);
        render();
      };
      return h("tr", null,
        h("td", null, h("code", null, id)), h("td", null, def.kind === "walker" ? "walker sheet" : "image"),
        h("td", null, def.kind === "image" ? def.src : "sheet" in def ? def.sheet : "atlases"),
        h("td", { class: `art-status ${status.source}` }, status.source === "missing" ? "placeholder" : status.source, status.from && status.source === "project" ? h("span", { class: "muted" }, ` ${status.from}`) : null),
        h("td", null, h("button", { type: "button", class: "text-button", disabled: !localArt.available, title: localArt.reason, onclick: () => void choose() }, "Choose PNG…")));
    });
    replace(body, h("table", { class: "art-table" },
      h("thead", null, h("tr", null, h("th", null, "Id"), h("th", null, "Kind"), h("th", null, "Size / source"), h("th", null, "Art"), h("th", null, ""))),
      h("tbody", null, sheetRows, spriteRows)));
  };
  render();
  dialog("Art",
    h("p", { class: "hint" }, `Tile sheets and characters are drawn from art keyed by id. A project folder brings its own (art/sheets/<id>.png, each sprite's src or sheet path, art/sprites/<id>.png), and so does a pack that carries art; bundled examples bring theirs. The Choose PNG buttons below provide temporary art without changing the project. ${localArt.reason}`),
    h("button", { type: "button", disabled: !localArt.available, title: localArt.reason, onclick: openPngImportDialog }, "Import PNG into project…"),
    body);
}

function openShortcuts(): void {
  const mac = MOD === "⌘";
  const chord = (keys: string[]) => h("span", { class: "chord" }, keys.map((key, i) => [i > 0 ? h("span", { class: "plus" }, "+") : null, h("kbd", null, keyLabel(key, mac))]));
  dialog("Keyboard shortcuts",
    h("div", { class: "shortcut-grid", "data-role": "shortcuts" }, SHORTCUT_GROUPS.map((group) =>
      h("section", { class: "shortcut-group" },
        h("h3", null, group.title),
        h("dl", null, group.items.map((item) => [
          h("dt", null, item.keys.map((keys, i) => [i > 0 ? h("span", { class: "or" }, "/") : null, chord(keys)])),
          h("dd", null, item.action),
        ]))))),
    h("p", { class: "hint shortcut-foot" }, "Every toolbar button's tooltip also names its shortcut."));
}

// ---- right column tabs ----------------------------------------------------------------

function selectTab(tab: "inspector" | "history"): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  $("inspector").hidden = tab !== "inspector";
  $("history").hidden = tab !== "history";
  if (tab === "history") renderHistory();
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
  button.addEventListener("click", () => selectTab(button.dataset.tab as "inspector" | "history"));
}

// ---- events ------------------------------------------------------------------------------

app.on((reason) => {
  if (reason === "preferences") {
    host.setPreferences(app.preferences());
    document.documentElement.dataset.motion = app.reducedMotion ? "reduced" : "full";
  }
  if (reason === "hover") {
    renderStatus();
    return;
  }
  if (reason === "view") {
    const zoom = document.getElementById("studio-zoom");
    if (zoom) zoom.textContent = `${Math.round(app.view.zoom * 100)}%`;
    return;
  }
  if (reason === "notice") {
    renderNotices();
    return;
  }
  if (reason === "load" || reason === "edit" || reason === "history" || reason === "problems" || reason === "saved") scheduleProblems();
  if (reason === "load") {
    document.title = `${app.session?.title() ?? "Studio"} — Pocket RPG Kit Studio`;
  }
  renderToolbar();
  renderStatus();
  if (!$("history").hidden) renderHistory();
});

host.guardClose(() => app.session?.isDirty() ?? false);

function deleteSelectedEvent(): void {
  const selection = app.selection;
  const map = app.currentMap();
  if (selection.kind !== "event" || !map) return;
  const response = app.run("delete-event", { map: map.id, event: selection.eventId }, `Delete event ${selection.eventId}`);
  if (response?.ok) app.select({ kind: "none" });
}

function duplicateSelectedEvent(): void {
  const selection = app.selection;
  const map = app.currentMap();
  if (selection.kind !== "event" || !map) return;
  const event = map.events?.find((item) => item.id === selection.eventId);
  if (!event) return;
  const copy = eventCopyOp(map, event);
  const response = app.run("add-event", copy.op.args ?? {}, `Duplicate event ${event.id}`);
  if (response?.ok) app.select({ kind: "event", eventId: copy.id, page: 0 });
}

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && key === "k") {
    event.preventDefault();
    commandPalette.open();
    return;
  }
  if (commandPalette.isOpen) return;
  if (mod && key === "z") {
    if (isTyping(event)) return;
    event.preventDefault();
    if (event.shiftKey) app.redo(); else app.undo();
    return;
  }
  if (mod && key === "y") { if (isTyping(event)) return; event.preventDefault(); app.redo(); return; }
  if (mod && key === "s") { event.preventDefault(); void files.save(); return; }
  if (mod && key === "o") { event.preventDefault(); files.openFile(); return; }
  if (mod && event.shiftKey && key === "e") { event.preventDefault(); void files.download(); return; }
  if (mod && key === "enter") { if (!app.session || !can("preview").available) return; event.preventDefault(); playPanel.open(); return; }
  if (mod && key === "d") { if (isTyping(event)) return; event.preventDefault(); duplicateSelectedEvent(); return; }
  if (mod || event.altKey || isTyping(event)) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.shiftKey && /^Digit[1-5]$/.test(event.code)) {
    event.preventDefault();
    const layer = (["ground", "upper", "passage", "regions", "events"] as const)[Number(event.code.slice(-1)) - 1]!;
    app.visible[layer] = !app.visible[layer];
    app.emit("view");
    renderToolbar();
    return;
  }
  const tool = TOOLS.find(([, , , shortcut]) => shortcut.toLowerCase() === key);
  if (tool) { app.setTool(tool[0]); return; }
  const layer = LAYERS.find(([, , shortcut]) => shortcut === key);
  if (layer) { app.setLayer(layer[0]); return; }
  if (key === "g") { app.visible.grid = !app.visible.grid; app.emit("view"); renderToolbar(); return; }
  if (key === "p") { app.visible.passage = !app.visible.passage; app.emit("view"); renderToolbar(); return; }
  if (key === "=" || key === "+") { canvas?.zoomStep(1); return; }
  if (key === "-") { canvas?.zoomStep(-1); return; }
  if (key === "0") { canvas?.fit(); return; }
  if (key === "?") { openShortcuts(); return; }
  if (key === "escape") {
    closeMenus();
    if (canvas?.cancelDrag()) return;
    app.select({ kind: "none" });
    return;
  }
  if ((key === "delete" || key === "backspace") && (event.target === document.body || event.target === canvas?.canvas)) {
    event.preventDefault();
    deleteSelectedEvent();
  }
});

// ---- host menus ---------------------------------------------------------------------------

/** Whether a text field has the focus (Undo there is the field's own). */
function typingInField(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

/** The desktop app's menu bar. Its shortcuts are the page's own (handled
 * above); a click on the menu item arrives here. */
function runHostCommand(command: HostCommand): void {
  switch (command) {
    case "open-file": files.openFile(); return;
    case "open-folder": void files.openDirectory(); return;
    case "save": void files.save(); return;
    case "export": void files.download(); return;
    case "undo": if (typingInField()) document.execCommand("undo"); else app.undo(); return;
    case "redo": if (typingInField()) document.execCommand("redo"); else app.redo(); return;
    case "problems": problemsOpen = !problemsOpen; renderProblems(); renderStatus(); return;
    case "engine-checks":
      problemsOpen = true;
      renderProblems();
      renderStatus();
      if (can("dynamicChecks").available) void runEngineChecks();
      return;
    case "agent": if (app.session && can("agent").available) agentPanel.toggle(); return;
    case "playtest": if (app.session && can("preview").available) playPanel.open(); return;
    case "theme": toggleTheme(); return;
    case "shortcuts": openShortcuts(); return;
  }
}
host.onCommand?.(runHostCommand);

// ---- boot ---------------------------------------------------------------------------------

/** Test and debugging hook: state, timings and coordinate helpers. */
(window as unknown as { __studio: unknown }).__studio = {
  app,
  art,
  files,
  host,
  canvas,
  play,
  agent,
  agentPanel,
  commandPalette,
  minimap,
  hoverCard,
  askAgent,
  frameStats: () => canvas?.stats,
  lintIdle: () => lintScheduler.idle(),
  cellToClient: (x: number, y: number) => canvas?.cellToClient(x, y),
  tileAt: (x: number, y: number) => {
    const map = app.currentMap();
    return map ? map.ground[y * map.width + x] ?? null : null;
  },
  parseTileId,
};

renderToolbar();
renderStatus();
renderNotices();
await files.loadExamples();
renderToolbar();
const params = new URLSearchParams(location.search);
const requested = params.get("example");
/** Open what the OS handed the host before Studio started; false if none
 * opened. */
async function openInitial(): Promise<boolean> {
  let any = false;
  for (const opened of host.initialDocuments?.() ?? []) any = (await files.opened(opened)) || any;
  return any;
}
if (requested) await files.openExample(requested);
else if (!(await openInitial()) && !files.restore()) await files.openExample(files.examples[0]?.id ?? "sunstone");
document.documentElement.dataset.ready = "1";
