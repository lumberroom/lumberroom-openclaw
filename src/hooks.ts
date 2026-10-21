import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_TRIGGERS } from "./config.js";
import { hostRootConfig, identityFromHookCtx, turnAllowed } from "./gate.js";
import { retryListingIfDegraded } from "./service.js";
import { GUARDED_TOOLS, GUARD_REASON, guardTargets, isGuardedPath } from "./guard.js";
import {
  DATA_NOTE,
  LOGIN_LINE,
  NUDGE_LINE,
  UNREACHABLE_LINE,
  DIGEST_QUERY_MIN_CHARS,
  clipQuery,
  formatDigest,
  formatHits,
  inertLine,
  wrapRecall,
} from "./recall.js";
import type { CallMeta, CallResult, Hit, HookCtxLike, LumberroomConfig, PluginDeps } from "./types.js";

// The gate must still fail closed when the plugin is inert and no LumberroomConfig exists to read
// triggers and ownerIds from (spec 9: "fails closed where it cannot tell who is speaking"). This
// carries only the two fields turnAllowed reads, so an inert turn in a shared chat with no owners
// configured stays refused rather than defaulting open.
const INERT_GATE_CFG = { triggers: DEFAULT_TRIGGERS, ownerIds: [] } as unknown as LumberroomConfig;

interface PromptEventLike {
  prompt?: unknown;
  currentUserMessage?: unknown; // the Codex app-server harness only; acpx and the embedded runner never set it
}

interface ToolCallEventLike {
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: readonly string[];
}

interface ToolCallCtxLike {
  agentId?: string;
}

function sessionCacheKey(ctx: HookCtxLike): string | undefined {
  return ctx.sessionId ?? ctx.sessionKey;
}

function resolveProject(cfg: LumberroomConfig, ctx: HookCtxLike): string | undefined {
  if (cfg.project === "none") return undefined;
  if (cfg.project === "auto") return ctx.activeProjectKeys?.[0];
  return cfg.project;
}

// The floor of digestTimeoutMs. A retry with less than this left would time out before the engine
// answered and feed the breaker for a call that never had a chance.
const RETRY_MIN_MS = 500;

// OpenClaw answers a bare /new or /reset by running the new session's first turn on its own startup
// text, joined after the inbound context and the daily memory notes, with trigger "user" and no
// hook field that marks the reset. All three variants open with this sentence
// (OC src/auto-reply/reply/session-reset-prompt.ts). The match is brittle: a host release that
// rewords the sentence lets startup text reach the engine as a query again.
const RESET_MARKER = "A new session was started via /new or /reset";

// OpenClaw ends every inbound-context header it writes with this marker
// (OC src/auto-reply/reply/inbound-context-marker.ts). The plugin SDK does not export the host's
// stripper, and the host's own extensions copy the constant rather than import it, so this copy
// follows the same convention. A host release that changes the marker lets chat metadata reach the
// engine as the query again on the acpx harness; re-check that file on each OpenClaw bump.
const INBOUND_MARKER = "⟦openclaw:ctx⟧";
// The header of the channel context block the host appends after the request
// (OC strip-inbound-meta.ts CHANNEL_CONTEXT_HEADER). Cutting only at this exact line keeps a request
// that quotes the marker whole.
const CHANNEL_CONTEXT_HEADER = `Context: ${INBOUND_MARKER}`;
// The one unmarked line the host puts between the marked blocks and the request
// (OC inbound-meta.ts formatActiveGoalContext). Matching both ends keeps a request that happens to
// open with the same words.
const GOAL_PREFIX = "Active goal: ";
const GOAL_SUFFIX = "provide the requested visible final.";
// The first line of an unmentioned group message under messages.groupChat.unmentionedInbound
// "room_event" (OC prompt-prelude.ts ROOM_EVENT_PROMPT). The host tells the model the turn is "not a
// request", and the first line carries no marker, so the stripper alone would send this header as the
// query. Not exported by the SDK; re-check on each OpenClaw bump.
const ROOM_EVENT_PROMPT = "[OpenClaw room event]";

