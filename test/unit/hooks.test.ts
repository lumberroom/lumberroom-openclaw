import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config.js";
import { GUARD_REASON } from "../../src/guard.js";
import { registerGuard, registerHooks } from "../../src/hooks.js";
import { createState } from "../../src/state.js";
import type { CallMeta, CallResult, EngineClient, LumberroomConfig, PluginDeps } from "../../src/types.js";
import { createFakeApi } from "../fakes/api.js";

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
function fakeClient(reply: (name: string, args: Record<string, unknown>, meta: CallMeta) => CallResult | Promise<CallResult>): EngineClient & { calls: RecordedCall[]; lists: number } {
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

function deps(client: EngineClient, cfgOverrides: Record<string, unknown> = {}): PluginDeps {
  const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-hooks-"));
  const cfg: LumberroomConfig = resolveConfig(cfgOverrides);
  return {
    state: createState(cfg, null, stateDir),
    client,
    auth: null,
    stateDir,
    logger: { info() {}, warn() {} },
    now: () => 0,
  };
}

function setup(d: PluginDeps) {
  const fake = createFakeApi({ workspaceDir: "/tmp" });
  registerHooks(fake.api, d);
  return fake;
}

const CTX = { sessionKey: "agent:main:main", sessionId: "s-1", trigger: "user" };

describe("digestHandler", () => {
  it("is fetched once per session and returned byte-identical", async () => {
    const client = fakeClient(() => ok({ text: "Aditya prefers draft PRs." }));
    const d = deps(client);
    const fake = setup(d);
    const first = await fake.runHook("before_prompt_build", {}, CTX);
    const second = await fake.runHook("before_prompt_build", {}, CTX);
    expect(client.calls).toHaveLength(1);
    expect((first as { prependSystemContext: string }).prependSystemContext).toBe((second as { prependSystemContext: string }).prependSystemContext);
    expect((first as { prependSystemContext: string }).prependSystemContext).toContain("Aditya prefers draft PRs.");
  });

  it("retries next turn after a failed fetch", async () => {
    let attempt = 0;
    const client = fakeClient(() => {
      attempt += 1;
      return attempt === 1 ? fail("unreachable", "connection refused") : ok({ text: "recovered" });
    });
    const d = deps(client);
    const fake = setup(d);
    const first = await fake.runHook("before_prompt_build", {}, CTX);
    expect(first).toBeUndefined();
    const second = await fake.runHook("before_prompt_build", {}, CTX);
    expect((second as { prependSystemContext: string }).prependSystemContext).toContain("recovered");
    expect(client.calls).toHaveLength(2);
  });

  it("uses the hook invocation", async () => {
    const client = fakeClient(() => ok({ text: "x" }));
    const d = deps(client);
    const fake = setup(d);
    await fake.runHook("before_prompt_build", {}, CTX);
    expect(client.calls[0]!.meta.invocation).toBe("hook");
  });

  it("project auto sends the first activeProjectKeys entry", async () => {
    const client = fakeClient(() => ok({ text: "x" }));
    const d = deps(client, { project: "auto" });
    const fake = setup(d);
    await fake.runHook("before_prompt_build", {}, { ...CTX, activeProjectKeys: ["github.com/org/repo", "path:/abs/other"] });
    expect(client.calls[0]!.args.project).toBe("github.com/org/repo");
  });
});

describe("recallHandler", () => {
  function authority(d: PluginDeps, event: Record<string, unknown>, ctx: Record<string, unknown>, allows: string[] = ["memory_search"]) {
    const fake = setup(d);
    return { fake, run: () => fake.runHook("before_prompt_build", event, ctx, { requiresToolAuthority: true, allows }) };
  }

  it("a failed search leaves the cached digest in place", async () => {
    const client = fakeClient((name) => {
      if (name === "context_bootstrap") return ok({ text: "cached digest" });
      return fail("unreachable", "connection refused");
    });
    const d = deps(client);
    const fake = setup(d);
    const digestResult = await fake.runHook("before_prompt_build", {}, CTX);
    expect((digestResult as { prependSystemContext: string }).prependSystemContext).toContain("cached digest");
    await fake.runHook("before_prompt_build", { prompt: "hello" }, CTX, { requiresToolAuthority: true, allows: ["memory_search"] });
    const digestAgain = await fake.runHook("before_prompt_build", {}, CTX);
    expect((digestAgain as { prependSystemContext: string }).prependSystemContext).toContain("cached digest");
  });

  it("skips when toolAuthority does not allow memory_search", async () => {
    const client = fakeClient(() => ok({ namespaces: [], also_searched: [], hits: [] }));
    const d = deps(client);
    const { run } = authority(d, { prompt: "hello" }, CTX, []);
    const result = await run();
    expect(result).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it("skips an empty prompt and a slash command", async () => {
    const client = fakeClient(() => ok({ namespaces: [], also_searched: [], hits: [] }));
    const d = deps(client);
    const { run: runEmpty } = authority(d, { prompt: "" }, CTX);
    expect(await runEmpty()).toBeUndefined();
    const { run: runSlash } = authority(d, { prompt: "/help" }, CTX);
    expect(await runSlash()).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it("drops hits already injected this session", async () => {
    const hits = [
      { id: "a", namespace: "user:me", content: "First fact." },
      { id: "b", namespace: "user:me", content: "Second fact." },
    ];
    let call = 0;
    const client = fakeClient((name) => {
      if (name !== "memory_search") return ok();
      call += 1;
      return ok({ namespaces: [], also_searched: [], hits: call === 1 ? hits : hits });
    });
    const d = deps(client);
    const { run: runFirst } = authority(d, { prompt: "hello" }, CTX);
    const first = await runFirst();
    expect((first as { prependContext: string }).prependContext).toContain("First fact.");
    expect((first as { prependContext: string }).prependContext).toContain("Second fact.");
    const { run: runSecond } = authority(d, { prompt: "hello again" }, CTX);
    const second = await runSecond();
    expect(second).toBeUndefined();
  });

  it("uses the hook invocation", async () => {
    const client = fakeClient(() => ok({ namespaces: [], also_searched: [], hits: [] }));
    const d = deps(client);
    const { run } = authority(d, { prompt: "hello" }, CTX);
    await run();
    expect(client.calls[0]!.meta.invocation).toBe("hook");
  });

  it("the login line appears once per session", async () => {
    const client = fakeClient(() => fail("login_required", "lumberroom is not signed in. Run: openclaw lumberroom login"));
    const d = deps(client);
    const { run: runFirst } = authority(d, { prompt: "hello" }, CTX);
    const first = await runFirst();
    expect((first as { prependContext: string }).prependContext).toContain("lumberroom is not signed in");
    const { run: runSecond } = authority(d, { prompt: "hello again" }, CTX);
    expect(await runSecond()).toBeUndefined();
  });

  it("the inert line appears once per session", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-hooks-inert-"));
    const d: PluginDeps = {
      state: createState(null, "baseUrl must start with http", stateDir),
      client: null,
      auth: null,
      stateDir,
      logger: { info() {}, warn() {} },
      now: () => 0,
    };
    const { run: runFirst } = authority(d, { prompt: "hello" }, CTX);
    const first = await runFirst();
    expect((first as { prependContext: string }).prependContext).toContain("lumberroom is not configured");
    const { run: runSecond } = authority(d, { prompt: "hello again" }, CTX);
    expect(await runSecond()).toBeUndefined();
  });

  it("an allowed turn retries a degraded listing", async () => {
    const client = fakeClient(() => ok({ text: "digest" }));
    const d = deps(client);
    await setup(d).runHook("before_prompt_build", {}, CTX);
    expect(client.lists).toBe(1);
  });

  it("a refused turn makes no engine call", async () => {
    const client = fakeClient(() => ok());
    const d = deps(client, { ownerIds: [] });
    const groupCtx = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", trigger: "user" };
    const { run } = authority(d, { prompt: "hello" }, groupCtx);
    expect(await run()).toBeUndefined();
    expect(await setup(d).runHook("before_prompt_build", {}, groupCtx)).toBeUndefined();
    expect(d.state.listingSource).not.toBe("live");
    expect(client.calls).toHaveLength(0);
    expect(client.lists).toBe(0);
  });

  it("a stranger's room turn routed into the main session gets neither digest nor recall", async () => {
    const client = fakeClient(() => ok({ text: "owner digest", namespaces: [], also_searched: [], hits: [] }));
    const d: PluginDeps = { ...deps(client, { ownerIds: ["slack:UOWNER"] }), rootConfig: () => ({ session: { groupScope: "main" } }) };
    const ctx = { ...CTX, channel: "slack", senderId: "USTRANGER", chatId: "C0123TEAM" };
    const fake = setup(d);
    expect(await fake.runHook("before_prompt_build", { prompt: "hello" }, ctx)).toBeUndefined();
    expect(await fake.runHook("before_prompt_build", { prompt: "hello" }, ctx, { requiresToolAuthority: true, allows: ["memory_search"] })).toBeUndefined();
    expect(client.calls).toHaveLength(0);
    expect(client.lists).toBe(0);
  });

  it("a host config the plugin cannot read counts as rooms reaching the main session", async () => {
    const client = fakeClient(() => ok({ text: "owner digest" }));
    const d: PluginDeps = {
      ...deps(client, { ownerIds: ["slack:UOWNER"] }),
      rootConfig: () => {
        throw new Error("runtime unavailable");
      },
    };
    const fake = setup(d);
    expect(await fake.runHook("before_prompt_build", {}, { ...CTX, channel: "slack", senderId: "USTRANGER" })).toBeUndefined();
    expect(client.calls).toHaveLength(0);
    expect(client.lists).toBe(0);
  });

  it("the outage line appears once per outage and the breaker opens after three failures", async () => {
    const client = fakeClient(() => fail("unreachable", "connection refused"));
    const d = deps(client);
    const { run: r1 } = authority(d, { prompt: "one" }, CTX);
    const first = await r1();
    expect((first as { prependContext: string }).prependContext).toContain("lumberroom unreachable");

    const { run: r2 } = authority(d, { prompt: "two" }, CTX);
    expect(await r2()).toBeUndefined();

    const { run: r3 } = authority(d, { prompt: "three" }, CTX);
    expect(await r3()).toBeUndefined();
    expect(client.calls).toHaveLength(3);

    const { run: r4 } = authority(d, { prompt: "four" }, CTX);
    expect(await r4()).toBeUndefined();
    expect(client.calls).toHaveLength(3); // breaker open: no fourth attempt
  });

  it("the nudge appears every reviewInterval eligible turns", async () => {
    const client = fakeClient(() => ok({ namespaces: [], also_searched: [], hits: [] }));
    const d = deps(client, { reviewInterval: 2 });
    let last: unknown;
    for (let i = 0; i < 2; i += 1) {
      const { run } = authority(d, { prompt: `turn ${i}` }, CTX);
      last = await run();
    }
    expect((last as { prependContext: string }).prependContext).toContain("Review the recent turns.");
  });
});

describe("session_end", () => {
  it("forgets the session", async () => {
    const client = fakeClient(() => ok({ text: "digest text" }));
    const d = deps(client);
    const fake = setup(d);
    await fake.runHook("before_prompt_build", {}, CTX);
    expect(d.state.digests.get("s-1")).toBeDefined();
    await fake.runHook("session_end", {}, CTX);
    expect(d.state.digests.get("s-1")).toBeUndefined();
  });
});

describe("registerGuard", () => {
  it("blocks MEMORY.md in the agent's workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lumberroom-guard-hook-"));
    writeFileSync(join(ws, "MEMORY.md"), "x");
    const fake = createFakeApi({ workspaceDir: ws });
    registerGuard(fake.api, () => ws);
    const result = await fake.runHook("before_tool_call", { toolName: "write", params: { path: "MEMORY.md" } }, { agentId: "main" });
    expect(result).toEqual({ block: true, blockReason: GUARD_REASON });
  });

  it("blocks when resolving the workspace throws", async () => {
    const fake = createFakeApi({ workspaceDir: "/tmp" });
    registerGuard(fake.api, () => {
      throw new Error("no workspace");
    });
    const result = await fake.runHook("before_tool_call", { toolName: "write", params: { path: "notes.md" } }, { agentId: "main" });
    expect(result).toEqual({ block: true, blockReason: GUARD_REASON });
  });

  it("registers while the config is invalid", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lumberroom-guard-invalid-"));
    mkdirSync(join(ws, "memory"));
    const fake = createFakeApi({ workspaceDir: ws });
    registerGuard(fake.api, () => ws);
    const result = await fake.runHook("before_tool_call", { toolName: "write", params: { path: "memory/fact.md" } }, { agentId: "main" });
    expect(result).toEqual({ block: true, blockReason: GUARD_REASON });
  });
});
