import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFailure, neverSent, toolResult } from "../../src/client/classify.js";
import { createEngineClient } from "../../src/client/mcp.js";
import { resolveConfig } from "../../src/config.js";
import { FenceTimeout, LoginRequired, RefreshUnavailable, TokenSaveFailed } from "../../src/errors.js";
import type { AuthHandle, CallMeta, EngineClient } from "../../src/types.js";
import { startFakeEngine, type FakeEngine, type RecordedRequest } from "../fakes/engine.js";

// Every transport the client builds is recorded here, so a test can read the options it received.
const transportOptions = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>);
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js")>();
  type Opts = ConstructorParameters<typeof real.StreamableHTTPClientTransport>[1];
  class RecordingTransport extends real.StreamableHTTPClientTransport {
    constructor(url: URL, opts?: Opts) {
      transportOptions.push(opts as Record<string, unknown> | undefined);
      super(url, opts);
    }
  }
  return { ...real, StreamableHTTPClientTransport: RecordingTransport };
});

const SNAPSHOT = JSON.parse(readFileSync(new URL("../../tools-snapshot.json", import.meta.url), "utf8")) as {
  instructions: string;
  tools: Array<{ name: string }>;
};

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  transportOptions.length = 0;
});

async function engine(opts?: Parameters<typeof startFakeEngine>[0]): Promise<FakeEngine> {
  const e = await startFakeEngine(opts);
  open.push(e);
  return e;
}

interface StubAuth extends AuthHandle {
  header: string;
  fail: Error | null;
  jitterMs: number;
  delayMs: number;
  rejectedWith: string[];
  settleCalls: number[];
  settleGate: Promise<void> | null;
}

function stubAuth(header = "Bearer t"): StubAuth {
  const s: StubAuth = {
    mode: "token",
    header,
    fail: null,
    jitterMs: 0,
    delayMs: 0,
    rejectedWith: [],
    settleCalls: [],
    settleGate: null,
    async authorize() {
      if (s.jitterMs) await sleep(Math.floor(Math.random() * s.jitterMs));
      if (s.delayMs) await sleep(s.delayMs);
      if (s.fail) throw s.fail;
      return s.header;
    },
    rejected(authorization: string) {
      s.rejectedWith.push(authorization);
    },
    async settle(timeoutMs: number) {
      s.settleCalls.push(timeoutMs);
      await s.settleGate;
    },
  };
  return s;
}

function client(url: string, auth: AuthHandle = stubAuth(), opts: { fetch?: typeof globalThis.fetch } = {}): EngineClient {
  const cfg = resolveConfig({ baseUrl: url, auth: "token", token: "t" });
  const c = createEngineClient(cfg, auth, { version: "9.9.9", pid: 4242, ...opts });
  open.push({ close: () => c.close(0) });
  return c;
}

const hook = (sessionId?: string, timeoutMs = 5000): CallMeta => ({ invocation: "hook", timeoutMs, ...(sessionId ? { sessionId } : {}) });
const model = (sessionId?: string, timeoutMs = 5000): CallMeta => ({ invocation: "model", timeoutMs, ...(sessionId ? { sessionId } : {}) });

function rpc(r: RecordedRequest): { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } {
  return (r.body ?? {}) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}
// Records every request that reaches the real fetch, which is the last point before the network.
function recordingFetch(): { fetch: typeof globalThis.fetch; methods(): string[] } {
  const bodies: unknown[] = [];
  return {
    fetch: (input, init) => {
      bodies.push(init?.body);
      return fetch(input, init);
    },
    methods: () =>
      bodies.flatMap((b) => {
        try {
          return typeof b === "string" ? [String((JSON.parse(b) as { method?: unknown }).method)] : [];
        } catch {
          return [];
        }
      }),
  };
}
const calls = (e: FakeEngine) => e.requests.filter((r) => rpc(r).method === "tools/call");
const inits = (e: FakeEngine) => e.requests.filter((r) => rpc(r).method === "initialize");

