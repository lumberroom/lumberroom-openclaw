import type { AuthHandle, LumberroomConfig } from "../types.js";

export const REFRESH_SKEW_MS = 60_000;

export type OAuthStatus = "signed_in" | "signed_out" | "expired_no_refresh" | "refused";

export interface OAuthAuthOptions {
  stateDir: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  fenceTimeoutMs?: number;
  refreshTimeoutMs?: number;
}

export function createOAuthAuth(cfg: LumberroomConfig, opts: OAuthAuthOptions): AuthHandle & { status(): OAuthStatus } {
  throw new Error("T2");
}
