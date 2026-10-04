import { describe, expect, test } from "bun:test";
import { executeEditOperation } from "../editor/api/operations.ts";
import { EditSession } from "../editor/api/session.ts";
import { loadProject, serializeProject, validateProject } from "../editor/engine/document.ts";
import { doctorFindings, type DoctorFinding } from "../editor/studio/doctor.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";

function makeProject(events: GameEvent[], maps: { id: string }[] = [{ id: "town" }, { id: "cave" }]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Doctor test",
    tileSize: 16,
    start: { map: "town", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "town", pak: "tiles:town", cols: 10, rows: 10 }],
    items: [],
    maps: maps.map((m) => ({
      id: m.id,
      name: m.id,
      width: 10,
      height: 10,
      sheets: ["town"],
      ground: new Array(100).fill(null),
      events: m.id === "town" ? events : [],
    })),
  };
}

function event(id: string, pages: GameEvent["pages"]): GameEvent {
  return { id, x: 1, y: 1, pages };
}

/** Apply a finding's fix ops to the project source and return the new source. */
function applyFix(source: string, finding: DoctorFinding): string {
  if (!finding.fix) throw new Error(`finding ${finding.check} offers no fix`);
  let next = source;
  for (const op of finding.fix.ops) {
    const result = executeEditOperation(next, op.command, op.args ?? {});
    if (!result.response.ok) throw new Error(`fix op ${op.command} refused: ${result.response.error?.message}`);
    next = result.output!;
  }
  return next;
}

function findingsAfter(source: string): DoctorFinding[] {
  const loaded = loadProject(source);
  expect(loaded.errors).toEqual([]);
  return doctorFindings(loaded.project as Project);
}

/** The autorun-restarts-every-frame finding for one event page, if any. */
function autorunFinding(project: Project, eventId: string, pageIndex: number): DoctorFinding | undefined {
  return doctorFindings(project).find(
    (f) => f.check === "doctor/autorun-restarts-every-frame" && f.loc.event === eventId && f.loc.page === pageIndex,
  );
}

