import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFence } from "../../src/auth/fence.js";
import { createOAuthAuth, REFRESH_SKEW_MS } from "../../src/auth/oauth.js";
import { TokenStore, tokenPaths } from "../../src/auth/store.js";
import { createTokenAuth } from "../../src/auth/token.js";
import { resolveConfig } from "../../src/config.js";
import { LoginRequired, RefreshUnavailable, TokenSaveFailed } from "../../src/errors.js";
import type { LumberroomConfig } from "../../src/types.js";
import { startFakeEngine, type FakeEngine } from "../fakes/engine.js";

const REDIRECT = "http://127.0.0.1:47632/callback";
const T0 = 1_900_000_000_000;

let stateDir = "";
let clock = T0;
let e: FakeEngine;
let cfg: LumberroomConfig;
let store: TokenStore;
const engines: FakeEngine[] = [];

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "lr-oauth-"));
  clock = T0;
  e = await startFakeEngine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
  engines.push(e);
  cfg = resolveConfig({ baseUrl: e.url });
  store = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (engines.length) await engines.pop()!.close().catch(() => undefined);
  rmSync(stateDir, { recursive: true, force: true });
});

function handle(opts: { fenceTimeoutMs?: number; refreshTimeoutMs?: number } = {}) {
  return createOAuthAuth(cfg, { stateDir, now: () => clock, ...opts });
}

function deadline(ms = 10_000): AbortSignal {
  return AbortSignal.timeout(ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A sign-in the way a peer process or `openclaw lumberroom login` leaves it on disk.
async function signIn(): Promise<OAuthTokens> {
  const info = await discoverOAuthServerInfo(cfg.mcpUrl);
  const metadata = info.authorizationServerMetadata;
  const client = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: {
      client_name: "oauth test",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata, clientInformation: client, redirectUrl: REDIRECT, resource: cfg.mcpUrl,
  });
  const code = new URL(await e.authorize(authorizationUrl.href)).searchParams.get("code")!;
  const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
    metadata, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: REDIRECT, resource: cfg.mcpUrl,
  });
  store.write({ clientInformation: client, discovery: info, resource: cfg.mcpUrl, refreshStartedAt: null });
  store.saveTokens(tokens, clock);
  return tokens;
}

function expiresAt(): number {
  return store.read().expiresAt!;
}

function onDisk(): OAuthTokens | null {
  return store.read().tokens;
}

// Every refresh grant that reached the token route. The fake's refreshGrants skips a request a
// queued status answered, and those count here: the plugin sent them.
function grants(): number {
  return e.requests.filter((r) => r.path === "/oauth/token" && (r.body as Record<string, string> | null)?.grant_type === "refresh_token").length;
}

const realRename = fs.renameSync;

// A refresh renames twice: the in-flight marker, then the rotated pair. `skip` lets the first ones through.
function refuseRenames(skip: number, times = Infinity): void {
  let calls = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    calls += 1;
    if (calls > skip && calls <= skip + times) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return realRename(from, to);
  });
}

