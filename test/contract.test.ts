// Pins every host and SDK import the plugin makes, so an OpenClaw or SDK release that moves one
// fails here before it fails inside a gateway. Host imports go through these subpaths and no
// others (plan, global constraints).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, discoverOAuthServerInfo, refreshAuthorization, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError, OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthProtectedResourceMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi, OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import { DECLARED_TOOLS, REVIEW_TOOLS, resolveConfig, SIDE_EFFECTING_TOOLS } from "../src/config.js";
import { createFakeApi } from "./fakes/api.js";
import { startFakeEngine, type FakeEngine } from "./fakes/engine.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<string, unknown>;
const MANIFEST = read("../openclaw.plugin.json") as {
  id: string;
  kind: string;
  contracts: { tools: string[] };
  toolMetadata: Record<string, { sideEffecting?: boolean }>;
  cliCommands: Array<{ name: string }>;
  configSchema: { properties: Record<string, { items?: { enum?: string[] } }> };
};
const PACKAGE = read("../package.json") as { openclaw: { extensions: string[] }; dependencies: Record<string, string> };

// L0 recorded these names on each subpath of openclaw 2026.9.6. isIncognitoSessionKey lives on
// routing; the core subpath does not carry it. Each specifier stays a literal so the bundler and a
// reader both see the exact import.
const HOST_EXPORTS: Array<[string, () => Promise<Record<string, unknown>>, string[]]> = [
  ["plugin-entry", () => import("openclaw/plugin-sdk/plugin-entry"), ["definePluginEntry"]],
  ["routing", () => import("openclaw/plugin-sdk/routing"), ["parseAgentSessionKey", "isIncognitoSessionKey", "isSubagentSessionKey"]],
  ["tool-results", () => import("openclaw/plugin-sdk/tool-results"), ["textResult"]],
  ["state-paths", () => import("openclaw/plugin-sdk/state-paths"), ["resolveStateDir"]],
  ["config-mutation", () => import("openclaw/plugin-sdk/config-mutation"), ["mutateConfigFile"]],
  ["plugin-runtime", () => import("openclaw/plugin-sdk/plugin-runtime"), ["getGlobalHookRunner"]],
  ["agent-scope-runtime", () => import("openclaw/plugin-sdk/agent-scope-runtime"), ["resolveDefaultAgentId"]],
  // The CLI resolves a SecretRef token itself; W found the CLI host passes it unresolved.
  ["secret-input-runtime", () => import("openclaw/plugin-sdk/secret-input-runtime"), ["resolveConfiguredSecretInputString"]],
];

describe("openclaw/plugin-sdk subpaths", () => {
  it.each(HOST_EXPORTS)("openclaw/plugin-sdk/%s exports its names as functions", async (subpath, load, names) => {
    const mod = await load();
    for (const name of names) expect(typeof mod[name], `${subpath}.${name}`).toBe("function");
  });

  it("openclaw/plugin-sdk/core loads and does not export isIncognitoSessionKey", async () => {
    const core = (await import("openclaw/plugin-sdk/core")) as Record<string, unknown>;
    expect(typeof core.definePluginEntry).toBe("function");
    expect(core.isIncognitoSessionKey).toBeUndefined();
  });

  it("the host types the plugin names compile against a memory capability and a config schema", () => {
    // Type-level pins: tsc fails this file if either type moves or changes shape.
    const capability: MemoryPluginCapability = { flushPlanResolver: () => null };
    const schema: OpenClawPluginConfigSchema = { safeParse: () => ({ success: true, data: {} }) };
    const register: (api: OpenClawPluginApi) => void = (api) => void api.registrationMode;
    expect(Object.hasOwn(capability, "flushPlanResolver")).toBe(true);
    expect(typeof schema.safeParse).toBe("function");
    expect(typeof register).toBe("function");
  });
});

