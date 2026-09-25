// openclaw lumberroom setup | login | logout | status | import. Spec section 14.
import { createInterface } from "node:readline/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { login, logout } from "./auth/login.js";
import { resolveConfig, sidecarCheck } from "./config.js";
import { MissingGrant } from "./errors.js";
import { readEntries, runImport } from "./importer.js";
import { loginIoFrom, runSetup, type CliDeps, type CliIo } from "./setup.js";
import type { LumberroomConfig } from "./types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function readSlotOwner(cliConfig: Record<string, unknown>): string | null {
  const slots = rec(rec(cliConfig.plugins).slots);
  return typeof slots.memory === "string" ? slots.memory : null;
}

function readAllowConversationAccess(cliConfig: Record<string, unknown>): boolean {
  const entries = rec(rec(cliConfig.plugins).entries);
  const hooks = rec(rec(entries.lumberroom).hooks);
  return hooks.allowConversationAccess === true;
}

export interface StatusReport {
  baseUrl: string | null;
  auth: string | null;
  hosted: boolean | null;
  credential: "present" | "missing" | "unknown";
  slotOwner: string | null;
  allowConversationAccess: boolean;
  sidecar: { dreamingOff: boolean; memoryCoreOff: boolean };
  reachable: boolean;
  serverInfo: { name: string; version: string } | null;
  protocolVersion: string | null;
  tools: string[];
  whoami: { client: string; may_ingest: boolean; may_delete: boolean } | null;
  roundTripMs: number | null;
  problems: string[];
}

