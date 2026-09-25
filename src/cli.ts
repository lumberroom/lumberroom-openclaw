import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CliDeps, CliIo } from "./setup.js";

/** node:readline/promises over stdin and stdout; askSecret does not echo. */
export function createCliIo(): CliIo {
  throw new Error("T5");
}

export function registerLumberroomCli(api: OpenClawPluginApi, deps: Omit<CliDeps, "cliConfig" | "workspaceDir">): void {
  throw new Error("T5");
}