describe("OAuth guard", () => {
  it("a fresh pair authorizes without a grant", async () => {
    const pair = await signIn();
    const auth = handle();
    expect(auth.mode).toBe("oauth");
    expect(await auth.authorize(deadline())).toBe(`Bearer ${pair.access_token}`);
    expect(auth.status()).toBe("signed_in");
    expect(grants()).toBe(0);
  });

  it("a pair inside the 60 second window refreshes once for many concurrent callers", async () => {
    const pair = await signIn();
    clock = expiresAt() - REFRESH_SKEW_MS / 2;
    const auth = handle();
    const all = await Promise.all(Array.from({ length: 10 }, () => auth.authorize(deadline())));
    expect(new Set(all).size).toBe(1);
    expect(all[0]).not.toBe(`Bearer ${pair.access_token}`);
    expect(all[0]).toBe(`Bearer ${onDisk()!.access_token}`);
    expect(onDisk()!.refresh_token).not.toBe(pair.refresh_token);
    expect(grants()).toBe(1);
    expect(e.replays).toBe(0);
  });

  it("a missing expiresAt counts as due", async () => {
    await signIn();
    store.write({ expiresAt: null });
    await handle().authorize(deadline());
    expect(grants()).toBe(1);
  });

  it("a caller whose deadline passes mid-refresh does not cancel the refresh", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", delayMs: 800 });
    const started = Date.now();
    await expect(auth.authorize(deadline(100))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(700);
    await auth.settle(5000);
    const rotated = onDisk()!;
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);
    expect(store.read().refreshStartedAt).toBeNull();
    expect(await auth.authorize(deadline())).toBe(`Bearer ${rotated.access_token}`);
    expect(grants()).toBe(1);
    expect(e.replays).toBe(0);
  });

  it("a peer's refresh on disk is adopted without a grant", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    // The caller decides to refresh with the old token, then waits on the peer's fence.
    let release!: () => void;
    const peerHolds = withFence(tokenPaths(stateDir).lock, () => new Promise<void>((r) => (release = r)));
    await sleep(50);
    const pending = auth.authorize(deadline());
    await sleep(100);
    const info = store.read();
    const peer = await refreshAuthorization(info.discovery!.authorizationServerUrl, {
      metadata: info.discovery!.authorizationServerMetadata,
      clientInformation: info.clientInformation!,
      refreshToken: pair.refresh_token!,
      resource: cfg.mcpUrl,
    });
    store.saveTokens(peer, clock);
    release();
    await peerHolds;
    expect(await pending).toBe(`Bearer ${peer.access_token}`);
    expect(grants()).toBe(1);
    expect(e.replays).toBe(0);
  });

  it("a 4xx refresh latches login_required until the file changes", async () => {
    await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", status: 400, body: { error: "invalid_grant", error_description: "revoked" } });
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(auth.status()).toBe("refused");
    expect(grants()).toBe(1);
    expect(store.read().refreshStartedAt).toBeNull();

    const again = await signIn();
    expect(await auth.authorize(deadline())).toBe(`Bearer ${again.access_token}`);
    expect(auth.status()).toBe("signed_in");
  });

  it("a 5xx refresh inside the window proceeds with the live access token", async () => {
    const pair = await signIn();
    clock = expiresAt() - REFRESH_SKEW_MS / 2;
    e.next({ route: "token", status: 503 });
    expect(await handle().authorize(deadline())).toBe(`Bearer ${pair.access_token}`);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
    expect(store.read().refreshStartedAt).toBeNull();
    expect(grants()).toBe(1);
  });

  it("a 5xx refresh past expiry is RefreshUnavailable", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    e.next({ route: "token", status: 500 });
    await expect(handle().authorize(deadline())).rejects.toBeInstanceOf(RefreshUnavailable);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
  });

  it("a 503 whose body is an OAuth error is RefreshUnavailable and keeps the refresh token", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", status: 503, body: { error: "temporarily_unavailable", error_description: "restarting" } });
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(RefreshUnavailable);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
    expect(store.read().refreshStartedAt).toBeNull();
    await auth.authorize(deadline());
    expect(grants()).toBe(2);
    expect(e.replays).toBe(0);
  });

  it("a 400 whose body is unparseable latches login_required", async () => {
    await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", status: 400, body: "<html>bad request</html>" });
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(grants()).toBe(1);
  });

  it("a refresh sent with no answer drops the refresh token and reports login required", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", dropAfterBody: true });
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    const left = store.read();
    expect(left.tokens).toEqual({ access_token: pair.access_token, token_type: "Bearer", expires_in: 3600 });
    expect(left.refreshStartedAt).toBeNull();
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(auth.status()).toBe("expired_no_refresh");
    expect(grants()).toBe(1);
    expect(e.replays).toBe(0);
  });

  it("a refresh that times out after sending drops the refresh token", async () => {
    await signIn();
    clock = expiresAt() + 1000;
    e.next({ route: "token", delayMs: 1500 });
    await expect(handle({ refreshTimeoutMs: 300 }).authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(onDisk()!.refresh_token).toBeUndefined();
    expect(e.replays).toBe(0);
  });

  it("a refresh the engine never received keeps the refresh token", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    await e.close();
    await expect(handle().authorize(deadline())).rejects.toBeInstanceOf(RefreshUnavailable);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
    expect(store.read().refreshStartedAt).toBeNull();
  });

  it("a rotated pair the disk refused stays in memory and the spent token leaves the disk", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    refuseRenames(1, 1);
    const failure = auth.authorize(deadline());
    await expect(failure).rejects.toBeInstanceOf(TokenSaveFailed);
    await expect(failure).rejects.toMatchObject({ code: "ENOSPC" });
    expect(onDisk()).toEqual({ access_token: pair.access_token, token_type: "Bearer", expires_in: 3600 });
    expect(store.read().refreshStartedAt).toBeNull();
    expect(grants()).toBe(1);
  });

  it("a spent token the disk refused to rewrite leaves with the file", async () => {
    await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    refuseRenames(1);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(TokenSaveFailed);
    expect(fs.existsSync(tokenPaths(stateDir).file)).toBe(false);
    // Still refused: the pair stays in memory and nothing is presentable on disk.
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(TokenSaveFailed);
    expect(grants()).toBe(1);

    vi.mocked(fs.renameSync).mockRestore();
    const bearer = await auth.authorize(deadline());
    const saved = store.read();
    expect(bearer).toBe(`Bearer ${saved.tokens!.access_token}`);
    expect(saved.tokens!.refresh_token).toBeTruthy();
    expect(saved.clientInformation).not.toBeNull();
    expect(saved.discovery).not.toBeNull();
    expect(saved.resource).toBe(cfg.mcpUrl);
    expect(grants()).toBe(1);
  });

  it("the next authorize saves a pair the disk refused unless the file changed", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    refuseRenames(1, 1);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(TokenSaveFailed);
    vi.mocked(fs.renameSync).mockRestore();

    const bearer = await auth.authorize(deadline());
    const saved = onDisk()!;
    expect(bearer).toBe(`Bearer ${saved.access_token}`);
    expect(saved.access_token).not.toBe(pair.access_token);
    expect(saved.refresh_token).not.toBe(pair.refresh_token);
    expect(grants()).toBe(1);
    // The saved refresh token is the live one: the engine rotates it without calling it a replay.
    clock = expiresAt() + 1000;
    await auth.authorize(deadline());
    expect(grants()).toBe(2);
    expect(e.replays).toBe(0);

    // A sign-in that lands while a refused pair waits wins over it.
    clock = expiresAt() + 1000;
    refuseRenames(1, 1);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(TokenSaveFailed);
    vi.mocked(fs.renameSync).mockRestore();
    const fresh = await signIn();
    expect(await auth.authorize(deadline())).toBe(`Bearer ${fresh.access_token}`);
    expect(onDisk()).toEqual(fresh);
  });

  it("a refreshStartedAt marker from a dead holder drops the refresh token", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    store.write({ refreshStartedAt: clock - 5000 });
    await expect(handle().authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(onDisk()).toEqual({ access_token: pair.access_token, token_type: "Bearer", expires_in: 3600 });
    expect(store.read().refreshStartedAt).toBeNull();
    expect(grants()).toBe(0);
  });

  it("a compromised lock aborts a refresh that has not been sent", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const real = lockfile.lock.bind(lockfile);
    vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      const release = await real(file, options);
      options?.onCompromised?.(Object.assign(new Error("stolen"), { code: "ECOMPROMISED" }));
      return release;
    });
    await expect(handle().authorize(deadline())).rejects.toBeInstanceOf(RefreshUnavailable);
    expect(grants()).toBe(0);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
    expect(store.read().refreshStartedAt).toBeNull();
  });

  it("a 401 from the engine forces one refresh under the fence", async () => {
    await signIn();
    const auth = handle();
    const first = await auth.authorize(deadline());
    auth.rejected(first);
    const second = await auth.authorize(deadline());
    expect(second).not.toBe(first);
    expect(second).toBe(`Bearer ${onDisk()!.access_token}`);
    expect(grants()).toBe(1);
    // A late 401 for the header this process already replaced changes nothing.
    auth.rejected(first);
    expect(await auth.authorize(deadline())).toBe(second);
    expect(grants()).toBe(1);
    // A 401 for the pair that refresh produced is not worth another grant.
    auth.rejected(second);
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(grants()).toBe(1);
  });

  it("a sign-in in another process takes effect on the next authorize", async () => {
    const auth = handle();
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(auth.status()).toBe("signed_out");
    const pair = await signIn();
    expect(await auth.authorize(deadline())).toBe(`Bearer ${pair.access_token}`);
    expect(auth.status()).toBe("signed_in");
    store.clear();
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
  });

  it("settle waits for a refresh in flight up to its bound", async () => {
    const pair = await signIn();
    clock = expiresAt() + 1000;
    const auth = handle();
    e.next({ route: "token", delayMs: 600 });
    await expect(auth.authorize(deadline(50))).rejects.toThrow();
    let started = Date.now();
    await auth.settle(5000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(onDisk()!.refresh_token).not.toBe(pair.refresh_token);

    clock = expiresAt() + 1000;
    const before = onDisk()!.refresh_token;
    e.next({ route: "token", delayMs: 1500 });
    await expect(auth.authorize(deadline(50))).rejects.toThrow();
    started = Date.now();
    await auth.settle(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(onDisk()!.refresh_token).toBe(before);
    await auth.settle(5000);
    expect(onDisk()!.refresh_token).not.toBe(before);
    expect(e.replays).toBe(0);
  });

  it("a pair stored without discovery finds the authorization server and keeps what it found", async () => {
    await signIn();
    store.write({ discovery: null });
    clock = expiresAt() + 1000;
    await handle().authorize(deadline());
    expect(grants()).toBe(1);
    expect(store.read().discovery).toMatchObject({ authorizationServerUrl: e.url });
  });

  it("a pair stored without its client registration asks for a sign-in and sends nothing", async () => {
    const pair = await signIn();
    store.write({ clientInformation: null });
    clock = expiresAt() + 1000;
    const auth = handle();
    await expect(auth.authorize(deadline())).rejects.toBeInstanceOf(LoginRequired);
    expect(auth.status()).toBe("refused");
    expect(grants()).toBe(0);
    expect(onDisk()!.refresh_token).toBe(pair.refresh_token);
  });

  it("the refresh sends the resource sign-in stored", async () => {
    await signIn();
    clock = expiresAt() + 1000;
    await handle().authorize(deadline());
    const grant = e.requests.find((r) => r.path === "/oauth/token" && (r.body as Record<string, string>).grant_type === "refresh_token");
    expect(grant!.body).toMatchObject({ resource: cfg.mcpUrl });
  });
});

describe("token auth", () => {
  it("token auth returns the bearer and settles at once", async () => {
    const auth = createTokenAuth("lr_secret");
    expect(auth.mode).toBe("token");
    expect(await auth.authorize(deadline())).toBe("Bearer lr_secret");
    auth.rejected("Bearer lr_secret");
    expect(await auth.authorize(deadline())).toBe("Bearer lr_secret");
    const started = Date.now();
    await auth.settle(5000);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
