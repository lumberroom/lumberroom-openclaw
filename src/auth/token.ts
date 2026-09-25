import type { AuthHandle } from "../types.js";

/** A static bearer: a self-hosted AUTH_TOKENS entry or a hosted lr_ token. Nothing to refresh or settle. */
export function createTokenAuth(token: string): AuthHandle {
  const header = `Bearer ${token}`;
  return {
    mode: "token",
    async authorize() {
      return header;
    },
    // A 401 in token mode means the grant or the token is wrong, and only the owner can fix that.
    rejected() {},
    async settle() {},
  };
}