describe("headers", () => {
  it("hook calls carry x-memory-invocation hook and the session id", async () => {
    const e = await engine({ bearer: "t" });
    const r = await client(e.url).callTool("memory_search", { query: "x" }, hook("s-1"));
    expect(r.kind).toBe("ok");
    const call = calls(e)[0]!;
    expect(call.headers["x-memory-invocation"]).toBe("hook");
    expect(call.headers["x-session-id"]).toBe("s-1");
    expect(call.headers.authorization).toBe("Bearer t");
    expect(call.headers["user-agent"]).toBe("lumberroom-openclaw/9.9.9");
    expect(inits(e)[0]!.headers["x-memory-invocation"]).toBe("hook");
    expect((rpc(inits(e)[0]!).params as unknown as { clientInfo: unknown }).clientInfo).toEqual({ name: "lumberroom-openclaw", version: "9.9.9" });
  });

  it("model calls carry no invocation header", async () => {
    const e = await engine({ bearer: "t" });
    const r = await client(e.url).callTool("memory_search", { query: "x" }, model("s-2"));
    expect(r.kind).toBe("ok");
    for (const req of e.requests.filter((q) => q.path === "/mcp")) {
      expect(req.headers["x-memory-invocation"]).toBeUndefined();
    }
    expect(calls(e)[0]!.headers["x-session-id"]).toBe("s-2");
  });

  it("cli calls carry x-memory-invocation cli", async () => {
    const e = await engine({ bearer: "t" });
    const r = await client(e.url).callTool("memory_search", { query: "x" }, { invocation: "cli", timeoutMs: 5000 });
    expect(r.kind).toBe("ok");
    expect(calls(e)[0]!.headers["x-memory-invocation"]).toBe("cli");
    expect(calls(e)[0]!.headers["x-session-id"]).toBe("cli-4242");
  });

  it("a session id longer than 128 characters is clipped", async () => {
    const e = await engine({ bearer: "t" });
    const long = "agent:main:telegram:direct:" + "9".repeat(300);
    await client(e.url).callTool("memory_search", { query: "x" }, hook(long));
    expect(calls(e)[0]!.headers["x-session-id"]).toBe(long.slice(0, 128));
  });

  it("a session id with characters a header cannot carry still reaches the engine", async () => {
    const e = await engine({ bearer: "t" });
    const r = await client(e.url).callTool("memory_search", { query: "x" }, hook("agent:main:ünïcode\n"));
    expect(r.kind).toBe("ok");
    expect(calls(e)[0]!.headers["x-session-id"]).toMatch(/^agent:main:[\x21-\x7e]+$/);
  });

  it("concurrent calls with different session ids keep their own headers", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth();
    auth.jitterMs = 15;
    const c = client(e.url, auth);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        c.callTool("memory_search", { query: `q-${i}` }, i % 2 ? model(`s-${i}`) : hook(`s-${i}`)),
      ),
    );
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    const seen = calls(e);
    expect(seen).toHaveLength(12);
    for (const req of seen) {
      const i = Number(String(rpc(req).params!.arguments!.query).slice(2));
      expect(req.headers["x-session-id"]).toBe(`s-${i}`);
      expect(req.headers["x-memory-invocation"]).toBe(i % 2 ? undefined : "hook");
    }
  });
});

