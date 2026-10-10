// Type-only seam between the base session reducer and the optional connected-
// world opening resolver. The concrete index/geometry implementation is only
// imported by the explicit world entry, so projects that never opt in do not
// pull it into their bundle.

import type { Dir, Facing } from "./types.ts";

export interface WorldHandoffRequest {
  portalId: string;
  sourceMapId: string;
  targetMapId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  facing: Facing;
  transferDirection: Dir | "keep";
}

/** Geometry proven by the immutable WorldLayout. Runtime passage checks are
 * deliberately left to Session, which owns the compiled source/target tables. */
export interface WorldHandoffResolution {
  direction: Facing;
  /** Trusted opening provenance, never copied from the transfer command. */
  movementCapability?: string;
}

export interface WorldHandoffResolver {
  /** Binds the resolver to the exact topology carried by ProjectSource. */
  readonly topologyHash: string;
  resolve(request: Readonly<WorldHandoffRequest>): WorldHandoffResolution | null;
}
