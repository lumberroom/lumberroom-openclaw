import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeApi } from "../fakes/api.js";
import { createCliIo, registerLumberroomCli, runImportCommand, runLoginCommand, runLogoutCommand, runStatusCommand } from "../../src/cli.js";
import { MissingGrant } from "../../src/errors.js";
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
      io: memoryIo(),
      mutateConfig: async () => {},
      makeClient: (_cfg: LumberroomConfig) => ({ client: fakeClient({ auth: fakeAuth() }), auth: fakeAuth() }),
    });
    expect(fake.cli).toHaveLength(1);
    const opts = fake.cli[0]!.opts as { descriptors: Array<{ name: string; hasSubcommands: boolean }> };
    expect(opts.descriptors).toEqual([
      { name: "lumberroom", description: "Set up, sign in to and import into lumberroom", hasSubcommands: true },
    ]);
  });
});

describe("createCliIo", () => {
  it("is exported as a function", () => {
    // Not invoked here: it opens a real readline interface over stdin, which a headless test
    // runner cannot drive and could leave open.
    expect(typeof createCliIo).toBe("function");
  });
});
