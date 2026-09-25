import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { FenceTimeout, LoginRequired, RefreshUnavailable, TokenSaveFailed } from "../errors.js";
import type { CallKind, CallResult } from "../types.js";

export interface Attempt {
  sent: boolean;
  status: number | null;
}

const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

// Ruling 8: a proxy answers 502 or 503 while the engine restarts, so the owner accepted reporting
// those as nothing stored even though a proxy can also answer 502 after the engine took the write.
const NOT_FORWARDED = new Set([502, 503]);

const MAX_DETAIL = 300;

// Walks cause and AggregateError members. Node's happy-eyeballs connect wraps one error per address
// in an AggregateError, so the errno can sit a level below the cause.
function* chain(err: unknown, depth = 0): Generator<unknown> {
  if (depth > 6 || err === null || typeof err !== "object") return;
  yield err;
  if (err instanceof AggregateError) for (const e of err.errors) yield* chain(e, depth + 1);
  yield* chain((err as { cause?: unknown }).cause, depth + 1);
}

function errno(err: unknown): string | undefined {
  for (const e of chain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/** ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ENETUNREACH, UND_ERR_CONNECT_TIMEOUT, looked up through err.cause. */
export function neverSent(err: unknown): boolean {
  for (const e of chain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT.has(code)) return true;
  }
  return false;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL)}...` : t;
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    const code = errno(err);
    const inner = [...chain(err)].at(-1);
    const detail = inner instanceof Error && inner !== err ? `${err.message}: ${inner.message}` : err.message;
    const text = clip(detail || err.name);
    return code && !text.includes(code) ? `${text} (${code})` : text;
  }
  return clip(String(err));
}

// The SDK carries the HTTP status on .code and only the status text in the message, so the status
// comes from there or from what the fetch wrapper recorded, never from parsing the message.
function httpStatus(err: unknown, attempt: Attempt): number | null {
  if (err instanceof StreamableHTTPError && typeof err.code === "number" && err.code >= 100) return err.code;
  return attempt.status;
}

function fail(kind: CallKind, error: string, status: number | null): CallResult {
  return { kind, structured: null, text: "", error, status };
}

function serverMessage(err: McpError): string {
  return err.message.replace(/^MCP error -?\d+: /, "");
}

function httpDetail(err: unknown): string {
  if (!(err instanceof StreamableHTTPError)) return "";
  const body = err.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/, "");
  return body ? `: ${clip(body)}` : "";
}

export function classifyFailure(err: unknown, attempt: Attempt): CallResult {
  const status = httpStatus(err, attempt);
  // A failure result carries a status only when an error status arrived. A 200 whose body could not
  // be read is a lost answer, and a caller printing "answered HTTP 200" would mislead.
  const errorStatus = status !== null && status >= 400 ? status : null;

  if (err instanceof LoginRequired) return fail("login_required", err.message, null);
  if (status === 401) return fail("unauthorized", "HTTP 401", 401);
  if (err instanceof FenceTimeout || err instanceof RefreshUnavailable || err instanceof TokenSaveFailed) {
    return fail("unreachable", reason(err), null);
  }
  if (neverSent(err) || !attempt.sent) return fail("unreachable", reason(err), errorStatus);
  if (status !== null && NOT_FORWARDED.has(status)) return fail("unreachable", `HTTP ${status}`, status);

  // Past this point the request left. Only an answer that proves the engine refused it may say
  // nothing happened; everything else tells the caller the call may have taken effect.
  if (err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed) {
    return fail("tool_error", serverMessage(err), null);
  }
  if (errorStatus !== null && errorStatus < 500) {
    return fail("tool_error", `lumberroom answered HTTP ${errorStatus}${httpDetail(err)}`, errorStatus);
  }
  return fail("timeout", errorStatus !== null ? `HTTP ${errorStatus}` : reason(err), errorStatus);
}

interface RawToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

/** An SDK CallToolResult to a CallResult. isError becomes tool_error with the engine's text. */
export function toolResult(tool: string, raw: unknown): CallResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawToolResult;
  const parts = Array.isArray(r.content) ? (r.content as unknown[]) : [];
  const text = parts
    .filter((c): c is { type: "text"; text: string } => {
      const p = c as { type?: unknown; text?: unknown } | null;
      return !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string";
    })
    .map((c) => c.text)
    .join("\n");
  const structured =
    r.structuredContent && typeof r.structuredContent === "object" && !Array.isArray(r.structuredContent)
      ? (r.structuredContent as Record<string, unknown>)
      : null;
  if (r.isError === true) return { kind: "tool_error", structured, text, error: text || `${tool} failed`, status: null };
  return { kind: "ok", structured, text, error: null, status: null };
}
