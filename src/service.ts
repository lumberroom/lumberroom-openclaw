import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginDeps } from "./types.js";

export function registerLumberroomService(api: OpenClawPluginApi, deps: PluginDeps): void {
  throw new Error("T4");
}

/** At most once a minute after a failure. */
export function refreshListing(deps: PluginDeps): Promise<void> {
  throw new Error("T4");
}
