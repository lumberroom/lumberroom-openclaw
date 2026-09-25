// Reads OpenClaw's built-in memory files and posts them to the engine's proposal queue. Never the
// live store: main_model never auto-approves (E11), so a rerun only reinforces existing proposals.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MissingGrant } from "./errors.js";
import type { EngineClient, ImportEntry, ImportReport } from "./types.js";

export const EXTRACTOR = "openclaw-builtin-import";
export const SPEAKER = "main_model";
export const BATCH_SIZE = 100;

const LIST_MARKER = /^(?:[-*+]\s+|\d+\.\s+)/;
const HEADING_ONLY = /^#{1,6}\s+\S/;
const MIN_ENTRY_CHARS = 3;
const MAX_ENTRY_CHARS = 4000;

function splitLong(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const window = text.slice(0, maxLen);
  const lastNewline = window.lastIndexOf("\n");
  let lastSentence = -1;
  const sentenceEnd = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(window))) lastSentence = match.index + 1;
  const cut = Math.max(lastNewline, lastSentence);
  const at = cut > 0 ? cut : maxLen;
  const head = text.slice(0, at).trim();
  const rest = text.slice(at).trim();
  return rest ? [head, ...splitLong(rest, maxLen)] : [head];
}

/** Blocks separated by blank lines; a bullet block yields one entry per item, a heading-only block drops. */
export function splitEntries(text: string): string[] {
  const blocks = text
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const nonEmpty = lines.filter((line) => line.trim());
    if (nonEmpty.length > 0 && nonEmpty.every((line) => LIST_MARKER.test(line.trim()))) {
      for (const line of nonEmpty) candidates.push(line.trim().replace(LIST_MARKER, "").trim());
      continue;
    }
    if (lines.length === 1 && HEADING_ONLY.test(block)) continue;
    candidates.push(block);
  }

  const result: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < MIN_ENTRY_CHARS) continue;
    result.push(...splitLong(candidate, MAX_ENTRY_CHARS));
  }
  return result;
}

function entriesFromFile(path: string, file: ImportEntry["file"], namespace: ImportEntry["namespace"]): ImportEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return splitEntries(raw).map((entryText) => ({
    file,
    path,
    text: entryText,
    sha256: createHash("sha256").update(entryText).digest("hex"),
    namespace,
  }));
}

/** MEMORY.md into global, USER.md into user:me, memory/*.md (top level, sorted) into global. */
export function readEntries(workspaceDir: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  entries.push(...entriesFromFile(resolve(workspaceDir, "MEMORY.md"), "MEMORY.md", "global"));
  entries.push(...entriesFromFile(resolve(workspaceDir, "USER.md"), "USER.md", "user:me"));

  const memoryDir = resolve(workspaceDir, "memory");
  if (existsSync(memoryDir)) {
    const names = readdirSync(memoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      entries.push(...entriesFromFile(join(memoryDir, name), `memory/${name}`, "global"));
    }
  }
  return entries;
}

export function proposalsBody(entries: readonly ImportEntry[], runId: string): { extractor: string; facts: unknown[] } {
  return {
    extractor: EXTRACTOR,
    facts: entries.map((entry) => ({
      content: entry.text,
      namespace: entry.namespace,
      tags: ["openclaw-import"],
      speaker: SPEAKER,
      span_text: entry.text,
      source: { file_path: entry.path, entry_uuid: entry.sha256, run_id: runId },
    })),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Throws MissingGrant. */
export async function runImport(
  client: EngineClient,
  workspaceDir: string,
  opts: { dryRun: boolean; agentId: string | null; timeoutMs: number },
): Promise<ImportReport> {
  const entries = readEntries(workspaceDir);
  const empty: ImportReport = { runId: null, posted: 0, proposalsNew: 0, proposalsReinforced: 0, refused: 0, blocked: 0 };
  if (opts.dryRun || entries.length === 0) return empty;

  const runRes = await client.admin(
    "POST",
    "/admin/ingest/runs",
    { extractor: EXTRACTOR, scope: { workspace: workspaceDir, agent: opts.agentId } },
    { timeoutMs: opts.timeoutMs },
  );
  if (runRes.status === 403) throw new MissingGrant();
  if (runRes.status !== 200 || !isRecord(runRes.json) || typeof runRes.json.run_id !== "string") {
    throw new Error(`lumberroom ingest run failed (${runRes.status})`);
  }
  const runId = runRes.json.run_id;

  let posted = 0;
  let proposalsNew = 0;
  let proposalsReinforced = 0;
  let refused = 0;
  let blocked = 0;
  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);
    const res = await client.admin("POST", "/admin/ingest/proposals", proposalsBody(batch, runId), { timeoutMs: opts.timeoutMs });
    if (res.status === 403) throw new MissingGrant();
    if (res.status !== 200 || !isRecord(res.json)) {
      throw new Error(`lumberroom ingest proposals failed (${res.status})`);
    }
    posted += batch.length;
    proposalsNew += typeof res.json.proposals_new === "number" ? res.json.proposals_new : 0;
    proposalsReinforced += typeof res.json.proposals_reinforced === "number" ? res.json.proposals_reinforced : 0;
    refused += typeof res.json.refused === "number" ? res.json.refused : 0;
    blocked += typeof res.json.blocked === "number" ? res.json.blocked : 0;
  }

  const closeRes = await client.admin(
    "POST",
    `/admin/ingest/runs/${runId}/close`,
    { entries_seen: entries.length, proposals_new: proposalsNew, proposals_reinforced: proposalsReinforced },
    { timeoutMs: opts.timeoutMs },
  );
  if (closeRes.status === 403) throw new MissingGrant();
  if (closeRes.status !== 200) throw new Error(`lumberroom ingest close failed (${closeRes.status})`);

  return { runId, posted, proposalsNew, proposalsReinforced, refused, blocked };
}
