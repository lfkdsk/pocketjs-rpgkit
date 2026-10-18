// tools/rpgmaker-import/report.ts — the coverage report (Markdown + JSON).
//
// Two views of the same converter:
//
// - "This project": how many uses of each construct the imported project
//   had, split by disposition (Native / Degraded / Placeholder / Dropped),
//   the Tuxemon importer's coverage table format.
// - "Every MV/MZ command": the importer's handling of each event command
//   code, measured by converting a minimal sample of that command
//   (catalog.ts sampleCommands) with a scratch recorder. This is the
//   "what would importing an RPG Maker game need" checklist; `needsKit`
//   names the kit capability a native mapping would take.

import { Coverage, DISPOSITIONS, type CoverageSection, type Disposition } from "./coverage.ts";
import type { AudioMediaRecord } from "./audio-media.ts";
import { convertRpgMakerTroopEffects } from "./battle-data.ts";
import { RM_COMMANDS, sampleCommands } from "./catalog.ts";
import { convertCommands, type EventContext } from "./events.ts";
import type { RmProject } from "./rm-types.ts";
import type { Project } from "../../src/engine/types.ts";

const SECTION_TITLES: Record<CoverageSection, string> = {
  command: "Event commands",
  script: "Safe Script shapes",
  condition: "Conditional Branch types",
  pageCondition: "Event page conditions",
  trigger: "Event triggers",
  route: "Movement route commands",
  escape: "Message escape codes",
  tile: "Tiles and map attributes",
  audio: "Audio media",
  battle: "Battle database and formulas",
};

const SECTION_ORDER: CoverageSection[] = ["command", "script", "condition", "pageCondition", "trigger", "route", "escape", "tile", "audio", "battle"];

export interface StaticCommandRow {
  code: number;
  name: string;
  flavor: string;
  disposition: Disposition | "—";
  reason: string;
  needsKit: string;
}

/** A scratch project + context the samples convert against. */
function sampleContext(cov: Coverage): EventContext {
  const rm: RmProject = {
    root: "",
    flavor: "MZ",
    system: {
      gameTitle: "sample",
      currencyUnit: "G",
      partyMembers: [1],
      startMapId: 1,
      startX: 0,
      startY: 0,
      switches: [],
      variables: [],
    },
    mapInfos: [null, { id: 1, name: "Map", order: 1, parentId: 0 }, { id: 2, name: "Map2", order: 2, parentId: 0 }],
    maps: new Map(),
    tilesets: [null, { id: 1, name: "Sample", mode: 0, tilesetNames: [], flags: [], note: "" }],
    commonEvents: [null, { id: 1, name: "Common", trigger: 0, switchId: 1, list: [{ code: 0, indent: 0, parameters: [] }] }],
    items: [null, { id: 1, name: "Potion", description: "", iconIndex: 0, price: 10, note: "" }],
    weapons: [null, { id: 1, name: "Sword", description: "", iconIndex: 0, price: 10, note: "" }],
    armors: [null, { id: 1, name: "Shield", description: "", iconIndex: 0, price: 10, note: "" }],
    actors: [null, {
      id: 1, name: "Hero", nickname: "", characterName: "", characterIndex: 0,
      faceName: "", faceIndex: 0, classId: 1, initialLevel: 1, equips: [1, 1], traits: [], note: "",
    }],
    classes: [null, { id: 1, name: "Hero", learnings: [{ level: 1, skillId: 1 }], traits: [], note: "" }],
    skills: [null, { id: 1, name: "Attack", note: "" }],
    states: [null, { id: 1, name: "Knockout", note: "" }],
    enemies: [null],
    troops: [null, { id: 1, name: "Slime", members: [], pages: [] }],
    animations: [null],
  };
  let shop = 0;
  let animation = 0;
  return {
    rm,
    battleDatabaseHash: "0".repeat(64),
    cov,
    placeholders: "visible",
    maps: new Map([[1, "map001"], [2, "map002"]]),
    owner: { kind: "page", mapId: "map001", eventId: "ev001", page: 0, trigger: "action", eventIds: new Map([[1, "ev001"]]) },
    sprite: (image) => image.characterName || image.tileId > 0
      ? `sample-sprite-${image.characterIndex}`
      : null,
    picture: (name) => name.toLowerCase(),
    parallax: (name) => name ? { image: name.toLowerCase(), zero: name.startsWith("!") } : null,
    animation: (n) => ({ id: `anim${n}`, disposition: "Native" }),
    animationFailure: () => "animation unavailable during static catalog reporting",
    balloon: (n) => `balloon${n}`,
    audio: (kind, name) => `${kind}-${name.toLowerCase()}`,
    nextShopId: () => `sample-shop${shop++}`,
    nextAnimationId: () => `sample-animation${animation++}`,
  };
}

