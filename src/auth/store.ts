import { randomBytes } from "node:crypto";
// The default import is the mutable module object, which the tests spy on to make the disk refuse a write.
import fs from "node:fs";
import { dirname, join } from "node:path";
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type AuthorizationServerMetadata,
  type OAuthClientInformationFull,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredDiscovery {
  authorizationServerUrl: string;
  authorizationServerMetadata?: AuthorizationServerMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
}

export interface StoredOAuth {
  mcpUrl: string;
  tokens: OAuthTokens | null;
  expiresAt: number | null; // epoch ms; null counts as due
  clientInformation: OAuthClientInformationFull | null;
  discovery: StoredDiscovery | null;
  resource: string | null;
  refreshStartedAt: number | null; // set under the fence before a grant is sent
}

/** <stateDir>/lumberroom/oauth.json and oauth.lock. */
export function tokenPaths(stateDir: string): { file: string; lock: string } {
  const dir = join(stateDir, "lumberroom");
  return { file: join(dir, "oauth.json"), lock: join(dir, "oauth.lock") };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function discoveryOrNull(v: unknown): StoredDiscovery | null {
  if (!isRecord(v) || typeof v.authorizationServerUrl !== "string" || !v.authorizationServerUrl) return null;
  return {
    authorizationServerUrl: v.authorizationServerUrl,
    ...(isRecord(v.authorizationServerMetadata) ? { authorizationServerMetadata: v.authorizationServerMetadata as AuthorizationServerMetadata } : {}),
    ...(isRecord(v.resourceMetadata) ? { resourceMetadata: v.resourceMetadata as OAuthProtectedResourceMetadata } : {}),
  };
}

export class TokenStore {
  constructor(
    private readonly file: string,
    private readonly mcpUrl: string,
    opts?: { now?: () => number },
  ) {}

  /** Signed out for a missing or corrupt file, or one bound to another mcpUrl. Never throws. */
  read(): StoredOAuth {
    const empty: StoredOAuth = {
      mcpUrl: this.mcpUrl, tokens: null, expiresAt: null, clientInformation: null, discovery: null, resource: null, refreshStartedAt: null,
    };
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return empty;
    }
    // A file for another server reads as signed out, so a changed baseUrl never sends one server's
    // token to another. It stays on disk until a sign-in replaces it.
    if (!isRecord(data) || data.mcpUrl !== this.mcpUrl) return empty;
    const tokens = OAuthTokensSchema.safeParse(data.tokens);
    const client = OAuthClientInformationFullSchema.safeParse(data.clientInformation);
    return {
      mcpUrl: this.mcpUrl,
      tokens: tokens.success ? tokens.data : null,
      expiresAt: finiteOrNull(data.expiresAt),
      clientInformation: client.success ? client.data : null,
      discovery: discoveryOrNull(data.discovery),
      resource: typeof data.resource === "string" && data.resource ? data.resource : null,
      refreshStartedAt: finiteOrNull(data.refreshStartedAt),
    };
  }

  /**
   * Changes on every write, 0n when the file is absent. The inode joins the mtime because every
   * write renames a new file into place, and Linux stamps mtimes from a clock coarse enough for two
   * writes to share one.
   */
  version(): bigint {
    try {
      const st = fs.statSync(this.file, { bigint: true });
      return (st.ino << 64n) | st.mtimeNs;
    } catch {
      return 0n;
    }
  }

  /** Read, merge, temp file, fsync, rename, 0600. Throws the errno. */
  write(patch: Partial<Omit<StoredOAuth, "mcpUrl">>): void {
    const { mcpUrl, ...current } = this.read();
    this.replace({ ...current, ...patch, mcpUrl });
  }

  /** expiresAt from expires_in; refreshStartedAt back to null. */
  saveTokens(tokens: OAuthTokens, receivedAtMs: number): void {
    const ttl = tokens.expires_in;
    const expiresAt = typeof ttl === "number" && Number.isFinite(ttl) ? receivedAtMs + ttl * 1000 : null;
    this.write({ tokens, expiresAt, refreshStartedAt: null });
  }

  /**
   * Keeps the access token and clears the in-flight marker in the same write. Every caller drops the
   * token because a grant may have spent it, so the marker has nothing left to guard.
   */
  dropRefreshToken(): void {
    const current = this.read();
    if (!current.tokens) return;
    const { refresh_token: _spent, ...rest } = current.tokens;
    this.write({ tokens: rest, refreshStartedAt: null });
  }

  clear(): boolean {
    try {
      fs.unlinkSync(this.file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  private replace(record: StoredOAuth): void {
    const dir = dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory alone, and the tools cache may have created this one first.
    fs.chmodSync(dir, 0o700);
    // A reader sees the old file or the new one, never half of either, and a crash mid-write leaves
    // the old pair usable.
    const tmp = join(dir, `.oauth-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify(record, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // The write error is the one worth reporting.
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Already gone, or the directory refuses changes; the first error is the one worth reporting.
      }
      throw e;
    }
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      // Some file systems refuse fsync on a directory. The rename has happened either way.
    }
  }
}