describe("Studio doctor", () => {
  test("flags a jump to a missing label and inserts it", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [
        { op: "text", lines: ["hi"] },
        { op: "jumpLabel", name: "done" },
      ],
    }])]);
    const findings = doctorFindings(project);
    const finding = findings.find((f) => f.check === "doctor/label-missing");
    expect(finding).toBeDefined();
    expect(finding!.loc).toMatchObject({ map: "town", event: "npc", page: 0 });
    expect(finding!.fix!.label).toContain("done");

    const fixed = applyFix(serializeProject(project), finding!);
    const after = findingsAfter(fixed);
    expect(after.some((f) => f.check === "doctor/label-missing")).toBe(false);
    // The label was inserted at the end of the page.
    const page = (loadProject(fixed).project as Project).maps[0]!.events![0]!.pages[0]!;
    expect(page.commands.at(-1)).toMatchObject({ op: "label", name: "done" });
  });

  test("a label defined in a branch satisfies a jump to it", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [{
        op: "if",
        if: { kind: "switch", id: "gate" },
        then: [{ op: "label", name: "done" }],
      }, { op: "jumpLabel", name: "done" }],
    }])]);
    expect(doctorFindings(project).some((f) => f.check === "doctor/label-missing")).toBe(false);
  });

  test("flags a transfer to a missing map and deletes it", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [{ op: "transfer", map: "nowhere", x: 1, y: 1 }],
    }])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/transfer-target-missing");
    expect(finding).toBeDefined();
    const fixed = applyFix(serializeProject(project), finding!);
    expect(findingsAfter(fixed).some((f) => f.check === "doctor/transfer-target-missing")).toBe(false);
    const page = (loadProject(fixed).project as Project).maps[0]!.events![0]!.pages[0]!;
    expect(page.commands).toHaveLength(0);
  });

  test("a transfer to a known map is not flagged", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [{ op: "transfer", map: "cave", x: 1, y: 1 }],
    }])]);
    expect(doctorFindings(project).some((f) => f.check === "doctor/transfer-target-missing")).toBe(false);
  });

  test("flags a call to an undefined common event and deletes it", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [{ op: "common", id: "heal" }],
    }])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/common-event-missing");
    expect(finding).toBeDefined();
    const fixed = applyFix(serializeProject(project), finding!);
    expect(findingsAfter(fixed).some((f) => f.check === "doctor/common-event-missing")).toBe(false);
  });

  test("a break outside a loop is not a doctor finding (it is a legal early exit)", () => {
    // The language defines a break outside any loop as ending the page (RPG
    // Maker parity). Deleting it would change the event's behavior, so the
    // doctor never offers that; the lint lists it for review without a fix.
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [
        { op: "break" },
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      ],
    }])]);
    const findings = doctorFindings(project);
    expect(findings.some((f) => f.check.includes("break"))).toBe(false);
    // The break still does its job: the engine probe shows the write after it
    // never runs, while the same event without the break does run it.
    expect(runActionFrames(project.maps[0]!.events![0]!, 2)).toBe(0);
    const noBreak = makeProject([event("npc", [{
      trigger: "action",
      commands: [{ op: "variable", id: "runs", set: { op: "add", value: 1 } }],
    }])]);
    expect(runActionFrames(noBreak.maps[0]!.events![0]!, 2)).toBe(1);
  });

  test("a break inside a loop body is not flagged", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [{
        op: "loop",
        commands: [{ op: "break" }],
      }],
    }])]);
    expect(doctorFindings(project).some((f) => f.check.includes("break"))).toBe(false);
  });

  test("flags a page whose self switch is never set and deletes it", () => {
    const project = makeProject([event("npc", [
      { trigger: "action", commands: [{ op: "text", lines: ["page 1"] }] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [{ op: "text", lines: ["page 2"] }] },
    ])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/selfswitch-never-set");
    expect(finding).toBeDefined();
    expect(finding!.loc.page).toBe(1);
    const fixed = applyFix(serializeProject(project), finding!);
    expect(findingsAfter(fixed).some((f) => f.check === "doctor/selfswitch-never-set")).toBe(false);
    const after = (loadProject(fixed).project as Project).maps[0]!.events![0]!;
    expect(after.pages).toHaveLength(1);
  });

  test("a self switch set by another page keeps the page alive", () => {
    const project = makeProject([event("npc", [
      { trigger: "action", commands: [{ op: "selfSwitch", key: "A", value: true }] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [{ op: "text", lines: ["page 2"] }] },
    ])]);
    expect(doctorFindings(project).some((f) => f.check === "doctor/selfswitch-never-set")).toBe(false);
  });

  test("a single-page dead-self-switch event gets a fix the edit API accepts", () => {
    // The last page of an event cannot be deleted, so the fix must not be
    // delete-page: it removes the impossible condition instead.
    const project = makeProject([event("lonely", [{
      trigger: "action",
      condition: { selfSwitch: "A" },
      commands: [{ op: "text", lines: ["hi"] }],
    }])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/selfswitch-never-set")!;
    expect(finding).toBeDefined();
    expect(finding.fix!.ops[0]!.command).not.toBe("delete-page");
    const fixed = applyFix(serializeProject(project), finding);
    expect(findingsAfter(fixed).some((f) => f.check === "doctor/selfswitch-never-set")).toBe(false);
    const page = (loadProject(fixed).project as Project).maps[0]!.events![0]!.pages[0]!;
    expect(page.condition).toBeUndefined();
    expect(page.commands).toHaveLength(1);
  });

  test("every doctor fix applies through the edit API, undoes, and clears its finding", () => {
    // One fixture exercising every check that carries a fix.
    const project = makeProject([
      event("bad-jump", [{
        trigger: "action",
        commands: [{ op: "jumpLabel", name: "nowhere" }],
      }]),
      event("bad-transfer", [{
        trigger: "action",
        commands: [{ op: "transfer", map: "nowhere", x: 1, y: 1 }],
      }]),
      event("bad-common", [{
        trigger: "action",
        commands: [{ op: "common", id: "ghost" }],
      }]),
      event("dead-page", [
        { trigger: "action", commands: [{ op: "text", lines: ["page 1"] }] },
        { trigger: "action", condition: { selfSwitch: "B" }, commands: [{ op: "text", lines: ["page 2"] }] },
      ]),
      event("lonely-dead", [{
        trigger: "action",
        condition: { selfSwitch: "C" },
        commands: [{ op: "text", lines: ["hi"] }],
      }]),
      event("runaway", [{
        trigger: "autorun",
        commands: [{ op: "variable", id: "runs", set: { op: "add", value: 1 } }],
      }]),
    ]);
    const source = serializeProject(project);
    const findings = doctorFindings(project);
    const fixable = findings.filter((f) => f.fix);
    // The runaway autorun is reported but carries no automatic fix (a finite
    // probe window cannot prove a rewrite safe), so it is not in this list.
    expect(fixable.length).toBe(5);
    for (const finding of fixable) {
      const session = EditSession.open(source);
      const response = session.transaction(finding.fix!.label, finding.fix!.ops);
      if (!response.ok) throw new Error(`${finding.check} fix refused: ${response.error.message}`);
      const after = findingsAfter(session.exportText());
      expect(after.some((f) => f.check === finding.check && f.loc.event === finding.loc.event && f.loc.page === finding.loc.page))
        .toBe(false);
      expect(session.undo()?.ok).toBe(true);
      expect(session.exportText()).toBe(source);
    }
  });

  test("a self switch set by a called common event keeps the page alive", () => {
    const project = makeProject([event("npc", [
      { trigger: "action", commands: [{ op: "common", id: "heal" }] },
      { trigger: "action", condition: { selfSwitch: "B" }, commands: [{ op: "text", lines: ["page 2"] }] },
    ])]);
    project.commonEvents = [{ id: "heal", trigger: "none", commands: [{ op: "selfSwitch", key: "B", value: true }] }];
    expect(doctorFindings(project).some((f) => f.check === "doctor/selfswitch-never-set")).toBe(false);
  });

  test("flags an autorun that restarts every frame, as evidence with no automatic fix", () => {
    // The check is empirical: the page is run from a fresh entry with no
    // input, and a page that restarts every frame (its fiber starts on every
    // frame from its first start) is flagged. The finding states only what
    // was measured (the probe window and the start frames) — it does not
    // claim the page can never deactivate — and it carries no Fix: a finite
    // window cannot prove an automatic rewrite safe, so the repair is left
    // to the author (the message describes the standard one-shot pattern).
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [{ op: "variable", id: "runs", set: { op: "add", value: 1 } }],
    }])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/autorun-restarts-every-frame");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
    expect(finding!.fix).toBeUndefined();
    expect(finding!.message).not.toContain("never deactivates");
    expect(finding!.message).toContain("no input");
    expect(finding!.message).toContain("from frame 0 (its first start) through frame 11");
    // The measured frame list is the evidence.
    expect(finding!.message).toContain("0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11");
    // The message describes the standard one-shot pattern instead of applying it.
    expect(finding!.message).toContain("one-shot");
    expect(finding!.message).toContain("self switch");
  });

  test("the autorun finding carries the measured evidence (frames and starts)", () => {
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [{ op: "variable", id: "runs", set: { op: "add", value: 1 } }],
    }])]);
    const finding = doctorFindings(project).find((f) => f.check === "doctor/autorun-restarts-every-frame")!;
    // The message names the probe window and the measured start frames, so
    // the finding is evidence, not a static guess — and it never claims the
    // page "never deactivates" (a finite window cannot prove that).
    expect(finding.message).toContain("no input");
    expect(finding.message).toMatch(/\b12\b/);
    expect(finding.message).toContain("fiber starts on frames");
    expect(finding.message).not.toContain("never deactivates");
    expect(finding.fix).toBeUndefined();
    expect(finding.loc).toMatchObject({ map: "town", event: "npc", page: 0 });
  });

  // --- The round-2 review's counterexamples, as permanent tests. Each is a
  // page the old static scan mis-judged; the measured probe gets it right.

  test("flags a gate += 1 page whose own condition stays true forever", () => {
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: ">=", value: 0 } },
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "variable", id: "gate", set: { op: "add", value: 1 } },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0);
    expect(finding).toBeDefined();
    // It really does restart every frame: the engine probe agrees.
    expect(runEventFrames(project.maps[0]!.events![0]!, 12)).toBe(12);
  });

  test("flags a page that resets a gate a later page needs, so the later page never takes over", () => {
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        condition: { variable: { id: "gate", op: ">=", value: 0 } },
        commands: [{ op: "variable", id: "gate", set: { op: "set", value: 0 } }],
      },
      { trigger: "action", condition: { variable: { id: "gate", op: ">=", value: 1 } }, commands: [] },
    ])]);
    const finding = autorunFinding(project, "npc", 0);
    expect(finding).toBeDefined();
    expect(autorunFinding(project, "npc", 1)).toBeUndefined();
  });

  test("flags an unreachable self-switch write placed after an exit", () => {
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        commands: [
          { op: "exit" },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    expect(autorunFinding(project, "npc", 0)).toBeDefined();
  });

  test("flags an unreachable self-switch write placed after a break outside a loop", () => {
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        commands: [
          { op: "break" },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    expect(autorunFinding(project, "npc", 0)).toBeDefined();
  });

  test("flags an unreachable self-switch write inside a never-taken branch", () => {
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        commands: [{
          op: "if",
          if: { kind: "switch", id: "gate" },
          then: [{ op: "selfSwitch", key: "A", value: true }],
        }],
      },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    expect(autorunFinding(project, "npc", 0)).toBeDefined();
  });

  test("flags a page that writes its own switch OFF then back ON (it stays active)", () => {
    // Page 1's own condition is `gate is ON`; it writes gate OFF then ON, so
    // the condition holds at the end of every run and the page restarts. Page
    // 0 turns gate on once so page 1 can run; the probe still catches page 1
    // (it restarts on every frame from its first start).
    const project = makeProject([event("npc", [
      { trigger: "autorun", commands: [{ op: "switch", id: "gate", value: true }] },
      {
        trigger: "autorun",
        condition: { switch: "gate" },
        commands: [
          { op: "switch", id: "gate", value: false },
          { op: "switch", id: "gate", value: true },
        ],
      },
    ])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
    expect(autorunFinding(project, "npc", 1)).toBeDefined();
  });

  test("does not flag a one-shot that writes its condition variable via timer/read", () => {
    // The page starts a timer and reads the remaining seconds into its own
    // condition variable; the read is nonzero, so the condition turns false
    // after the first run. The old static scan did not recognise timer/read
    // as a variable write and false-positived.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [
        { op: "timer", action: "start", seconds: 5 },
        { op: "timer", action: "read", variable: "gate" },
      ],
    }])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
  });

  test("does not flag a one-shot that writes its condition variable via inputNumber", () => {
    // The number-input scene parks the fiber until the player enters digits;
    // with no input the page starts once and waits, so it does not restart.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [{ op: "inputNumber", variable: "gate", digits: 3 }],
    }])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
  });

  test("does not flag a one-shot that writes its condition variable via selectItem", () => {
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [{ op: "selectItem", variable: "gate", itemType: "regular" }],
    }])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
  });

  test("does not flag a one-shot that writes its condition variable via locationInfo", () => {
    // The event's id has a numeric suffix, so an event-kind locationInfo on
    // its own cell writes a nonzero value and the condition turns false.
    const project = makeProject([event("probe1", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [{ op: "locationInfo", variable: "gate", x: 1, y: 1, kind: "event" }],
    }])]);
    expect(autorunFinding(project, "probe1", 0)).toBeUndefined();
  });

  test("does not flag a one-shot that writes its condition variable via extChoice.write", () => {
    // The choice parks the fiber until the player picks; with no input the
    // page starts once and waits. (The probe registers a parking handler for
    // extension choices, since a choice waits for player input.)
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [{
        op: "extChoice",
        call: "game.pick",
        args: null,
        prompt: "Pick",
        write: { cancelled: "gate" },
      }],
    }])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
  });

  test("does not flag a one-shot whose self switch is set by a called common event", () => {
    // Page 1 calls a common event that sets self switch A; page 2 (condition
    // A) then takes over. The old static scan did not follow common events
    // for the autorun check and false-positived.
    const project = makeProject([event("npc", [
      { trigger: "autorun", commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "common", id: "heal" },
      ] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    project.commonEvents = [{ id: "heal", trigger: "none", commands: [{ op: "selfSwitch", key: "A", value: true }] }];
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
    // And it really is one-shot: the engine probe runs it exactly once.
    expect(runProjectFrames(project, 12)).toBe(1);
  });

  test("an exit does not stop a still-active autorun (engine probe)", () => {
    // The engine contract that motivates the doctor check: `exit` only clears
    // the current fiber; the scanner restarts a still-active autorun next
    // frame. So an autorun ending in exit runs again every frame.
    const runs = runAutorunFrames([
      { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      { op: "exit" },
    ], 8);
    expect(runs).toBe(8);
  });

  test("an autorun ending in exit still restarts every frame and is reported without a fix", () => {
    // The round-2 review's fix probe, kept as a detection test: `exit` only
    // clears the current fiber, so an autorun whose tail is exit restarts
    // every frame. The finding is produced (evidence) but carries no Fix —
    // the repair is described, not applied.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "exit" },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    expect(finding.message).not.toContain("never deactivates");
    // The engine probe agrees: it really does restart every frame.
    expect(runEventFrames(project.maps[0]!.events![0]!, 12)).toBe(12);
  });

  test("an autorun ending in a break outside a loop still restarts every frame and is reported without a fix", () => {
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "break" },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    expect(runEventFrames(project.maps[0]!.events![0]!, 12)).toBe(12);
  });

  test("an autorun with a never-taken branch still restarts every frame and is reported without a fix", () => {
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        commands: [
          { op: "variable", id: "runs", set: { op: "add", value: 1 } },
          {
            op: "if",
            if: { kind: "switch", id: "gate" },
            then: [{ op: "selfSwitch", key: "A", value: true }],
          },
        ],
      },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    expect(runEventFrames(project.maps[0]!.events![0]!, 12)).toBe(12);
  });

  // --- The round-3 review's counterexamples, as permanent tests. Each
  // confirms the finding is a truthful, bounded observation (the measured
  // frames in the probe window) with no automatic rewrite — not an absolute
  // "never deactivates" claim with a fix that could change the event's
  // semantics.

  test("a finite autorun that stops after 13 runs is reported with its observed frames, not as 'never deactivates'", () => {
    // The page runs while `gate < 13` and increments gate each run, so it
    // really does stop after 13 runs. In the 12-frame probe it restarts on
    // every frame (gate never reaches 13), so the finding fires — but the
    // finding only states those 12 observed frames. It must not claim the
    // page "never deactivates" (it does, on run 13) and must not offer a fix
    // that would delete the 12 legitimate runs.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "<=", value: 12 } },
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "variable", id: "gate", set: { op: "add", value: 1 } },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    expect(finding.message).not.toContain("never deactivates");
    expect(finding.message).toContain("from frame 0 (its first start) through frame 11");
    // It really is finite: a longer engine probe shows it stops after 13 runs.
    expect(runEventFrames(project.maps[0]!.events![0]!, 20)).toBe(13);
  });

  test("an autorun whose extension handler would make it one-shot is reported with a fallback caveat, not a fix", () => {
    // A real `ext` handler could write the page's condition variable on the
    // first run, making the page one-shot. The probe runs unknown extensions
    // as no-ops, so under the probe the page restarts every frame. The
    // finding is produced (it is a true observation of the probe) but says
    // so with a caveat and offers no fix.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { variable: { id: "gate", op: "==", value: 0 } },
      commands: [
        { op: "ext", call: "game.finish", args: null },
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    expect(finding.message).not.toContain("never deactivates");
    expect(finding.message).toContain("no-ops");
  });

  test("an autorun whose called common event has a runtime writer carries the fallback caveat", () => {
    // The round-4 review probe: the runtime-write scan only recursed the
    // page's own branches, so an autorun that calls a common event
    // containing an unknown extension was flagged as an every-frame
    // restarter without the "may not match your game" caveat. The probe
    // runs unknown extensions as no-ops; a real handler could write the
    // page's condition on the first run and make it one-shot.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "common", id: "ext" },
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      ],
    }])]);
    project.commonEvents = [{
      id: "ext",
      trigger: "none",
      commands: [{ op: "ext", call: "game.finish", args: null }],
    }];
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.message).toContain("extension command");
    expect(finding.message).toContain("no-ops");
  });

  test("the caveat names a channel the probe executed on the page's own fiber", () => {
    // The page calls an extension command (no-op in the probe) every frame
    // and restarts every frame. The probe really did run the extension, so
    // the caveat names the extension-command channel and describes the
    // no-op truthfully.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "ext", call: "game.tick", args: null },
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.message).toContain("extension command");
    expect(finding.message).toContain("no-ops");
  });

  test("the caveat omits channels the probe never reached, even when the page statically contains them", () => {
    // The round-5 review probe: all five parking/transfer channels sit in a
    // branch the probe never takes (switch "gate" is off). The old caveat
    // named every channel the page statically contained, claiming the probe
    // "follows variable-target transfers" and "parks battles" when the probe
    // never reached any of them. The caveat now names only the channels the
    // probe actually executed — here, none, so the finding has no caveat.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        {
          op: "if",
          if: { kind: "switch", id: "gate" },
          then: [
            { op: "extChoice", call: "game.pick", args: null, prompt: "Pick" },
            { op: "battle", setup: { troop: 1 } },
            { op: "scene", id: "game.journal" },
            { op: "shop", id: "mart", goods: [] },
            { op: "transfer", map: { variable: "nextMap" }, x: 1, y: 1 },
          ],
        },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.message).not.toContain("The probe may not match");
    for (const channel of ["extension choice", "battle", "scene", "shop", "variable-target transfer"]) {
      expect(finding.message).not.toContain(channel);
    }
  });

  test("a variable-target transfer in a branch the probe never takes carries no caveat", () => {
    // The review's exact probe: the page's only runtime writer is a
    // variable-target transfer in a never-taken branch, so the probe never
    // executed it (transferExecutions=0). The old caveat still claimed
    // "it follows variable-target transfers to whatever map the variable
    // names at that moment" — the opposite of the probe's actual behavior.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        {
          op: "if",
          if: { kind: "switch", id: "gate" },
          then: [{ op: "transfer", map: { variable: "nextMap" }, x: 1, y: 1 }],
        },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.message).not.toContain("variable-target transfer");
    expect(finding.message).not.toContain("The probe may not match");
  });

  test("a probe that cannot simulate a page reports the check as incomplete instead of staying silent", () => {
    // The round-5 review probe: the page calls an extension that, in the
    // real game, writes the map variable "dest" each round, then transfers
    // by it. The probe runs unknown extensions as no-ops, so "dest" stays
    // unset and the transfer fails ("map variable must hold a non-empty
    // string"), aborting the probe. The old probe silently swallowed the
    // error (partial starts, no finding), hiding a page that restarts every
    // frame under the real handler. The doctor now reports the check as
    // incomplete for this page: severity info, no fix, naming the command
    // and why the probe could not simulate it.
    const project = makeProject([event("auto", [{
      trigger: "autorun",
      commands: [
        { op: "ext", call: "game.setDest", args: null },
        { op: "transfer", map: { variable: "dest" }, x: 1, y: 1 },
      ],
    }])]);
    const findings = doctorFindings(project);
    // No autorun finding: the probe aborted before the page could restart
    // every frame.
    expect(findings.some((f) => f.check === "doctor/autorun-restarts-every-frame")).toBe(false);
    // Instead, an incomplete-check finding for this page.
    const incomplete = findings.find((f) => f.check === "doctor/autorun-probe-incomplete");
    expect(incomplete).toBeDefined();
    expect(incomplete!.severity).toBe("info");
    expect(incomplete!.fix).toBeUndefined();
    expect(incomplete!.loc).toMatchObject({ map: "town", event: "auto", page: 0 });
    // It names the command that failed and why the probe could not simulate it.
    expect(incomplete!.message).toContain("variable-target transfer");
    expect(incomplete!.message).toContain("dest");
    expect(incomplete!.message).toContain("no-ops");
  });

  test("an autorun whose first-round branch reads a switch is reported without a fix that would change that branch", () => {
    // The page's first-round `if` reads switch A. The old one-shot fix picked
    // a free self-switch key by scanning page conditions and selfSwitch
    // writes only, so it could choose A and write it at the top, changing the
    // first-round branch. With the fix cancelled, the finding is produced
    // (the page restarts every frame) but carries no rewrite, so the
    // first-round result is untouched.
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        {
          op: "if",
          if: { kind: "switch", id: "A" },
          then: [{ op: "variable", id: "branch", set: { op: "set", value: 99 } }],
        },
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
      ],
    }])]);
    const finding = autorunFinding(project, "npc", 0)!;
    expect(finding).toBeDefined();
    expect(finding.fix).toBeUndefined();
    // The first-round branch is unchanged: switch A is OFF, so `branch`
    // stays 0 (the old fix would have set A ON at the top and made it 99).
    expect(runVariable(project, "branch", 1)).toBe(0);
  });

  test("an autorun that restarts with a short wait between runs is not flagged (the check is every-frame only)", () => {
    // The page waits 0.05 s (3 frames at 60 fps) between runs, so it starts
    // on frames 0, 4, 8, … — a persistently restarting autorun, but not an
    // every-frame one. The finding only claims every-frame restarts in the
    // probe window, so this page is not flagged (and the docs say so).
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "wait", seconds: 0.05 },
      ],
    }])]);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
    // It really does restart repeatedly, just not every frame.
    expect(runEventFrames(project.maps[0]!.events![0]!, 12)).toBe(3);
  });

  test("a page that takes over mid-window is reported from its first start, not from frame 0", () => {
    // The round-4 review probe: page 0 waits 3 frames then turns its own
    // condition off; page 1 (lower priority) takes over on frame 4 and
    // restarts every frame from then on. The finding must state the measured
    // range — from frame 4 (its first start) through frame 11 — not "the
    // first 12 frames", which would contradict the measured start list.
    const project = makeProject([event("npc", [
      {
        trigger: "autorun",
        condition: { variable: { id: "gate", op: "==", value: 0 } },
        commands: [
          { op: "wait", seconds: 0.05 },
          { op: "variable", id: "gate", set: { op: "set", value: 1 } },
        ],
      },
      {
        trigger: "autorun",
        condition: { variable: { id: "gate", op: ">=", value: 1 } },
        commands: [{ op: "variable", id: "runs", set: { op: "add", value: 1 } }],
      },
    ])]);
    // Page 0 ran once and handed over; page 1 restarted on frames 4..11.
    expect(runProjectFrames(project, 12)).toBe(8);
    expect(autorunFinding(project, "npc", 0)).toBeUndefined();
    const finding = autorunFinding(project, "npc", 1)!;
    expect(finding).toBeDefined();
    expect(finding.message).toContain("from frame 4 (its first start) through frame 11");
    expect(finding.message).toContain("4, 5, 6, 7, 8, 9, 10, 11");
    expect(finding.message).not.toContain("first 12 frames");
  });

  test("the standard one-shot pattern (set self switch, later page takes over) is not flagged", () => {
    const project = makeProject([event("npc", [
      { trigger: "autorun", commands: [
        { op: "variable", id: "runs", set: { op: "add", value: 1 } },
        { op: "selfSwitch", key: "A", value: true },
      ] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ])]);
    expect(doctorFindings(project).some((f) => f.check.includes("autorun"))).toBe(false);
    // And it really does run once: the engine probe agrees with the doctor.
    expect(runEventFrames(project.maps[0]!.events![0]!, 8)).toBe(1);
  });

  test("an autorun that writes off its own condition is not flagged", () => {
    const project = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { switch: "gate" },
      commands: [{ op: "switch", id: "gate", value: false }],
    }])]);
    expect(doctorFindings(project).some((f) => f.check.includes("autorun"))).toBe(false);
  });

  test("an autorun that transfers, erases or turns its own page off is not flagged", () => {
    const transfer = makeProject([event("npc", [{
      trigger: "autorun",
      commands: [{ op: "transfer", map: "cave", x: 1, y: 1 }],
    }])]);
    expect(doctorFindings(transfer).some((f) => f.check === "doctor/autorun-restarts-every-frame")).toBe(false);
    const selfOff = makeProject([event("npc", [{
      trigger: "autorun",
      condition: { selfSwitch: "A" },
      commands: [{ op: "selfSwitch", key: "A", value: false }],
    }])]);
    expect(doctorFindings(selfOff).some((f) => f.check === "doctor/autorun-restarts-every-frame")).toBe(false);
  });

  test("a parallel page is not flagged for missing exit (it is allowed to loop)", () => {
    const project = makeProject([event("npc", [{
      trigger: "parallel",
      commands: [{ op: "text", lines: ["forever"] }],
    }])]);
    expect(doctorFindings(project).some((f) => f.check === "doctor/autorun-restarts-every-frame")).toBe(false);
  });

  test("a healthy project has no doctor findings", () => {
    const project = makeProject([event("npc", [{
      trigger: "action",
      commands: [
        { op: "text", lines: ["hi"] },
        { op: "switch", id: "met", value: true },
        { op: "transfer", map: "cave", x: 1, y: 1 },
      ],
    }])]);
    expect(doctorFindings(project)).toEqual([]);
    expect(validateProject(project)).toEqual([]);
  });
});

