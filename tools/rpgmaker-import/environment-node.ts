// Node/Bun host adapter for the browser-safe RPG Maker conversion core.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { convertRpgMakerAudioMedia } from "./audio-media.ts";
import type { RpgMakerImportEnvironment } from "./environment.ts";
import { readRpgMakerMedia } from "./media.ts";
import { readPng } from "./png.ts";

export const NODE_RPGMAKER_IMPORT_ENVIRONMENT: RpgMakerImportEnvironment = {
  join,
  exists: existsSync,
  list(path) {
    if (!existsSync(path)) return [];
    return readdirSync(path).sort();
  },
  readPng,
  async readMedia(path, encryption, kind = "image") {
    return readRpgMakerMedia(path, encryption, kind);
  },
  convertAudio: convertRpgMakerAudioMedia,
};
