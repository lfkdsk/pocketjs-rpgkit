/// <reference lib="dom" />
// Global, keyboard-first command palette. The catalog is supplied by main.ts
// so this component remains independent of files, the edit protocol and the
// desktop host.

import type { StudioApp } from "./app.ts";
import { emptyState, h, icon, replace } from "./dom.ts";

export type CommandSection = "Actions" | "Maps" | "Common events" | "Events" | "Commands";

export interface StudioCommand {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  shortcut?: string;
  section: CommandSection;
  disabled?: string;
  run(): void;
}

export interface RankedCommand {
  command: StudioCommand;
  score: number;
  recent: number;
}

const SECTIONS: readonly CommandSection[] = ["Actions", "Maps", "Common events", "Events", "Commands"];

/** A compact fuzzy score: word/exact matches lead, then ordered characters
 * with penalties for gaps and late starts. `null` means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  if (haystack === needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    const boundary = direct === 0 || /[^a-z0-9]/.test(haystack[direct - 1]!);
    return 2 + direct + (boundary ? 0 : 8);
  }
  let at = 0;
  let score = 20;
  let previous = -1;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return null;
    score += found === previous + 1 ? 0 : Math.min(12, found - previous - 1);
    if (found === 0 || /[^a-z0-9]/.test(haystack[found - 1]!)) score -= 2;
    previous = found;
    at = found + 1;
  }
  return Math.max(1, score + Math.floor((haystack.length - needle.length) / 24));
}

export function rankCommands(commands: readonly StudioCommand[], query: string, recentIds: readonly string[]): RankedCommand[] {
  const recent = new Map(recentIds.map((id, index) => [id, index]));
  return commands.flatMap((command): RankedCommand[] => {
    const text = `${command.label} ${command.id} ${command.detail ?? ""} ${command.keywords ?? ""} ${command.section}`;
    const score = fuzzyScore(query, text);
    return score === null ? [] : [{ command, score, recent: recent.get(command.id) ?? Number.MAX_SAFE_INTEGER }];
  }).sort((a, b) => a.score - b.score || a.recent - b.recent || a.command.label.localeCompare(b.command.label));
}

export class CommandPalette {
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private active = 0;
  private visible: RankedCommand[] = [];
  private returnFocus: HTMLElement | null = null;

  constructor(private app: StudioApp, private catalog: () => StudioCommand[]) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(query = ""): void {
    if (this.overlay) {
      this.input?.focus();
      this.input?.select();
      return;
    }
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = h("input", {
      type: "search",
      class: "command-palette-input",
      placeholder: "Search actions, maps, events and commands…",
      autocomplete: "off",
      spellcheck: "false",
      role: "combobox",
      "aria-label": "Command palette search",
      "aria-expanded": "true",
      "aria-controls": "studio-command-results",
      oninput: () => { this.active = 0; this.render(); },
      onkeydown: (event: KeyboardEvent) => this.keydown(event),
    });
    input.value = query;
    const list = h("div", { class: "command-palette-results", id: "studio-command-results", role: "listbox", "aria-label": "Studio commands" });
    const panel = h("section", { class: "command-palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette", "data-testid": "command-palette" },
      h("header", { class: "command-palette-head" }, icon("search"), input, h("kbd", null, "Esc")),
      list,
      h("footer", { class: "command-palette-foot" },
        h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), " navigate"),
        h("span", null, h("kbd", null, "Enter"), " run")),
    );
    const overlay = h("div", {
      class: "command-palette-backdrop",
      onpointerdown: (event: PointerEvent) => { if (event.target === overlay) this.close(); },
    }, panel);
    this.overlay = overlay;
    this.input = input;
    this.list = list;
    document.body.appendChild(overlay);
    this.render();
    input.focus();
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.input = null;
    this.list = null;
    const focus = this.returnFocus;
    this.returnFocus = null;
    if (focus?.isConnected) focus.focus();
  }

  private setActive(index: number, reveal: boolean): void {
    const input = this.input;
    const list = this.list;
    if (!input || !list || index === this.active || index < 0 || index >= this.visible.length) return;
    const previous = list.querySelector<HTMLElement>(`#studio-command-${this.active}`);
    previous?.classList.remove("active");
    previous?.setAttribute("aria-selected", "false");
    this.active = index;
    input.setAttribute("aria-activedescendant", `studio-command-${index}`);
    const current = list.querySelector<HTMLElement>(`#studio-command-${index}`);
    current?.classList.add("active");
    current?.setAttribute("aria-selected", "true");
    if (reveal) current?.scrollIntoView({ block: "nearest" });
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (this.visible.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.setActive((this.active + delta + this.visible.length) % this.visible.length, true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = this.visible[this.active]?.command;
      if (item && !item.disabled) this.run(item);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  private run(command: StudioCommand): void {
    if (command.disabled) return;
    this.app.rememberCommand(command.id);
    this.close();
    command.run();
  }

  private render(): void {
    const input = this.input;
    const list = this.list;
    if (!input || !list) return;
    const ranked = rankCommands(this.catalog(), input.value, this.app.recentCommands).slice(0, 80);
    if (ranked.length === 0) {
      this.visible = [];
      input.setAttribute("aria-activedescendant", "");
      replace(list, emptyState("search", "No matching command", "Try a map id, event name, tool or command type."));
      return;
    }

    const recentIds = new Set(this.app.recentCommands);
    const groups: { label: string; items: RankedCommand[] }[] = [];
    const recent = ranked.filter((item) => recentIds.has(item.command.id));
    if (recent.length) groups.push({ label: "Recent", items: recent });
    for (const section of SECTIONS) {
      const items = ranked.filter((item) => item.command.section === section && !recentIds.has(item.command.id));
      if (items.length) groups.push({ label: section, items });
    }
    this.visible = groups.flatMap((group) => group.items);
    this.active = Math.max(0, Math.min(this.active, this.visible.length - 1));
    input.setAttribute("aria-activedescendant", `studio-command-${this.active}`);
    replace(list, groups.map((group) => h("section", { class: "command-palette-group" },
      h("h3", null, group.label),
      group.items.map((item) => {
        const index = this.visible.indexOf(item);
        const command = item.command;
        return h("button", {
          type: "button",
          id: `studio-command-${index}`,
          class: `command-palette-row${index === this.active ? " active" : ""}`,
          role: "option",
          "aria-selected": String(index === this.active),
          disabled: !!command.disabled,
          title: command.disabled,
          dataset: { commandId: command.id },
          onpointermove: () => this.setActive(index, false),
          onclick: () => this.run(command),
        },
        h("span", { class: "command-palette-mark" }, icon(command.section === "Maps" ? "map" : command.section === "Events" ? "event" : command.section === "Commands" ? "plus" : "search")),
        h("span", { class: "command-palette-copy" }, h("strong", null, command.label), command.detail ? h("small", null, command.detail) : null),
        command.shortcut ? h("kbd", null, command.shortcut) : command.disabled ? h("span", { class: "muted" }, "unavailable") : null);
      }),
    )));
    list.querySelector<HTMLElement>(`#studio-command-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }
}
