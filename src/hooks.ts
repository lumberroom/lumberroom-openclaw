import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_TRIGGERS } from "./config.js";
import { identityFromHookCtx, turnAllowed } from "./gate.js";
import { GUARDED_TOOLS, GUARD_REASON, guardTargets, isGuardedPath } from "./guard.js";
import {
  DATA_NOTE,
  LOGIN_LINE,
  NUDGE_LINE,
  UNREACHABLE_LINE,
  clipQuery,
  formatDigest,
  formatHits,
  inertLine,
  wrapRecall,
} from "./recall.js";
import type { CallMeta, Hit, HookCtxLike, LumberroomConfig, PluginDeps } from "./types.js";

// The gate must still fail closed when the plugin is inert and no LumberroomConfig exists to read
// triggers and ownerIds from (spec 9: "fails closed where it cannot tell who is speaking"). This
// carries only the two fields turnAllowed reads, so an inert turn in a shared chat with no owners
// configured stays refused rather than defaulting open.
const INERT_GATE_CFG = { triggers: DEFAULT_TRIGGERS, ownerIds: [] } as unknown as LumberroomConfig;

interface PromptEventLike {
  prompt?: unknown;
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

async function digestHandler(_event: unknown, rawCtx: unknown, deps: PluginDeps): Promise<{ prependSystemContext: string } | undefined> {
  const ctx = rawCtx as HookCtxLike;
  try {
    const cfg = deps.state.cfg;
    if (!cfg || !cfg.recall || !cfg.digest) return undefined;
    if (!turnAllowed(identityFromHookCtx(ctx), cfg).allowed) return undefined;
    if (!deps.state.breaker.allow()) return undefined;

    const key = sessionCacheKey(ctx);
    if (key) {
      const cached = deps.state.digests.get(key);
      if (cached !== undefined) return cached ? { prependSystemContext: cached } : undefined;
    }
    if (!deps.client) return undefined;

    const project = resolveProject(cfg, ctx);
    const meta: CallMeta = { invocation: "hook", timeoutMs: cfg.digestTimeoutMs, ...(key ? { sessionId: key } : {}) };
    const result = await deps.client.callTool("context_bootstrap", project ? { project } : {}, meta);

    if (result.kind !== "ok") {
      if (result.kind === "unreachable" || result.kind === "timeout") deps.state.breaker.failure();
      return undefined; // try again next turn: nothing cached on failure (spec 8.2)
    }
    deps.state.breaker.success();
    const text = typeof result.structured?.text === "string" ? (result.structured.text as string) : "";
    const formatted = formatDigest(text, cfg.digestMaxChars);
    if (key) deps.state.digests.set(key, formatted);
    return formatted ? { prependSystemContext: formatted } : undefined;
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
    if (!turnAllowed(identityFromHookCtx(ctx), gateCfg).allowed) return undefined;

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
