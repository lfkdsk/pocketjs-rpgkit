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
import { RM_COMMANDS, sampleCommands } from "./catalog.ts";
import { convertCommands, type EventContext } from "./events.ts";
import type { RmProject } from "./rm-types.ts";

const SECTION_TITLES: Record<CoverageSection, string> = {
  command: "Event commands",
  condition: "Conditional Branch types",
  pageCondition: "Event page conditions",
  trigger: "Event triggers",
  route: "Movement route commands",
  escape: "Message escape codes",
  tile: "Tiles and map attributes",
  audio: "Audio media",
};

const SECTION_ORDER: CoverageSection[] = ["command", "condition", "pageCondition", "trigger", "route", "escape", "tile", "audio"];

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
    tilesets: [null],
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
    troops: [null, { id: 1, name: "Slime", members: [], pages: [] }],
    animations: [null],
  };
  let shop = 0;
  let animation = 0;
  return {
    rm,
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
  for (const info of RM_COMMANDS) {
    if (info.continuation) continue;
    const samples = sampleCommands(info.code);
    let disposition: Disposition | "—" = "—";
    let reason = "";
    if (samples.length > 0) {
      const cov = new Coverage();
      convertCommands(samples, sampleContext(cov));
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

function pct(n: number, total: number): string {
  return total === 0 ? "—" : `${((100 * n) / total).toFixed(1)}%`;
}

export function coverageMarkdown(
  title: string,
  cov: Coverage,
  opts: { staticTable?: boolean; audioMedia?: readonly AudioMediaRecord[] } = {},
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
    "  commands, battles).",
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
