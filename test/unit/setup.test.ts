import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withFence } from "../../src/auth/fence.js";
import { login } from "../../src/auth/login.js";
import { tokenPaths } from "../../src/auth/store.js";
import { TOKEN_ENV } from "../../src/config.js";
import { ConfigError } from "../../src/errors.js";
import {
  applySetup,
  loginIoFrom,
  planSetup,
  runSetup,
  writeEnvToken,
  type CliDeps,
  type CliIo,
  type SetupAnswers,
} from "../../src/setup.js";

// login() is T2's; the plan says setup.test.ts stubs it rather than depend on that task landing
// first ("login and logout from src/auth/login.ts through their locked signatures, tests stub them").
vi.mock("../../src/auth/login.js", () => ({
  login: vi.fn(async () => {}),
  logout: vi.fn(async () => true),
}));
import type { AuthHandle, CallMeta, CallResult, EngineClient, LumberroomConfig } from "../../src/types.js";

// Each spawned opener is a bare EventEmitter, so a test can raise the asynchronous 'error' a host
// with no open or xdg-open delivers after spawn() has already returned.
const spawned = vi.hoisted(() => [] as import("node:events").EventEmitter[]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { unref() {} });
      spawned.push(child);
      return child;
    }),
  };
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lumberroom-setup-"));
}

const hostedAnswers: SetupAnswers = {
  deployment: "hosted",
  auth: "oauth",
  dreamingReview: false,
  ownerIds: [],
};

const tokenAnswers: SetupAnswers = {
  deployment: "hosted",
  auth: "token",
  token: "lr_secret_value",
  dreamingReview: false,
  ownerIds: [],
};

describe("loginIoFrom openBrowser", () => {
  it("survives a host with no browser opener", async () => {
    spawned.length = 0;
    const io = loginIoFrom({ print() {}, ask: async () => "", askSecret: async () => "", async *pastedLines() {} });
    await io.openBrowser("http://127.0.0.1:47632/never");
    expect(spawned).toHaveLength(1);
    const enoent = Object.assign(new Error("spawn open ENOENT"), { code: "ENOENT" });
    // An EventEmitter with no 'error' listener throws here, which in a real process is uncaught.
    expect(() => spawned[0]!.emit("error", enoent)).not.toThrow();
  });
});

describe("planSetup", () => {
  it("planSetup takes the memory slot and grants conversation access", () => {
    const plan = planSetup({}, hostedAnswers);
    expect(plan.diff).toContain('plugins.slots.memory = "lumberroom"');
    expect(plan.diff).toContain("plugins.entries.lumberroom.hooks.allowConversationAccess = true");
  });

  it("planSetup turns dreaming off and disables memory-core", () => {
    const plan = planSetup({}, hostedAnswers);
    expect(plan.entryConfig.dreaming).toEqual({ enabled: false });
    expect(plan.diff).toContain("plugins.entries.memory-core.enabled = false");
  });

  it("planSetup turns off OpenClaw's session-memory hook and shows it in the diff", () => {
    const plan = planSetup({}, hostedAnswers);
    expect(plan.diff).toContain("hooks.internal.entries.session-memory.enabled = false");
  });

  it("token mode writes a SecretRef and never plaintext", () => {
    const plan = planSetup({}, tokenAnswers);
    expect(plan.entryConfig.token).toEqual({ source: "env", provider: "default", id: TOKEN_ENV });
    expect(plan.envToken).toBe("lr_secret_value");
    expect(JSON.stringify(plan.entryConfig)).not.toContain("lr_secret_value");
    expect(JSON.stringify(plan.diff)).not.toContain("lr_secret_value");
  });

  it("plugins.allow gains lumberroom only when it is a non-empty list without it", () => {
    expect(planSetup({}, hostedAnswers).addPluginsAllow).toBe(false);
    expect(planSetup({ plugins: { allow: [] } }, hostedAnswers).addPluginsAllow).toBe(false);
    expect(planSetup({ plugins: { allow: ["other-plugin"] } }, hostedAnswers).addPluginsAllow).toBe(true);
    expect(planSetup({ plugins: { allow: ["lumberroom", "other-plugin"] } }, hostedAnswers).addPluginsAllow).toBe(false);
  });

  it("tools.alsoAllow follows the profiles L0 recorded", () => {
    expect(planSetup({}, hostedAnswers).addToolsAlsoAllow).toBe(false);
    expect(planSetup({ tools: { profile: "full" } }, hostedAnswers).addToolsAlsoAllow).toBe(false);
    expect(planSetup({ tools: { profile: "coding" } }, hostedAnswers).addToolsAlsoAllow).toBe(true);
    expect(planSetup({ tools: { profile: "messaging" } }, hostedAnswers).addToolsAlsoAllow).toBe(true);
    expect(planSetup({ tools: { profile: "coding", alsoAllow: ["lumberroom"] } }, hostedAnswers).addToolsAlsoAllow).toBe(false);
  });

  it("tools.alsoAllow covers the minimal profile, which the W gate saw hide every lumberroom tool", () => {
    expect(planSetup({ tools: { profile: "minimal" } }, hostedAnswers).addToolsAlsoAllow).toBe(true);
  });

  it("an owner id on webchat is refused before anything is saved", () => {
    expect(() => planSetup({}, { ...hostedAnswers, ownerIds: ["webchat:1"] })).toThrow(ConfigError);
  });
});

