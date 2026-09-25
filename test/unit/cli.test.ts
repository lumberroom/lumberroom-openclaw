import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi } from "../fakes/api.js";
import { createCliIo, registerLumberroomCli, runImportCommand, runLoginCommand, runLogoutCommand, runStatusCommand } from "../../src/cli.js";
import { InputClosed, MissingGrant } from "../../src/errors.js";
import type { CliDeps, CliIo } from "../../src/setup.js";
import type { AdminResponse, AuthHandle, CallMeta, CallResult, EngineClient, LumberroomConfig, ToolsListing } from "../../src/types.js";

// The importer.ts consumed here is real; login/logout are T2's, so cli.test.ts stubs them per the
// plan ("login and logout from src/auth/login.ts through their locked signatures, tests stub them").
vi.mock("../../src/auth/login.js", () => ({
  login: vi.fn(async () => {}),
  logout: vi.fn(async () => true),
}));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lumberroom-cli-"));
}

function workspaceWithMemory(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "MEMORY.md"), "a durable fact worth keeping across the whole test suite");
  return dir;
}

function memoryIo(): CliIo & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print(line) {
      printed.push(line);
    },
    async ask() {
      return "";
    },
    async askSecret() {
      return "";
    },
    async *pastedLines() {},
  };
}

const LISTING: ToolsListing = {
  tools: [{ name: "memory_search", inputSchema: {} }],
  instructions: null,
  serverInfo: { name: "rmcp", version: "3.2.0" },
  protocolVersion: "2025-11-25",
};

function fakeClient(opts: {
  listResult?: CallResult;
  whoamiStatus?: number;
  whoamiJson?: unknown;
  admin?: (method: string, path: string, body: unknown) => AdminResponse;
  auth: AuthHandle;
} & { auth: AuthHandle }): EngineClient & { closeCalls: number } {
  const state = { closeCalls: 0 };
  return {
    get closeCalls() {
      return state.closeCalls;
    },
    async listTools(_meta: CallMeta) {
      return {
        result: opts.listResult ?? { kind: "ok", structured: { tools: LISTING.tools }, text: "{}", error: null, status: 200 },
        listing: LISTING,
      };
    },
    async callTool(): Promise<CallResult> {
      throw new Error("not used by cli tests");
    },
    async admin(method, path, body) {
      if (opts.admin) return opts.admin(method, path, body);
      if (path === "/admin/whoami") {
        return { status: opts.whoamiStatus ?? 200, json: opts.whoamiJson ?? { client: "test", may_ingest: true, may_delete: true } };
      }
      throw new Error(`unexpected admin path ${path}`);
    },
    async close(timeoutMs: number) {
      state.closeCalls += 1;
      await opts.auth.settle(timeoutMs);
    },
  } as EngineClient & { closeCalls: number };
}

function fakeAuth(): AuthHandle & { settleCalls: number } {
  const state = { settleCalls: 0 };
  return {
    mode: "token",
    async authorize() {
      return "Bearer test";
    },
    rejected() {},
    get settleCalls() {
      return state.settleCalls;
    },
    async settle() {
      state.settleCalls += 1;
    },
  } as AuthHandle & { settleCalls: number };
}

function baseDeps(io: CliIo, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    pluginConfig: {},
    cliConfig: {
      plugins: {
        slots: { memory: "lumberroom" },
        entries: {
          lumberroom: { config: { dreaming: { enabled: false } }, hooks: { allowConversationAccess: true } },
          "memory-core": { enabled: false },
        },
      },
      hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
    },
    workspaceDir: undefined,
    stateDir: () => tempDir(),
    io,
    mutateConfig: vi.fn(async () => {}),
    makeClient: (_cfg: LumberroomConfig) => ({ client: fakeClient({ auth: fakeAuth() }), auth: fakeAuth() }),
    ...overrides,
  };
}

