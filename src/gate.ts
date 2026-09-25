import type { GateVerdict, HookCtxLike, LumberroomConfig, ToolCtxLike, TurnIdentity } from "./types.js";

export const REFUSAL = "lumberroom tools are limited to the owner in this chat.";

export function isSharedSessionKey(sessionKey: string | undefined): boolean {
  throw new Error("T3");
}

export function channelFromSessionKey(sessionKey: string | undefined): string | undefined {
  throw new Error("T3");
}

export function identityFromHookCtx(ctx: HookCtxLike): TurnIdentity {
  throw new Error("T3");
}

export function identityFromToolCtx(ctx: ToolCtxLike): TurnIdentity {
  throw new Error("T3");
}

export function turnAllowed(id: TurnIdentity, cfg: LumberroomConfig): GateVerdict {
  throw new Error("T3");
}
