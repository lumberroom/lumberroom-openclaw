import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import lockfile from "proper-lockfile";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withFence, withFenceSync } from "../../src/auth/fence.js";
import { createOAuthAuth } from "../../src/auth/oauth.js";
import { TokenStore, tokenPaths } from "../../src/auth/store.js";
import { resolveConfig } from "../../src/config.js";
import { FenceTimeout } from "../../src/errors.js";
import type { LumberroomConfig } from "../../src/types.js";
import { startFakeEngine, type FakeEngine } from "../fakes/engine.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = join(ROOT, "test/helpers/refresh-child.mjs");

let stateDir = "";
let lock = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lr-fence-"));
  lock = tokenPaths(stateDir).lock;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("withFence", () => {
  it("a second holder waits until the first releases", async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withFence(lock, async () => {
      order.push("first in");
      await gate.promise;
      order.push("first out");
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = withFence(lock, async () => {
      order.push("second in");
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["first in"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("the lock is released when fn throws", async () => {
    await expect(withFence(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
    await expect(withFence(lock, async () => "again", { timeoutMs: 500 })).resolves.toBe("again");
  });

  it("a lock held past the timeout is FenceTimeout", async () => {
    const gate = deferred();
    const holder = withFence(lock, () => gate.promise);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await expect(withFence(lock, async () => "never", { timeoutMs: 500 })).rejects.toBeInstanceOf(FenceTimeout);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    gate.resolve();
    await holder;
  });

  it("compromised reports a lock proper-lockfile gave up on", async () => {
    let fire: ((err: Error) => void) | undefined;
    const real = lockfile.lock.bind(lockfile);
    vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
      fire = options?.onCompromised;
      return real(file, options);
    });
    const seen = await withFence(lock, async (fence) => {
      const before = fence.compromised();
      expect(() => fire!(Object.assign(new Error("stolen"), { code: "ECOMPROMISED" }))).not.toThrow();
      return [before, fence.compromised()];
    });
    expect(seen).toEqual([false, true]);
  });
});

describe("withFenceSync", () => {
  it("waits for a lock another process holds, then runs fn and releases", async () => {
    mkdirSync(join(stateDir, "lumberroom"), { recursive: true });
    // A peer that holds the lock the way proper-lockfile does: a directory it removes when done.
    const peer = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.mkdirSync(${JSON.stringify(lock)});
      process.stdout.write("held\\n");
      setTimeout(() => fs.rmdirSync(${JSON.stringify(lock)}), 400);
    `]);
    await new Promise<void>((resolve) => peer.stdout.once("data", () => resolve()));
    const started = Date.now();
    const out = withFenceSync(lock, () => existsSync(lock));
    expect(out).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(existsSync(lock)).toBe(false);
    await new Promise((r) => peer.once("exit", r));
  });

  it("the lock is released when fn throws", () => {
    expect(() => withFenceSync(lock, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });
});

async function signIn(e: FakeEngine, cfg: LumberroomConfig, at: number): Promise<void> {
  const redirectUrl = "http://127.0.0.1:47632/callback";
  const info = await discoverOAuthServerInfo(cfg.mcpUrl);
  const metadata = info.authorizationServerMetadata;
  const client = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: { client_name: "fence test", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, { metadata, clientInformation: client, redirectUrl, resource: cfg.mcpUrl });
  const code = new URL(await e.authorize(authorizationUrl.href)).searchParams.get("code")!;
  const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: redirectUrl, resource: cfg.mcpUrl });
  const store = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl);
  store.write({ clientInformation: client, discovery: info, resource: cfg.mcpUrl });
  store.saveTokens(tokens, at);
}

function child(baseUrl: string): { ready: Promise<void>; done: Promise<string> } {
  const proc = spawn(process.execPath, [CHILD, baseUrl, stateDir], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes("ready\n")) markReady();
  });
  const done = new Promise<string>((resolve) => proc.once("exit", () => resolve(out.replace("ready\n", "").trim())));
  return { ready, done };
}

describe("the refresh across processes", () => {
  // The children run dist/. A stale build would test old code and pass for the wrong reason.
  beforeAll(() => {
    for (const name of ["auth/oauth", "auth/fence", "auth/store"]) {
      const built = join(ROOT, `dist/${name}.js`);
      if (!existsSync(built) || statSync(built).mtimeMs < statSync(join(ROOT, `src/${name}.ts`)).mtimeMs) {
        throw new Error(`dist/${name}.js is older than src/${name}.ts; run npm run build first`);
      }
    }
  });

  it("two processes past expiry make one refresh grant and no replay", async () => {
    const e = await startFakeEngine({ oauth: { accessTtlSec: 1, autoConsent: true } });
    try {
      const cfg = resolveConfig({ baseUrl: e.url });
      await signIn(e, cfg, Date.now());
      await new Promise((r) => setTimeout(r, 1100));
      // The test holds the fence until both children have read the expired pair and queued on it.
      // Without the hold one child could finish before the other starts, and with a one-second
      // lifetime the second would then refresh its successor's pair for a legitimate second grant.
      let release!: () => void;
      const held = withFence(lock, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 50));
      const a = child(e.url);
      const b = child(e.url);
      await Promise.all([a.ready, b.ready]);
      await new Promise((r) => setTimeout(r, 500));
      release();
      await held;
      const [outA, outB] = await Promise.all([a.done, b.done]);

      const onDisk = new TokenStore(tokenPaths(stateDir).file, cfg.mcpUrl).read().tokens!;
      const expected = `ok ${createHash("sha256").update(`Bearer ${onDisk.access_token}`).digest("hex").slice(0, 16)}`;
      expect([outA, outB]).toEqual([expected, expected]);
      expect(e.refreshGrants).toBe(1);
      expect(e.replays).toBe(0);
    } finally {
      await e.close();
    }
  });

  it("a fence held past the timeout is FenceTimeout", async () => {
    const e = await startFakeEngine({ oauth: { accessTtlSec: 3600, autoConsent: true } });
    try {
      const cfg = resolveConfig({ baseUrl: e.url });
      const signedAt = Date.now();
      await signIn(e, cfg, signedAt);
      const auth = createOAuthAuth(cfg, { stateDir, now: () => signedAt + 3_601_000, fenceTimeoutMs: 500 });
      let release!: () => void;
      const held = withFence(lock, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 50));
      await expect(auth.authorize(AbortSignal.timeout(10_000))).rejects.toBeInstanceOf(FenceTimeout);
      release();
      await held;
      expect(e.requests.filter((r) => r.path === "/oauth/token")).toHaveLength(1); // the sign-in's code exchange
    } finally {
      await e.close();
    }
  });
});