describe("status", () => {
  it("status exits 0 when reachable, signed in, slot owned, access granted, both sidecar switches off", async () => {
    const io = memoryIo();
    const code = await runStatusCommand(baseDeps(io), { json: false });
    expect(code).toBe(0);
  });

  it("status exits 1 and names the problem otherwise", async () => {
    const io = memoryIo();
    const deps = baseDeps(io, { cliConfig: {} }); // no slot owner, no conversation access, both switches on
    const code = await runStatusCommand(deps, { json: false });
    expect(code).toBe(1);
    expect(io.printed.some((line) => line.includes('plugins.slots.memory is null, not "lumberroom"'))).toBe(true);
  });

  it("status exits 1 and names each open sidecar switch by its key", async () => {
    const io = memoryIo();
    const deps = baseDeps(io, {
      cliConfig: {
        plugins: {
          slots: { memory: "lumberroom" },
          entries: { lumberroom: { hooks: { allowConversationAccess: true } } },
        },
      },
    });
    const code = await runStatusCommand(deps, { json: false });
    expect(code).toBe(1);
    expect(io.printed).toContain("problem: plugins.entries.lumberroom.config.dreaming.enabled is not false");
    expect(io.printed).toContain("problem: plugins.entries.memory-core.enabled is not false");
  });

  // OpenClaw onboarding turns session-memory on, and it writes memory/*.md through fs where the
  // write guard never sees it.
  it("status names an enabled session-memory hook as a problem", async () => {
    for (const hooks of [{ internal: { enabled: true } }, { internal: { entries: { "session-memory": { enabled: true } } } }]) {
      const io = memoryIo();
      const cliConfig = { ...baseDeps(io).cliConfig, hooks };
      const code = await runStatusCommand(baseDeps(io, { cliConfig }), { json: false });
      expect(code).toBe(1);
      expect(io.printed).toContain("problem: hooks.internal.entries.session-memory.enabled is not false");
    }
  });

  // N2: OpenClaw runs no internal hook discovery without a hooks block, and an allowlist that leaves
  // session-memory out never loads it (OC src/hooks/configured.ts).
  it.each([
    ["no hooks block", undefined],
    ["an allowlist without session-memory", { internal: { entries: { "command-logger": { enabled: true } } } }],
  ])("status accepts %s, where OpenClaw cannot load session-memory", async (_label, hooks) => {
    const io = memoryIo();
    const cliConfig = { ...baseDeps(io).cliConfig, hooks };
    const code = await runStatusCommand(baseDeps(io, { cliConfig }), { json: false });
    expect(io.printed.filter((l) => l.startsWith("problem:"))).toEqual([]);
    expect(code).toBe(0);
  });

  it("status accepts internal hooks switched off as a whole", async () => {
    const io = memoryIo();
    const cliConfig = { ...baseDeps(io).cliConfig, hooks: { internal: { enabled: false } } };
    const code = await runStatusCommand(baseDeps(io, { cliConfig }), { json: false });
    expect(io.printed.filter((l) => l.startsWith("problem:"))).toEqual([]);
    expect(code).toBe(0);
  });

  describe("queue mode with owners listed", () => {
    const owners = { baseUrl: "http://127.0.0.1:8794", auth: "token", token: "t", ownerIds: ["telegram:42"] };

    async function problemsFor(messages: unknown, pluginConfig: unknown = owners): Promise<string[]> {
      const io = memoryIo();
      const cliConfig = { ...baseDeps(io).cliConfig, ...(messages === undefined ? {} : { messages }) };
      await runStatusCommand(baseDeps(io, { cliConfig, pluginConfig }), { json: false });
      return io.printed.filter((l) => l.startsWith("problem:"));
    }

    const SUMMARIZE =
      'problem: messages.queue.drop is "summarize"; dropped messages from anyone fold into one turn that can carry an owner\'s identity. Set it to "old"';

    it("names the default steer mode and the default summarize drop as problems", async () => {
      expect(await problemsFor(undefined)).toEqual([
        'problem: messages.queue.mode is "steer"; a message from anyone in a shared chat can steer into an owner\'s run. Set it to "followup"',
        SUMMARIZE,
      ]);
    });

    it("names a per-channel steer or collect override", async () => {
      expect(await problemsFor({ queue: { mode: "followup", drop: "old", byChannel: { discord: "collect", telegram: "interrupt" } } })).toEqual([
        'problem: messages.queue.byChannel.discord is "collect"; a message from anyone in a shared chat can steer into an owner\'s run. Set it to "followup"',
      ]);
    });

    it("names an explicit summarize drop", async () => {
      expect(await problemsFor({ queue: { mode: "followup", drop: "summarize" } })).toEqual([SUMMARIZE]);
    });

    it.each(["old", "new"])("accepts followup and interrupt with drop %s", async (drop) => {
      expect(await problemsFor({ queue: { mode: "followup", drop, byChannel: { telegram: "interrupt" } } })).toEqual([]);
    });

    it("says nothing when no owners are listed", async () => {
      expect(await problemsFor(undefined, { baseUrl: "http://127.0.0.1:8794", auth: "token", token: "t" })).toEqual([]);
    });
  });

  it("text status prints the live tools, the server, the credential and its grants", async () => {
    // Spec 14 lists these for status; the W gate found the text form printed none of them.
    const io = memoryIo();
    const code = await runStatusCommand(baseDeps(io), { json: false });
    expect(code).toBe(0);
    expect(io.printed).toContain("tools: memory_search");
    expect(io.printed).toContain("server: rmcp 3.2.0, protocol 2025-11-25");
    expect(io.printed).toContain("credential: present (client test, may_ingest true, may_delete true)");
    expect(io.printed.some((line) => /^round trip: \d+ ms$/.test(line))).toBe(true);
  });

  it("status --json prints one object", async () => {
    const io = memoryIo();
    const code = await runStatusCommand(baseDeps(io), { json: true });
    expect(code).toBe(0);
    expect(io.printed).toHaveLength(1);
    const parsed = JSON.parse(io.printed[0]!);
    expect(parsed).toMatchObject({ slotOwner: "lumberroom", allowConversationAccess: true, reachable: true });
  });
});

