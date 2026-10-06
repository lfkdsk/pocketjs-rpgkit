// Studio's play-test (editor/studio/preview.ts) on the memory host: what the
// panel's controller sends to the game — the document, the start cell or
// chapter, reloads and restarts — and what it refuses to send. The browser
// side (iframe, postMessage, forged replies, Esc) is tools/studio-verify.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryHost } from "../editor/studio/host-memory.ts";
import { chaptersFor, PlayTest, previewArtMessages, previewArtProblem, previewDocument, PREVIEW_ART_SLICE_BYTES, PREVIEW_LIMITS, type PreviewArtImage } from "../editor/studio/preview.ts";
import { PREVIEW_PROTOCOL, previewMessageBytes } from "../tools/preview/protocol.ts";
import { studioPackText } from "../tools/studio-build.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");
const SLOT = "playtest-screen";

function studio(text = SUNSTONE, host = new MemoryHost()) {
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  expect(files.openText(text, "doc.json", "doc.json")).toBe(true);
  const play = new PlayTest(app, host, () => files.examples);
  return { host, app, files, play, game: host.playTest! };
}

/** Sunstone plus seven full 256×256 maps: just over the 4 MiB message limit. */
function oversized(): string {
  const project = JSON.parse(SUNSTONE) as Project;
  for (let i = 1; i <= 7; i++) {
    project.maps.push({ id: `big-${i}`, name: `Big ${i}`, width: 256, height: 256, sheets: ["town"], ground: new Array(256 * 256).fill("town.37"), events: [] } as unknown as Project["maps"][number]);
  }
  return `${JSON.stringify(project)}\n`;
}

