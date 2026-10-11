// tools/preview/preview.tsx — the rpgkit-preview/v1 host app.
//
// This player page embeds the real engine: a postMessage `load` hands it an
// rpgkit-project/v1 document, which it validates through the editor's
// document gate (editor/engine/document.ts), dresses in the editor playtest
// art (editor/engine/playtest-view.ts), or in the project's own images when
// the frontend staged them with `art` (./art.ts), and plays through the
// production GameView. The demo seam (src/ui/demo) gives the protocol host
// the same validated warp and tape paths as the in-game demo menu, so
// `start` and `input` reuse demo machinery rather than a second
// implementation.
//
// See docs/protocols.md (Preview protocol) and tools/web/preview-demo.html
// (the reference frontend).

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { getOps, mount, registerTexture } from "@pocketjs/framework";
import { loadTileTexture } from "../../vendor/pocketjs/framework/src/tiles.ts";
import { PSM } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { GameView, type BattleSceneViewProps } from "../../src/ui/GameView.tsx";
import { ChoiceIconBox } from "../../src/ui/ChoiceIconBox.tsx";
import { krm2ScreenPresentation } from "../../src/ui/krm2/index.ts";
import type { GameAssets } from "../../src/ui/game-assets.ts";
import type { GameViewDemoHost } from "../../src/ui/demo-contract.ts";
import { createWarpState, loadDemoChapter } from "../../src/ui/demo/runtime.ts";
import type { DemoChapter } from "../../src/ui/demo/types.ts";
import type { Dir, Project } from "../../src/engine/types.ts";
import type { SessionState } from "../../src/engine/session.ts";
import { loadProject } from "../../editor/engine/document.ts";
import { createPlaytestAssets, PLAYTEST_BATTLE_RULES } from "../../editor/engine/playtest-view.ts";
import { buildPreviewArt, type PreviewTextureOps } from "./art.ts";
import { documentCodepoints, supplementGlyphs } from "./cjk-glyphs.ts";
import {
  PREVIEW_FEATURES,
  PREVIEW_PROTOCOL,
  PREVIEW_VERSION,
  PreviewArtStage,
  PreviewError,
  dispatchPreviewMessage,
  parsePreviewArt,
  previewAllowlist,
  type PreviewArtResult,
  type PreviewBackend,
  type PreviewMessage,
  type PreviewLoadResult,
  type PreviewStartResult,
  type PreviewStartTarget,
  type PreviewStateResult,
} from "./protocol.ts";

const DIR_NAMES: readonly string[] = ["down", "left", "up", "right"];

// The kit compiles without the DOM lib (the engine is host-free), so the
// small browser surface this app touches is declared structurally.
interface PreviewMessageEvent {
  data: unknown;
  origin: string;
  source: { postMessage(message: unknown, targetOrigin: string): void } | null;
}
interface PreviewWindow {
  parent: PreviewWindow;
  addEventListener(type: "message", listener: (event: PreviewMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: PreviewMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}
interface PreviewLocation {
  origin: string;
  search: string;
}
function browserWindow(): PreviewWindow | undefined {
  return (globalThis as { window?: PreviewWindow }).window;
}
function browserLocation(): PreviewLocation | undefined {
  return (globalThis as { location?: PreviewLocation }).location;
}

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitPreview: RpgkitPreviewHook | undefined;
}

/** Same-page test/driver bridge, mirroring __rpgkitDemo. Every call uses the
 *  same validated paths as the postMessage protocol. */
interface RpgkitPreviewHook {
  load(document: unknown, chapters?: unknown, art?: boolean): PreviewLoadResult;
  /** One `art` request's fields (kind, id, width, height, offset, rgba). */
  art(fields: Record<string, unknown>): PreviewArtResult;
  start(target: PreviewStartTarget): PreviewStartResult;
  state(): PreviewStateResult;
  input(buttons: number, frames?: number): void;
  stop(): void;
}

interface Run {
  project: Project;
  assets: GameAssets;
  chapters: ReadonlyMap<string, DemoChapter>;
}

/** Texture operations on the running PocketJS host (RGBA8 uploads). */
const TEXTURE_OPS: PreviewTextureOps = {
  upload: (rgba, width, height) => getOps().uploadTexture(rgba, width, height, PSM.PSM_8888),
  free: (handle) => getOps().freeTexture?.(handle),
  register: registerTexture,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PreviewBattleScene(props: BattleSceneViewProps): JSX.Element {
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height, bgColor: "#171126" }}
      debugName="rpgkit-preview-battle"
    >
      <Text class="text-lg" style={{ textColor: "#f4c35a", lineHeight: 22, height: 22 }}>BATTLE PREVIEW</Text>
      <Text class="text-xs" style={{ textColor: "#8a93a8", lineHeight: 14, height: 14 }}>CIRCLE: WIN   CROSS: ESCAPE</Text>
    </View>
  );
}

