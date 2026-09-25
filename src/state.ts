import { Breaker, SessionLru } from "./recall.js";
import { loadSnapshot, readCache } from "./schemas.js";
import type { ListingSource, LumberroomConfig, RuntimeState, ToolsListing } from "./types.js";

// Bounds per-session bookkeeping (digests, seen ids, turn counters, told flags) so a host that
// never fires session_end for a stale session cannot grow this without limit (spec 8: "an LRU of
// 256 sessions").
const SESSION_LRU_MAX = 256;

/** Seeds the listing from the cache, else the snapshot, so the plugin has something to offer before the service's first live fetch (spec 8.1 step 3). */
export function createState(cfg: LumberroomConfig | null, inertReason: string | null, stateDir: string): RuntimeState {
  const cached = readCache(stateDir);
  const listing: ToolsListing = cached ?? loadSnapshot();
  const listingSource: ListingSource = cached ? "cache" : "snapshot";
  return {
    cfg,
    inertReason,
    listing,
    listingSource,
    // -Infinity, not 0: a real clock can read 0 (deps.now() is process-supplied and tests fix it at
    // 0), and 0 must not be mistaken for "never attempted" when throttling refreshListing.
    lastListAttemptMs: -Infinity,
    digests: new SessionLru(SESSION_LRU_MAX),
    seen: new SessionLru(SESSION_LRU_MAX),
    turns: new SessionLru(SESSION_LRU_MAX),
    told: new SessionLru(SESSION_LRU_MAX),
    breaker: new Breaker(),
  };
}