describe("the MCP session", () => {
  it("the transport receives no auth provider", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.callTool("memory_search", { query: "x" }, hook());
    await c.callTool("memory_search", { query: "x" }, model());
    expect(transportOptions).toHaveLength(2);
    for (const o of transportOptions) {
      expect(o).toBeDefined();
      expect(o!.authProvider).toBeUndefined();
      expect(typeof o!.fetch).toBe("function");
    }
  });

  it("the handshake runs once per invocation kind", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await Promise.all([
      c.callTool("memory_search", { query: "a" }, hook()),
      c.callTool("memory_search", { query: "b" }, hook()),
      c.listTools(hook()),
    ]);
    await c.callTool("memory_search", { query: "c" }, model());
    await c.callTool("memory_search", { query: "d" }, model());
    expect(inits(e).map((r) => r.headers["x-memory-invocation"])).toEqual(["hook", undefined]);
  });

  it("listTools returns instructions, serverInfo and protocol 2025-11-25 from the transcript", async () => {
    const e = await engine({ bearer: "t" });
    const { result, listing } = await client(e.url).listTools(hook());
    expect(result.kind).toBe("ok");
    expect(listing).not.toBeNull();
    expect(listing!.instructions).toBe(SNAPSHOT.instructions);
    expect(listing!.serverInfo).toEqual({ name: "rmcp", version: "3.2.0" });
    expect(listing!.protocolVersion).toBe("2025-11-25");
    expect(listing!.tools.map((t) => t.name)).toEqual(SNAPSHOT.tools.map((t) => t.name));
    expect(typeof listing!.tools[0]!.inputSchema).toBe("object");
  });

  it("a failed listTools returns no listing", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(hook());
    e.next({ route: "mcp", status: 503 });
    const { result, listing } = await c.listTools(hook());
    expect(result.kind).toBe("unreachable");
    expect(listing).toBeNull();
  });

  it("a structured result comes back as ok with structuredContent", async () => {
    const e = await engine({ bearer: "t" });
    const r = await client(e.url).callTool("memory_write", { content: "Prefers draft PRs.", namespace: "user:me" }, model());
    expect(r.kind).toBe("ok");
    expect(r.error).toBeNull();
    expect(r.structured).toMatchObject({ id: e.memories[0]!.id, namespace: "user:me", deduplicated: false });
    expect(r.text).toContain(e.memories[0]!.id);
    expect(r.status).toBe(200);
  });

  it("an isError result is a tool_error with the engine's text", async () => {
    const e = await engine({ bearer: "t" });
    e.next({ route: "mcp", tool: "memory_write", isError: "the credential tripwire refused it" });
    const r = await client(e.url).callTool("memory_write", { content: "x y z", namespace: "global" }, model());
    expect(r.kind).toBe("tool_error");
    expect(r.text).toBe("memory_write failed: the credential tripwire refused it");
    expect(r.error).toBe("memory_write failed: the credential tripwire refused it");
    expect(e.memories).toHaveLength(0);
  });
});

