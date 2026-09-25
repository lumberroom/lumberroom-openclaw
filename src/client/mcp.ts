import type { AuthHandle, EngineClient, LumberroomConfig } from "../types.js";

export interface EngineClientOptions {
  version: string;
  fetch?: typeof globalThis.fetch;
  pid?: number;
}

export function createEngineClient(cfg: LumberroomConfig, auth: AuthHandle, opts: EngineClientOptions): EngineClient {
  throw new Error("T1");
}