function messageResult(state: SessionState): PreviewMessage | null {
  const modal = state.interp.modal;
  if (!modal) return null;
  if (modal.kind === "text") return { kind: "text", text: modal.lines.join("\n") };
  if (modal.kind === "scrollText") return { kind: "scrollText", text: modal.lines.join("\n") };
  if (modal.kind === "choices") return { kind: "choices", text: [modal.prompt, ...modal.options].join("\n") };
  return { kind: "shop", text: "" };
}

function stateResult(state: SessionState): PreviewStateResult {
  const interp = state.interp;
  return {
    status: "running",
    map: state.mapId,
    x: state.move.tx,
    y: state.move.ty,
    px: state.move.px,
    py: state.move.py,
    dir: DIR_NAMES[state.move.facing] ?? "down",
    moving: state.move.moving,
    frame: state.frame,
    running: (interp.main ? 1 : 0) + Object.keys(interp.parallels).length,
    event: interp.main?.key ?? null,
    message: messageResult(state),
    switches: { ...state.sw.switches },
    variables: { ...state.sw.variables },
    gold: state.sw.gold,
    items: { ...state.sw.items },
  };
}

/** Shape-check the optional chapter list at load time; snapshot validity is
 *  checked when the chapter starts, the way the demo menu does it. */
function chapterList(chapters: unknown): Map<string, DemoChapter> {
  const map = new Map<string, DemoChapter>();
  if (chapters === undefined) return map;
  if (!Array.isArray(chapters)) throw new PreviewError("bad-document", "chapters must be a list");
  for (const [index, entry] of chapters.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PreviewError("bad-document", `chapters[${index}] is not an object`);
    }
    const chapter = entry as Record<string, unknown>;
    if (typeof chapter.id !== "string" || chapter.id.length === 0) {
      throw new PreviewError("bad-document", `chapters[${index}].id is missing`);
    }
    if (typeof chapter.title !== "string" || chapter.title.length === 0) {
      throw new PreviewError("bad-document", `chapters[${index}].title is missing`);
    }
    const snapshot = chapter.snapshot;
    if (typeof snapshot !== "string" && (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot))) {
      throw new PreviewError("bad-document", `chapters[${index}].snapshot must be a save code or snapshot object`);
    }
    if (chapter.tape !== undefined && (!Array.isArray(chapter.tape) || chapter.tape.some((m) => !Number.isInteger(m) || m < 0 || m > 0xffff))) {
      throw new PreviewError("bad-document", `chapters[${index}].tape must be a list of u16 masks`);
    }
    map.set(chapter.id, chapter as unknown as DemoChapter);
  }
  return map;
}

