import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import { createState } from "../../src/state.js";
import { registerTools } from "../../src/tools.js";
import type { CallMeta, CallResult, EngineClient, LumberroomConfig, PluginDeps, ToolsListing } from "../../src/types.js";
import { createFakeApi } from "../fakes/api.js";

function baseListing(): ToolsListing {
  return {
    tools: [
      { name: "memory_search", description: "Search.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "memory_write", description: "Write.", inputSchema: { type: "object", properties: { content: { type: "string" } } } },
      { name: "registry_get", description: "Get.", inputSchema: { type: "object" } },
      { name: "memory_forget", description: "Forget.", inputSchema: { type: "object" } },
      { name: "review_queue", description: "Queue.", inputSchema: { type: "object" } },
      { name: "review_decide", description: "Decide.", inputSchema: { type: "object" } },
    ],
    instructions: "Search before you write.",
    serverInfo: { name: "rmcp", version: "3.2.0" },
    protocolVersion: "2025-11-25",
  };
}

function ok(structured: Record<string, unknown> = {}): CallResult {
  return { kind: "ok", structured, text: JSON.stringify(structured), error: null, status: null };
}

function fail(kind: CallResult["kind"], error: string, status: number | null = null): CallResult {
  return { kind, structured: null, text: "", error, status };
}

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  meta: CallMeta;
}

// lists counts tools/list requests, which a refused turn must not send either.
function fakeClient(reply: (name: string, args: Record<string, unknown>, meta: CallMeta) => CallResult): EngineClient & { calls: RecordedCall[]; lists: number } {
  const calls: RecordedCall[] = [];
  const client: EngineClient & { calls: RecordedCall[]; lists: number } = {
    calls,
    lists: 0,
    async listTools() {
      client.lists += 1;
      return { result: ok(), listing: null };
    },
    async callTool(name, args, meta) {
      calls.push({ name, args, meta });
      return reply(name, args, meta);
    },
    async admin() {
      return { status: 200, json: {} };
    },
    async close() {},
  };
  return client;
}

function deps(overrides: Partial<PluginDeps> = {}, cfgOverrides: Record<string, unknown> = {}): PluginDeps {
  const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-tools-"));
  const cfg: LumberroomConfig = resolveConfig(cfgOverrides);
  const state = createState(cfg, null, stateDir);
  state.listing = baseListing();
  state.listingSource = "live";
  return {
    state,
    client: fakeClient(() => ok()),
    auth: null,
    stateDir,
    logger: { info() {}, warn() {} },
    now: () => 0,
    ...overrides,
  };
}

function runFactory(d: PluginDeps, toolCtx: Record<string, unknown> = { sessionKey: "agent:main:main" }) {
  const fake = createFakeApi({ workspaceDir: "/tmp" });
  registerTools(fake.api, d);
  return fake.resolveTools(toolCtx);
}

describe("registerTools factory", () => {
  it("returns null for a refused group turn and sends no tools/list", () => {
    const client = fakeClient(() => ok());
    const d = deps({ client }, { ownerIds: [] });
    d.state.listingSource = "snapshot";
    const tools = runFactory(d, { sessionKey: "agent:main:telegram:group:1", requesterSenderId: "42" });
    expect(tools).toEqual([]);
    expect(client.lists).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it("retries a degraded listing on an allowed turn", () => {
    const client = fakeClient(() => ok());
    const d = deps({ client });
    d.state.listingSource = "snapshot";
    runFactory(d);
    expect(client.lists).toBe(1);
  });

  it("returns null while inert", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-tools-inert-"));
    const d: PluginDeps = {
      state: createState(null, "baseUrl must start with http", stateDir),
      client: null,
      auth: null,
      stateDir,
      logger: { info() {}, warn() {} },
      now: () => 0,
    };
    const tools = runFactory(d);
    expect(tools).toEqual([]);
  });

  it("returns the allowlisted tools with live descriptions", () => {
    const d = deps({}, { tools: ["memory_search", "memory_write"] });
    const tools = runFactory(d);
    expect(tools.map((t) => t.name).sort()).toEqual(["memory_search", "memory_write"]);
    const search = tools.find((t) => t.name === "memory_search")!;
    expect(search.description).toBe("Search.");
  });

  it("review tools appear only with dreamingReview, a hosted baseUrl and a live listing", () => {
    const d = deps({}, { dreamingReview: true, baseUrl: "https://mcp.lumberroom.cloud" });
    d.state.listingSource = "live";
    const tools = runFactory(d);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["review_queue", "review_decide"]));
  });

  it("a degraded listing never exposes review tools", () => {
    const d = deps({}, { dreamingReview: true, baseUrl: "https://mcp.lumberroom.cloud" });
    d.state.listingSource = "cache";
    const tools = runFactory(d);
    expect(tools.map((t) => t.name)).not.toContain("review_queue");
    expect(tools.map((t) => t.name)).not.toContain("review_decide");
  });

  it("memory_write returns possible_conflicts unchanged", async () => {
    const conflicts = [{ id: "x", namespace: "global", content: "dup", similarity: 0.98 }];
    const d = deps({ client: fakeClient(() => ok({ id: "new", namespace: "global", possible_conflicts: conflicts })) }, { tools: ["memory_write"] });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_write")!.execute("call-1", { content: "x", namespace: "global" });
    expect((result as { details: unknown }).details).toEqual({ id: "new", namespace: "global", possible_conflicts: conflicts });
  });

  it("an unreachable memory_write says nothing was stored", async () => {
    const d = deps({ client: fakeClient(() => fail("unreachable", "connection refused")) }, { tools: ["memory_write"] });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_write")!.execute("call-1", { content: "x", namespace: "global" });
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain("Nothing was stored.");
  });

  it("an unreachable memory_forget says nothing was deleted", async () => {
    const d = deps({ client: fakeClient(() => fail("unreachable", "connection refused")) }, { tools: ["memory_forget"] });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_forget")!.execute("call-1", { id: "x", reason: "r" });
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain("Nothing was deleted.");
  });

  it("a timeout on memory_write says it may have taken effect", async () => {
    const d = deps({ client: fakeClient(() => fail("timeout", "deadline passed")) }, { tools: ["memory_write"], toolTimeoutMs: 20000 });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_write")!.execute("call-1", { content: "x", namespace: "global" });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("did not answer within 20s");
    expect(text).toContain("may have taken effect");
  });

  it("a 500 on memory_write names the status and says it may have taken effect", async () => {
    const d = deps({ client: fakeClient(() => fail("timeout", "HTTP 500", 500)) }, { tools: ["memory_write"] });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_write")!.execute("call-1", { content: "x", namespace: "global" });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe("lumberroom answered HTTP 500. The call may have taken effect; search before retrying.");
  });

  it("a login_required tool call says to run openclaw lumberroom login", async () => {
    const d = deps({ client: fakeClient(() => fail("login_required", "lumberroom is not signed in. Run: openclaw lumberroom login")) }, { tools: ["memory_search"] });
    const tools = runFactory(d);
    const result = await tools.find((t) => t.name === "memory_search")!.execute("call-1", { query: "x" });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toBe("lumberroom is not signed in. Run: openclaw lumberroom login");
  });

  it("model tool calls use the model invocation and the session id", async () => {
    const client = fakeClient(() => ok());
    const d = deps({ client }, { tools: ["memory_search"] });
    const tools = runFactory(d, { sessionKey: "agent:main:main", sessionId: "s-99" });
    await tools.find((t) => t.name === "memory_search")!.execute("call-1", { query: "x" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.meta.invocation).toBe("model");
    expect(client.calls[0]!.meta.sessionId).toBe("s-99");
  });
});
