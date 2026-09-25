import type { ListingSource, LumberroomConfig, McpTool, ToolParameters, ToolsListing } from "./types.js";

/** <package root>/tools-snapshot.json, found through import.meta.url. */
export function loadSnapshot(): ToolsListing {
  throw new Error("T3");
}

/** <stateDir>/lumberroom/tools-cache.json. */
export function readCache(stateDir: string): ToolsListing | null {
  throw new Error("T3");
}

export function writeCache(stateDir: string, listing: ToolsListing): void {
  throw new Error("T3");
}

export function candidateNames(cfg: LumberroomConfig): string[] {
  throw new Error("T3");
}

export function exposedTools(cfg: LumberroomConfig, listing: ToolsListing, source: ListingSource): McpTool[] {
  throw new Error("T3");
}

/** Type.Unsafe over the engine's raw JSON Schema. */
export function toParameters(inputSchema: Record<string, unknown>): ToolParameters {
  throw new Error("T3");
}
