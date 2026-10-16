import { afterEach, describe, expect, test } from "bun:test";

// The browser player is deliberately plain JavaScript. Importing it in Bun is
// safe because its boot block is guarded by `typeof document`.
// @ts-expect-error no declaration file for the browser-only host module
import { Player } from "../tools/web/player.js";

const saved = {
  document: globalThis.document,
  location: globalThis.location,
  css: globalThis.CSS,
  demo: (globalThis as Record<string, unknown>).__rpgkitDemo,
};

afterEach(() => {
  Object.assign(globalThis, {
    document: saved.document,
    location: saved.location,
    CSS: saved.css,
    __rpgkitDemo: saved.demo,
  });
});

function button(dataset: Record<string, string>) {
  const attributes = new Map<string, string>();
  let writes = 0;
  return {
    dataset,
    href: "",
    get writes() { return writes; },
    classList: { toggle() { writes++; } },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
      writes++;
    },
    removeAttribute(name: string) {
      attributes.delete(name);
      writes++;
    },
  };
}

describe("Web demo control synchronization", () => {
  test("polls the guest hook but skips unchanged DOM and URL work", () => {
    const chapters = [button({ demoChapter: "cave", demoAutoplay: "true" }), button({ demoChapter: "forest" })];
    const speeds = [button({ demoSpeed: "1" }), button({ demoSpeed: "2" })];
    let queries = 0;
    const root = {
      dataset: {} as Record<string, string>,
      querySelectorAll(selector: string) {
        queries++;
        return selector === "[data-demo-chapter]" ? chapters : speeds;
      },
      querySelector(selector: string) {
        queries++;
        if (selector.includes('data-demo-chapter="cave"')) return chapters[0];
        return chapters[0];
      },
    };
    Object.assign(globalThis, {
      document: { querySelector: () => root },
      location: { search: "?lang=en&chapter=cave", pathname: "/play", hash: "" },
      CSS: { escape: (value: string) => value },
    });
    const state = { chapter: "cave", speed: 1 };
    let polls = 0;
    (globalThis as Record<string, unknown>).__rpgkitDemo = {
      jump() {}, autoplay() {},
      current() { polls++; return { ...state }; },
    };
    const player = Object.assign(Object.create(Player.prototype), {
      demoControls: undefined,
      demoControlsKey: null,
      demoBootSearch: null,
      demoBoot: null,
    });

    player.syncDemoControls();
    const firstQueries = queries;
    const firstWrites = [...chapters, ...speeds].reduce((sum, item) => sum + item.writes, 0);
    expect(firstQueries).toBeGreaterThan(0);
    expect(firstWrites).toBeGreaterThan(0);

    player.syncDemoControls();
    expect(polls).toBe(2);
    expect(queries).toBe(firstQueries);
    expect([...chapters, ...speeds].reduce((sum, item) => sum + item.writes, 0)).toBe(firstWrites);

    state.chapter = "forest";
    player.syncDemoControls();
    expect(queries).toBeGreaterThan(firstQueries);
    expect(root.dataset.chapter).toBe("forest");
  });
});
