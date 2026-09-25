import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateNames, exposedTools, loadSnapshot, readCache, toParameters, writeCache } from "../../src/schemas.js";
import { resolveConfig } from "../../src/config.js";
import type { ListingSource, McpTool, ToolsListing } from "../../src/types.js";

function listing(tools: McpTool[], overrides: Partial<ToolsListing> = {}): ToolsListing {
  return { tools, instructions: null, serverInfo: { name: "rmcp", version: "3.2.0" }, protocolVersion: "2025-11-25", ...overrides };
}

function tool(name: string): McpTool {
  return { name, description: `does ${name}`, inputSchema: { type: "object", properties: {} } };
}

describe("loadSnapshot", () => {
  it("reads the committed tools-snapshot.json from the package root", () => {
    const snapshot = loadSnapshot();
    expect(snapshot.protocolVersion).toBe("2025-11-25");
    expect(snapshot.serverInfo).toEqual({ name: "rmcp", version: "3.2.0" });
    const names = snapshot.tools.map((t) => t.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_write");
    expect(names).toContain("context_bootstrap");
    expect(typeof snapshot.instructions).toBe("string");
  });

  it("matches the raw file's tool count", () => {
    const raw = JSON.parse(readFileSync(new URL("../../tools-snapshot.json", import.meta.url), "utf8")) as { tools: unknown[] };
    expect(loadSnapshot().tools).toHaveLength(raw.tools.length);
  });
});

describe("readCache and writeCache", () => {
  it("round-trips a listing through the state directory", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-schemas-"));
    const written = listing([tool("memory_search")]);
    writeCache(stateDir, written);
    expect(readCache(stateDir)).toEqual(written);
  });

  it("returns null when no cache file exists", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-schemas-"));
    expect(readCache(stateDir)).toBeNull();
  });

  it("returns null for a corrupt cache file rather than throwing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-schemas-"));
    writeCache(stateDir, listing([tool("memory_search")]));
    const path = join(stateDir, "lumberroom", "tools-cache.json");
    // Overwrite with garbage to prove readCache degrades instead of crashing the caller.
    writeFileSync(path, "not json");
    expect(readCache(stateDir)).toBeNull();
  });

  it("writeCache creates the lumberroom subdirectory on first write", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-schemas-"));
    expect(() => writeCache(stateDir, listing([]))).not.toThrow();
  });
});

describe("candidateNames", () => {
  it("is the tools allowlist when dreamingReview is off", () => {
    const cfg = resolveConfig({ tools: ["memory_search", "registry_get"] });
    expect(candidateNames(cfg)).toEqual(["memory_search", "registry_get"]);
  });

  it("adds the review tools only when dreamingReview is on and the host is hosted", () => {
    const cfg = resolveConfig({ tools: ["memory_search"], dreamingReview: true });
    expect(candidateNames(cfg)).toEqual(["memory_search", "review_queue", "review_decide"]);
  });

  it("does not add the review tools for a self-hosted engine even with dreamingReview on", () => {
    const cfg = resolveConfig({ baseUrl: "http://127.0.0.1:8787", tools: ["memory_search"], dreamingReview: true });
    expect(candidateNames(cfg)).toEqual(["memory_search"]);
  });
});

describe("exposedTools", () => {
  const cfg = resolveConfig({ tools: ["memory_search", "memory_write"], dreamingReview: true });

  it("returns only candidates the listing actually carries, in candidate order", () => {
    const l = listing([tool("memory_write"), tool("memory_search")]);
    expect(exposedTools(cfg, l, "live").map((t) => t.name)).toEqual(["memory_search", "memory_write"]);
  });

  it("drops a candidate absent from the listing", () => {
    const l = listing([tool("memory_search")]);
    expect(exposedTools(cfg, l, "live").map((t) => t.name)).toEqual(["memory_search"]);
  });

  it("exposes the review tools only from a live listing", () => {
    const l = listing([tool("memory_search"), tool("memory_write"), tool("review_queue"), tool("review_decide")]);
    expect(exposedTools(cfg, l, "live").map((t) => t.name)).toEqual(["memory_search", "memory_write", "review_queue", "review_decide"]);
  });

  it.each<ListingSource>(["cache", "snapshot"])("drops the review tools when the listing source is %s", (source) => {
    const l = listing([tool("memory_search"), tool("memory_write"), tool("review_queue"), tool("review_decide")]);
    expect(exposedTools(cfg, l, source).map((t) => t.name)).toEqual(["memory_search", "memory_write"]);
  });
});

describe("toParameters", () => {
  it("wraps the raw JSON schema unchanged", () => {
    const raw = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    expect(toParameters(raw)).toEqual(raw);
  });
});
