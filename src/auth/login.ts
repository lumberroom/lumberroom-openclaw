import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { LoginFailed } from "../errors.js";
import type { LumberroomConfig } from "../types.js";
import { withFence } from "./fence.js";
import { TokenStore, tokenPaths, type StoredDiscovery } from "./store.js";

export interface LoginIo {
  print(line: string): void;
  openBrowser(url: string): Promise<void>;
  pastedLines(): AsyncIterable<string>;
}

export interface LoginOptions {
  stateDir: string;
  openBrowser: boolean;
  io: LoginIo;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export const CLIENT_NAME = "OpenClaw (lumberroom)";
const CALLBACK_TIMEOUT_MS = 300_000;
const URL_HEADER = "Open this URL to sign in:";

/** A redirect with neither a code nor an error: a stray request or a partial paste. Worth another try. */
class NoCode extends LoginFailed {}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Throws LoginFailed. */
export function parseRedirect(raw: string): { code: string; state: string | null } {
  const text = raw.trim();
  let query: string;
  try {
    query = new URL(text).search.slice(1);
  } catch {
    // The owner pasted only the query string.
    query = text.startsWith("?") ? text.slice(1) : text;
  }
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) {
    const detail = params.get("error_description");
    throw new LoginFailed(`the authorization server refused the sign-in: ${error}${detail ? ` (${detail})` : ""}`);
  }
  const code = params.get("code");
  if (!code) throw new NoCode("the redirect URL carries no code= parameter; paste the full address the browser landed on");
  return { code, state: params.get("state") };
}

/** One redirect, delivered by whichever of the loopback listener and a pasted line gets there first. */
class Redirect {
  settled = false;
  readonly promise: Promise<{ code: string; state: string | null }>;
  private done!: (v: { code: string; state: string | null }) => void;
  private fail!: (e: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.done = resolve;
      this.fail = reject;
    });
    this.promise.catch(() => undefined);
  }

  resolve(v: { code: string; state: string | null }): void {
    if (this.settled) return;
    this.settled = true;
    this.done(v);
  }

  reject(e: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.fail(e);
  }

  async wait(ms: number): Promise<{ code: string; state: string | null }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LoginFailed(`timed out after ${Math.round(ms / 1000)} seconds waiting for the browser to return or for a pasted URL`)),
        ms,
      );
    });
    try {
      return await Promise.race([this.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function listen(port: number, redirect: Redirect): Promise<Server | null> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    let status = 200;
    let page = "lumberroom received the sign-in. You can close this tab.";
    try {
      redirect.resolve(parseRedirect(url.href));
    } catch (e) {
      status = 400;
      page = e instanceof NoCode ? `Sign-in did not complete: ${e.message}` : `Sign-in failed: ${reason(e)}`;
      if (!(e instanceof NoCode)) redirect.reject(e);
    }
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end(page);
  });
  return new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  const closed = new Promise<void>((r) => server.close(() => r()));
  // The browser's keep-alive socket would hold the port past the sign-in.
  server.closeAllConnections();
  await closed;
}

/** Feeds pasted lines to the redirect until one parses. Returns a stop function. */
function readPastes(io: LoginIo, redirect: Redirect): () => void {
  const lines = io.pastedLines()[Symbol.asyncIterator]();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped && !redirect.settled) {
        const next = await lines.next();
        if (next.done || stopped || redirect.settled) return;
        if (!next.value.trim()) continue;
        try {
          redirect.resolve(parseRedirect(next.value));
        } catch (e) {
          if (e instanceof NoCode) io.print(e.message);
          else redirect.reject(e);
        }
      }
    } catch {
      // stdin closed or failed; the loopback listener may still deliver.
    }
  })();
  return () => {
    stopped = true;
    void Promise.resolve(lines.return?.()).catch(() => undefined);
  };
}

/**
 * What the SDK's auth() drives. tokens() returns nothing, so sign-in always runs the browser flow and
 * never refreshes: an owner signing in again usually wants a different consent, and a refresh here
 * would be a grant outside the fence.
 */
