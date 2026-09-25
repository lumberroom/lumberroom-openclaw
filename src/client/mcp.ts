import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FenceTimeout, LoginRequired, RefreshUnavailable, TokenSaveFailed } from "../errors.js";
import type {
  AdminResponse,
  AuthHandle,
  CallMeta,
  CallResult,
  EngineClient,
  Invocation,
  LumberroomConfig,
  McpTool,
  ToolsListing,
} from "../types.js";
import { classifyFailure, toolResult, type Attempt } from "./classify.js";

export interface EngineClientOptions {
  version: string;
  fetch?: typeof globalThis.fetch;
  pid?: number;
}

const CLIENT_NAME = "lumberroom-openclaw";
const SESSION_ID_MAX = 128;
const MAX_LIST_PAGES = 20;
// Only a handle that breaks its own settle bound hits this; it keeps shutdown from hanging on it.
const SETTLE_BACKSTOP_MS = 1000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// "connect" covers the handshake and the GET stream it opens. Nothing there can change engine state,
// so a failure in it never counts as sent.
interface CallContext {
  invocation: Invocation;
  sessionId: string | undefined;
  deadline: AbortSignal;
  attempt: Attempt;
  phase: "connect" | "call";
}

interface Entry {
  invocation: Invocation;
  client: Client;
  transport: StreamableHTTPClientTransport;
  ready: Promise<void>;
  inflight: number;
  retired: boolean;
  shut: boolean;
}

const AUTH_ERRORS = [LoginRequired, FenceTimeout, RefreshUnavailable, TokenSaveFailed];

function freshAttempt(): Attempt {
  return { sent: false, status: null };
}

function connectTimeout(ms: number): Error {
  const err = new Error(`no answer to the handshake within ${ms} ms`);
  err.name = "ConnectTimeout";
  return err;
}

// A pending promise that loses to the caller's deadline. The loser keeps running for whoever else
// waits on it, which is what a shared handshake needs.
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// The SDK answers a passed deadline with notifications/cancelled from the signal's abort listener,
// which runs outside the call's async context, so no deadline stops it. The engine is stateless and
// answers each POST on its own; the cancellation has no request left to reach.
function isCancellation(body: unknown): boolean {
  if (typeof body !== "string" || !body.includes("notifications/cancelled")) return false;
  try {
    return (JSON.parse(body) as { method?: unknown }).method === "notifications/cancelled";
  } catch {
    return false;
  }
}