describe("login", () => {
  it("login refuses in token mode", async () => {
    const io = memoryIo();
    const deps = baseDeps(io, { pluginConfig: { auth: "token", token: "lr_x" } });
    const code = await runLoginCommand(deps, { browser: true });
    expect(code).toBe(1);
    expect(io.printed.some((line) => /refuses in auth token mode/.test(line))).toBe(true);
  });
});

describe("import", () => {
  it("import exits 2 on a missing grant", async () => {
    const io = memoryIo();
    const auth = fakeAuth();
    const client = fakeClient({
      auth,
      admin: () => ({ status: 403, json: { error: "forbidden" } }),
    });
    const dir = workspaceWithMemory();
    const deps = baseDeps(io, {
      workspaceDir: dir,
      makeClient: () => ({ client, auth }),
    });
    const code = await runImportCommand(deps, { dryRun: false });
    expect(code).toBe(2);
  });
});

describe("every command settles auth before returning", () => {
  it("status closes the client, which settles the injected auth handle", async () => {
    const io = memoryIo();
    const auth = fakeAuth();
    const client = fakeClient({ auth });
    const deps = baseDeps(io, { makeClient: () => ({ client, auth }) });
    await runStatusCommand(deps, { json: false });
    expect((client as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(auth.settleCalls).toBe(1);
  });

  it("import closes the client after a MissingGrant failure", async () => {
    const io = memoryIo();
    const auth = fakeAuth();
    const client = fakeClient({ auth, admin: () => ({ status: 403, json: {} }) });
    const dir = workspaceWithMemory();
    const deps = baseDeps(io, { workspaceDir: dir, makeClient: () => ({ client, auth }) });
    const code = await runImportCommand(deps, { dryRun: false });
    expect(code).toBe(2);
    expect((client as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(auth.settleCalls).toBe(1);
  });

  it("logout needs no client and still returns 0", async () => {
    const io = memoryIo();
    const code = await runLogoutCommand(baseDeps(io));
    expect(code).toBe(0);
  });
});

describe("MissingGrant plumbing", () => {
  it("is exported and importable from errors", () => {
    expect(new MissingGrant().name).toBe("MissingGrant");
  });
});

describe("registerLumberroomCli", () => {
  it("registers one root cli command with the lumberroom descriptor", () => {
    const fake = createFakeApi({ workspaceDir: tempDir() });
    registerLumberroomCli(fake.api, {
      pluginConfig: {},
      stateDir: () => tempDir(),
      makeIo: () => Object.assign(memoryIo(), { close() {} }),
      mutateConfig: async () => {},
      makeClient: (_cfg: LumberroomConfig) => ({ client: fakeClient({ auth: fakeAuth() }), auth: fakeAuth() }),
    });
    expect(fake.cli).toHaveLength(1);
    const opts = fake.cli[0]!.opts as { descriptors: Array<{ name: string; hasSubcommands: boolean }> };
    expect(opts.descriptors).toEqual([
      { name: "lumberroom", description: "Set up, sign in to and import into lumberroom", hasSubcommands: true },
    ]);
  });

  // Records each subcommand's action the way commander chains them, so a test can run one.
  it("builds the terminal io inside each action and closes it before the action returns", async () => {
    const savedExit = process.exitCode;
    try {
      const fake = createFakeApi({ workspaceDir: tempDir() });
      const closed: number[] = [];
      const makeIo = vi.fn(() => Object.assign(memoryIo(), { close: () => closed.push(makeIo.mock.calls.length) }));
      registerLumberroomCli(fake.api, {
        pluginConfig: {},
        stateDir: () => tempDir(),
        makeIo,
        mutateConfig: async () => {},
        makeClient: (_cfg: LumberroomConfig) => ({ client: fakeClient({ auth: fakeAuth() }), auth: fakeAuth() }),
      });
      const { program, actions } = fakeProgram();
      (fake.cli[0]!.registrar as (ctx: unknown) => void)({ program, config: {}, workspaceDir: undefined });
      expect(makeIo).not.toHaveBeenCalled();
      await actions.get("status")!({});
      await actions.get("logout")!({});
      expect(makeIo).toHaveBeenCalledTimes(2);
      expect(closed).toEqual([1, 2]);
    } finally {
      process.exitCode = savedExit;
    }
  });

  it("an action sees a SecretRef token resolved from the environment, which the CLI host leaves unresolved", async () => {
    // The W gate saw openclaw lumberroom status get the token as the SecretRef object while the
    // gateway got the string, so every CLI action in token mode read as misconfigured.
    const saved = process.env.LUMBERROOM_OPENCLAW_TOKEN;
    const savedExit = process.exitCode;
    process.env.LUMBERROOM_OPENCLAW_TOKEN = "lr_from_env";
    const seen: LumberroomConfig[] = [];
    try {
      const fake = createFakeApi({ workspaceDir: tempDir() });
      registerLumberroomCli(fake.api, {
        pluginConfig: { baseUrl: "http://127.0.0.1:8794", auth: "token", token: { source: "env", provider: "default", id: "LUMBERROOM_OPENCLAW_TOKEN" } },
        stateDir: () => tempDir(),
        makeIo: () => Object.assign(memoryIo(), { close() {} }),
        mutateConfig: async () => {},
        makeClient: (cfg: LumberroomConfig) => {
          seen.push(cfg);
          const auth = fakeAuth();
          return { client: fakeClient({ auth }), auth };
        },
      });
      const { program, actions } = fakeProgram();
      (fake.cli[0]!.registrar as (ctx: unknown) => void)({ program, config: {}, workspaceDir: undefined });
      await actions.get("status")!({});
      expect(seen.map((c) => c.token)).toEqual(["lr_from_env"]);
    } finally {
      if (saved === undefined) delete process.env.LUMBERROOM_OPENCLAW_TOKEN;
      else process.env.LUMBERROOM_OPENCLAW_TOKEN = saved;
      process.exitCode = savedExit;
    }
  });
});

function fakeProgram(): { program: unknown; actions: Map<string, (opts: Record<string, unknown>) => Promise<void>> } {
  const actions = new Map<string, (opts: Record<string, unknown>) => Promise<void>>();
  const node = (name: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    self.command = (sub: string) => node(sub);
    self.description = () => self;
    self.option = () => self;
    self.action = (fn: (opts: Record<string, unknown>) => Promise<void>) => {
      actions.set(name, fn);
      return self;
    };
    return self;
  };
  return { program: node(""), actions };
}

// A terminal pair readline treats as a real TTY: it switches to raw mode and echoes keystrokes.
function fakeTerminal(): { input: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(m: boolean): unknown }; output: PassThrough & { isTTY: boolean; columns: number }; written(): string } {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false }) as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(m: boolean): unknown };
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    return input;
  };
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) as PassThrough & { isTTY: boolean; columns: number };
  let text = "";
  output.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return { input, output, written: () => text };
}

