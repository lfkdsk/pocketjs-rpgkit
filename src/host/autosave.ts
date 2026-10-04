// Host-neutral autosave bridge. Browser pages install it over localStorage;
// sim tests install the in-memory implementation below. The guest sees one
// dedicated value rather than a general storage API, keeping autosaves
// separate from the three numbered manual slots.

import type { MapContentIdentity } from "../engine/map-repository.ts";
import {
  decodeEnvelopeText,
  encodeEnvelope,
  summarizeEnvelope,
  type SaveSnapshot,
  type SlotSummary,
} from "../engine/save.ts";
import type { GameViewHostCallbacks } from "../ui/game-host-actions.ts";
import type { GameViewSessionHost } from "../ui/demo-contract.ts";

export interface AutosaveBridge {
  read(): string | null;
  /** false means the host had no durable storage or refused the write. */
  write(envelope: string): boolean;
}

export interface AutosaveSlotSummary extends Omit<SlotSummary, "slot"> {
  slot: 0;
  checksum: string;
}

export type AutosaveSlotStatus = AutosaveSlotSummary | { slot: 0; error: string } | null;

declare global {
  // eslint-disable-next-line no-var
  var __rpgkitAutosave: AutosaveBridge | undefined;
}

/** The bridge installed by a target host, or null on unsupported targets. */
export function autosaveBridge(): AutosaveBridge | null {
  const bridge = globalThis.__rpgkitAutosave;
  return bridge && typeof bridge.read === "function" && typeof bridge.write === "function"
    ? bridge
    : null;
}

/** Encode and replace the host's one autosave value. Unsupported/failed
 * storage is a quiet false result; the host itself may log diagnostics. */
export function writeAutosaveHost(
  snapshot: Readonly<SaveSnapshot>,
  content?: MapContentIdentity | null,
): boolean {
  const bridge = autosaveBridge();
  if (!bridge) return false;
  try {
    return bridge.write(encodeEnvelope(snapshot as SaveSnapshot, content)) !== false;
  } catch (error) {
    globalThis.console?.debug?.("pocket-rpgkit: autosave write failed", error);
    return false;
  }
}

/** Read and validate the dedicated autosave value. null means no autosave;
 * malformed or incompatible data throws the same typed SaveError as a
 * numbered slot. */
export function loadAutosaveHost(
  content?: MapContentIdentity | null,
): SaveSnapshot | null {
  const bridge = autosaveBridge();
  if (!bridge) return null;
  const text = bridge.read();
  return text === null ? null : decodeEnvelopeText(text, content);
}

/** Menu-facing status. Corruption stays visible as a damaged row. */
export function inspectAutosaveHost(
  content?: MapContentIdentity | null,
): AutosaveSlotStatus {
  const bridge = autosaveBridge();
  if (!bridge) return null;
  const text = bridge.read();
  if (text === null) return null;
  try {
    const summary = summarizeEnvelope(0, text, content);
    return { ...summary, slot: 0 };
  } catch (error) {
    return { slot: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Drop-in GameView `hostActions` implementation for browser and sim hosts. */
export const autosaveHostCallbacks = {
  autosave(host: GameViewSessionHost, snapshot: Readonly<SaveSnapshot>): void {
    writeAutosaveHost(snapshot, host.session.content);
  },
} satisfies Pick<GameViewHostCallbacks, "autosave">;

/** Reference sim implementation. Pass it as the `__rpgkitAutosave` extra
 * global to bootWorld; `text()` lets a harness inspect persisted bytes. */
export function createSimAutosaveBridge(initial: string | null = null): AutosaveBridge & {
  text(): string | null;
} {
  let value = initial;
  return {
    read: () => value,
    write: (envelope) => {
      value = envelope;
      return true;
    },
    text: () => value,
  };
}
