import { describe, expect, it } from "vitest";
import {
  configSchema,
  DEFAULT_TOOLS,
  HOSTED_BASE_URL,
  isHosted,
  normalizeBaseUrl,
  resolveConfig,
  sidecarCheck,
  TOKEN_ENV,
} from "../../src/config.js";
import { ConfigError } from "../../src/errors.js";

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError and nothing was thrown");
}

describe("baseUrl", () => {
  // Review focus 4: five spellings of one engine and two that could pass for the hosted domain.
  it.each(["https://h", "https://h/", "https://h/mcp", "https://h/mcp/", "HTTPS://H"])(
    "%s resolves to the mcpUrl https://h/mcp",
    (raw) => {
      const cfg = resolveConfig({ baseUrl: raw });
      expect(cfg.baseUrl).toBe("https://h");
      expect(cfg.mcpUrl).toBe("https://h/mcp");
    },
  );

  it.each(["https://evil.example?.lumberroom.cloud", "https://lumberroom.cloud@evil.example"])(
    "%s is a ConfigError because text after ? or @ could pass for the host",
    (raw) => {
      expect(configError(() => resolveConfig({ baseUrl: raw })).message).toContain("plain origin");
    },
  );

  it("a fragment is a ConfigError", () => {
    configError(() => normalizeBaseUrl("https://h#lumberroom.cloud"));
  });

  it("a scheme other than http or https is a ConfigError", () => {
    expect(configError(() => normalizeBaseUrl("ftp://h")).message).toContain("http:// or https://");
  });

  it("text that is no URL is a ConfigError", () => {
    configError(() => normalizeBaseUrl("h:8787 nope"));
  });

  it("an empty or non-string baseUrl is a ConfigError", () => {
    configError(() => normalizeBaseUrl(""));
    configError(() => normalizeBaseUrl("   "));
    configError(() => normalizeBaseUrl(8787));
  });

  it("a path prefix survives and only the trailing /mcp is removed", () => {
    expect(normalizeBaseUrl("https://h/engine/mcp/")).toBe("https://h/engine");
    expect(normalizeBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
});

describe("resolveConfig defaults", () => {
  it.each([undefined, null, {}])("an empty config (%s) resolves to the hosted URL and OAuth", (raw) => {
    const cfg = resolveConfig(raw);
    expect(cfg.baseUrl).toBe(HOSTED_BASE_URL);
    expect(cfg.mcpUrl).toBe(`${HOSTED_BASE_URL}/mcp`);
    expect(cfg.hosted).toBe(true);
    expect(cfg.auth).toBe("oauth");
    expect(cfg.token).toBeNull();
    expect(cfg.project).toBe("auto");
    expect(cfg.recall).toBe(true);
    expect(cfg.digest).toBe(true);
    expect(cfg.dreamingReview).toBe(false);
    expect(cfg.digestMaxChars).toBe(6000);
    expect(cfg.recallLimit).toBe(4);
    expect(cfg.recallMaxChars).toBe(1200);
    expect(cfg.reviewInterval).toBe(10);
    expect(cfg.digestTimeoutMs).toBe(4000);
    expect(cfg.recallTimeoutMs).toBe(3000);
    expect(cfg.toolTimeoutMs).toBe(20_000);
    expect(cfg.connectTimeoutMs).toBe(3000);
    expect(cfg.oauthCallbackPort).toBe(47_632);
    expect(cfg.tools).toEqual([...DEFAULT_TOOLS]);
    expect(cfg.ownerIds).toEqual([]);
    expect(cfg.triggers).toEqual(["user", "cron"]);
  });

  it("a self-hosted baseUrl is not hosted", () => {
    expect(resolveConfig({ baseUrl: "http://127.0.0.1:8787" }).hosted).toBe(false);
  });

  it("a config that is not an object is a ConfigError", () => {
    configError(() => resolveConfig("https://h"));
    configError(() => resolveConfig([]));
  });

  it("an unknown key names itself", () => {
    expect(configError(() => resolveConfig({ baseURL: "https://h" })).message).toBe("unknown key baseURL");
  });

  it("the dreaming block passes through without a check", () => {
    expect(() => resolveConfig({ dreaming: { enabled: false } })).not.toThrow();
  });
});

describe("auth", () => {
  it("auth token without a string token fails naming the env variable", () => {
    expect(configError(() => resolveConfig({ auth: "token" })).message).toContain(TOKEN_ENV);
    expect(TOKEN_ENV).toBe("LUMBERROOM_OPENCLAW_TOKEN");
  });

  it("an unresolved SecretRef in token mode fails naming the env variable", () => {
    const ref = { source: "env", provider: "default", id: TOKEN_ENV };
    expect(configError(() => resolveConfig({ auth: "token", token: ref })).message).toContain(TOKEN_ENV);
  });

  it("a blank token in token mode is a ConfigError", () => {
    configError(() => resolveConfig({ auth: "token", token: "   " }));
  });

  it("token mode keeps the trimmed token", () => {
    expect(resolveConfig({ auth: "token", token: " lr_abc " }).token).toBe("lr_abc");
  });

  it("oauth mode ignores a token", () => {
    expect(resolveConfig({ auth: "oauth", token: "lr_abc" }).token).toBeNull();
  });

  it("an auth mode other than oauth or token is a ConfigError", () => {
    configError(() => resolveConfig({ auth: "basic" }));
  });
});

describe("booleans and project", () => {
  it.each(["recall", "digest", "dreamingReview"])("%s must be a boolean", (key) => {
    expect(configError(() => resolveConfig({ [key]: "yes" })).message).toContain(key);
    expect(resolveConfig({ [key]: false })[key as "recall"]).toBe(false);
  });

  it("project keeps a given slug and refuses an empty one", () => {
    expect(resolveConfig({ project: " none " }).project).toBe("none");
    configError(() => resolveConfig({ project: "  " }));
    configError(() => resolveConfig({ project: 7 }));
  });
});

describe("integer bounds", () => {
  const bounds: Array<[string, number, number]> = [
    ["digestMaxChars", 0, 50_000],
    ["recallLimit", 1, 20],
    ["recallMaxChars", 0, 20_000],
    ["reviewInterval", 0, 1000],
    ["digestTimeoutMs", 500, 14_000],
    ["recallTimeoutMs", 500, 14_000],
    ["toolTimeoutMs", 1000, 120_000],
    ["connectTimeoutMs", 500, 30_000],
    ["oauthCallbackPort", 1024, 65_535],
  ];

  it.each(bounds)("%s accepts %i and %i", (key, lo, hi) => {
    expect(resolveConfig({ [key]: lo })[key as "recallLimit"]).toBe(lo);
    expect(resolveConfig({ [key]: hi })[key as "recallLimit"]).toBe(hi);
  });

  it.each(bounds)("%s refuses one below %i and one above %i", (key, lo, hi) => {
    expect(configError(() => resolveConfig({ [key]: lo - 1 })).message).toBe(`${key} must be a whole number from ${lo} to ${hi}`);
    expect(configError(() => resolveConfig({ [key]: hi + 1 })).message).toBe(`${key} must be a whole number from ${lo} to ${hi}`);
  });

  it.each(bounds)("%s refuses a fraction and a string", (key, lo) => {
    configError(() => resolveConfig({ [key]: lo + 0.5 }));
    configError(() => resolveConfig({ [key]: String(lo) }));
  });
});

describe("tools", () => {
  it.each(["review_queue", "review_decide"])("tools refuses %s because dreamingReview controls it", (name) => {
    expect(configError(() => resolveConfig({ tools: [name] })).message).toContain("dreamingReview");
  });

  it("tools refuses an unknown name", () => {
    expect(configError(() => resolveConfig({ tools: ["memory_search", "memory_get"] })).message).toBe(
      "tools lists unknown tool memory_get",
    );
  });

  it("tools refuses an empty list", () => {
    configError(() => resolveConfig({ tools: [] }));
  });

  it("tools refuses a list holding something other than names", () => {
    configError(() => resolveConfig({ tools: "memory_search" }));
    configError(() => resolveConfig({ tools: ["memory_search", 3] }));
  });

  it("tools drops duplicates and keeps order", () => {
    expect(resolveConfig({ tools: ["registry_get", "memory_search", "registry_get"] }).tools).toEqual([
      "registry_get",
      "memory_search",
    ]);
  });
});

describe("ownerIds", () => {
  it.each(["webchat:1", "WebChat:1"])("ownerIds refuses %s because webchat carries no verified sender", (entry) => {
    expect(configError(() => resolveConfig({ ownerIds: [entry] })).message).toContain("webchat");
  });

  it.each(["telegram", ":1", "telegram: 1", "telegram:"])("ownerIds refuses the malformed entry %j", (entry) => {
    configError(() => resolveConfig({ ownerIds: [entry] }));
  });

  it("ownerIds lower-cases the channel and keeps the sender as given", () => {
    expect(resolveConfig({ ownerIds: ["Telegram:ABC123"] }).ownerIds).toEqual(["telegram:ABC123"]);
  });
});

describe("triggers", () => {
  it("triggers refuses manual", () => {
    expect(configError(() => resolveConfig({ triggers: ["user", "manual"] })).message).toContain("manual");
  });

  it("triggers accepts heartbeat", () => {
    expect(resolveConfig({ triggers: ["heartbeat"] }).triggers).toEqual(["heartbeat"]);
  });
});

describe("isHosted", () => {
  it.each(["https://lumberroom.cloud", "https://mcp.lumberroom.cloud", "https://MCP.Lumberroom.Cloud"])(
    "%s is hosted",
    (url) => {
      expect(isHosted(url)).toBe(true);
    },
  );

  it.each(["https://lumberroom.cloud.evil.example", "https://notlumberroom.cloud", "http://127.0.0.1:8787"])(
    "%s is not hosted",
    (url) => {
      expect(isHosted(url)).toBe(false);
    },
  );
});

describe("sidecarCheck", () => {
  const both = {
    plugins: {
      entries: {
        lumberroom: { config: { dreaming: { enabled: false } } },
        "memory-core": { enabled: false },
      },
    },
  };

  it("reports both switches off only when both are false", () => {
    expect(sidecarCheck(both)).toEqual({ dreamingOff: true, memoryCoreOff: true });
  });

  it("counts plugins.deny listing memory-core as off", () => {
    const root = { plugins: { deny: ["memory-core"], entries: { lumberroom: { config: { dreaming: { enabled: false } } } } } };
    expect(sidecarCheck(root)).toEqual({ dreamingOff: true, memoryCoreOff: true });
  });

  it("reads a dreaming switch that is true as on", () => {
    const root = structuredClone(both);
    root.plugins.entries.lumberroom.config.dreaming.enabled = true as unknown as false;
    expect(sidecarCheck(root)).toEqual({ dreamingOff: false, memoryCoreOff: true });
  });

  it("reads memory-core enabled true as on", () => {
    const root = structuredClone(both);
    root.plugins.entries["memory-core"].enabled = true as unknown as false;
    expect(sidecarCheck(root)).toEqual({ dreamingOff: true, memoryCoreOff: false });
  });

  it.each([
    ["a missing plugins key", {}],
    ["an empty dreaming block", { plugins: { entries: { lumberroom: { config: { dreaming: {} } }, "memory-core": {} } } }],
    ["a null root", null],
    ["null entries", { plugins: { entries: null } }],
  ])("reads %s as both switches on", (_label, root) => {
    expect(sidecarCheck(root)).toEqual({ dreamingOff: false, memoryCoreOff: false });
  });
});

describe("configSchema", () => {
  it("accepts an object and a missing block and refuses anything else", () => {
    const parse = configSchema.safeParse!;
    expect(parse({ baseUrl: "not a url" }).success).toBe(true);
    expect(parse(undefined)).toEqual({ success: true, data: {} });
    expect(parse("https://h").success).toBe(false);
    expect(parse([]).success).toBe(false);
  });
});
