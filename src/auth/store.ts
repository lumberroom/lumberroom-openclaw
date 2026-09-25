import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
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
  throw new Error("T2");
}

export class TokenStore {
  constructor(file: string, mcpUrl: string, opts?: { now?: () => number }) {
    throw new Error("T2");
  }

  /** Signed out for a missing or corrupt file, or one bound to another mcpUrl. Never throws. */
  read(): StoredOAuth {
    throw new Error("T2");
  }

  /** mtimeNs, 0n when the file is absent. */
  version(): bigint {
    throw new Error("T2");
  }

  /** Read, merge, temp file, fsync, rename, 0600. Throws the errno. */
  write(patch: Partial<Omit<StoredOAuth, "mcpUrl">>): void {
    throw new Error("T2");
  }

  /** expiresAt from expires_in; refreshStartedAt back to null. */
  saveTokens(tokens: OAuthTokens, receivedAtMs: number): void {
    throw new Error("T2");
  }

  dropRefreshToken(): void {
    throw new Error("T2");
  }

  clear(): boolean {
    throw new Error("T2");
  }
}