export async function runStatusCommand(deps: CliDeps, opts: { json: boolean }): Promise<number> {
  const { io } = deps;
  const problems: string[] = [];

  const owner = readSlotOwner(deps.cliConfig);
  if (owner !== "lumberroom") problems.push(`plugins.slots.memory is ${JSON.stringify(owner)}, not "lumberroom"`);

  const allowConversationAccess = readAllowConversationAccess(deps.cliConfig);
  if (!allowConversationAccess) problems.push("plugins.entries.lumberroom.hooks.allowConversationAccess is not true");

  const sidecar = sidecarCheck(deps.cliConfig);
  if (!sidecar.dreamingOff) problems.push("plugins.entries.lumberroom.config.dreaming.enabled is not false");
  if (!sidecar.memoryCoreOff) problems.push("plugins.entries.memory-core.enabled is not false");

  let cfg: LumberroomConfig | null = null;
  try {
    cfg = resolveConfig(deps.pluginConfig);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  let reachable = false;
  let serverInfo: { name: string; version: string } | null = null;
  let protocolVersion: string | null = null;
  let tools: string[] = [];
  let roundTripMs: number | null = null;
  let whoami: { client: string; may_ingest: boolean; may_delete: boolean } | null = null;
  let credential: StatusReport["credential"] = "unknown";

  if (cfg) {
    const { client } = deps.makeClient(cfg);
    try {
      const start = Date.now();
      const listed = await client.listTools({ invocation: "cli", timeoutMs: cfg.connectTimeoutMs });
      roundTripMs = Date.now() - start;
      if (listed.result.kind === "ok" && listed.listing) {
        reachable = true;
        serverInfo = listed.listing.serverInfo;
        protocolVersion = listed.listing.protocolVersion;
        tools = listed.listing.tools.map((tool) => tool.name);
      } else {
        problems.push(`tools/list failed: ${listed.result.error ?? listed.result.kind}`);
      }

      const who = await client.admin("GET", "/admin/whoami", null, { timeoutMs: cfg.connectTimeoutMs });
      if (who.status === 200 && isRecord(who.json)) {
        whoami = {
          client: typeof who.json.client === "string" ? who.json.client : "",
          may_ingest: who.json.may_ingest === true,
          may_delete: who.json.may_delete === true,
        };
        credential = "present";
      } else {
        problems.push(`admin/whoami failed (${who.status})`);
        credential = who.status === 401 ? "missing" : "unknown";
      }
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    } finally {
      await client.close(3000);
    }
  }

  const report: StatusReport = {
    baseUrl: cfg?.baseUrl ?? null,
    auth: cfg?.auth ?? null,
    hosted: cfg?.hosted ?? null,
    credential,
    slotOwner: owner,
    allowConversationAccess,
    sidecar,
    reachable,
    serverInfo,
    protocolVersion,
    tools,
    whoami,
    roundTripMs,
    problems,
  };

  if (opts.json) {
    io.print(JSON.stringify(report));
  } else {
    io.print(`baseUrl: ${report.baseUrl ?? "(invalid config)"}`);
    io.print(`auth: ${report.auth ?? "(invalid config)"}`);
    io.print(`slot owner: ${report.slotOwner ?? "none"}`);
    io.print(`conversation access: ${report.allowConversationAccess}`);
    io.print(`dreaming.enabled is false: ${sidecar.dreamingOff}`);
    io.print(`memory-core.enabled is false: ${sidecar.memoryCoreOff}`);
    io.print(`reachable: ${report.reachable}`);
    if (serverInfo) io.print(`server: ${serverInfo.name} ${serverInfo.version}, protocol ${protocolVersion ?? "unknown"}`);
    if (reachable) io.print(`tools: ${tools.join(", ")}`);
    if (whoami) io.print(`credential: ${credential} (client ${whoami.client}, may_ingest ${whoami.may_ingest}, may_delete ${whoami.may_delete})`);
    else if (cfg) io.print(`credential: ${credential}`);
    if (roundTripMs !== null) io.print(`round trip: ${roundTripMs} ms`);
    for (const problem of problems) io.print(`problem: ${problem}`);
  }

  return problems.length === 0 ? 0 : 1;
}

export async function runLoginCommand(deps: CliDeps, opts: { browser: boolean }): Promise<number> {
  const { io } = deps;
  let cfg: LumberroomConfig;
  try {
    cfg = resolveConfig(deps.pluginConfig);
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (cfg.auth !== "oauth") {
    io.print("login refuses in auth token mode. Paste a token with openclaw lumberroom setup, or switch auth to oauth.");
    return 1;
  }
  const { client } = deps.makeClient(cfg);
  try {
    await login(cfg, { stateDir: deps.stateDir(), openBrowser: opts.browser, io: loginIoFrom(io) });
    return 0;
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await client.close(3000);
  }
}

export async function runLogoutCommand(deps: CliDeps): Promise<number> {
  const { io } = deps;
  let cfg: LumberroomConfig;
  try {
    cfg = resolveConfig(deps.pluginConfig);
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  }
  await logout(cfg, deps.stateDir());
  return 0;
}

export async function runImportCommand(deps: CliDeps, opts: { dryRun: boolean; workspace?: string }): Promise<number> {
  const { io } = deps;
  const workspaceDir = opts.workspace ?? deps.workspaceDir;
  if (!workspaceDir) {
    io.print("import needs a workspace: pass --workspace <dir>");
    return 1;
  }

  if (opts.dryRun) {
    for (const entry of readEntries(workspaceDir)) {
      io.print(`${entry.namespace}\t${entry.file}\t${entry.text.slice(0, 80).replace(/\s+/g, " ")}`);
    }
    return 0;
  }

  let cfg: LumberroomConfig;
  try {
    cfg = resolveConfig(deps.pluginConfig);
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { client } = deps.makeClient(cfg);
  try {
    const report = await runImport(client, workspaceDir, { dryRun: false, agentId: null, timeoutMs: cfg.toolTimeoutMs });
    io.print(
      `posted ${report.posted} entries: ${report.proposalsNew} new, ${report.proposalsReinforced} reinforced, ` +
        `${report.refused} refused, ${report.blocked} blocked`,
    );
    io.print("review with: lumberroom ingest review, or the queue in the lumberroom.cloud console.");
    return 0;
  } catch (err) {
    if (err instanceof MissingGrant) {
      io.print('the credential lacks mayIngest. Add "mayIngest":true to the AUTH_TOKENS grant, or consent with full on lumberroom.cloud.');
      return 2;
    }
    io.print(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await client.close(3000);
  }
}

function readSecret(question: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question.endsWith(" ") ? question : `${question} `);
    let input = "";

    if (!(stdin.isTTY && typeof stdin.setRawMode === "function")) {
      // No TTY to mute (a test harness or piped input): read one line with no echo control.
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolvePromise(buffered.slice(0, newline).replace(/\r$/, ""));
      };
      stdin.on("data", onData);
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          stdin.setRawMode?.(false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolvePromise(input);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode?.(false);
          stdin.removeListener("data", onData);
          reject(new Error("sign-in cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          input = input.slice(0, -1);
          continue;
        }
        input += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** node:readline/promises over stdin and stdout; askSecret does not echo. */
export function createCliIo(): CliIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    async ask(question, fallback) {
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = (await rl.question(`${question}${suffix} `)).trim();
      return answer || (fallback ?? "");
    },
    askSecret(question) {
      return readSecret(question);
    },
    pastedLines(): AsyncIterable<string> {
      return rl;
    },
  };
}

/**
 * The gateway resolves a SecretRef token at start, but a CLI command gets the raw config (seen in
 * the W gate). A ref that does not resolve stays as it was, so resolveConfig names the variable.
 */
async function resolveTokenRef(pluginConfig: unknown, rootConfig: unknown): Promise<unknown> {
  if (!isRecord(pluginConfig) || !isRecord(pluginConfig.token)) return pluginConfig;
  try {
    const { value } = await resolveConfiguredSecretInputString({
      config: rootConfig as Parameters<typeof resolveConfiguredSecretInputString>[0]["config"],
      env: process.env,
      value: pluginConfig.token,
      path: "plugins.entries.lumberroom.config.token",
    });
    return value ? { ...pluginConfig, token: value } : pluginConfig;
  } catch {
    return pluginConfig;
  }
}

export function registerLumberroomCli(api: OpenClawPluginApi, deps: Omit<CliDeps, "cliConfig" | "workspaceDir">): void {
  api.registerCli(
    (ctx) => {
      const fullDeps = async (): Promise<CliDeps> => ({
        ...deps,
        pluginConfig: await resolveTokenRef(deps.pluginConfig, ctx.config ?? {}),
        cliConfig: (ctx.config ?? {}) as unknown as Record<string, unknown>,
        workspaceDir: ctx.workspaceDir,
      });

      const root = ctx.program.command("lumberroom").description("Set up, sign in to and import into lumberroom");

      root
        .command("setup")
        .description("Interactive setup")
        .action(async () => {
          process.exitCode = await runSetup(await fullDeps());
        });

      root
        .command("login")
        .description("Sign in with OAuth")
        .option("--no-browser", "print the sign-in URL instead of opening a browser")
        .action(async (opts: { browser?: boolean }) => {
          process.exitCode = await runLoginCommand(await fullDeps(), { browser: opts.browser !== false });
        });

      root
        .command("logout")
        .description("Sign out and delete the stored OAuth tokens")
        .action(async () => {
          process.exitCode = await runLogoutCommand(await fullDeps());
        });

      root
        .command("status")
        .description("Report reachability, sign-in and slot ownership")
        .option("--json", "print one JSON object")
        .action(async (opts: { json?: boolean }) => {
          process.exitCode = await runStatusCommand(await fullDeps(), { json: opts.json === true });
        });

      root
        .command("import")
        .description("Send MEMORY.md, USER.md and memory/*.md to the review queue")
        .option("--dry-run", "print entries and namespaces without posting")
        .option("--workspace <dir>", "the workspace to read from")
        .action(async (opts: { dryRun?: boolean; workspace?: string }) => {
          process.exitCode = await runImportCommand(await fullDeps(), { dryRun: opts.dryRun === true, workspace: opts.workspace });
        });
    },
    { descriptors: [{ name: "lumberroom", description: "Set up, sign in to and import into lumberroom", hasSubcommands: true }] },
  );
}