describe("Studio play-test controller", () => {
  test("Play loads the export bytes and starts at the selected cell and facing", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    play.dir = "up";
    await play.openIn(SLOT);
    expect(game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:7:up", "state", "focus"]);
    expect(game.loaded).toEqual([app.session!.exportText()]);
    expect(play.status).toBe("running");
    expect(play.state).toMatchObject({ map: "village", x: 9, y: 7, dir: "up", frame: 15 });
    await play.poll();
    expect(play.state?.frame).toBe(30);
    expect(play.readings).toBe(2);
  });

  test("with no cell selected, the game starts at the project start", async () => {
    const { play, game } = studio();
    await play.openIn(SLOT);
    expect(game.calls).toContain("start:village:9:9:up");
    play.choice = { kind: "project" };
    expect(play.nextTarget()).toEqual({ kind: "tile", map: "village", x: 9, y: 9, dir: "up" });
  });

  test("an edit marks the game stale; Reload sends the latest document to the same place", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    await play.openIn(SLOT);
    expect(play.stale).toBe(false);
    app.run("update-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "lines", value: "ELDER: Edited." });
    expect(play.stale).toBe(true);
    app.select({ kind: "none" });
    game.calls = [];
    expect(await play.play(play.target)).toBe(true);
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(JSON.parse(game.loaded.at(-1)!).maps[0].events.find((e: { id: string }) => e.id === "elder").pages[0].commands[0].lines).toEqual(["ELDER: Edited."]);
    expect(play.stale).toBe(false);
  });

  test("Restart loads the same document afresh, without later edits; after Stop it loads the latest", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 7 });
    await play.openIn(SLOT);
    const first = game.loaded[0]!;
    app.run("update-command", { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, field: "lines", value: "ELDER: Later." });
    game.calls = [];
    await play.restart();
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(game.loaded.at(-1)).toBe(first);
    expect(play.stale).toBe(true);
    await play.stop();
    expect(play.status).toBe("stopped");
    game.calls = [];
    await play.restart();
    expect(game.calls).toEqual(["load", "start:village:9:7:down", "state", "focus"]);
    expect(game.loaded.at(-1)).toBe(app.session!.exportText());
  });

  test("a refused start is shown, with the cell it tried", async () => {
    const { app, play, game } = studio();
    app.select({ kind: "cell", x: 9, y: 5 });
    game.failNext = { type: "start", code: "bad-start", message: "village (9, 5) holds an event" };
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("Could not start at village (9, 5): village (9, 5) holds an event");
  });

  test("a failed connection is shown and the next Play connects again", async () => {
    const { play, game } = studio();
    game.failNext = { type: "connect", code: "timeout", message: "The game page did not start within 20 s." };
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("The game page did not start within 20 s.");
    await play.play();
    expect(play.status).toBe("running");
    expect(game.calls.filter((call) => call.startsWith("connect"))).toHaveLength(2);
  });

  test("a document over the protocol's message limit is refused with a reason and never sent", async () => {
    const { play, game } = studio(oversized());
    await play.openIn(SLOT);
    expect(play.blocked).toMatch(/^Too large to play-test: the document is 4\.\d MiB and the preview protocol carries at most 4\.0 MiB per message\.$/);
    expect(game.calls).toEqual([]);
    expect(await play.play()).toBe(false);
    expect(game.calls).toEqual([]);
  }, 15_000);

  test("the size check counts the load message the way the game page does", () => {
    const { app } = studio();
    const document = previewDocument(app.session!);
    if (!document.ok) throw new Error(document.reason);
    const message = { protocol: PREVIEW_PROTOCOL, type: "load", requestId: "studio-load-000000", document: document.text };
    expect(document.bytes).toBe(previewMessageBytes(message));
    expect(document.bytes).toBeLessThan(PREVIEW_LIMITS.maxMessageBytes);
    expect(document.expanded).toBe(false);
  });

  test("a sharded pack is put together into one inline document", async () => {
    const project = JSON.parse(SUNSTONE) as Project;
    const { app, play, game } = studio(studioPackText(project));
    expect(app.session!.kind).toBe("pack");
    await play.openIn(SLOT);
    expect(play.status).toBe("running");
    expect(play.expanded).toBe(true);
    const sent = JSON.parse(game.loaded[0]!) as Project & { mapIndex?: unknown };
    expect(sent.mapIndex).toBeUndefined();
    // The pack's map index order (by id) replaces the authored order; the
    // maps themselves are unchanged.
    const byId = (maps: Project["maps"]) => [...maps].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(sent.maps)).toEqual(byId(project.maps));
    expect(sent.start).toEqual(project.start);
  });

  test("chapters come from the bundled example with the same title", async () => {
    const host = new MemoryHost();
    const chapters = [{ id: "forest", title: "Whispering Wood", snapshot: "code-forest" }];
    host.examples = [
      { id: "meadow", title: "Mini Meadow", document: "m.json", sheets: {}, sprites: {}, chapters: [{ id: "x", title: "X", snapshot: "x" }] },
      { id: "sunstone", title: (JSON.parse(SUNSTONE) as Project).title, document: "s.json", sheets: {}, sprites: {}, chapters },
    ];
    const { files, play, game } = studio(SUNSTONE, host);
    await files.loadExamples();
    expect(play.chapters()).toEqual(chapters);
    expect(chaptersFor(host.examples, "Something else")).toEqual([]);
    play.choice = { kind: "chapter", chapter: "forest" };
    await play.openIn(SLOT);
    expect(game.calls).toContain("start:chapter:forest");
    expect(game.chapters[0]).toEqual(chapters);
  });

  test("a host without play-testing says why", async () => {
    const host = new MemoryHost();
    host.playTest = null;
    const { play } = studio(SUNSTONE, host);
    expect(play.availability()).toEqual({ available: false, reason: "This host has no game to play-test in." });
    await play.openIn(SLOT);
    expect(play.status).toBe("error");
    expect(play.error).toBe("This host has no game to play-test in.");
  });

  test("a failed Stop is shown and the next Play connects again", async () => {
    const { play, game } = studio();
    await play.openIn(SLOT);
    game.failNext = { type: "stop", code: "disconnected", message: "The game was closed." };
    await play.stop();
    expect(play.status).toBe("error");
    expect(play.error).toBe("The game was closed.");
    game.calls = [];
    await play.play();
    expect(game.calls[0]).toBe(`connect:${SLOT}`);
  });

  test("Esc in the game reaches the panel; Close disconnects", async () => {
    const { play, game } = studio();
    let released = 0;
    play.onRelease(() => released++);
    await play.openIn(SLOT);
    game.release();
    expect(released).toBe(1);
    play.close();
    expect(play.status).toBe("closed");
    expect(game.calls.at(-1)).toBe("disconnect");
    expect(game.connected).toBe(false);
  });
});

