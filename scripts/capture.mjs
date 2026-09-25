#!/usr/bin/env node
// Captures the engine's MCP handshake, tools/list and one tools/call for the OpenClaw plugin.
// Writes tools-snapshot.json, the schemas the plugin offers before it reaches the engine, and
// test/fixtures/engine_transcript.json, which test/fakes/engine.ts replays. Run by
// scripts/openclaw-plugin-test.sh --capture against a scratch engine in token mode.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KEEP_HEADERS = ["content-type", "mcp-protocol-version", "www-authenticate"];
const { values: a } = parseArgs({
  options: { url: { type: "string" }, token: { type: "string" }, snapshot: { type: "string" }, transcript: { type: "string" } },
});
for (const k of ["url", "token", "snapshot", "transcript"]) {
  if (!a[k]) {
    console.error(`--${k} is required`);
    process.exit(1);
  }
}

const exchanges = [];
const pick = (h) => Object.fromEntries([...h.entries()].filter(([k]) => KEEP_HEADERS.includes(k.toLowerCase())));
const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function recordingFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${a.token}`);
  headers.set("x-memory-invocation", "hook");
  const method = init.method ?? "GET";
  const res = await fetch(input, { ...init, headers });
  // A 200 GET is an event stream that never ends; reading it would hang the capture.
  const body = method === "GET" && res.ok ? "" : await res.clone().text();
  exchanges.push({
    request: { method, path: new URL(String(input)).pathname, headers: pick(headers), json: parse(typeof init.body === "string" ? init.body : null) },
    response: { status: res.status, headers: pick(res.headers), json: parse(body) },
  });
  return res;
}

const client = new Client({ name: "lumberroom-openclaw-capture", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${a.url}/mcp`), { fetch: recordingFetch });
try {
  await client.connect(transport);
} catch (e) {
  console.error(`handshake failed: ${e?.message ?? e}`);
  process.exit(2);
}
const listing = await client.listTools();
await client.callTool({ name: "memory_search", arguments: { query: "capture probe", limit: 1 } });
const snapshot = {
  protocolVersion: transport.protocolVersion ?? null,
  serverInfo: client.getServerVersion() ?? null,
  instructions: client.getInstructions() ?? null,
  tools: listing.tools,
};
await client.close();
mkdirSync(dirname(a.snapshot), { recursive: true });
writeFileSync(a.snapshot, JSON.stringify(snapshot, null, 2) + "\n");
mkdirSync(dirname(a.transcript), { recursive: true });
writeFileSync(a.transcript, JSON.stringify({ exchanges }, null, 2) + "\n");
console.log(
  `protocol=${snapshot.protocolVersion} server=${snapshot.serverInfo?.name}/${snapshot.serverInfo?.version} ` +
    `tools=${listing.tools.map((t) => t.name).join(",")}`,
);
