// tools/web/boot.ts — the small, host-owned URL bridge used by the web
// player. Values stay as URL strings; each game owns their semantic and
// numeric validation.

export const RPGKIT_BOOT_KEYS = ["chapter", "map", "x", "y", "autoplay", "speed"] as const;

export type RpgkitBoot = Partial<Record<(typeof RPGKIT_BOOT_KEYS)[number], string>>;

/** Copy only the supported deep-link keys, preserving empty string values. */
export function rpgkitBootFromSearch(search: string): RpgkitBoot {
  const query = new URLSearchParams(search);
  const boot: RpgkitBoot = {};
  for (const key of RPGKIT_BOOT_KEYS) {
    if (query.has(key)) boot[key] = query.get(key) ?? "";
  }
  return boot;
}

/** Replace the demo-owned query keys (chapter/autoplay/…) with `values`,
 *  preserving every other parameter — the language parameter first among
 *  them, so a `?lang=` deep link survives chapter and autoplay clicks. The
 *  returned string is "" when nothing remains. */
export function withDemoQuery(search: string, values: Record<string, string>): string {
  const query = new URLSearchParams(search);
  for (const key of RPGKIT_BOOT_KEYS) query.delete(key);
  for (const [key, value] of Object.entries(values)) query.set(key, value);
  const next = query.toString();
  return next ? `?${next}` : "";
}