// ---- project art ----------------------------------------------------------------

function art(kind: "sheet" | "sprite", id: string, width: number, height: number): PreviewArtImage {
  return { kind, id, width, height, rgba: new Uint8Array(width * height * 4).fill(kind === "sheet" ? 0x40 : 0x80) };
}

/** A studio whose game page advertises the "art" feature, with a provider
 * returning `images` (and counting its calls). */
function artStudio(images: () => readonly PreviewArtImage[]) {
  const setup = studio();
  setup.game.pageFeatures = ["art"];
  const provided = { calls: 0 };
  setup.play.setArtProvider(async () => {
    provided.calls++;
    return images();
  });
  return { ...setup, provided };
}

describe("Studio play-test with the project's art", () => {
  test("a page that lists \"art\" gets the images, then a load with art", async () => {
    const { play, game, provided } = artStudio(() => [art("sheet", "town", 352, 192), art("sprite", "wiz", 16, 16)]);
    await play.openIn(SLOT);
    expect(game.calls).toEqual([`connect:${SLOT}`, "art:sheet:town:0", "art:sprite:wiz:0", "load:art", "start:village:9:9:up", "state", "focus"]);
    expect(provided.calls).toBe(1);
    expect(game.loadedArt[0]!.map((image) => `${image.kind}:${image.id}:${image.width}x${image.height}`)).toEqual(["sheet:town:352x192", "sprite:wiz:16x16"]);
    expect(game.loadedArt[0]![0]!.rgba).toEqual(art("sheet", "town", 352, 192).rgba);
    expect(play.art).toEqual({ kind: "project", images: 2, used: 2, skipped: [] });
    expect(play.artNote).toBeNull();
    expect(play.status).toBe("running");
  });

  test("without the feature, or without a provider, nothing changes: no art requests, a plain load", async () => {
    const old = artStudio(() => [art("sheet", "town", 16, 16)]);
    old.game.pageFeatures = [];
    await old.play.openIn(SLOT);
    expect(old.game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:9:up", "state", "focus"]);
    expect(old.provided.calls).toBe(0);
    expect(old.play.art).toEqual({ kind: "stand-ins" });

    const none = studio();
    none.game.pageFeatures = ["art"];
    await none.play.openIn(SLOT);
    expect(none.game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:9:up", "state", "focus"]);
    expect(none.play.art).toEqual({ kind: "stand-ins" });

    const empty = artStudio(() => []);
    await empty.play.openIn(SLOT);
    expect(empty.game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:9:up", "state", "focus"]);
    expect(empty.provided.calls).toBe(1);
  });

  test("an image larger than one slice goes in order, in slices that fit a message", async () => {
    const big = art("sheet", "town", 1024, 1024); // 4 MiB
    const messages = previewArtMessages(big);
    expect(messages.map((message) => message.offset)).toEqual([0, PREVIEW_ART_SLICE_BYTES]);
    const { play, game } = artStudio(() => [big]);
    await play.openIn(SLOT);
    expect(game.calls.slice(1, 4)).toEqual(["art:sheet:town:0", `art:sheet:town:${PREVIEW_ART_SLICE_BYTES}`, "load:art"]);
    expect(game.loadedArt[0]![0]!.rgba).toEqual(big.rgba);
  });

  test("art over the limits plays with stand-ins and says why", async () => {
    // Five 2048x1024 sheets: 40 MiB, over the 32 MiB staging limit.
    const { play, game } = artStudio(() => [1, 2, 3, 4, 5].map((n) => art("sheet", `s${n}`, 2048, 1024)));
    await play.openIn(SLOT);
    expect(game.calls).toEqual([`connect:${SLOT}`, "load", "start:village:9:9:up", "state", "focus"]);
    expect(play.status).toBe("running");
    expect(play.art).toEqual({ kind: "stand-ins" });
    expect(play.artNote).toBe("Project art too large for the play-test (40.0 MiB; at most 32.0 MiB); using stand-in art.");
  });

  test("the pre-flight check covers count, side and byte length", () => {
    expect(previewArtProblem([art("sheet", "town", 16, 16)])).toBeNull();
    const many = Array.from({ length: PREVIEW_LIMITS.maxArtImages + 1 }, (_, i) => art("sprite", `s${i}`, 1, 1));
    expect(previewArtProblem(many)).toMatch(/1025 images and the play-test takes at most 1024/);
    expect(previewArtProblem([art("sheet", "wide", PREVIEW_LIMITS.maxArtSide + 16, 16)])).toMatch(/4112×16 .* at most 4096 px a side/);
    expect(previewArtProblem([{ ...art("sprite", "odd", 16, 16), rgba: new Uint8Array(10) }])).toMatch(/not a 16×16 RGBA image/);
  });

  test("a refused art slice plays on with stand-ins; a lost game fails the play", async () => {
    const refused = artStudio(() => [art("sheet", "town", 16, 16), art("sprite", "wiz", 16, 16)]);
    refused.game.failNext = { type: "art", code: "too-large", message: "at most 1024 images are staged at once" };
    await refused.play.openIn(SLOT);
    expect(refused.game.calls).toEqual([`connect:${SLOT}`, "art:sheet:town:0", "load", "start:village:9:9:up", "state", "focus"]);
    expect(refused.play.status).toBe("running");
    expect(refused.play.art).toEqual({ kind: "stand-ins" });
    expect(refused.play.artNote).toBe("Could not send the project art (at most 1024 images are staged at once); using stand-in art.");

    const lost = artStudio(() => [art("sheet", "town", 16, 16)]);
    lost.game.failNext = { type: "art", code: "disconnected", message: "The game was closed." };
    await lost.play.openIn(SLOT);
    expect(lost.play.status).toBe("error");
    expect(lost.play.error).toBe("Could not send the project art: The game was closed.");
    lost.game.calls = [];
    await lost.play.play();
    expect(lost.game.calls[0]).toBe(`connect:${SLOT}`);
  });

  test("a provider that fails plays with stand-ins and says why", async () => {
    const { play, game } = artStudio(() => {
      throw new Error("the art folder is gone");
    });
    await play.openIn(SLOT);
    expect(game.calls).toContain("load");
    expect(play.status).toBe("running");
    expect(play.artNote).toBe("Could not read the project art (the art folder is gone); using stand-in art.");
  });

  test("Restart sends the same art again; Reload asks the provider afresh; Close forgets it", async () => {
    let width = 16;
    const { play, game, provided } = artStudio(() => [art("sheet", "town", width, 16)]);
    await play.openIn(SLOT);
    width = 32;
    game.calls = [];
    await play.restart();
    expect(game.calls).toEqual(["art:sheet:town:0", "load:art", "start:village:9:9:up", "state", "focus"]);
    expect(game.loadedArt[1]![0]!.width).toBe(16);
    expect(provided.calls).toBe(1);
    await play.play(play.target);
    expect(provided.calls).toBe(2);
    expect(game.loadedArt[2]![0]!.width).toBe(32);
    play.close();
    expect(play.art).toBeNull();
    expect(play.artNote).toBeNull();
  });
});
