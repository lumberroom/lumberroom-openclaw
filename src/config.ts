import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { ConfigError } from "./errors.js";
import type { AuthMode, LumberroomConfig, Trigger } from "./types.js";

export const HOSTED_DOMAIN = "lumberroom.cloud";
export const HOSTED_BASE_URL = "https://mcp.lumberroom.cloud";
export const TOKEN_ENV = "LUMBERROOM_OPENCLAW_TOKEN";
export const REVIEW_TOOLS = ["review_queue", "review_decide"] as const;
export const DECLARED_TOOLS = [
  "memory_search", "memory_write", "registry_get", "memory_forget", "memory_history",
  "registry_history", "registry_set", "alias_set", "alias_list", "review_queue", "review_decide",
] as const;
export const DEFAULT_TOOLS = ["memory_search", "memory_write", "registry_get", "memory_forget"] as const;
export const SIDE_EFFECTING_TOOLS = ["memory_write", "memory_forget", "registry_set", "alias_set", "review_decide"] as const;
export const DEFAULT_TRIGGERS: readonly Trigger[] = ["user", "cron"];
// The gateway's HTTP chat surfaces run turns on this channel with no sender id, and the caller picks
// the session key (OC/src/gateway/http-utils.ts:289-311). An owner entry there would match nobody
// OpenClaw verified.
export const UNLISTABLE_CHANNELS = ["webchat"] as const;

const INTS = {
  digestMaxChars: [0, 50_000, 6000],
  recallLimit: [1, 20, 4],
  recallMaxChars: [0, 20_000, 1200],
  reviewInterval: [0, 1000, 10],
  digestTimeoutMs: [500, 14_000, 4000],
  recallTimeoutMs: [500, 14_000, 3000],
  toolTimeoutMs: [1000, 120_000, 20_000],
  connectTimeoutMs: [500, 30_000, 3000],
  oauthCallbackPort: [1024, 65_535, 47_632],
} as const;
const BOOLS = { recall: true, digest: true, dreamingReview: false } as const;
const KNOWN = new Set<string>([
  "baseUrl", "auth", "token", "project", "tools", "ownerIds", "triggers", "dreaming",
  ...Object.keys(INTS), ...Object.keys(BOOLS),
]);
const TRIGGERS: readonly Trigger[] = ["user", "cron", "heartbeat"];

