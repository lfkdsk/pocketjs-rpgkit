// src/host/index.ts — host adapters shipping with the component.

export {
  hasFsSave,
  fsSaveStore,
  saveSlotFs,
  loadSlotFs,
  listSlotsFs,
  AUTOSAVE_FS_PATH,
  saveAutosaveFs,
  loadAutosaveFs,
  inspectAutosaveFs,
  type FsSlotInfo,
} from "./save-fs.ts";
export {
  autosaveBridge,
  autosaveHostCallbacks,
  createSimAutosaveBridge,
  inspectAutosaveHost,
  loadAutosaveHost,
  writeAutosaveHost,
  type AutosaveBridge,
  type AutosaveSlotStatus,
  type AutosaveSlotSummary,
} from "./autosave.ts";
export { loadAttractTape } from "./attract-tape.ts";