async function withTerminal<T>(term: ReturnType<typeof fakeTerminal>, run: () => Promise<T>): Promise<T> {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  Object.defineProperty(process, "stdin", { configurable: true, enumerable: true, get: () => term.input });
  Object.defineProperty(process, "stdout", { configurable: true, enumerable: true, get: () => term.output });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("createCliIo", () => {
  it("leaves the terminal alone until a question is asked", async () => {
    const term = fakeTerminal();
    await withTerminal(term, async () => {
      createCliIo();
      expect(term.input.isRaw).toBe(false);
    });
  });

  it("does not echo the token after an earlier question on the same terminal", async () => {
    const term = fakeTerminal();
    await withTerminal(term, async () => {
      const io = createCliIo();
      const deployment = io.ask("Deployment?", "lumberroom.cloud");
      await tick();
      term.input.write("\r");
      expect(await deployment).toBe("lumberroom.cloud");

      const secret = io.askSecret("Token:");
      await tick();
      term.input.write("SECRETXYZ\r");
      expect(await secret).toBe("SECRETXYZ");
      expect(term.written()).toContain("Token:");
      expect(term.written()).not.toContain("SECRETXYZ");
      expect(term.input.isRaw).toBe(false);
      io.close();
    });
  });

  it("still asks and reads pasted lines after a secret prompt", async () => {
    const term = fakeTerminal();
    await withTerminal(term, async () => {
      const io = createCliIo();
      const secret = io.askSecret("Token:");
      await tick();
      term.input.write("s\r");
      await secret;

      const next = io.ask("Save?");
      await tick();
      term.input.write("y\r");
      expect(await next).toBe("y");

      const lines = io.pastedLines()[Symbol.asyncIterator]();
      const first = lines.next();
      await tick();
      term.input.write("http://127.0.0.1/cb?code=x\r");
      expect((await first).value).toBe("http://127.0.0.1/cb?code=x");
      await lines.return?.();
      io.close();
      expect(term.input.isRaw).toBe(false);
    });
  });
});

// N5: piped answers arrive before the questions that want them, and stdin can close mid-setup.
function pipedTerminal(): ReturnType<typeof fakeTerminal> {
  const term = fakeTerminal();
  term.input.isTTY = false;
  return term;
}

describe("createCliIo with piped stdin", () => {
  it("answers each question from lines written before it was asked, and never echoes the secret", async () => {
    const term = pipedTerminal();
    await withTerminal(term, async () => {
      term.input.end("lumberroom.cloud\nSECRETXYZ\n\n");
      await tick();
      const io = createCliIo();
      expect(await io.ask("Deployment?", "x")).toBe("lumberroom.cloud");
      expect(await io.askSecret("Token:")).toBe("SECRETXYZ");
      expect(await io.ask("Owners?", "none")).toBe("none");
      expect(term.written()).toContain("Token:");
      expect(term.written()).not.toContain("SECRETXYZ");
      io.close();
    });
  });

  it("rejects a question still pending when stdin closes", async () => {
    const term = pipedTerminal();
    await withTerminal(term, async () => {
      const io = createCliIo();
      term.input.end("lumberroom.cloud\n");
      expect(await io.ask("Deployment?")).toBe("lumberroom.cloud");
      await expect(io.ask("Auth?")).rejects.toBeInstanceOf(InputClosed);
      io.close();
    });
  });

  it("hands the line after a stopped paste reader to the next question", async () => {
    const term = pipedTerminal();
    await withTerminal(term, async () => {
      const io = createCliIo();
      const lines = io.pastedLines()[Symbol.asyncIterator]();
      const first = lines.next();
      term.input.write("http://127.0.0.1/cb?code=x\n");
      expect((await first).value).toBe("http://127.0.0.1/cb?code=x");
      const pending = lines.next();
      await lines.return?.();
      expect((await pending).done).toBe(true);
      term.input.end("Y\n");
      expect(await io.ask("Save this configuration?")).toBe("Y");
      io.close();
    });
  });

  it("setup exits non-zero when stdin closes with a question pending", async () => {
    const term = pipedTerminal();
    const savedExit = process.exitCode;
    const mutateConfig = vi.fn(async () => {});
    try {
      await withTerminal(term, async () => {
        const fake = createFakeApi({ workspaceDir: tempDir() });
        registerLumberroomCli(fake.api, {
          pluginConfig: {},
          stateDir: () => tempDir(),
          makeIo: () => createCliIo(),
          mutateConfig,
          makeClient: () => {
            throw new Error("setup must stop before it connects");
          },
        });
        const { program, actions } = fakeProgram();
        (fake.cli[0]!.registrar as (ctx: unknown) => void)({ program, config: {}, workspaceDir: undefined });
        term.input.end("lumberroom.cloud\n");
        process.exitCode = 0;
        await actions.get("setup")!({});
        expect(process.exitCode).toBe(1);
        expect(term.written()).toContain("stdin closed");
      });
    } finally {
      process.exitCode = savedExit;
    }
    expect(mutateConfig).not.toHaveBeenCalled();
  });
});