export function createEngineClient(cfg: LumberroomConfig, auth: AuthHandle, opts: EngineClientOptions): EngineClient {
  const als = new AsyncLocalStorage<CallContext>();
  const userAgent = `${CLIENT_NAME}/${opts.version}`;
  const pid = opts.pid ?? process.pid;
  const entries = new Map<Invocation, Entry>();
  const live = new Set<Entry>();
  let closed = false;

  function sessionHeader(invocation: Invocation, sessionId: string | undefined): string | undefined {
    const raw = sessionId?.trim() ? sessionId : invocation === "cli" ? `cli-${pid}` : undefined;
    if (raw === undefined) return undefined;
    // A header value must be visible ASCII or fetch throws before the request leaves. The engine
    // trims and keeps 128 characters (ENG/src/http/mod.rs:280-289).
    const clean = raw.replace(/[^\x20-\x7e]/g, "_").trim().slice(0, SESSION_ID_MAX).trim();
    return clean || undefined;
  }

  function wrap(invocation: Invocation): FetchLike {
    return async (input, init = {}) => {
      if (isCancellation(init.body)) return new Response(null, { status: 202 });
      const ctx = als.getStore();
      // No context means the SDK started this request on its own, such as a GET stream reconnect.
      const attempt = ctx?.attempt ?? freshAttempt();
      const deadline = ctx?.deadline ?? AbortSignal.timeout(cfg.toolTimeoutMs);
      deadline.throwIfAborted();
      const authorization = await auth.authorize(deadline);
      deadline.throwIfAborted();

      const headers = new Headers(init.headers);
      headers.set("authorization", authorization);
      headers.set("user-agent", userAgent);
      if (invocation === "hook" || invocation === "cli") headers.set("x-memory-invocation", invocation);
      else headers.delete("x-memory-invocation");
      const sid = sessionHeader(invocation, ctx?.sessionId);
      if (sid) headers.set("x-session-id", sid);
      else headers.delete("x-session-id");

      const signals = [deadline];
      if (init.signal) signals.push(init.signal);
      let timer: NodeJS.Timeout | undefined;
      if (ctx?.phase === "call") {
        attempt.sent = true;
      } else {
        // Node's fetch offers no connect-only timeout without undici's Agent, so the bound covers the
        // handshake until headers arrive. A tool call gets the caller's deadline alone: a slow write
        // cut at 3 s would report "may have taken effect" for a write that was only slow.
        const ctl = new AbortController();
        timer = setTimeout(() => ctl.abort(connectTimeout(cfg.connectTimeoutMs)), cfg.connectTimeoutMs);
        signals.push(ctl.signal);
      }
      try {
        const res = await (opts.fetch ?? globalThis.fetch)(input, { ...init, headers, signal: AbortSignal.any(signals) });
        attempt.status = res.status;
        if (res.status === 401) auth.rejected(authorization);
        return res;
      } finally {
        clearTimeout(timer);
      }
    };
  }

  function shut(entry: Entry): Promise<void> {
    if (entry.shut) return Promise.resolve();
    entry.shut = true;
    live.delete(entry);
    return entry.client.close().catch(() => undefined);
  }

  // A retired client takes no new calls. Closing it aborts its transport, so it closes only once the
  // calls already on it have finished.
  function retire(entry: Entry): void {
    if (entries.get(entry.invocation) === entry) entries.delete(entry.invocation);
    entry.retired = true;
    if (entry.inflight === 0) void shut(entry);
  }

  function open(ctx: CallContext): Entry {
    const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), { fetch: wrap(ctx.invocation) });
    const client = new Client({ name: CLIENT_NAME, version: opts.version });
    const entry: Entry = { invocation: ctx.invocation, client, transport, ready: Promise.resolve(), inflight: 0, retired: false, shut: false };
    const connectCtx: CallContext = { ...ctx, attempt: freshAttempt(), phase: "connect" };
    entry.ready = als.run(connectCtx, () => client.connect(transport, { signal: ctx.deadline }));
    entry.ready.catch(() => retire(entry));
    entries.set(ctx.invocation, entry);
    live.add(entry);
    return entry;
  }

  function isTransportFailure(err: unknown, result: CallResult): boolean {
    if (result.kind !== "unreachable" && result.kind !== "timeout") return false;
    return !AUTH_ERRORS.some((cls) => err instanceof cls);
  }

  function closedResult(): CallResult {
    return { kind: "unreachable", structured: null, text: "", error: "the lumberroom client is closed", status: null };
  }

  async function run(meta: CallMeta, body: (entry: Entry, ctx: CallContext) => Promise<CallResult>): Promise<CallResult> {
    if (closed) return closedResult();
    const ctx: CallContext = {
      invocation: meta.invocation,
      sessionId: meta.sessionId,
      deadline: AbortSignal.timeout(meta.timeoutMs),
      attempt: freshAttempt(),
      phase: "call",
    };
    let entry: Entry | undefined;
    try {
      entry = entries.get(meta.invocation) ?? open(ctx);
      entry.inflight += 1;
      await untilAborted(entry.ready, ctx.deadline);
      return await body(entry, ctx);
    } catch (err) {
      // A snapshot: the SDK's abort path can still touch the attempt after the call has failed.
      const result = classifyFailure(err, { ...ctx.attempt });
      if (entry && isTransportFailure(err, result)) retire(entry);
      return result;
    } finally {
      if (entry) {
        entry.inflight -= 1;
        if (entry.retired && entry.inflight === 0) void shut(entry);
      }
    }
  }

  const adminFetch = wrap("cli");

  return {
    async listTools(meta) {
      let listing: ToolsListing | null = null;
      const result = await run(meta, async (entry, ctx) => {
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const params = cursor ? { cursor } : undefined;
          const page = await als.run(ctx, () => entry.client.listTools(params, { signal: ctx.deadline, timeout: meta.timeoutMs }));
          tools.push(...(page.tools as McpTool[]));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor && pages < MAX_LIST_PAGES);
        const info = entry.client.getServerVersion();
        listing = {
          tools,
          instructions: entry.client.getInstructions() ?? null,
          serverInfo: info ? { name: info.name, version: info.version } : null,
          protocolVersion: entry.transport.protocolVersion ?? null,
        };
        return { kind: "ok", structured: null, text: "", error: null, status: ctx.attempt.status };
      });
      return { result, listing: result.kind === "ok" ? listing : null };
    },

    async callTool(name, args, meta) {
      return run(meta, async (entry, ctx) => {
        const raw = await als.run(ctx, () =>
          entry.client.callTool({ name, arguments: args }, undefined, { signal: ctx.deadline, timeout: meta.timeoutMs }),
        );
        return { ...toolResult(name, raw), status: ctx.attempt.status };
      });
    },

    async admin(method, path, body, meta): Promise<AdminResponse> {
      if (closed) throw new Error("the lumberroom client is closed");
      const deadline = AbortSignal.timeout(meta.timeoutMs);
      const ctx: CallContext = { invocation: "cli", sessionId: meta.sessionId, deadline, attempt: freshAttempt(), phase: "call" };
      const headers: Record<string, string> = { accept: "application/json" };
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const res = await als.run(ctx, () => adminFetch(url, init));
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    },

    async close(timeoutMs) {
      closed = true;
      // Settle first: a refresh the engine has already rotated must finish saving before the process
      // lets go, or the only live refresh token is lost.
      let backstop: NodeJS.Timeout | undefined;
      await Promise.race([
        auth.settle(timeoutMs).catch(() => undefined),
        new Promise<void>((resolve) => {
          backstop = setTimeout(resolve, timeoutMs + SETTLE_BACKSTOP_MS);
        }),
      ]);
      clearTimeout(backstop);
      entries.clear();
      await Promise.all([...live].map((entry) => shut(entry)));
    },
  };
}