/** The importer's handling of every MV/MZ command code. */
export function staticCommandTable(): StaticCommandRow[] {
  const rows: StaticCommandRow[] = [];
  const troopOnly = new Set([331, 332, 333, 334, 335, 336, 337, 339, 340, 342]);
  for (const info of RM_COMMANDS) {
    if (info.continuation) continue;
    const samples = sampleCommands(info.code);
    let disposition: Disposition | "—" = "—";
    let reason = "";
    if (samples.length > 0) {
      const cov = new Coverage();
      if (troopOnly.has(info.code)) convertRpgMakerTroopEffects(samples, cov, (id) => `anim${id}`);
      else convertCommands(samples, sampleContext(cov));
      const row = cov.list("command").find((r) => r.key === String(info.code));
      if (row) {
        // The disposition the sample recorded most often for its own code.
        let best = 0;
        for (const d of DISPOSITIONS) {
          if (row.counts[d] > best) {
            best = row.counts[d];
            disposition = d;
          }
        }
        reason = row.reasons.join("; ");
      }
    }
    rows.push({ code: info.code, name: info.name, flavor: info.flavor, disposition, reason, needsKit: info.needsKit ?? "" });
  }
  return rows;
}

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface RpgMakerCapabilityRequirement {
  capability: "rpgMakerText" | "screenPresentation";
  requiredBy: string[];
  registration: string;
}

const SCREEN_RUNTIME_CODES = new Set([223, 236]);
const SCREEN_PRESENTATION_CODES = new Set([124, 223, 231, 232, 233, 234, 235, 236, 281]);

function commandRequirementEvidence(cov: Coverage, codes: ReadonlySet<number>): string[] {
  const names = new Map(RM_COMMANDS.map((command) => [command.code, command.name]));
  return cov.list("command").flatMap((row) => {
    const code = Number(row.key);
    if (!codes.has(code)) return [];
    const uses = DISPOSITIONS.reduce((sum, disposition) => sum + row.counts[disposition], 0);
    return uses > 0 ? [`${code} ${names.get(code) ?? "command"} (${uses})`] : [];
  });
}

/** Code-side registrations an imported document cannot carry in JSON. The
 * coverage report surfaces them so a generated native command can never be
 * mistaken for a complete, silently-degraded application integration. */
export function rpgMakerCapabilityRequirements(
  cov: Coverage,
  project?: Pick<Project, "system">,
): RpgMakerCapabilityRequirement[] {
  const runtime = commandRequirementEvidence(cov, SCREEN_RUNTIME_CODES);
  const presentation = commandRequirementEvidence(cov, SCREEN_PRESENTATION_CODES);
  if (project?.system?.rpgMakerText) runtime.unshift("system.rpgMakerText");
  if (project?.system?.mapNameDisplay === true) presentation.unshift("system.mapNameDisplay");
  const rows: RpgMakerCapabilityRequirement[] = [];
  if (runtime.length > 0) {
    rows.push({
      capability: "rpgMakerText",
      requiredBy: [...new Set(runtime)],
      registration: "createSession/GameView rpgMakerText",
    });
  }
  if (presentation.length > 0) {
    rows.push({
      capability: "screenPresentation",
      requiredBy: [...new Set(presentation)],
      registration: "GameView screenPresentation (for example krm2ScreenPresentation)",
    });
  }
  return rows;
}

function pct(n: number, total: number): string {
  return total === 0 ? "—" : `${((100 * n) / total).toFixed(1)}%`;
}

