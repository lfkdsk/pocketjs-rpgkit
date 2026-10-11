// tools/rpgmaker-import/text.ts — preserve RPG Maker MV/MZ message
// escapes for the kit's runtime parser and account for their coverage.
//
// Message escape expansion depends on live variables, actor names, party
// order and the current currency word. Baking those values at import time is
// observably wrong, while deleting presentation codes loses source data. The
// importer therefore returns every line byte-for-byte and only scans it for
// coverage. `system.rpgMakerText` makes the runtime interpret the supported
// grammar when the box opens.

import type { Coverage, Disposition } from "./coverage.ts";
import type { RmProject } from "./rm-types.ts";

export interface TextContext {
  rm: RmProject;
  cov: Coverage;
}

const DEGRADE_REASONS: Record<string, string> = {
  P: "runtime party names use the imported initial party order",
  I: "inline icons are preserved but not interpreted at runtime",
  "{": "font size changes are preserved but not interpreted at runtime",
  "}": "font size changes are preserved but not interpreted at runtime",
  FS: "MZ font size changes are preserved but omitted at runtime",
  PX: "MZ text position changes are preserved but omitted at runtime",
  PY: "MZ text position changes are preserved but omitted at runtime",
  $: "gold-window control is preserved but not interpreted at runtime",
  ".": "message timing controls are preserved but not interpreted at runtime",
  "|": "message timing controls are preserved but not interpreted at runtime",
  "!": "message timing controls are preserved but not interpreted at runtime",
  ">": "message timing controls are preserved but not interpreted at runtime",
  "<": "message timing controls are preserved but not interpreted at runtime",
  "^": "message timing controls are preserved but not interpreted at runtime",
};

/** Return message lines exactly as authored. Every recognized occurrence is
 * still recorded in the escape coverage section. */
export function convertMessage(lines: string[], ctx: TextContext): string[] {
  return lines.map((line) => {
    const text = String(line ?? "");
    scanLine(text, ctx);
    return text;
  });
}

function scanLine(text: string, ctx: TextContext): void {
  let i = 0;
  const rec = (code: string, disposition: Disposition, reason?: string): void =>
    ctx.cov.record("escape", `\\${code}`, disposition, reason);
  while (i < text.length) {
    if (text[i] !== "\\") {
      i++;
      continue;
    }
    const rest = text.slice(i + 1);
    if (rest.startsWith("\\")) {
      rec("\\", "Native");
      i += 2;
      continue;
    }

    // These parameter escapes are parsed live by src/engine/rpgmaker-text.
    // MZ's layout codes are deliberately retained too; the runtime reports
    // and omits their presentation effect instead of exposing or losing the
    // source spelling.
    const parameter = /^(V|N|P|C|PX|PY|FS)\[([0-9]+)\]/i.exec(rest);
    if (parameter) {
      const code = parameter[1]!.toUpperCase();
      const disposition: Disposition = code === "P" || code === "PX" || code === "PY" || code === "FS"
        ? "Degraded"
        : "Native";
      rec(code, disposition, DEGRADE_REASONS[code]);
      i += 1 + parameter[0].length;
      continue;
    }

    // As in RPG Maker and the kit parser, `\Gold` is `\G` followed by
    // "old", not an unknown word escape.
    if (rest[0]?.toUpperCase() === "G") {
      rec("G", "Native");
      i += 2;
      continue;
    }

    const symbol = /^[$.|^!><{}]/.exec(rest);
    if (symbol) {
      rec(symbol[0], "Degraded", DEGRADE_REASONS[symbol[0]]);
      i += 2;
      continue;
    }

    // Preserve unsupported built-in/plugin codes visibly. Consume an
    // optional numeric parameter only for scanning; the returned line is
    // never reconstructed or changed.
    const word = /^[A-Za-z]+/.exec(rest);
    if (!word) {
      i++;
      continue;
    }
    const code = word[0].toUpperCase();
    const parameterSuffix = /^\[[0-9]+\]/.exec(rest.slice(word[0].length));
    rec(code, "Degraded", DEGRADE_REASONS[code] ?? "plugin or unknown escape is preserved but not interpreted at runtime");
    i += 1 + word[0].length + (parameterSuffix?.[0].length ?? 0);
  }
}
