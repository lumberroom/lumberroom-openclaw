import type { LumberroomConfig } from "../types.js";

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

/** Throws LoginFailed. */
export function parseRedirect(raw: string): { code: string; state: string | null } {
  throw new Error("T2");
}

/** Throws LoginFailed. */
export function login(cfg: LumberroomConfig, opts: LoginOptions): Promise<void> {
  throw new Error("T2");
}

export function logout(cfg: LumberroomConfig, stateDir: string): Promise<boolean> {
  throw new Error("T2");
}
