/// <reference lib="dom" />
// editor/studio/layers-panel.ts — visibility, opacity and editing-layer
// controls for the layers Studio presents on the map canvas.

import type { PaintLayer, PresentedLayer, StudioApp } from "./app.ts";
import { emptyState, h, icon, replace } from "./dom.ts";

interface LayerDefinition {
  key: PresentedLayer;
  label: string;
  /** Events are presented here, but selected with the event tool. */
  editable?: PaintLayer;
}

const LAYERS: readonly LayerDefinition[] = [
  { key: "ground", label: "Ground", editable: "ground" },
  { key: "upper", label: "Upper", editable: "upper" },
  { key: "passage", label: "Passage", editable: "passage" },
  { key: "regions", label: "Regions", editable: "regions" },
  { key: "events", label: "Events" },
];

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/** Mount the layer visibility, opacity and editing-layer controls. */
export function mountLayersPanel(root: HTMLElement, app: StudioApp): void {
  root.classList.add("layers-panel");
  root.dataset.testid = "layers-panel";

  let showingProject: boolean | null = null;
  let syncControls: (() => void) | null = null;

  const render = (): void => {
    const hasProject = app.session !== null;
    if (showingProject === hasProject) {
      syncControls?.();
      return;
    }
    showingProject = hasProject;

    const header = h("div", { class: "panel-header layers-header" },
      h("span", { class: "panel-title" }, icon("layers"), " Layers"));

    if (!hasProject) {
      syncControls = null;
      replace(root,
        header,
        emptyState("layers", "No project open", "Open a project to control its map layers."),
      );
      root.querySelector("[data-role=\"empty-state\"]")?.setAttribute("data-testid", "layers-empty");
      return;
    }

    const controls = LAYERS.map((definition) => {
      const { key, label, editable } = definition;
      const select = editable
        ? h("button", {
            type: "button",
            class: "layer-name",
            dataset: { layer: key },
            "data-testid": `layer-${key}-select`,
            "aria-label": `Edit ${label} layer`,
            onclick: () => app.setLayer(editable),
          }, label)
        : h("span", { class: "layer-name", dataset: { layer: key } }, label);
      const visibility = h("button", {
        type: "button",
        class: "icon-button layer-visibility",
        "data-testid": `layer-${key}-visibility`,
        onclick: () => {
          app.visible[key] = !app.visible[key];
          syncControls?.();
          app.emit("view");
        },
      });
      const opacity = h("input", {
        type: "range",
        class: "layer-opacity",
        min: 0,
        max: 100,
        step: 1,
        "data-testid": `layer-${key}-opacity`,
        "aria-label": `${label} layer opacity`,
      });
      const opacityValue = h("output", {
        class: "layer-opacity-value",
        "aria-hidden": "true",
      });
      const changeOpacity = (event: Event): void => {
        const value = Number((event.currentTarget as HTMLInputElement).value);
        app.opacity[key] = Math.max(0, Math.min(100, value)) / 100;
        opacityValue.value = `${Math.round(value)}%`;
        app.emit("view");
      };
      opacity.addEventListener("input", changeOpacity);
      opacity.addEventListener("change", changeOpacity);

      const row = h("div", {
        class: "layer-row",
        role: "listitem",
        dataset: { layer: key },
        "data-testid": `layer-${key}`,
      }, select, visibility, opacity, opacityValue);
      return { definition, row, select, visibility, opacity, opacityValue };
    });

    syncControls = () => {
      // One-way edge painting shares the passage overlay and row.
      const activeLayer: string = app.layer === "edges" ? "passage" : app.layer;
      for (const control of controls) {
        const { key, label, editable } = control.definition;
        const active = activeLayer === key;
        const visible = app.visible[key];
        const value = percent(app.opacity[key]);

        control.row.classList.toggle("active", active);
        if (active) control.row.setAttribute("aria-current", "true");
        else control.row.removeAttribute("aria-current");
        if (editable) {
          control.select.classList.toggle("active", active);
          control.select.setAttribute("aria-pressed", String(active));
        }

        control.visibility.classList.toggle("pressed", visible);
        control.visibility.setAttribute("aria-pressed", String(visible));
        control.visibility.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${label} layer`);
        control.visibility.title = `${visible ? "Hide" : "Show"} ${label} layer`;
        replace(control.visibility, icon(visible ? "eye" : "eyeOff"));

        control.opacity.value = String(value);
        control.opacity.setAttribute("aria-valuetext", `${value}%`);
        control.opacity.title = `${label} layer opacity: ${value}%`;
        control.opacityValue.value = `${value}%`;
      }
    };

    replace(root,
      header,
      h("div", { class: "layers-list", role: "list", "aria-label": "Map layers" }, controls.map((control) => control.row)),
    );
    syncControls();
  };

  app.on(render);
  render();
}
