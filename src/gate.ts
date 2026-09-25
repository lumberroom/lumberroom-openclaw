import { isIncognitoSessionKey, isSubagentSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { GateVerdict, HookCtxLike, LumberroomConfig, PluginDeps, ToolCtxLike, TurnIdentity } from "./types.js";

export const REFUSAL = "lumberroom tools are limited to the owner in this chat.";

const CANONICAL_PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);
const LEGACY_GROUP_RE = /^group:[^:]+(?::.*)?$/;
const LEGACY_CHANNEL_RE = /^channel:[^:]+(?::.*)?$/;
const WHATSAPP_GROUP_RE = /^(?:whatsapp:)?[^:]+@g\.us$/;
const DISCORD_CHANNEL_RE = /^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/;

/** The rest of the session key after "agent:<id>:", lower-cased, or the whole key when it carries no agent wrapper. */
function restOfSessionKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return (parsed ? parsed.rest : sessionKey).toLowerCase();
}

export function isSharedSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const rest = restOfSessionKey(sessionKey);
  if (LEGACY_GROUP_RE.test(rest) || LEGACY_CHANNEL_RE.test(rest)) return true;
  if (WHATSAPP_GROUP_RE.test(rest) || DISCORD_CHANNEL_RE.test(rest)) return true;
  const segments = rest.split(":");
  return segments.includes("group") || segments.includes("channel") || segments.includes("thread");
}

/** The channel of a canonical "<channel>:(direct|dm|group|channel):<id>" or account-form shape. undefined for a bare or legacy shape. */
export function channelFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const rest = restOfSessionKey(sessionKey);
  const parts = rest.split(":");
  if (parts.length >= 2 && parts[0] && CANONICAL_PEER_KINDS.has(parts[1] ?? "")) return parts[0];
  if (parts.length >= 3 && parts[0] && parts[1] && CANONICAL_PEER_KINDS.has(parts[2] ?? "")) return parts[0];
  return undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * session.groupScope "main" (global or on any binding) sends group, channel and room turns to the
 * agent's main key, and session.scope "global" sends every turn to "global" (OC docs/concepts/
 * session.md). On those keys the key alone cannot show a room, so the gate has to ask the context.
 */
export function roomsRouteToKey(sessionKey: string | undefined, root: unknown): boolean {
  if (!sessionKey) return false;
  const session = rec(rec(root).session);
  const bindings = rec(root).bindings;
  const groupsInMain =
    session.groupScope === "main" || (Array.isArray(bindings) && bindings.some((b) => rec(rec(b).session).groupScope === "main"));
  if (session.scope === "global" && sessionKey.toLowerCase() === "global") return true;
  if (!groupsInMain) return false;
  const mainKey = typeof session.mainKey === "string" && session.mainKey.trim() ? session.mainKey.trim().toLowerCase() : "main";
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed !== null && parsed.rest.toLowerCase() === mainKey;
}

// Reads as "rooms reach main and global", so a config the plugin cannot read fails closed.
const UNREADABLE_ROOT = { session: { groupScope: "main", scope: "global" } };

/** The host config for roomsRouteToKey. */
export function hostRootConfig(deps: Pick<PluginDeps, "rootConfig">): unknown {
  try {
    return deps.rootConfig?.();
  } catch {
    return UNREADABLE_ROOT;
  }
}

export function identityFromHookCtx(ctx: HookCtxLike, root?: unknown): TurnIdentity {
  return {
    sessionKey: ctx.sessionKey,
    channel: ctx.channel,
    senderId: ctx.senderId,
    chatId: ctx.chatId ?? ctx.channelId ?? ctx.channelContext?.chat?.id,
    trigger: ctx.trigger ?? "user",
    roomsRouteHere: roomsRouteToKey(ctx.sessionKey, root),
  };
}

export function identityFromToolCtx(ctx: ToolCtxLike, root?: unknown): TurnIdentity {
  return {
    sessionKey: ctx.sessionKey,
    channel: channelFromSessionKey(ctx.sessionKey) ?? ctx.messageChannel?.split(":")[0],
    senderId: ctx.requesterSenderId,
    chatId: ctx.nativeChannelId,
    trigger: "user",
    roomsRouteHere: roomsRouteToKey(ctx.sessionKey, root),
  };
}

// OpenClaw's internal channel (OC/src/utils/message-channel-constants.ts). The Control UI, the TUI
// and gateway clients such as the CLI speak on it, and all of them hold the operator credential.
const INTERNAL_CHANNEL = "webchat";

function sameId(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Whether a turn on a key rooms route to could have come from a room. OpenClaw sets the hook chatId
 * on every turn and falls back to the channel name, so only a chat that differs from both the
 * channel and the sender names a room. A sender with no chat could be anywhere and counts.
 */
function mayComeFromRoom(id: TurnIdentity): boolean {
  if (sameId(id.channel, INTERNAL_CHANNEL)) return false;
  const chat = sameId(id.chatId, id.channel) ? undefined : id.chatId;
  if (chat) return !sameId(chat, id.senderId);
  return Boolean(id.senderId);
}

export function turnAllowed(id: TurnIdentity, cfg: LumberroomConfig): GateVerdict {
  if (isIncognitoSessionKey(id.sessionKey)) return { allowed: false, reason: "incognito" };
  if (isSubagentSessionKey(id.sessionKey)) return { allowed: false, reason: "subagent" };
  const trigger = id.trigger ?? "user";
  if (!(cfg.triggers as readonly string[]).includes(trigger)) return { allowed: false, reason: "trigger" };

  // On a key rooms route to, the key cannot tell a room from a DM, so the context has to.
  const routedRoomTurn = id.roomsRouteHere === true && mayComeFromRoom(id);
  if (isSharedSessionKey(id.sessionKey) || routedRoomTurn) {
    if (!cfg.ownerIds.length) return { allowed: false, reason: "no_owners" };
    if (!id.senderId) return { allowed: false, reason: "no_author" };
    const key = `${(id.channel ?? "").toLowerCase()}:${id.senderId}`;
    if (!cfg.ownerIds.includes(key)) return { allowed: false, reason: "not_owner" };
    return { allowed: true, shared: true };
  }

  return { allowed: true, shared: false };
}
