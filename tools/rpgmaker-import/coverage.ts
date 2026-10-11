// tools/rpgmaker-import/coverage.ts — per-source-construct disposition
// counts, the importer's acceptance metric.
//
// Every converter branch records what it did with one source construct:
//
//   Native       represented by kit v1 commands without a gameplay loss
//                (including importer lowerings that preserve behavior)
//   Degraded     runs with a documented limitation
//   Placeholder  a deliberate visible stand-in (plugin and script commands,
//                behavior the kit has no runtime for yet)
//   Dropped      no output at all
//
// The same four buckets as the Tuxemon importer's coverage report, so the
// two numbers compare directly.

export type Disposition = "Native" | "Degraded" | "Placeholder" | "Dropped";

export const DISPOSITIONS: readonly Disposition[] = ["Native", "Degraded", "Placeholder", "Dropped"];

/** Report sections. `command` keys are event command codes as strings
 *  ("101"); the others use descriptive keys ("switch", "moveDown", "\\V"). */
export type CoverageSection =
  | "command"
  | "condition"
  | "pageCondition"
  | "trigger"
  | "route"
  | "escape"
  | "tile"
  | "audio"
  | "battle";

export interface CoverageRow {
  section: CoverageSection;
  key: string;
  counts: Record<Disposition, number>;
  /** Distinct reasons, in first-seen order (capped). */
  reasons: string[];
}

const MAX_REASONS = 6;

export class Coverage {
  private rows = new Map<string, CoverageRow>();

  record(section: CoverageSection, key: string | number, disposition: Disposition, reason?: string): void {
    const k = `${section}\u0000${key}`;
    let row = this.rows.get(k);
    if (!row) {
      row = {
        section,
        key: String(key),
        counts: { Native: 0, Degraded: 0, Placeholder: 0, Dropped: 0 },
        reasons: [],
      };
      this.rows.set(k, row);
    }
    row.counts[disposition]++;
    if (reason && disposition !== "Native" && row.reasons.length < MAX_REASONS && !row.reasons.includes(reason)) {
      row.reasons.push(reason);
    }
  }

  /** Rows sorted by section then key (numeric keys numerically). */
  list(section?: CoverageSection): CoverageRow[] {
    const out = [...this.rows.values()].filter((r) => section === undefined || r.section === section);
    out.sort((a, b) => {
      if (a.section !== b.section) return a.section < b.section ? -1 : 1;
      const na = Number(a.key);
      const nb = Number(b.key);
      if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return out;
  }

  totals(section: CoverageSection): Record<Disposition, number> & { total: number } {
    const t = { Native: 0, Degraded: 0, Placeholder: 0, Dropped: 0, total: 0 };
    for (const r of this.list(section)) {
      for (const d of DISPOSITIONS) {
        t[d] += r.counts[d];
        t.total += r.counts[d];
      }
    }
    return t;
  }

  /** Merge another recorder's counts into this one (multi-project tables). */
  merge(other: Coverage): void {
    for (const r of other.list()) {
      for (const d of DISPOSITIONS) {
        for (let i = 0; i < r.counts[d]; i++) this.record(r.section, r.key, d, r.reasons[i]);
      }
    }
  }

  toJSON(): CoverageRow[] {
    return this.list();
  }
}