/** Drive a one-event project (map "town", event "probe" at the start cell)
 *  for `frames` frames and return the event's "runs" counter. */
function runEventFrames(event: GameEvent, frames: number): number {
  const project = makeProject([event]);
  project.start = { map: "town", x: 1, y: 1, dir: "down" };
  return runProjectFrames(project, frames);
}

/** Drive a project as-is (common events and all) for `frames` frames with no
 *  input and return the "runs" variable. */
function runProjectFrames(project: Project, frames: number): number {
  const session: Session = createSession(project);
  let state: SessionState = startSession(project, session);
  for (let i = 0; i < frames; i++) state = stepSession(session, state, { buttons: 0, confirmEdge: false });
  return Number(state.sw.variables["runs"] ?? 0);
}

/** Drive a project as-is for `frames` frames with no input and return the
 *  named variable's value. */
function runVariable(project: Project, name: string, frames: number): number {
  const session: Session = createSession(project);
  let state: SessionState = startSession(project, session);
  for (let i = 0; i < frames; i++) state = stepSession(session, state, { buttons: 0, confirmEdge: false });
  return Number(state.sw.variables[name] ?? 0);
}

function runAutorunFrames(commands: Command[], frames: number): number {
  return runEventFrames(event("probe", [{ trigger: "autorun", commands }]), frames);
}

/** Drive a one-event project whose page is `trigger: "action"`, pressing
 *  confirm on the first frame (the player starts on the event's cell), and
 *  return the event's "runs" counter. */
function runActionFrames(gameEvent: GameEvent, frames: number): number {
  const project = makeProject([gameEvent]);
  project.start = { map: "town", x: 1, y: 1, dir: "down" };
  const session: Session = createSession(project);
  let state: SessionState = startSession(project, session);
  for (let i = 0; i < frames; i++) {
    state = stepSession(session, state, { buttons: i === 0 ? 0x2000 : 0, confirmEdge: i === 0 });
  }
  return Number(state.sw.variables["runs"] ?? 0);
}
