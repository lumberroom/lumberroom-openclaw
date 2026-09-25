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
    expect(identityFromHookCtx(ctx)).toEqual({ sessionKey: ctx.sessionKey, channel: "telegram", senderId: "42", trigger: "user" });
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
    expect(identityFromToolCtx(ctx)).toEqual({ sessionKey: ctx.sessionKey, channel: "telegram", senderId: "42", trigger: "user" });
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
