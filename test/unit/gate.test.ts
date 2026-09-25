import { buildAgentHookContextChannelFields } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { channelFromSessionKey, identityFromHookCtx, identityFromToolCtx, isSharedSessionKey, turnAllowed } from "../../src/gate.js";
import { resolveConfig } from "../../src/config.js";
import type { HookCtxLike, LumberroomConfig, ToolCtxLike } from "../../src/types.js";

function cfgWith(overrides: Record<string, unknown>): LumberroomConfig {
  return resolveConfig(overrides);
}

describe("isSharedSessionKey", () => {
  it.each([
    ["agent:main:telegram:group:123", true],
    ["agent:main:telegram:channel:123", true],
    ["agent:main:group:123", true],
    ["agent:main:channel:123", true],
    ["agent:main:123@g.us", true],
    ["agent:main:whatsapp:123@g.us", true],
    ["agent:main:discord:guild-1:channel-2", true],
    ["agent:main:telegram:group:123:thread:9", true],
  ])("%s is a shared session", (key) => {
    expect(isSharedSessionKey(key)).toBe(true);
  });

  it.each([
    ["agent:main:telegram:direct:123", false],
    ["agent:main:telegram:dm:123", false],
    ["agent:main:direct:123", false],
    ["agent:main:main", false],
    [undefined, false],
  ] as Array<[string | undefined, boolean]>)("%s is not a shared session", (key, shared) => {
    expect(isSharedSessionKey(key)).toBe(shared);
  });
});

describe("channelFromSessionKey", () => {
  it("reads the channel from the canonical shape", () => {
    expect(channelFromSessionKey("agent:main:telegram:group:123")).toBe("telegram");
    expect(channelFromSessionKey("agent:main:telegram:direct:123")).toBe("telegram");
  });

  it("reads the channel from the account form", () => {
    expect(channelFromSessionKey("agent:main:telegram:acct1:group:123")).toBe("telegram");
  });

  it("has no channel for a bare direct or dm shape", () => {
    expect(channelFromSessionKey("agent:main:direct:123")).toBeUndefined();
    expect(channelFromSessionKey("agent:main:dm:123")).toBeUndefined();
  });

  it("has no channel for a legacy group shape", () => {
    expect(channelFromSessionKey("agent:main:group:123")).toBeUndefined();
  });

  it("has no channel for an undefined session key", () => {
    expect(channelFromSessionKey(undefined)).toBeUndefined();
  });
});

describe("identityFromHookCtx", () => {
  it("carries sessionKey, channel, senderId and trigger straight from the context", () => {
    const ctx: HookCtxLike = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", senderId: "42", trigger: "user" };
    expect(identityFromHookCtx(ctx)).toEqual({ sessionKey: ctx.sessionKey, channel: "telegram", senderId: "42", trigger: "user", roomsRouteHere: false });
  });

  it("defaults trigger to user when the context carries none", () => {
    const ctx: HookCtxLike = { sessionKey: "agent:main:main" };
    expect(identityFromHookCtx(ctx).trigger).toBe("user");
  });

  it("leaves senderId undefined for a non-user trigger, as O12 requires the host to", () => {
    const ctx: HookCtxLike = { sessionKey: "agent:main:cron:job", trigger: "cron" };
    expect(identityFromHookCtx(ctx).senderId).toBeUndefined();
  });
});

describe("identityFromToolCtx", () => {
  it("derives the channel from the session key when the shape is canonical", () => {
    const ctx: ToolCtxLike = { sessionKey: "agent:main:telegram:group:1", requesterSenderId: "42", messageChannel: "webchat" };
    expect(identityFromToolCtx(ctx)).toEqual({ sessionKey: ctx.sessionKey, channel: "telegram", senderId: "42", trigger: "user", roomsRouteHere: false });
  });

  it("falls back to the first segment of messageChannel when the session key carries no channel", () => {
    const ctx: ToolCtxLike = { sessionKey: "agent:main:direct:1", requesterSenderId: "42", messageChannel: "webchat:room1" };
    expect(identityFromToolCtx(ctx).channel).toBe("webchat");
  });

  it("always counts as trigger user, since a tool context carries none", () => {
    const ctx: ToolCtxLike = { sessionKey: "agent:main:main" };
    expect(identityFromToolCtx(ctx).trigger).toBe("user");
  });
});

