import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapability } from "../../src/capability.js";
import { createState } from "../../src/state.js";
import type { PluginDeps, ToolsListing } from "../../src/types.js";

function listing(overrides: Partial<ToolsListing> = {}): ToolsListing {
  return {
    tools: [{ name: "memory_write", description: "Write a fact.", inputSchema: { type: "object" } }],
    instructions: "Search before you write.",
    serverInfo: { name: "rmcp", version: "3.2.0" },
    protocolVersion: "2025-11-25",
    ...overrides,
  };
}

function deps(overrides: Partial<PluginDeps> = {}): PluginDeps {
  const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-capability-"));
  return {
    state: createState(null, null, stateDir),
    client: null,
    auth: null,
    stateDir,
    logger: { info() {}, warn() {} },
    now: () => 0,
    ...overrides,
  };
}

describe("buildCapability", () => {
  it("flushPlanResolver is an own property that returns null", () => {
    const capability = buildCapability(deps());
    expect(Object.hasOwn(capability, "flushPlanResolver")).toBe(true);
    expect(capability.flushPlanResolver?.({})).toBeNull();
  });

  it("promptBuilder returns the server instructions and two lines when memory_write is available", () => {
    const d = deps();
    d.state.listing = listing({ instructions: "Search before you write." });
    d.state.listingSource = "live";
    const capability = buildCapability(d);
    const lines = capability.promptBuilder!({ availableTools: new Set(["memory_write", "memory_search"]) });
    expect(lines).toEqual([
      "Search before you write.",
      "Lumberroom is the durable memory here. Record durable facts with memory_write.",
      "MEMORY.md, USER.md and memory/ in the workspace are read-only while lumberroom owns memory.",
    ]);
  });

  it("promptBuilder falls back to the snapshot instructions", () => {
    const d = deps();
    // createState with no cache on disk seeds state.listing from tools-snapshot.json.
    const capability = buildCapability(d);
    const lines = capability.promptBuilder!({ availableTools: new Set(["memory_write"]) });
    expect(lines[0]).toBe(d.state.listing.instructions);
    expect(lines).toContain("Lumberroom is the durable memory here. Record durable facts with memory_write.");
  });

  it("promptBuilder returns nothing when memory_write is unavailable", () => {
    const d = deps();
    d.state.listing = listing();
    const capability = buildCapability(d);
    expect(capability.promptBuilder!({ availableTools: new Set(["memory_search"]) })).toEqual([]);
  });
});
