// Budgeted, cross-frame preparation of the seamless-world working set.
//
// The preparer stages the compiled keep-set (active map plus imminent
// targets) through prepareSessionMapStep — one fixed cold unit per stage —
// without publishing anything. acquireSessionMap at the transfer boundary
// still publishes, so a tick never observes a half-prepared map and the same
// input executes exactly once whether or not prefetch finished in time; the
// reducer's own fade-out prefetch remains the deterministic backstop.
//
// A map whose preparation fails is recorded and skipped on later updates
// (stable error instead of a per-frame rethrow); the error surfaces again if
// the game actually enters the map. Construction is the only allocation the
// feature costs, and only projects that carry a WorldLayout construct one.

import { prepareSessionMapStep, type Session } from "./session.ts";
import type { WorldWorkingSet } from "./world-working-set.ts";

export interface WorldPrefetchOptions {
  /** Wall-clock budget per update() call in milliseconds. At least one
   *  stage always runs when work is pending, so a stage slower than the
   *  budget cannot starve the queue. Defaults to 8. */
  budgetMs?: number;
  /** Clock for the budget; defaults to Date.now. */
  now?: () => number;
}

export interface WorldPrefetchStats {
  /** Maps with completed staged preparation, still unpublished. */
  staged: number;
  /** Maps still missing at least one stage. */
  pending: number;
  /** Stages performed by this update call. */
  stages: number;
  /** Maps whose preparation failed, with the stable error message. */
  failures: Readonly<Record<string, string>>;
  /** Wall-clock milliseconds spent staging by this update call. */
  stageMs: number;
}

export interface WorldPrefetcher {
  /** Advance preparation of the working set's compiled keep-set. Safe to
   *  call every frame: it does nothing when everything is resident. */
  update(set: Readonly<WorldWorkingSet>): WorldPrefetchStats;
  /** Failures recorded since the prefetcher was created. */
  failures(): Readonly<Record<string, string>>;
}

/** Compiled keep-set in prefetch priority order: active first, then the
 *  imminent targets in their facing/distance rank, de-duplicated. */
function compiledQueue(set: Readonly<WorldWorkingSet>): string[] {
  const queue: string[] = [set.active];
  for (const entry of set.imminent) {
    if (!queue.includes(entry.mapId)) queue.push(entry.mapId);
  }
  return queue;
}

export function createWorldPrefetcher(
  sess: Session,
  options: WorldPrefetchOptions = {},
): WorldPrefetcher {
  const budgetMs = options.budgetMs ?? 8;
  const now = options.now ?? Date.now;
  const staged = new Set<string>();
  let transport: {
    desired: Set<string>;
    prefetched: Set<string>;
    prefetching: Set<string>;
  } | undefined;
  const failures = new Map<string, string>();

  const reconcile = (): void => {
    // A layered release drops unpublished preparation for maps that left the
    // parsed keep-set, and trims maps that left the compiled keep-set back
    // to their parsed stage; such a map must stage again if it returns. A
    // map that is fully resident was published and is no longer "staged".
    for (const id of [...staged]) {
      if (sess.maps.has(id) && sess.worlds.has(id) && sess.tables.has(id)) {
        staged.delete(id);
        continue;
      }
      const preparation = sess.preparingMaps.get(id);
      if (!preparation || !preparation.world || !preparation.table) {
        staged.delete(id);
      }
    }
  };

  return {
    failures: () => ({ ...Object.fromEntries(failures) }),
    update(set) {
      reconcile();
      const start = now();
      let stages = 0;
      let pending = 0;
      // Without synchronous staging units the async prepare path or the
      // transfer boundary's full acquire handles readiness; nothing to do.
      const canStage = sess.repository?.acquireStep !== undefined;
      const queue = compiledQueue(set);
      const prefetch = canStage ? undefined : sess.repository?.prefetch;
      if (prefetch) {
        transport ??= {
          desired: new Set<string>(),
          prefetched: new Set<string>(),
          prefetching: new Set<string>(),
        };
        transport.desired.clear();
        for (const id of queue) transport.desired.add(id);
        for (const id of [...transport.prefetched]) {
          if (!transport.desired.has(id)) transport.prefetched.delete(id);
        }
      }
      for (const id of queue) {
        if (staged.has(id)) continue;
        // A parsed-only map (visible but not imminent) is resident in the
        // parsed layer only: it still needs its compiled stages staged.
        if (sess.maps.has(id) && sess.worlds.has(id) && sess.tables.has(id)) continue;
        if (failures.has(id)) { pending++; continue; }
        if (!canStage) {
          if (!prefetch) { pending++; continue; }
          const active = transport!;
          if (active.prefetched.has(id)) continue;
          pending++;
          if (active.prefetching.has(id)) continue;
          if (stages > 0 && now() - start >= budgetMs) continue;
          active.prefetching.add(id);
          void prefetch(id).then(
            () => {
              active.prefetching.delete(id);
              if (active.desired.has(id)) active.prefetched.add(id);
            },
            (error) => {
              active.prefetching.delete(id);
              failures.set(id, error instanceof Error ? error.message : String(error));
            },
          );
          stages++;
          continue;
        }
        // Stage this map to completion in prefetch priority order, or until
        // the budget runs out. At least one stage always runs when work is
        // pending, so a stage slower than the budget cannot starve the queue.
        for (;;) {
          if (stages > 0 && now() - start >= budgetMs) { pending++; break; }
          let done: boolean;
          try {
            done = prepareSessionMapStep(sess, id);
          } catch (error) {
            failures.set(id, error instanceof Error ? error.message : String(error));
            sess.preparingMaps.delete(id);
            pending++;
            break;
          }
          stages++;
          if (done) {
            staged.add(id);
            break;
          }
        }
      }
      return {
        staged: staged.size + (transport?.prefetched.size ?? 0),
        pending,
        stages,
        failures: Object.fromEntries(failures),
        stageMs: now() - start,
      };
    },
  };
}
