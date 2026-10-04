// editor/app.tsx — the tile-map editor shell.
//
//   root View (dark, overflow-hidden)
//     header row      LAYER DOC < >      UNDO REDO SAVE
//     [no-svc banner] gamepad-mode legend, only without a companion
//     PalettePanel    eraser + every sheet cell of the current map
//     Canvas          ground, event markers, upper star cells, cursor
//     status bar      doc / map / layer / selection / mode / save result
//
// Input has TWO live modes, neither silent:
//   - rpgkit-editor companion (desktop host, --companions rpgkit-editor):
//     real mouse + keyboard arrive as svc JSON lines (svc.ts). Left click
//     paints, right click / shift erases, drag strokes, wheel scrolls the
//     palette, cmd+z / cmd+shift+z / cmd+s drive undo/redo/save.
//   - no companion (goldens, hosts/sim without injected ops, browsers): a
//     visible amber banner names the controls and the same editor runs from
//     buttons: d-pad moves the cursor across canvas/palette/header, CIRCLE
//     paints, CROSS erases, SQUARE/TRIANGLE undo/redo, L/R switch maps,
//     SELECT toggles the layer, START saves. A missing companion must
//     never leave a window whose buttons are silently dead.
//
// Documents: the editor boots on the first bundled example document
// (engine/projects.ts; a copy saved on data.fs wins). With the companion,
// the host's --file arrives as a {t:"load"} line and replaces it; from
// then on SAVE writes that file and DOC stays on it, so the open document
// can never be saved over a different project's file.

