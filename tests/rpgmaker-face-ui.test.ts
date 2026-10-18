import { describe, expect, test } from "bun:test";
import {
  rpgMakerFaceKey,
  rpgMakerFaceSource,
  rpgMakerRuntimeActorFaceSource,
} from "../src/ui/rpgmaker-face.ts";

const FACES = {
  "WrenFaces:0": "wren-0.png",
  "WrenFaces:5": "wren-5.png",
  "MossFaces:2": "moss-2.png",
} as const;

describe("RPG Maker actor face presentation lookup", () => {
  test("uses the importer's exact faceName:faceIndex identity", () => {
    expect(rpgMakerFaceKey("WrenFaces", 0)).toBe("WrenFaces:0");
    expect(rpgMakerFaceSource(FACES, "WrenFaces", 5)).toBe("wren-5.png");
    expect(rpgMakerFaceSource(FACES, "WrenFaces", 1)).toBeUndefined();
    expect(rpgMakerFaceKey("", 0)).toBeUndefined();
    expect(rpgMakerFaceKey("WrenFaces", -1)).toBeUndefined();
    expect(rpgMakerFaceKey("WrenFaces", 1.5)).toBeUndefined();
  });

  test("formation observes Change Actor Images fields from the live saved runtime", () => {
    const actor = { faceName: "WrenFaces", faceIndex: 0 };
    const ext = { rpgmakerBattle: { actors: { "1": actor } } };
    expect(rpgMakerRuntimeActorFaceSource(FACES, ext, 1)).toBe("wren-0.png");

    actor.faceIndex = 5;
    expect(rpgMakerRuntimeActorFaceSource(FACES, ext, 1)).toBe("wren-5.png");

    actor.faceName = "MossFaces";
    actor.faceIndex = 2;
    expect(rpgMakerRuntimeActorFaceSource(FACES, ext, 1)).toBe("moss-2.png");
  });

  test("old or malformed saves and an omitted face map keep the no-image path", () => {
    expect(rpgMakerRuntimeActorFaceSource(FACES, {}, 1)).toBeUndefined();
    expect(rpgMakerRuntimeActorFaceSource(FACES, {
      rpgmakerBattle: { actors: { "1": { faceName: "WrenFaces" } } },
    }, 1)).toBeUndefined();

    const untouched = new Proxy({}, {
      get() {
        throw new Error("omitted face maps must not inspect RPG Maker extension state");
      },
    });
    expect(rpgMakerRuntimeActorFaceSource(undefined, untouched, 1)).toBeUndefined();
  });
});