describe("turnAllowed", () => {
  const owned = cfgWith({ ownerIds: ["telegram:42"] });
  const unowned = cfgWith({});

  it("refuses an incognito session key", () => {
    const id = { sessionKey: "agent:main:dashboard:incognito-1", trigger: "user" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: false, reason: "incognito" });
  });

  it("refuses a subagent session key", () => {
    const id = { sessionKey: "agent:main:subagent:1", trigger: "user" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: false, reason: "subagent" });
  });

  it("refuses a trigger outside the configured triggers", () => {
    const id = { sessionKey: "agent:main:main", trigger: "heartbeat" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: false, reason: "trigger" });
  });

  it("allows a direct session with the default triggers", () => {
    const id = { sessionKey: "agent:main:telegram:direct:1", channel: "telegram", senderId: "1", trigger: "user" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: true, shared: false });
  });

  it("allows the main session with no sender at all", () => {
    const id = { sessionKey: "agent:main:main", trigger: "user" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: true, shared: false });
  });

  // Review focus 2: a group turn with no sender id is refused, not merely unrecognized.
  it("refuses a group turn with no sender id", () => {
    const id = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", trigger: "user" };
    expect(turnAllowed(id, owned)).toEqual({ allowed: false, reason: "no_author" });
  });

  it("refuses a shared session when ownerIds is empty", () => {
    const id = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", senderId: "42", trigger: "user" };
    expect(turnAllowed(id, unowned)).toEqual({ allowed: false, reason: "no_owners" });
  });

  it("refuses a shared session whose sender is not listed", () => {
    const id = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", senderId: "99", trigger: "user" };
    expect(turnAllowed(id, owned)).toEqual({ allowed: false, reason: "not_owner" });
  });

  it("allows a shared session whose sender is listed", () => {
    const id = { sessionKey: "agent:main:telegram:group:1", channel: "telegram", senderId: "42", trigger: "user" };
    expect(turnAllowed(id, owned)).toEqual({ allowed: true, shared: true });
  });

  it("matches the channel case-insensitively against the lower-cased ownerIds entry", () => {
    const id = { sessionKey: "agent:main:telegram:group:1", channel: "Telegram", senderId: "42", trigger: "user" };
    expect(turnAllowed(id, owned)).toEqual({ allowed: true, shared: true });
  });
});