describe("failure classes", () => {
  it("connection refused is unreachable and never sent", async () => {
    const e = await startFakeEngine({ bearer: "t" });
    const url = e.url;
    await e.close();
    const errors: unknown[] = [];
    const recording: typeof globalThis.fetch = async (input, init) => {
      try {
        return await fetch(input, init);
      } catch (err) {
        errors.push(err);
        throw err;
      }
    };
    const r = await client(url, stubAuth(), { fetch: recording }).callTool("memory_write", { content: "x", namespace: "global" }, model());
    expect(r.kind).toBe("unreachable");
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(errors.length).toBeGreaterThan(0);
    expect(neverSent(errors[0])).toBe(true);
  });

  it("a proxy 502 on memory_write is unreachable", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", status: 502, body: "Bad Gateway" });
    const r = await c.callTool("memory_write", { content: "lost", namespace: "global" }, model());
    expect(r.kind).toBe("unreachable");
    expect(r.status).toBe(502);
    expect(e.memories).toHaveLength(0);
  });

  it("a 503 is unreachable", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", status: 503 });
    const r = await c.callTool("memory_search", { query: "x" }, model());
    expect(r.kind).toBe("unreachable");
    expect(r.status).toBe(503);
  });

  it("a 500 after send is a timeout", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", status: 500 });
    const r = await c.callTool("memory_write", { content: "maybe", namespace: "global" }, model());
    expect(r.kind).toBe("timeout");
    expect(r.status).toBe(500);
  });

  it("a 500 during the handshake is unreachable", async () => {
    const e = await engine({ bearer: "t" });
    e.next({ route: "mcp", status: 500 });
    const r = await client(e.url).callTool("memory_write", { content: "x", namespace: "global" }, model());
    expect(r.kind).toBe("unreachable");
    expect(calls(e)).toHaveLength(0);
  });

  it("a socket dropped after the body was read is a timeout", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", dropAfterBody: true });
    const r = await c.callTool("memory_write", { content: "landed", namespace: "global" }, model());
    expect(r.kind).toBe("timeout");
    expect(r.status).toBeNull();
    expect(e.memories.map((m) => m.content)).toEqual(["landed"]);
  });

  it("a deadline that passes after send is a timeout", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", delayMs: 3000 });
    const started = Date.now();
    const r = await c.callTool("memory_write", { content: "slow", namespace: "global" }, model(undefined, 300));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.kind).toBe("timeout");
    expect(e.memories.map((m) => m.content)).toEqual(["slow"]);
  });

  it("a timed-out call sends no cancellation to the stateless engine", async () => {
    const e = await engine({ bearer: "t" });
    const sent = recordingFetch();
    const c = client(e.url, stubAuth(), { fetch: sent.fetch });
    await c.listTools(model());
    e.next({ route: "mcp", delayMs: 1000 });
    expect((await c.callTool("memory_search", { query: "x" }, model(undefined, 200))).kind).toBe("timeout");
    await sleep(300);
    expect(sent.methods()).not.toContain("notifications/cancelled");
  });

  it("a 401 is unauthorized and tells the auth handle", async () => {
    const e = await engine({ oauth: { accessTtlSec: 60, autoConsent: true } });
    const auth = stubAuth("Bearer stale");
    const r = await client(e.url, auth).callTool("memory_search", { query: "x" }, model());
    expect(r.kind).toBe("unauthorized");
    expect(r.status).toBe(401);
    expect(auth.rejectedWith).toContain("Bearer stale");
    // With an auth provider the SDK would follow the challenge into discovery and a grant.
    expect(e.requests.filter((q) => q.path !== "/mcp")).toEqual([]);
  });

  it("LoginRequired from the auth handle is login_required and sends nothing", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth();
    auth.fail = new LoginRequired();
    const c = client(e.url, auth);
    const r = await c.callTool("memory_write", { content: "x", namespace: "global" }, model());
    expect(r.kind).toBe("login_required");
    expect(r.error).toMatch(/openclaw lumberroom login/);
    const listed = await c.listTools(hook());
    expect(listed.result.kind).toBe("login_required");
    expect(e.requests).toEqual([]);
  });

  it("a deadline that passes while auth waits is unreachable and sends nothing", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth();
    const sent = recordingFetch();
    const c = client(e.url, auth, { fetch: sent.fetch });
    await c.listTools(model());
    auth.delayMs = 500;
    const r = await c.callTool("memory_write", { content: "x", namespace: "global" }, model(undefined, 200));
    expect(r.kind).toBe("unreachable");
    await sleep(500);
    expect(sent.methods()).not.toContain("tools/call");
  });

  it("FenceTimeout from the auth handle is unreachable", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth();
    const c = client(e.url, auth);
    await c.listTools(model());
    auth.fail = new FenceTimeout("/state/lumberroom/oauth.lock");
    const r = await c.callTool("memory_write", { content: "x", namespace: "global" }, model());
    expect(r.kind).toBe("unreachable");
    expect(r.error).toMatch(/oauth\.lock/);
    expect(calls(e)).toHaveLength(0);
  });

  it("a transport failure retires the client and the next call reconnects", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", status: 503 });
    expect((await c.callTool("memory_search", { query: "x" }, model())).kind).toBe("unreachable");
    expect((await c.callTool("memory_search", { query: "x" }, model())).kind).toBe("ok");
    expect(inits(e)).toHaveLength(2);
  });

  it("a retired client finishes the calls already in flight", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    await c.listTools(model());
    e.next({ route: "mcp", delayMs: 400 });
    const slow = c.callTool("memory_write", { content: "in flight", namespace: "global" }, model());
    await vi.waitFor(() => expect(calls(e)).toHaveLength(1));
    e.next({ route: "mcp", status: 500 });
    const failed = await c.callTool("memory_search", { query: "x" }, model());
    expect(failed.kind).toBe("timeout");
    expect((await slow).kind).toBe("ok");
  });

  it("a hung handshake gives up at the connect timeout and counts as unreachable", async () => {
    const e = await engine({ bearer: "t" });
    e.next({ route: "mcp", delayMs: 5000 });
    const cfg = resolveConfig({ baseUrl: e.url, auth: "token", token: "t", connectTimeoutMs: 500 });
    const c = createEngineClient(cfg, stubAuth(), { version: "9.9.9" });
    open.push({ close: () => c.close(0) });
    const started = Date.now();
    const r = await c.callTool("memory_write", { content: "x", namespace: "global" }, model(undefined, 10_000));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.kind).toBe("unreachable");
  });
});

