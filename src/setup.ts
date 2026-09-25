// Interactive setup: nothing is saved until every answer is validated (spec section 14).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { login } from "./auth/login.js";
import type { LoginIo } from "./auth/login.js";
import { MEMORY_CORE_ID, TOKEN_ENV, resolveConfig } from "./config.js";
import type { AuthHandle, AuthMode, EngineClient, LumberroomConfig } from "./types.js";

export interface SetupAnswers {
  deployment: "hosted" | "self";
  baseUrl?: string;
  auth: AuthMode;
  token?: string;
  dreamingReview: boolean;
  ownerIds: string[];
}

export interface SetupPlan {
  entryConfig: Record<string, unknown>;
  addPluginsAllow: boolean;
  addToolsAlsoAllow: boolean;
  envToken: string | null;
  diff: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

// Every OpenClaw profile but full allows a fixed list of core tool ids (OC/src/agents/tool-catalog.ts
// CORE_TOOL_PROFILES), so a plugin's tools pass only when tools.alsoAllow names the plugin. The W
// gate saw minimal and messaging hide all four default tools and coding keep only memory_search.
const PROFILE_ALLOWING_PLUGIN_TOOLS = "full";

function includesString(list: unknown, value: string): boolean {
  return Array.isArray(list) && list.some((entry) => entry === value);
}

/** Validates the shape of the answers and decides what setup will write; throws ConfigError on a bad answer. */
export function planSetup(current: Record<string, unknown>, answers: SetupAnswers): SetupPlan {
  const entryConfig: Record<string, unknown> = {
    ...(answers.deployment === "self" && answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
    auth: answers.auth,
    ...(answers.auth === "token" ? { token: { source: "env", provider: "default", id: TOKEN_ENV } } : {}),
    dreamingReview: answers.dreamingReview,
    ...(answers.ownerIds.length ? { ownerIds: [...answers.ownerIds] } : {}),
    dreaming: { enabled: false },
  };

  // resolveConfig is the single source of truth for what a valid config looks like (baseUrl shape,
  // ownerIds channels, bounds). The SecretRef would fail that check on its own, so the probe swaps
  // in the plaintext answer, which is never written to entryConfig or the diff.
  const probe: Record<string, unknown> = { ...entryConfig };
  if (answers.auth === "token") probe.token = answers.token ?? "";
  resolveConfig(probe);

  const plugins = rec(current.plugins);
  const pluginsAllow = plugins.allow;
  const addPluginsAllow = Array.isArray(pluginsAllow) && pluginsAllow.length > 0 && !includesString(pluginsAllow, "lumberroom");

  const toolsBlock = rec(current.tools);
  const profile = typeof toolsBlock.profile === "string" ? toolsBlock.profile : undefined;
  const hidesPluginTools = profile !== undefined && profile !== PROFILE_ALLOWING_PLUGIN_TOOLS;
  const alreadyAllowed = includesString(toolsBlock.alsoAllow, "lumberroom") || includesString(toolsBlock.allow, "lumberroom");
  const addToolsAlsoAllow = hidesPluginTools && !alreadyAllowed;

  const diff = [
    'plugins.slots.memory = "lumberroom"',
    "plugins.entries.lumberroom.enabled = true",
    "plugins.entries.lumberroom.hooks.allowConversationAccess = true",
    `plugins.entries.lumberroom.config = ${JSON.stringify(entryConfig)}`,
    "plugins.entries.memory-core.enabled = false",
    ...(addPluginsAllow ? ['plugins.allow += "lumberroom"'] : []),
    ...(addToolsAlsoAllow ? ['tools.alsoAllow (or tools.allow, whichever is set) += "lumberroom"'] : []),
  ];

  return {
    entryConfig,
    addPluginsAllow,
    addToolsAlsoAllow,
    envToken: answers.auth === "token" ? (answers.token ?? null) : null,
    diff,
  };
}

/** Runs inside mutateConfigFile's mutate. */
export function applySetup(draft: Record<string, unknown>, plan: SetupPlan): void {
  const plugins = (draft.plugins = rec(draft.plugins));
  const slots = (plugins.slots = rec(plugins.slots));
  slots.memory = "lumberroom";

  const entries = (plugins.entries = rec(plugins.entries));
  const lumberroom = (entries.lumberroom = rec(entries.lumberroom));
  lumberroom.enabled = true;
  const hooks = (lumberroom.hooks = rec(lumberroom.hooks));
  hooks.allowConversationAccess = true;
  lumberroom.config = plan.entryConfig;

  const memoryCore = (entries[MEMORY_CORE_ID] = rec(entries[MEMORY_CORE_ID]));
  memoryCore.enabled = false;

  if (plan.addPluginsAllow) {
    const allow = Array.isArray(plugins.allow) ? (plugins.allow as unknown[]) : [];
    if (!includesString(allow, "lumberroom")) allow.push("lumberroom");
    plugins.allow = allow;
  }

  if (plan.addToolsAlsoAllow) {
    const tools = (draft.tools = rec(draft.tools));
    // The host refuses tools.allow and tools.alsoAllow set together, so an existing allow list wins.
    if (Array.isArray(tools.allow)) {
      const allow = tools.allow as unknown[];
      if (!includesString(allow, "lumberroom")) allow.push("lumberroom");
    } else {
      const alsoAllow = Array.isArray(tools.alsoAllow) ? (tools.alsoAllow as unknown[]) : [];
      if (!includesString(alsoAllow, "lumberroom")) alsoAllow.push("lumberroom");
      tools.alsoAllow = alsoAllow;
    }
  }
}

/** Upserts one line, keeps the rest, 0600. */
export function writeEnvToken(stateDir: string, token: string): void {
  const path = join(stateDir, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  const prefix = `${TOKEN_ENV}=`;
  let found = false;
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    found = true;
    return `${prefix}${token}`;
  });
  if (next.length && next[next.length - 1] === "") next.pop();
  if (!found) next.push(`${prefix}${token}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, `${next.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface CliIo {
  print(line: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  pastedLines(): AsyncIterable<string>;
}

export interface CliDeps {
  pluginConfig: unknown;
  cliConfig: Record<string, unknown>; // the CLI context's config
  workspaceDir: string | undefined;
  stateDir(): string;
  io: CliIo;
  mutateConfig(mutate: (draft: Record<string, unknown>) => void): Promise<void>;
  makeClient(cfg: LumberroomConfig): { client: EngineClient; auth: AuthHandle };
}

/** Opening a browser is best-effort; the printed sign-in URL (spec 7.2 step 2) is the real fallback. */
async function openBrowserBestEffort(url: string): Promise<void> {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", '""', url] : [url];
  try {
    const { spawn } = await import("node:child_process");
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The sign-in URL was already printed by login(); nothing else to do here.
  }
}

/** Adapts a CliIo to a LoginIo for login(); cli.ts reuses this for the standalone login command. */
export function loginIoFrom(io: CliIo): LoginIo {
  return {
    print: (line) => io.print(line),
    pastedLines: () => io.pastedLines(),
    openBrowser: (url) => openBrowserBestEffort(url),
  };
}

async function askYesNo(io: CliIo, question: string, defaultYes: boolean): Promise<boolean> {
  const fallback = defaultYes ? "Y" : "N";
  const answer = await io.ask(question, fallback);
  return /^y/i.test(answer.trim() || fallback);
}

/** Resolves to the exit code. */
export async function runSetup(deps: CliDeps): Promise<number> {
  const { io } = deps;

  const deploymentAnswer = await io.ask("Deployment: lumberroom.cloud, or a self-hosted engine?", "lumberroom.cloud");
  const deployment: "hosted" | "self" = /self/i.test(deploymentAnswer) ? "self" : "hosted";

  let baseUrl: string | undefined;
  if (deployment === "self") {
    baseUrl = (await io.ask("Self-hosted engine URL, such as http://127.0.0.1:8787:")).trim();
  }

  let auth: AuthMode;
  if (deployment === "hosted") {
    const choice = await io.ask("Sign in with a browser, or paste an API token (lr_...)?", "Sign in with a browser");
    auth = /token/i.test(choice) ? "token" : "oauth";
  } else {
    const choice = await io.ask("Auth: oauth or token?", "oauth");
    auth = choice.trim().toLowerCase() === "token" ? "token" : "oauth";
  }

  let token: string | undefined;
  if (auth === "token") {
    token = await io.askSecret("Token:");
  }

  let dreamingReview = false;
  if (deployment === "hosted") {
    dreamingReview = await askYesNo(io, "Let OpenClaw work the lumberroom.cloud dreaming queue?", false);
  }

  const ownersRaw = await io.ask("Owners in shared chats, comma-separated channel:senderId (blank for none):", "");
  const ownerIds = ownersRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const answers: SetupAnswers = { deployment, baseUrl, auth, token, dreamingReview, ownerIds };

  let plan: SetupPlan;
  try {
    plan = planSetup(deps.cliConfig, answers);
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const probeConfig: Record<string, unknown> = { ...plan.entryConfig };
  if (auth === "token") probeConfig.token = token ?? "";
  const cfg: LumberroomConfig = resolveConfig(probeConfig);

  const { client, auth: authHandle } = deps.makeClient(cfg);
  try {
    if (auth === "token") {
      const res = await client.admin("GET", "/admin/whoami", null, { timeoutMs: cfg.connectTimeoutMs });
      if (res.status !== 200) {
        io.print(`lumberroom refused the configured token (${res.status}). Check the token and its grant.`);
        return 1;
      }
    } else {
      try {
        await login(cfg, { stateDir: deps.stateDir(), openBrowser: true, io: loginIoFrom(io) });
      } catch (err) {
        io.print(err instanceof Error ? err.message : String(err));
        return 1;
      }
      const listed = await client.listTools({ invocation: "cli", timeoutMs: cfg.connectTimeoutMs });
      if (listed.result.kind !== "ok") {
        io.print(`lumberroom signed in but tools/list failed: ${listed.result.error ?? listed.result.kind}`);
        return 1;
      }
    }
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await client.close(3000);
  }

  for (const line of plan.diff) io.print(line);
  const confirmed = await askYesNo(io, "Save this configuration?", true);
  if (!confirmed) {
    io.print("aborted, nothing saved");
    return 1;
  }

  await deps.mutateConfig((draft) => applySetup(draft, plan));
  if (plan.envToken) writeEnvToken(deps.stateDir(), plan.envToken);

  return 0;
}