// F3: session.groupScope "main" (global or on a binding) and session.scope "global" put room turns on
// the main or global key, so the key alone cannot say the turn came from a shared room.
describe("turnAllowed when rooms route into the main session", () => {
  const owned = cfgWith({ ownerIds: ["slack:UOWNER"] });
  const unowned = cfgWith({});
  const groupScopeMain = { session: { groupScope: "main" } };
  const bindingMain = { bindings: [{ agentId: "main", match: { channel: "slack", peer: { kind: "channel", id: "C0123TEAM" } }, session: { groupScope: "main" } }] };
  const scopeGlobal = { session: { scope: "global" } };
  const strangerInRoom: HookCtxLike = { sessionKey: "agent:main:main", channel: "slack", senderId: "USTRANGER", chatId: "C0123TEAM", trigger: "user" };

  it.each([
    ["session.groupScope main", groupScopeMain],
    ["a binding with groupScope main", bindingMain],
  ])("refuses an unlisted sender on the main key under %s", (_label, root) => {
    expect(turnAllowed(identityFromHookCtx(strangerInRoom, root), owned)).toEqual({ allowed: false, reason: "not_owner" });
    const toolCtx: ToolCtxLike = { sessionKey: "agent:main:main", messageChannel: "slack", requesterSenderId: "USTRANGER", nativeChannelId: "C0123TEAM" };
    expect(turnAllowed(identityFromToolCtx(toolCtx, root), owned)).toEqual({ allowed: false, reason: "not_owner" });
  });

  it("refuses an unlisted sender on the global key under session.scope global", () => {
    const ctx: HookCtxLike = { sessionKey: "global", channel: "telegram", senderId: "999", trigger: "user" };
    expect(turnAllowed(identityFromHookCtx(ctx, scopeGlobal), cfgWith({ ownerIds: ["telegram:42"] }))).toEqual({ allowed: false, reason: "not_owner" });
  });

  it("refuses a room turn on the main key when no owners are listed", () => {
    expect(turnAllowed(identityFromHookCtx(strangerInRoom, groupScopeMain), unowned)).toEqual({ allowed: false, reason: "no_owners" });
  });

  it("allows a listed owner on the main key as a shared turn", () => {
    const ctx = { ...strangerInRoom, senderId: "UOWNER" };
    expect(turnAllowed(identityFromHookCtx(ctx, groupScopeMain), owned)).toEqual({ allowed: true, shared: true });
  });

  it("still allows a local turn on the main key, which carries no sender and no chat", () => {
    const ctx: HookCtxLike = { sessionKey: "agent:main:main", trigger: "user" };
    expect(turnAllowed(identityFromHookCtx(ctx, groupScopeMain), unowned)).toEqual({ allowed: true, shared: false });
  });

  it("reads the chat from channelContext when chatId is absent", () => {
    const ctx: HookCtxLike = { sessionKey: "agent:main:main", channel: "slack", channelContext: { chat: { id: "C0123TEAM" } }, trigger: "user" };
    expect(turnAllowed(identityFromHookCtx(ctx, groupScopeMain), owned)).toEqual({ allowed: false, reason: "no_author" });
  });

  it("leaves the main key alone when rooms keep their own sessions", () => {
    expect(turnAllowed(identityFromHookCtx(strangerInRoom, { session: { groupScope: "per-group" } }), owned)).toEqual({ allowed: true, shared: false });
    expect(turnAllowed(identityFromHookCtx(strangerInRoom), owned)).toEqual({ allowed: true, shared: false });
  });

  it("refuses a tool turn that names a room but no requester", () => {
    const toolCtx: ToolCtxLike = { sessionKey: "agent:main:main", messageChannel: "slack", nativeChannelId: "C0123TEAM" };
    expect(turnAllowed(identityFromToolCtx(toolCtx, groupScopeMain), owned)).toEqual({ allowed: false, reason: "no_author" });
  });

  it("honours a custom session.mainKey", () => {
    const root = { session: { groupScope: "main", mainKey: "home" } };
    const ctx = { ...strangerInRoom, sessionKey: "agent:main:home" };
    expect(turnAllowed(identityFromHookCtx(ctx, root), owned)).toEqual({ allowed: false, reason: "not_owner" });
  });
});

