import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFence } from "../../src/auth/fence.js";
import { CLIENT_NAME, login, logout, parseRedirect, type LoginIo } from "../../src/auth/login.js";
import { TokenStore, tokenPaths } from "../../src/auth/store.js";
import { resolveConfig } from "../../src/config.js";
import { LoginFailed } from "../../src/errors.js";
import type { LumberroomConfig } from "../../src/types.js";
import { startFakeEngine, type FakeEngine } from "../fakes/engine.js";

const HEADER = "Open this URL to sign in:";

let stateDir = "";
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lr-login-"));
});

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  rmSync(stateDir, { recursive: true, force: true });
});

async function engine(autoConsent = true): Promise<FakeEngine> {
  const e = await startFakeEngine({ oauth: { accessTtlSec: 3600, autoConsent } });
  cleanup.push(() => e.close());
  return e;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function occupy(port: number): Promise<Server> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
  return s;
}

async function config(e: FakeEngine): Promise<LumberroomConfig> {
  return resolveConfig({ baseUrl: e.url, oauthCallbackPort: await freePort() });
}

interface FakeIo {
  io: LoginIo;
  lines: string[];
  opened: string[];
}

// The printed URL, handed to a pretend browser or pasted back as the redirect it lands on.
function fakeIo(opts: { browser?: (url: string) => Promise<void>; paste?: (url: string) => Promise<string> }): FakeIo {
  const lines: string[] = [];
  const opened: string[] = [];
  let printed!: (url: string) => void;
  const url = new Promise<string>((r) => (printed = r));
  const io: LoginIo = {
    print(line) {
      if (lines.at(-1) === HEADER) printed(line);
      lines.push(line);
    },
    async openBrowser(target) {
      opened.push(target);
      await opts.browser?.(target);
    },
    async *pastedLines() {
      if (!opts.paste) return;
      yield await opts.paste(await url);
    },
  };
  return { io, lines, opened };
}

function viaLoopback(e: FakeEngine): (url: string) => Promise<void> {
  return async (url) => {
    const redirect = await e.authorize(url);
    await fetch(redirect);
  };
}

function viaPaste(e: FakeEngine, edit: (redirect: URL) => void = () => {}): (url: string) => Promise<string> {
  return async (url) => {
    const redirect = new URL(await e.authorize(url));
    edit(redirect);
    return redirect.href;
  };
}

function count(e: FakeEngine, path: string, grant?: string): number {
  return e.requests.filter((r) => r.path === path && (!grant || (r.body as Record<string, string> | null)?.grant_type === grant)).length;
}

describe("parseRedirect", () => {
  it("reads the code and state from a full redirect URL or its bare query", () => {
    expect(parseRedirect(" http://127.0.0.1:47632/callback?code=abc&state=s1 \n")).toEqual({ code: "abc", state: "s1" });
    expect(parseRedirect("code=abc")).toEqual({ code: "abc", state: null });
  });

  it("an error redirect carries the server's reason", () => {
    expect(() => parseRedirect("http://127.0.0.1:1/callback?error=access_denied&error_description=the%20owner%20declined&state=s"))
      .toThrow(/access_denied.*the owner declined/);
  });

  it("a URL without a code is refused", () => {
    expect(() => parseRedirect("http://127.0.0.1:1/callback?state=s")).toThrow(LoginFailed);
  });
});

