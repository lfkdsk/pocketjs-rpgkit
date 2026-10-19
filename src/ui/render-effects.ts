// Native draw-effect availability is a build-target fact. The core software
// rasterizer (web/test and PocketBook) implements image blend/tone and
// destination tone exactly. Fixed GPU/console draw-list interpreters currently
// consume the appended operations safely but retain their legacy pixels.

import { platform } from "@pocketjs/framework/platform";
import { getHost, type Host } from "@pocketjs/framework/host";

/** Whether the active host executes the appended image/destination effect
 * ops. Injected web/test adapters drive the core software rasterizer even
 * when a fixture bundle targets a console; PocketBook is the one native
 * profile that also presents the software surface directly. */
export function nativeRenderEffectsSupported(
  target = platform.target,
  kind?: Host["kind"],
): boolean {
  const hostKind = kind ?? getHost().kind;
  return hostKind === "injected" || target === "pocketbook";
}
