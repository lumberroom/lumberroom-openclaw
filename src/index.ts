import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { createOAuthAuth } from "./auth/oauth.js";
import { createTokenAuth } from "./auth/token.js";
import { buildCapability } from "./capability.js";
import { createCliIo, registerLumberroomCli } from "./cli.js";
import { createEngineClient } from "./client/mcp.js";
import { configSchema, resolveConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { registerGuard, registerHooks } from "./hooks.js";
import { registerLumberroomService } from "./service.js";
import { createState } from "./state.js";
import { registerTools } from "./tools.js";
import type { AuthHandle, LumberroomConfig, PluginDeps } from "./types.js";
import { VERSION } from "./version.js";

function makeAuth(cfg: LumberroomConfig, stateDir: string): AuthHandle {
  return cfg.auth === "token" ? createTokenAuth(cfg.token!) : createOAuthAuth(cfg, { stateDir });
}

export default definePluginEntry({
  id: "lumberroom",
  name: "lumberroom",
  description: "Durable memory shared with every agent you use, from lumberroom.cloud or a self-hosted engine.",
  kind: "memory",
  configSchema,
  register(api: OpenClawPluginApi) {
    const stateDir = resolveStateDir();
    let cfg: LumberroomConfig | null = null;
    let inert: string | null = null;
    try {
      cfg = resolveConfig(api.pluginConfig);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      inert = e.message;
      api.logger.warn(`lumberroom: inert until configured (${inert})`);
    }
    // Discovery and cli-metadata passes must open no socket and read no token (spec 8).
    const full = api.registrationMode === "full";
    const auth = cfg && full ? makeAuth(cfg, stateDir) : null;
    const client = cfg && auth ? createEngineClient(cfg, auth, { version: VERSION }) : null;
    const deps: PluginDeps = {
      state: createState(cfg, inert, stateDir),
      client,
      auth,
      stateDir,
      logger: api.logger,
      now: Date.now,
      rootConfig: () => api.runtime.config.current(),
    };

    // Both register whatever the config says, so a typo can never reopen the local store.
    api.registerMemoryCapability(buildCapability(deps));
    registerGuard(api, (agentId) => {
      // current() is DeepReadonly<OpenClawConfig>; both host helpers only read it.
      const current = api.runtime.config.current() as Parameters<typeof resolveDefaultAgentId>[0];
      return api.runtime.agent.resolveAgentWorkspaceDir(current, agentId ?? resolveDefaultAgentId(current));
    });

    registerTools(api, deps);
    registerHooks(api, deps);
    if (full) registerLumberroomService(api, deps);
    registerLumberroomCli(api, {
      pluginConfig: api.pluginConfig,
      stateDir: resolveStateDir,
      makeIo: createCliIo,
      mutateConfig: async (mutate) => {
        await mutateConfigFile({
          mutate: (draft) => mutate(draft as unknown as Record<string, unknown>),
          afterWrite: { mode: "restart", reason: "lumberroom took the memory slot" },
        });
      },
      makeClient: (c, opts) => {
        const a = makeAuth(c, opts?.stateDir ?? resolveStateDir());
        return { client: createEngineClient(c, a, { version: VERSION }), auth: a };
      },
    });
  },
});
