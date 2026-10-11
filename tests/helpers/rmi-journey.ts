// tests/helpers/rmi-journey.ts — an adaptive input driver for the imported
// RPG Maker test projects (tests/fixtures/rpgmaker). It folds the pure
// session reducer one 60 Hz frame at a time and records the held button
// mask of every frame, so the same tape can be replayed against the built
// GameView bundle on the wasm sim host. Walking uses a BFS over the
// engine's own passage table (the imported RM passability), recomputed at
// each tile boundary.

import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../src/engine/name-input.ts";
import { canStepFrom, type Dir4 } from "../../src/engine/passability.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../../src/engine/session.ts";
import type { Project } from "../../src/engine/types.ts";
import {
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
} from "../../src/rpgmaker-battle/rules.ts";
import type { RpgMakerBattleDatabase } from "../../src/rpgmaker-battle/types.ts";

export const BTN_UP = 0x0010;
export const BTN_RIGHT = 0x0020;
export const BTN_DOWN = 0x0040;
export const BTN_LEFT = 0x0080;
export const BTN_CIRCLE = 0x2000;
export const BTN_CROSS = 0x4000;

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_BTN = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
export const FACE = { down: 0, left: 1, up: 2, right: 3 } as const satisfies Record<string, Dir4>;

export function rmiSession(project: Project, battle: RpgMakerBattleDatabase, hz = 60): Session {
  return createSession(project, hz, {
    extensions: createRpgMakerBattleExtensions(battle),
    battle: createRpgMakerBattleRules(battle),
    scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
  });
}

export class RmiDriver {
  readonly session: Session;
  state: SessionState;
  readonly masks: number[] = [];
  private prev = 0;
  /** Named frame indices (the state AFTER that frame). */
  readonly marks: Record<string, number> = {};
  /** The state after each marked frame. */
  readonly markStates: Record<string, SessionState> = {};
  /** Predicates that mark the first frame they hold (see watch()). */
  private readonly watches: [string, (s: SessionState) => boolean][] = [];

  constructor(readonly project: Project, readonly battle: RpgMakerBattleDatabase) {
    this.session = rmiSession(project, battle);
    this.state = startSession(project, this.session);
  }

  go(mask: number): SessionState {
    const pressed = mask & ~this.prev;
    this.prev = mask;
    this.state = stepSession(this.session, this.state, {
      buttons: mask,
      confirmEdge: !!(pressed & BTN_CIRCLE),
      cancelEdge: !!(pressed & BTN_CROSS),
      upEdge: !!(pressed & BTN_UP),
      downEdge: !!(pressed & BTN_DOWN),
      leftEdge: !!(pressed & BTN_LEFT),
      rightEdge: !!(pressed & BTN_RIGHT),
    });
    if (this.state.interp.error) {
      throw new Error(`rmi journey: interpreter error ${JSON.stringify(this.state.interp.error)}`);
    }
    this.masks.push(mask >>> 0);
    for (let i = this.watches.length - 1; i >= 0; i--) {
      const [name, holds] = this.watches[i]!;
      if (holds(this.state)) {
        this.marks[name] = this.masks.length - 1;
        this.markStates[name] = this.state;
        this.watches.splice(i, 1);
      }
    }
    return this.state;
  }

  /** Mark the first later frame on which `holds` is true. */
  watch(name: string, holds: (s: SessionState) => boolean): void {
    this.watches.push([name, holds]);
  }

  idle(frames: number): void {
    for (let i = 0; i < frames; i++) this.go(0);
  }

  mark(name: string): void {
    this.marks[name] = this.masks.length - 1;
    this.markStates[name] = this.state;
  }

  private pads(): Set<number> {
    const map = this.session.maps.get(this.state.mapId)!;
    const out = new Set<number>();
    for (const ev of map.events ?? []) {
      if (ev.pages.some((p) => (p.trigger === "playerTouch" || p.trigger === "eventTouch") && p.blocks !== true)) {
        out.add(ev.y * map.width + ev.x);
      }
    }
    return out;
  }

