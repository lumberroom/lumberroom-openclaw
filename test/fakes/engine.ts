// A fake lumberroom engine on node:http for unit tests. It replays the handshake and tools/list the
// L0 capture recorded (test/fixtures/engine_transcript.json), keeps memories and proposals in memory,
// and serves the OAuth routes with refresh rotation and replay detection like
// ENG/src/authserver/routes.rs:751-800.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  at: number;
}

export type Route = "mcp" | "token" | "register" | "admin";

export type Behaviour =
  | { route: Route; status: number; body?: unknown } // answer this status once
  | { route: Route; delayMs: number } // hold the answer once
  | { route: Route; dropAfterBody: true } // read the body, then destroy the socket once
  | { route: "mcp"; tool: string; isError: string }; // the next call of that tool fails

export interface FakeEngineOptions {
  bearer?: string | null; // token mode: the one accepted bearer; null accepts any
  oauth?: { accessTtlSec: number; autoConsent: boolean }; // enables the OAuth routes
  tools?: string[]; // grant filter over the transcript's tools/list
  // L1 addition: the plan says the ingest routes answer 403 when the grant lacks ingest, and
  // nothing else in these options can express that grant.
  mayIngest?: boolean; // default true
}

export interface FakeEngine {
  url: string;
  requests: RecordedRequest[];
  memories: Array<{ id: string; namespace: string; content: string; source: string }>;
  proposals: Array<Record<string, unknown>>;
  refreshGrants: number;
  replays: number;
  next(b: Behaviour): void;
  authorize(authorizeUrl: string): Promise<string>; // with autoConsent: returns the redirect URL carrying code and state
  close(): Promise<void>;
}

interface Exchange {
  request: { method: string; json: unknown };
  response: { status: number; json: unknown };
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown; // an object goes out as JSON, a string as text, undefined as an empty body
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
}

const TRANSCRIPT = JSON.parse(
  readFileSync(new URL("../fixtures/engine_transcript.json", import.meta.url), "utf8"),
) as { exchanges: Exchange[] };

function transcriptResult(method: string): Record<string, unknown> {
  const ex = TRANSCRIPT.exchanges.find((e) => (e.request.json as Rpc | null)?.method === method);
  const result = (ex?.response.json as { result?: Record<string, unknown> } | undefined)?.result;
  if (!result) throw new Error(`the engine transcript holds no ${method} answer`);
  return result;
}

const INITIALIZE = transcriptResult("initialize");
const TOOLS = (transcriptResult("tools/list").tools as Array<{ name: string }>).map((t) => structuredClone(t));
const SOURCE = "fake-engine";
const CLIENT = "fake-engine";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function token(prefix: string): string {
  return `${prefix}_${b64url(randomBytes(24))}`;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return null;
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolOk(structured: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false };
}

// E4: a failed tool answers isError with "<tool> failed: <reason>".
function toolFail(tool: string, reason: string): Record<string, unknown> {
  return { content: [{ type: "text", text: `${tool} failed: ${reason}` }], isError: true };
}

function oauthError(status: number, error: string, description: string): Reply {
  return { status, headers: { "cache-control": "no-store" }, body: { error, error_description: description } };
}

