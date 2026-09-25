import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sessionMemoryHookOff } from "../../src/config.js";
import { HOOK_NARROWING_LINE, applySetup, planSetup, type SetupAnswers } from "../../src/setup.js";

type Selection = { configured: boolean; names: Set<string> | null; declaredNames: Set<string> };
let resolveInternalHookSelection: (config: unknown) => Selection;

// OpenClaw exports its hook selection on no public subpath, so the test finds the bundled chunk that
// defines it and imports that file. A missing chunk fails here, loudly, on an OpenClaw upgrade.
beforeAll(async () => {
  // Hook installs live in OpenClaw's state database; an empty state dir means none.
  process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "lumberroom-hooksel-"));
  const require = createRequire(import.meta.url);
  const dist = join(dirname(require.resolve("openclaw/plugin-sdk/core")), "..");
  const file = readdirSync(dist).find((name) => name.endsWith(".mjs") && readFileSync(join(dist, name), "utf8").includes("function resolveInternalHookSelection("));
  if (!file) throw new Error("OpenClaw's resolveInternalHookSelection chunk was not found under dist");
  const source = readFileSync(join(dist, file), "utf8");
  const alias = /resolveInternalHookSelection as (\w+)/.exec(source)?.[1];
  if (!alias) throw new Error(`no export alias for resolveInternalHookSelection in ${file}`);
  const mod = (await import(pathToFileURL(join(dist, file)).href)) as Record<string, unknown>;
  resolveInternalHookSelection = mod[alias] as typeof resolveInternalHookSelection;
});

/** OpenClaw's loader: discovery only when configured, then the name selection, then the entry's own switch. */
function openClawLoadsSessionMemory(root: Record<string, unknown>): boolean {
  const sel = resolveInternalHookSelection(root);
  const entry = (root.hooks as { internal?: { entries?: Record<string, { enabled?: boolean }> } } | undefined)?.internal?.entries?.["session-memory"];
  return sel.configured && (sel.names === null || sel.names.has("session-memory")) && entry?.enabled !== false;
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ["no hooks block", {}],
  ["internal hooks on with no entries", { hooks: { internal: { enabled: true } } }],
  ["internal hooks off", { hooks: { internal: { enabled: false, entries: { "session-memory": { enabled: true } } } } }],
  ["session-memory listed on", { hooks: { internal: { entries: { "session-memory": { enabled: true } } } } }],
  ["session-memory listed off", { hooks: { internal: { enabled: true, entries: { "session-memory": { enabled: false } } } } }],
  ["an allowlist without session-memory", { hooks: { internal: { entries: { "command-logger": { enabled: true } } } } }],
  ["an allowlist of disabled entries only", { hooks: { internal: { enabled: true, entries: { "command-logger": { enabled: false } } } } }],
  ["extra dirs open discovery past an allowlist", { hooks: { internal: { load: { extraDirs: ["/opt/hooks"] }, entries: { "command-logger": { enabled: true } } } } }],
  ["blank extra dirs leave the allowlist closed", { hooks: { internal: { load: { extraDirs: ["  "] }, entries: { "command-logger": { enabled: true } } } } }],
  ["session-memory listed with no enabled key", { hooks: { internal: { entries: { "session-memory": {} } } } }],
  ["a blank entry name turns discovery on", { hooks: { internal: { entries: { " ": {} } } } }],
];

describe("sessionMemoryHookOff matches OpenClaw's hook selection", () => {
  it.each(CASES)("%s", (_label, root) => {
    expect(sessionMemoryHookOff(root)).toBe(!openClawLoadsSessionMemory(root));
  });
});

describe("setup and internal hook discovery", () => {
  const answers: SetupAnswers = { deployment: "hosted", auth: "oauth", dreamingReview: false, ownerIds: [] };
  const NARROWING = HOOK_NARROWING_LINE;

  function namesAfterSetup(current: Record<string, unknown>) {
    const plan = planSetup(current, answers);
    const draft = structuredClone(current);
    applySetup(draft, plan);
    return { plan, before: resolveInternalHookSelection(current).names, after: resolveInternalHookSelection(draft).names };
  }

  it("names the narrowing when internal hooks are on with no entries", () => {
    const { plan, before, after } = namesAfterSetup({ hooks: { internal: { enabled: true } } });
    expect(before).toBeNull();
    expect(after).toEqual(new Set());
    expect(plan.diff).toContain(NARROWING);
  });

  it.each([
    ["no hooks block", {}],
    ["an existing allowlist", { hooks: { internal: { enabled: true, entries: { "command-logger": { enabled: true } } } } }],
    ["discovery opened by extra dirs", { hooks: { internal: { enabled: true, load: { extraDirs: ["/opt/hooks"] } } } }],
    ["internal hooks off", { hooks: { internal: { enabled: false } } }],
  ])("prints no narrowing line with %s", (_label, current) => {
    const { plan, before, after } = namesAfterSetup(current as Record<string, unknown>);
    expect(before === null && after !== null).toBe(false);
    expect(plan.diff).not.toContain(NARROWING);
  });
});