  private nextStep(tx: number, ty: number, avoid: Set<number>): Dir4 | null {
    const s = this.state;
    const table = this.session.tables.get(s.mapId)!;
    const map = this.session.maps.get(s.mapId)!;
    const W = map.width;
    const H = map.height;
    const idx = (x: number, y: number): number => y * W + x;
    const blocked = new Set<number>();
    for (const ch of Object.values(s.chars.chars)) {
      if (!ch.blocks) continue;
      blocked.add(idx(ch.tx, ch.ty));
      if (ch.moving) blocked.add(idx(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]));
    }
    const start = idx(s.move.tx, s.move.ty);
    const goal = idx(tx, ty);
    if (start === goal) return null;
    const parent = new Int32Array(W * H).fill(-2);
    parent[start] = -1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      if (cur === goal) break;
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      for (let dir = 0 as Dir4; dir < 4; dir = (dir + 1) as Dir4) {
        const nx = cx + DX[dir];
        const ny = cy + DY[dir];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = idx(nx, ny);
        if (parent[ni] !== -2) continue;
        if (ni !== goal && (avoid.has(ni) || blocked.has(ni))) continue;
        if (!canStepFrom(table, cx, cy, dir)) continue;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    if (parent[goal] === -2) return null;
    let cur = goal;
    let p = parent[cur]!;
    while (p !== start) {
      cur = p;
      p = parent[cur]!;
      if (p < 0) return null;
    }
    const sx = start % W;
    const sy = Math.floor(start / W);
    const nx = cur % W;
    const ny = Math.floor(cur / W);
    if (nx === sx + 1) return 3;
    if (nx === sx - 1) return 1;
    if (ny === sy + 1) return 0;
    return 2;
  }

  /** Walk to (tx,ty) avoiding touch pads (step onto one with stepOnce). */
  walkTo(tx: number, ty: number, maxFrames = 6000): void {
    const avoid = this.pads();
    let blockedFor = 0;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      if (s.move.tx === tx && s.move.ty === ty && !s.move.moving) return;
      let held: number;
      if (s.move.moving) {
        held = this.prev;
      } else {
        const dir = this.nextStep(tx, ty, avoid);
        if (dir === null) {
          if (++blockedFor > 600) {
            throw new Error(`rmi journey: route to (${tx},${ty}) blocked at ${s.mapId}(${s.move.tx},${s.move.ty})`);
          }
          held = 0;
        } else {
          blockedFor = 0;
          held = DIR_BTN[dir];
        }
      }
      this.go(held);
    }
    const s = this.state;
    throw new Error(`rmi journey: never reached (${tx},${ty}); at ${s.mapId}(${s.move.tx},${s.move.ty})`);
  }

  /** One held frame toward `dir`: turns in place against a blocker, or
   *  commits one step (used to step onto a transfer pad). */
  press(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
    this.go(0);
  }

  /** Release, then hold until the committed step completes. */
  stepOnce(dir: Dir4): void {
    this.go(DIR_BTN[dir]);
    while (this.state.move.moving) this.go(0);
  }

  /** Pulse confirm until no blocking fiber, modal, scene or fade remains
   *  (and the map is `wantMap` when given). Choices boxes are answered with
   *  the first option listed in `pick` (default: the first row). */
  settle(opts: { wantMap?: string; maxFrames?: number; pick?: readonly string[] } = {}): void {
    const maxFrames = opts.maxFrames ?? 6000;
    // One released frame first: an autorun or a just-confirmed event may
    // only start its fiber on the next fold.
    this.go(0);
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      const s = this.state;
      const quiet = !s.fade && !s.scene && (!opts.wantMap || s.mapId === opts.wantMap);
      if (s.interp.main === null && s.interp.modal === null && quiet) return;
      const modal = s.interp.modal;
      if (modal?.kind === "choices") {
        // Answer a choices box with the first option named in `pick` (else
        // the first row): move the cursor there, then confirm.
        const target = Math.max(0, modal.options.findIndex((o) => opts.pick?.includes(o) ?? false));
        const mask = modal.index < target ? BTN_DOWN : modal.index > target ? BTN_UP : BTN_CIRCLE;
        this.go(mask);
        this.go(0);
        continue;
      }
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error(`rmi journey: settle timed out at ${this.state.mapId}(${this.state.move.tx},${this.state.move.ty})`);
  }

  /** Confirm at the faced event, then settle. */
  talk(opts: Parameters<RmiDriver["settle"]>[0] = {}): void {
    this.go(BTN_CIRCLE);
    this.go(0);
    this.settle(opts);
  }

  /** Open the faced shop but stop before choosing a row, so a visual test
   * can inspect it without accidentally buying anything. */
  openShop(maxFrames = 3000): void {
    this.go(BTN_CIRCLE);
    this.go(0);
    let confirm = true;
    for (let i = 0; i < maxFrames; i++) {
      if (this.state.interp.modal?.kind === "shop") return;
      this.go(confirm ? BTN_CIRCLE : 0);
      confirm = !confirm;
    }
    throw new Error("rmi journey: shop did not open");
  }

  /** Select the final Leave/Back control row, then finish the event. */
  leaveShop(maxFrames = 1000): void {
    for (let i = 0; i < maxFrames; i++) {
      const modal = this.state.interp.modal;
      if (modal?.kind !== "shop") {
        this.settle();
        return;
      }
      if (modal.index < modal.rows.length - 1) {
        this.go(BTN_DOWN);
        this.go(0);
      } else {
        this.go(BTN_CIRCLE);
        this.go(0);
      }
    }
    throw new Error("rmi journey: shop did not close");
  }
}