import { batch, createEffect, createMemo, createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import type { GameEvent, MapDef, MapIndexEntry, Page, Project, ProjectShell, ProjectSource, TileId } from "../src/engine/types.ts";
import { canonicalMapJson, isProjectShell, mapManifestHash, sha256Text } from "../src/engine/map-repository.ts";
import { deepClone } from "../src/engine/clone.ts";
import {
  addPage,
  canRedo,
  canUndo,
  commitProjectReplacement,
  copyPage,
  createEditorState,
  createEventAt,
  currentMap,
  deleteMap,
  deletePage,
  deleteSelectedEvent,
  duplicateMap,
  duplicateSelectedEvent,
  edgePaintCell,
  edgeStrokeEnd,
  edgeStrokeStart,
  eventMarkers,
  exportProject,
  mapReferences,
  markSaved,
  movePage,
  moveSelectedEvent,
  newMap,
  paintCell,
  paletteTiles,
  redo,
  renameMap,
  renameSelectedEvent,
  resizeMap,
  resizeSelectedEvent,
  selectEvent,
  selectLayer,
  selectMap,
  selectPage,
  selectPassageBrush,
  selectTile,
  setMapName,
  setMapSheets,
  slotForTile,
  strokeEnd,
  strokeStart,
  undo,
  updateSelectedPage,
  type EdgeBrush,
  type EditorState,
  type MapReference,
} from "./engine/model.ts";
import { loadProject, serializeProjectPreservingSource, validateProject } from "./engine/document.ts";
import { documentStructureErrors } from "./api/operations.ts";
import { BUNDLED_PROJECTS } from "./engine/projects.ts";
import { createTileTextures } from "./engine/textures.ts";
import {
  HEADER_H,
  STATUS_H,
  PAL_COLS,
  PAL_GRID_TOP,
  PAL_PITCH,
  PAL_W,
  clampCam,
  EVENT_TOOL_COLS,
  EVENT_TOOL_IDS,
  PASS_TOOL_COLS,
  PASS_TOOL_IDS,
  PASS_TOOL_LABELS,
  fittedView,
  compactHeader,
  headerButtons,
  hitEventTool,
  hitPassTool,
  hitTest,
  type HeaderButtonId,
  type PassTool,
} from "./engine/layout.ts";
import { HEADER_ORDER, initialCursor, stepCursor, type Cursor } from "./engine/cursor.ts";
import { connectSvc, type HostLine, type Svc } from "./svc.ts";
import {
  LOCAL_AGENT_MAX_PROMPT,
  LOCAL_AGENT_PROTOCOL,
  parseLocalAgentHostMessage,
  type LocalAgentReady,
  type LocalAgentStart,
  type LocalAgentState,
} from "./agent/types.ts";
import { createShardedEditorWorkspace, type ShardedEditorWorkspace } from "./engine/sharded-workspace.ts";
import { hitMapListRow, mapListWindow, revealMapListRow } from "./engine/map-list.ts";
import { hasFs, readProject, writeProject } from "./store.ts";
import { Banner, EventPanel, HeaderButton, PalettePanel, type PaletteThumb } from "./ui/panels.tsx";
import { PassPanel } from "./ui/pass-panel.tsx";
import { Canvas, type CellEdges } from "./ui/canvas.tsx";
import { DIM, GOOD, BAD } from "./ui/panels.tsx";
import {
  eventDragDestination,
  topmostEventAt,
  type EventDragPreview,
} from "./engine/event-canvas.ts";
import {
  CONDITION_KINDS,
  EDITABLE_COMMAND_OPS,
  battleBranchPath,
  choiceBranchPath,
  commandAddressKey,
  copyCommand,
  defaultCommand,
  deleteCommand,
  getCommandList,
  ifBranchPath,
  insertCommand,
  loopBodyPath,
  moveCommand,
  sceneBranchPath,
  updateCommand,
  type CommandAddress,
  type ConditionKind,
  type EditableCommandOp,
} from "./engine/commands.ts";
import {
  addPageCondition,
  commandInspectorRows,
  conditionFields,
  deletePageCondition,
  editCommandField,
  editPageConditionField,
  editPageField,
  editPageRouteField,
  eventGeometryValue,
  nextFieldValue,
  pageFieldDescriptors,
  pageRouteFieldDescriptors,
  type EditableField,
  type InspectorCommandRow as EditableCommandRow,
} from "./engine/event-fields.ts";
import { eventEditorResources } from "./engine/event-resources.ts";
import {
  createEventInspectorLayout,
  hitTestEventInspector,
  ZERO_INSPECTOR_SCROLL,
  type EventInspectorAction,
  type InspectorScrollOffsets,
} from "./engine/event-layout.ts";
import {
  createMapInspectorLayout,
  hitTestMapInspector,
  type MapInspectorAction,
  type MapField,
} from "./engine/map-layout.ts";
import { EventInspector, flattenInspectorConditions } from "./ui/event-inspector.tsx";
import { MapInspector } from "./ui/map-inspector.tsx";
import { MapList } from "./ui/map-list.tsx";
import { ProposalPanel } from "./ui/proposal-panel.tsx";
import {
  hitProposalPanel,
  proposalVisibleRows,
  type ProposalPanelAction,
} from "./engine/proposal-layout.ts";
import {
  applyProposalHunks,
  assessHunk,
  assessProposal,
  decideProposalHunks,
  parseProposal,
  previewProposalHunks,
  proposalComplete,
  proposalSemanticHash,
} from "./proposals/model.ts";
import {
  editorSaveBridgeCapability,
  readEditorSaveResult,
  readProposalHostState,
  readProposalSession,
  writeEditorSaveRequest,
  writeProposalSession,
} from "./proposals/store.ts";
import type {
  EditProposal,
  EditorSaveRequest,
  ProposalPreview,
} from "./proposals/types.ts";
import {
  buildPlaytestProject,
  playtestStartCell,
  capturePlaytestCarry,
  diagnosePlaytestProject,
  playtestDebugRows,
  playtestRowEdit,
  type PlaytestCarry,
  type PlaytestIssue,
} from "./engine/playtest.ts";
import {
  hitTestPlaytest,
  playtestPanelRect,
  playtestRowsPerPage,
  type PlaytestTab,
} from "./engine/playtest-layout.ts";
import { createPlaytestAssets } from "./engine/playtest-view.ts";
import { PLAYTEST_BUNDLED_ART } from "./engine/playtest-bundled-art.ts";
import type { GameAssets } from "../src/ui/game-assets.ts";
import type { SessionState } from "../src/engine/session.ts";
import { PlaytestSurface, type PlaytestPort } from "./ui/playtest.tsx";
import { editorTextWidth, fitEditorText } from "./ui/text-fit.ts";

type Notice = { kind: "info" | "good" | "bad"; text: string };

// Fallback logical viewport when the host reports none (the fixed 480x272
// profile the goldens and the sim tests boot at).
const SCREEN_W = 480;
const SCREEN_H = 272;

interface DocSlot {
  id: string;
  project: Project;
  sourceText: string;
}

interface BootDoc {
  slot: DocSlot;
  warning: Notice | null;
}

interface PendingMapRead {
  entry: string;
  resolve(map: MapDef): void;
  reject(error: Error): void;
}

interface PendingShardedSave {
  token: number;
  activeMapId: string | null;
  activeMapText: string | null;
  shardCount: number;
}

/** Present one resident shard to the existing single-project editor model.
 * The shell remains authoritative for the catalog and persistence identity. */
function projectForShardedMap(shell: ProjectShell, map: MapDef): Project {
  const {
    mapIndex: _mapIndex,
    mapManifestHash: _mapManifestHash,
    mapSchemaHash: _mapSchemaHash,
    ...globals
  } = shell;
  const start = shell.start.map === map.id
    ? shell.start
    : { map: map.id, x: 0, y: 0, dir: shell.start.dir };
  return { ...deepClone(globals), start: deepClone(start), maps: [deepClone(map)] };
}

interface HostSaveGuard {
  /** Last host revision observed before the accepted review was queued. */
  previousHash: string;
  /** Null means the bridge merged a host revision the guest cannot model. */
  expectedHash: string | null;
  /** Expected host document after applying the accepted hunks. */
  baseline: DocSlot | null;
}

interface PendingHostSave {
  request: EditorSaveRequest;
  baseline: DocSlot;
  project: Project;
  successPrefix: string;
}

let saveRequestSequence = 0;
let agentRequestSequence = 0;

function saveRequestId(expectedSourceHash: string, projectHash: string): string {
  saveRequestSequence++;
  return sha256Text(`${Date.now()}\n${saveRequestSequence}\n${expectedSourceHash}\n${projectHash}`);
}

/** The document gate: schema errors, then the edit protocol's structural
 *  checks (a document the protocol cannot edit is not opened). */
function documentErrors(text: string): { project: Project; errors: { path: string; msg: string }[] } {
  const loaded = loadProject(text);
  if (loaded.errors.length > 0) return loaded;
  return { project: loaded.project, errors: documentStructureErrors(loaded.project as unknown as ProjectSource) };
}

function bootDoc(index: number): BootDoc {
  const bundled = BUNDLED_PROJECTS[index]!;
  const bundledSlot = (): DocSlot => ({
    id: bundled.id,
    project: loadProject(bundled.json).project,
    sourceText: bundled.json,
  });
  const rejected = (error: string): BootDoc => ({
    slot: bundledSlot(),
    warning: { kind: "bad", text: `EXPORTED COPY REJECTED: ${error}; OPENED BUNDLED ${bundled.id}` },
  });
  // A previously exported copy on data.fs wins over the bundled document.
  const onFs = readProject(bundled.id);
  if (onFs && "text" in onFs) {
    const loaded = documentErrors(onFs.text);
    if (loaded.errors.length === 0) {
      return {
        slot: { id: bundled.id, project: loaded.project, sourceText: onFs.text },
        warning: null,
      };
    }
    const error = `${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`;
    return rejected(error);
  }
  if (onFs && "error" in onFs) return rejected(onFs.error);
  return { slot: bundledSlot(), warning: null };
}

export function EditorApp(): JSX.Element {
  const svc: Svc | null = connectSvc();
  const fsOk = hasFs();
  const proposalSession = readProposalSession();
  const initialDoc = bootDoc(0);

  const vp0 = hostViewport(getOps());
  const [vp, setVp] = createSignal(vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H });
  const [docIndex, setDocIndex] = createSignal(0);
  const [doc, setDoc] = createSignal<DocSlot>(initialDoc.slot);
  const [editor, setEditor] = createSignal<EditorState>(createEditorState(doc().project));
  const [cam, setCam] = createSignal({ x: 0, y: 0 });
  const [notice, setNotice] = createSignal<Notice>(initialDoc.warning ?? {
    kind: "info",
    text: svc
      ? fsOk
        ? "POINTER MODE (companion): LEFT PAINT, RIGHT/SHIFT ERASE"
        : "POINTER MODE (companion; no data.fs: SAVE GOES TO THE HOST FILE)"
      : "NO COMPANION - GAMEPAD MODE (SEE BANNER)",
  });
  // Every edit runs as an editor/api operation; one the protocol refuses
  // leaves the document unchanged and is reported here, once.
  let reportedRefusal: EditorState["error"] = null;
  createEffect(() => {
    const refusal = editor().error;
    if (!refusal || refusal === reportedRefusal) return;
    reportedRefusal = refusal;
    setNotice({ kind: "bad", text: `EDIT REFUSED: ${refusal.message.toUpperCase()}` });
  });
  const [palScroll, setPalScroll] = createSignal(0);
  const [hover, setHover] = createSignal<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = createSignal<Cursor>(initialCursor(0, 0));
  const [headerMenuOpen, setHeaderMenuOpen] = createSignal(false);
  const [savedText, setSavedText] = createSignal<string | null>(null);
  const [loadNotice, setLoadNotice] = createSignal<string | null>(null);
  /** True once the host's --file document is open: SAVE writes that file,
   *  so DOC must not swap another project in under it. */
  const [hostFile, setHostFile] = createSignal(false);
  const [shardedWorkspace, setShardedWorkspace] = createSignal<ShardedEditorWorkspace | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = createSignal(0);
  const [catalogIndex, setCatalogIndex] = createSignal(0);
  const [mapListOpen, setMapListOpen] = createSignal(false);
  const [mapListCursor, setMapListCursor] = createSignal(0);
  const [mapListScroll, setMapListScroll] = createSignal(0);
  const [loadingMapIndex, setLoadingMapIndex] = createSignal<number | null>(null);
  const [savePending, setSavePending] = createSignal(false);
  const [pendingHostSave, setPendingHostSave] = createSignal<PendingHostSave | null>(null);
  const [eventMode, setEventMode] = createSignal(false);
  const [inspectorOpen, setInspectorOpen] = createSignal(false);
  const [eventPlacement, setEventPlacement] = createSignal({ x: 0, y: 0 });
  const [selectedCell, setSelectedCell] = createSignal<{ mapId: string; x: number; y: number } | null>(null);
  const [dragPreview, setDragPreview] = createSignal<EventDragPreview | null>(null);
  const [inspectorSelection, setInspectorSelection] = createSignal<{
    condition: number | null;
    command: number | null;
  }>({ condition: null, command: null });
  const [inspectorFocus, setInspectorFocus] = createSignal<EventInspectorAction | null>(null);
  const [inputBuffer, setInputBuffer] = createSignal("");
  const [inspectorScroll, setInspectorScroll] = createSignal<InspectorScrollOffsets>({
    ...ZERO_INSPECTOR_SCROLL,
  });
  const [passTool, setPassTool] = createSignal<PassTool>("pass");
  const [mapInspectorOpen, setMapInspectorOpen] = createSignal(false);
  const [mapFocus, setMapFocus] = createSignal<MapInspectorAction | null>(null);
  const [mapInput, setMapInput] = createSignal("");
  const [deleteRefs, setDeleteRefs] = createSignal<{
    mapId: string;
    references: MapReference[];
  } | null>(null);
  const [mapReferencePage, setMapReferencePage] = createSignal(0);
  const [pendingPick, setPendingPick] = createSignal<{
    mapIndex: number;
    eventId: string;
    pageIndex: number;
    address: CommandAddress;
    /** Object identity pins the exact command revision. Map switches retain
     *  it; undo/redo and structural command changes do not. */
    command: Page["commands"][number];
  } | null>(null);
  const [proposals, setProposals] = createSignal<EditProposal[]>(proposalSession?.proposals ?? []);
  const [proposalOpen, setProposalOpen] = createSignal(false);
  const [selectedProposal, setSelectedProposal] = createSignal<number | null>(null);
  const [selectedProposalHunk, setSelectedProposalHunk] = createSignal(0);
  const [proposalScroll, setProposalScroll] = createSignal(0);
  const [agentReady, setAgentReady] = createSignal<LocalAgentReady>({
    t: "agent-ready",
    protocol: LOCAL_AGENT_PROTOCOL,
    available: false,
    adapter: "local agent",
    message: svc ? "Waiting for local-agent companion…" : "Desktop companion required",
    maxPromptChars: LOCAL_AGENT_MAX_PROMPT,
  });
  const [agentState, setAgentState] = createSignal<LocalAgentState | null>(null);
  const [agentInput, setAgentInput] = createSignal("");
  const [agentInputFocus, setAgentInputFocus] = createSignal(false);
  const [hostSaveGuard, setHostSaveGuard] = createSignal<HostSaveGuard | null>(null);
  const [playProject, setPlayProject] = createSignal<Project | null>(null);
  const [playAssets, setPlayAssets] = createSignal<GameAssets | null>(null);
  const [playState, setPlayState] = createSignal<SessionState | null>(null);
  const [playDebug, setPlayDebug] = createSignal(false);
  const [playTab, setPlayTab] = createSignal<PlaytestTab>("switch");
  const [playPage, setPlayPage] = createSignal(0);
  const [playIssues, setPlayIssues] = createSignal<PlaytestIssue[]>([]);
  const [carryPrevious, setCarryPrevious] = createSignal(false);
  const [lastPlayCarry, setLastPlayCarry] = createSignal<PlaytestCarry | null>(null);
  const [playStartCell, setPlayStartCell] = createSignal<{ mapId: string; x: number; y: number } | null>(null);

  // Input transactions live beside the reactive editor state. Mode changes
  // must close both halves together: reducer strokes and these UI latches.
  let pointerDown: false | "paint" | "erase" | "event" | "pass" | "edge" = false;
  let eventDrag: { event: GameEvent; start: { x: number; y: number } } | null = null;
  let pointerX = PAL_W;
  let prevButtons = 0;
  let strokeOpen = false;
  let edgeStrokeOpen = false;
  let playPointerDown = false;
  let playPort: PlaytestPort | null = null;
  let nextServiceRequest = 1;
  let activationGeneration = 0;
  const pendingMapReads = new Map<number, PendingMapRead>();
  const pendingShardedSaves = new Map<number, PendingShardedSave>();
  const syncedMapText = new Map<string, string>();

  const tileTextures = createTileTextures();

  const bumpWorkspace = (): void => {
    setWorkspaceRevision((value) => value + 1);
  };
  const catalog = createMemo<readonly MapIndexEntry[]>(() => {
    workspaceRevision();
    return shardedWorkspace()?.catalog ?? [];
  });
  const mapListPanelHeight = (viewportHeight = vp().h): number =>
    Math.max(0, viewportHeight - HEADER_H - STATUS_H);
  const proposalPanelHeight = (viewportHeight = vp().h): number =>
    Math.max(0, viewportHeight - HEADER_H - STATUS_H);
  const applyViewport = (width: number, height: number): void => {
    setVp({ w: width, h: height });
    if (!compactHeader(width)) setHeaderMenuOpen(false);
    if (mapListOpen()) {
      setMapListScroll((scroll) => revealMapListRow(
        mapListCursor(),
        catalog().length,
        mapListPanelHeight(height),
        scroll,
      ));
    }
    if (proposalOpen()) {
      const pending = shardedWorkspace() ? [] : proposals().filter((proposal) => !proposalComplete(proposal));
      const selected = selectedProposal();
      const proposal = selected === null ? undefined : pending[selected];
      const detail = proposal !== undefined;
      const visible = proposalVisibleRows(proposalPanelHeight(height), detail, !detail);
      const count = detail ? proposal.hunks.length : pending.length;
      setProposalScroll((scroll) => {
        const max = Math.max(0, count - visible);
        if (!detail || visible === 0) return Math.min(scroll, max);
        const hunk = Math.min(selectedProposalHunk(), Math.max(0, count - 1));
        const revealed = hunk < scroll
          ? hunk
          : hunk >= scroll + visible
            ? hunk - visible + 1
            : scroll;
        return Math.max(0, Math.min(max, revealed));
      });
    }
  };
  const dirtyEntries = createMemo<ReadonlySet<string>>(() => {
    workspaceRevision();
    const workspace = shardedWorkspace();
    if (!workspace) return new Set<string>();
    const ids = new Set(workspace.dirtyMapIds);
    if (editor().dirty && workspace.activeMapId) ids.add(workspace.activeMapId);
    return new Set(workspace.catalog.filter((meta) => ids.has(meta.id)).map((meta) => meta.entry));
  });
  const visibleMapRows = createMemo(() => {
    if (!mapListOpen()) return 0;
    const windowed = mapListWindow(catalog().length, mapListPanelHeight(), mapListScroll());
    return windowed.end - windowed.first;
  });
  const pendingProposals = createMemo(() =>
    shardedWorkspace() ? [] : proposals().filter((proposal) => !proposalComplete(proposal)));
  const agentRunning = createMemo(() => {
    const status = agentState()?.status;
    return status === "starting" || status === "running" || status === "cancelling";
  });
  const proposalAssessments = createMemo(() => {
    const project = exportProject(editor());
    return pendingProposals().map((proposal) => assessProposal(project, proposal));
  });
  const proposalPreview = createMemo<ProposalPreview>(() => {
    const index = selectedProposal();
    if (!proposalOpen() || index === null) return { tiles: [], events: [], maps: [] };
    const proposal = pendingProposals()[index];
    const assessment = proposalAssessments()[index];
    if (!proposal || !assessment) return { tiles: [], events: [], maps: [] };
    const cleanIds = proposal.hunks.filter((hunk, hunkIndex) =>
      !hunk.decision && assessment.hunks[hunkIndex]?.state === "clean").map((hunk) => hunk.id);
    if (cleanIds.length === 0) return { tiles: [], events: [], maps: [] };
    try {
      return previewProposalHunks(exportProject(editor()), proposal, cleanIds);
    } catch {
      return { tiles: [], events: [], maps: [] };
    }
  });

  const map = createMemo(() => currentMap(editor()));
  const markers = createMemo(() => eventMarkers(map()));
  /** PASS mode: the active layer is the passage override layer. Event mode
   *  is orthogonal to the layer (the layer cycle passes through PASS on the
   *  way to EVENT), so it must exclude event mode explicitly. */
  const passMode = createMemo(() => !eventMode() && editor().layer === "passage");
  const passageDense = createMemo(() => editor().passageDense[editor().mapIndex] ?? null);
  // Ground painting replaces the map wrapper on every changed cell. Keep
  // sheet identity behind its own memo so ordinary painting does not rebuild
  // edge metadata for all 10,000 cells of a 100x100 map. Canvas resolves only
  // its bounded visible window through this stable lookup.
  const sheetDefs = createMemo(() => editor().project.sheets);
  const tileEdges = createMemo<ReadonlyMap<string, CellEdges>>(() => {
    const out = new Map<string, CellEdges>();
    for (const sheet of sheetDefs()) {
      for (const [cell, edges] of Object.entries(sheet.dirEdges ?? {})) {
        out.set(`${sheet.id}.${Number(cell)}`, edges);
      }
    }
    return out;
  });
  const edgeForTile = (tile: TileId): CellEdges | null =>
    tile === null ? null : tileEdges().get(tile) ?? null;
  const selectedEvent = createMemo<GameEvent | null>(() => {
    const id = editor().selectedEventId;
    return id === null ? null : (map().events ?? []).find((event) => event.id === id) ?? null;
  });
  const activePage = createMemo<Page | null>(() =>
    selectedEvent()?.pages[editor().selectedPageIndex] ?? null,
  );
  const inspectorResources = createMemo(() => eventEditorResources(editor().project, map()));
  const conditionRows = createMemo(() => flattenInspectorConditions(activePage() ?? undefined, inspectorResources()));
  const commandRows = createMemo<EditableCommandRow[]>(() =>
    commandInspectorRows(activePage()?.commands ?? [], inspectorResources()),
  );
  const inspectorLayout = createMemo(() => {
    const event = selectedEvent();
    if (!event) return null;
    return createEventInspectorLayout({
      width: vp().w,
      height: vp().h - HEADER_H - STATUS_H,
      pageCount: event.pages.length,
      activePage: editor().selectedPageIndex,
      conditions: conditionRows(),
      commands: commandRows(),
      scroll: inspectorScroll(),
      measure: editorTextWidth,
    });
  });
  const mapInspectorLayout = createMemo(() => {
    if (!mapInspectorOpen()) return null;
    const pendingDelete = deleteRefs();
    return createMapInspectorLayout({
      width: vp().w,
      height: vp().h - HEADER_H - STATUS_H,
      referenceCount: pendingDelete?.references.length ?? 0,
      referencePage: mapReferencePage(),
      showNotice: notice().text.length > 0,
    });
  });
  // Content-compared: a paint stroke replaces the project object, but the
  // palette (and the 133 thumbnail nodes under it) only changes with the
  // map's sheets.
  const palette = createMemo(() => paletteTiles(editor()), undefined, { equals: sameTiles });
  const selectedSlot = createMemo(() => slotForTile(palette(), editor().tile));
  const banner = createMemo(() => svc === null);
  const fit = createMemo(() => fittedView(vp().w, vp().h, banner()));
  const viewCols = () => fit().cols;
  const viewRows = () => fit().rows;

  const texKey = (tile: TileId): string => (tile === null ? "" : tileTextures.key(tile) ?? "");

  const thumbs = createMemo<PaletteThumb[]>(() =>
    palette().map((tile, slot) => ({
      slot,
      tileKey: tile,
      src: texKey(tile),
      label: tile ?? "erase",
    })),
  );

  const clampCameraTo = (state: EditorState, next: { x: number; y: number }) => {
    const m = currentMap(state);
    return {
      x: clampCam(next.x, m.width, viewCols()),
      y: clampCam(next.y, m.height, viewRows()),
    };
  };

  const abandonShardedRequests = (reason: string): void => {
    activationGeneration++;
    for (const pending of pendingMapReads.values()) pending.reject(new Error(reason));
    pendingMapReads.clear();
    pendingShardedSaves.clear();
    syncedMapText.clear();
    setSavePending(false);
    setLoadingMapIndex(null);
  };

  const requestMapShard = (meta: MapIndexEntry): Promise<MapDef> => {
    if (!svc) return Promise.reject(new Error("sharded projects require an editor file host"));
    const request = nextServiceRequest++;
    return new Promise<MapDef>((resolve, reject) => {
      pendingMapReads.set(request, { entry: meta.entry, resolve, reject });
      svc.readMap(meta.entry, request);
    });
  };

  /** Flush the active reducer snapshot into the workspace at explicit
   * boundaries. Edits stay inside the single resident map between switches,
   * so per-frame work never scales with the 263-entry catalog. */
  const syncActiveShardedMap = (): MapDef | null => {
    const workspace = shardedWorkspace();
    const id = workspace?.activeMapId;
    if (!workspace || !id) return null;
    let state = editor();
    if (state.stroke) state = strokeEnd(state);
    if (state.edgeStroke) state = edgeStrokeEnd(state);
    if (state !== editor()) setEditor(state);
    const active = exportProject(state).maps[0]!;
    const text = canonicalMapJson(active);
    if (text !== syncedMapText.get(id)) {
      workspace.replaceMap(id, active);
      syncedMapText.set(id, text);
      bumpWorkspace();
    }
    return active;
  };

  const activateShardedMap = async (index: number): Promise<void> => {
    const workspace = shardedWorkspace();
    const entries = workspace?.catalog ?? [];
    if (!workspace || entries.length === 0) return;
    const target = Math.max(0, Math.min(entries.length - 1, index));
    const meta = entries[target]!;
    syncActiveShardedMap();
    const generation = ++activationGeneration;
    setLoadingMapIndex(target);
    setNotice({ kind: "info", text: `LOADING ${meta.id}…` });
    try {
      const loadedMap = await workspace.activateMap(meta.id);
      if (generation !== activationGeneration || shardedWorkspace() !== workspace) return;
      const project = projectForShardedMap(workspace.shell, loadedMap);
      const problem = documentStructureErrors(project)[0];
      if (problem) throw new Error(`${problem.path} ${problem.msg}`);
      const sourceText = serializeProjectPreservingSource(JSON.stringify(project), project, project);
      syncedMapText.set(meta.id, canonicalMapJson(loadedMap));
      batch(() => {
        setDoc({ id: "sharded", project, sourceText });
        setEditor(createEditorState(project));
        setCatalogIndex(target);
        setMapListCursor(target);
        setMapListScroll(revealMapListRow(target, entries.length, mapListPanelHeight(), mapListScroll()));
        setMapListOpen(false);
        setLoadingMapIndex(null);
        setCam({ x: 0, y: 0 });
        setCursor(initialCursor(0, 0));
        setHover(null);
        setPalScroll(0);
        setEventMode(false);
        setInspectorOpen(false);
        setMapInspectorOpen(false);
        setPendingPick(null);
        setPlayStartCell(null);
        setNotice({ kind: "good", text: `LOADED ${meta.id} (${target + 1}/${entries.length})` });
      });
      bumpWorkspace();
    } catch (error) {
      if (generation !== activationGeneration || shardedWorkspace() !== workspace) return;
      setLoadingMapIndex(null);
      setNotice({ kind: "bad", text: `MAP LOAD FAILED: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const handleMapReply = (line: HostLine): void => {
    if (line.request === undefined) return;
    const pending = pendingMapReads.get(line.request);
    if (!pending) return;
    pendingMapReads.delete(line.request);
    if (line.entry !== pending.entry) {
      pending.reject(new Error(`host returned ${line.entry ?? "an unnamed shard"} for ${pending.entry}`));
      return;
    }
    if (line.t === "map-error") {
      pending.reject(new Error(line.error ?? `host could not read ${pending.entry}`));
      return;
    }
    if (line.t !== "map-data" || typeof line.text !== "string") {
      pending.reject(new Error(`host returned no data for ${pending.entry}`));
      return;
    }
    try {
      pending.resolve(JSON.parse(line.text) as MapDef);
    } catch (error) {
      pending.reject(new Error(`invalid map JSON for ${pending.entry}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  const leaveShardedProject = (reason: string): void => {
    if (shardedWorkspace()) abandonShardedRequests(reason);
    setShardedWorkspace(null);
    setMapListOpen(false);
    setMapListCursor(0);
    setMapListScroll(0);
    setCatalogIndex(0);
    bumpWorkspace();
  };

  const resetForProject = (project: Project, message: Notice): void => {
    batch(() => {
      setEditor(createEditorState(project));
      setCam({ x: 0, y: 0 });
      setCursor(initialCursor(0, 0));
      setHover(null);
      setPalScroll(0);
      setEventMode(false);
      setInspectorOpen(false);
      setMapInspectorOpen(false);
      setMapFocus(null);
      setMapInput("");
      setDeleteRefs(null);
      setMapReferencePage(0);
      setPendingPick(null);
      setProposalOpen(false);
      setSelectedProposal(null);
      setSelectedProposalHunk(0);
      setProposalScroll(0);
      setHostSaveGuard(null);
      setPendingHostSave(null);
      setPassTool("pass");
      setEventPlacement({ x: 0, y: 0 });
      setSelectedCell(null);
      setPlayStartCell(null);
      setDragPreview(null);
      setInspectorSelection({ condition: null, command: null });
      setInspectorFocus(null);
      setInputBuffer("");
      setInspectorScroll({ ...ZERO_INSPECTOR_SCROLL });
      setNotice(message);
    });
  };

  const switchDoc = (): void => {
    if (hostFile()) {
      setNotice({ kind: "bad", text: "DOC IS THE HOST --file; RELAUNCH TO OPEN ANOTHER PROJECT" });
      return;
    }
    const nextIndex = (docIndex() + 1) % BUNDLED_PROJECTS.length;
    leaveShardedProject("another document was opened");
    setDocIndex(nextIndex);
    const opened = bootDoc(nextIndex);
    const slot = opened.slot;
    setDoc(slot);
    setSavedText(null);
    resetForProject(
      slot.project,
      opened.warning ?? { kind: "info", text: `OPENED ${slot.id}: ${slot.project.title}` },
    );
  };

  const switchMap = (delta: number): void => {
    const workspace = shardedWorkspace();
    if (workspace) {
      if (pendingPick()) {
        setNotice({ kind: "bad", text: "CROSS-MAP TARGET PICKING IS UNAVAILABLE IN A LAZY PROJECT" });
        return;
      }
      const count = workspace.catalog.length;
      if (count === 0 || loadingMapIndex() !== null) return;
      const next = (catalogIndex() + delta + count) % count;
      if (next !== catalogIndex()) void activateShardedMap(next);
      return;
    }
    const e = editor();
    const count = e.project.maps.length;
    const next = (e.mapIndex + delta + count) % count;
    if (next === e.mapIndex) return;
    const switched = selectMap(e, next);
    setDeleteRefs(null);
    setMapReferencePage(0);
    // pendingPick survives map switches: picking a target on another map is
    // the whole point of the flow.
    batch(() => {
      setEditor(switched);
      setCam(clampCameraTo(switched, cam()));
      setSelectedCell(null);
      setPlayStartCell(null);
    });
  };

  const performShardedSave = (hostRequest?: number): void => {
    const workspace = shardedWorkspace();
    if (!workspace || !svc) return;
    if (savePending()) {
      if (hostRequest !== undefined) svc.saveError(hostRequest, "a sharded save is already in progress");
      setNotice({ kind: "bad", text: "SAVE ALREADY IN PROGRESS" });
      return;
    }
    const active = syncActiveShardedMap();
    const candidate = exportProject(editor());
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      if (hostRequest !== undefined) svc.saveError(hostRequest, `${errors[0]!.path} ${errors[0]!.msg}`);
      setNotice({
        kind: "bad",
        text: `EXPORT REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const before = workspace.shell;
    const output = workspace.buildSavePayload();
    const request = hostRequest ?? nextServiceRequest++;
    const shards = Object.entries(output.shards).map(([entry, text]) => {
      const expected = before.mapIndex.find((meta) => meta.entry === entry)?.sha256;
      if (!expected) throw new Error(`dirty shard ${entry} is absent from the open shell`);
      return { entry, text, expectedSha256: expected };
    });
    const shellText = `${JSON.stringify(output.shell, null, 2)}\n`;
    pendingShardedSaves.set(request, {
      token: output.token,
      activeMapId: workspace.activeMapId,
      activeMapText: active ? canonicalMapJson(active) : null,
      shardCount: shards.length,
    });
    setSavePending(true);
    svc.saveProject({
      baseManifestHash: before.mapManifestHash ?? mapManifestHash(before),
      shell: shellText,
      shards,
    }, request);
    setNotice({ kind: "info", text: `SAVING ${shards.length} CHANGED MAP${shards.length === 1 ? "" : "S"}…` });
  };

  const handleProjectSaved = (line: HostLine): void => {
    if (line.request === undefined) return;
    const pending = pendingShardedSaves.get(line.request);
    const workspace = shardedWorkspace();
    if (!pending || !workspace) return;
    pendingShardedSaves.delete(line.request);
    setSavePending(pendingShardedSaves.size > 0);
    workspace.acknowledgeSave(pending.token, line.ok === true);
    if (line.ok !== true) {
      bumpWorkspace();
      setNotice({ kind: "bad", text: `SAVE FAILED: ${line.error ?? "host rejected the project"}` });
      return;
    }
    const active = workspace.activeMapId;
    const current = active ? canonicalMapJson(exportProject(editor()).maps[0]!) : null;
    if (active === pending.activeMapId && current === pending.activeMapText &&
      !workspace.dirtyMapIds.includes(active!)) {
      setEditor(markSaved(editor()));
    }
    setSavedText(`${JSON.stringify(workspace.shell, null, 2)}\n`);
    bumpWorkspace();
    setNotice({
      kind: "good",
      text: `SAVED ${pending.shardCount} MAP SHARD${pending.shardCount === 1 ? "" : "S"} + PROJECT SHELL`,
    });
  };

  const resolvePendingHostBaseline = (): DocSlot | null => {
    const pending = hostSaveGuard();
    if (!pending) return doc();
    const observed = readProposalHostState();
    if (pending.expectedHash === null || pending.baseline === null) {
      setNotice({ kind: "bad", text: "SAVE REFUSED: HOST FILE CHANGED DURING PROPOSAL REVIEW; RELOAD THE EDITOR" });
      return null;
    }
    if (observed?.projectHash === pending.expectedHash) {
      setDoc(pending.baseline);
      setHostSaveGuard(null);
      return pending.baseline;
    }
    if (!observed || observed.projectHash === pending.previousHash) {
      setNotice({ kind: "bad", text: "SAVE REFUSED: WAITING FOR HOST PROPOSAL APPLY; WAIT OR RELOAD THE EDITOR" });
      return null;
    }
    setNotice({ kind: "bad", text: "SAVE REFUSED: HOST FILE CHANGED DURING PROPOSAL REVIEW; RELOAD THE EDITOR" });
    return null;
  };

  const performSave = (
    provided?: EditorState,
    successPrefix = "SAVED",
    browserRequest?: number,
  ): void => {
    if (pendingHostSave()) {
      setNotice({ kind: "bad", text: "SAVE WAITING FOR HOST COMMIT" });
      return;
    }
    let e = provided ?? editor();
    if (provided === undefined && e.stroke) {
      e = strokeEnd(e);
      setEditor(e);
    }
    if (provided === undefined && e.edgeStroke) {
      e = edgeStrokeEnd(e);
      setEditor(e);
    }
    if (shardedWorkspace()) {
      performShardedSave(browserRequest);
      return;
    }
    const candidate = exportProject(e);
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      if (svc && browserRequest !== undefined) {
        svc.saveError(browserRequest, `${errors[0]!.path} ${errors[0]!.msg}`);
      }
      setNotice({
        kind: "bad",
        text: `EXPORT REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const baseline = resolvePendingHostBaseline();
    if (!baseline) return;
    const observed = readProposalHostState();
    if (hostFile() && observed && observed.projectHash !== proposalSemanticHash(baseline.project)) {
      setNotice({ kind: "bad", text: "SAVE REFUSED: HOST FILE CHANGED SINCE IT WAS LOADED; RELOAD THE EDITOR" });
      return;
    }
    const text = serializeProjectPreservingSource(
      baseline.sourceText,
      baseline.project,
      candidate,
    );
    const finish = (message: string): void => {
      batch(() => {
        setSavedText(text);
        setDoc({ ...baseline, project: candidate, sourceText: text });
        setEditor(markSaved(e));
        setNotice({ kind: "good", text: message });
      });
    };
    if (svc) {
      // The managed launcher exposes data.fs host state. Queue an exact-source
      // CAS there so SAVE shares the project lock with CLI edits and proposal
      // acceptance. A generic companion without the bridge keeps the legacy
      // svc save path.
      const saveBridge = hostFile() && fsOk ? editorSaveBridgeCapability() : "absent";
      if (saveBridge !== "absent") {
        if (saveBridge !== "ready" || !observed) {
          setNotice({ kind: "bad", text: "SAVE REFUSED: HOST SAVE BRIDGE IS NOT READY; WAIT OR RELOAD THE EDITOR" });
          return;
        }
        const expectedSourceHash = sha256Text(baseline.sourceText);
        const projectHash = proposalSemanticHash(candidate);
        const saveRequest: EditorSaveRequest = {
          id: saveRequestId(expectedSourceHash, projectHash),
          expectedSourceHash,
          projectHash,
          text,
        };
        const queued = writeEditorSaveRequest(saveRequest);
        if ("error" in queued) {
          setNotice({ kind: "bad", text: `SAVE FAILED: ${queued.error}` });
          return;
        }
        setPendingHostSave({ request: saveRequest, baseline, project: candidate, successPrefix });
        setNotice({ kind: "info", text: `SAVE QUEUED ${text.length} bytes FOR HOST CAS` });
        return;
      }
      svc.save(text, browserRequest);
      // Receipt only means the generic host accepted the message. The
      // browser companion reports localStorage or Download failures in its
      // page chrome, so do not claim durable persistence here.
      finish(`SENT ${text.length} bytes TO HOST`);
      return;
    }
    if (fsOk) {
      const result = writeProject(doc().id, text);
      if ("error" in result) {
        setNotice({ kind: "bad", text: `SAVE FAILED: ${result.error}` });
        return;
      }
      finish(`${successPrefix} ${result.bytes} bytes TO ${result.path}`);
      return;
    }
    // Explicit, visible failure: no silent drop (the fs API's same rule).
    setNotice({
      kind: "bad",
      text: "NO SAVE CHANNEL: RELAUNCH WITH THE rpgkit-editor COMPANION OR A DATA.FS HOST",
    });
  };

  const settlePendingHostSave = (): void => {
    const pending = pendingHostSave();
    if (!pending) return;
    const result = readEditorSaveResult();
    if (!result || result.id !== pending.request.id) return;
    setPendingHostSave(null);
    if (result.status !== "saved") {
      setNotice({
        kind: "bad",
        text: result.status === "conflict"
          ? "SAVE REFUSED: HOST FILE CHANGED BEFORE COMMIT; RELOAD THE EDITOR"
          : `SAVE REFUSED: ${result.message ?? "HOST REJECTED THE DOCUMENT"}`,
      });
      return;
    }
    const stillCurrent = proposalSemanticHash(exportProject(editor())) === pending.request.projectHash;
    batch(() => {
      setSavedText(pending.request.text);
      setDoc({ ...pending.baseline, project: pending.project, sourceText: pending.request.text });
      if (stillCurrent) setEditor(markSaved(editor()));
      setNotice({
        kind: "good",
        text: `${pending.successPrefix} ${pending.request.text.length} bytes TO HOST FILE`,
      });
    });
  };

  /** Commit any live paint transaction and clear every pointer/gamepad
   *  latch before a mode boundary changes how releases are interpreted. */
  const finishActiveInput = (): void => {
    let e = editor();
    if (e.stroke) e = strokeEnd(e);
    if (e.edgeStroke) e = edgeStrokeEnd(e);
    if (e !== editor()) setEditor(e);
    pointerDown = false;
    eventDrag = null;
    setDragPreview(null);
    strokeOpen = false;
    edgeStrokeOpen = false;
  };

  const persistProposalQueue = (
    next: EditProposal[],
    changed?: EditProposal,
  ): boolean => {
    setProposals(next);
    // projectHash is the bridge's last observation of the real host file.
    // Review UI must never replace it with an unconfirmed in-memory result.
    const observed = readProposalSession();
    const projectHash = observed?.projectHash ?? proposalSession?.projectHash ?? proposalSemanticHash(doc().project);
    const stored = writeProposalSession({ projectHash, proposals: next });
    if (changed && svc) svc.reviewProposal(changed);
    if ("error" in stored) {
      setNotice({ kind: "bad", text: `PROPOSAL STATUS NOT SAVED: ${stored.error}` });
      return false;
    }
    return true;
  };

  const locateProposalHunk = (proposal: EditProposal, hunkIndex: number): void => {
    const hunk = proposal.hunks[hunkIndex];
    if (!hunk) return;
    const project = exportProject(editor());
    let mapIndex = -1;
    const pathMap = /^\/maps\/(\d+)(?:\/|$)/.exec(hunk.changes[0]?.path ?? "");
    if (pathMap) mapIndex = Number(pathMap[1]);
    let location: { mapId: string; x: number; y: number } | undefined;
    try {
      const preview = previewProposalHunks(project, proposal, [hunk.id]);
      const first = preview.tiles[0] ?? preview.events[0];
      if (first) location = { mapId: first.mapId, x: first.x, y: first.y };
    } catch {
      // A conflicting hunk still locates its map by JSON Pointer below.
    }
    if (location) mapIndex = project.maps.findIndex((map) => map.id === location!.mapId);
    if (mapIndex < 0 || mapIndex >= project.maps.length) return;
    let next = editor();
    if (next.mapIndex !== mapIndex) next = selectMap(next, mapIndex);
    batch(() => {
      setEditor(next);
      if (location) {
        const previewMap = previewProposalHunks(project, proposal, [hunk.id]).maps
          .find((candidate) => candidate.mapId === location!.mapId);
        const width = Math.max(currentMap(next).width, previewMap?.width ?? 0);
        const height = Math.max(currentMap(next).height, previewMap?.height ?? 0);
        setCam({
          x: clampCam(location.x - Math.floor(viewCols() / 2), width, viewCols()),
          y: clampCam(location.y - Math.floor(viewRows() / 2), height, viewRows()),
        });
      } else {
        setCam(clampCameraTo(next, cam()));
      }
    });
  };

  const selectProposalAt = (index: number): void => {
    const proposal = pendingProposals()[index];
    if (!proposal) return;
    const firstPending = proposal.hunks.findIndex((hunk) => !hunk.decision);
    const hunkIndex = firstPending < 0 ? 0 : firstPending;
    setSelectedProposal(index);
    setAgentInputFocus(false);
    setSelectedProposalHunk(hunkIndex);
    setProposalScroll(Math.max(0, hunkIndex - 1));
    locateProposalHunk(proposal, hunkIndex);
  };

  /** Leave a hunk preview and return the camera to the live map's bounds.
   * Expanded proposals may temporarily pan beyond those bounds. */
  const clearProposalSelection = (state = editor()): void => {
    batch(() => {
      setSelectedProposal(null);
      setProposalScroll(0);
      setCam(clampCameraTo(state, cam()));
    });
  };

  /** A decision can remove an expansion preview without closing the detail
   * panel. Clamp against the live map plus only the clean hunks still shown. */
  const clampCameraToProposalBounds = (state: EditorState, proposal: EditProposal): void => {
    const project = exportProject(state);
    const assessment = assessProposal(project, proposal);
    const cleanIds = proposal.hunks.filter((hunk, index) =>
      !hunk.decision && assessment.hunks[index]?.state === "clean").map((hunk) => hunk.id);
    let proposed: ProposalPreview["maps"][number] | undefined;
    if (cleanIds.length > 0) {
      try {
        proposed = previewProposalHunks(project, proposal, cleanIds).maps
          .find((candidate) => candidate.mapId === currentMap(state).id);
      } catch {
        // A concurrent edit can invalidate the preview; live bounds are safe.
      }
    }
    const live = currentMap(state);
    setCam({
      x: clampCam(cam().x, Math.max(live.width, proposed?.width ?? 0), viewCols()),
      y: clampCam(cam().y, Math.max(live.height, proposed?.height ?? 0), viewRows()),
    });
  };

  const toggleProposalPanel = (): void => {
    finishActiveInput();
    if (shardedWorkspace()) {
      setProposalOpen(false);
      clearProposalSelection();
      setNotice({
        kind: "bad",
        text: "PROPOSALS ARE UNAVAILABLE FOR SHARDED PROJECTS; USE DIRECT EDITS OR OPEN AN INLINE PROJECT",
      });
      return;
    }
    if (proposalOpen()) {
      setProposalOpen(false);
      setAgentInputFocus(false);
      clearProposalSelection();
      return;
    }
    const stored = readProposalSession();
    if (stored) setProposals(stored.proposals);
    batch(() => {
      setInspectorOpen(false);
      setMapInspectorOpen(false);
      setPendingPick(null);
      setProposalOpen(true);
      setSelectedProposal(null);
      setProposalScroll(0);
      setAgentInputFocus(true);
      setNotice({ kind: "info", text: `${pendingProposals().length} PENDING PROPOSAL(S)` });
    });
  };

  const startLocalAgent = (): void => {
    const ready = agentReady();
    const request = agentInput().trim();
    if (shardedWorkspace()) {
      setNotice({ kind: "bad", text: "LOCAL AGENTS ARE UNAVAILABLE FOR SHARDED PROJECTS" });
      return;
    }
    if (!svc || !ready.available) {
      setNotice({ kind: "bad", text: ready.message.toUpperCase() });
      return;
    }
    if (agentRunning()) {
      setNotice({ kind: "bad", text: "A LOCAL AGENT REQUEST IS ALREADY RUNNING" });
      return;
    }
    if (!request) {
      setNotice({ kind: "bad", text: "DESCRIBE WHAT YOU WANT TO CHANGE" });
      return;
    }
    if (editor().dirty || pendingHostSave()) {
      setNotice({ kind: "bad", text: "SAVE OR RELOAD EDITS BEFORE ASKING THE AGENT" });
      return;
    }
    const current = map();
    const cell = selectedCell();
    const event = selectedEvent();
    agentRequestSequence++;
    const id = sha256Text(`${Date.now()}\n${agentRequestSequence}\n${request}\n${proposalSemanticHash(exportProject(editor()))}`);
    const start: LocalAgentStart = {
      t: "agent-start" as const,
      protocol: LOCAL_AGENT_PROTOCOL,
      id,
      request,
      projectHash: proposalSemanticHash(exportProject(editor())),
      context: {
        map: { id: current.id, name: current.name, width: current.width, height: current.height },
        selectedCell: cell?.mapId === current.id ? cell : null,
        selectedEvent: event ? {
          id: event.id,
          ...(event.name === undefined ? {} : { name: event.name }),
          x: event.x,
          y: event.y,
          w: event.w ?? 1,
          h: event.h ?? 1,
          page: editor().selectedPageIndex,
        } : null,
      },
    };
    batch(() => {
      setAgentInputFocus(false);
      setAgentState({
        t: "agent-state",
        protocol: LOCAL_AGENT_PROTOCOL,
        id,
        status: "starting",
        message: `Starting ${ready.adapter}…`,
      });
      setNotice({ kind: "info", text: `STARTING ${ready.adapter.toUpperCase()} FOR A PROPOSAL` });
    });
    svc.startAgent(start);
  };

  const cancelLocalAgent = (): void => {
    const state = agentState();
    if (!svc || !state || !agentRunning()) return;
    svc.cancelAgent({ t: "agent-cancel", protocol: LOCAL_AGENT_PROTOCOL, id: state.id });
    setAgentState({ ...state, status: "cancelling", message: "Cancelling local agent…" });
  };

  const activateProposal = (action: ProposalPanelAction): void => {
    if (action.kind === "focus-agent-input") {
      if (!agentRunning()) setAgentInputFocus(true);
      return;
    }
    if (action.kind === "run-agent") {
      startLocalAgent();
      return;
    }
    if (action.kind === "cancel-agent") {
      cancelLocalAgent();
      return;
    }
    const index = selectedProposal();
    if (action.kind === "back") {
      clearProposalSelection();
      return;
    }
    if (action.kind === "select-proposal") {
      selectProposalAt(action.index);
      return;
    }
    const proposal = index === null ? undefined : pendingProposals()[index];
    if (!proposal) return;
    if (action.kind === "select-hunk") {
      setSelectedProposalHunk(action.index);
      locateProposalHunk(proposal, action.index);
      return;
    }
    const project = exportProject(editor());
    const assessment = assessProposal(project, proposal);
    const selected = proposal.hunks[selectedProposalHunk()];
    if (action.kind === "reject") {
      if (!selected || selected.decision) return;
      const updated = decideProposalHunks(proposal, [selected.id], "rejected");
      const next = proposals().map((item) => item.id === updated.id ? updated : item);
      const persisted = persistProposalQueue(next, updated);
      if (proposalComplete(updated)) {
        clearProposalSelection();
      } else {
        clampCameraToProposalBounds(editor(), updated);
      }
      if (persisted) setNotice({ kind: "info", text: `REJECTED ${selected.id}${proposalComplete(updated) ? "; ARCHIVE QUEUED" : ""}` });
      return;
    }
    const chosen = action.kind === "accept-all"
      ? proposal.hunks.filter((hunk, hunkIndex) => !hunk.decision &&
          ["clean", "already-applied"].includes(assessment.hunks[hunkIndex]?.state ?? "conflict"))
      : selected && !selected.decision &&
          ["clean", "already-applied"].includes(assessment.hunks[selectedProposalHunk()]?.state ?? "conflict")
        ? [selected]
        : [];
    if (chosen.length === 0) {
      setNotice({ kind: "bad", text: "NO CLEAN HUNK TO ACCEPT; ASK THE AGENT TO REGENERATE CONFLICTS" });
      return;
    }
    if (hostSaveGuard() && !resolvePendingHostBaseline()) return;
    const reviewBaseline = doc();
    const observedHost = hostFile() ? readProposalHostState() : null;
    let nextHostGuard: HostSaveGuard | null = null;
    if (observedHost) {
      if (observedHost.projectHash !== proposalSemanticHash(reviewBaseline.project)) {
        nextHostGuard = { previousHash: observedHost.projectHash, expectedHash: null, baseline: null };
      } else {
        const hostClean: string[] = [];
        let predictable = true;
        for (const hunk of chosen) {
          const state = assessHunk(reviewBaseline.project, hunk).state;
          if (state === "clean") hostClean.push(hunk.id);
          else if (state !== "already-applied") predictable = false;
        }
        if (predictable) {
          const expectedProject = hostClean.length > 0
            ? applyProposalHunks(reviewBaseline.project, proposal, hostClean)
            : reviewBaseline.project;
          const expectedSource = serializeProjectPreservingSource(
            reviewBaseline.sourceText,
            reviewBaseline.project,
            expectedProject,
          );
          nextHostGuard = {
            previousHash: observedHost.projectHash,
            expectedHash: proposalSemanticHash(expectedProject),
            baseline: { ...reviewBaseline, project: expectedProject, sourceText: expectedSource },
          };
        } else {
          nextHostGuard = { previousHash: observedHost.projectHash, expectedHash: null, baseline: null };
        }
      }
    }
    const cleanIds = chosen.filter((hunk) =>
      assessment.hunks[proposal.hunks.indexOf(hunk)]?.state === "clean").map((hunk) => hunk.id);
    let committed = editor();
    let candidate = project;
    if (cleanIds.length > 0) {
      try {
        candidate = applyProposalHunks(project, proposal, cleanIds);
        committed = commitProjectReplacement(editor(), candidate);
        if (committed.error !== null && committed.error !== editor().error) throw new Error(committed.error.message);
      } catch (error) {
        setNotice({ kind: "bad", text: `ACCEPT REFUSED: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
    }
    const updated = decideProposalHunks(proposal, chosen.map((hunk) => hunk.id), "accepted");
    const next = proposals().map((item) => item.id === updated.id ? updated : item);
    setEditor(committed);
    // The desktop bridge applies accepted hunks to the latest host document.
    // Do not send a whole stale editor snapshot through the generic save
    // channel: that could overwrite an unrelated external edit made since
    // this document was opened.
    const persisted = persistProposalQueue(next, updated);
    if (persisted && nextHostGuard) setHostSaveGuard(nextHostGuard);
    if (proposalComplete(updated)) {
      clearProposalSelection(committed);
    } else {
      clampCameraToProposalBounds(committed, updated);
    }
    if (persisted) {
      if (cleanIds.length === 0) setNotice({ kind: "good", text: `RECORDED ${chosen.length} ALREADY-APPLIED HUNK(S)` });
      else setNotice({ kind: "good", text: `ACCEPTED ${chosen.length} HUNK(S); HOST APPLY QUEUED` });
    }
  };

  const startPlaytest = (): void => {
    if (shardedWorkspace()) {
      setNotice({ kind: "bad", text: "SAVE, THEN RELOAD THE GAME TO PLAYTEST A SHARDED PROJECT" });
      return;
    }
    if (inspectorFocus() || mapFocus()) {
      setNotice({ kind: "bad", text: "FINISH OR CANCEL THE ACTIVE FIELD BEFORE PLAY" });
      return;
    }
    finishActiveInput();
    setProposalOpen(false);
    clearProposalSelection();
    const e = editor();
    const cell = playtestStartCell(e, playStartCell());
    const candidate = buildPlaytestProject(e, cell);
    const errors = validateProject(candidate);
    if (errors.length > 0) {
      setNotice({
        kind: "bad",
        text: `PLAY REFUSED: ${errors.length} schema error(s), first: ${errors[0]!.path} ${errors[0]!.msg}`,
      });
      return;
    }
    const issues = diagnosePlaytestProject(candidate);
    batch(() => {
      setInspectorOpen(false);
      setMapInspectorOpen(false);
      setPlayState(null);
      setPlayDebug(false);
      setPlayTab("switch");
      setPlayPage(0);
      setPlayIssues(issues);
      setPlayAssets(createPlaytestAssets(candidate, PLAYTEST_BUNDLED_ART));
      setPlayProject(candidate);
    });
  };

  const stopPlaytest = (): void => {
    const ended = playPort?.state() ?? playState();
    if (ended) setLastPlayCarry(capturePlaytestCarry(ended));
    playPointerDown = false;
    playPort = null;
    batch(() => {
      setPlayProject(null);
      setPlayAssets(null);
      setPlayState(null);
      setPlayDebug(false);
      setPlayPage(0);
      setNotice({ kind: "good", text: "PLAYTEST STOPPED; EDITS AND UNDO HISTORY PRESERVED" });
    });
  };

  const toggleCarryMode = (): void => {
    setCarryPrevious((value) => !value);
    setNotice({
      kind: "info",
      text: carryPrevious() ? "PLAY STATE: LAST RUN SWITCHES / VARIABLES" : "PLAY STATE: FRESH",
    });
  };

  /** Apply one host document and acknowledge browser-correlated loads. The
   * desktop host omits request, so the extra reply is harmless there. */
  const loadHostDocument = (line: HostLine): void => {
    const text = line.text!;
    const loaded = documentErrors(text);
    const source = loaded.project as unknown as ProjectSource;
    if (loaded.errors.length === 0 && isProjectShell(source)) {
      loadHostShardedProject({ ...line, t: "project", shell: text });
      return;
    }
    if (loaded.errors.length === 0) {
      leaveShardedProject("an inline document was opened");
      // Name the slot after the bundled example the file came from (the
      // launcher points --file at an example document).
      const match = BUNDLED_PROJECTS.findIndex((b) => b.title === loaded.project.title);
      if (match >= 0) setDocIndex(match);
      setDoc({
        id: match >= 0 ? BUNDLED_PROJECTS[match]!.id : "file",
        project: loaded.project,
        sourceText: text,
      });
      setHostFile(true);
      setSavedText(text);
      setLoadNotice(`HOST FILE ${text.length} bytes`);
      resetForProject(loaded.project, { kind: "info", text: `LOADED ${text.length} bytes FROM HOST FILE` });
      svc?.loaded(line.request, true);
      return;
    }
    const error = `${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`;
    setNotice({ kind: "bad", text: `HOST FILE REJECTED: ${error}` });
    svc?.loaded(line.request, false, error);
  };

  const loadHostShardedProject = (line: HostLine): void => {
    const shellText = line.shell!;
    const loaded = loadProject(shellText);
    const source = loaded.project as unknown as ProjectSource;
    if (loaded.errors.length > 0 || !isProjectShell(source)) {
      const error = loaded.errors.length > 0
        ? `${loaded.errors[0]!.path} ${loaded.errors[0]!.msg}`
        : "$ expected a ProjectShell with mapIndex";
      setNotice({ kind: "bad", text: `PROJECT SHELL REJECTED: ${error}` });
      svc?.loaded(line.request, false, error);
      return;
    }
    try {
      leaveShardedProject("another sharded project was opened");
      const workspace = createShardedEditorWorkspace(source, requestMapShard, { maxLoadedMaps: 4 });
      setProposalOpen(false);
      setAgentInputFocus(false);
      clearProposalSelection();
      setShardedWorkspace(workspace);
      setHostFile(true);
      setSavedText(shellText);
      setLoadNotice(`SHARDED HOST PROJECT ${workspace.catalog.length} MAPS`);
      setMapListCursor(0);
      setMapListScroll(0);
      bumpWorkspace();
      svc?.loaded(line.request, true);
      const start = workspace.catalog.findIndex((meta) => meta.id === source.start.map);
      void activateShardedMap(start >= 0 ? start : 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice({ kind: "bad", text: `PROJECT SHELL REJECTED: ${message}` });
      svc?.loaded(line.request, false, message);
    }
  };

  const activatePlaytestHit = (hit: NonNullable<ReturnType<typeof hitTestPlaytest>>): void => {
    if (hit.kind === "stop") {
      stopPlaytest();
      return;
    }
    if (hit.kind === "debug") {
      setPlayDebug((open) => !open);
      return;
    }
    if (hit.kind === "tab") {
      setPlayTab(hit.tab);
      setPlayPage(0);
      return;
    }
    const project = playProject();
    const state = playPort?.state() ?? playState();
    if (!project || !state) return;
    const panel = playtestPanelRect(vp().w, vp().h, playIssues().length > 0);
    const perPage = playtestRowsPerPage(panel);
    const rows = playtestDebugRows(project, state, playTab());
    if (hit.kind === "page") {
      const pages = Math.max(1, Math.ceil(rows.length / perPage));
      setPlayPage((page) => Math.max(0, Math.min(pages - 1, page + hit.delta)));
      return;
    }
    const row = rows[playPage() * perPage + hit.row];
    if (!row) return;
    const edit = playtestRowEdit(row, hit.delta);
    if (edit) playPort?.edit(edit);
  };

  const handlePlaytestMouseLine = (line: HostLine): void => {
    if (line.t !== "mouse") return;
    if (line.x === undefined || line.y === undefined || !line.d) {
      playPointerDown = false;
      return;
    }
    if (playPointerDown) return;
    playPointerDown = true;
    const hit = hitTestPlaytest(
      line.x | 0,
      line.y | 0,
      vp().w,
      vp().h,
      playDebug(),
      playIssues().length > 0,
    );
    if (hit) activatePlaytestHit(hit);
  };

  const stepPlaytestButtons = (buttons: number): void => {
    const edge = buttons & ~prevButtons;
    if (edge & BTN.START) stopPlaytest();
    else if (edge & BTN.SELECT) setPlayDebug((open) => !open);
    prevButtons = buttons;
  };

  const toggleLayer = (): void => {
    finishActiveInput();
    setProposalOpen(false);
    clearProposalSelection();
    const e = editor();
    if (eventMode()) {
      setEventMode(false);
      const next = selectLayer(e, "ground");
      setEditor(next);
      setNotice({ kind: "info", text: "LAYER: GROUND" });
      return;
    }
    if (e.layer === "ground") {
      const next = selectLayer(e, "upper");
      setEditor(next);
      setNotice({ kind: "info", text: "LAYER: UPPER" });
      return;
    }
    if (e.layer === "upper") {
      const next = selectLayer(e, "passage");
      setEditor(next);
      setNotice({ kind: "info", text: "MODE: PASSAGE (PASS/BLOCK/EDGE TOOLS)" });
      return;
    }
    setEventMode(true);
    setCursor((cursor) => cursor.zone === "palette"
      ? { ...cursor, slot: Math.min(cursor.slot, EVENT_TOOL_IDS.length - 1) }
      : cursor);
    setNotice({ kind: "info", text: "MODE: EVENTS" });
  };

  const activateHeader = (index: number): void => {
    const id = HEADER_ORDER[index];
    if (id === undefined) return;
    if (id === "layer") toggleLayer();
    else if (id === "doc") switchDoc();
    else if (id === "mapprev") switchMap(-1);
    else if (id === "mapnext") switchMap(1);
    else if (id === "map") toggleMapInspector();
    else if (id === "proposals") toggleProposalPanel();
    else if (id === "play") startPlaytest();
    else if (id === "state") toggleCarryMode();
    else if (id === "undo") {
      setPendingPick(null);
      const e = editor();
      if (canUndo(e)) {
        const u = undo(e);
        batch(() => {
          setEditor(u);
          setCam(clampCameraTo(u, cam()));
          setDeleteRefs(null);
          setMapReferencePage(0);
        });
      }
    } else if (id === "redo") {
      setPendingPick(null);
      const e = editor();
      if (canRedo(e)) {
        const r = redo(e);
        batch(() => {
          setEditor(r);
          setCam(clampCameraTo(r, cam()));
          setDeleteRefs(null);
          setMapReferencePage(0);
        });
      }
    } else if (id === "save") performSave();
  };

  const secondaryHeader = (): boolean => compactHeader(vp().w) && headerMenuOpen();
  const visibleHeaderButtons = () => headerButtons(vp().w, secondaryHeader());
  const activateHeaderButton = (id: HeaderButtonId): void => {
    if (id === "more") {
      setHeaderMenuOpen((open) => !open);
      return;
    }
    setHeaderMenuOpen(false);
    activateHeader(HEADER_ORDER.indexOf(id));
  };

  const pickPalette = (slot: number): void => {
    const tile = palette()[slot] ?? null;
    setEditor(selectTile(editor(), tile));
    setNotice({ kind: "info", text: tile === null ? "ERASER SELECTED" : `TILE ${tile}` });
  };

  // --- event inspector ---------------------------------------------------
  const clearInspectorInput = (): void => {
    setInspectorFocus(null);
    setInputBuffer("");
  };

  const resetInspectorRows = (): void => {
    setInspectorSelection({ condition: null, command: null });
    clearInspectorInput();
    setInspectorScroll({ ...ZERO_INSPECTOR_SCROLL });
  };

  const openInspector = (): void => {
    if (!selectedEvent()) {
      setNotice({ kind: "bad", text: "SELECT AN EVENT BEFORE EDIT" });
      return;
    }
    resetInspectorRows();
    setProposalOpen(false);
    clearProposalSelection();
    setMapInspectorOpen(false);
    setInspectorOpen(true);
  };

  const closeInspector = (): void => {
    clearInspectorInput();
    setInspectorOpen(false);
  };

  const currentConditionField = (
    action: Extract<EventInspectorAction, { kind: "condition-field" }>,
  ): EditableField | null => {
    const page = activePage();
    const row = conditionRows()[action.row];
    if (!page?.condition || !row) return null;
    if (row.source.kind === "all") {
      const condition = page.condition.all?.[row.source.index];
      return condition ? conditionFields(condition, "", inspectorResources()).find((field) => field.key === action.field) ?? null : null;
    }
    if (row.source.key === "switch" && page.condition.switch !== undefined) {
      return conditionFields({ kind: "switch", id: page.condition.switch }, "", inspectorResources()).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "selfSwitch" && page.condition.selfSwitch !== undefined) {
      return conditionFields({ kind: "selfSwitch", key: page.condition.selfSwitch }, "", inspectorResources()).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "variable" && page.condition.variable !== undefined) {
      return conditionFields({ kind: "variable", ...page.condition.variable }, "", inspectorResources()).find((field) => field.key === action.field) ?? null;
    }
    if (row.source.key === "item" && page.condition.item !== undefined) {
      return conditionFields({ kind: "item", id: page.condition.item, count: 1 }, "", inspectorResources()).find((field) => field.key === action.field) ?? null;
    }
    return null;
  };

  const editableFieldFor = (action: EventInspectorAction): EditableField | null => {
    const event = selectedEvent();
    const page = activePage();
    if (!event || !page) return null;
    if (action.kind === "event-field") {
      const value = action.field === "name"
        ? event.name ?? event.id
        : action.field === "x"
          ? event.x
          : action.field === "y"
            ? event.y
            : action.field === "w"
              ? event.w ?? 1
              : event.h ?? 1;
      return {
        key: action.field,
        label: action.field.toUpperCase(),
        value,
        kind: action.field === "name" ? "text" : "integer",
      };
    }
    if (action.kind === "page-field") {
      return pageFieldDescriptors(page).find((field) => field.key === action.field) ?? null;
    }
    if (action.kind === "route-field") {
      return pageRouteFieldDescriptors(page).find((field) => field.key === action.field) ?? null;
    }
    if (action.kind === "condition-field") return currentConditionField(action);
    if (action.kind === "command-field") {
      return commandRows()[action.row]?.fields.find((field) => field.key === action.field) ?? null;
    }
    return null;
  };

  /** Install an edit-model result. False when the protocol refused the edit:
   *  the document is unchanged and the refusal is already on the status line,
   *  so the caller must not report success over it. */
  const applyEdit = (next: EditorState): boolean => {
    const refused = next.error !== null && next.error !== editor().error;
    setEditor(next);
    return !refused;
  };

  const finishFieldEdit = (message?: string): void => {
    clearInspectorInput();
    if (message) setNotice({ kind: "info", text: message });
  };

  const commitInspectorField = (action: EventInspectorAction, raw: string): boolean => {
    const event = selectedEvent();
    const page = activePage();
    if (!event || !page) return false;
    if (action.kind === "event-field") {
      if (action.field === "name") {
        if (!applyEdit(renameSelectedEvent(editor(), raw))) return false;
        finishFieldEdit("EVENT NAME UPDATED");
        return true;
      }
      const parsed = eventGeometryValue(raw, action.field);
      if (!parsed.ok) {
        setNotice({ kind: "bad", text: parsed.error.toUpperCase() });
        return false;
      }
      const next = action.field === "x" ? moveSelectedEvent(editor(), parsed.value, event.y)
        : action.field === "y" ? moveSelectedEvent(editor(), event.x, parsed.value)
          : action.field === "w" ? resizeSelectedEvent(editor(), parsed.value, event.h ?? 1)
            : resizeSelectedEvent(editor(), event.w ?? 1, parsed.value);
      if (!applyEdit(next)) return false;
      finishFieldEdit("EVENT GEOMETRY UPDATED");
      return true;
    }
    if (action.kind === "page-field" || action.kind === "route-field") {
      const edited = action.kind === "page-field"
        ? editPageField(page, action.field, raw)
        : editPageRouteField(page, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      if (!applyEdit(updateSelectedPage(editor(), () => edited.value))) return false;
      finishFieldEdit("PAGE UPDATED");
      return true;
    }
    if (action.kind === "condition-field") {
      if (action.readOnly) {
        setNotice({ kind: "bad", text: "EXTENSION CONDITION IS READ ONLY" });
        return false;
      }
      const row = conditionRows()[action.row];
      if (!row) return false;
      const edited = editPageConditionField(page, row.source, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      if (!applyEdit(updateSelectedPage(editor(), () => edited.value))) return false;
      finishFieldEdit("CONDITION UPDATED");
      return true;
    }
    if (action.kind === "command-field") {
      if (action.readOnly) {
        setNotice({ kind: "bad", text: "COMMAND PAYLOAD IS READ ONLY" });
        return false;
      }
      const row = commandRows()[action.row];
      if (!row) return false;
      const edited = editCommandField(row.command, action.field, raw);
      if (!edited.ok) {
        setNotice({ kind: "bad", text: edited.error.toUpperCase() });
        return false;
      }
      const commands = updateCommand(page.commands, row.address, edited.value);
      if (!applyEdit(updateSelectedPage(editor(), (current) => ({ ...current, commands })))) return false;
      finishFieldEdit("COMMAND UPDATED");
      return true;
    }
    return false;
  };

  const beginInspectorField = (action: EventInspectorAction): void => {
    if ((action.kind === "condition-field" || action.kind === "command-field") && action.readOnly) {
      setNotice({ kind: "bad", text: "THIS FIELD IS DISPLAY ONLY" });
      return;
    }
    const field = editableFieldFor(action);
    if (!field || field.readOnly) {
      setNotice({ kind: "bad", text: "THIS FIELD IS DISPLAY ONLY" });
      return;
    }
    if (field.kind === "enum" || field.kind === "boolean") {
      commitInspectorField(action, nextFieldValue(field));
      return;
    }
    setInspectorFocus(action);
    setInputBuffer(String(field.value ?? ""));
    if (field.hint) setNotice({ kind: "info", text: field.hint.toUpperCase() });
  };

  const selectCommandKey = (commands: Page["commands"], key: string | null): void => {
    const rows = commandInspectorRows(commands, inspectorResources());
    const command = key === null ? null : rows.findIndex((row) => row.key === key);
    setInspectorSelection((selection) => ({
      ...selection,
      command: command !== null && command >= 0 ? command : null,
    }));
  };

  const replaceCommands = (commands: Page["commands"], selectKey: string | null): void => {
    setEditor(updateSelectedPage(editor(), (page) => ({ ...page, commands })));
    selectCommandKey(commands, selectKey);
    clearInspectorInput();
  };

  const commitAddPrompt = (): boolean => {
    const focus = inspectorFocus();
    const page = activePage();
    if (!focus || !page) return false;
    const raw = inputBuffer().trim();
    if (focus.kind === "condition-action" && focus.action === "add") {
      if (!CONDITION_KINDS.includes(raw as ConditionKind)) {
        setNotice({ kind: "bad", text: `CONDITION MUST BE: ${CONDITION_KINDS.join(", ")}` });
        return false;
      }
      const next = addPageCondition(page, raw as ConditionKind);
      setEditor(updateSelectedPage(editor(), () => next));
      setInspectorSelection((selection) => ({
        ...selection,
        condition: flattenInspectorConditions(next).length - 1,
      }));
      finishFieldEdit(`ADDED ${raw.toUpperCase()} CONDITION`);
      return true;
    }
    if (focus.kind === "command-action" && focus.action === "add") {
      const [opText = "", branchText, ...extra] = raw.split("@");
      if (extra.length > 0 || !EDITABLE_COMMAND_OPS.includes(opText as EditableCommandOp)) {
        setNotice({ kind: "bad", text: `UNKNOWN EDITABLE COMMAND: ${opText || "(EMPTY)"}` });
        return false;
      }
      const selected = inspectorSelection().command;
      const selectedRow = selected === null ? null : commandRows()[selected] ?? null;
      const root = getCommandList(page.commands, []);
      let address: CommandAddress = selectedRow
        ? { path: selectedRow.address.path, index: selectedRow.address.index + 1 }
        : { path: [], index: root?.length ?? 0 };
      if (branchText !== undefined) {
        if (!selectedRow) {
          setNotice({ kind: "bad", text: "SELECT THE PARENT COMMAND FOR @BRANCH" });
          return false;
        }
        let path = null as ReturnType<typeof ifBranchPath> | null;
        if (selectedRow.command.op === "if" && (branchText === "then" || branchText === "else")) {
          path = ifBranchPath(selectedRow.address, branchText);
        } else if (selectedRow.command.op === "choices") {
          if (branchText === "cancel") path = choiceBranchPath(selectedRow.address, "cancel");
          else {
            const match = /^option([1-9][0-9]*)$/.exec(branchText);
            const option = match ? Number(match[1]) - 1 : -1;
            if (option >= 0 && option < selectedRow.command.options.length) {
              path = choiceBranchPath(selectedRow.address, option);
            }
          }
        } else if (selectedRow.command.op === "battle"
          && (branchText === "win" || branchText === "lose" || branchText === "escape")) {
          path = battleBranchPath(selectedRow.address, branchText);
        } else if (selectedRow.command.op === "scene"
          && (branchText === "done" || branchText === "cancel")) {
          path = sceneBranchPath(selectedRow.address, branchText);
        } else if (selectedRow.command.op === "loop" && branchText === "body") {
          path = loopBodyPath(selectedRow.address);
        }
        const list = path ? getCommandList(page.commands, path) : null;
        if (!path || !list) {
          setNotice({ kind: "bad", text: `INVALID @BRANCH ${branchText.toUpperCase()}` });
          return false;
        }
        address = { path, index: list.length };
      }
      const commands = insertCommand(page.commands, address, defaultCommand(opText as EditableCommandOp));
      replaceCommands(commands, commandAddressKey(address));
      setNotice({ kind: "info", text: `ADDED ${opText.toUpperCase()} COMMAND${branchText ? ` @${branchText.toUpperCase()}` : ""}` });
      return true;
    }
    return false;
  };

  const activateInspector = (action: EventInspectorAction): void => {
    const page = activePage();
    if (!page) return;
    if (action.kind === "close") {
      closeInspector();
      return;
    }
    if (action.kind === "event-field" || action.kind === "page-field" || action.kind === "route-field"
      || action.kind === "condition-field" || action.kind === "command-field") {
      beginInspectorField(action);
      return;
    }
    if (action.kind === "page-select") {
      setEditor(selectPage(editor(), action.page));
      resetInspectorRows();
      return;
    }
    if (action.kind === "page-action") {
      const index = editor().selectedPageIndex;
      const next = action.action === "add"
        ? addPage(editor())
        : action.action === "delete"
          ? deletePage(editor())
          : action.action === "up"
            ? movePage(editor(), index - 1)
            : action.action === "down"
              ? movePage(editor(), index + 1)
              : copyPage(editor());
      setEditor(next);
      resetInspectorRows();
      return;
    }
    if (action.kind === "condition-select") {
      setInspectorSelection((selection) => ({ ...selection, condition: action.row }));
      clearInspectorInput();
      return;
    }
    if (action.kind === "condition-action") {
      if (action.action === "add") {
        setInspectorFocus(action);
        setInputBuffer("");
      } else {
        const selected = inspectorSelection().condition;
        const row = selected === null ? null : conditionRows()[selected];
        if (!row) {
          setNotice({ kind: "bad", text: "SELECT A CONDITION FIRST" });
          return;
        }
        setEditor(updateSelectedPage(editor(), (current) => deletePageCondition(current, row.source)));
        setInspectorSelection((selection) => ({ ...selection, condition: null }));
        clearInspectorInput();
      }
      return;
    }
    if (action.kind === "command-select") {
      setInspectorSelection((selection) => ({ ...selection, command: action.row }));
      clearInspectorInput();
      return;
    }
    if (action.kind === "command-pick") {
      beginPick(action.row);
      return;
    }
    if (action.kind === "command-action") {
      if (action.action === "add") {
        setInspectorFocus(action);
        setInputBuffer("");
        return;
      }
      const selected = inspectorSelection().command;
      const row = selected === null ? null : commandRows()[selected];
      if (!row) {
        setNotice({ kind: "bad", text: "SELECT A COMMAND FIRST" });
        return;
      }
      if (action.action === "delete") {
        replaceCommands(deleteCommand(page.commands, row.address), null);
      } else if (action.action === "copy") {
        const destination = { path: row.address.path, index: row.address.index + 1 };
        replaceCommands(copyCommand(page.commands, row.address, destination), commandAddressKey(destination));
      } else {
        const list = getCommandList(page.commands, row.address.path);
        const target = row.address.index + (action.action === "up" ? -1 : 1);
        if (list && target >= 0 && target < list.length) {
          const destination = { path: row.address.path, index: target };
          replaceCommands(moveCommand(page.commands, row.address, target), commandAddressKey(destination));
        }
      }
    }
  };

  const activateEventTool = (tool: (typeof EVENT_TOOL_IDS)[number]): void => {
    if (tool === "new") {
      const at = eventPlacement();
      if (!applyEdit(createEventAt(editor(), at.x, at.y))) return;
      setNotice({ kind: "info", text: `NEW EVENT AT ${at.x},${at.y}` });
      // The newly created event is selected synchronously by the model.
      setInspectorSelection({ condition: null, command: null });
      setInspectorOpen(true);
      return;
    }
    if (!selectedEvent()) {
      setNotice({ kind: "bad", text: "SELECT AN EVENT FIRST" });
      return;
    }
    if (tool === "edit") openInspector();
    else if (tool === "copy") {
      if (applyEdit(duplicateSelectedEvent(editor()))) setNotice({ kind: "info", text: "EVENT COPIED" });
    } else if (applyEdit(deleteSelectedEvent(editor()))) {
      setNotice({ kind: "info", text: "EVENT DELETED" });
    }
  };

  // --- map inspector -------------------------------------------------------
  const closeMapInspector = (): void => {
    setMapFocus(null);
    setMapInput("");
    setDeleteRefs(null);
    setMapReferencePage(0);
    setMapInspectorOpen(false);
  };

  const closeMapList = (): void => {
    setMapListOpen(false);
  };

  const moveMapListCursor = (delta: number): void => {
    const entries = catalog();
    if (entries.length === 0) return;
    const next = Math.max(0, Math.min(entries.length - 1, mapListCursor() + delta));
    setMapListCursor(next);
    setMapListScroll(revealMapListRow(next, entries.length, mapListPanelHeight(), mapListScroll()));
  };

  const openMapListSelection = (): void => {
    if (loadingMapIndex() !== null) return;
    void activateShardedMap(mapListCursor());
  };

  const toggleMapInspector = (): void => {
    if (shardedWorkspace()) {
      if (mapListOpen()) {
        closeMapList();
      } else {
        setInspectorOpen(false);
        setMapInspectorOpen(false);
        setMapListCursor(catalogIndex());
        setMapListScroll(revealMapListRow(
          catalogIndex(),
          catalog().length,
          mapListPanelHeight(),
          mapListScroll(),
        ));
        setMapListOpen(true);
      }
      return;
    }
    if (mapInspectorOpen()) {
      closeMapInspector();
      return;
    }
    if (pendingPick()) return; // picking owns the canvas
    // the two inspectors are mutually exclusive (they share the canvas area)
    setInspectorOpen(false);
    setProposalOpen(false);
    clearProposalSelection();
    setDeleteRefs(null);
    setMapReferencePage(0);
    setMapInspectorOpen(true);
  };

  const mapFieldValue = (field: MapField): string => {
    const m = currentMap(editor());
    if (field === "id") return m.id;
    if (field === "name") return m.name;
    if (field === "width") return String(m.width);
    if (field === "height") return String(m.height);
    return (m.sheets ?? []).join(",");
  };

  const commitMapField = (field: MapField, raw: string): boolean => {
    const e = editor();
    if (field === "id") {
      if (shardedWorkspace()) {
        setNotice({ kind: "bad", text: "MAP IDS ARE STABLE IN A SHARDED EDITOR SESSION; USE rpgkit-edit TO RENAME" });
        return false;
      }
      const r = renameMap(e, raw);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setNotice({ kind: "info", text: `MAP ID: ${raw.trim()}` });
      return true;
    }
    if (field === "name") {
      const r = setMapName(e, raw);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setNotice({ kind: "info", text: "MAP NAME UPDATED" });
      return true;
    }
    if (field === "width" || field === "height") {
      if (!/^-?\d+$/.test(raw.trim())) {
        setNotice({ kind: "bad", text: "SIZE MUST BE AN INTEGER" });
        return false;
      }
      const m = currentMap(e);
      const r = resizeMap(e, field === "width" ? Number(raw) : m.width, field === "height" ? Number(raw) : m.height);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return false;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice(r.croppedEvents.length > 0
        ? { kind: "bad", text: `RESIZED; CROPPED ${r.croppedEvents.length} EVENT(S): ${r.croppedEvents.join(", ")} — UNDO RESTORES` }
        : { kind: "info", text: "MAP RESIZED" });
      return true;
    }
    // sheets
    const sheets = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const r = setMapSheets(e, sheets);
    if (!r.ok) {
      setNotice({ kind: "bad", text: r.error.toUpperCase() });
      return false;
    }
    setEditor(r.state);
    setDeleteRefs(null);
    setMapReferencePage(0);
    setNotice({ kind: "info", text: "MAP SHEETS UPDATED" });
    return true;
  };

  const activateMapInspector = (action: MapInspectorAction): void => {
    if (action.kind === "close") {
      closeMapInspector();
      return;
    }
    if (action.kind === "field") {
      setMapFocus(action);
      setMapInput(mapFieldValue(action.field));
      return;
    }
    if (action.kind === "reference-page") {
      const layout = mapInspectorLayout();
      if (!layout) return;
      setMapReferencePage(Math.max(
        0,
        Math.min(layout.referencePageCount - 1, layout.referencePage + action.delta),
      ));
      return;
    }
    const e = editor();
    if (shardedWorkspace() && action.kind === "action") {
      setNotice({ kind: "bad", text: "ADD, DUPLICATE, AND DELETE MAP USE rpgkit-edit FOR SHARDED PROJECTS" });
      return;
    }
    if (action.action === "new") {
      // A new map inherits the current map's sheets and fills with the first
      // sheet's cell 0 (a walkable default) rather than blocking void.
      const sheets = currentMap(e).sheets ?? e.project.sheets.slice(0, 1).map((s) => s.id);
      const fill = sheets.length > 0 ? `${sheets[0]}.0` : null;
      const r = newMap(e, { sheets, fill });
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice({ kind: "info", text: `NEW MAP: ${currentMap(r.state).id}` });
      return;
    }
    if (action.action === "dup") {
      const r = duplicateMap(e);
      if (!r.ok) {
        setNotice({ kind: "bad", text: r.error.toUpperCase() });
        return;
      }
      setEditor(r.state);
      setDeleteRefs(null);
      setMapReferencePage(0);
      setCam(clampCameraTo(r.state, cam()));
      setNotice({ kind: "info", text: `DUPLICATED MAP: ${currentMap(r.state).id}` });
      return;
    }
    // del: a first click lists the transfers that target this map; a second
    // click (with the same map still active) confirms the delete.
    const mapId = currentMap(e).id;
    if (deleteRefs()?.mapId !== mapId) {
      const refs = mapReferences(e.project, mapId);
      if (refs.length > 0) {
        setDeleteRefs({ mapId, references: refs });
        setMapReferencePage(0);
        setNotice({ kind: "bad", text: `${refs.length} TRANSFER(S) TARGET THIS MAP — DEL AGAIN TO CONFIRM` });
        return;
      }
    }
    const r = deleteMap(e, true);
    if (!r.ok) {
      setNotice({ kind: "bad", text: r.error.toUpperCase() });
      return;
    }
    setEditor(r.state);
    setDeleteRefs(null);
    setMapReferencePage(0);
    setCam(clampCameraTo(r.state, cam()));
    setNotice({ kind: "info", text: "MAP DELETED" });
  };

  // --- passage tools --------------------------------------------------------
  const selectPassTool = (tool: PassTool): void => {
    if (shardedWorkspace() && (tool === "clr-edge" || tool.startsWith("in-") || tool.startsWith("out-"))) {
      setNotice({ kind: "bad", text: "SHEET EDGE EDITS ARE GLOBAL; USE rpgkit-edit FOR A SHARDED PROJECT" });
      return;
    }
    setPassTool(tool);
    setNotice({ kind: "info", text: `PASS TOOL: ${PASS_TOOL_LABELS[tool]}` });
  };

  /** The edge brush for the current pass tool, or null for cell brushes. */
  const edgeBrushFor = (tool: PassTool): EdgeBrush | null => {
    if (tool === "clr-edge") return { kind: "clear" };
    if (tool === "in-down" || tool === "out-down") return { kind: tool === "in-down" ? "enter" : "exit", dir: "down" };
    if (tool === "in-left" || tool === "out-left") return { kind: tool === "in-left" ? "enter" : "exit", dir: "left" };
    if (tool === "in-right" || tool === "out-right") return { kind: tool === "in-right" ? "enter" : "exit", dir: "right" };
    if (tool === "in-up" || tool === "out-up") return { kind: tool === "in-up" ? "enter" : "exit", dir: "up" };
    return null;
  };

  // --- transfer target picking ----------------------------------------------
  const beginPick = (row: number): void => {
    const e = editor();
    const event = selectedEvent();
    const cmdRow = commandRows()[row];
    if (!event || !cmdRow) return;
    setPendingPick({
      mapIndex: e.mapIndex,
      eventId: event.id,
      pageIndex: e.selectedPageIndex,
      address: cmdRow.address,
      command: cmdRow.command,
    });
    setInspectorOpen(false);
    setMapInspectorOpen(false);
    clearInspectorInput();
    setMapFocus(null);
    setMapInput("");
    setNotice({ kind: "info", text: "PICK TRANSFER TARGET: CLICK A CELL (L/R SWITCH MAPS, ESC CANCELS)" });
  };

  const applyPick = (tx: number, ty: number): void => {
    const pick = pendingPick();
    if (!pick) return;
    const targetMapId = currentMap(editor()).id;
    let e = selectMap(editor(), pick.mapIndex);
    e = selectEvent(e, pick.eventId, pick.pageIndex);
    const page = e.project.maps[pick.mapIndex]?.events?.find((ev) => ev.id === pick.eventId)?.pages[pick.pageIndex];
    const list = page ? getCommandList(page.commands, pick.address.path) : null;
    const command = list?.[pick.address.index];
    if (!page || !command || command !== pick.command || command.op !== "transfer") {
      setPendingPick(null);
      setNotice({ kind: "bad", text: "PICK CANCELLED: COMMAND CHANGED" });
      return;
    }
    const keepDir = typeof command.dir === "string" ? command.dir : "down";
    let edited = editCommandField(command, "map", targetMapId);
    if (!edited.ok) {
      setPendingPick(null);
      setNotice({ kind: "bad", text: edited.error.toUpperCase() });
      return;
    }
    edited = editCommandField(edited.value, "x", String(tx));
    if (edited.ok) edited = editCommandField(edited.value, "y", String(ty));
    if (edited.ok) edited = editCommandField(edited.value, "dir", keepDir);
    if (!edited.ok) {
      setPendingPick(null);
      setNotice({ kind: "bad", text: edited.error.toUpperCase() });
      return;
    }
    const commands = updateCommand(page.commands, pick.address, edited.value);
    const next = updateSelectedPage(e, (current) => ({ ...current, commands }));
    if (!applyEdit(next)) {
      setPendingPick(null);
      return;
    }
    // The pick may have switched maps; clamp the camera back to the event's map.
    setCam(clampCameraTo(next, cam()));
    setPendingPick(null);
    setInspectorOpen(true);
    setInspectorSelection({ condition: null, command: null });
    setNotice({ kind: "info", text: `TARGET SET: ${targetMapId} ${tx},${ty} ${keepDir}` });
  };

  // --- pointer interaction ------------------------------------------------
  // false      no button held
  // "paint"    primary held (left)
  // "erase"    secondary/shift held
  // "pass"     passage override stroke (PASS mode cell brush)
  // "edge"     sheet dirEdges stroke (PASS mode edge brush)
  const cellPaint = (tx: number, ty: number): void => {
    const e = editor();
    const m = currentMap(e);
    if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height) return;
    setEditor(paintCell(e, ty * m.width + tx));
  };

  const hitAt = (x: number, y: number) => {
    const m = map();
    return hitTest(x, y, vp().w, vp().h, fit().frame, cam().x, cam().y, palette().length, palScroll(), {
      w: m.width,
      h: m.height,
    }, secondaryHeader());
  };

  const handleMouseLine = (m: HostLine): void => {
    if (m.t !== "mouse") return;
    if (playProject()) {
      handlePlaytestMouseLine(m);
      return;
    }
    // A bare release (host Reset on focus loss) ends the stroke anywhere.
    if (m.x === undefined || m.y === undefined) {
      if (pointerDown === "paint" || pointerDown === "erase" || pointerDown === "pass") {
        setEditor(strokeEnd(editor()));
      } else if (pointerDown === "edge") {
        setEditor(edgeStrokeEnd(editor()));
      }
      eventDrag = null;
      setDragPreview(null);
      pointerDown = false;
      return;
    }
    const x = m.x | 0;
    const y = m.y | 0;
    pointerX = x;

    if (mapListOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeaderButton(hit.id);
        } else {
          const index = hitMapListRow(
            y - HEADER_H,
            catalog().length,
            mapListPanelHeight(),
            mapListScroll(),
          );
          if (index !== null) {
            setMapListCursor(index);
            openMapListSelection();
          }
        }
      } else if (!m.d) {
        pointerDown = false;
      }
      return;
    }

    if (mapInspectorOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeaderButton(hit.id);
        } else {
          const layout = mapInspectorLayout();
          if (layout) {
            const action = hitTestMapInspector(layout, x, y - HEADER_H);
            if (action) activateMapInspector(action);
          }
        }
      } else if (!m.d) {
        pointerDown = false;
      }
      return;
    }

    if (inspectorOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeaderButton(hit.id);
        } else {
          const layout = inspectorLayout();
          if (layout) {
            const action = hitTestEventInspector(layout, x, y - HEADER_H);
            if (action) activateInspector(action);
          }
        }
      } else if (!m.d) {
        pointerDown = false;
      }
      return;
    }

    if (proposalOpen()) {
      if (m.d && !pointerDown) {
        pointerDown = "event";
        if (y < HEADER_H) {
          const hit = hitAt(x, y);
          if (hit?.kind === "button") activateHeaderButton(hit.id);
        } else if (x < PAL_W && y < vp().h - STATUS_H) {
          const proposal = selectedProposal() === null ? undefined : pendingProposals()[selectedProposal()!];
          const action = hitProposalPanel(
            x,
            y - HEADER_H,
            proposalPanelHeight(),
            pendingProposals().length,
            proposal?.hunks.length ?? 0,
            proposal !== undefined,
            proposalScroll(),
            proposal === undefined,
            agentRunning(),
          );
          if (action) activateProposal(action);
        }
      } else if (!m.d) {
        pointerDown = false;
        const hit = hitAt(x, y);
        setHover(hit?.kind === "cell" ? { x: hit.tx, y: hit.ty } : null);
      }
      return;
    }

    if (m.d) {
      const erase = m.b === 2 || m.sh === true;
      const kind: "paint" | "erase" = erase ? "erase" : "paint";
      if (!pointerDown) {
        // Press edge: buttons and palette slots activate only here, so a
        // drag that starts on the header does not repaint the map.
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") setSelectedCell({ mapId: map().id, x: hit.tx, y: hit.ty });
        if (hit?.kind === "cell") setPlayStartCell({ mapId: map().id, x: hit.tx, y: hit.ty });
        if (hit?.kind === "button") {
          pointerDown = kind;
          activateHeaderButton(hit.id);
          return;
        }
        // Transfer-target picking owns canvas cells in every mode.
        if (pendingPick() && hit?.kind === "cell") {
          applyPick(hit.tx, hit.ty);
          return;
        }
        if (passMode() && x < PAL_W && y >= HEADER_H && y < vp().h - STATUS_H) {
          const tool = hitPassTool(x, y - HEADER_H);
          if (tool) selectPassTool(tool);
          return;
        }
        if (passMode() && hit?.kind === "cell") {
          const tool = passTool();
          const edgeBrush = edgeBrushFor(tool);
          setHover({ x: hit.tx, y: hit.ty });
          if (edgeBrush) {
            setEditor(edgeStrokeStart(editor(), edgeBrush));
            setEditor(edgePaintCell(editor(), hit.ty * map().width + hit.tx));
            pointerDown = "edge";
          } else {
            let e = selectPassageBrush(editor(), tool === "block" ? "block" : "pass");
            e = strokeStart(e, tool === "clear");
            setEditor(e);
            cellPaint(hit.tx, hit.ty);
            pointerDown = "pass";
          }
          return;
        }
        pointerDown = kind;
        if (eventMode() && x < PAL_W && y >= HEADER_H && y < vp().h - STATUS_H) {
          const tool = hitEventTool(x, y - HEADER_H);
          if (tool) activateEventTool(tool);
          return;
        }
        if (eventMode() && hit?.kind === "cell") {
          const event = topmostEventAt(markers(), hit.tx, hit.ty);
          setHover({ x: hit.tx, y: hit.ty });
          setEventPlacement({ x: hit.tx, y: hit.ty });
          setEditor(selectEvent(editor(), event?.id ?? null));
          pointerDown = "event";
          const authored = event ? (map().events ?? []).find((candidate) => candidate.id === event.id) : null;
          if (authored && !erase) eventDrag = { event: authored, start: { x: hit.tx, y: hit.ty } };
          return;
        }
        if (hit?.kind === "palette") {
          pickPalette(hit.slot);
          return;
        }
        if (hit?.kind === "cell") {
          setEditor(strokeStart(editor(), erase));
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      } else if (pointerDown === "event" && eventDrag) {
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          const destination = eventDragDestination(eventDrag.event, eventDrag.start, {
            x: hit.tx,
            y: hit.ty,
          }, { width: map().width, height: map().height });
          setHover({ x: hit.tx, y: hit.ty });
          setDragPreview({ id: eventDrag.event.id, ...destination });
        }
      } else if (pointerDown === "edge") {
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          setHover({ x: hit.tx, y: hit.ty });
          setEditor(edgePaintCell(editor(), hit.ty * map().width + hit.tx));
        }
      } else {
        // Held move: only canvas cells extend the stroke.
        const hit = hitAt(x, y);
        if (hit?.kind === "cell") {
          setHover({ x: hit.tx, y: hit.ty });
          cellPaint(hit.tx, hit.ty);
        }
      }
    } else if (pointerDown) {
      if (pointerDown === "event") {
        const preview = dragPreview();
        if (preview && eventDrag?.event.id === preview.id) {
          setEditor(moveSelectedEvent(editor(), preview.x, preview.y));
          setEventPlacement({ x: preview.x, y: preview.y });
        }
        eventDrag = null;
        setDragPreview(null);
      } else if (pointerDown === "edge") {
        setEditor(edgeStrokeEnd(editor()));
      } else {
        setEditor(strokeEnd(editor()));
      }
      pointerDown = false;
    }
    if (!m.d) {
      const hit = hitAt(x, y);
      if (hit?.kind === "cell") {
        setHover({ x: hit.tx, y: hit.ty });
        if (eventMode()) setEventPlacement({ x: hit.tx, y: hit.ty });
      } else {
        setHover(null);
      }
    }
  };

  // --- buttons interaction (always live; the gamepad mode without svc) ---
  const stepButtons = (buttons: number): void => {
    if (playProject()) {
      stepPlaytestButtons(buttons);
      return;
    }
    const edge = buttons & ~prevButtons;
    const released = prevButtons & ~buttons;
    // With a pointer companion the host ALSO mirrors keys as buttons
    // (vendor/pocketjs/hosts/desktop/src/buttons.rs: z/x/a/s map to
    // CROSS/CIRCLE/SQUARE/TRIANGLE), so a cmd+z chord would undo AND erase
    // and a plain "z" would erase the cell under the cursor.
    // Pointer mode therefore lets buttons move the cursor only; activation
    // comes from the mouse and cmd-key chords. The gamepad fallback (no
    // companion) keeps the full button vocabulary.
    const pointerMode = svc !== null;
    if (mapListOpen()) {
      if (!pointerMode) {
        if (edge & BTN.UP) moveMapListCursor(-1);
        if (edge & BTN.DOWN) moveMapListCursor(1);
        if (edge & BTN.CIRCLE) openMapListSelection();
        if (edge & BTN.CROSS) closeMapList();
        if (edge & BTN.START) performSave();
      }
      prevButtons = buttons;
      return;
    }
    if (proposalOpen()) {
      if (!pointerMode) {
        const selectedIndex = selectedProposal();
        if (selectedIndex === null) {
          if (edge & BTN.UP) setProposalScroll((value) => Math.max(0, value - 1));
          if (edge & BTN.DOWN) setProposalScroll((value) => Math.min(Math.max(0, pendingProposals().length - 1), value + 1));
          if (edge & BTN.CIRCLE) selectProposalAt(proposalScroll());
          if (edge & BTN.CROSS) toggleProposalPanel();
        } else {
          const proposal = pendingProposals()[selectedIndex];
          if (proposal) {
            let hunk = selectedProposalHunk();
            if (edge & BTN.UP) hunk = Math.max(0, hunk - 1);
            if (edge & BTN.DOWN) hunk = Math.min(proposal.hunks.length - 1, hunk + 1);
            if (hunk !== selectedProposalHunk()) {
              setSelectedProposalHunk(hunk);
              const visible = proposalVisibleRows(proposalPanelHeight(), true);
              if (hunk < proposalScroll()) setProposalScroll(hunk);
              else if (hunk >= proposalScroll() + visible) setProposalScroll(hunk - visible + 1);
              locateProposalHunk(proposal, hunk);
            }
            if (edge & BTN.CIRCLE) activateProposal({ kind: "accept" });
            if (edge & BTN.CROSS) activateProposal({ kind: "reject" });
            if (edge & BTN.START) activateProposal({ kind: "accept-all" });
            if (edge & BTN.SELECT) activateProposal({ kind: "back" });
          }
        }
        if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
        if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
      }
      prevButtons = buttons;
      return;
    }
    if (inspectorOpen() || mapInspectorOpen()) {
      if (!pointerMode) {
        if (edge & BTN.CROSS) {
          if (inspectorOpen()) closeInspector();
          else closeMapInspector();
        }
        if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
        if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
        if (edge & BTN.START) performSave();
      }
      prevButtons = buttons;
      return;
    }
    let cur = cursor();
    let c = cam();
    const moveWorld = (dir: 0 | 1 | 2 | 3) => {
      const r = stepCursor(cur, dir, {
        mapW: map().width,
        mapH: map().height,
        viewCols: viewCols(),
        viewRows: viewRows(),
        camX: c.x,
        camY: c.y,
        paletteSize: eventMode()
          ? EVENT_TOOL_IDS.length
          : passMode()
            ? PASS_TOOL_IDS.length
            : palette().length,
        paletteCols: eventMode()
          ? EVENT_TOOL_COLS
          : passMode()
            ? PASS_TOOL_COLS
            : undefined,
        headerSize: visibleHeaderButtons().length,
      });
      cur = r.cursor;
      c = { x: r.camX, y: r.camY };
    };
    if (edge & BTN.UP) moveWorld(2);
    if (edge & BTN.DOWN) moveWorld(0);
    if (edge & BTN.LEFT) moveWorld(1);
    if (edge & BTN.RIGHT) moveWorld(3);
    if (!pointerMode) {
      if (edge & BTN.SELECT) toggleLayer();
      if (edge & BTN.LTRIGGER) switchMap(-1);
      if (edge & BTN.RTRIGGER) switchMap(1);
      if (edge & BTN.SQUARE) activateHeader(HEADER_ORDER.indexOf("undo"));
      if (edge & BTN.TRIANGLE) activateHeader(HEADER_ORDER.indexOf("redo"));
      if (edge & BTN.START) performSave();
    }
    if (!pointerMode && cur.zone === "canvas" && (edge & (BTN.CIRCLE | BTN.CROSS))) {
      setSelectedCell({ mapId: map().id, x: cur.tx, y: cur.ty });
      setPlayStartCell({ mapId: map().id, x: cur.tx, y: cur.ty });
    }

    // Transfer-target picking owns the canvas in every mode.
    if (!pointerMode && pendingPick() && cur.zone === "canvas" && (edge & BTN.CIRCLE)) {
      applyPick(cur.tx, cur.ty);
    } else if (!pointerMode && pendingPick() && (edge & BTN.CROSS)) {
      // CROSS cancels a pending pick instead of deleting an event.
      setPendingPick(null);
      setNotice({ kind: "info", text: "PICK CANCELLED" });
    } else if (!pointerMode && eventMode() && edge & (BTN.CIRCLE | BTN.CROSS)) {
      const remove = (edge & BTN.CROSS) !== 0;
      if (cur.zone === "palette") {
        if (!remove) activateEventTool(EVENT_TOOL_IDS[cur.slot] ?? "new");
      } else if (cur.zone === "header") {
        if (!remove) {
          const id = visibleHeaderButtons()[cur.button]?.id;
          if (id) activateHeaderButton(id);
        }
      } else {
        setEventPlacement({ x: cur.tx, y: cur.ty });
        const event = topmostEventAt(markers(), cur.tx, cur.ty);
        setEditor(selectEvent(editor(), event?.id ?? null));
        if (remove && event) setEditor(deleteSelectedEvent(selectEvent(editor(), event.id)));
      }
    } else if (!pointerMode && passMode() && edge & (BTN.CIRCLE | BTN.CROSS)) {
      if (cur.zone === "palette") {
        if (edge & BTN.CIRCLE) selectPassTool(PASS_TOOL_IDS[cur.slot] ?? "pass");
      } else if (cur.zone === "header") {
        if (edge & BTN.CIRCLE) {
          const id = visibleHeaderButtons()[cur.button]?.id;
          if (id) activateHeaderButton(id);
        }
      } else if (cur.zone === "canvas" && !strokeOpen && !edgeStrokeOpen) {
        const m = map();
        if (cur.tx < m.width && cur.ty < m.height) {
          const tool = passTool();
          const edgeBrush = edgeBrushFor(tool);
          if (edgeBrush) {
            setEditor(edgeStrokeStart(editor(), edgeBrush));
            setEditor((e) => edgePaintCell(e, cur.ty * m.width + cur.tx));
            edgeStrokeOpen = true;
          } else {
            let e = selectPassageBrush(editor(), tool === "block" ? "block" : "pass");
            e = strokeStart(e, tool === "clear");
            setEditor(e);
            strokeOpen = true;
          }
        }
      }
    } else if (!pointerMode && edge & (BTN.CIRCLE | BTN.CROSS)) {
      const erase = (edge & BTN.CROSS) !== 0;
      if (cur.zone === "palette") {
        if (!erase) pickPalette(cur.slot);
      } else if (cur.zone === "header") {
        if (!erase) {
          const id = visibleHeaderButtons()[cur.button]?.id;
          if (id) activateHeaderButton(id);
        }
      } else if (!strokeOpen) {
        strokeOpen = true;
        setEditor(strokeStart(editor(), erase));
      }
    }
    if (!pointerMode && !eventMode() && !passMode() && strokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => paintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && passMode() && strokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => paintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && passMode() && edgeStrokeOpen && cur.zone === "canvas" && (buttons & (BTN.CIRCLE | BTN.CROSS))) {
      const m = map();
      if (cur.tx < m.width && cur.ty < m.height) {
        setEditor((e) => edgePaintCell(e, cur.ty * m.width + cur.tx));
      }
    }
    if (!pointerMode && !eventMode() && !passMode() && released & (BTN.CIRCLE | BTN.CROSS) && strokeOpen) {
      setEditor((e) => strokeEnd(e));
      strokeOpen = false;
    }
    if (!pointerMode && passMode() && released & (BTN.CIRCLE | BTN.CROSS)) {
      if (strokeOpen) {
        setEditor((e) => strokeEnd(e));
        strokeOpen = false;
      }
      if (edgeStrokeOpen) {
        setEditor((e) => edgeStrokeEnd(e));
        edgeStrokeOpen = false;
      }
    }

    batch(() => {
      if (cur.zone === "header") {
        cur = { ...cur, button: Math.min(cur.button, Math.max(0, visibleHeaderButtons().length - 1)) };
      }
      setCursor(cur);
      if (c.x !== cam().x || c.y !== cam().y) setCam(c);
      // Keep the gamepad cursor's palette row inside the scrolled strip.
      if (cur.zone === "palette" && !eventMode()) {
        const columns = passMode() ? PASS_TOOL_COLS : PAL_COLS;
        const rowTop = Math.floor(cur.slot / columns) * PAL_PITCH;
        const view = vp().h - HEADER_H - STATUS_H - PAL_GRID_TOP - PAL_PITCH;
        const y = palScroll();
        if (rowTop < y) setPalScroll(rowTop);
        else if (rowTop > y + view) setPalScroll(Math.max(0, rowTop - view));
      }
    });
    prevButtons = buttons;
  };

  // --- per-frame pump -----------------------------------------------------
  onFrame((buttons) => {
    // Dynamic web and desktop hosts resize the core before this callback.
    // Polling the authoritative viewport keeps chrome geometry correct even
    // when no companion-specific resize message is available.
    const liveViewport = hostViewport(getOps());
    if (liveViewport && (liveViewport.w !== vp().w || liveViewport.h !== vp().h)) {
      applyViewport(liveViewport.w, liveViewport.h);
    }
    settlePendingHostSave();
    if (playProject()) {
      if (svc) {
        for (const line of svc.poll()) {
          if (line.t === "resize" && line.w !== undefined && line.h !== undefined) {
            applyViewport(line.w, line.h);
          } else if (line.t === "mouse") {
            handlePlaytestMouseLine(line);
          } else if (line.t === "key" && (line.k === "Escape" || line.k === "Esc")) {
            stopPlaytest();
          } else if (line.t === "key" && line.cmd && (line.k === "s" || line.k === "S")) {
            performSave(undefined, "SAVED", line.request);
          } else if (line.t === "project" && typeof line.shell === "string") {
            stopPlaytest();
            loadHostShardedProject(line);
          } else if (line.t === "load" && typeof line.text === "string") {
            stopPlaytest();
            loadHostDocument(line);
          }
        }
      }
      stepPlaytestButtons(buttons);
      return;
    }
    if (svc) {
      for (const line of svc.poll()) {
        const agentMessage = parseLocalAgentHostMessage(line);
        if (agentMessage?.t === "agent-ready") {
          setAgentReady(agentMessage);
          if (!agentMessage.available) setNotice({ kind: "bad", text: agentMessage.message.toUpperCase() });
        } else if (agentMessage?.t === "agent-state") {
          const current = agentState();
          if (!current || current.id === agentMessage.id) {
            setAgentState(agentMessage);
            if (agentMessage.status === "completed") {
              const ids = new Set(agentMessage.proposalIds ?? []);
              const index = pendingProposals().findIndex((proposal) => ids.has(proposal.id));
              batch(() => {
                setAgentInput("");
                setAgentInputFocus(false);
                setProposalOpen(true);
                setNotice({ kind: "good", text: agentMessage.message.toUpperCase() });
              });
              if (index >= 0) selectProposalAt(index);
            } else if (agentMessage.status === "failed" || agentMessage.status === "timed-out") {
              setNotice({ kind: "bad", text: agentMessage.message.toUpperCase() });
            } else if (agentMessage.status === "cancelled") {
              setNotice({ kind: "info", text: agentMessage.message.toUpperCase() });
            }
          }
        } else if (line.t === "resize" && line.w !== undefined && line.h !== undefined) {
          applyViewport(line.w, line.h);
        } else if (line.t === "project" && typeof line.shell === "string") {
          loadHostShardedProject(line);
        } else if ((line.t === "map-data" || line.t === "map-error") && line.request !== undefined) {
          handleMapReply(line);
        } else if (line.t === "project-saved") {
          handleProjectSaved(line);
        } else if (line.t === "load" && typeof line.text === "string") {
          loadHostDocument(line);
        } else if (line.t === "proposals" && Array.isArray(line.proposals)) {
          if (shardedWorkspace()) {
            setNotice({ kind: "bad", text: "PROPOSALS ARE UNAVAILABLE FOR SHARDED PROJECTS" });
            continue;
          }
          try {
            const incoming = line.proposals.map(parseProposal);
            batch(() => {
              setProposals(incoming);
              clearProposalSelection();
              setNotice({ kind: "info", text: `LOADED ${incoming.filter((proposal) => !proposalComplete(proposal)).length} PROPOSAL(S)` });
            });
          } catch (error) {
            setNotice({ kind: "bad", text: `PROPOSALS REJECTED: ${error instanceof Error ? error.message : String(error)}` });
          }
        } else if (line.t === "mouse") {
          handleMouseLine(line);
        } else if (line.t === "scroll" && typeof line.dy === "number") {
          if (mapListOpen()) {
            const windowed = mapListWindow(catalog().length, mapListPanelHeight(), mapListScroll());
            setMapListScroll((value) => Math.max(
              0,
              Math.min(windowed.maxScroll, value + Math.sign(line.dy!) * 44),
            ));
            continue;
          }
          if (proposalOpen()) {
            const proposal = selectedProposal() === null ? undefined : pendingProposals()[selectedProposal()!];
            const count = proposal?.hunks.length ?? pendingProposals().length;
            const visible = proposalVisibleRows(proposalPanelHeight(), proposal !== undefined, proposal === undefined);
            setProposalScroll((value) => Math.max(0, Math.min(Math.max(0, count - visible), value + Math.sign(line.dy!))));
            continue;
          }
          if (inspectorOpen()) {
            const layout = inspectorLayout();
            const amount = Math.sign(line.dy) * 36;
            if (layout && pointerX < layout.leftWidth) {
              setInspectorScroll((scroll) => ({
                ...scroll,
                conditionsY: Math.max(0, scroll.conditionsY + amount),
              }));
            } else {
              setInspectorScroll((scroll) => ({
                ...scroll,
                commandsY: Math.max(0, scroll.commandsY + amount),
              }));
            }
            continue;
          }
          // Clamp so the last palette row can reach the panel bottom but
          // the strip never scrolls into emptiness.
          const panelH = vp().h - HEADER_H - STATUS_H;
          const stripH = PAL_GRID_TOP + Math.ceil(palette().length / PAL_COLS) * PAL_PITCH;
          const max = Math.max(0, stripH - panelH);
          setPalScroll((y) => Math.max(0, Math.min(max, y + Math.sign(line.dy!) * 16)));
        } else if (line.t === "ch" && typeof line.s === "string") {
          if (agentInputFocus()) setAgentInput((value) => (value + line.s!).slice(0, agentReady().maxPromptChars));
          else if (mapFocus()) setMapInput((value) => (value + line.s!).slice(0, 4096));
          else if (inspectorFocus()) setInputBuffer((value) => (value + line.s!).slice(0, 4096));
        } else if (line.t === "paste" && typeof line.text === "string") {
          if (agentInputFocus()) setAgentInput((value) => (value + line.text!).slice(0, agentReady().maxPromptChars));
          else if (mapFocus()) setMapInput((value) => (value + line.text!).slice(0, 4096));
          else if (inspectorFocus()) setInputBuffer((value) => (value + line.text!).slice(0, 4096));
        } else if (line.t === "key") {
          const name = line.k ?? "";
          const focus = inspectorFocus();
          const mapFocusAction = mapFocus();
          if (mapListOpen() && (name === "ArrowUp" || name === "Up")) {
            moveMapListCursor(-1);
          } else if (mapListOpen() && (name === "ArrowDown" || name === "Down")) {
            moveMapListCursor(1);
          } else if (mapListOpen() && name === "Home") {
            moveMapListCursor(-catalog().length);
          } else if (mapListOpen() && name === "End") {
            moveMapListCursor(catalog().length);
          } else if (mapListOpen() && name === "Enter") {
            openMapListSelection();
          } else if (mapListOpen() && (name === "Escape" || name === "Esc")) {
            closeMapList();
          } else if (agentInputFocus() && name === "Enter") {
            startLocalAgent();
          } else if (agentInputFocus() && (name === "Escape" || name === "Esc")) {
            setAgentInputFocus(false);
          } else if (agentInputFocus() && name === "Backspace") {
            setAgentInput((value) => value.slice(0, -1));
          } else if (pendingPick() && (name === "Escape" || name === "Esc")) {
            setPendingPick(null);
            setNotice({ kind: "info", text: "PICK CANCELLED" });
          } else if (mapFocusAction && mapFocusAction.kind === "field" && name === "Enter") {
            if (commitMapField(mapFocusAction.field, mapInput())) {
              setMapFocus(null);
              setMapInput("");
            }
          } else if (mapFocusAction && (name === "Escape" || name === "Esc")) {
            setMapFocus(null);
            setMapInput("");
          } else if (mapFocusAction && name === "Backspace") {
            setMapInput((value) => value.slice(0, -1));
          } else if (!mapFocusAction && mapInspectorOpen() && (name === "Escape" || name === "Esc")) {
            closeMapInspector();
          } else if (focus && name === "Enter") {
            if (focus.kind === "condition-action" || focus.kind === "command-action") commitAddPrompt();
            else commitInspectorField(focus, inputBuffer());
          } else if (focus && (name === "Escape" || name === "Esc")) {
            clearInspectorInput();
          } else if (focus && name === "Backspace") {
            setInputBuffer((value) => value.slice(0, -1));
          } else if (!focus && inspectorOpen() && (name === "Escape" || name === "Esc")) {
            closeInspector();
          } else if (line.cmd && (name === "z" || name === "Z")) {
            activateHeader(HEADER_ORDER.indexOf(line.sh ? "redo" : "undo"));
          } else if (line.cmd && (name === "y" || name === "Y")) {
            activateHeader(HEADER_ORDER.indexOf("redo"));
          } else if (line.cmd && (name === "s" || name === "S")) {
            performSave(undefined, "SAVED", line.request);
          } else if (name === "Undo") activateHeader(HEADER_ORDER.indexOf("undo"));
          else if (name === "Redo") activateHeader(HEADER_ORDER.indexOf("redo"));
        }
      }
    }
    stepButtons(buttons);
  });

  // --- test/dev hooks -----------------------------------------------------
  (globalThis as Record<string, unknown>).__rpgkitEditorState = () => ({
    editor: editor(),
    cam: cam(),
    cursor: cursor(),
    paletteSize: palette().length,
    palScroll: palScroll(),
    hover: hover(),
    notice: notice(),
    hasSvc: svc !== null,
    hasFs: fsOk,
    docId: doc().id,
    savedText: savedText(),
    loadNotice: loadNotice(),
    hostFile: hostFile(),
    sharded: shardedWorkspace() !== null,
    catalogCount: catalog().length,
    catalogIndex: catalogIndex(),
    mapListOpen: mapListOpen(),
    mapListCursor: mapListCursor(),
    mapListScroll: mapListScroll(),
    visibleMapRows: visibleMapRows(),
    loadingMapIndex: loadingMapIndex(),
    loadedMapIds: shardedWorkspace()?.loadedMapIds ?? [],
    dirtyMapIds: shardedWorkspace()?.dirtyMapIds ?? [],
    savePending: savePending(),
    pendingHostSave: pendingHostSave(),
    eventMode: eventMode(),
    passMode: passMode(),
    passTool: passTool(),
    inspectorOpen: inspectorOpen(),
    mapInspectorOpen: mapInspectorOpen(),
    mapFocus: mapFocus(),
    mapInput: mapInput(),
    deleteRefs: deleteRefs(),
    mapReferencePage: mapReferencePage(),
    pendingPick: pendingPick(),
    selectedCell: selectedCell(),
    proposalOpen: proposalOpen(),
    proposals: proposals(),
    pendingProposals: pendingProposals(),
    proposalAssessments: proposalAssessments(),
    selectedProposal: selectedProposal(),
    selectedProposalHunk: selectedProposalHunk(),
    proposalPreview: proposalPreview(),
    agentReady: agentReady(),
    agentState: agentState(),
    agentInput: agentInput(),
    agentInputFocus: agentInputFocus(),
    agentRunning: agentRunning(),
    hostSaveGuard: hostSaveGuard(),
    eventPlacement: eventPlacement(),
    inspectorSelection: inspectorSelection(),
    inspectorFocus: inspectorFocus(),
    inputBuffer: inputBuffer(),
    uploaded: tileTextures.uploaded(),
    playtest: playProject() !== null,
    playProject: playProject(),
    playState: playState(),
    playDebug: playDebug(),
    playTab: playTab(),
    playPage: playPage(),
    playIssues: playIssues(),
    carryPrevious: carryPrevious(),
    hasLastPlayState: lastPlayCarry() !== null,
    playStartCell: playStartCell(),
  });
  (globalThis as Record<string, unknown>).__rpgkitEditorInject = (json: string) => {
    const loaded = documentErrors(json);
    if (loaded.errors.length > 0) return { ok: false, errors: loaded.errors };
    const source = loaded.project as unknown as ProjectSource;
    if (isProjectShell(source)) return { ok: false, errors: [{ path: "$", msg: "sharded injection requires a file host" }] };
    leaveShardedProject("a test document was injected");
    setDoc({ id: "injected", project: loaded.project, sourceText: json });
    setSavedText(json);
    resetForProject(loaded.project, { kind: "info", text: "INJECTED PROJECT JSON" });
    return { ok: true };
  };
  (globalThis as Record<string, unknown>).__rpgkitEditorExport = (): unknown => {
    const e = editor();
    const candidate = exportProject(e);
    return {
      ok: validateProject(candidate).length === 0,
      errors: validateProject(candidate),
      text: serializeProjectPreservingSource(doc().sourceText, doc().project, candidate),
    };
  };

  const buttonsRow = createMemo(visibleHeaderButtons);

  const statusLine = (): string => {
    const e = editor();
    const m = currentMap(e);
    const dirty = e.dirty || shardedWorkspace()?.isDirty ? "*" : "";
    const mode = svc ? "PTR" : "PAD";
    const sel = eventMode()
      ? e.selectedEventId ?? "NO EVENT"
      : passMode()
        ? PASS_TOOL_LABELS[passTool()]
        : e.tile ?? "ERASE";
    const h = hover();
    const pos = h ? ` ${h.x},${h.y}` : "";
    const layer = eventMode() ? "EVENTS" : passMode() ? "PASS" : e.layer.toUpperCase();
    const pick = pendingPick() ? " | PICK TARGET" : "";
    const selectedStart = playStartCell();
    const start = selectedStart?.mapId === m.id ? ` | START ${selectedStart.x},${selectedStart.y}` : "";
    const width = Math.max(0, vp().w - 8);
    const core = `${m.id} ${m.width}x${m.height} | ${layer} | ${sel}`;
    const details = `${pos}${start}${pick}`;
    const noticeText = notice().text;
    const full = `${mode} | ${doc().id}${dirty} | ${core}${details} | ${noticeText}`;
    if (editorTextWidth(full) <= width) return full;

    // On narrow screens the editing context is more useful than a transient
    // notice. Keep map/layer/selection intact, then spend any remaining pixels
    // on details and a word-boundary-fitted notice.
    let line = editorTextWidth(core) <= width ? core : fitEditorText(core, width);
    if (details && editorTextWidth(line + details) <= width) line += details;
    if (!noticeText) return line;
    const separator = " | ";
    const remaining = width - editorTextWidth(line + separator);
    if (remaining <= editorTextWidth("…")) return line;
    const fittedNotice = fitEditorText(noticeText, remaining);
    return fittedNotice ? `${line}${separator}${fittedNotice}` : line;
  };

  return (
    <View class="w-full h-full" style={{ bgColor: "#10131b" }} debugName="editor-root">
      {playProject() && playAssets() ? (
        <PlaytestSurface
          project={playProject()!}
          assets={playAssets()!}
          carry={carryPrevious() ? lastPlayCarry() : null}
          width={vp().w}
          height={vp().h}
          debugOpen={playDebug()}
          tab={playTab()}
          page={playPage()}
          issues={playIssues()}
          onState={(state) => setPlayState(state)}
          onPort={(port) => {
            playPort = port;
          }}
        />
      ) : (
        <>
      <View
        class="absolute flex-row items-center"
        style={{ posType: 1, insetL: 0, insetT: 0, width: vp().w, height: HEADER_H, bgColor: "#1b2230" }}
        debugName="editor-header"
      >
        <For each={buttonsRow()}>
          {(b, i) => (
            <HeaderButton
              label={headerLabel(b.id, eventMode(), editor().layer, carryPrevious(), secondaryHeader())}
              x={b.x}
              w={b.w}
              focus={cursor().zone === "header" && cursor().button === i()}
              enabled={headerEnabled(b.id, editor(), hostFile())}
            />
          )}
        </For>
      </View>

      {mapListOpen() && shardedWorkspace() ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: vp().w, height: mapListPanelHeight() }}
        >
          <MapList
            entries={catalog()}
            active={catalogIndex()}
            cursor={mapListCursor()}
            loading={loadingMapIndex()}
            dirtyEntries={dirtyEntries()}
            scrollY={mapListScroll()}
            width={vp().w}
            height={mapListPanelHeight()}
          />
        </View>
      ) : inspectorOpen() && selectedEvent() ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: vp().w, height: vp().h - HEADER_H - STATUS_H }}
        >
          <EventInspector
            width={vp().w}
            height={vp().h - HEADER_H - STATUS_H}
            event={selectedEvent()!}
            activePage={editor().selectedPageIndex}
            conditionRows={conditionRows()}
            commandRows={commandRows()}
            selection={inspectorSelection()}
            focus={inspectorFocus()}
            inputBuffer={inputBuffer()}
            scroll={inspectorScroll()}
            notice={notice()}
          />
        </View>
      ) : mapInspectorOpen() ? (
        <View
          class="absolute"
          style={{ posType: 1, insetL: 0, insetT: HEADER_H, width: vp().w, height: vp().h - HEADER_H - STATUS_H }}
        >
          <MapInspector
            width={vp().w}
            height={vp().h - HEADER_H - STATUS_H}
            map={map()}
            references={deleteRefs()?.references ?? []}
            referencePage={mapReferencePage()}
            notice={notice()}
            focus={mapFocus()}
            inputBuffer={mapInput()}
          />
        </View>
      ) : (
        <>
          {banner() ? <Banner width={Math.max(0, vp().w - PAL_W)} /> : null}

          {proposalOpen() ? (
            <ProposalPanel
              proposals={pendingProposals()}
              assessments={proposalAssessments()}
              selectedProposal={selectedProposal()}
              selectedHunk={selectedProposalHunk()}
              scroll={proposalScroll()}
              panelH={proposalPanelHeight()}
              agent={{
                available: agentReady().available,
                adapter: agentReady().adapter,
                message: agentState()?.message ?? agentReady().message,
                input: agentInput(),
                focused: agentInputFocus(),
                running: agentRunning(),
              }}
            />
          ) : eventMode() ? (
            <EventPanel
              selected={selectedEvent()}
              cursorTool={cursor().zone === "palette" ? cursor().slot : -1}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          ) : passMode() ? (
            <PassPanel
              selected={passTool()}
              cursorTool={cursor().zone === "palette" ? cursor().slot : -1}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          ) : (
            <PalettePanel
              thumbs={thumbs()}
              selectedSlot={selectedSlot() < 0 ? 0 : selectedSlot()}
              cursorSlot={cursor().zone === "palette" ? cursor().slot : -1}
              scrollY={palScroll()}
              panelH={vp().h - HEADER_H - STATUS_H}
            />
          )}

          <Canvas
            map={map()}
            upper={editor().upperDense[editor().mapIndex]!}
            passage={passageDense()}
            edgeForTile={edgeForTile}
            camX={cam().x}
            camY={cam().y}
            cols={viewCols()}
            rows={viewRows()}
            frame={fit().frame}
            texKey={texKey}
            events={markers()}
            eventMode={eventMode()}
            selectedEventId={editor().selectedEventId}
            dragPreview={dragPreview()}
            proposalTiles={proposalPreview().tiles}
            proposalEvents={proposalPreview().events}
            proposalMaps={proposalPreview().maps}
            hover={hover()}
            cursorZone={cursor().zone}
            cursor={cursor().zone === "canvas" ? { x: cursor().tx, y: cursor().ty } : { x: -99, y: -99 }}
          />

        </>
      )}
      <View
        class="absolute flex-row items-center"
        style={{
          posType: 1,
          insetL: 0,
          insetT: vp().h - STATUS_H,
          width: vp().w,
          height: STATUS_H,
          bgColor: "#1b2230",
          overflow: 1,
        }}
        debugName="editor-status"
      >
        <Text
          class="text-xs"
          style={{
            insetL: 4,
            width: Math.max(0, vp().w - 8),
            textColor: notice().kind === "bad" ? BAD : notice().kind === "good" ? GOOD : DIM,
            lineHeight: 12,
            height: 12,
          }}
        >
          {statusLine()}
        </Text>
      </View>
        </>
      )}
    </View>
  );
}

function headerLabel(
  id: HeaderButtonId,
  eventMode: boolean,
  layer: EditorState["layer"],
  carryPrevious: boolean,
  secondary: boolean,
): string {
  if (id === "layer") return eventMode ? "EVENT" : layer === "ground" ? "GROUND" : layer === "upper" ? "UPPER" : "PASS";
  if (id === "doc") return "DOC";
  if (id === "mapprev") return secondary ? "PREV" : "<";
  if (id === "mapnext") return secondary ? "NEXT" : ">";
  if (id === "map") return "MAP";
  if (id === "proposals") return "PROPOSALS";
  if (id === "play") return "PLAY";
  if (id === "state") return carryPrevious ? "STATE LAST" : "STATE FRESH";
  if (id === "undo") return "UNDO";
  if (id === "redo") return "REDO";
  if (id === "more") return secondary ? "BACK" : "MORE";
  return "SAVE";
}

function headerEnabled(id: HeaderButtonId, e: EditorState, hostFile: boolean): boolean {
  if (id === "doc") return !hostFile;
  if (id === "undo") return canUndo(e);
  if (id === "redo") return canRedo(e);
  return true;
}

function sameTiles(a: TileId[], b: TileId[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
