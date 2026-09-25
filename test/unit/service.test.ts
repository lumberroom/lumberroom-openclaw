import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import { readCache } from "../../src/schemas.js";
import { refreshListing, registerLumberroomService } from "../../src/service.js";
import { createState } from "../../src/state.js";
import type { CallResult, EngineClient, PluginDeps, ToolsListing } from "../../src/types.js";
import { createFakeApi } from "../fakes/api.js";

function liveListing(): ToolsListing {
  return {
    tools: [{ name: "memory_search", description: "Search.", inputSchema: { type: "object" } }],
    instructions: "live instructions",
    serverInfo: { name: "rmcp", version: "3.2.0" },
    protocolVersion: "2025-11-25",
  };
}

function okListing(listing: ToolsListing): { result: CallResult; listing: ToolsListing } {
  return { result: { kind: "ok", structured: null, text: "", error: null, status: null }, listing };
}

function failListing(): { result: CallResult; listing: null } {
  return { result: { kind: "unreachable", structured: null, text: "", error: "connection refused", status: null }, listing: null };
}

function fakeClient(listTools?: () => ReturnType<EngineClient["listTools"]>): EngineClient & { closes: number[] } {
  const closes: number[] = [];
  return {
    closes,
    listTools: listTools ?? (async () => okListing(liveListing())),
    async callTool() {
      return { kind: "ok", structured: {}, text: "", error: null, status: null };
    },
    async admin() {
      return { status: 200, json: {} };
    },
    async close(timeoutMs: number) {
      closes.push(timeoutMs);
    },
  };
}

function deps(client: EngineClient, now: () => number = () => 0): PluginDeps {
  const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-service-"));
  return {
    state: createState(resolveConfig({}), null, stateDir),
    client,
    auth: null,
    stateDir,
    logger: { info() {}, warn() {} },
    now,
  };
}

describe("registerLumberroomService", () => {
  it("start stores a live listing and writes the cache", async () => {
    const client = fakeClient();
    const d = deps(client);
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    registerLumberroomService(fake.api, d);
    await fake.services[0]!.start({});
    expect(d.state.listingSource).toBe("live");
    expect(d.state.listing.instructions).toBe("live instructions");
    expect(readCache(d.stateDir)).toEqual(d.state.listing);
  });

  it("start failure keeps the snapshot and marks the listing degraded", async () => {
    const client = fakeClient(async () => failListing());
    const d = deps(client);
    const before = d.state.listing;
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    registerLumberroomService(fake.api, d);
    await fake.services[0]!.start({});
    expect(d.state.listingSource).not.toBe("live");
    expect(d.state.listing).toBe(before);
  });

  it("a degraded listing retries at most once a minute", async () => {
    let calls = 0;
    let clock = 0;
    const client = fakeClient(async () => {
      calls += 1;
      return failListing();
    });
    const d = deps(client, () => clock);
    await refreshListing(d);
    expect(calls).toBe(1);
    await refreshListing(d);
    expect(calls).toBe(1);
    clock = 60_000;
    await refreshListing(d);
    expect(calls).toBe(2);
  });

  it("stop closes the client with a 3000 ms settle", async () => {
    const client = fakeClient();
    const d = deps(client);
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    registerLumberroomService(fake.api, d);
    await fake.services[0]!.stop?.({});
    expect(client.closes).toEqual([3000]);
  });

  it("start logs one error naming each open sidecar switch", async () => {
    const client = fakeClient();
    const d = deps(client);
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    (fake.api.config as Record<string, unknown>).plugins = {
      entries: { lumberroom: { config: { dreaming: { enabled: true } } }, "memory-core": {} },
    };
    registerLumberroomService(fake.api, d);
    await fake.services[0]!.start({});
    const errors = fake.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("can load beside lumberroom");
    expect(errors[0]!.message).toContain("plugins.entries.lumberroom.config.dreaming.enabled");
    expect(errors[0]!.message).toContain("plugins.entries.memory-core.enabled");
  });

  it("start logs no sidecar error when both switches are off", async () => {
    const client = fakeClient();
    const d = deps(client);
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    (fake.api.config as Record<string, unknown>).plugins = {
      entries: { lumberroom: { config: { dreaming: { enabled: false } } }, "memory-core": { enabled: false } },
    };
    registerLumberroomService(fake.api, d);
    await fake.services[0]!.start({});
    expect(fake.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  it("registers nothing outside registrationMode full", () => {
    const client = fakeClient();
    const d = deps(client);
    const fake = createFakeApi({ workspaceDir: "/tmp", registrationMode: "discovery" });
    registerLumberroomService(fake.api, d);
    expect(fake.services).toHaveLength(0);
  });
});