// --- the two fixture playthroughs (tests/fixtures/rpgmaker/README.md) -------

/** hollow-mz main path: intro, elder, house chest, guard, cave golem
 *  (real front-view battle, Win), back to the elder. */
export function playHollow(project: Project, battle: RpgMakerBattleDatabase): RmiDriver {
  const d = new RmiDriver(project, battle);
  d.watch("intro", (s) => s.interp.modal?.kind === "text");
  d.watch("battle", (s) => s.scene?.kind === "battle");
  d.settle();
  d.mark("village");
  d.walkTo(12, 9);
  d.press(FACE.right);
  d.watch("elder-choices", (s) => s.interp.modal?.kind === "choices");
  d.watch("luck-text", (s) =>
    s.interp.modal?.kind === "text" &&
    s.interp.modal.complete &&
    s.interp.modal.lines.some((line) => line.includes("luck today")),
  );
  d.talk({ pick: ["I'll help"] });
  d.walkTo(11, 6);
  // The door is a same-priority Player Touch event on the house wall. The
  // import keeps its body blocking and maps it to eventTouch, so this bump
  // starts the event without moving the player onto the door.
  d.stepOnce(FACE.up);
  d.settle({ wantMap: "map002" });
  d.mark("house");
  // The fixture leaves a service opening in front of the shopkeeper so the
  // journey does not depend on the importer's known counter-reach downgrade.
  d.walkTo(9, 5);
  d.press(FACE.up);
  d.openShop();
  d.mark("shop-icons");
  d.leaveShop();
  d.walkTo(6, 4);
  d.press(FACE.up);
  d.talk();
  d.mark("chest");
  d.walkTo(6, 8);
  d.stepOnce(FACE.down);
  d.settle({ wantMap: "map001" });
  d.walkTo(19, 7);
  d.press(FACE.left);
  // The guard's choice defaults to "Keep" in MV; the kit's cursor starts
  // on the first row, so the tape moves to "Keep" explicitly.
  d.talk({ pick: ["Keep"] });
  d.mark("gate-open");
  d.walkTo(19, 1);
  d.stepOnce(FACE.up);
  d.settle({ wantMap: "map003" });
  d.mark("cave");
  d.walkTo(10, 5);
  d.press(FACE.up);
  d.talk();
  d.mark("golem-down");
  d.walkTo(10, 13);
  d.stepOnce(FACE.down);
  d.settle({ wantMap: "map001" });
  d.walkTo(13, 10);
  d.press(FACE.up);
  d.talk();
  d.mark("end");
  return d;
}

/** stage-mv: the opening cutscene, then the usher. The Director's native
 *  polling loop waits for the Stagehand's three claps before continuing. */
export function playStage(project: Project, battle: RpgMakerBattleDatabase): RmiDriver {
  const d = new RmiDriver(project, battle);
  d.watch("curtain", (s) => s.interp.screen?.pictures?.["1"] !== undefined && s.interp.modal?.kind === "text");
  d.watch("tint", (s) => Object.keys(s.interp.screen?.tints ?? {}).length > 0 && s.interp.modal?.kind === "text");
  d.watch("balloon", (s) => Object.keys(s.interp.screen?.balloons ?? {}).length > 0);
  d.watch("parallax", (s) => s.interp.parallax?.image === "parallax-stageglow" && s.interp.modal?.kind === "text");
  d.watch("sparkle", (s) => {
    const instance = s.interp.anims?.find((anim) => anim.anim === "anim001");
    return !!instance && s.interp.frame - instance.start >= 4;
  });
  d.settle({ maxFrames: 20000 });
  d.mark("cutscene-done");
  d.mark("claps");
  d.walkTo(13, 10);
  d.press(FACE.right);
  d.talk();
  d.mark("end");
  return d;
}
