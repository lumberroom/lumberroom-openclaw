import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry from "../../src/index.js";
import { createFakeApi, type FakeApi } from "../fakes/api.js";

const MANIFEST = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8")) as { contracts: { tools: string[] } };

// resolveStateDir() reads OPENCLAW_STATE_DIR, so each test points it at a scratch directory and the
// owner's ~/.openclaw is never read.
let stateDir = "";
let savedStateDir: string | undefined;
beforeEach(() => {
  savedStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "lumberroom-index-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = savedStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function register(opts: Parameters<typeof createFakeApi>[0]): FakeApi {
  const fake = createFakeApi({ workspaceDir: join(stateDir, "ws"), ...opts });
  (entry as unknown as { register(api: unknown): void }).register(fake.api);
  return fake;
}

function hookNames(fake: FakeApi): string[] {
  return fake.hooks.map((h) => {
    const o = h.opts as { requiresToolAuthority?: boolean } | undefined;
    return o?.requiresToolAuthority ? `${h.name}+authority` : h.name;
  });
}

describe("register", () => {
  it("register with no config registers the capability, the guard, the tools, both prompt hooks, session_end, the service and the cli", () => {
    const fake = register({});
    expect(fake.capability).toBeDefined();
    expect(hookNames(fake).sort()).toEqual(["before_prompt_build", "before_prompt_build+authority", "before_tool_call", "session_end"]);
    expect(fake.tools).toHaveLength(1);
    expect(fake.services.map((s) => s.id)).toEqual(["lumberroom"]);
    expect(fake.cli).toHaveLength(1);
    expect(fake.logs.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("register with a bad baseUrl still registers the capability and the guard", async () => {
    const fake = register({ pluginConfig: { baseUrl: "ftp://nope" } });
    expect(fake.capability).toBeDefined();
    expect(hookNames(fake)).toContain("before_tool_call");
    expect(fake.logs.some((l) => l.level === "warn" && l.message.startsWith("lumberroom: inert until configured"))).toBe(true);
    const verdict = (await fake.runHook("before_tool_call", { toolName: "write", params: { path: "MEMORY.md" } }, { agentId: "main" })) as { block?: boolean } | undefined;
    expect(verdict?.block).toBe(true);
    expect(fake.resolveTools({ sessionKey: "agent:main:main" })).toEqual([]);
  });

  it("cli-metadata registration touches no runtime", () => {
    const fake = register({ registrationMode: "cli-metadata" });
    expect(fake.cli).toHaveLength(1);
    expect(fake.services).toEqual([]);
  });

  it("the tool factory's names equal contracts.tools", () => {
    const fake = register({ pluginConfig: { auth: "token", token: "t" } });
    const opts = fake.tools[0]!.opts as { names: string[] };
    expect(opts.names).toEqual(MANIFEST.contracts.tools);
    const offered = fake.resolveTools({ sessionKey: "agent:main:main" }).map((t) => t.name);
    expect(offered.length).toBeGreaterThan(0);
    for (const name of offered) expect(MANIFEST.contracts.tools).toContain(name);
  });

  it("the guard reads the workspace from the host runtime for the hook's agent", async () => {
    const fake = register({ pluginConfig: { auth: "token", token: "t" } });
    const verdict = (await fake.runHook("before_tool_call", { toolName: "write", params: { path: "notes.md" } }, { agentId: "main" })) as { block?: boolean } | undefined;
    expect(verdict?.block).not.toBe(true);
  });
});