// N1: OpenClaw fills the hook chatId on every turn, falling back to the channel name, so the gate
// builds these contexts through OpenClaw's own builder instead of guessing the shape.
describe("turnAllowed on a routed key with contexts OpenClaw builds", () => {
  const roots = [
    ["session.groupScope main", { session: { groupScope: "main" } }, "agent:main:main"],
    ["session.scope global", { session: { scope: "global" } }, "global"],
  ] as const;
  const owners = [
    ["no owners", cfgWith({})],
    ["an owner listed", cfgWith({ ownerIds: ["telegram:4242"] })],
  ] as const;

  function hookCtx(run: Parameters<typeof buildAgentHookContextChannelFields>[0] & { trigger?: string }): HookCtxLike {
    return { sessionKey: run.sessionKey ?? undefined, trigger: run.trigger ?? "user", ...buildAgentHookContextChannelFields(run) } as HookCtxLike;
  }

  describe.each(roots)("under %s", (_label, root, sessionKey) => {
    it.each(owners)("allows the Control UI with %s", (_o, cfg) => {
      const ctx = hookCtx({ sessionKey, messageChannel: "webchat", messageProvider: "webchat" });
      expect(ctx.chatId).toBe("webchat");
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfg)).toEqual({ allowed: true, shared: false });
    });

    it.each(owners)("allows a CLI gateway client, which OpenClaw gives sender id cli, with %s", (_o, cfg) => {
      const ctx = hookCtx({ sessionKey, messageChannel: "webchat", messageProvider: "webchat", senderId: "cli" });
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfg)).toEqual({ allowed: true, shared: false });
      const toolCtx: ToolCtxLike = { sessionKey, messageChannel: "webchat", requesterSenderId: "cli" };
      expect(turnAllowed(identityFromToolCtx(toolCtx, root), cfg)).toEqual({ allowed: true, shared: false });
    });

    it.each(owners)("allows the embedded TUI with %s", (_o, cfg) => {
      const ctx = hookCtx({ sessionKey, messageChannel: "webchat", messageProvider: "webchat", currentChannelId: "webchat" });
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfg)).toEqual({ allowed: true, shared: false });
    });

    it.each(owners)("allows a local agent run whose chat is only the channel name, with %s", (_o, cfg) => {
      const ctx = hookCtx({ sessionKey, messageChannel: "telegram", messageProvider: "telegram" });
      expect(ctx.chatId).toBe("telegram");
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfg)).toEqual({ allowed: true, shared: false });
    });

    it.each(owners)("allows a direct chat whose chat id is the sender id, with %s", (_o, cfg) => {
      const ctx = hookCtx({ sessionKey, messageChannel: "telegram", messageProvider: "telegram", currentChannelId: "telegram:4242", senderId: "4242" });
      expect(ctx.chatId).toBe("4242");
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfg)).toEqual({ allowed: true, shared: false });
    });

    it("refuses a stranger routed in from a real group", () => {
      const ctx = hookCtx({ sessionKey, messageChannel: "telegram", messageProvider: "telegram", currentChannelId: "telegram:-100777", senderId: "999" });
      expect(ctx.chatId).toBe("-100777");
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfgWith({ ownerIds: ["telegram:4242"] }))).toEqual({ allowed: false, reason: "not_owner" });
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfgWith({}))).toEqual({ allowed: false, reason: "no_owners" });
    });

    it("allows the owner routed in from a real group as a shared turn", () => {
      const ctx = hookCtx({ sessionKey, messageChannel: "telegram", messageProvider: "telegram", currentChannelId: "telegram:-100777", senderId: "4242" });
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfgWith({ ownerIds: ["telegram:4242"] }))).toEqual({ allowed: true, shared: true });
    });

    it("refuses a room turn that carries a chat and no sender", () => {
      const ctx = hookCtx({ sessionKey, messageChannel: "slack", messageProvider: "slack", currentChannelId: "C0123TEAM" });
      expect(turnAllowed(identityFromHookCtx(ctx, root), cfgWith({ ownerIds: ["telegram:4242"] }))).toEqual({ allowed: false, reason: "no_author" });
    });

    it("refuses a tool turn with a sender and no chat, since the room is unknown", () => {
      const toolCtx: ToolCtxLike = { sessionKey, messageChannel: "telegram", requesterSenderId: "999" };
      expect(turnAllowed(identityFromToolCtx(toolCtx, root), cfgWith({ ownerIds: ["telegram:4242"] }))).toEqual({ allowed: false, reason: "not_owner" });
    });
  });

  it("still holds a webchat turn on a group key to the owner rule", () => {
    const ctx = hookCtx({ sessionKey: "agent:main:telegram:group:-100777", messageChannel: "webchat", messageProvider: "webchat" });
    expect(turnAllowed(identityFromHookCtx(ctx, { session: { groupScope: "main" } }), cfgWith({ ownerIds: ["telegram:4242"] }))).toEqual({ allowed: false, reason: "no_author" });
  });
});
