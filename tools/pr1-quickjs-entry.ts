// Pure engine workloads bundled once per compared checkout and evaluated by
// tools/pr1-quickjs-bench.rs in PocketJS's real desktop QuickJS guest.

import { buildGame } from "../examples/sunstone/game-data.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { JsonValue } from "../src/engine/types.ts";
import { battleEvent, MAP, MAP_ID } from "../tests/fixtures/kb4-battle/fixture-data.ts";
import { kb4BattleRules } from "../tests/fixtures/kb4-battle/rules.ts";
import { StreamedRoam } from "./pr1-streamed-roam.ts";

type BenchName =
  | "sunstoneIdle"
  | "sunstoneWalk"
  | "sunstoneControlWalk"
  | "streamedRoam"
  | "battleScene"
  | "sunstoneIdleImmutable"
  | "sunstoneControlWalkImmutable"
  | "battleSceneImmutable";

const sunstone = buildGame().project;
// Grade 5 is the legacy/default speed, so this page remains behaviorally
// neutral while opting the compiled world into KM1's controlled path.
const controlledSunstone = buildGame().project;
const controlledPage = controlledSunstone.maps[0]?.events?.[0]?.pages[0];
if (!controlledPage) throw new Error("sunstone control benchmark needs one event page");
controlledPage.moveSpeed = 5;
const idleSession = createSession(sunstone, 60);
const walkSession = createSession(sunstone, 60);
const controlWalkSession = createSession(controlledSunstone, 60);
const immutableIdleSession = createSession(sunstone, 60, { immutableState: true });
const immutableControlWalkSession = createSession(controlledSunstone, 60, { immutableState: true });
let idleState = startSession(sunstone, idleSession);
let walkState = startSession(sunstone, walkSession);
let controlWalkState = startSession(controlledSunstone, controlWalkSession);
let immutableIdleState = startSession(sunstone, immutableIdleSession);
let immutableControlWalkState = startSession(controlledSunstone, immutableControlWalkSession);
let walkFrame = 0;
let controlWalkFrame = 0;
let immutableControlWalkFrame = 0;

for (let frame = 0; frame < 180; frame++) {
  idleState = stepSession(idleSession, idleState, { buttons: 0 });
  const buttons = frame % 64 < 32 ? 0x0020 : 0x0080;
  walkState = stepSession(walkSession, walkState, { buttons });
  controlWalkState = stepSession(controlWalkSession, controlWalkState, { buttons });
  immutableIdleState = stepSession(immutableIdleSession, immutableIdleState, { buttons: 0 });
  immutableControlWalkState = stepSession(
    immutableControlWalkSession,
    immutableControlWalkState,
    { buttons },
  );
}

const streamedRoam = new StreamedRoam();
for (let frame = 0; frame < 720; frame++) streamedRoam.step();

const battleMap = { ...MAP, events: [battleEvent({ enemyHp: 999_999 })] };
const battleProject = {
  format: "rpgkit-project/v1" as const,
  title: "PR1 QuickJS battle scene",
  tileSize: 16 as const,
  start: { map: MAP_ID, x: 2, y: 2, dir: "down" as const },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" as const }],
  items: [],
  maps: [battleMap],
};
const battleSession = createSession(battleProject, 60, { battle: kb4BattleRules });
let battleState = stepSession(battleSession, startSession(battleProject, battleSession), { buttons: 0 });

// A persistent ruleset isolates BattleRules.immutableState from the mutable
// KB4 fixture. Its unchanged party/move tree is representative of the data a
// battle scene carries while only its clock and input mask advance.
const immutableBattleRules: BattleRules = {
  immutableState: true,
  start(ext) {
    return {
      ext,
      state: {
        ticks: 0,
        buttons: 0,
        party: Array.from({ length: 12 }, (_, slot) => ({
          id: `fighter-${slot}`,
          hp: 100,
          moves: ["strike", "guard", "item", "escape"],
        })),
      },
    };
  },
  step(value, input, ticks) {
    const state = value as { ticks: number; buttons: number; party: JsonValue };
    return { ...state, ticks: state.ticks + ticks, buttons: input.buttons } as JsonValue;
  },
  done() {
    return null;
  },
};
const immutableBattleSession = createSession(battleProject, 60, {
  battle: immutableBattleRules,
  immutableState: true,
});
let immutableBattleState = stepSession(
  immutableBattleSession,
  startSession(battleProject, immutableBattleSession),
  { buttons: 0 },
);

const benches: Record<BenchName, () => number> = {
  sunstoneIdle: () => {
    idleState = stepSession(idleSession, idleState, { buttons: 0 });
    return idleState.frame;
  },
  sunstoneWalk: () => {
    const buttons = walkFrame++ % 64 < 32 ? 0x0020 : 0x0080;
    walkState = stepSession(walkSession, walkState, { buttons });
    return walkState.frame;
  },
  sunstoneControlWalk: () => {
    const buttons = controlWalkFrame++ % 64 < 32 ? 0x0020 : 0x0080;
    controlWalkState = stepSession(controlWalkSession, controlWalkState, { buttons });
    return controlWalkState.frame;
  },
  streamedRoam: () => {
    return streamedRoam.step();
  },
  battleScene: () => {
    battleState = stepSession(battleSession, battleState, { buttons: 0 });
    return battleState.frame;
  },
  sunstoneIdleImmutable: () => {
    immutableIdleState = stepSession(immutableIdleSession, immutableIdleState, { buttons: 0 });
    return immutableIdleState.frame;
  },
  sunstoneControlWalkImmutable: () => {
    const buttons = immutableControlWalkFrame++ % 64 < 32 ? 0x0020 : 0x0080;
    immutableControlWalkState = stepSession(
      immutableControlWalkSession,
      immutableControlWalkState,
      { buttons },
    );
    return immutableControlWalkState.frame;
  },
  battleSceneImmutable: () => {
    immutableBattleState = stepSession(immutableBattleSession, immutableBattleState, { buttons: 0 });
    return immutableBattleState.frame;
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __pr1Run: (name: BenchName, iterations: number) => number;
  // eslint-disable-next-line no-var
  var __pr1Sink: number;
}

globalThis.__pr1Sink = 0;
globalThis.__pr1Run = (name, iterations) => {
  const bench = benches[name];
  if (!bench) throw new Error(`unknown PR1 benchmark ${name}`);
  let sink = globalThis.__pr1Sink | 0;
  for (let i = 0; i < iterations; i++) sink = (sink ^ bench()) | 0;
  globalThis.__pr1Sink = sink;
  return sink;
};
