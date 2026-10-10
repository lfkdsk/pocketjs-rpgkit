// Optional WorldLayout-backed opening resolver. It is deliberately outside
// the base engine barrel: GameView reaches it only through ui/world, and
// headless users may import this module explicitly.

import type { Dir, Facing, WorldLayout, WorldOpening, WorldPlacement, WorldSide } from "./types.ts";
import { validateWorldLayout } from "./world-layout.ts";
import type {
  WorldHandoffRequest,
  WorldHandoffResolution,
  WorldHandoffResolver,
} from "./world-handoff-contract.ts";

interface OpeningBinding {
  opening: Readonly<WorldOpening>;
  source: Readonly<WorldPlacement>;
  target: Readonly<WorldPlacement>;
}

const SIDE_DIRECTION: Readonly<Record<WorldSide, Facing>> = {
  south: 0,
  west: 1,
  north: 2,
  east: 3,
};

const DIR_NAME: readonly Dir[] = ["down", "left", "up", "right"];
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;

function edgeCoordinate(
  placement: Readonly<WorldPlacement>,
  side: WorldSide,
  tangent: number,
): { x: number; y: number } {
  switch (side) {
    case "north": return { x: tangent, y: 0 };
    case "east": return { x: placement.width - 1, y: tangent };
    case "south": return { x: tangent, y: placement.height - 1 };
    case "west": return { x: 0, y: tangent };
  }
}

function tangentCoordinate(axis: "x" | "y", x: number, y: number): number {
  return axis === "x" ? x : y;
}

/** Build a stable portal-id index after checking every relational layout
 * invariant. Resolution is allocation-light and fail-closed: any mismatch
 * returns null so Session uses the unchanged legacy transfer path. */
export function createWorldHandoffResolver(layout: Readonly<WorldLayout>): WorldHandoffResolver {
  validateWorldLayout(layout as WorldLayout);
  const byPortal = new Map<string, OpeningBinding>();
  for (const component of layout.components) {
    const placements = new Map(component.placements.map((placement) => [placement.mapId, placement]));
    for (const opening of component.openings) {
      byPortal.set(opening.portalId, {
        opening,
        source: placements.get(opening.source.mapId)!,
        target: placements.get(opening.target.mapId)!,
      });
    }
  }

  return {
    topologyHash: layout.topologyHash,
    resolve(request: Readonly<WorldHandoffRequest>): WorldHandoffResolution | null {
      const binding = byPortal.get(request.portalId);
      if (!binding || binding.opening.compatibility !== "coordinate-preserving") return null;
      const { opening, source, target } = binding;
      if (opening.source.mapId !== request.sourceMapId || opening.target.mapId !== request.targetMapId) return null;
      if (
        source.width !== request.sourceWidth || source.height !== request.sourceHeight ||
        target.width !== request.targetWidth || target.height !== request.targetHeight
      ) return null;

      const direction = SIDE_DIRECTION[opening.source.side];
      if (request.facing !== direction) return null;
      if (request.transferDirection !== "keep" && request.transferDirection !== DIR_NAME[direction]) return null;
      const sourceTangent = tangentCoordinate(opening.axis, request.sourceX, request.sourceY);
      if (sourceTangent < opening.source.span.start || sourceTangent >= opening.source.span.end) return null;
      const expectedSource = edgeCoordinate(source, opening.source.side, sourceTangent);
      if (expectedSource.x !== request.sourceX || expectedSource.y !== request.sourceY) return null;

      const targetTangent = sourceTangent + opening.offset;
      if (targetTangent < opening.target.span.start || targetTangent >= opening.target.span.end) return null;
      const expectedTarget = edgeCoordinate(target, opening.target.side, targetTangent);
      if (expectedTarget.x !== request.targetX || expectedTarget.y !== request.targetY) return null;

      const sourceWorldX = source.originTileX + request.sourceX;
      const sourceWorldY = source.originTileY + request.sourceY;
      const targetWorldX = target.originTileX + request.targetX;
      const targetWorldY = target.originTileY + request.targetY;
      if (sourceWorldX + DX[direction] !== targetWorldX || sourceWorldY + DY[direction] !== targetWorldY) return null;
      return opening.movementCapability === undefined
        ? { direction }
        : { direction, movementCapability: opening.movementCapability };
    },
  };
}
