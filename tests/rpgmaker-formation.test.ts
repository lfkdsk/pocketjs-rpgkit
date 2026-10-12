import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { buildMiniProject } from "../examples/meadow/mini-project.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { createSession, startSession, type SessionState } from "../src/engine/session.ts";
import { travelRuntime } from "../src/travel.ts";
import type { Project } from "../src/engine/types.ts";
import type {
  GameViewDemoRuntime,
  GameViewSessionHost,
} from "../src/ui/demo-contract.ts";

// The formation module is TSX for PocketJS's Solid compiler. These tests
// exercise only its runtime contract, so JSX construction deliberately fails
// if a test accidentally reaches presentation code.
Bun.plugin({
  name: "rpgmaker-formation-without-jsx",
  setup(build) {
    build.onLoad({ filter: /src\/ui\/.*\.tsx$/ }, async ({ path }) => {
      const transpiler = new Bun.Transpiler({
        loader: "tsx",
        tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "__noJsx", jsxFragmentFactory: "__noJsx" } },
      });
      const code = transpiler.transformSync(await Bun.file(path).text());
      return {
        loader: "js",
        contents: `const __noJsx = () => { throw new Error("formation rendering is not part of this test"); };\n${code}`,
      };
    });
  },
});

const { createRpgMakerFormation } = await import("../src/ui/rpgmaker-formation/index.tsx");

function project(): Project {
  return {
    ...buildMiniProject(),
    system: { rpgMakerText: { party: [1, 2, 3], currencyUnit: "G" } },
    actors: [
      { id: "actor001", databaseId: 1, name: "Aster" },
      { id: "actor002", databaseId: 2, name: "Bryn" },
      { id: "actor003", databaseId: 3, name: "Cyra" },
    ],
    followers: {
      enabled: true,
      members: [
        { id: "actor001", sprite: "aster" },
        { id: "actor002", sprite: "bryn" },
        { id: "actor003", sprite: "cyra" },
      ],
    },
  };
}

interface Mounted {
  runtime: GameViewDemoRuntime;
  state(): SessionState;
  replaceCount(): number;
  lastHeld(): number | undefined;
}

function withRuntime<T>(
  body: (mounted: Mounted) => T,
  options: { openButton?: number; state?: (state: SessionState) => void } = {},
): T {
  return createRoot((dispose) => {
    try {
      const source = project();
      const session = createSession(source, 60, {
        rpgMakerText: rpgMakerTextRuntime,
        travel: travelRuntime,
      });
      let state = startSession(source, session);
      options.state?.(state);
      let replacements = 0;
      let held: number | undefined;
      const host: GameViewSessionHost = {
        project: source,
        session,
        getState: () => state,
        heldButtons: () => 0x20,
        replaceState(next, nextHeld) {
          state = next;
          held = nextHeld;
          replacements++;
        },
      };
      return body({
        runtime: createRpgMakerFormation({ openButton: options.openButton }).create(host),
        state: () => state,
        replaceCount: () => replacements,
        lastHeld: () => held,
      });
    } finally {
      dispose();
    }
  });
}

function press(runtime: GameViewDemoRuntime, button: number) {
  return runtime.step(button, button);
}

describe("RPG Maker formation overlay", () => {
  test("disabled formation access neither opens nor mutates the session", () => {
    withRuntime(({ runtime, state, replaceCount }) => {
      const before = structuredClone(state());
      expect(press(runtime, BTN.CROSS)).toEqual({ consumed: false });
      expect(runtime.isOpen()).toBe(false);
      expect(replaceCount()).toBe(0);
      expect(state()).toEqual(before);
    }, {
      state(state) {
        state.interp.sw.formationAccess = false;
        state.sw = state.interp.sw;
      },
    });
  });

  test("swaps every party position through a cloned state while only walking art stays fixed", () => {
    withRuntime(({ runtime, state, replaceCount, lastHeld }) => {
      const original = state();
      expect(press(runtime, BTN.CROSS)).toEqual({ consumed: true });
      expect(runtime.isOpen()).toBe(true);

      // Match upstream formation semantics: index 0 participates in party
      // and follower order even though this overlay cannot rebind GameView's
      // fixed walking sprite artwork.
      press(runtime, BTN.CIRCLE);
      press(runtime, BTN.DOWN);
      expect(press(runtime, BTN.CIRCLE)).toEqual({ consumed: true, stateChanged: true });
      expect(state().sw.partyOrder).toEqual([2, 1, 3]);
      expect(state().travel?.followers?.members.map((member) => member.id)).toEqual([
        "actor002",
        "actor001",
        "actor003",
      ]);

      // Every remaining position is reorderable too.
      press(runtime, BTN.CIRCLE);
      press(runtime, BTN.DOWN);
      expect(press(runtime, BTN.CIRCLE)).toEqual({ consumed: true, stateChanged: true });
      expect(state().sw.partyOrder).toEqual([2, 3, 1]);
      expect(state().travel?.followers?.members.map((member) => member.id)).toEqual([
        "actor002",
        "actor003",
        "actor001",
      ]);
      expect(state().sw).toBe(state().interp.sw);
      expect(state()).not.toBe(original);
      expect(state().interp).not.toBe(original.interp);
      expect(original.sw.partyOrder).toBeUndefined();
      expect(original.travel?.followers?.members.map((member) => member.id)).toEqual([
        "actor001",
        "actor002",
        "actor003",
      ]);
      expect(replaceCount()).toBe(2);
      expect(lastHeld()).toBe(0x20);
    });
  });

  test("a configurable opener leaves CROSS as cancel and cancel does not replace state", () => {
    withRuntime(({ runtime, state, replaceCount }) => {
      const before = structuredClone(state());
      expect(press(runtime, BTN.CROSS)).toEqual({ consumed: false });
      expect(runtime.isOpen()).toBe(false);
      expect(press(runtime, BTN.START)).toEqual({ consumed: true });
      expect(runtime.isOpen()).toBe(true);
      expect(press(runtime, BTN.CROSS)).toEqual({ consumed: true });
      expect(runtime.isOpen()).toBe(false);
      expect(replaceCount()).toBe(0);
      expect(state()).toEqual(before);
    }, { openButton: BTN.START });
  });

  test("rejects open buttons that would consume menu navigation or selection", () => {
    expect(() => createRpgMakerFormation({ openButton: BTN.CIRCLE })).toThrow("conflicts with menu navigation");
    expect(() => createRpgMakerFormation({ openButton: BTN.DOWN })).toThrow("conflicts with menu navigation");
    expect(() => createRpgMakerFormation({ openButton: BTN.START | BTN.CROSS })).toThrow("one button bit");
  });

  test("reconciles a sparse saved partyOrder before reordering followers", () => {
    withRuntime(({ runtime, state }) => {
      press(runtime, BTN.CROSS);
      press(runtime, BTN.DOWN);
      press(runtime, BTN.CIRCLE);
      press(runtime, BTN.DOWN);
      expect(press(runtime, BTN.CIRCLE).stateChanged).toBe(true);
      expect(state().sw.partyOrder).toEqual([3, 2, 1]);
      expect(state().sw).toBe(state().interp.sw);
    }, {
      state(state) {
        state.interp.sw.partyOrder = [3];
        state.sw = state.interp.sw;
      },
    });
  });
});