// The unmarked lines the host adds under messages.visibleReplies "message_tool", copied from
// OC src/plugin-sdk/message-tool-delivery-hints.ts:1-14 at OpenClaw 2026.9.6. The host exports them
// on a subpath it lists as private-local and publishes no types for, so an import could vanish in
// any release and break plugin load. A host rewording makes the strip miss: the hint reaches the
// engine as part of the query and the turn still runs. Re-check that file on each OpenClaw bump.
const MESSAGE_TOOL_DELIVERY_HINTS: readonly string[] = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.",
  "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.",
];

function isDeliveryHint(line: string): boolean {
  return MESSAGE_TOOL_DELIVERY_HINTS.includes(line);
}

/**
 * The request inside a prompt that carries inbound context ahead of it. A port of the host's
 * stripLeadingInboundMetadata (OC strip-inbound-meta.ts). It skips, in any order, each block whose
 * header ends with the marker (a fenced json block to its closing fence, a prose block to the next
 * blank line), the active goal line and the unmarked delivery hint the host adds under
 * messages.visibleReplies "message_tool". Then it cuts the trailing channel context block. The
 * Telegram reply-quote block carries no marker and stays in, and a delivery hint behind it stays too.
 */
function requestAfterInboundContext(prompt: string): string {
  const lines = prompt.split("\n");
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i]!.trim() === "") i += 1;
  };
  skipBlank();
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line.length > INBOUND_MARKER.length && line.endsWith(INBOUND_MARKER)) {
      i += 1;
      if (lines[i]?.trim() === "```json") {
        i += 1;
        while (i < lines.length && lines[i]!.trim() !== "```") i += 1;
        i += 1;
      } else {
        while (i < lines.length && lines[i]!.trim() !== "") i += 1;
      }
    } else if (isDeliveryHint(line) || (line.startsWith(GOAL_PREFIX) && line.endsWith(GOAL_SUFFIX))) {
      i += 1;
    } else {
      break;
    }
    skipBlank();
  }
  const rest = lines.slice(i);
  const trailing = rest.findIndex((line) => line.trim() === CHANNEL_CONTEXT_HEADER);
  return (trailing < 0 ? rest : rest.slice(0, trailing)).join("\n");
}

function isRoomEvent(prompt: unknown): boolean {
  return typeof prompt === "string" && prompt.trimStart().split("\n", 1)[0]!.trim() === ROOM_EVENT_PROMPT;
}

/**
 * The turn's request as a context_bootstrap query, or undefined when the turn carries none. Only
 * the Codex app-server harness sends currentUserMessage, the request alone, where blank means no
 * textual request. The acpx harness sends prompt with inbound context (sender, chat ids, group
 * history) ahead of the request, so the plugin strips it. The embedded runner joins inbound context
 * after this hook and sends prompt alone. A heartbeat prompt is the host's own text.
 */
function digestQuery(cfg: LumberroomConfig, event: PromptEventLike, ctx: HookCtxLike): string | undefined {
  if (!cfg.digestQuery || ctx.trigger === "heartbeat") return undefined;
  if ([event.prompt, event.currentUserMessage].some((t) => typeof t === "string" && t.includes(RESET_MARKER))) return undefined;
  // Checked on prompt whatever the harness: the Codex app-server harness sends the chat line alone as
  // currentUserMessage, and the host still calls the turn observed activity.
  if (isRoomEvent(event.prompt)) return undefined;
  const raw =
    typeof event.currentUserMessage === "string"
      ? event.currentUserMessage
      : typeof event.prompt === "string"
        ? requestAfterInboundContext(event.prompt)
        : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length < DIGEST_QUERY_MIN_CHARS || text.startsWith("/")) return undefined;
  return clipQuery(text);
}

function served(text: string | undefined): { prependSystemContext: string } | undefined {
  return text ? { prependSystemContext: text } : undefined;
}

function digestFrom(result: CallResult, maxChars: number): string {
  const text = typeof result.structured?.text === "string" ? (result.structured.text as string) : "";
  return formatDigest(text, maxChars);
}

type Told = "login" | "inert" | "outage";

function hasTold(deps: PluginDeps, key: string, kind: Told): boolean {
  return deps.state.told.get(key)?.has(kind) ?? false;
}

function markTold(deps: PluginDeps, key: string, kind: Told): void {
  const set = deps.state.told.get(key) ?? new Set<Told>();
  set.add(kind);
  deps.state.told.set(key, set);
}