export async function startFakeEngine(opts: FakeEngineOptions = {}): Promise<FakeEngine> {
  const queue: Behaviour[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<Socket>();
  const extras = new Map<string, { tags: string[]; created_at: string; occurred_at?: string; superseded_by?: string }>();
  const clients = new Map<string, { redirect_uris: string[]; client_name?: string }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string | null; used: boolean }>();
  const refreshTokens = new Map<string, { family: string; clientId: string; resource: string | null; spent: boolean }>();
  const accessTokens = new Map<string, { family: string; expiresAt: number }>();
  const revokedFamilies = new Set<string>();
  const runs = new Map<string, { extractor: string; closed: Record<string, unknown> | null }>();
  const fingerprints = new Map<string, Record<string, unknown>>();
  const granted = opts.tools ? new Set(opts.tools) : null;
  const mayIngest = opts.mayIngest ?? true;
  const mayDelete = granted === null || granted.has("memory_forget");

  let url = "";

  const engine: FakeEngine = {
    url: "",
    requests: [],
    memories: [],
    proposals: [],
    refreshGrants: 0,
    replays: 0,
    next(b) {
      queue.push(b);
    },
    async authorize(authorizeUrl) {
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) {
        throw new Error(`the fake authorize endpoint answered ${res.status}: ${await res.text()}`);
      }
      return location;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  function takeBehaviour(route: Route): Behaviour | undefined {
    const i = queue.findIndex((b) => b.route === route && !("tool" in b));
    return i < 0 ? undefined : queue.splice(i, 1)[0];
  }

  function takeToolError(tool: string): string | undefined {
    const i = queue.findIndex((b) => "tool" in b && b.tool === tool);
    if (i < 0) return undefined;
    return (queue.splice(i, 1)[0] as { isError: string }).isError;
  }

  function challenge(presented: boolean): string {
    // Same shape as ENG/src/adapters/auth/metadata.rs:74-89: a bare challenge when no credential
    // came, and the metadata pointer only when OAuth protects the resource.
    const params: string[] = [];
    if (presented) params.push('error="invalid_token"');
    if (opts.oauth) params.push(`resource_metadata="${url}/.well-known/oauth-protected-resource"`);
    return params.length ? `Bearer ${params.join(", ")}` : "Bearer";
  }

  function unauthorized(headers: Record<string, string>): Reply | null {
    const header = headers.authorization?.trim();
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!opts.oauth && (opts.bearer === undefined || opts.bearer === null)) return null;
    if (typeof opts.bearer === "string" && bearer === opts.bearer) return null;
    if (opts.oauth && bearer) {
      const live = accessTokens.get(bearer);
      if (live && !revokedFamilies.has(live.family) && live.expiresAt > Date.now()) return null;
    }
    return {
      status: 401,
      headers: { "www-authenticate": challenge(Boolean(header)) },
      body: { error: "unauthorized", detail: header ? "the token is unknown, expired or revoked" : "no credential" },
    };
  }

  function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const queued = takeToolError(name);
    if (queued !== undefined) return toolFail(name, queued);
    if (granted && !granted.has(name)) return toolFail(name, "this credential's grant does not include it");

    if (name === "memory_write") {
      const { content, namespace } = args;
      if (typeof content !== "string" || !content.trim() || typeof namespace !== "string" || !namespace.trim()) {
        return toolFail(name, "content and namespace are required");
      }
      const conflicts = engine.memories
        .filter((m) => !extras.get(m.id)?.superseded_by && norm(m.content) === norm(content))
        .map((m) => ({ id: m.id, namespace: m.namespace, content: m.content, similarity: 1 }));
      const id = randomUUID();
      engine.memories.push({ id, namespace, content, source: SOURCE });
      extras.set(id, {
        tags: Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : [],
        created_at: new Date().toISOString(),
        ...(typeof args.occurred_at === "string" ? { occurred_at: args.occurred_at } : {}),
      });
      let superseded: string | undefined;
      if (typeof args.supersedes === "string" && engine.memories.some((m) => m.id === args.supersedes)) {
        superseded = args.supersedes;
        const old = extras.get(superseded);
        if (old) old.superseded_by = id;
      }
      return toolOk({
        id,
        namespace,
        sensitivity: typeof args.sensitivity === "string" ? args.sensitivity : "open",
        deduplicated: false,
        ...(superseded ? { superseded } : {}),
        ...(conflicts.length ? { possible_conflicts: conflicts } : {}),
      });
    }

    if (name === "memory_search") {
      if (typeof args.query !== "string" || !args.query.trim()) return toolFail(name, "query is required");
      const query = args.query.toLowerCase().trim();
      const limit = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 8;
      const namespaces = Array.isArray(args.namespaces) ? new Set(args.namespaces) : null;
      // A whole-query substring, or any word of three or more characters, counts as a match. Tests
      // send whole user messages as the query, which rarely appear verbatim in a stored memory.
      const words = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
      const hits = engine.memories
        .filter((m) => !extras.get(m.id)?.superseded_by)
        .filter((m) => !namespaces || namespaces.has(m.namespace))
        .filter((m) => {
          const c = m.content.toLowerCase();
          return c.includes(query) || words.some((w) => c.includes(w));
        })
        .slice(0, limit)
        .map((m, i) => {
          const x = extras.get(m.id);
          return {
            id: m.id,
            namespace: m.namespace,
            content: m.content,
            tags: x?.tags ?? [],
            source: m.source,
            sensitivity: "open",
            created_at: x?.created_at ?? new Date(0).toISOString(),
            score: Number((0.9 - i * 0.01).toFixed(4)),
            similarity: 0.9,
            primary: true,
            ...(x?.occurred_at ? { occurred_at: x.occurred_at } : {}),
          };
        });
      return toolOk({ namespaces: ["user:me", "global"], also_searched: [], hits });
    }

    if (name === "context_bootstrap") {
      const live = engine.memories.filter((m) => !extras.get(m.id)?.superseded_by);
      const byNs = new Map<string, string[]>();
      for (const m of live) byNs.set(m.namespace, [...(byNs.get(m.namespace) ?? []), `- ${m.content}`]);
      const text = live.length
        ? [...byNs].map(([ns, lines]) => `## ${ns}\n${lines.join("\n")}`).join("\n\n")
        : "Nothing is stored yet.";
      return toolOk({ text });
    }

    return toolFail(name, "the fake engine does not implement this tool");
  }

  function mcp(body: unknown): Reply {
    const msg = body as Rpc | null;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
    }
    // A notification carries no id and gets 202 with no body, as notifications/initialized did in
    // the capture.
    if (msg.id === undefined) return { status: 202 };
    const answer = (result: unknown): Reply => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: msg.id, result },
    });
    switch (msg.method) {
      case "initialize":
        return answer(structuredClone(INITIALIZE));
      case "tools/list":
        return answer({ tools: TOOLS.filter((t) => !granted || granted.has(t.name)).map((t) => structuredClone(t)) });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string") {
          return { status: 200, headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "tool name is required" } } };
        }
        return answer(callTool(name, msg.params?.arguments ?? {}));
      }
      case "ping":
        return answer({});
      default:
        return { status: 200, headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } } };
    }
  }

  function issuePair(family: string, clientId: string, resource: string | null): Record<string, unknown> {
    const access = token("at");
    const refresh = token("rt");
    const ttl = opts.oauth!.accessTtlSec;
    accessTokens.set(access, { family, expiresAt: Date.now() + ttl * 1000 });
    refreshTokens.set(refresh, { family, clientId, resource, spent: false });
    return { access_token: access, token_type: "Bearer", expires_in: ttl, refresh_token: refresh };
  }

  function tokenRoute(body: unknown): Reply {
    const form = (body && typeof body === "object" ? body : {}) as Record<string, string | undefined>;
    if (form.grant_type === "authorization_code") {
      const code = form.code ? codes.get(form.code) : undefined;
      if (!code || code.used) return oauthError(400, "invalid_grant", "unknown authorization code");
      if (code.clientId !== form.client_id) return oauthError(400, "invalid_grant", "the code was issued to another client");
      if (code.redirectUri !== form.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri does not match");
      const expected = b64url(createHash("sha256").update(form.code_verifier ?? "").digest());
      if (expected !== code.challenge) return oauthError(400, "invalid_grant", "the PKCE verifier does not match");
      code.used = true;
      const resource = form.resource ?? code.resource;
      return { status: 200, headers: { "cache-control": "no-store" }, body: issuePair(randomUUID(), code.clientId, resource) };
    }
    if (form.grant_type === "refresh_token") {
      engine.refreshGrants += 1;
      if (!form.refresh_token) return oauthError(400, "invalid_request", "refresh_token is required");
      const rt = refreshTokens.get(form.refresh_token);
      if (!rt) return oauthError(400, "invalid_grant", "unknown refresh token");
      if (revokedFamilies.has(rt.family)) return oauthError(400, "invalid_grant", "this refresh token was revoked");
      if (rt.clientId !== form.client_id) return oauthError(400, "invalid_grant", "the refresh token was issued to another client");
      // The engine settles the resource before it spends the token (E5).
      if (form.resource !== undefined && rt.resource !== null && form.resource !== rt.resource) {
        return oauthError(400, "invalid_target", "the resource does not match the grant");
      }
      if (rt.spent) {
        engine.replays += 1;
        revokedFamilies.add(rt.family);
        return oauthError(400, "invalid_grant", "refresh token replayed, the token family is revoked");
      }
      rt.spent = true;
      return { status: 200, headers: { "cache-control": "no-store" }, body: issuePair(rt.family, rt.clientId, rt.resource) };
    }
    return oauthError(400, "unsupported_grant_type", `grant_type ${String(form.grant_type)} is not supported`);
  }

  function register(body: unknown): Reply {
    const meta = body as { redirect_uris?: unknown; client_name?: string } | null;
    const uris = meta?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string")) {
      return oauthError(400, "invalid_redirect_uri", "redirect_uris must list at least one URI");
    }
    const clientId = randomUUID();
    clients.set(clientId, { redirect_uris: uris as string[], ...(meta?.client_name ? { client_name: meta.client_name } : {}) });
    return {
      status: 201,
      body: { ...(meta as object), client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" },
    };
  }

  function authorizeRoute(query: URLSearchParams): Reply {
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const client = clients.get(clientId);
    if (!client) return oauthError(400, "invalid_client", "unknown client_id");
    if (!client.redirect_uris.includes(redirectUri)) return oauthError(400, "invalid_request", "redirect_uri is not registered");
    if (query.get("response_type") !== "code") return oauthError(400, "unsupported_response_type", "response_type must be code");
    const challengeValue = query.get("code_challenge");
    if (!challengeValue || query.get("code_challenge_method") !== "S256") {
      return oauthError(400, "invalid_request", "PKCE with S256 is required");
    }
    const target = new URL(redirectUri);
    const state = query.get("state");
    if (opts.oauth!.autoConsent) {
      const code = token("code");
      codes.set(code, { clientId, redirectUri, challenge: challengeValue, resource: query.get("resource"), used: false });
      target.searchParams.set("code", code);
    } else {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "the owner declined");
    }
    if (state !== null) target.searchParams.set("state", state);
    return { status: 302, headers: { location: target.href } };
  }

  function admin(method: string, path: string, body: unknown): Reply {
    if (method === "GET" && path === "/admin/whoami") {
      return {
        status: 200,
        body: {
          client: CLIENT,
          mode: opts.oauth ? "oauth" : "token",
          may_delete: mayDelete,
          may_ingest: mayIngest,
          may_read_history: false,
          scopes: [],
        },
      };
    }
    if (!path.startsWith("/admin/ingest/")) return { status: 404, body: { error: "not_found" } };
    if (!mayIngest) {
      return { status: 403, body: { error: "forbidden", detail: `client ${CLIENT} may not ingest: the grant carries no may_ingest.` } };
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (method === "POST" && path === "/admin/ingest/runs") {
      if (typeof b.extractor !== "string") return { status: 422, body: { error: "extractor is required" } };
      const runId = randomUUID();
      runs.set(runId, { extractor: b.extractor, closed: null });
      return { status: 200, body: { run_id: runId } };
    }
    const close = path.match(/^\/admin\/ingest\/runs\/([^/]+)\/close$/);
    if (method === "POST" && close) {
      const run = runs.get(close[1]!);
      if (!run) return { status: 404, body: { error: "not_found" } };
      run.closed = b;
      return { status: 200, body: { closed: true } };
    }
    if (method === "POST" && path === "/admin/ingest/proposals") {
      const facts = b.facts;
      if (typeof b.extractor !== "string" || !Array.isArray(facts)) return { status: 422, body: { error: "extractor and facts are required" } };
      for (const f of facts as Array<Record<string, unknown>>) {
        const src = f?.source as Record<string, unknown> | undefined;
        if (typeof f?.content !== "string" || typeof f.namespace !== "string" || typeof f.speaker !== "string" || typeof src?.file_path !== "string" || typeof src.run_id !== "string") {
          return { status: 422, body: { error: "each fact needs content, namespace, speaker, source.file_path and source.run_id" } };
        }
      }
      const outcomes: Array<Record<string, unknown>> = [];
      let fresh = 0;
      let reinforced = 0;
      for (const f of facts as Array<Record<string, unknown>>) {
        const src = f.source as Record<string, unknown>;
        const sourceKey = typeof src.source_key === "string" ? src.source_key : typeof src.entry_uuid === "string" ? `${src.file_path}#${src.entry_uuid}` : String(src.file_path);
        const fp = `${f.namespace}\u0000${norm(f.content as string)}`;
        const existing = fingerprints.get(fp);
        if (existing) {
          const keys = existing.source_keys as string[];
          if (!keys.includes(sourceKey)) keys.push(sourceKey);
          reinforced += 1;
          outcomes.push({ outcome: "reinforced", id: existing.id });
          continue;
        }
        // E11: only owner_typed can auto-approve.
        const proposal = { id: randomUUID(), extractor: b.extractor, ...f, source_keys: [sourceKey], status: "pending" };
        fingerprints.set(fp, proposal);
        engine.proposals.push(proposal);
        fresh += 1;
        outcomes.push({ outcome: "proposed", id: proposal.id, auto: f.speaker === "owner_typed" });
      }
      return { status: 200, body: { outcomes, proposals_new: fresh, proposals_reinforced: reinforced, confirmations: 0, refused: 0, blocked: 0 } };
    }
    return { status: 404, body: { error: "not_found" } };
  }

  function discovery(path: string): Reply | null {
    if (!opts.oauth) return null;
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return { status: 200, body: { resource: `${url}/mcp`, authorization_servers: [url], bearer_methods_supported: ["header"] } };
    }
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
      return {
        status: 200,
        body: {
          issuer: url,
          authorization_endpoint: `${url}/oauth/authorize`,
          token_endpoint: `${url}/oauth/token`,
          registration_endpoint: `${url}/oauth/register`,
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        },
      };
    }
    return null;
  }

  function routeOf(path: string): Route | null {
    if (path === "/mcp") return "mcp";
    if (path === "/oauth/token") return opts.oauth ? "token" : null;
    if (path === "/oauth/register") return opts.oauth ? "register" : null;
    if (path.startsWith("/admin/")) return "admin";
    return null;
  }

  function answer(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: unknown): Reply {
    const route = routeOf(path);
    if (route === "mcp") {
      // The engine is stateless: the GET stream the SDK opens after initialized gets 405, and so
      // does a DELETE, as the capture recorded.
      if (method !== "POST") return { status: 405, body: "Method Not Allowed" };
      return unauthorized(headers) ?? mcp(body);
    }
    if (route === "admin") return unauthorized(headers) ?? admin(method, path, body);
    if (route === "token" && method === "POST") return tokenRoute(body);
    if (route === "register" && method === "POST") return register(body);
    if (opts.oauth && method === "GET" && path === "/oauth/authorize") return authorizeRoute(query);
    return discovery(path) ?? { status: 404, body: { error: "not_found" } };
  }

  function send(res: ServerResponse, reply: Reply): void {
    if (res.destroyed) return;
    const headers = { ...(reply.headers ?? {}) };
    let payload = "";
    if (typeof reply.body === "string") {
      payload = reply.body;
    } else if (reply.body !== undefined) {
      payload = JSON.stringify(reply.body);
      headers["content-type"] ??= "application/json";
    }
    res.writeHead(reply.status, headers);
    res.end(payload);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = flatHeaders(req);
    const target = new URL(req.url ?? "/", url);
    const method = req.method ?? "GET";
    const body = parseBody(Buffer.concat(chunks).toString("utf8"), headers["content-type"]);
    engine.requests.push({ method, path: target.pathname, headers, body, at: Date.now() });

    const route = routeOf(target.pathname);
    // Status, delay and drop behaviours on the mcp route apply to the next POST only, so the SDK's
    // GET stream never consumes one. The handshake is a POST: queue after connecting to hit a call.
    const behaviour = route && !(route === "mcp" && method !== "POST") ? takeBehaviour(route) : undefined;
    if (behaviour && "status" in behaviour) {
      send(res, { status: behaviour.status, body: behaviour.body ?? { error: "fake_status", detail: `status ${behaviour.status} from the behaviour queue` } });
      return;
    }
    // Delay and drop still run the request first, so a write lands and a refresh rotates. That is
    // the case a caller has to handle: the engine acted and the answer never arrived.
    const reply = answer(method, target.pathname, target.searchParams, headers, body);
    if (behaviour && "dropAfterBody" in behaviour) {
      req.socket.destroy();
      return;
    }
    if (behaviour && "delayMs" in behaviour) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, behaviour.delayMs);
        timers.add(t);
      });
    }
    send(res, reply);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent && !res.destroyed) send(res, { status: 500, body: { error: "fake_engine_crash", detail: String(err) } });
      else res.destroy();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  engine.url = url;
  return engine;
}