/** The engine origin, with one trailing slash and a trailing /mcp removed. */
export function normalizeBaseUrl(raw: unknown): string {
  if (raw === undefined || raw === null) return HOSTED_BASE_URL;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ConfigError("baseUrl must be the engine's URL, such as http://127.0.0.1:8787");
  }
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`baseUrl must start with http:// or https://, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`baseUrl must start with http:// or https://, got ${JSON.stringify(raw)}`);
  }
  // Text after "?", "#" or "@" can pass for the host in isHosted while the client connects elsewhere:
  // https://evil.example?.lumberroom.cloud and https://lumberroom.cloud@evil.example both.
  if (/[?#]/.test(text) || url.username || url.password || !url.hostname) {
    throw new ConfigError(`baseUrl must be a plain origin such as https://host, got ${JSON.stringify(raw)}`);
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/mcp")) path = path.slice(0, -"/mcp".length);
  return `${url.protocol}//${url.host}${path}`;
}

/** The host is lumberroom.cloud or one of its subdomains. Engine and fork both answer rmcp, so the host is the only signal. */
export function isHosted(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === HOSTED_DOMAIN || host.endsWith(`.${HOSTED_DOMAIN}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const MEMORY_CORE_ID = "memory-core";
export interface SidecarCheck { dreamingOff: boolean; memoryCoreOff: boolean }

/**
 * OpenClaw loads memory-core beside the slot owner as a dreaming sidecar that skips slot exclusion
 * and registers its own memory_search, unless our dreaming.enabled is false or memory-core is
 * disabled or denied (OC/src/plugins/loader-shared.ts:73-139). Setup turns both off, so one reset
 * still leaves the other. A missing key counts as on, as the host reads it.
 */
export function sidecarCheck(root: unknown): SidecarCheck {
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
  const plugins = rec(rec(root).plugins);
  const entries = rec(plugins.entries);
  const dreaming = rec(rec(rec(entries.lumberroom).config).dreaming);
  const core = rec(entries[MEMORY_CORE_ID]);
  const deny: unknown[] = Array.isArray(plugins.deny) ? plugins.deny : [];
  return {
    dreamingOff: dreaming.enabled === false,
    memoryCoreOff: core.enabled === false || deny.includes(MEMORY_CORE_ID),
  };
}

function stringList(block: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in block)) return undefined;
  const v = block[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) {
    throw new ConfigError(`${key} must be a list of strings`);
  }
  return [...new Set(v.map((x: string) => x.trim()))];
}

/** Meaning and defaults. Throws ConfigError naming the key; the host already checked shapes. */
export function resolveConfig(raw: unknown): LumberroomConfig {
  const block = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(block)) throw new ConfigError("plugins.entries.lumberroom.config must be an object");
  const unknown = Object.keys(block).filter((k) => !KNOWN.has(k)).sort();
  if (unknown.length) throw new ConfigError(`unknown key ${unknown[0]}`);

  const baseUrl = normalizeBaseUrl(block.baseUrl);
  const auth = (block.auth ?? "oauth") as AuthMode;
  if (auth !== "oauth" && auth !== "token") throw new ConfigError("auth must be oauth or token");

  let token: string | null = null;
  if (auth === "token") {
    // The host resolves a SecretRef before the plugin sees it. An object here is one that did not
    // resolve, usually because LUMBERROOM_OPENCLAW_TOKEN is missing from $OPENCLAW_STATE_DIR/.env.
    if (typeof block.token !== "string" || !block.token.trim()) {
      throw new ConfigError(`auth token needs token; set ${TOKEN_ENV} in $OPENCLAW_STATE_DIR/.env or rerun openclaw lumberroom setup`);
    }
    token = block.token.trim();
  }

  const project = block.project ?? "auto";
  if (typeof project !== "string" || !project.trim()) throw new ConfigError("project must be auto, none, or a slug or path");

  const bools = { ...BOOLS } as Record<keyof typeof BOOLS, boolean>;
  for (const key of Object.keys(BOOLS) as (keyof typeof BOOLS)[]) {
    if (key in block) {
      if (typeof block[key] !== "boolean") throw new ConfigError(`${key} must be true or false`);
      bools[key] = block[key] as boolean;
    }
  }

  const ints = {} as Record<keyof typeof INTS, number>;
  for (const [key, [lo, hi, dflt]] of Object.entries(INTS) as [keyof typeof INTS, readonly [number, number, number]][]) {
    const v = key in block ? block[key] : dflt;
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
      throw new ConfigError(`${key} must be a whole number from ${lo} to ${hi}`);
    }
    ints[key] = v;
  }

  const tools = stringList(block, "tools") ?? [...DEFAULT_TOOLS];
  if (!tools.length) throw new ConfigError("tools must name at least one tool");
  for (const t of tools) {
    if ((REVIEW_TOOLS as readonly string[]).includes(t)) {
      throw new ConfigError(`tools cannot list ${t}; dreamingReview controls it`);
    }
    if (!(DECLARED_TOOLS as readonly string[]).includes(t)) throw new ConfigError(`tools lists unknown tool ${t}`);
  }

  const ownerIds = (stringList(block, "ownerIds") ?? []).map((entry) => {
    const at = entry.indexOf(":");
    const channel = entry.slice(0, at).toLowerCase();
    const sender = entry.slice(at + 1);
    if (at <= 0 || !sender || /\s/.test(entry)) {
      throw new ConfigError(`ownerIds entries look like telegram:123456789, got ${JSON.stringify(entry)}`);
    }
    if ((UNLISTABLE_CHANNELS as readonly string[]).includes(channel)) {
      throw new ConfigError(`ownerIds cannot list ${JSON.stringify(entry)}: a ${channel} turn carries no sender OpenClaw verified`);
    }
    return `${channel}:${sender}`;
  });

  const triggers = (stringList(block, "triggers") ?? [...DEFAULT_TRIGGERS]) as Trigger[];
  for (const t of triggers) if (!TRIGGERS.includes(t)) throw new ConfigError(`triggers may list user, cron, heartbeat; got ${t}`);

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    hosted: isHosted(baseUrl),
    auth,
    token,
    project: project.trim(),
    recall: bools.recall,
    digest: bools.digest,
    dreamingReview: bools.dreamingReview,
    ...ints,
    tools,
    ownerIds,
    triggers,
  };
}

/** Shape-only for the host: a semantic error must leave the plugin inert, never unloaded, so the guard and the null flush plan stay registered. */
export const configSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined || isRecord(value)) return { success: true, data: value ?? {} };
    return { success: false, error: { issues: [{ path: [], message: "expected an object" }] } };
  },
};
