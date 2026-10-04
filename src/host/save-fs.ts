// src/host/save-fs.ts — P1⑤ desktop save store over @pocketjs/framework/fs.
//
// The desktop host (hosts/desktop/src/fs.rs) binds the app's own data root
// as globalThis.fs and registers data.fs for linux-app/macos-app. Saves
// land at save/slot-N.json under that root. On every target without the
// module mounted (web-app, the sim host unless a test mounts one) fsHost()
// is null: the UI then runs the save-code fallback (engine/save.ts)
// instead of calling here. The adapter is the SaveStore port from
// engine/save.ts plus a slot lister for the menu.

import { file, fsHost, write } from "@pocketjs/framework/fs";
import type { MapContentIdentity } from "../engine/map-repository.ts";
import {
  decodeEnvelopeText,
  encodeEnvelope,
  loadFromStore,
  saveToStore,
  slotPath,
  summarizeEnvelope,
  type SaveSnapshot,
  type SaveStore,
  type SlotSummary,
} from "../engine/save.ts";

export interface FsSlotInfo extends SlotSummary {
  checksum: string;
}

/** Dedicated desktop autosave file. It is intentionally outside slotPath's
 * 1..3 namespace, so no save-menu command can overwrite it. */
export const AUTOSAVE_FS_PATH = "save/autosave.json";

/** True when a host mounted the fs module (desktop linux-app/macos-app). */
export function hasFsSave(): boolean {
  return fsHost() !== null;
}

class FsSaveStore implements SaveStore {
  exists(slot: number): boolean {
    return file(slotPath(slot)).exists();
  }
  read(slot: number): string | null {
    const f = file(slotPath(slot));
    if (!f.exists()) return null;
    return f.text();
  }
  write(slot: number, envelope: string): void {
    // Bun.write semantics: truncates and creates the save/ parent.
    write(slotPath(slot), envelope);
  }
}

let store: FsSaveStore | null = null;

/** The fs-backed store, or null where the host mounted no fs module. */
export function fsSaveStore(): SaveStore | null {
  if (!hasFsSave()) return null;
  store ??= new FsSaveStore();
  return store;
}

export function saveSlotFs(
  slot: number,
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): void {
  const s = fsSaveStore();
  if (!s) throw new Error("save: fs module is not mounted on this target");
  saveToStore(s, slot, snapshot, content);
}

export function loadSlotFs(
  slot: number,
  content?: MapContentIdentity | null,
): SaveSnapshot {
  const s = fsSaveStore();
  if (!s) throw new Error("save: fs module is not mounted on this target");
  return loadFromStore(s, slot, content);
}

export function saveAutosaveFs(
  snapshot: SaveSnapshot,
  content?: MapContentIdentity | null,
): void {
  if (!hasFsSave()) throw new Error("autosave: fs module is not mounted on this target");
  write(AUTOSAVE_FS_PATH, encodeEnvelope(snapshot, content));
}

export function loadAutosaveFs(
  content?: MapContentIdentity | null,
): SaveSnapshot | null {
  if (!hasFsSave()) return null;
  const autosave = file(AUTOSAVE_FS_PATH);
  return autosave.exists() ? decodeEnvelopeText(autosave.text(), content) : null;
}

export function inspectAutosaveFs(
  content?: MapContentIdentity | null,
): FsSlotInfo | { slot: 0; error: string } | null {
  if (!hasFsSave()) return null;
  const autosave = file(AUTOSAVE_FS_PATH);
  if (!autosave.exists()) return null;
  try {
    return { ...summarizeEnvelope(0, autosave.text(), content), slot: 0 };
  } catch (error) {
    return { slot: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Summaries of the three fixed manual slots; null entries are empty slots.
 *  A file that fails checksum/version is listed as a slot with an error
 *  code so the menu can show it as corrupt rather than silently empty. */
export function listSlotsFs(
  content?: MapContentIdentity | null,
): (FsSlotInfo | { slot: number; error: string } | null)[] {
  const s = fsSaveStore();
  if (!s) return [null, null, null];
  return [1, 2, 3].map((slot) => {
    const text = s.read(slot);
    if (text === null) return null;
    try {
      return { ...summarizeEnvelope(slot, text, content) };
    } catch (e) {
      return { slot, error: (e as Error).message };
    }
  });
}
