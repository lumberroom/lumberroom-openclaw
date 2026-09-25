// openclaw lumberroom setup | login | logout | status | import. Spec section 14.
import { createInterface as createLineReader } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { login, logout } from "./auth/login.js";
import { resolveConfig, sessionMemoryHookOff, sidecarCheck, unsafeQueueModes } from "./config.js";
import { InputClosed, MissingGrant } from "./errors.js";
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
  sessionMemoryHookOff: boolean;
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
  const sessionHookOff = sessionMemoryHookOff(deps.cliConfig);
  if (!sessionHookOff) problems.push("hooks.internal.entries.session-memory.enabled is not false");

  let cfg: LumberroomConfig | null = null;
  try {
    cfg = resolveConfig(deps.pluginConfig);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  if (cfg?.ownerIds.length) {
    const unsafe = unsafeQueueModes(deps.cliConfig);
    const steers = (key: string, mode: string) =>
      `${key} is ${JSON.stringify(mode)}; a message from anyone in a shared chat can steer into an owner's run. Set it to "followup"`;
    if (unsafe.mode !== null) problems.push(steers("messages.queue.mode", unsafe.mode));
    if (unsafe.drop !== null) {
      problems.push(
        `messages.queue.drop is ${JSON.stringify(unsafe.drop)}; dropped messages from anyone fold into one turn that can carry an owner's identity. Set it to "old"`,
      );
    }
    for (const { channel, mode } of unsafe.byChannel) problems.push(steers(`messages.queue.byChannel.${channel}`, mode));
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
    sessionMemoryHookOff: sessionHookOff,
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
    io.print(`session-memory hook is off: ${sessionHookOff}`);
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

/** Reads one line with the TTY in raw mode so nothing echoes. No readline may be open meanwhile. */
function readSecret(question: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    output.write(question.endsWith(" ") ? question : `${question} `);
    let typed = "";
    const finish = (settle: () => void) => {
      input.setRawMode(false);
      input.removeListener("data", onData);
      input.pause();
      settle();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          output.write("\n");
          return finish(() => resolvePromise(typed));
        }
        if (ch === "\u0003") return finish(() => reject(new Error("sign-in cancelled")));
        if (ch === "\u007f" || ch === "\b") {
          typed = typed.slice(0, -1);
          continue;
        }
        typed += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export interface ClosableCliIo extends CliIo {
  /** Closes any open readline interface and hands the terminal back. */
  close(): void;
}

interface LineQueue {
  /** The next line, or null once cancel runs. Rejects with InputClosed when stdin ends first. */
  take(): { line: Promise<string | null>; cancel(): void };
  close(): void;
}

/**
 * Piped stdin delivers every line at once, before the questions that want them, and readline's
 * question() drops a line nobody is waiting for. One 'line' listener queues them instead.
 * terminal: false, so nothing read here is echoed to a TTY stdout.
 */
function pipedLineQueue(input: NodeJS.ReadableStream): LineQueue {
  const reader = createLineReader({ input, terminal: false, crlfDelay: Infinity });
  const buffered: string[] = [];
  const waiters: Array<{ resolve(line: string | null): void; reject(err: Error): void }> = [];
  let ended = false;
  reader.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else buffered.push(line);
  });
  reader.on("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new InputClosed());
  });
  return {
    take() {
      if (buffered.length) return { line: Promise.resolve(buffered.shift()!), cancel() {} };
      if (ended) return { line: Promise.reject(new InputClosed()), cancel() {} };
      let waiter!: (typeof waiters)[number];
      const line = new Promise<string | null>((resolve, reject) => {
        waiter = { resolve, reject };
        waiters.push(waiter);
      });
      return {
        line,
        cancel() {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          waiter.resolve(null);
        },
      };
    },
    close: () => reader.close(),
  };
}

