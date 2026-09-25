import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { REVIEW_TOOLS } from "./config.js";
import type { ListingSource, LumberroomConfig, McpTool, ToolParameters, ToolsListing } from "./types.js";

const REVIEW_TOOL_NAMES: readonly string[] = REVIEW_TOOLS;

function packageRoot(): string {
  // This file sits directly under src/ (or dist/ once built), one level below the package root.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function normalizeListing(raw: Partial<ToolsListing> & { tools?: unknown }): ToolsListing | null {
  if (!raw || !Array.isArray(raw.tools)) return null;
  return {
    tools: raw.tools as McpTool[],
    instructions: raw.instructions ?? null,
    serverInfo: raw.serverInfo ?? null,
    protocolVersion: raw.protocolVersion ?? null,
  };
}

/** <package root>/tools-snapshot.json, found through import.meta.url. */
export function loadSnapshot(): ToolsListing {
  const raw = JSON.parse(readFileSync(join(packageRoot(), "tools-snapshot.json"), "utf8")) as Partial<ToolsListing>;
  const listing = normalizeListing(raw);
  if (!listing) throw new Error("tools-snapshot.json carries no tools array");
  return listing;
}

function cachePath(stateDir: string): string {
  return join(stateDir, "lumberroom", "tools-cache.json");
}

/** <stateDir>/lumberroom/tools-cache.json. */
export function readCache(stateDir: string): ToolsListing | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(stateDir), "utf8")) as Partial<ToolsListing>;
    return normalizeListing(raw);
  } catch {
    return null;
  }
}

export function writeCache(stateDir: string, listing: ToolsListing): void {
  const path = cachePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(listing));
  renameSync(tmp, path);
}

export function candidateNames(cfg: LumberroomConfig): string[] {
  const names = [...cfg.tools];
  if (cfg.dreamingReview && cfg.hosted) names.push(...REVIEW_TOOL_NAMES);
  return names;
}

export function exposedTools(cfg: LumberroomConfig, listing: ToolsListing, source: ListingSource): McpTool[] {
  const byName = new Map(listing.tools.map((t) => [t.name, t] as const));
  const candidates = candidateNames(cfg).filter((name) => source === "live" || !REVIEW_TOOL_NAMES.includes(name));
  const out: McpTool[] = [];
  for (const name of candidates) {
    const tool = byName.get(name);
    if (tool) out.push(tool);
  }
  return out;
}

/** Type.Unsafe over the engine's raw JSON Schema. */
export function toParameters(inputSchema: Record<string, unknown>): ToolParameters {
  return Type.Unsafe(inputSchema);
}
