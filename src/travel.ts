// Explicit follower/vehicle entry. Walking-only consumers never import this
// module, so the full travel reducer stays outside their source graph.

import * as implementation from "./engine/travel.ts";
import * as sessionIntegration from "./engine/travel-session.ts";
import type { TravelRuntime } from "./engine/travel-contract.ts";

export const travelRuntime: TravelRuntime = Object.freeze({
  ...implementation,
  ...sessionIntegration,
});
export type { TravelRuntime } from "./engine/travel-contract.ts";
export * from "./engine/travel.ts";
