// A fake OpenClawPluginApi that records every registration and runs hooks and tool factories the
// way the host does: priority order, the two before_prompt_build phases kept apart, the
// before_tool_call matcher, and the tool-authority phase keeping only prependContext and
// appendContext (OC/src/plugins/hooks.ts:261-271,983-1065).
import { resolve } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface FakeApi {
  api: OpenClawPluginApi; // every register* records; runtime.agent.resolveAgentWorkspaceDir and runtime.config.current are settable
  tools: Array<{ factory: unknown; opts: unknown }>;
  hooks: Array<{ name: string; handler: (event: unknown, ctx: unknown) => unknown; opts: unknown }>;
  capability: unknown;
  services: Array<{ id: string; start: (ctx: unknown) => unknown; stop?: (ctx: unknown) => unknown }>;
  cli: Array<{ registrar: unknown; opts: unknown }>;
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }>; // every api.logger call
  runHook(name: string, event: unknown, ctx: unknown, opts?: { requiresToolAuthority?: boolean; allows?: string[] }): Promise<unknown>;
  resolveTools(ctx: Record<string, unknown>): Array<{ name: string; description: string; parameters: unknown; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>;
}

type Registered = { name: string; handler: (event: unknown, ctx: unknown) => unknown; opts: unknown };
type HookOpts = { priority?: number; matcher?: readonly string[]; requiresToolAuthority?: boolean } | undefined;
type PromptResult = Record<string, unknown>;

const PROMPT_TEXT_FIELDS = ["prependContext", "appendContext", "prependSystemContext", "appendSystemContext"] as const;

// The host joins text from several handlers with a blank line (OC/src/shared/text/join-segments.ts).
function mergePrompt(acc: PromptResult | undefined, next: PromptResult): PromptResult {
  const out: PromptResult = { ...acc };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    const prev = out[k];
    if ((PROMPT_TEXT_FIELDS as readonly string[]).includes(k) && typeof prev === "string" && prev && typeof v === "string" && v) {
      out[k] = `${prev}\n\n${v}`;
    } else if (!(k in out) || out[k] === undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function createFakeApi(opts: { pluginConfig?: unknown; registrationMode?: "full" | "discovery" | "cli-metadata"; workspaceDir?: string }): FakeApi {
  const mode = opts.registrationMode ?? "full";
  const config: Record<string, unknown> = {};
  const fake: FakeApi = {
    api: undefined as unknown as OpenClawPluginApi,
    tools: [],
    hooks: [],
    capability: undefined,
    services: [],
    cli: [],
    logs: [],
    async runHook(name, event, ctx, runOpts) {
      const authority = runOpts?.requiresToolAuthority === true;
      const allowed = new Set(runOpts?.allows ?? []);
      const toolName = name === "before_tool_call" || name === "after_tool_call" ? (event as { toolName?: unknown } | null)?.toolName : undefined;
      const hookCtx = authority
        ? { ...(ctx as object), toolAuthority: { fingerprint: "fake-api", allows: (n: string) => allowed.has(n), assertActive: () => undefined } }
        : ctx;
      const selected = fake.hooks
        .filter((h) => h.name === name)
        .filter((h) => name !== "before_prompt_build" || ((h.opts as HookOpts)?.requiresToolAuthority === true) === authority)
        .filter((h) => {
          const matcher = (h.opts as HookOpts)?.matcher;
          return typeof toolName !== "string" || !matcher || matcher.some((m) => m.toLowerCase() === toolName.toLowerCase());
        })
        .map((h, i) => ({ h, i }))
        .sort((a, b) => ((b.h.opts as HookOpts)?.priority ?? 0) - ((a.h.opts as HookOpts)?.priority ?? 0) || a.i - b.i)
        .map(({ h }) => h);

      let merged: PromptResult | undefined;
      for (const h of selected) {
        const r = (await h.handler(event, hookCtx)) as PromptResult | undefined | null;
        if (r === undefined || r === null) continue;
        // before_tool_call stops at the first block, as the host does.
        if (name === "before_tool_call" && r.block === true) return r;
        merged = mergePrompt(merged, r);
      }
      if (authority && merged) {
        const kept: PromptResult = {};
        if (merged.prependContext) kept.prependContext = merged.prependContext;
        if (merged.appendContext) kept.appendContext = merged.appendContext;
        return Object.keys(kept).length ? kept : undefined;
      }
      return merged;
    },
    resolveTools(ctx) {
      const out: ReturnType<FakeApi["resolveTools"]> = [];
      for (const { factory } of fake.tools) {
        let produced: unknown;
        if (typeof factory === "function") produced = (factory as (c: unknown) => unknown)(ctx);
        else if (factory && typeof factory === "object" && "create" in factory) produced = (factory as { create(c: unknown): unknown }).create(ctx);
        else produced = factory;
        if (produced === null || produced === undefined) continue;
        out.push(...((Array.isArray(produced) ? produced : [produced]) as ReturnType<FakeApi["resolveTools"]>));
      }
      return out;
    },
  };

  const runtime = {
    agent: {
      resolveAgentWorkspaceDir: (_cfg: unknown, _agentId?: string): string => {
        if (!opts.workspaceDir) throw new Error("createFakeApi got no workspaceDir");
        return opts.workspaceDir;
      },
    },
    config: {
      current: (): unknown => config,
    },
  };

  const record = (level: "debug" | "info" | "warn" | "error") => (message: string) => {
    fake.logs.push({ level, message });
  };

  const implemented: Record<string, unknown> = {
    id: "lumberroom",
    name: "lumberroom",
    source: "test/fakes/api.ts",
    registrationMode: mode,
    config,
    pluginConfig: opts.pluginConfig,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    resolvePath: (input: string) => resolve(opts.workspaceDir ?? process.cwd(), input),
    registerTool: (factory: unknown, toolOpts?: unknown) => {
      fake.tools.push({ factory, opts: toolOpts });
    },
    on: (name: string, handler: Registered["handler"], hookOpts?: unknown) => {
      fake.hooks.push({ name, handler, opts: hookOpts });
    },
    registerMemoryCapability: (capability: unknown) => {
      fake.capability = capability;
    },
    registerService: (service: FakeApi["services"][number]) => {
      fake.services.push(service);
    },
    registerCli: (registrar: unknown, cliOpts?: unknown) => {
      fake.cli.push({ registrar, opts: cliOpts });
    },
  };

  // Anything the plugin reaches for that the fake does not record fails loudly, so a new host
  // call surfaces in a test instead of passing as a silent no-op.
  fake.api = new Proxy(implemented, {
    get(target, prop) {
      if (prop === "runtime") {
        // The host leaves runtime unavailable while it collects CLI metadata (OC/docs/plugins/sdk-runtime.md:12).
        if (mode === "cli-metadata") throw new Error("api.runtime is unavailable during cli-metadata registration");
        return runtime;
      }
      if (typeof prop === "string" && prop in target) return target[prop];
      if (typeof prop === "string" && /^(register|on[A-Z]|enqueue|emit)/.test(prop)) {
        return () => {
          throw new Error(`the fake api does not implement api.${prop}`);
        };
      }
      return undefined;
    },
  }) as unknown as OpenClawPluginApi;

  return fake;
}
