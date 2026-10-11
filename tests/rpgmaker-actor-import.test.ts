import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";
import type { RmCommand, RmProject, RmTrait } from "../tools/rpgmaker-import/rm-types.ts";

const HOLLOW = join(import.meta.dir, "fixtures/rpgmaker/hollow-mz");

const trait = (code: number, dataId: number): RmTrait => ({ code, dataId, value: 0 });

function branch(actor: number, subtype: number, value: string | number): RmCommand[] {
  return [
    { code: 111, indent: 0, parameters: [4, actor, subtype, value] },
    { code: 121, indent: 1, parameters: [20, 20, 0] },
    { code: 0, indent: 1, parameters: [] },
    { code: 412, indent: 0, parameters: [] },
  ];
}

describe("rpgmaker-import: initial actor equipment", () => {
  test("equipment-granted dual wield changes validation slots but not raw-id decoding", async () => {
    const rm = loadRmProject(HOLLOW);
    const body = rm.armors[1]!;
    const mutated: RmProject = {
      ...rm,
      skills: [
        ...rm.skills,
        { id: 2, name: "Weapon art", note: "" },
        { id: 3, name: "Shield art", note: "" },
        { id: 4, name: "Armor art", note: "" },
      ],
      weapons: rm.weapons.map((item) => item?.id === 1
        ? { ...item, traits: [...(item.traits ?? []), trait(55, 1), trait(43, 2)] }
        : item),
      armors: [
        null,
        { ...body, etypeId: 2, traits: [trait(43, 3)] },
        { ...body, id: 2, name: "Second coat", etypeId: 4, traits: [trait(43, 4)] },
      ],
      actors: rm.actors.map((actor) => actor?.id === 1
        ? { ...actor, equips: [1, 1, 0, 2, 0], traits: [...actor.traits, trait(53, 4)] }
        : actor),
    };

    const imported = await importRmProject(mutated);
    const actor = imported.project.actors?.find((entry) => entry.databaseId === 1);
    expect(actor).toMatchObject({
      weapons: ["weapon001"],
      armors: ["armor002"],
      skills: ["skill001", "skill002", "skill004"],
    });
    // Slot 1 was initially decoded as armor. The equipped weapon then grants
    // dual wield, so validation changes slot 1 to a weapon slot and releases
    // the shield. Its skill trait must disappear with it. Trait 53 does not
    // invalidate the locked body slot.
    expect(actor?.armors).not.toContain("armor001");
    expect(actor?.skills).not.toContain("skill003");
  });

  test("release passes recompute permission and seal traits after each removal", async () => {
    const rm = loadRmProject(HOLLOW);
    const armor = rm.armors[1]!;
    const mutated: RmProject = {
      ...rm,
      skills: [
        ...rm.skills,
        { id: 2, name: "Weapon art", note: "" },
        { id: 3, name: "Head art", note: "" },
        { id: 4, name: "Charm art", note: "" },
        { id: 5, name: "Provider art", note: "" },
        { id: 6, name: "Out-of-range art", note: "" },
      ],
      classes: rm.classes.map((entry) => entry?.id === 1
        ? { ...entry, traits: [trait(51, 1), trait(52, 1), trait(53, 5)] }
        : entry),
      weapons: rm.weapons.map((item) => item?.id === 1
        ? { ...item, wtypeId: 1, etypeId: 1, traits: [trait(43, 2)] }
        : item),
      armors: [
        null,
        { ...armor, id: 1, name: "Type-two helm", etypeId: 3, atypeId: 2, traits: [trait(43, 3)] },
        {
          ...armor,
          id: 2,
          name: "Mis-slotted provider",
          etypeId: 5,
          atypeId: 2,
          traits: [trait(52, 2), trait(54, 1), trait(43, 5)],
        },
        { ...armor, id: 3, name: "Locked charm", etypeId: 5, atypeId: 1, traits: [trait(43, 4)] },
        { ...armor, id: 4, name: "Extra-slot relic", etypeId: 5, atypeId: 1, traits: [trait(43, 6)] },
      ],
      actors: rm.actors.map((actor) => actor?.id === 1
        ? { ...actor, equips: [1, 0, 1, 2, 3, 4] }
        : actor),
    };

    const imported = await importRmProject(mutated);
    const actor = imported.project.actors?.find((entry) => entry.databaseId === 1);
    expect(actor?.weapons).toBeUndefined();
    expect(actor?.armors).toEqual(["armor003"]);
    expect(actor?.skills).toEqual(["skill001", "skill004"]);
    // System.equipTypes defines exactly five slots; a sixth raw id is not
    // initialized and therefore cannot leak its trait-added skill.
    expect(actor?.skills).not.toContain("skill006");
  });

  test("actor fact predicates execute with initial-only coverage and empty-name rows degrade explicitly", async () => {
    const rm = loadRmProject(HOLLOW);
    const emptyActor = {
      ...rm.actors[1]!,
      id: 3,
      name: "",
      characterName: "",
      equips: [0, 0, 0, 0, 0],
    };
    const mutated: RmProject = {
      ...rm,
      actors: [...rm.actors, emptyActor],
      commonEvents: [
        ...rm.commonEvents,
        {
          id: 99,
          name: "Actor fact coverage",
          trigger: 0,
          switchId: 0,
          list: [
            ...branch(1, 2, 1),
            ...branch(3, 2, 1),
            { code: 0, indent: 0, parameters: [] },
          ],
        },
      ],
    };

    const imported = await importRmProject(mutated);
    const json = JSON.stringify(imported.project.commonEvents);
    expect(json).toContain('"actor":"actor001","test":"class","value":"class001"');
    expect(json).not.toContain('"actor":"actor003"');
    expect(imported.project.actors?.some((actor) => actor.databaseId === 3)).toBe(false);
    const coverage = imported.cov.list("condition").find((row) => row.key === "actor")!;
    expect(coverage.counts.Degraded).toBe(2);
    expect(coverage.reasons).toContain(
      "actor class, skill, equipment, and state conditions read initial actor facts only",
    );
    expect(coverage.reasons).toContain(
      "actor 3 has an empty name and cannot be represented; treated as false",
    );
  });
});
