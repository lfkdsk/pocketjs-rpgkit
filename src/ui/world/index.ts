// Separate opt-in entry. Deliberately not re-exported as runtime values from
// ../index.ts, so ordinary GameView bundles cannot reach connected-world code.
export { createWorldRenderer, type WorldRendererOptions } from "./renderer.tsx";
export { WorldNpcPreview, type WorldNpcPreviewOptions, type WorldNpcPreviewStats } from "../WorldNpcPreview.tsx";
export {
  createSandboxPreviewReader,
  createSandboxSession,
  compileSandboxMap,
  defaultSandboxProbes,
  holdSandboxMap,
  runSandboxEntry,
  SANDBOX_PREVIEW_REJECT_REASONS,
  sandboxWorldMapPreview,
  summarizeSandboxPreviewCoverage,
  trimSandboxMaps,
  type SandboxActor,
  type SandboxMapPreview,
  type SandboxPreviewActor,
  type SandboxPreviewCoverage,
  type SandboxPreviewHooks,
  type SandboxPreviewOptions,
  type SandboxPreviewReader,
  type SandboxPreviewReaderOptions,
  type SandboxPreviewReaderStats,
  type SandboxPreviewRejectReason,
  type SandboxRejection,
  type SandboxRun,
} from "../../engine/world-preview-sandbox.ts";
export {
  createWorldPreviewReader,
  selectWorldMapPreview,
  summarizeWorldPreviewCoverage,
  WORLD_PREVIEW_REJECT_REASONS,
  type WorldMapPreview,
  type WorldPreviewActor,
  type WorldPreviewCoverage,
  type WorldPreviewOptions,
  type WorldPreviewReader,
  type WorldPreviewRejection,
  type WorldPreviewRejectReason,
} from "../../engine/world-preview.ts";
export { createWorldHandoffResolver } from "../../engine/world-handoff.ts";
export {
  WorldStreamedTerrain,
  type WorldStreamedTerrainBand,
  type WorldStreamedTerrainBandSource,
  type WorldStreamedTerrainProps,
  type WorldStreamedTerrainStats,
} from "../WorldStreamedTerrain.tsx";
export { WorldAnimatedTiles, type WorldAnimatedTilesProps } from "../WorldAnimatedTiles.tsx";
export type {
  GameViewWorldBand,
  GameViewWorldBandSource,
  GameViewWorldConfig,
  GameViewWorldFactoryHost,
  GameViewWorldFrame,
  GameViewWorldPreviewSource,
  GameViewWorldRenderProps,
  GameViewWorldRuntime,
  GameViewWorldViewport,
  WorldNpcSandboxStats,
  WorldPreviewHandover,
  WorldPreviewHandoverActor,
} from "../world-contract.ts";