describe("@modelcontextprotocol/sdk specifiers", () => {
  it.each([
    ["client/index.js Client", Client],
    ["client/streamableHttp.js StreamableHTTPClientTransport", StreamableHTTPClientTransport],
    ["client/streamableHttp.js StreamableHTTPError", StreamableHTTPError],
    ["client/auth.js auth", auth],
    ["client/auth.js discoverOAuthServerInfo", discoverOAuthServerInfo],
    ["client/auth.js refreshAuthorization", refreshAuthorization],
    ["client/auth.js UnauthorizedError", UnauthorizedError],
    ["server/auth/errors.js InvalidGrantError", InvalidGrantError],
    ["server/auth/errors.js OAuthError", OAuthError],
    ["server/auth/errors.js ServerError", ServerError],
    ["types.js McpError", McpError],
  ])("%s is a function", (_label, value) => {
    expect(typeof value).toBe("function");
  });

  it("the shared/auth.js types the token store names compile", () => {
    const tokens: OAuthTokens = { access_token: "a", token_type: "Bearer" };
    const client: OAuthClientInformationFull = { client_id: "c", redirect_uris: ["http://127.0.0.1:47632/callback"] };
    const as: AuthorizationServerMetadata = {
      issuer: "https://h",
      authorization_endpoint: "https://h/oauth/authorize",
      token_endpoint: "https://h/oauth/token",
      response_types_supported: ["code"],
    };
    const prm: OAuthProtectedResourceMetadata = { resource: "https://h/mcp" };
    const provider: Pick<OAuthClientProvider, "tokens"> = { tokens: () => tokens };
    expect([client.client_id, as.issuer, prm.resource, provider.tokens()]).toHaveLength(4);
  });

  let engine: FakeEngine | null = null;
  afterEach(async () => {
    await engine?.close();
    engine = null;
  });

  it("an invalid_grant from the token route reaches the caller as an InvalidGrantError that is an OAuthError and not a ServerError", async () => {
    engine = await startFakeEngine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    const info = await discoverOAuthServerInfo(`${engine.url}/mcp`);
    const err = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: { client_id: "never-registered" },
      refreshToken: "never-issued",
      resource: new URL(`${engine.url}/mcp`),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).not.toBeInstanceOf(ServerError);
  });
});

describe("openclaw.plugin.json", () => {
  it("contracts.tools equals DECLARED_TOOLS", () => {
    expect(MANIFEST.contracts.tools).toEqual([...DECLARED_TOOLS]);
  });

  it("toolMetadata marks exactly the side-effecting tools", () => {
    const marked = Object.entries(MANIFEST.toolMetadata).filter(([, m]) => m.sideEffecting).map(([n]) => n);
    expect(marked.sort()).toEqual([...SIDE_EFFECTING_TOOLS].sort());
  });

  it("the tools enum is every declared tool but the two review tools", () => {
    const allowed = DECLARED_TOOLS.filter((t) => !(REVIEW_TOOLS as readonly string[]).includes(t));
    expect(MANIFEST.configSchema.properties.tools!.items!.enum).toEqual(allowed);
  });

  it("every configSchema key is one resolveConfig knows", () => {
    for (const key of Object.keys(MANIFEST.configSchema.properties)) {
      try {
        resolveConfig({ [key]: undefined });
      } catch (e) {
        expect((e as Error).message, key).not.toMatch(/^unknown key/);
      }
    }
  });

  it("the plugin is lumberroom of kind memory with one root command", () => {
    expect(MANIFEST.id).toBe("lumberroom");
    expect(MANIFEST.kind).toBe("memory");
    expect(MANIFEST.cliCommands.map((c) => c.name)).toEqual(["lumberroom"]);
  });

  it("package.json points the host at dist/index.js and pins the SDK", () => {
    expect(PACKAGE.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(PACKAGE.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.1");
  });
});

describe("src/index.ts", () => {
  it("exports a plugin entry for lumberroom with the config schema", async () => {
    const { configSchema } = await import("../src/config.js");
    const entry = (await import("../src/index.js")).default as { id: string; register: unknown; configSchema: unknown };
    expect(entry.id).toBe("lumberroom");
    expect(entry.configSchema).toBe(configSchema);
    expect(typeof entry.register).toBe("function");
  });

  it("registers through the fake api as kind memory, with contracts.tools as the factory's names and an own null flush plan", async () => {
    const entry = (await import("../src/index.js")).default as { kind: string; register(api: unknown): void };
    // resolveStateDir() reads OPENCLAW_STATE_DIR; a scratch directory keeps ~/.openclaw out of it.
    const saved = process.env.OPENCLAW_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "lumberroom-contract-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const fake = createFakeApi({ pluginConfig: { auth: "token", token: "t" }, workspaceDir: stateDir });
      entry.register(fake.api);
      expect(entry.kind).toBe(MANIFEST.kind);
      expect((fake.tools[0]!.opts as { names: string[] }).names).toEqual(MANIFEST.contracts.tools);
      for (const tool of fake.resolveTools({ sessionKey: "agent:main:main" })) expect(MANIFEST.contracts.tools).toContain(tool.name);
      const capability = fake.capability as Record<string, unknown>;
      expect(Object.hasOwn(capability, "flushPlanResolver")).toBe(true);
      expect((capability.flushPlanResolver as () => unknown)()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = saved;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
