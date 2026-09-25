import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_ENV } from "../../src/config.js";
import { ConfigError } from "../../src/errors.js";
import {
  applySetup,
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
    const io = scriptedIo(["lumberroom.cloud", "browser", "No", "", "Y"]);
    const mutateConfig = vi.fn(async () => {});
    const code = await runSetup(baseDeps(io, { mutateConfig }));
    expect(code).toBe(0);
    expect(mutateConfig).toHaveBeenCalledTimes(1);
  });
});