/** Pasted lines from the queue. return() cancels a pending read, so the line goes to the next question. */
function queuedPastes(queue: LineQueue): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      let pending: ReturnType<LineQueue["take"]> | null = null;
      return {
        async next(): Promise<IteratorResult<string>> {
          if (done) return { done: true, value: undefined };
          const read = (pending = queue.take());
          try {
            const line = await read.line;
            if (line === null) return { done: true, value: undefined };
            return { done: false, value: line };
          } catch (err) {
            if (!(err instanceof InputClosed)) throw err;
            done = true;
            return { done: true, value: undefined };
          } finally {
            if (pending === read) pending = null;
          }
        },
        async return(): Promise<IteratorResult<string>> {
          done = true;
          pending?.cancel();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Piped stdin reads through pipedLineQueue. A TTY uses
 * node:readline/promises over stdin and stdout, opened on first use. A terminal-mode interface puts
 * stdin in raw mode and echoes keystrokes, so none may exist at register time (the gateway would
 * lose Ctrl-C) or while askSecret reads.
 */
export function createCliIo(): ClosableCliIo {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) return createPipedCliIo(input, output);
  let rl: Interface | null = null;
  const open = (): Interface => {
    if (rl) return rl;
    const opened = createInterface({ input, output });
    opened.once("close", () => {
      if (rl === opened) rl = null;
    });
    rl = opened;
    return opened;
  };
  const release = () => {
    rl?.close();
    rl = null;
  };
  const ask = async (question: string, fallback?: string) => {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await open().question(`${question}${suffix} `)).trim();
    return answer || (fallback ?? "");
  };
  return {
    print(line) {
      output.write(`${line}\n`);
    },
    ask,
    async askSecret(question) {
      if (typeof input.setRawMode !== "function") return (await open().question(question.endsWith(" ") ? question : `${question} `)).trim();
      release();
      return readSecret(question, input, output);
    },
    pastedLines(): AsyncIterable<string> {
      return open();
    },
    close: release,
  };
}

function createPipedCliIo(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): ClosableCliIo {
  let queue: LineQueue | null = null;
  const lines = (): LineQueue => (queue ??= pipedLineQueue(input));
  const read = async (prompt: string): Promise<string> => {
    output.write(prompt.endsWith(" ") ? prompt : `${prompt} `);
    const line = await lines().take().line;
    output.write("\n");
    return (line ?? "").trim();
  };
  return {
    print(line) {
      output.write(`${line}\n`);
    },
    async ask(question, fallback) {
      const answer = await read(`${question}${fallback ? ` [${fallback}]` : ""}`);
      return answer || (fallback ?? "");
    },
    askSecret: (question) => read(question),
    pastedLines: () => queuedPastes(lines()),
    close() {
      queue?.close();
      queue = null;
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

export type CliRegistrationDeps = Omit<CliDeps, "cliConfig" | "workspaceDir" | "io"> & {
  /** Called once per action, never at register time; the action closes it before returning. */
  makeIo(): ClosableCliIo;
};

export function registerLumberroomCli(api: OpenClawPluginApi, deps: CliRegistrationDeps): void {
  api.registerCli(
    (ctx) => {
      const { makeIo, ...rest } = deps;
      const withDeps = async (run: (full: CliDeps) => Promise<number>): Promise<void> => {
        const io = makeIo();
        try {
          process.exitCode = await run({
            ...rest,
            io,
            pluginConfig: await resolveTokenRef(deps.pluginConfig, ctx.config ?? {}),
            cliConfig: (ctx.config ?? {}) as unknown as Record<string, unknown>,
            workspaceDir: ctx.workspaceDir,
          });
        } catch (err) {
          if (!(err instanceof InputClosed)) throw err;
          io.print(err.message);
          process.exitCode = 1;
        } finally {
          io.close();
        }
      };

      const root = ctx.program.command("lumberroom").description("Set up, sign in to and import into lumberroom");

      root
        .command("setup")
        .description("Interactive setup")
        .action(async () => {
          await withDeps((full) => runSetup(full));
        });

      root
        .command("login")
        .description("Sign in with OAuth")
        .option("--no-browser", "print the sign-in URL instead of opening a browser")
        .action(async (opts: { browser?: boolean }) => {
          await withDeps((full) => runLoginCommand(full, { browser: opts.browser !== false }));
        });

      root
        .command("logout")
        .description("Sign out and delete the stored OAuth tokens")
        .action(async () => {
          await withDeps((full) => runLogoutCommand(full));
        });

      root
        .command("status")
        .description("Report reachability, sign-in and slot ownership")
        .option("--json", "print one JSON object")
        .action(async (opts: { json?: boolean }) => {
          await withDeps((full) => runStatusCommand(full, { json: opts.json === true }));
        });

      root
        .command("import")
        .description("Send MEMORY.md, USER.md and memory/*.md to the review queue")
        .option("--dry-run", "print entries and namespaces without posting")
        .option("--workspace <dir>", "the workspace to read from")
        .action(async (opts: { dryRun?: boolean; workspace?: string }) => {
          await withDeps((full) => runImportCommand(full, { dryRun: opts.dryRun === true, workspace: opts.workspace }));
        });
    },
    { descriptors: [{ name: "lumberroom", description: "Set up, sign in to and import into lumberroom", hasSubcommands: true }] },
  );
}
