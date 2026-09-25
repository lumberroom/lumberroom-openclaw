import type { TSchema } from "typebox";
import type { Breaker, SessionLru } from "./recall.js";

export type AuthMode = "oauth" | "token";
export type Trigger = "user" | "cron" | "heartbeat";

/** The resolved plugins.entries.lumberroom.config. resolveConfig is the only producer. */
export interface LumberroomConfig {
  baseUrl: string; // origin plus any path prefix, no trailing slash, no /mcp
  mcpUrl: string; // baseUrl + "/mcp"
  hosted: boolean; // isHosted(baseUrl)
  auth: AuthMode;
  token: string | null; // the resolved secret in token mode, else null
  project: string; // "auto" | "none" | a slug or path sent as given
  recall: boolean;
  digest: boolean;
  digestMaxChars: number;
  recallLimit: number;
  recallMaxChars: number;
  reviewInterval: number;
  tools: readonly string[];
  ownerIds: readonly string[]; // "<channel lower case>:<senderId>"
  triggers: readonly Trigger[];
  dreamingReview: boolean;
  digestTimeoutMs: number;
  recallTimeoutMs: number;
  toolTimeoutMs: number;
  connectTimeoutMs: number;
  oauthCallbackPort: number;
}

export type Invocation = "hook" | "model" | "cli";
export type CallKind = "ok" | "tool_error" | "unreachable" | "timeout" | "unauthorized" | "login_required";

export interface CallResult {
  kind: CallKind;
  structured: Record<string, unknown> | null;
  text: string;
  error: string | null; // a readable reason for every kind but ok
  status: number | null; // the HTTP status when one arrived
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolsListing {
  tools: McpTool[];
  instructions: string | null;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
}

export type ListingSource = "live" | "cache" | "snapshot";

export interface CallMeta {
  invocation: Invocation;
  sessionId?: string;
  timeoutMs: number;
}

export interface AdminResponse {
  status: number;
  json: unknown;
}

export interface EngineClient {
  listTools(meta: CallMeta): Promise<{ result: CallResult; listing: ToolsListing | null }>;
  callTool(name: string, args: Record<string, unknown>, meta: CallMeta): Promise<CallResult>;
  /** JSON to the engine origin with the same auth. Throws on a transport failure. */
  admin(method: "GET" | "POST", path: string, body: unknown, meta: { timeoutMs: number; sessionId?: string }): Promise<AdminResponse>;
  /** Settles auth within timeoutMs, then closes every MCP client. */
  close(timeoutMs: number): Promise<void>;
}

export interface AuthHandle {
  readonly mode: AuthMode;
  /** The authorization header for the next request. Throws LoginRequired, FenceTimeout, RefreshUnavailable or TokenSaveFailed. */
  authorize(deadline: AbortSignal): Promise<string>;
  /** The engine answered 401 to a request that carried this header. */
  rejected(authorization: string): void;
  /** Waits up to timeoutMs for a refresh or a pending save. */
  settle(timeoutMs: number): Promise<void>;
}

// No openclaw/plugin-sdk subpath exports the hook context types, so the plugin reads these fields
// structurally. The host's contexts are supersets (OC/src/plugins/hook-types.ts:261-306,
// OC/src/plugins/tool-types.ts:21-80).
export interface HookCtxLike {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  activeProjectKeys?: readonly string[];
  channel?: string;
  senderId?: string;
  chatId?: string;
  channelId?: string;
  channelContext?: { chat?: { id?: string } };
  trigger?: string;
  toolAuthority?: { allows(toolName: string): boolean };
}

export interface ToolCtxLike {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  nativeChannelId?: string;
  activeProjectKeys?: readonly string[];
}

export interface TurnIdentity {
  sessionKey?: string;
  channel?: string;
  senderId?: string;
  chatId?: string;
  trigger?: string;
  /** The host config routes rooms onto this key (the main or global session). */
  roomsRouteHere?: boolean;
}

export type GateReason = "incognito" | "subagent" | "trigger" | "no_owners" | "no_author" | "not_owner";
export type GateVerdict = { allowed: true; shared: boolean } | { allowed: false; reason: GateReason };

export interface Hit {
  id: string;
  namespace: string;
  content: string;
  source?: string;
  occurred_at?: string;
  [key: string]: unknown;
}

export interface RuntimeState {
  cfg: LumberroomConfig | null;
  inertReason: string | null;
  listing: ToolsListing;
  listingSource: ListingSource;
  lastListAttemptMs: number;
  digests: SessionLru<string>;
  seen: SessionLru<Set<string>>;
  turns: SessionLru<number>;
  told: SessionLru<Set<"login" | "inert" | "outage">>;
  breaker: Breaker;
}

export interface PluginLoggerLike {
  info(message: string): void;
  warn(message: string): void;
}

export interface PluginDeps {
  state: RuntimeState;
  client: EngineClient | null; // null when inert or outside full registration
  auth: AuthHandle | null;
  stateDir: string;
  logger: PluginLoggerLike;
  now(): number;
  /** The host's root config, read per turn for session routing. Absent in unit tests. */
  rootConfig?(): unknown;
}

export interface ImportEntry {
  file: "MEMORY.md" | "USER.md" | `memory/${string}`;
  path: string; // absolute
  text: string;
  sha256: string;
  namespace: "global" | "user:me";
}

export interface ImportReport {
  runId: string | null;
  posted: number;
  proposalsNew: number;
  proposalsReinforced: number;
  refused: number;
  blocked: number;
}

export type ToolParameters = TSchema;
