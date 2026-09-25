import type { MemoryPluginCapability } from "openclaw/plugin-sdk/core";
import type { PluginDeps } from "./types.js";

const RECORD_LINE = "Lumberroom is the durable memory here. Record durable facts with memory_write.";
const READ_ONLY_LINE = "MEMORY.md, USER.md and memory/ in the workspace are read-only while lumberroom owns memory.";

export function buildCapability(deps: PluginDeps): MemoryPluginCapability {
  return {
    // An own property so a dreaming sidecar's own resolver can never fill this in (O4, O5): the
    // owner's undefined fields fall through to the sidecar, but a present null-returning function
    // does not.
    flushPlanResolver: () => null,
    promptBuilder(params) {
      if (!params.availableTools.has("memory_write")) return [];
      const instructions = deps.state.listing.instructions;
      const lines: string[] = [];
      if (instructions) lines.push(instructions);
      lines.push(RECORD_LINE, READ_ONLY_LINE);
      return lines;
    },
  };
}