function finish(parts: string[]): { prependContext: string } | undefined {
  const wrapped = wrapRecall(parts);
  return wrapped ? { prependContext: wrapped } : undefined;
}

async function digestHandler(rawEvent: unknown, rawCtx: unknown, deps: PluginDeps): Promise<{ prependSystemContext: string } | undefined> {
  const ctx = rawCtx as HookCtxLike;
  try {
    const cfg = deps.state.cfg;
    if (!cfg) return undefined;
    if (!turnAllowed(identityFromHookCtx(ctx, hostRootConfig(deps)), cfg).allowed) return undefined;
    // After the gate: a refused turn sends nothing to the engine, tools/list included.
    retryListingIfDegraded(deps);
    if (!cfg.recall || !cfg.digest) return undefined;
    if (!deps.state.breaker.allow()) return undefined;

    const key = sessionCacheKey(ctx);
    // With no cache key the digest refetches every turn, and a query would change the system prompt
    // on each one. A session spends one query, on its first eligible turn.
    const query = key && !deps.state.queried.get(key) ? digestQuery(cfg, rawEvent as PromptEventLike, ctx) : undefined;
    const held = key ? deps.state.digests.get(key) : undefined;
    if (held !== undefined && query === undefined) return served(held);
    if (!deps.client) return served(held);

    const project = resolveProject(cfg, ctx);
    const meta: CallMeta = { invocation: "hook", timeoutMs: cfg.digestTimeoutMs, ...(key ? { sessionId: key } : {}) };
    const args: Record<string, unknown> = project ? { project } : {};

    if (key && held !== undefined) {
      // The digest loaded on a turn with no request: a bare /new or /reset, a greeting, a slash
      // command. This refetch changes the system prompt once for the session. The flag goes up
      // before the call so a failure never earns a second try, and a failure feeds no breaker: the
      // held digest still serves, so the session has no outage.
      deps.state.queried.set(key, true);
      const result = await deps.client.callTool("context_bootstrap", { ...args, query }, meta);
      if (result.kind !== "ok") return served(held);
      const formatted = digestFrom(result, cfg.digestMaxChars);
      if (!formatted) return served(held);
      deps.state.digests.set(key, formatted);
      return served(formatted);
    }

    const started = deps.now();
    let result = await deps.client.callTool("context_bootstrap", query ? { ...args, query } : args, meta);

    // An engine before decision 0034 ignores query. A server that refuses it answers tool_error, and
    // without this retry every turn would resend the query and the session would never get a
    // digest. No error text marks a refusal reliably (a schema validator names no field), so every
    // tool_error retries. The cost: during an unrelated engine error each turn makes two calls, and a
    // fallback that succeeds spends the session's query. The retry spends what is left of
    // digestTimeoutMs, so both calls stay under the host's 15 s hook limit.
    if (query && result.kind === "tool_error") {
      const left = cfg.digestTimeoutMs - (deps.now() - started);
      if (left < RETRY_MIN_MS) return undefined;
      deps.logger.info("lumberroom: context_bootstrap failed with a query; fetching the digest without it");
      result = await deps.client.callTool("context_bootstrap", args, { ...meta, timeoutMs: left });
    }

    if (result.kind !== "ok") {
      if (result.kind === "unreachable" || result.kind === "timeout") deps.state.breaker.failure();
      return undefined; // try again next turn, with that turn's text: nothing cached on failure (spec 8.2)
    }
    deps.state.breaker.success();
    const formatted = digestFrom(result, cfg.digestMaxChars);
    if (key) {
      deps.state.digests.set(key, formatted);
      // A query the engine answered, served or refused, spends the session's one query. A
      // query-less first fetch leaves it for the first eligible turn.
      if (query) deps.state.queried.set(key, true);
    }
    return served(formatted);
  } catch (err) {
    deps.logger.warn(`lumberroom: digest hook failed: ${String(err)}`);
    return undefined;
  }
}

