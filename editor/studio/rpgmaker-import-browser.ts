/// <reference lib="dom" />
// Browser RPG Maker import operation: source picker, lazy DirectoryHandle
// reads, shared conversion core, self-contained pack, coverage and lifecycle.

import type {
  RpgMakerImportOutcome,
  RpgMakerImportProgress,
  RpgMakerImportRequest,
} from "./host.ts";
import { importRmProject } from "../../tools/rpgmaker-import/project.ts";
import { packBrowserRpgMakerImport } from "./rpgmaker-import-browser-pack.ts";
import type { BrowserRpgMakerImageCodec } from "./rpgmaker-import-browser-io.ts";
import {
  BrowserRmLoadError,
  BrowserRpgMakerSource,
  loadBrowserRmProject,
  type BrowserDirectoryHandle,
} from "./rpgmaker-import-browser-source.ts";

export type BrowserDirectoryPicker = (options: { mode: "read" | "readwrite" }) => Promise<BrowserDirectoryHandle>;

function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

function importedFileName(sourceName: string): string {
  const stem = sourceName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "rpgmaker-project";
  return `${stem}-imported.rpgpack.json`;
}

interface ActiveImport {
  token: string;
  controller: AbortController;
}

export class BrowserRpgMakerImporter {
  private active: ActiveImport | null = null;
  private listeners = new Set<(progress: RpgMakerImportProgress) => void>();

  constructor(
    private readonly picker: () => BrowserDirectoryPicker | null,
    private readonly codec?: BrowserRpgMakerImageCodec,
  ) {}

  available(): boolean {
    return this.picker() !== null;
  }

  onProgress(listener: (progress: RpgMakerImportProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(token: string): void {
    if (this.active?.token === token) this.active.controller.abort();
  }

  async import(request: RpgMakerImportRequest): Promise<RpgMakerImportOutcome> {
    if (this.active) {
      return { ok: false, token: request.token, code: "BUSY", message: "Another RPG Maker import is already running." };
    }
    const picker = this.picker();
    if (!picker) {
      return {
        ok: false,
        token: request.token,
        code: "IMPORT_FAILED",
        message: "This browser has no directory picker (File System Access); use Chrome or Edge.",
      };
    }
    const controller = new AbortController();
    const active = { token: request.token, controller };
    this.active = active;
    try {
      this.progress(request.token, "selecting", "Choose the RPG Maker MV or MZ project folder.");
      const handle = await picker({ mode: "read" });
      if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
      this.progress(request.token, "reading", `Reading ${handle.name}/…`);
      const source = await BrowserRpgMakerSource.index(handle, {
        signal: controller.signal,
        onEntry: (_completed, path) => this.progress(request.token, "reading", path),
      });
      const loaded = await loadBrowserRmProject(source, { signal: controller.signal, codec: this.codec });
      this.progress(request.token, "converting", `Converting ${loaded.project.maps.size} map${loaded.project.maps.size === 1 ? "" : "s"}…`);
      const result = await importRmProject(loaded.project, { placeholders: request.placeholders });
      if (controller.signal.aborted) throw new DOMException("cancelled", "AbortError");
      this.progress(request.token, "packing", "Embedding maps and imported PNG art…", 0, result.images.size + result.mediaFiles.size);
      const text = await packBrowserRpgMakerImport(result, {
        signal: controller.signal,
        codec: this.codec,
        onAsset: (completed, total, path) => this.progress(request.token, "packing", path, completed, total),
      });
      const commandTotals = result.cov.totals("command");
      const rows = result.cov.list().map((row) => ({
        section: row.section,
        key: row.key,
        counts: { ...row.counts },
        reasons: [...row.reasons],
      }));
      const label = `${handle.name} (imported)`;
      const notes = [
        `Imported ${result.project.maps.length} map${result.project.maps.length === 1 ? "" : "s"} and embedded ${result.images.size + result.mediaFiles.size} PNG asset${result.images.size + result.mediaFiles.size === 1 ? "" : "s"}.`,
      ];
      this.progress(request.token, "complete", `Imported ${handle.name}/.`);
      return {
        ok: true,
        token: request.token,
        opened: { text, label, fileName: importedFileName(handle.name), notes },
        coverage: { totals: commandTotals, rows },
        warnings: [...result.warnings],
      };
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) {
        return { ok: false, token: request.token, code: "CANCELLED", message: "RPG Maker import cancelled." };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return error instanceof BrowserRmLoadError
        ? { ok: false, token: request.token, code: "INVALID_SOURCE", message: detail }
        : { ok: false, token: request.token, code: "IMPORT_FAILED", message: `RPG Maker import failed: ${detail}` };
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  private progress(
    token: string,
    phase: RpgMakerImportProgress["phase"],
    message?: string,
    completed?: number,
    total?: number,
  ): void {
    const progress: RpgMakerImportProgress = {
      token,
      phase,
      ...(message === undefined ? {} : { message }),
      ...(completed === undefined ? {} : { completed }),
      ...(total === undefined ? {} : { total }),
    };
    for (const listener of this.listeners) listener(progress);
  }
}
