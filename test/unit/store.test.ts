import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore, tokenPaths } from "../../src/auth/store.js";

const MCP = "http://127.0.0.1:9/mcp";
const PAIR: OAuthTokens = { access_token: "at_1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt_1" };

let stateDir = "";
let file = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "lr-store-"));
  file = tokenPaths(stateDir).file;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

function signedIn(store: TokenStore): void {
  store.write({
    tokens: PAIR,
    expiresAt: 1_000_000,
    clientInformation: { client_id: "c1", redirect_uris: ["http://127.0.0.1:47632/callback"] },
    discovery: { authorizationServerUrl: "http://127.0.0.1:9" },
    resource: MCP,
  });
}

describe("TokenStore", () => {
  it("tokenPaths puts oauth.json and oauth.lock under <stateDir>/lumberroom", () => {
    expect(tokenPaths("/s")).toEqual({ file: "/s/lumberroom/oauth.json", lock: "/s/lumberroom/oauth.lock" });
  });

  it("a missing file reads as signed out", () => {
    const store = new TokenStore(file, MCP);
    expect(store.read()).toEqual({
      mcpUrl: MCP, tokens: null, expiresAt: null, clientInformation: null, discovery: null, resource: null, refreshStartedAt: null,
    });
    expect(store.version()).toBe(0n);
  });

  it("a corrupt file reads as signed out and stays on disk", () => {
    fs.mkdirSync(join(stateDir, "lumberroom"), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const store = new TokenStore(file, MCP);
    expect(store.read().tokens).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  it("a file whose tokens lack an access token reads as signed out", () => {
    fs.mkdirSync(join(stateDir, "lumberroom"), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpUrl: MCP, tokens: { refresh_token: "rt" } }));
    expect(new TokenStore(file, MCP).read().tokens).toBeNull();
  });

  it("a file for another mcpUrl reads as signed out", () => {
    signedIn(new TokenStore(file, "https://other.example/mcp"));
    const store = new TokenStore(file, MCP);
    expect(store.read().tokens).toBeNull();
    expect(store.read().clientInformation).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpUrl).toBe("https://other.example/mcp");
  });

  it("writes are 0600 in a 0700 directory", () => {
    // A cache writer may create the directory first with the default mode.
    fs.mkdirSync(join(stateDir, "lumberroom"), { mode: 0o755 });
    const store = new TokenStore(file, MCP);
    signedIn(store);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(stateDir, "lumberroom")).mode & 0o777).toBe(0o700);
    expect(store.read()).toMatchObject({ mcpUrl: MCP, tokens: PAIR, expiresAt: 1_000_000, resource: MCP });
  });

  it("a write that fails leaves the previous file intact", () => {
    const store = new TokenStore(file, MCP);
    signedIn(store);
    const before = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });
    expect(() => store.write({ tokens: { ...PAIR, access_token: "at_2" } })).toThrow(expect.objectContaining({ code: "ENOSPC" }));
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    // The temp file goes too, so a full disk does not fill up with half-written pairs.
    expect(fs.readdirSync(join(stateDir, "lumberroom"))).toEqual(["oauth.json"]);
  });

  it("version changes on every write", () => {
    const store = new TokenStore(file, MCP);
    signedIn(store);
    const seen = new Set<bigint>([store.version()]);
    for (let i = 0; i < 20; i++) {
      store.write({ refreshStartedAt: i });
      seen.add(store.version());
    }
    expect(seen.size).toBe(21);
  });

  it("write merges the patch into what is on disk", () => {
    const store = new TokenStore(file, MCP);
    signedIn(store);
    store.write({ refreshStartedAt: 42 });
    expect(store.read()).toMatchObject({ tokens: PAIR, refreshStartedAt: 42, clientInformation: { client_id: "c1" } });
  });

  it("saveTokens sets expiresAt from expires_in and clears refreshStartedAt", () => {
    const store = new TokenStore(file, MCP);
    signedIn(store);
    store.write({ refreshStartedAt: 5 });
    store.saveTokens({ ...PAIR, access_token: "at_2", expires_in: 60 }, 10_000);
    expect(store.read()).toMatchObject({ tokens: { access_token: "at_2" }, expiresAt: 70_000, refreshStartedAt: null });
    store.saveTokens({ access_token: "at_3", token_type: "Bearer" }, 10_000);
    expect(store.read().expiresAt).toBeNull();
  });

  it("dropRefreshToken keeps the access token", () => {
    const store = new TokenStore(file, MCP);
    signedIn(store);
    store.write({ refreshStartedAt: 7 });
    store.dropRefreshToken();
    const after = store.read();
    expect(after.tokens).toEqual({ access_token: "at_1", token_type: "Bearer", expires_in: 3600 });
    expect(after.expiresAt).toBe(1_000_000);
    expect(after.refreshStartedAt).toBeNull();
    expect(after.clientInformation).toMatchObject({ client_id: "c1" });
  });

  it("clear deletes the file and reports whether one existed", () => {
    const store = new TokenStore(file, MCP);
    expect(store.clear()).toBe(false);
    signedIn(store);
    expect(store.clear()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});