describe("admin and close", () => {
  it("admin JSON goes to the origin with the same authorization", async () => {
    const e = await engine({ bearer: "t" });
    const c = client(e.url);
    const who = await c.admin("GET", "/admin/whoami", undefined, { timeoutMs: 5000 });
    expect(who.status).toBe(200);
    expect(who.json).toMatchObject({ may_ingest: true });
    const run = await c.admin("POST", "/admin/ingest/runs", { extractor: "openclaw-builtin-import" }, { timeoutMs: 5000, sessionId: "s-9" });
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ run_id: expect.any(String) });
    const [get, post] = e.requests;
    expect(get).toMatchObject({ method: "GET", path: "/admin/whoami" });
    expect(get!.headers.authorization).toBe("Bearer t");
    expect(get!.headers["x-session-id"]).toBe("cli-4242");
    expect(post).toMatchObject({ method: "POST", path: "/admin/ingest/runs", body: { extractor: "openclaw-builtin-import" } });
    expect(post!.headers.authorization).toBe("Bearer t");
    expect(post!.headers["content-type"]).toContain("application/json");
    expect(post!.headers["x-session-id"]).toBe("s-9");
  });

  it("admin reports a 401 to the auth handle and throws on a refused connection", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth("Bearer wrong");
    const res = await client(e.url, auth).admin("GET", "/admin/whoami", undefined, { timeoutMs: 5000 });
    expect(res.status).toBe(401);
    expect(auth.rejectedWith).toEqual(["Bearer wrong"]);
    const dead = await startFakeEngine();
    const url = dead.url;
    await dead.close();
    await expect(client(url).admin("GET", "/admin/whoami", undefined, { timeoutMs: 5000 })).rejects.toThrow();
  });

  it("admin gives up at its deadline", async () => {
    const e = await engine({ bearer: "t" });
    e.next({ route: "admin", delayMs: 3000 });
    const started = Date.now();
    await expect(client(e.url).admin("GET", "/admin/whoami", undefined, { timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("close waits for auth settle before closing the clients", async () => {
    const e = await engine({ bearer: "t" });
    const auth = stubAuth();
    let release!: () => void;
    auth.settleGate = new Promise<void>((resolve) => (release = resolve));
    const c = client(e.url, auth);
    await c.listTools(hook());
    e.next({ route: "mcp", delayMs: 3000 });
    const started = Date.now();
    let done = false;
    const pending = c.callTool("memory_search", { query: "x" }, hook(undefined, 10_000)).finally(() => (done = true));
    await vi.waitFor(() => expect(calls(e)).toHaveLength(1));
    const closing = c.close(3000);
    await sleep(150);
    expect(auth.settleCalls).toEqual([3000]);
    expect(done).toBe(false);
    release();
    await closing;
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.kind).toBe("timeout");
    const before = e.requests.length;
    expect((await c.callTool("memory_search", { query: "x" }, hook())).kind).toBe("unreachable");
    expect(e.requests.length).toBe(before);
  });
});

describe("classify", () => {
  const sent = { sent: true, status: null };
  const unsent = { sent: false, status: null };

  it("neverSent finds the errno through the cause chain and inside an AggregateError", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    expect(neverSent(new TypeError("fetch failed", { cause: refused }))).toBe(true);
    const both = new AggregateError([refused, Object.assign(new Error("x"), { code: "ENETUNREACH" })]);
    expect(neverSent(new TypeError("fetch failed", { cause: both }))).toBe(true);
    const timeout = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(neverSent(new TypeError("fetch failed", { cause: timeout }))).toBe(true);
    const closed = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    expect(neverSent(new TypeError("fetch failed", { cause: closed }))).toBe(false);
    expect(neverSent("ECONNREFUSED")).toBe(false);
  });

  it("login_required ranks ahead of every other class", () => {
    const err = new LoginRequired();
    expect(classifyFailure(err, { sent: true, status: 500 }).kind).toBe("login_required");
  });

  it("an auth handle failure is unreachable even after an earlier request of the call left", () => {
    // A second tools/list page asks the handle again after the first page went out.
    const after = { sent: true, status: 200 };
    expect(classifyFailure(new FenceTimeout("/s/lumberroom/oauth.lock"), after).kind).toBe("unreachable");
    expect(classifyFailure(new RefreshUnavailable("token endpoint answered 503"), after).kind).toBe("unreachable");
    expect(classifyFailure(new TokenSaveFailed("lumberroom renewed the sign-in and could not save it (ENOSPC)", "ENOSPC"), after)).toMatchObject({
      kind: "unreachable",
      error: expect.stringContaining("ENOSPC"),
    });
  });

  it("the status the wrapper recorded decides when the error carries none", () => {
    expect(classifyFailure(new Error("boom"), { sent: true, status: 401 })).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(classifyFailure(new Error("boom"), { sent: true, status: 502 })).toMatchObject({ kind: "unreachable", status: 502 });
    expect(classifyFailure(new StreamableHTTPError(503, "Service Unavailable"), sent)).toMatchObject({ kind: "unreachable", status: 503 });
  });

  it("a JSON-RPC error from the server is a tool_error with the server's message", () => {
    const r = classifyFailure(new McpError(ErrorCode.InvalidParams, "namespace is required"), sent);
    expect(r).toMatchObject({ kind: "tool_error", error: "namespace is required" });
  });

  it("an SDK request timeout after send is a timeout and before send is unreachable", () => {
    const err = new McpError(ErrorCode.RequestTimeout, "Request timed out");
    expect(classifyFailure(err, sent).kind).toBe("timeout");
    expect(classifyFailure(err, unsent).kind).toBe("unreachable");
  });

  it("a 4xx other than 401 after send is a tool_error that names the status", () => {
    const r = classifyFailure(new StreamableHTTPError(413, "Error POSTing to endpoint: payload too large"), sent);
    expect(r.kind).toBe("tool_error");
    expect(r.status).toBe(413);
    expect(r.error).toMatch(/HTTP 413/);
  });

  it("an unreadable answer after send may have taken effect", () => {
    expect(classifyFailure(new SyntaxError("Unexpected token <"), { sent: true, status: 200 })).toMatchObject({ kind: "timeout", status: null });
  });

  it("toolResult joins the text parts and keeps structuredContent", () => {
    const raw = { content: [{ type: "text", text: "a" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "b" }], structuredContent: { id: "1" } };
    expect(toolResult("memory_write", raw)).toEqual({ kind: "ok", structured: { id: "1" }, text: "a\nb", error: null, status: null });
    expect(toolResult("memory_write", { content: [], isError: true })).toMatchObject({ kind: "tool_error", error: "memory_write failed" });
  });
});
