import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginDeps } from "./types.js";

/** Both prompt hooks and session_end. */
export function registerHooks(api: OpenClawPluginApi, deps: PluginDeps): void {
  throw new Error("T4");
}

export function registerGuard(api: OpenClawPluginApi, resolveWorkspace: (agentId: string | undefined) => string): void {
  throw new Error("T4");
}