describe("applySetup", () => {
  it("applies the plan onto an arbitrary draft without losing unrelated keys", () => {
    const plan = planSetup({}, hostedAnswers);
    const draft: Record<string, unknown> = { unrelated: { keep: true } };
    applySetup(draft, plan);
    expect((draft.unrelated as { keep: boolean }).keep).toBe(true);
    expect((draft.plugins as Record<string, unknown>).slots).toEqual({ memory: "lumberroom" });
    const entries = (draft.plugins as Record<string, unknown>).entries as Record<string, unknown>;
    expect((entries.lumberroom as Record<string, unknown>).enabled).toBe(true);
    expect(((entries.lumberroom as Record<string, unknown>).hooks as Record<string, unknown>).allowConversationAccess).toBe(true);
    expect((entries["memory-core"] as Record<string, unknown>).enabled).toBe(false);
  });

  it("disables session-memory and keeps the other internal hooks as they were", () => {
    const plan = planSetup({}, hostedAnswers);
    const draft: Record<string, unknown> = {
      hooks: { token: "keep", internal: { entries: { "session-memory": { enabled: true, llmSlug: true }, "command-logger": { enabled: true } } } },
    };
    applySetup(draft, plan);
    const hooks = draft.hooks as { token: string; internal: { entries: Record<string, Record<string, unknown>> } };
    expect(hooks.token).toBe("keep");
    expect(hooks.internal.entries["session-memory"]).toEqual({ enabled: false, llmSlug: true });
    expect(hooks.internal.entries["command-logger"]).toEqual({ enabled: true });
  });

  // F8: OpenClaw steers a message that arrives mid-run into that run whoever sent it, and the run
  // keeps the owner's lumberroom tools. followup gives every message its own gated turn.
  it("with owners listed, sets the queue to followup and keeps safe per-channel modes", () => {
    const answers = { ...hostedAnswers, ownerIds: ["telegram:42"] };
    const current = { messages: { queue: { cap: 5, byChannel: { discord: "collect", telegram: "interrupt", slack: "steer" } } } };
    const plan = planSetup(current, answers);
    expect(plan.diff).toContain('messages.queue.mode = "followup"');
    expect(plan.diff).toContain('messages.queue.byChannel.discord = "followup"');
    expect(plan.diff).toContain('messages.queue.byChannel.slack = "followup"');
    const draft = structuredClone(current) as Record<string, unknown>;
    applySetup(draft, plan);
    expect((draft.messages as { queue: unknown }).queue).toEqual({
      cap: 5,
      mode: "followup",
      drop: "old",
      byChannel: { discord: "followup", telegram: "interrupt", slack: "followup" },
    });
  });

  // N6: the default drop policy, summarize, folds dropped messages from anyone into a synthetic
  // followup turn, which runs with whichever sender's identity it inherits.
  it.each([undefined, "summarize"])("with owners listed, sets drop %s to old", (drop) => {
    const current = { messages: { queue: { mode: "followup", ...(drop ? { drop } : {}) } } };
    const plan = planSetup(current, { ...hostedAnswers, ownerIds: ["telegram:42"] });
    expect(plan.diff.filter((line) => line.startsWith("messages.queue"))).toEqual(['messages.queue.drop = "old"']);
    const draft = structuredClone(current) as Record<string, unknown>;
    applySetup(draft, plan);
    expect((draft.messages as { queue: unknown }).queue).toEqual({ mode: "followup", drop: "old" });
  });

  it("with owners listed, keeps drop new, which never merges messages", () => {
    const plan = planSetup({ messages: { queue: { mode: "followup", drop: "new" } } }, { ...hostedAnswers, ownerIds: ["telegram:42"] });
    expect(plan.diff.some((line) => line.startsWith("messages.queue"))).toBe(false);
  });

  it("with no owners listed, leaves the queue alone", () => {
    const plan = planSetup({}, hostedAnswers);
    expect(plan.diff.some((line) => line.startsWith("messages.queue"))).toBe(false);
    const draft: Record<string, unknown> = {};
    applySetup(draft, plan);
    expect(draft.messages).toBeUndefined();
  });

  it("with owners listed and the queue already safe, changes nothing there", () => {
    const current = { messages: { queue: { mode: "interrupt", drop: "old", byChannel: { telegram: "followup" } } } };
    const plan = planSetup(current, { ...hostedAnswers, ownerIds: ["telegram:42"] });
    expect(plan.diff.some((line) => line.startsWith("messages.queue"))).toBe(false);
  });

  it("puts lumberroom into an existing non-empty plugins.allow", () => {
    const plan = planSetup({ plugins: { allow: ["other-plugin"] } }, hostedAnswers);
    const draft: Record<string, unknown> = { plugins: { allow: ["other-plugin"] } };
    applySetup(draft, plan);
    expect((draft.plugins as Record<string, unknown>).allow).toEqual(["other-plugin", "lumberroom"]);
  });

  it("targets tools.allow instead of tools.alsoAllow when allow is already set", () => {
    const plan = planSetup({ tools: { profile: "coding", allow: ["other-tool"] } }, hostedAnswers);
    const draft: Record<string, unknown> = { tools: { profile: "coding", allow: ["other-tool"] } };
    applySetup(draft, plan);
    const tools = draft.tools as Record<string, unknown>;
    expect(tools.allow).toEqual(["other-tool", "lumberroom"]);
    expect(tools.alsoAllow).toBeUndefined();
  });
});

