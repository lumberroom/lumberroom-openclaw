import type { CallResult } from "../types.js";

export interface Attempt {
  sent: boolean;
  status: number | null;
}

/** ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ENETUNREACH, UND_ERR_CONNECT_TIMEOUT, looked up through err.cause. */
export function neverSent(err: unknown): boolean {
  throw new Error("T1");
}

export function classifyFailure(err: unknown, attempt: Attempt): CallResult {
  throw new Error("T1");
}

/** An SDK CallToolResult to a CallResult. isError becomes tool_error with the engine's text. */
export function toolResult(tool: string, raw: unknown): CallResult {
  throw new Error("T1");
}