describe("login", () => {
  it("the loopback callback completes sign-in", async () => {
    const e = await engine();
    const cfg = await config(e);
    const fake = fakeIo({ browser: viaLoopback(e) });
    await login(cfg, { stateDir, openBrowser: true, io: fake.io });

    const idx = fake.lines.indexOf(HEADER);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(fake.lines[idx + 1]).toMatch(new RegExp(`^${e.url}/oauth/authorize\\?`));
    expect(fake.opened).toEqual([fake.lines[idx + 1]]);
    const saved = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read();
    expect(saved.tokens!.refresh_token).toBeTruthy();
    expect(saved.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(saved.resource).toBe(cfg.mcpUrl);
    expect(saved.discovery!.authorizationServerUrl).toBe(e.url);
    expect(saved.clientInformation).toMatchObject({ client_name: CLIENT_NAME, redirect_uris: [`http://127.0.0.1:${cfg.oauthCallbackPort}/callback`] });
    expect(saved.refreshStartedAt).toBeNull();
    const register = e.requests.find((r) => r.path === "/oauth/register")!;
    expect(register.body).toMatchObject({
      client_name: "OpenClaw (lumberroom)",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    // The listener is gone once sign-in returns.
    await occupy(cfg.oauthCallbackPort);
  });

  it("the state parameter is 32 random bytes in base64url", async () => {
    const e = await engine();
    const cfg = await config(e);
    let state = "";
    await login(cfg, {
      stateDir, openBrowser: false,
      io: fakeIo({ paste: viaPaste(e, (r) => (state = r.searchParams.get("state")!)) }).io,
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("a pasted redirect URL completes sign-in when the port is busy", async () => {
    const e = await engine();
    const cfg = await config(e);
    await occupy(cfg.oauthCallbackPort);
    const fake = fakeIo({ paste: viaPaste(e) });
    await login(cfg, { stateDir, openBrowser: false, io: fake.io });
    expect(fake.lines.some((l) => l.includes(`Port ${cfg.oauthCallbackPort} is busy`))).toBe(true);
    expect(fake.opened).toEqual([]);
    expect(new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens).not.toBeNull();
  });

  it("a state mismatch fails sign-in", async () => {
    const e = await engine();
    const cfg = await config(e);
    const fake = fakeIo({ paste: viaPaste(e, (r) => r.searchParams.set("state", "forged")) });
    await expect(login(cfg, { stateDir, openBrowser: false, io: fake.io })).rejects.toThrow(/state/);
    expect(count(e, "/oauth/token")).toBe(0);
    expect(new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens).toBeNull();
  });

  it("an error redirect fails with the server's reason", async () => {
    const e = await engine(false);
    const cfg = await config(e);
    const failure = login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    await expect(failure).rejects.toBeInstanceOf(LoginFailed);
    await expect(failure).rejects.toThrow(/access_denied.*the owner declined/);
  });

  it("a sign-in nobody completes times out", async () => {
    const e = await engine();
    const cfg = await config(e);
    await expect(login(cfg, { stateDir, openBrowser: false, io: fakeIo({}).io, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    await occupy(cfg.oauthCallbackPort);
  });

  it("login runs the browser flow even with a valid stored pair", async () => {
    const e = await engine();
    const cfg = await config(e);
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    const first = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens!;
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    const second = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens!;
    expect(second.access_token).not.toBe(first.access_token);
    expect(count(e, "/oauth/authorize")).toBe(2);
    expect(count(e, "/oauth/token", "authorization_code")).toBe(2);
    expect(count(e, "/oauth/token", "refresh_token")).toBe(0);
  });

  it("login reuses the stored DCR client", async () => {
    const e = await engine();
    const cfg = await config(e);
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    const client = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().clientInformation!.client_id;
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    expect(count(e, "/oauth/register")).toBe(1);
    expect(new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().clientInformation!.client_id).toBe(client);
  });

  it("a stored client registered for another callback port is not reused", async () => {
    const e = await engine();
    const cfg = await config(e);
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    const moved = { ...cfg, oauthCallbackPort: await freePort() };
    await login(moved, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    expect(count(e, "/oauth/register")).toBe(2);
  });

  it("the new pair waits for a refresh in flight before it lands", async () => {
    const e = await engine();
    const cfg = await config(e);
    let release!: () => void;
    const held = withFence(tokenPaths(stateDir).lock, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    let done = false;
    const signing = login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io }).then(() => (done = true));
    const exchanged = () => count(e, "/oauth/token", "authorization_code") === 1;
    for (let i = 0; i < 100 && !exchanged(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(exchanged()).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(existsSync(tokenPaths(stateDir).file)).toBe(false);
    release();
    await held;
    await signing;
    expect(new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens).not.toBeNull();
  });

  it("login refuses in token mode", async () => {
    const e = await engine();
    const cfg = resolveConfig({ baseUrl: e.url, auth: "token", token: "t" });
    await expect(login(cfg, { stateDir, openBrowser: false, io: fakeIo({}).io })).rejects.toBeInstanceOf(LoginFailed);
    expect(e.requests).toEqual([]);
  });
});

describe("logout", () => {
  it("logout deletes the file under the fence", async () => {
    const e = await engine();
    const cfg = await config(e);
    expect(await logout(cfg, stateDir)).toBe(false);
    await login(cfg, { stateDir, openBrowser: false, io: fakeIo({ paste: viaPaste(e) }).io });
    let release!: () => void;
    const held = withFence(tokenPaths(stateDir).lock, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    let result: boolean | undefined;
    const out = logout(cfg, stateDir).then((v) => (result = v));
    await new Promise((r) => setTimeout(r, 300));
    expect(result).toBeUndefined();
    expect(existsSync(tokenPaths(stateDir).file)).toBe(true);
    release();
    await held;
    await out;
    expect(result).toBe(true);
    expect(existsSync(tokenPaths(stateDir).file)).toBe(false);
  });
});
