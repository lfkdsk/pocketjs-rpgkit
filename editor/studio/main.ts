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
import { ArtRegistry, parseTileId } from "./art.ts";
import { MapCanvas, isTyping } from "./canvas.ts";
import { CommandPalette, type StudioCommand } from "./command-palette.ts";
import { emptyState, h, icon, iconButton, MOD, replace } from "./dom.ts";
import { StudioFiles } from "./files.ts";
import type { HostCommand, HostFeature, StudioHost, ThemeChoice } from "./host.ts";
import { BrowserHost } from "./host-browser.ts";
import { mountInspector } from "./inspector.ts";
import { eventCopyOp, insertionAddress, insertCommandOp, opLabel, PICKER_ENTRIES } from "./inspector-model.ts";
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

const host: StudioHost = (globalThis as { studioHost?: StudioHost }).studioHost ?? new BrowserHost();
const app = new StudioApp();
const art = new ArtRegistry();
const files = new StudioFiles(app, art, host);
const can = (feature: HostFeature) => host.capabilities()[feature];
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
  ["edges", "Edges", "4"],
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
  const map = app.currentMap();
  if (!map || selection.kind !== "event") return;
  const event = map.events?.find((item) => item.id === selection.eventId);
  const page = event?.pages[selection.page];
  if (!event || !page) return;
  const address = insertionAddress(page.commands, selection.command);
  if (!address) return;
  const operation = insertCommandOp({ map: map.id, event: event.id, page: selection.page }, address, defaultCommand(op as Parameters<typeof defaultCommand>[0]));
  const response = app.run(operation.command, operation.args ?? {}, `Add ${op} command`);
  if (response?.ok) {
    app.select({ ...selection, command: address });
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
    { id: "view:fit", label: "Fit map", detail: "Center the whole map", shortcut: "0", section: "Actions", disabled: noDocument, run: () => canvas?.fit() },
    { id: "view:settings", label: "View settings", detail: "Motion and camera behavior", section: "Actions", run: openViewSettings },
    { id: "view:theme", label: `Use ${effectiveTheme() === "dark" ? "light" : "dark"} theme`, keywords: "appearance color", section: "Actions", run: toggleTheme },
    { id: "view:art", label: "Manage project art…", keywords: "image png sheet sprite", section: "Actions", disabled: noDocument, run: openArtDialog },
    { id: "play:start", label: "Play-test", detail: "Run from the selected cell", shortcut: `${MOD}+Enter`, section: "Actions", disabled: !session ? "Open a project first" : can("preview").available ? undefined : can("preview").reason, run: () => playPanel.open() },
    ...TOOLS.map(([tool, , label, shortcut]): StudioCommand => ({
      id: `tool:${tool}`, label, detail: "Select editing tool", shortcut, section: "Actions", disabled: noDocument, run: () => app.setTool(tool),
    })),
    ...LAYERS.map(([layer, label, shortcut]): StudioCommand => ({
      id: `layer:${layer}`, label: `Edit ${label} layer`, detail: "Change the active editing layer", shortcut, section: "Actions", disabled: noDocument, run: () => app.setLayer(layer),
    })),
    ...(["ground", "upper", "passage", "events"] as const).map((layer, index): StudioCommand => ({
      id: `visibility:${layer}`, label: `${app.visible[layer] ? "Hide" : "Show"} ${layer} layer`, detail: "Canvas visibility", shortcut: `Shift+${index + 1}`, section: "Actions", disabled: noDocument,
      run: () => { app.visible[layer] = !app.visible[layer]; app.emit("view"); renderToolbar(); },
    })),
  ];
  if (!session) return commands;

  commands.push(...session.maps().map((item): StudioCommand => ({
    id: `map:${item.id}`, label: item.name ?? item.id, detail: `${item.id} · ${item.width}×${item.height}`, keywords: `map ${item.id}`, section: "Maps",
    run: () => { app.openMap(item.id); canvas?.canvas.focus(); },
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
    openMenu(openButton, [
      ["Open file…", () => files.openFile(), `${MOD}+O`],
      ["Open folder…", () => void files.openDirectory(), undefined, folder.available ? undefined : folder.reason],
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
      toggle("passage", "pass", "Passage overlay", "P")),
    h("div", { class: "group zoom" },
      iconButton("zoomOut", "Zoom out", () => canvas?.zoomStep(-1), { shortcut: "-" }),
      h("button", { type: "button", class: "zoom-label", title: "Fit map (0)", id: "studio-zoom", onclick: () => canvas?.fit() }, `${Math.round(app.view.zoom * 100)}%`),
      iconButton("zoomIn", "Zoom in", () => canvas?.zoomStep(1), { shortcut: "=" })),
    h("div", { class: "spacer" }),
    h("div", { class: "group" },
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
        h("span", { class: "problem-where" }, [problem.map, problem.event, problem.page === undefined ? undefined : `page ${problem.page + 1}`].filter(Boolean).join(" › ") || problem.code)),
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
    const upper = (map.upper ?? []).find(([cell]) => cell === index)?.[1];
    hoverText = `(${hover.x}, ${hover.y}) ${ground}${upper ? ` / ${upper}` : ""}`;
  }
  const selection = app.selection;
  const selectionText = selection.kind === "event" ? `event ${selection.eventId} · page ${selection.page + 1}` : selection.kind === "cell" ? `cell (${selection.x}, ${selection.y})` : "nothing selected";
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  const dirty = session?.isDirty();
  replace($("statusbar"),
    h("span", { class: "status-item", id: "status-map" }, map ? `${map.name ? `${map.name} · ` : ""}${map.id} ${map.width}×${map.height}` : "No document"),
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
  const element = h("dialog", { class: "studio-dialog" },
    h("div", { class: "dialog-header" }, h("h2", null, title), h("button", { type: "button", class: "icon-button tiny", "aria-label": "Close", onclick: () => element.close() }, "×")),
    ...content);
  element.addEventListener("close", () => element.remove());
  document.body.appendChild(element);
  element.showModal();
  return element;
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
    h("p", { class: "hint" }, `Tile sheets and characters are drawn from art keyed by id. A project folder brings its own (art/sheets/<id>.png, each sprite's src or sheet path, art/sprites/<id>.png), and so does a pack that carries art; bundled examples bring theirs. For other ids choose a local PNG. ${localArt.reason} The project JSON does not change.`),
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
  if (event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
    event.preventDefault();
    const layer = (["ground", "upper", "passage", "events"] as const)[Number(event.code.slice(-1)) - 1]!;
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