async function recallHandler(rawEvent: unknown, rawCtx: unknown, deps: PluginDeps): Promise<{ prependContext: string } | undefined> {
  const ctx = rawCtx as HookCtxLike;
  const event = rawEvent as PromptEventLike;
  try {
    const cfg = deps.state.cfg;
    if (cfg && !cfg.recall) return undefined;
    const gateCfg = cfg ?? INERT_GATE_CFG;
    if (!turnAllowed(identityFromHookCtx(ctx, hostRootConfig(deps)), gateCfg).allowed) return undefined;

    const key = sessionCacheKey(ctx);

    if (!cfg) {
      if (key && hasTold(deps, key, "inert")) return undefined;
      if (key) markTold(deps, key, "inert");
      return finish([inertLine(deps.state.inertReason ?? "misconfigured")]);
    }

    const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
    if (!prompt || prompt.startsWith("/")) return undefined;
    if (!ctx.toolAuthority?.allows("memory_search")) return undefined;
    if (!deps.state.breaker.allow()) return undefined;
    if (!deps.client) return undefined;

    const project = resolveProject(cfg, ctx);
    const meta: CallMeta = { invocation: "hook", timeoutMs: cfg.recallTimeoutMs, ...(key ? { sessionId: key } : {}) };
    const result = await deps.client.callTool(
      "memory_search",
      { query: clipQuery(prompt), limit: cfg.recallLimit, ...(project ? { project } : {}) },
      meta,
    );

    if (result.kind === "login_required") {
      if (key && hasTold(deps, key, "login")) return undefined;
      if (key) markTold(deps, key, "login");
      return finish([LOGIN_LINE]);
    }
    if (result.kind === "unreachable" || result.kind === "timeout") {
      const startsOutage = deps.state.breaker.failure();
      return startsOutage ? finish([UNREACHABLE_LINE]) : undefined;
    }
    if (result.kind !== "ok") return undefined; // tool_error, unauthorized: nothing shown this turn

    deps.state.breaker.success();
    const hits = (result.structured?.hits as Hit[] | undefined) ?? [];
    const seen = (key ? deps.state.seen.get(key) : undefined) ?? new Set<string>();
    const { block, ids } = formatHits(hits, seen, cfg.recallMaxChars);
    if (key && ids.length) {
      const merged = new Set(seen);
      for (const id of ids) merged.add(id);
      deps.state.seen.set(key, merged);
    }

    let nudge = "";
    if (key) {
      const turns = (deps.state.turns.get(key) ?? 0) + 1;
      deps.state.turns.set(key, turns);
      if (cfg.reviewInterval > 0 && turns % cfg.reviewInterval === 0) nudge = NUDGE_LINE;
    }

    const parts: string[] = [];
    if (block || nudge) parts.push(DATA_NOTE);
    if (block) parts.push(block);
    if (nudge) parts.push(nudge);
    return finish(parts);
  } catch (err) {
    deps.logger.warn(`lumberroom: recall hook failed: ${String(err)}`);
    return undefined;
  }
}

function forgetSession(deps: PluginDeps, key: string): void {
  deps.state.digests.delete(key);
  deps.state.queried.delete(key);
  deps.state.seen.delete(key);
  deps.state.turns.delete(key);
  deps.state.told.delete(key);
}

/** Both prompt hooks and session_end. */
export function registerHooks(api: OpenClawPluginApi, deps: PluginDeps): void {
  api.on("before_prompt_build", (event, ctx) => digestHandler(event, ctx, deps));
  api.on("before_prompt_build", (event, ctx) => recallHandler(event, ctx, deps), { requiresToolAuthority: true });
  api.on("session_end", (_event, rawCtx) => {
    const ctx = rawCtx as HookCtxLike;
    const key = ctx.sessionId ?? ctx.sessionKey;
    if (key) forgetSession(deps, key);
  });
}

export function registerGuard(api: OpenClawPluginApi, resolveWorkspace: (agentId: string | undefined) => string): void {
  api.on(
    "before_tool_call",
    (rawEvent, rawCtx) => {
      const event = rawEvent as ToolCallEventLike;
      const ctx = rawCtx as ToolCallCtxLike;
      try {
        const workspaceDir = resolveWorkspace(ctx.agentId);
        const targets = guardTargets(event.toolName, event.params, event.derivedPaths);
        for (const target of targets) {
          if (isGuardedPath(target, workspaceDir)) return { block: true, blockReason: GUARD_REASON };
        }
        return undefined;
      } catch {
        // O10: before_tool_call fails closed, and the guard is the one hook that also blocks on
        // its own thrown error rather than logging and returning undefined.
        return { block: true, blockReason: GUARD_REASON };
      }
    },
    { matcher: [...GUARDED_TOOLS] },
  );
}