export function PreviewApp() {
  const [run, setRun] = createSignal<Run | null>(null);
  const [notice, setNotice] = createSignal("Waiting for a project document…");
  let host: GameViewDemoHost | null = null;
  const staging = new PreviewArtStage();
  /** Sprite textures of the mounted run, freed when it goes. */
  let artHandles: number[] = [];

  /** Unmount the running game, then free its textures. */
  const unmount = (): void => {
    host = null;
    setRun(null);
    for (const handle of artHandles) TEXTURE_OPS.free(handle);
    artHandles = [];
  };

  const backend: PreviewBackend = {
    load(document, chapters, art) {
      // Whatever happens, this load ends the staging round.
      const images = art ? staging.take() : [];
      staging.clear();
      const text = typeof document === "string" ? document : JSON.stringify(document);
      const loaded = loadProject(text);
      if (loaded.errors.length > 0) {
        throw new PreviewError("bad-document", `${loaded.errors[0]!.path}: ${loaded.errors[0]!.msg}`);
      }
      const project = loaded.project;
      if (!Array.isArray(project.maps)) {
        throw new PreviewError("bad-document", "sharded projects (mapIndex) are not supported; paste an inline document");
      }
      const list = chapterList(chapters);
      unmount();
      // Bake the document's characters the atlases lack before the view
      // mounts and measures (cjk-glyphs.ts).
      const glyphs = supplementGlyphs(documentCodepoints(project));
      const built = art ? buildPreviewArt(project, images, TEXTURE_OPS, loadTileTexture) : null;
      artHandles = built?.handles ?? [];
      const assets = createPlaytestAssets(project, built?.art);
      setRun({ project, assets, chapters: list });
      setNotice(`Loaded “${project.title}”`);
      return {
        title: project.title,
        maps: project.maps.map((map) => ({ id: map.id, name: map.name || map.id, width: map.width, height: map.height })),
        start: { map: project.start.map, x: project.start.x, y: project.start.y, dir: project.start.dir },
        glyphs,
        ...(built ? { art: built.use } : {}),
      };
    },

    art(slice) {
      return staging.add(slice);
    },

    start(target) {
      const current = host;
      if (!current) throw new PreviewError("not-loaded", "no project is loaded");
      const loaded = run();
      if (target.kind === "chapter") {
        const chapter = loaded?.chapters.get(target.chapter);
        if (!chapter) throw new PreviewError("unknown-chapter", `no chapter ${JSON.stringify(target.chapter)}`);
        // loadDemoChapter validates the snapshot and loads it into the
        // controller itself; a chapter with a tape plays, one without is
        // restored for live play.
        try {
          loadDemoChapter(current, chapter, (chapter.tape?.length ?? 0) > 0, 1);
        } catch (error) {
          throw new PreviewError("bad-start", errorText(error));
        }
      } else {
        if (!loaded?.project.maps.some((map) => map.id === target.map)) {
          throw new PreviewError("unknown-map", `no map ${JSON.stringify(target.map)}`);
        }
        const spawn = { x: target.x, y: target.y, ...(target.dir ? { dir: target.dir } : {}) };
        let warped;
        try {
          warped = createWarpState(current, target.map, spawn);
        } catch (error) {
          throw new PreviewError("bad-start", errorText(error));
        }
        current.attract.loadState(warped, 0, [], false, 1);
      }
      const state = current.attract.state;
      return { map: state.mapId, x: state.move.tx, y: state.move.ty, dir: DIR_NAMES[state.move.facing] ?? "down" };
    },

    state() {
      const current = host;
      if (!current) throw new PreviewError("not-loaded", "no project is loaded");
      return stateResult(current.attract.state);
    },

    input(buttons, frames) {
      const current = host;
      if (!current) throw new PreviewError("not-loaded", "no project is loaded");
      // A fresh press: the tape holds the mask for `frames` then releases, so
      // edges arise from the mask change exactly as live input would.
      const tape = new Array<number>(frames).fill(buttons);
      tape.push(0);
      current.attract.loadState(current.attract.state, 0, tape, true, 1);
    },

    stop() {
      staging.clear();
      unmount();
      setNotice("Stopped. Waiting for a project document…");
    },
  };

  const hook: RpgkitPreviewHook = {
    load: (document, chapters, art) => backend.load(document, chapters, art === true),
    art: (fields) => backend.art(parsePreviewArt(fields)),
    start: (target) => backend.start(target),
    state: () => backend.state(),
    input: (buttons, frames) => backend.input(buttons, frames ?? 1),
    stop: () => backend.stop(),
  };
  globalThis.__rpgkitPreview = hook;
  onCleanup(() => {
    if (globalThis.__rpgkitPreview === hook) delete globalThis.__rpgkitPreview;
  });

  // The page owns one frame callback for the app's whole life, so the player
  // host keeps ticking on the idle screen; a mounted GameView adds its own.
  onFrame(() => {});

  onMount(() => {
    // The headless card preview renderer (tools/web/preview.ts) evaluates the
    // bundle without a DOM; the protocol listener exists only on real pages.
    const win = browserWindow();
    const loc = browserLocation();
    if (!win || !loc) return;
    const allow = previewAllowlist(loc.origin, loc.search);
    const onMessage = (event: PreviewMessageEvent) => {
      if (event.source === win) return;
      const dispatch = dispatchPreviewMessage(event.data, event.origin, allow, backend);
      if (dispatch === "drop" || dispatch === null) return;
      event.source?.postMessage(dispatch, event.origin);
    };
    win.addEventListener("message", onMessage);
    onCleanup(() => win.removeEventListener("message", onMessage));
    if (win.parent !== win) {
      win.parent.postMessage({ protocol: PREVIEW_PROTOCOL, type: "event", event: "ready", version: PREVIEW_VERSION, features: [...PREVIEW_FEATURES] }, "*");
    }
  });

  return (
    <View class="w-full h-full" style={{ bgColor: "#10131b" }} debugName="rpgkit-preview-root">
      <Show
        when={run()}
        keyed
        fallback={
          <View class="w-full h-full flex-col items-center justify-center" debugName="rpgkit-preview-idle">
            <Text class="text-sm" style={{ textColor: "#8a93a8" }}>{notice()}</Text>
          </View>
        }
      >
        {(loaded) => (
          <GameView
            project={loaded.project}
            assets={loaded.assets}
            screenPresentation={krm2ScreenPresentation}
            extensions={{ allowUnknown: true }}
            battle={PLAYTEST_BATTLE_RULES}
            battleScene={PreviewBattleScene}
            choiceIcons={ChoiceIconBox}
            demo={{
              create(h) {
                host = h;
                onCleanup(() => {
                  if (host === h) host = null;
                });
                return {
                  step: () => ({ consumed: false }),
                  isOpen: () => false,
                  render: () => null,
                };
              },
            }}
          />
        )}
      </Show>
    </View>
  );
}

mount(() => <PreviewApp />);
