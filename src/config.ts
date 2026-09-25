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

/**
 * What a ConfigError may say about a rejected baseUrl. The message reaches the gateway log and the
 * model through the inert line, so userinfo, query and fragment never appear, and neither does text
 * that is no URL at all (a token pasted into the wrong field).
 */
function describeRejected(url: URL | null): string {
  if (!url) return "a value that is not a URL";
  const userinfo = url.username || url.password ? "<credentials>@" : "";
  const tail = `${url.search ? "?<query>" : ""}${url.hash ? "#<fragment>" : ""}`;
  return JSON.stringify(`${url.protocol}//${userinfo}${url.host}${url.pathname}${tail}`);
}

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
    throw new ConfigError(`baseUrl must start with http:// or https://, got ${describeRejected(null)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`baseUrl must start with http:// or https://, got ${describeRejected(url)}`);
  }
  // Text after "?", "#" or "@" can pass for the host in isHosted while the client connects elsewhere:
  // https://evil.example?.lumberroom.cloud and https://lumberroom.cloud@evil.example both.
  if (/[?#]/.test(text) || url.username || url.password || !url.hostname) {
    throw new ConfigError(`baseUrl must be a plain origin such as https://host, got ${describeRejected(url)}`);
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

// Modes that start each message as its own turn, so the owner gate sees every sender.
const SAFE_QUEUE_MODES = new Set(["followup", "interrupt"]);
// Overflow policies that never fold one sender's message into another's turn.
const SAFE_QUEUE_DROPS = new Set(["old", "new"]);

export interface UnsafeQueueModes {
  mode: string | null; // the global mode when it steers or collects, else null
  drop: string | null; // the overflow policy when it summarizes, else null
  byChannel: Array<{ channel: string; mode: string }>;
}

/**
 * OpenClaw steers a message that arrives mid-run into that run, whoever sent it, and the run keeps
 * the tools its first sender was granted (OC docs/concepts/queue-steering.md, "Scope"). collect can
 * fold several senders into one turn. Either one hands a non-owner the owner's lumberroom tools.
 * The default drop, summarize, folds dropped messages into a synthetic turn the same way
 * (OC docs/concepts/queue.md). Unset mode reads as steer and unset drop as summarize, as the host does.
 */
export function unsafeQueueModes(root: unknown): UnsafeQueueModes {
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
  const queue = rec(rec(rec(root).messages).queue);
  const mode = typeof queue.mode === "string" ? queue.mode.toLowerCase() : "steer";
  const drop = typeof queue.drop === "string" ? queue.drop.toLowerCase() : "summarize";
  const byChannel = Object.entries(rec(queue.byChannel))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !SAFE_QUEUE_MODES.has(entry[1].toLowerCase()))
    .map(([channel, m]) => ({ channel, mode: m }));
  return { mode: SAFE_QUEUE_MODES.has(mode) ? null : mode, drop: SAFE_QUEUE_DROPS.has(drop) ? null : drop, byChannel };
}

export const SESSION_MEMORY_HOOK = "session-memory";

export interface InternalHookSelection {
  configured: boolean; // OpenClaw runs internal hook discovery at all
  names: Set<string> | null; // null loads every discovered hook; a set loads only those names
}

/**
 * OpenClaw's resolveInternalHookSelection (OC src/hooks/configured.ts) over the config alone. Hook
 * installs sit in OpenClaw's state database, which no plugin API reads. An install with a hook list
 * only narrows the selection further; one with an empty list opens discovery, and this cannot see it.
 */
export function internalHookSelection(root: unknown): InternalHookSelection {
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
  const internal = rec(rec(rec(root).hooks).internal);
  const extraDirs = rec(internal.load).extraDirs;
  const open = Array.isArray(extraDirs) && extraDirs.some((dir) => typeof dir === "string" && dir.trim().length > 0);
  const entries = Object.entries(rec(internal.entries));
  const names = new Set<string>();
  let declared = 0;
  for (const [name, entry] of entries) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    declared += 1;
    if (rec(entry).enabled !== false) names.add(trimmed);
  }
  if (internal.enabled === false) return { configured: false, names: new Set() };
  return {
    configured: internal.enabled === true || entries.some(([, entry]) => rec(entry).enabled !== false) || open,
    names: open || (declared === 0 && internal.enabled === true) ? null : names,
  };
}

/**
 * OpenClaw's bundled session-memory hook writes <workspace>/memory/*.md through fs on /new, /reset
 * and auto-reset, where the write guard never sees it (OC src/hooks/bundled/session-memory). It loads
 * when discovery runs, the selection admits it, and its own entry is not enabled: false
 * (OC src/hooks/loader.ts, src/hooks/policy.ts).
 */
export function sessionMemoryHookOff(root: unknown): boolean {
  const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
  const { configured, names } = internalHookSelection(root);
  const entry = rec(rec(rec(rec(rec(root).hooks).internal).entries)[SESSION_MEMORY_HOOK]);
  return !configured || (names !== null && !names.has(SESSION_MEMORY_HOOK)) || entry.enabled === false;
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
