import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, discoverOAuthServerInfo, refreshAuthorization, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeApi } from "../fakes/api.js";
import { startFakeEngine, type FakeEngine } from "../fakes/engine.js";

const TRANSCRIPT_TOOLS = [
  "alias_list", "context_bootstrap", "memory_forget", "memory_search",
  "memory_write", "registry_get", "review_decide", "review_queue",
];
const SNAPSHOT = JSON.parse(readFileSync(new URL("../../tools-snapshot.json", import.meta.url), "utf8")) as {
  instructions: string;
};

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function engine(opts?: Parameters<typeof startFakeEngine>[0]): Promise<FakeEngine> {
  const e = await startFakeEngine(opts);
  open.push(e);
  return e;
}

async function connect(e: FakeEngine, bearer: string | null, headers: Record<string, string> = {}): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "fakes-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${e.url}/mcp`), {
    requestInit: { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers } },
  });
  await client.connect(transport);
  open.push(client);
  return { client, transport };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe("fake engine in token mode", () => {
  it("the SDK client completes the transcript's handshake and lists its eight tools", async () => {
    const e = await engine({ bearer: "t" });
    const { client, transport } = await connect(e, "t");
    expect(client.getServerVersion()).toEqual({ name: "rmcp", version: "3.2.0" });
    expect(transport.protocolVersion).toBe("2025-11-25");
    expect(transport.sessionId).toBeUndefined();
    expect(client.getInstructions()).toBe(SNAPSHOT.instructions);
    const listing = await client.listTools();
    expect(listing.tools.map((t) => t.name)).toEqual(TRANSCRIPT_TOOLS);
  });

  it("the engine answers the GET stream with 405 as the real engine did", async () => {
    const e = await engine({ bearer: "t" });
    await connect(e, "t");
    // The SDK opens the GET stream after initialized without awaiting it (S4).
    await vi.waitFor(() => expect(e.requests.some((r) => r.method === "GET" && r.path === "/mcp")).toBe(true));
    const res = await fetch(`${e.url}/mcp`, { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(405);
  });

  it("memory_write, memory_search and context_bootstrap answer in the engine's shapes", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    const first = structured(await client.callTool({ name: "memory_write", arguments: { content: "Prefers draft PRs for engine changes.", namespace: "user:me" } }));
    expect(first).toMatchObject({ namespace: "user:me", sensitivity: "open", deduplicated: false });
    expect(first.possible_conflicts).toBeUndefined();
    const again = structured(await client.callTool({ name: "memory_write", arguments: { content: "prefers draft PRs for engine changes.", namespace: "global" } }));
    expect(again.possible_conflicts).toEqual([
      { id: first.id, namespace: "user:me", content: "Prefers draft PRs for engine changes.", similarity: 1 },
    ]);
    expect(e.memories).toHaveLength(2);

    const found = structured(await client.callTool({ name: "memory_search", arguments: { query: "which PRs do I want", limit: 1 } }));
    expect(found.namespaces).toEqual(["user:me", "global"]);
    expect(found.also_searched).toEqual([]);
    const hits = found.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: first.id, namespace: "user:me", content: "Prefers draft PRs for engine changes.", source: "fake-engine", primary: true });
    expect(Object.keys(hits[0]!)).toEqual(expect.arrayContaining(["tags", "sensitivity", "created_at", "score", "similarity"]));

    const digest = structured(await client.callTool({ name: "context_bootstrap", arguments: {} }));
    expect(digest.text).toContain("Prefers draft PRs for engine changes.");
  });

  it("a hit carries occurred_at only when the write gave one", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    await client.callTool({ name: "memory_write", arguments: { content: "Moved to Postgres 16.", namespace: "global", occurred_at: "2026-06-04" } });
    await client.callTool({ name: "memory_write", arguments: { content: "Postgres runs on port 5433.", namespace: "global" } });
    const hits = structured(await client.callTool({ name: "memory_search", arguments: { query: "postgres" } })).hits as Array<Record<string, unknown>>;
    expect(hits.map((h) => h.occurred_at)).toEqual(["2026-06-04", undefined]);
  });

  it("an unimplemented tool and a queued isError come back as isError with the engine's text", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    const other = await client.callTool({ name: "registry_get", arguments: { kind: "host", key: "x" } });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/^registry_get failed: /);

    e.next({ route: "mcp", tool: "memory_write", isError: "the credential tripwire refused it" });
    const search = await client.callTool({ name: "memory_search", arguments: { query: "x" } });
    expect(search.isError).toBe(false);
    const write = await client.callTool({ name: "memory_write", arguments: { content: "x y z", namespace: "global" } });
    expect(write.isError).toBe(true);
    expect(text(write)).toBe("memory_write failed: the credential tripwire refused it");
    expect(e.memories).toHaveLength(0);
    const retry = await client.callTool({ name: "memory_write", arguments: { content: "x y z", namespace: "global" } });
    expect(retry.isError).toBe(false);
  });

  it("a wrong bearer gets 401 and the handshake fails", async () => {
    const e = await engine({ bearer: "t" });
    await expect(connect(e, "wrong")).rejects.toThrow();
    const res = await fetch(`${e.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("every request lands in requests with lower-case headers and a parsed body", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t", { "x-memory-invocation": "hook", "x-session-id": "s-1" });
    await client.callTool({ name: "memory_search", arguments: { query: "anything" } });
    const call = e.requests.find((r) => (r.body as { method?: string } | null)?.method === "tools/call");
    expect(call).toMatchObject({ method: "POST", path: "/mcp" });
    expect(call!.headers["x-memory-invocation"]).toBe("hook");
    expect(call!.headers["x-session-id"]).toBe("s-1");
    expect(call!.headers.authorization).toBe("Bearer t");
    expect(call!.body).toMatchObject({ params: { name: "memory_search", arguments: { query: "anything" } } });
    expect(typeof call!.at).toBe("number");
  });

  it("a queued status answers the next POST once and is recorded first", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    await vi.waitFor(() => expect(e.requests.some((r) => r.method === "GET")).toBe(true));
    const before = e.requests.length;
    e.next({ route: "mcp", status: 502, body: "Bad Gateway" });
    await expect(client.callTool({ name: "memory_write", arguments: { content: "lost", namespace: "global" } })).rejects.toMatchObject({ code: 502 });
    expect(e.requests.length).toBe(before + 1);
    expect(e.memories).toHaveLength(0);
    const ok = await client.callTool({ name: "memory_write", arguments: { content: "kept", namespace: "global" } });
    expect(ok.isError).toBe(false);
  });

  it("a dropped socket after the body still performs the write", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    e.next({ route: "mcp", dropAfterBody: true });
    await expect(client.callTool({ name: "memory_write", arguments: { content: "maybe stored", namespace: "global" } })).rejects.toThrow();
    expect(e.memories.map((m) => m.content)).toEqual(["maybe stored"]);
  });

  it("a delayed answer outlives a short request timeout and the write still lands", async () => {
    const e = await engine({ bearer: "t" });
    const { client } = await connect(e, "t");
    e.next({ route: "mcp", delayMs: 400 });
    await expect(
      client.callTool({ name: "memory_write", arguments: { content: "slow", namespace: "global" } }, undefined, { timeout: 100 }),
    ).rejects.toThrow(/timed out/i);
    expect(e.memories.map((m) => m.content)).toEqual(["slow"]);
  });

  it("a tools filter narrows tools/list and a null bearer accepts a request with no credential", async () => {
    const e = await engine({ bearer: null, tools: ["memory_write", "memory_search"] });
    const { client } = await connect(e, null);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["memory_search", "memory_write"]);
    const refused = await client.callTool({ name: "memory_forget", arguments: { id: "x", reason: "y" } });
    expect(refused.isError).toBe(true);
  });

  it("admin whoami and the ingest routes answer in the engine's shapes", async () => {
    const e = await engine({ bearer: "t" });
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    const who = await fetch(`${e.url}/admin/whoami`, { headers });
    expect(await who.json()).toMatchObject({ may_ingest: true, may_delete: true });

    const run = await (await fetch(`${e.url}/admin/ingest/runs`, { method: "POST", headers, body: JSON.stringify({ extractor: "openclaw-builtin-import", scope: {} }) })).json() as { run_id: string };
    expect(run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    const fact = {
      content: "Prefers tabs.", namespace: "global", tags: ["openclaw-import"], speaker: "main_model", span_text: "Prefers tabs.",
      source: { file_path: "/ws/MEMORY.md", entry_uuid: "abc", run_id: run.run_id },
    };
    const post = (body: unknown) => fetch(`${e.url}/admin/ingest/proposals`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post({ extractor: "openclaw-builtin-import", facts: [fact] })).toMatchObject({ proposals_new: 1, proposals_reinforced: 0, outcomes: [{ outcome: "proposed", auto: false }] });
    expect(await post({ extractor: "openclaw-builtin-import", facts: [fact] })).toMatchObject({ proposals_new: 0, proposals_reinforced: 1, outcomes: [{ outcome: "reinforced" }] });
    expect(e.proposals).toHaveLength(1);
    expect(e.proposals[0]).toMatchObject({ content: "Prefers tabs.", speaker: "main_model", extractor: "openclaw-builtin-import" });

    const close = await fetch(`${e.url}/admin/ingest/runs/${run.run_id}/close`, { method: "POST", headers, body: JSON.stringify({ entries_seen: 1, proposals_new: 1, proposals_reinforced: 0 }) });
    expect(await close.json()).toEqual({ closed: true });
  });

  it("a grant without ingest gets 403 from the ingest routes and whoami says so", async () => {
    const e = await engine({ bearer: "t", mayIngest: false, tools: ["memory_search"] });
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    expect(await (await fetch(`${e.url}/admin/whoami`, { headers })).json()).toMatchObject({ may_ingest: false, may_delete: false });
    const run = await fetch(`${e.url}/admin/ingest/runs`, { method: "POST", headers, body: JSON.stringify({ extractor: "x" }) });
    expect(run.status).toBe(403);
    expect(await run.json()).toMatchObject({ error: "forbidden" });
  });
});

class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authUrl: URL | undefined;
  readonly stateValue = `state-${Math.random().toString(36).slice(2)}`;
  get redirectUrl(): string {
    return "http://127.0.0.1:47632/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "fakes test",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    return this.stateValue;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.info = info;
  }
  tokens(): OAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authUrl = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

async function signIn(e: FakeEngine): Promise<MemoryProvider> {
  const provider = new MemoryProvider();
  const serverUrl = `${e.url}/mcp`;
  expect(await auth(provider, { serverUrl })).toBe("REDIRECT");
  const redirect = new URL(await e.authorize(provider.authUrl!.href));
  expect(redirect.searchParams.get("state")).toBe(provider.stateValue);
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();
  expect(await auth(provider, { serverUrl, authorizationCode: code! })).toBe("AUTHORIZED");
  return provider;
}

describe("fake engine in OAuth mode", () => {
  it("the SDK signs in through discovery, registration and PKCE, then calls tools with the bearer", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const provider = await signIn(e);
    expect(provider.saved).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(provider.saved!.refresh_token).toBeTruthy();

    const exchange = e.requests.find((r) => r.path === "/oauth/token");
    expect(exchange!.body).toMatchObject({ grant_type: "authorization_code", resource: `${e.url}/mcp`, client_id: (provider.info as { client_id: string }).client_id });

    const { client } = await connect(e, provider.saved!.access_token);
    expect((await client.listTools()).tools).toHaveLength(8);
    const written = await client.callTool({ name: "memory_write", arguments: { content: "OAuth works end to end.", namespace: "global" } });
    expect(written.isError).toBe(false);
  });

  it("a request without a token gets 401 with a resource_metadata challenge", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const res = await fetch(`${e.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${e.url}/.well-known/oauth-protected-resource"`);
    const stale = await fetch(`${e.url}/mcp`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(stale.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("a refresh rotates the pair and a replay of the spent token revokes the family", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const provider = await signIn(e);
    const info = await discoverOAuthServerInfo(`${e.url}/mcp`);
    const spent = provider.saved!.refresh_token!;
    const rotated = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: provider.info!,
      refreshToken: spent,
      resource: new URL(`${e.url}/mcp`),
    });
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(spent);
    expect(e.refreshGrants).toBe(1);
    expect(e.replays).toBe(0);
    const { client } = await connect(e, rotated.access_token);
    await client.listTools();

    const replay = refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: provider.info!,
      refreshToken: spent,
      resource: new URL(`${e.url}/mcp`),
    });
    await expect(replay).rejects.toBeInstanceOf(InvalidGrantError);
    expect(e.refreshGrants).toBe(2);
    expect(e.replays).toBe(1);
    const revoked = await fetch(`${e.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${rotated.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(revoked.status).toBe(401);
  });

  it("a refresh for another resource is refused before the token is spent", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const provider = await signIn(e);
    const info = await discoverOAuthServerInfo(`${e.url}/mcp`);
    const args = { metadata: info.authorizationServerMetadata, clientInformation: provider.info!, refreshToken: provider.saved!.refresh_token! };
    await expect(refreshAuthorization(info.authorizationServerUrl, { ...args, resource: new URL("https://elsewhere.example/mcp") })).rejects.toThrow();
    await expect(refreshAuthorization(info.authorizationServerUrl, { ...args, resource: new URL(`${e.url}/mcp`) })).resolves.toMatchObject({ token_type: "Bearer" });
    expect(e.replays).toBe(0);
  });

  it("a dropped token answer still rotates, so presenting the old token again is a replay", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const provider = await signIn(e);
    const info = await discoverOAuthServerInfo(`${e.url}/mcp`);
    const args = { metadata: info.authorizationServerMetadata, clientInformation: provider.info!, refreshToken: provider.saved!.refresh_token!, resource: new URL(`${e.url}/mcp`) };
    e.next({ route: "token", dropAfterBody: true });
    await expect(refreshAuthorization(info.authorizationServerUrl, args)).rejects.toThrow();
    await expect(refreshAuthorization(info.authorizationServerUrl, args)).rejects.toBeInstanceOf(InvalidGrantError);
    expect(e.replays).toBe(1);
  });

  it("an access token past its lifetime gets 401", async () => {
    const e = await engine({ oauth: { accessTtlSec: 1, autoConsent: true } });
    const provider = await signIn(e);
    const call = () => fetch(`${e.url}/admin/whoami`, { headers: { authorization: `Bearer ${provider.saved!.access_token}` } });
    expect((await call()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call()).status).toBe(401);
  });

  it("without autoConsent the redirect carries access_denied and no code", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: false } });
    const provider = new MemoryProvider();
    expect(await auth(provider, { serverUrl: `${e.url}/mcp` })).toBe("REDIRECT");
    const redirect = new URL(await e.authorize(provider.authUrl!.href));
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("code")).toBeNull();
    expect(redirect.searchParams.get("state")).toBe(provider.stateValue);
  });

  it("a queued status on the token route answers once without rotating", async () => {
    const e = await engine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const provider = await signIn(e);
    const info = await discoverOAuthServerInfo(`${e.url}/mcp`);
    const args = { metadata: info.authorizationServerMetadata, clientInformation: provider.info!, refreshToken: provider.saved!.refresh_token!, resource: new URL(`${e.url}/mcp`) };
    e.next({ route: "token", status: 503, body: { error: "temporarily_unavailable" } });
    await expect(refreshAuthorization(info.authorizationServerUrl, args)).rejects.toThrow();
    await expect(refreshAuthorization(info.authorizationServerUrl, args)).resolves.toMatchObject({ token_type: "Bearer" });
    expect(e.replays).toBe(0);
  });
});

describe("fake OpenClaw api", () => {
  it("records registrations and logs", () => {
    const fake = createFakeApi({ pluginConfig: { recall: false } });
    const factory = () => null;
    fake.api.registerTool(factory, { names: ["memory_search"] });
    fake.api.on("session_end", () => undefined);
    fake.api.registerMemoryCapability({ flushPlanResolver: () => null });
    fake.api.registerService({ id: "lumberroom", start: () => undefined });
    fake.api.registerCli(() => undefined, { descriptors: [{ name: "lumberroom", description: "d", hasSubcommands: true }] });
    fake.api.logger.warn("careful");
    fake.api.logger.error("broken");
    expect(fake.api.pluginConfig).toEqual({ recall: false });
    expect(fake.api.registrationMode).toBe("full");
    expect(fake.tools).toEqual([{ factory, opts: { names: ["memory_search"] } }]);
    expect(fake.hooks.map((h) => h.name)).toEqual(["session_end"]);
    expect(fake.capability).toMatchObject({ flushPlanResolver: expect.any(Function) });
    expect(fake.services.map((s) => s.id)).toEqual(["lumberroom"]);
    expect(fake.cli).toHaveLength(1);
    expect(fake.logs).toEqual([
      { level: "warn", message: "careful" },
      { level: "error", message: "broken" },
    ]);
  });

  it("an unrecorded register method throws naming itself", () => {
    const fake = createFakeApi({});
    expect(() => fake.api.registerHttpRoute({} as never)).toThrow(/registerHttpRoute/);
  });

  it("runHook runs the ordinary phase apart from the tool-authority phase, as the host does", async () => {
    const fake = createFakeApi({});
    fake.api.on("before_prompt_build", () => ({ prependSystemContext: "digest" }));
    fake.api.on(
      "before_prompt_build",
      (_event, ctx) => ({
        prependContext: `search allowed: ${(ctx as { toolAuthority: { allows(n: string): boolean } }).toolAuthority.allows("memory_search")}`,
        prependSystemContext: "dropped by the host",
      }),
      { requiresToolAuthority: true },
    );
    expect(await fake.runHook("before_prompt_build", { prompt: "hi" }, {})).toEqual({ prependSystemContext: "digest" });
    expect(await fake.runHook("before_prompt_build", { prompt: "hi" }, {}, { requiresToolAuthority: true, allows: ["memory_search"] })).toEqual({
      prependContext: "search allowed: true",
    });
    expect(await fake.runHook("before_prompt_build", { prompt: "hi" }, {}, { requiresToolAuthority: true, allows: [] })).toEqual({
      prependContext: "search allowed: false",
    });
  });

  it("runHook applies a before_tool_call matcher to the event's tool name", async () => {
    const fake = createFakeApi({});
    fake.api.on("before_tool_call", () => ({ block: true, blockReason: "no" }), { matcher: ["write", "edit"] });
    expect(await fake.runHook("before_tool_call", { toolName: "write", params: {} }, {})).toEqual({ block: true, blockReason: "no" });
    expect(await fake.runHook("before_tool_call", { toolName: "read", params: {} }, {})).toBeUndefined();
  });

  it("resolveTools calls every factory with the context and drops a null result", () => {
    const fake = createFakeApi({});
    const seen: unknown[] = [];
    fake.api.registerTool((ctx) => {
      seen.push(ctx);
      return [
        { name: "memory_search", label: "memory_search", description: "d", parameters: {} as never, execute: async () => ({ content: [], details: {} }) },
      ];
    }, { names: ["memory_search"] });
    fake.api.registerTool(() => null, { names: ["memory_write"] });
    const tools = fake.resolveTools({ sessionKey: "agent:main:main" });
    expect(tools.map((t) => t.name)).toEqual(["memory_search"]);
    expect(seen).toEqual([{ sessionKey: "agent:main:main" }]);
  });

  it("runtime resolves the workspace from the option and lets a test replace it", () => {
    const fake = createFakeApi({ workspaceDir: "/tmp/ws" });
    // runtime.config.current() returns DeepReadonly<OpenClawConfig>; resolveAgentWorkspaceDir takes the mutable type.
    const current = fake.api.runtime.config.current() as OpenClawConfig;
    expect(fake.api.runtime.agent.resolveAgentWorkspaceDir(current, "main")).toBe("/tmp/ws");
    fake.api.runtime.agent.resolveAgentWorkspaceDir = () => "/tmp/other";
    expect(fake.api.runtime.agent.resolveAgentWorkspaceDir(current, "main")).toBe("/tmp/other");
    fake.api.runtime.config.current = () => ({ plugins: { slots: { memory: "lumberroom" } } }) as never;
    expect(fake.api.runtime.config.current()).toEqual({ plugins: { slots: { memory: "lumberroom" } } });
  });

  it("cli-metadata registration throws on any runtime access, as the host leaves it unavailable", () => {
    const fake = createFakeApi({ registrationMode: "cli-metadata" });
    expect(() => fake.api.runtime).toThrow(/cli-metadata/);
  });
});
