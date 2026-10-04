/// <reference lib="dom" />
// Delayed, non-interactive summary for the event under the map pointer.

import type { GameEvent } from "../../src/engine/types.ts";
import { flattenCommands } from "../engine/commands.ts";
import type { StudioApp } from "./app.ts";
import type { ArtRegistry } from "./art.ts";
import type { MapCanvas } from "./canvas.ts";
import { h, icon, replace } from "./dom.ts";

export interface HoverCardPlacement {
  x: number;
  /** The side of the event the card opens on, chosen by the roomier-side
   *  rule (before clamping). The card stamps this on its root as
   *  `data-side` for inspection and debugging; the verification does not
   *  trust it — it measures the card's actual rect against the anchor. */
  side: "left" | "right";
  /** True when the ideal x had to be clamped toward a host edge. */
  clamped: boolean;
}

export function hoverCardPlacement(hostWidth: number, eventCenter: number, eventHalfWidth: number, cardWidth: number): HoverCardPlacement {
  const inset = 8;
  const gap = 12;
  const right = eventCenter + eventHalfWidth + gap;
  const left = eventCenter - eventHalfWidth - gap - cardWidth;
  const rightRoom = hostWidth - inset - right;
  const leftRoom = left + cardWidth - inset;
  const chooseRight = rightRoom >= leftRoom;
  const ideal = chooseRight ? right : left;
  const maxX = Math.max(inset, hostWidth - cardWidth - inset);
  const x = Math.max(inset, Math.min(maxX, ideal));
  return { x, side: chooseRight ? "right" : "left", clamped: x !== ideal };
}

export function hoverCardX(hostWidth: number, eventCenter: number, eventHalfWidth: number, cardWidth: number): number {
  return hoverCardPlacement(hostWidth, eventCenter, eventHalfWidth, cardWidth).x;
}

export class EventHoverCard {
  readonly root: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private eventId = "";

  constructor(root: HTMLElement, private app: StudioApp, private canvas: MapCanvas, private art: ArtRegistry) {
    this.root = root;
    this.root.classList.add("event-hover-card");
    this.root.setAttribute("role", "tooltip");
    this.root.hidden = true;
    app.on((reason) => this.changed(reason));
    art.onChange(() => { if (!this.root.hidden) this.showNow(); });
  }

  private eventUnderPointer(): GameEvent | undefined {
    const map = this.app.currentMap();
    const hover = this.app.hover;
    if (!map || !hover || !this.app.visible.events || (this.app.tool !== "select" && this.app.tool !== "event")) return undefined;
    const events = map.events ?? [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (hover.x >= event.x && hover.y >= event.y && hover.x < event.x + (event.w ?? 1) && hover.y < event.y + (event.h ?? 1)) return event;
    }
    return undefined;
  }

  private changed(reason: string): void {
    if (reason !== "hover") {
      if (reason === "view" || reason === "selection" || reason === "map" || reason === "load" || reason === "edit" || reason === "history" || reason === "tool") this.hide();
      return;
    }
    const event = this.eventUnderPointer();
    if (!event) {
      this.hide();
      return;
    }
    if (!this.root.hidden && this.eventId === event.id) {
      this.position(event);
      return;
    }
    this.hide();
    this.eventId = event.id;
    this.timer = setTimeout(() => this.showNow(), 320);
  }

  private hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.eventId = "";
    this.root.hidden = true;
    this.root.textContent = "";
  }

  private showNow(): void {
    this.timer = null;
    const event = this.eventUnderPointer();
    if (!event || event.id !== this.eventId) return;
    const page = event.pages[0];
    const rows = page ? flattenCommands(page.commands).slice(0, 3) : [];
    const spriteId = page?.sprite;
    const preview = h("div", { class: "event-hover-sprite", "aria-hidden": "true" });
    if (spriteId) {
      const frame = this.art.spriteFrame(spriteId, this.app.session?.sprites()[spriteId]);
      if (frame) {
        const image = h("canvas", { width: 40, height: 44 });
        const ctx = image.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        const scale = Math.min(36 / frame.sw, 40 / frame.sh, 2);
        const width = Math.max(1, Math.round(frame.sw * scale));
        const height = Math.max(1, Math.round(frame.sh * scale));
        ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, Math.round((40 - width) / 2), 44 - height, width, height);
        preview.appendChild(image);
      } else {
        preview.append(icon("event"), h("small", null, spriteId));
      }
    } else {
      preview.append(icon("event"));
    }
    replace(this.root,
      preview,
      h("div", { class: "event-hover-copy" },
        h("strong", null, event.name ?? event.id),
        h("span", { class: "event-hover-meta" }, h("code", null, event.id), ` · ${page?.trigger ?? "no page"} · (${event.x}, ${event.y})`),
        rows.length
          ? h("ul", null, rows.map((row) => h("li", null, row.summary)))
          : h("span", { class: "event-hover-empty" }, "No commands on the first page"),
      ),
    );
    this.root.dataset.event = event.id;
    this.root.hidden = false;
    this.position(event);
  }

  private position(event: GameEvent): void {
    if (this.root.hidden) return;
    const hostRect = this.root.parentElement!.getBoundingClientRect();
    const center = this.canvas.cellToClient(event.x + ((event.w ?? 1) - 1) / 2, event.y + ((event.h ?? 1) - 1) / 2);
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const localX = center.x - hostRect.left;
    const localY = center.y - hostRect.top;
    const halfEvent = Math.max(8, (event.w ?? 1) * 8 * this.app.view.zoom);
    const placement = hoverCardPlacement(hostRect.width, localX, halfEvent, width);
    const y = Math.max(8, Math.min(hostRect.height - height - 8, localY - height / 2));
    this.root.dataset.side = placement.side;
    this.root.style.transform = `translate(${Math.round(placement.x)}px, ${Math.round(y)}px)`;
  }
}

export function mountEventHoverCard(root: HTMLElement, app: StudioApp, canvas: MapCanvas, art: ArtRegistry): EventHoverCard {
  return new EventHoverCard(root, app, canvas, art);
}
