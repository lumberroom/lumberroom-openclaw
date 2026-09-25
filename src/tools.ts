import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { DECLARED_TOOLS } from "./config.js";
import { identityFromToolCtx, turnAllowed } from "./gate.js";
import { exposedTools, toParameters } from "./schemas.js";
import type { CallMeta, CallResult, LumberroomConfig, McpTool, PluginDeps, ToolCtxLike } from "./types.js";

const TAIL: Record<string, string> = {
  memory_write: "Nothing was stored.",
  memory_forget: "Nothing was deleted.",
  registry_set: "Nothing was changed.",
  alias_set: "Nothing was changed.",
  review_decide: "Nothing was changed.",
};

function tailFor(name: string): string {
  return TAIL[name] ?? "No memory was read.";
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Spec 12's tool-call failure texts, character for character. */
function describeFailure(name: string, cfg: LumberroomConfig, result: CallResult): string {
  switch (result.kind) {
    case "login_required":
      return "lumberroom is not signed in. Run: openclaw lumberroom login";
    case "unauthorized":
      return cfg.auth === "token"
        ? "lumberroom refused the configured token (401). Check plugins.entries.lumberroom.config.token and its grant."
        : "lumberroom is not signed in. Run: openclaw lumberroom login";
    case "unreachable":
      return `lumberroom unreachable at ${hostOf(cfg.baseUrl)}: ${result.error ?? "unreachable"}. ${tailFor(name)}`;
    case "timeout":
      return result.status !== null
        ? `lumberroom answered HTTP ${result.status}. The call may have taken effect; search before retrying.`
        : `lumberroom did not answer within ${Math.round(cfg.toolTimeoutMs / 1000)}s. The call may have taken effect; search before retrying.`;
    case "tool_error":
      return result.error ?? `${name} failed`;
    default:
      return result.error ?? "lumberroom failed";
  }
}

function toAgentTool(tool: McpTool, cfg: LumberroomConfig, deps: PluginDeps, ctx: ToolCtxLike) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: toParameters(tool.inputSchema),
    async execute(_toolCallId: string, params: unknown) {
      if (!deps.client) {
        return textResult(`lumberroom unreachable: no engine connection. ${tailFor(tool.name)}`, { status: "error", kind: "unreachable" });
      }
      const meta: CallMeta = { invocation: "model", timeoutMs: cfg.toolTimeoutMs, ...(ctx.sessionId ?? ctx.sessionKey ? { sessionId: ctx.sessionId ?? ctx.sessionKey } : {}) };
      const result = await deps.client.callTool(tool.name, (params && typeof params === "object" ? params : {}) as Record<string, unknown>, meta);
      if (result.kind === "ok") {
        return textResult(JSON.stringify(result.structured ?? {}), result.structured);
      }
      return textResult(describeFailure(tool.name, cfg, result), { status: "error", kind: result.kind });
    },
  };
}

function factory(ctx: ToolCtxLike, deps: PluginDeps) {
  const cfg = deps.state.cfg;
  if (!cfg) return null;
  const verdict = turnAllowed(identityFromToolCtx(ctx), cfg);
  if (!verdict.allowed) return null;
  const tools = exposedTools(cfg, deps.state.listing, deps.state.listingSource);
  return tools.map((tool) => toAgentTool(tool, cfg, deps, ctx));
}

export function registerTools(api: OpenClawPluginApi, deps: PluginDeps): void {
  api.registerTool((ctx) => factory(ctx as ToolCtxLike, deps), { names: [...DECLARED_TOOLS] });
}
