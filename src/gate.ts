import { isIncognitoSessionKey, isSubagentSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { GateVerdict, HookCtxLike, LumberroomConfig, ToolCtxLike, TurnIdentity } from "./types.js";

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

export function identityFromHookCtx(ctx: HookCtxLike): TurnIdentity {
  return {
    sessionKey: ctx.sessionKey,
    channel: ctx.channel,
    senderId: ctx.senderId,
    trigger: ctx.trigger ?? "user",
  };
}

export function identityFromToolCtx(ctx: ToolCtxLike): TurnIdentity {
  return {
    sessionKey: ctx.sessionKey,
    channel: channelFromSessionKey(ctx.sessionKey) ?? ctx.messageChannel?.split(":")[0],
    senderId: ctx.requesterSenderId,
    trigger: "user",
  };
}

export function turnAllowed(id: TurnIdentity, cfg: LumberroomConfig): GateVerdict {
  if (isIncognitoSessionKey(id.sessionKey)) return { allowed: false, reason: "incognito" };
  if (isSubagentSessionKey(id.sessionKey)) return { allowed: false, reason: "subagent" };
  const trigger = id.trigger ?? "user";
  if (!(cfg.triggers as readonly string[]).includes(trigger)) return { allowed: false, reason: "trigger" };

  if (isSharedSessionKey(id.sessionKey)) {
    if (!cfg.ownerIds.length) return { allowed: false, reason: "no_owners" };
    if (!id.senderId) return { allowed: false, reason: "no_author" };
    const key = `${(id.channel ?? "").toLowerCase()}:${id.senderId}`;
    if (!cfg.ownerIds.includes(key)) return { allowed: false, reason: "not_owner" };
    return { allowed: true, shared: true };
  }

  return { allowed: true, shared: false };
}
