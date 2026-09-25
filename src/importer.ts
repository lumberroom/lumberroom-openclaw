import type { EngineClient, ImportEntry, ImportReport } from "./types.js";

export const EXTRACTOR = "openclaw-builtin-import";
export const SPEAKER = "main_model";
export const BATCH_SIZE = 100;

export function splitEntries(text: string): string[] {
  throw new Error("T5");
}

export function readEntries(workspaceDir: string): ImportEntry[] {
  throw new Error("T5");
}

export function proposalsBody(entries: readonly ImportEntry[], runId: string): { extractor: string; facts: unknown[] } {
  throw new Error("T5");
}

/** Throws MissingGrant. */
export function runImport(
  client: EngineClient,
  workspaceDir: string,
  opts: { dryRun: boolean; agentId: string | null; timeoutMs: number },
): Promise<ImportReport> {
  throw new Error("T5");
}
