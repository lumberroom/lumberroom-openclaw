import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MissingGrant } from "../../src/errors.js";
import { BATCH_SIZE, EXTRACTOR, proposalsBody, readEntries, runImport, splitEntries } from "../../src/importer.js";
import type { AdminResponse, CallMeta, CallResult, EngineClient, ImportEntry } from "../../src/types.js";
import { startFakeEngine, type FakeEngine } from "../fakes/engine.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "lumberroom-importer-"));
}

function notImplemented(name: string): never {
  throw new Error(`${name} is not used by the importer tests`);
}

/** A minimal EngineClient over plain fetch, enough for runImport's admin() calls against a fake engine. */
function adminClient(baseUrl: string, bearer?: string): EngineClient {
  return {
    listTools(_meta: CallMeta): Promise<{ result: CallResult; listing: null }> {
      return notImplemented("listTools");
    },
    callTool(_name: string, _args: Record<string, unknown>, _meta: CallMeta): Promise<CallResult> {
      return notImplemented("callTool");
    },
    async admin(method, path, body, _meta): Promise<AdminResponse> {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    },
    async close(): Promise<void> {},
  };
}

describe("splitEntries", () => {
  it("bullets become one entry each with the marker stripped", () => {
    expect(splitEntries("- first fact\n- second fact\n* third fact\n1. fourth fact")).toEqual([
      "first fact",
      "second fact",
      "third fact",
      "fourth fact",
    ]);
  });

  it("paragraphs split on blank lines", () => {
    expect(splitEntries("first paragraph here\n\nsecond paragraph here")).toEqual([
      "first paragraph here",
      "second paragraph here",
    ]);
  });

  it("a heading-only line drops", () => {
    expect(splitEntries("## Section heading\n\nthe actual durable fact goes here")).toEqual([
      "the actual durable fact goes here",
    ]);
  });

  it("an entry under three characters drops", () => {
    expect(splitEntries("ok\n\na real fact worth keeping")).toEqual(["a real fact worth keeping"]);
  });

  it("an entry over 4000 characters splits at a newline or sentence end", () => {
    const sentence = "This is one durable fact worth recording in full. ";
    const long = sentence.repeat(200); // well over 4000 characters
    const parts = splitEntries(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4000);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("This is one durable fact worth recording in full.");
  });
});

describe("readEntries", () => {
  it("USER.md goes to user:me and the rest to global", () => {
    const dir = tempWorkspace();
    writeFileSync(join(dir, "MEMORY.md"), "a global fact worth keeping");
    writeFileSync(join(dir, "USER.md"), "a user fact worth keeping");
    const entries = readEntries(dir);
    const byFile = new Map(entries.map((e) => [e.file, e]));
    expect(byFile.get("MEMORY.md")?.namespace).toBe("global");
    expect(byFile.get("USER.md")?.namespace).toBe("user:me");
  });

  it("memory files are read top level and sorted", () => {
    const dir = tempWorkspace();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "b.md"), "second file fact here");
    writeFileSync(join(dir, "memory", "a.md"), "first file fact here");
    mkdirSync(join(dir, "memory", "nested"));
    writeFileSync(join(dir, "memory", "nested", "c.md"), "nested fact that must not be read");
    const entries = readEntries(dir);
    expect(entries.map((e) => e.file)).toEqual(["memory/a.md", "memory/b.md"]);
    expect(entries.every((e) => e.namespace === "global")).toBe(true);
  });

  it("a missing file is skipped with no error", () => {
    const dir = tempWorkspace();
    expect(readEntries(dir)).toEqual([]);
  });
});

describe("proposalsBody", () => {
  it("the proposals body matches the engine's shape field for field", () => {
    const entries: ImportEntry[] = [
      { file: "MEMORY.md", path: "/ws/MEMORY.md", text: "a durable fact", sha256: "abc123", namespace: "global" },
    ];
    expect(proposalsBody(entries, "run-1")).toEqual({
      extractor: EXTRACTOR,
      facts: [
        {
          content: "a durable fact",
          namespace: "global",
          tags: ["openclaw-import"],
          speaker: "main_model",
          span_text: "a durable fact",
          source: { file_path: "/ws/MEMORY.md", entry_uuid: "abc123", run_id: "run-1" },
        },
      ],
    });
  });
});

describe("runImport", () => {
  let engine: FakeEngine | null = null;

  afterEach(async () => {
    if (engine) await engine.close();
    engine = null;
  });

  it("dry run posts nothing", async () => {
    engine = await startFakeEngine();
    const dir = tempWorkspace();
    writeFileSync(join(dir, "MEMORY.md"), "a durable fact worth keeping");
    const report = await runImport(adminClient(engine.url), dir, { dryRun: true, agentId: null, timeoutMs: 2000 });
    expect(report).toEqual({ runId: null, posted: 0, proposalsNew: 0, proposalsReinforced: 0, refused: 0, blocked: 0 });
    expect(engine.requests.length).toBe(0);
  });

  it("a 403 raises MissingGrant", async () => {
    engine = await startFakeEngine({ mayIngest: false });
    const dir = tempWorkspace();
    writeFileSync(join(dir, "MEMORY.md"), "a durable fact worth keeping");
    await expect(runImport(adminClient(engine.url), dir, { dryRun: false, agentId: null, timeoutMs: 2000 })).rejects.toBeInstanceOf(
      MissingGrant,
    );
  });

  it("a rerun reinforces and adds no proposal", async () => {
    engine = await startFakeEngine();
    const dir = tempWorkspace();
    writeFileSync(join(dir, "MEMORY.md"), "a durable fact worth keeping");
    const client = adminClient(engine.url);
    const first = await runImport(client, dir, { dryRun: false, agentId: null, timeoutMs: 2000 });
    expect(first.proposalsNew).toBe(1);
    expect(first.proposalsReinforced).toBe(0);
    const second = await runImport(client, dir, { dryRun: false, agentId: null, timeoutMs: 2000 });
    expect(second.proposalsNew).toBe(0);
    expect(second.proposalsReinforced).toBe(1);
  });

  it("posts go in batches of 100", async () => {
    engine = await startFakeEngine();
    const dir = tempWorkspace();
    const lines = Array.from({ length: BATCH_SIZE + 20 }, (_, i) => `distinct durable fact number ${i}`).join("\n\n");
    writeFileSync(join(dir, "MEMORY.md"), lines);
    const client = adminClient(engine.url);
    await runImport(client, dir, { dryRun: false, agentId: null, timeoutMs: 5000 });
    const proposalPosts = engine.requests.filter((r) => r.method === "POST" && r.path === "/admin/ingest/proposals");
    expect(proposalPosts.length).toBe(2);
  });

  it("the run closes with entries_seen and the proposal counts", async () => {
    engine = await startFakeEngine();
    const dir = tempWorkspace();
    writeFileSync(join(dir, "MEMORY.md"), "a durable fact worth keeping\n\nanother durable fact worth keeping");
    const client = adminClient(engine.url);
    const report = await runImport(client, dir, { dryRun: false, agentId: null, timeoutMs: 2000 });
    const close = engine.requests.find((r) => r.method === "POST" && r.path === `/admin/ingest/runs/${report.runId}/close`);
    expect(close?.body).toEqual({ entries_seen: 2, proposals_new: 2, proposals_reinforced: 0 });
  });
});