describe("writeEnvToken", () => {
  it("writeEnvToken keeps other lines and writes 0600", () => {
    const dir = tempDir();
    const path = join(dir, ".env");
    writeFileSync(path, "OTHER_VAR=keepme\n");
    writeEnvToken(dir, "first-token");
    expect(readFileSync(path, "utf8")).toBe(`OTHER_VAR=keepme\n${TOKEN_ENV}=first-token\n`);

    writeEnvToken(dir, "second-token");
    expect(readFileSync(path, "utf8")).toBe(`OTHER_VAR=keepme\n${TOKEN_ENV}=second-token\n`);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// A scripted CliIo for runSetup: answers is a queue consumed in order, questions is what was asked.
function scriptedIo(answers: string[]): CliIo & { questions: string[]; printed: string[] } {
  const queue = [...answers];
  const questions: string[] = [];
  const printed: string[] = [];
  return {
    questions,
    printed,
    print(line) {
      printed.push(line);
    },
    async ask(question) {
      questions.push(question);
      const next = queue.shift();
      return next ?? "";
    },
    async askSecret(question) {
      questions.push(question);
      const next = queue.shift();
      return next ?? "";
    },
    async *pastedLines() {},
  };
}

function fakeEngineClient(whoamiStatus = 200): EngineClient {
  return {
    async listTools(_meta: CallMeta): Promise<{ result: CallResult; listing: null }> {
      return {
        result: { kind: "ok", structured: { tools: [] }, text: "{}", error: null, status: 200 },
        listing: null,
      };
    },
    async callTool(): Promise<CallResult> {
      throw new Error("not used by setup tests");
    },
    async admin(_method, path) {
      if (path === "/admin/whoami") return { status: whoamiStatus, json: { client: "test", may_ingest: true, may_delete: true } };
      throw new Error(`unexpected admin path ${path}`);
    },
    async close(): Promise<void> {},
  };
}

function fakeAuthHandle(): AuthHandle {
  return {
    mode: "token",
    async authorize() {
      return "Bearer test";
    },
    rejected() {},
    async settle() {},
  };
}

function baseDeps(io: CliIo, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    pluginConfig: {},
    cliConfig: {},
    workspaceDir: undefined,
    stateDir: () => tempDir(),
    io,
    mutateConfig: vi.fn(async () => {}),
    makeClient: (_cfg: LumberroomConfig) => ({ client: fakeEngineClient(), auth: fakeAuthHandle() }),
    ...overrides,
  };
}

// login() is mocked, so this stands in for its contract: a sign-in that returns has stored a token.
function signInWritesNewTokens(): void {
  vi.mocked(login).mockImplementationOnce(async (cfg, opts) => {
    const { file } = tokenPaths(opts.stateDir);
    mkdirSync(join(opts.stateDir, "lumberroom"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpUrl: cfg.mcpUrl, tokens: { access_token: "new", token_type: "Bearer", refresh_token: "new-rt" } }));
  });
}

describe("runSetup", () => {
  it("a failed validation writes nothing", async () => {
    const io = scriptedIo([
      "lumberroom.cloud", // deployment
      "browser", // auth choice
      "No", // dreamingReview
      "webchat:1", // owners: invalid, refused by resolveConfig
      "Y", // confirm (never reached)
    ]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(io, { mutateConfig }));
    expect(code).toBe(1);
    expect(mutateConfig).not.toHaveBeenCalled();
  });

  it("hosted setup asks about dreaming review", async () => {
    // OAuth path calls login(); token mode is simpler to drive through this scripted flow.
    const tokenIo = scriptedIo(["lumberroom.cloud", "token", "lr_test_token", "No", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(tokenIo, { mutateConfig }));
    expect(code).toBe(0);
    expect(tokenIo.questions.some((q) => /dreaming queue/.test(q))).toBe(true);
    expect(mutateConfig).toHaveBeenCalledTimes(1);
  });

  it("self-hosted setup never asks about dreaming review", async () => {
    const io = scriptedIo(["self-hosted", "http://127.0.0.1:8787", "token", "lr_test_token", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(io, { mutateConfig }));
    expect(code).toBe(0);
    expect(io.questions.some((q) => /dreaming queue/.test(q))).toBe(false);
  });

  it("hosted setup offers browser sign-in first and an API token second", async () => {
    const io = scriptedIo(["lumberroom.cloud", "token", "lr_test_token", "No", "", "Y"]);
    await runSetup(baseDeps(io, { mutateConfig: vi.fn(async () => {}) }));
    const authQuestion = io.questions.find((q) => /browser/i.test(q));
    expect(authQuestion).toBeDefined();
    expect(authQuestion?.toLowerCase().indexOf("browser")).toBeLessThan(
      (authQuestion?.toLowerCase().indexOf("api token") ?? -1) < 0 ? Infinity : authQuestion!.toLowerCase().indexOf("api token"),
    );
  });

  it("a 401 on the configured token writes nothing", async () => {
    const io = scriptedIo(["lumberroom.cloud", "token", "lr_bad_token", "No", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const makeClient = () => ({ client: fakeEngineClient(401), auth: fakeAuthHandle() });
    const code = await runSetup(baseDeps(io, { mutateConfig, makeClient }));
    expect(code).toBe(1);
    expect(mutateConfig).not.toHaveBeenCalled();
  });

  it("the oauth path signs in and lists tools before saving", async () => {
    signInWritesNewTokens();
    const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(io, { mutateConfig }));
    expect(code).toBe(0);
    expect(mutateConfig).toHaveBeenCalledTimes(1);
  });

  it("a sign-in that stores no token fails before the confirm", async () => {
    const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(io, { mutateConfig }));
    expect(code).toBe(1);
    expect(mutateConfig).not.toHaveBeenCalled();
  });

  // F9: the browser sign-in lands in a staging directory and replaces oauth.json only after the
  // owner confirms, so an abort or a failed check leaves the gateway's running sign-in alone.
  describe("oauth sign-in staging", () => {
    const OLD = { mcpUrl: "https://old.example/mcp", tokens: { access_token: "old", token_type: "Bearer", refresh_token: "old-rt" } };

    function stateWithOldSignIn(): string {
      const dir = tempDir();
      const { file } = tokenPaths(dir);
      mkdirSync(join(dir, "lumberroom"), { recursive: true });
      writeFileSync(file, JSON.stringify(OLD));
      return dir;
    }

    const accessToken = (dir: string) => (JSON.parse(readFileSync(tokenPaths(dir).file, "utf8")) as typeof OLD).tokens.access_token;

    // tools/list succeeds only when the client reads the sign-in this setup just made.
    function clientReadingStagedTokens(): CliDeps["makeClient"] {
      return (_cfg, opts) => {
        const client = fakeEngineClient();
        client.listTools = async () => {
          const ok = opts?.stateDir !== undefined && existsSync(tokenPaths(opts.stateDir).file) && accessToken(opts.stateDir) === "new";
          return { result: { kind: ok ? "ok" : "unauthorized", structured: null, text: "", error: ok ? null : "old token", status: ok ? 200 : 401 }, listing: null };
        };
        return { client, auth: fakeAuthHandle() };
      };
    }

    it("an aborted oauth setup keeps the existing sign-in", async () => {
      const stateDir = stateWithOldSignIn();
      signInWritesNewTokens();
      const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "n"]);
      const code = await runSetup(baseDeps(io, { stateDir: () => stateDir }));
      expect(io.printed).toContain("aborted, nothing saved");
      expect(code).toBe(1);
      expect(accessToken(stateDir)).toBe("old");
      expect(readdirSync(join(stateDir, "lumberroom"))).toEqual(["oauth.json"]);
    });

    it("a failed tools/list after sign-in keeps the existing sign-in", async () => {
      const stateDir = stateWithOldSignIn();
      signInWritesNewTokens();
      const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
      const makeClient: CliDeps["makeClient"] = () => {
        const client = fakeEngineClient();
        client.listTools = async () => ({ result: { kind: "unreachable", structured: null, text: "", error: "down", status: null }, listing: null });
        return { client, auth: fakeAuthHandle() };
      };
      const code = await runSetup(baseDeps(io, { stateDir: () => stateDir, makeClient }));
      expect(code).toBe(1);
      expect(accessToken(stateDir)).toBe("old");
      expect(readdirSync(join(stateDir, "lumberroom"))).toEqual(["oauth.json"]);
    });

    it("a confirmed oauth setup checks the new sign-in and then installs it", async () => {
      const stateDir = stateWithOldSignIn();
      signInWritesNewTokens();
      const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
      const mutateConfig = vi.fn(async () => {});
      const code = await runSetup(baseDeps(io, { stateDir: () => stateDir, mutateConfig, makeClient: clientReadingStagedTokens() }));
      expect(io.printed).toEqual(expect.not.arrayContaining([expect.stringContaining("old token")]));
      expect(code).toBe(0);
      expect(mutateConfig).toHaveBeenCalledTimes(1);
      expect(accessToken(stateDir)).toBe("new");
      expect(readdirSync(join(stateDir, "lumberroom")).filter((f) => f !== "oauth.lock")).toEqual(["oauth.json"]);
    });

    // N4: a peer mid-refresh holds oauth.lock and writes its rotated pair. The staged sign-in has to
    // wait for that write and land after it, or the peer's write replaces the new sign-in.
    it("waits for a peer holding oauth.lock and installs the staged sign-in after the peer's write", async () => {
      const stateDir = stateWithOldSignIn();
      signInWritesNewTokens();
      const { file, lock } = tokenPaths(stateDir);
      let configSaved!: () => void;
      const saved = new Promise<void>((resolve) => (configSaved = resolve));
      let fenceHeld!: () => void;
      const held = new Promise<void>((resolve) => (fenceHeld = resolve));
      let peerWrote = false;
      const peer = withFence(lock, async () => {
        fenceHeld();
        await saved;
        // Long enough for an unfenced rename to land before the peer writes.
        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(file, JSON.stringify({ ...OLD, tokens: { ...OLD.tokens, access_token: "peer", refresh_token: "peer-rt" } }));
        peerWrote = true;
      });
      await held;
      const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
      const mutateConfig = vi.fn(async () => configSaved());
      const code = await runSetup(baseDeps(io, { stateDir: () => stateDir, mutateConfig, makeClient: clientReadingStagedTokens() }));
      await peer;
      expect(code).toBe(0);
      expect(peerWrote).toBe(true);
      expect(accessToken(stateDir)).toBe("new");
    });
  });
});