class SignInProvider implements OAuthClientProvider {
  readonly stateValue = randomBytes(32).toString("base64url");
  client: OAuthClientInformationFull | undefined;
  discovery: StoredDiscovery | undefined;
  private verifier = "";

  constructor(
    private readonly redirect: string,
    stored: OAuthClientInformationFull | null,
    private readonly io: LoginIo,
    private readonly browser: boolean,
    private readonly persist: (tokens: OAuthTokens) => Promise<void>,
  ) {
    // A DCR client registers one exact redirect URI, so a changed callback port needs a new one.
    if (stored?.redirect_uris.includes(redirect)) this.client = stored;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationFull | undefined {
    return this.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.client = { ...this.clientMetadata, ...info };
  }

  tokens(): undefined {
    return undefined;
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.persist(tokens);
  }

  redirectToAuthorization(url: URL): void {
    this.io.print(URL_HEADER);
    this.io.print(url.href);
    // A browser that fails to open leaves the printed URL and the paste path.
    if (this.browser) void this.io.openBrowser(url.href).catch(() => undefined);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = {
      authorizationServerUrl: state.authorizationServerUrl,
      ...(state.authorizationServerMetadata ? { authorizationServerMetadata: state.authorizationServerMetadata } : {}),
      ...(state.resourceMetadata ? { resourceMetadata: state.resourceMetadata } : {}),
    };
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

/** Throws LoginFailed. */
export async function login(cfg: LumberroomConfig, opts: LoginOptions): Promise<void> {
  if (cfg.auth !== "oauth") throw new LoginFailed("login applies to auth oauth, and this config sets auth token");
  const { file, lock } = tokenPaths(opts.stateDir);
  const store = new TokenStore(file, cfg.mcpUrl);
  const redirectUrl = `http://127.0.0.1:${cfg.oauthCallbackPort}/callback`;
  const redirect = new Redirect();
  // Bound before anything prints, so a fast browser cannot beat the listener.
  const server = await listen(cfg.oauthCallbackPort, redirect);
  if (!server) {
    opts.io.print(`Port ${cfg.oauthCallbackPort} is busy, so the browser cannot hand the sign-in back here. Paste the address the browser lands on instead.`);
  }

  const provider: SignInProvider = new SignInProvider(redirectUrl, store.read().clientInformation, opts.io, opts.openBrowser, (tokens) =>
    // Under the fence, so a peer's refresh cannot write its pair over this one.
    withFence(lock, async () => {
      const ttl = tokens.expires_in;
      store.write({
        tokens,
        expiresAt: typeof ttl === "number" && Number.isFinite(ttl) ? Date.now() + ttl * 1000 : null,
        clientInformation: provider.client ?? null,
        discovery: provider.discovery ?? null,
        resource: provider.discovery?.resourceMetadata?.resource ?? null,
        refreshStartedAt: null,
      });
    }),
  );
  const run = async (authorizationCode?: string) => {
    try {
      return await auth(provider, { serverUrl: cfg.mcpUrl, fetchFn: opts.fetch, ...(authorizationCode ? { authorizationCode } : {}) });
    } catch (e) {
      throw e instanceof LoginFailed ? e : new LoginFailed(`sign-in failed: ${reason(e)}`);
    }
  };

  let stopPastes: (() => void) | null = null;
  try {
    if ((await run()) === "AUTHORIZED") return;
    stopPastes = readPastes(opts.io, redirect);
    const got = await redirect.wait(opts.timeoutMs ?? CALLBACK_TIMEOUT_MS);
    if (got.state !== provider.stateValue) {
      throw new LoginFailed("the redirect's state does not match this sign-in; run openclaw lumberroom login again and use the newest URL");
    }
    await run(got.code);
  } finally {
    stopPastes?.();
    await closeServer(server);
  }
}

export async function logout(cfg: LumberroomConfig, stateDir: string): Promise<boolean> {
  const { file, lock } = tokenPaths(stateDir);
  if (!existsSync(file)) return false;
  // A peer mid-refresh writes its rotated pair back when it finishes, which would undo a delete that
  // did not wait for it.
  return withFence(lock, async () => new TokenStore(file, cfg.mcpUrl).clear());
}
