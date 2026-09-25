import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MEMORY_CORE_ID, sidecarCheck } from "./config.js";
import { writeCache } from "./schemas.js";
import type { CallMeta, PluginDeps } from "./types.js";

const LIST_TIMEOUT_MS = 2000;
const RETRY_INTERVAL_MS = 60_000;
const STOP_SETTLE_MS = 3000;

function logSidecarIfOpen(api: OpenClawPluginApi): void {
  const check = sidecarCheck(api.runtime.config.current());
  const open: string[] = [];
  if (!check.dreamingOff) open.push("plugins.entries.lumberroom.config.dreaming.enabled");
  if (!check.memoryCoreOff) open.push(`plugins.entries.${MEMORY_CORE_ID}.enabled`);
  if (!open.length) return;
  api.logger.error(
    `lumberroom: memory-core can load beside lumberroom as a dreaming sidecar (${open.join(", ")} not false); ` +
      `its memory_search may shadow lumberroom's. Run: openclaw lumberroom setup`,
  );
}

/** At most once a minute after a failure. */
export async function refreshListing(deps: PluginDeps): Promise<void> {
  if (!deps.client) return;
  const now = deps.now();
  if (deps.state.listingSource !== "live" && now - deps.state.lastListAttemptMs < RETRY_INTERVAL_MS) {
    return;
  }
  deps.state.lastListAttemptMs = now;
  const meta: CallMeta = { invocation: "hook", timeoutMs: LIST_TIMEOUT_MS };
  const { result, listing } = await deps.client.listTools(meta);
  if (result.kind === "ok" && listing) {
    deps.state.listing = listing;
    deps.state.listingSource = "live";
    writeCache(deps.stateDir, listing);
  }
  // Any other outcome leaves the cache or snapshot already in state, degraded rather than replaced.
}

export function registerLumberroomService(api: OpenClawPluginApi, deps: PluginDeps): void {
  // Sockets and clients only exist in full registration; discovery and cli-metadata modes must not
  // start them (spec 8: "Only in registrationMode full").
  if (api.registrationMode !== "full") return;
  api.registerService({
    id: "lumberroom",
    start: async () => {
      logSidecarIfOpen(api);
      await refreshListing(deps);
    },
    stop: async () => {
      await deps.client?.close(STOP_SETTLE_MS);
    },
  });
}