export function coverageMarkdown(
  title: string,
  cov: Coverage,
  opts: {
    staticTable?: boolean;
    audioMedia?: readonly AudioMediaRecord[];
    project?: Pick<Project, "system">;
  } = {},
): string {
  const out: string[] = [];
  out.push(`# ${title}`, "");
  out.push(
    "Generated by `bun tools/rpgmaker-import`. Each row counts the uses of one",
    "source construct and what the importer did with them:",
    "",
    "- **Native**: represented by kit v1 commands without a gameplay loss",
    "  (importer lowerings that keep the behavior count here).",
    "- **Degraded**: runs with a documented limitation (the reason column).",
    "- **Placeholder**: a deliberate visible stand-in (plugin and script",
    "  commands).",
    "- **Dropped**: no output.",
    "",
    "## Summary",
    "",
    "| Section | Uses | Native | Degraded | Placeholder | Dropped | Native % |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const section of SECTION_ORDER) {
    const t = cov.totals(section);
    if (t.total === 0) continue;
    out.push(`| ${SECTION_TITLES[section]} | ${t.total} | ${t.Native} | ${t.Degraded} | ${t.Placeholder} | ${t.Dropped} | ${pct(t.Native, t.total)} |`);
  }
  out.push("");
  const capabilities = rpgMakerCapabilityRequirements(cov, opts.project);
  out.push(
    "## Required application capabilities",
    "",
    "Project JSON records data, not code-side registrations. Missing a required",
    "reducer runtime fails every session during loading. `GameView` also declares",
    "whether screen presentation is registered and rejects a missing one instead of",
    "waiting on an invisible effect. A deliberately headless `createSession` caller",
    "may omit that presentation policy while it inspects reducer state only.",
    "",
  );
  if (capabilities.length === 0) {
    out.push("This import uses no optional RPG Maker screen capability.", "");
  } else {
    out.push(
      "| Capability | Required by this import | Register in |",
      "|---|---|---|",
    );
    for (const requirement of capabilities) {
      out.push(
        `| \`${requirement.capability}\` | ${esc(requirement.requiredBy.join(", "))} | ${esc(requirement.registration)} |`,
      );
    }
    out.push("");
  }
  const names = new Map(RM_COMMANDS.map((c) => [String(c.code), c.name]));
  for (const section of SECTION_ORDER) {
    const rows = cov.list(section);
    if (rows.length === 0) continue;
    out.push(`## ${SECTION_TITLES[section]}`, "");
    out.push("| Construct | Native | Degraded | Placeholder | Dropped | Total | Notes |", "|---|---:|---:|---:|---:|---:|---|");
    for (const r of rows) {
      const label = section === "command" ? `${r.key} ${names.get(r.key) ?? "(unknown code)"}` : `\`${r.key}\``;
      const total = DISPOSITIONS.reduce((s, d) => s + r.counts[d], 0);
      out.push(`| ${esc(label)} | ${r.counts.Native} | ${r.counts.Degraded} | ${r.counts.Placeholder} | ${r.counts.Dropped} | ${total} | ${esc(r.reasons.join("; "))} |`);
    }
    out.push("");
  }
  if (opts.audioMedia && opts.audioMedia.length > 0) {
    const success = opts.audioMedia.filter((record) => record.status === "success");
    const sourceBytes = success.reduce((sum, record) => sum + record.sourceBytes, 0);
    const outputBytes = success.reduce((sum, record) => sum + record.outputBytes, 0);
    const duration = success.reduce((sum, record) =>
      sum + (record.status === "success" ? record.frames / record.sampleRate : 0), 0);
    out.push(
      "## Imported audio statistics",
      "",
      `Converted ${success.length}/${opts.audioMedia.length} referenced media; ` +
        `${sourceBytes} compressed source bytes became ${outputBytes} QOA bytes; ` +
        `${duration.toFixed(3)} s decoded duration at pitch 100.`,
      "",
      "| Medium | Status | Source bytes | QOA bytes | PCM | Duration | Notes |",
      "|---|---|---:|---:|---|---:|---|",
    );
    for (const record of opts.audioMedia) {
      if (record.status === "success") {
        out.push(
          `| \`${esc(record.key)}\` | Native | ${record.sourceBytes} | ${record.outputBytes} | ` +
          `${record.channels}ch ${record.sampleRate} Hz, ${record.frames} frames | ` +
          `${(record.frames / record.sampleRate).toFixed(3)} s | ${record.sourceFormat.toUpperCase()} |`,
        );
      } else {
        out.push(
          `| \`${esc(record.key)}\` | Dropped | ${record.sourceBytes} | 0 | — | — | ${esc(record.reason)} |`,
        );
      }
    }
    out.push("");
  }
  if (opts.staticTable) {
    out.push(...staticTableMarkdown());
  }
  return out.join("\n") + "\n";
}

export function staticTableMarkdown(): string[] {
  return [
    "## Every MV/MZ event command",
    "",
    "How the importer handles a minimal use of each command code (continuation",
    "lines and branch markers are folded into their command). \"Needs kit\"",
    "names the runtime capability a native mapping would take.",
    "",
    ...commandTableLines(),
    "",
  ];
}

/** The command table alone (docs/rpgmaker-import.md embeds it verbatim). */
export function commandTableLines(): string[] {
  const out = ["| Code | Command | Flavor | Handling | Notes | Needs kit |", "|---:|---|---|---|---|---|"];
  for (const r of staticCommandTable()) {
    // A dropped command's reason is usually "needs <needsKit>"; say it once.
    const notes = r.reason === `needs ${r.needsKit}` ? "" : r.reason;
    out.push(`| ${r.code} | ${esc(r.name)} | ${r.flavor} | ${r.disposition} | ${esc(notes)} | ${esc(r.needsKit)} |`);
  }
  return out;
}
