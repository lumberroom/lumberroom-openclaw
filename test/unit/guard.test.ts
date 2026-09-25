import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardTargets, isGuardedPath } from "../../src/guard.js";

describe("guardTargets", () => {
  it("prefers derivedPaths when the event carries them", () => {
    expect(guardTargets("write", { path: "notes.md" }, ["a.md", "b.md"])).toEqual(["a.md", "b.md"]);
  });

  it("ignores an empty derivedPaths and falls back to params", () => {
    expect(guardTargets("write", { path: "notes.md" }, [])).toEqual(["notes.md"]);
  });

  it("reads path and file_path from write and edit params", () => {
    expect(guardTargets("write", { path: "a.md" })).toEqual(["a.md"]);
    expect(guardTargets("edit", { file_path: "b.md" })).toEqual(["b.md"]);
    expect(guardTargets("edit", { path: "a.md", file_path: "b.md" })).toEqual(["a.md", "b.md"]);
  });

  it("returns nothing when write params carry neither path nor file_path", () => {
    expect(guardTargets("write", {})).toEqual([]);
  });

  it("parses apply_patch markers when no derivedPaths are given", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: memory/new.md",
      "+hello",
      "*** Update File: MEMORY.md",
      "*** Move to: memory/renamed.md",
      "@@ context",
      "*** Delete File: USER.md",
      "*** End Patch",
    ].join("\n");
    expect(guardTargets("apply_patch", { input })).toEqual([
      "memory/new.md",
      "MEMORY.md",
      "memory/renamed.md",
      "USER.md",
    ]);
  });

  it("returns nothing for an apply_patch with no input", () => {
    expect(guardTargets("apply_patch", {})).toEqual([]);
  });
});

describe("isGuardedPath", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "lumberroom-guard-"));
    mkdirSync(join(ws, "memory"));
    writeFileSync(join(ws, "notes.md"), "hi");
  });

  // Review focus 3: every spelling of MEMORY.md, USER.md and memory/** blocked; notes.md allowed.
  it.each(["MEMORY.md", "memory.md", "./MEMORY.md", "USER.md", "user.md"])("blocks %s at the workspace root", (target) => {
    expect(isGuardedPath(target, ws)).toBe(true);
  });

  it("blocks a path inside memory/", () => {
    expect(isGuardedPath("memory/fact.md", ws)).toBe(true);
    expect(isGuardedPath("memory/nested/fact.md", ws)).toBe(true);
  });

  it("blocks a relative path whose .. segments normalize back to a guarded file", () => {
    mkdirSync(join(ws, "sub"));
    expect(isGuardedPath("sub/../USER.md", ws)).toBe(true);
  });

  it("blocks a symlinked subdirectory that defeats a lexical check by resolving back to the workspace root", () => {
    symlinkSync(ws, join(ws, "linked"));
    expect(isGuardedPath("linked/MEMORY.md", ws)).toBe(true);
  });

  it("blocks a symlink whose target resolves into memory/", () => {
    writeFileSync(join(ws, "memory", "secret.md"), "x");
    symlinkSync(join(ws, "memory", "secret.md"), join(ws, "alias.md"));
    expect(isGuardedPath("alias.md", ws)).toBe(true);
  });

  it("allows an ordinary workspace file", () => {
    expect(isGuardedPath("notes.md", ws)).toBe(false);
  });

  it("allows a file outside the workspace entirely", () => {
    const outside = mkdtempSync(join(tmpdir(), "lumberroom-outside-"));
    expect(isGuardedPath(join(outside, "MEMORY.md"), ws)).toBe(false);
  });

  it("allows a file whose name merely starts with memory but is not the directory", () => {
    expect(isGuardedPath("memory-notes.md", ws)).toBe(false);
  });
});

// F1: OpenClaw's write and edit tools strip one leading @, expand ~ and decode file:// before they
// touch disk (resolveLocalPathToCwd), so the guard has to read a target the same way.
describe("isGuardedPath reads targets the way OpenClaw's write tool does", () => {
  let ws: string;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lumberroom-home-"));
    ws = join(home, "ws");
    mkdirSync(join(ws, "memory"), { recursive: true });
    writeFileSync(join(ws, "MEMORY.md"), "x");
    writeFileSync(join(ws, "notes.md"), "hi");
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it.each(["@MEMORY.md", "@USER.md", "@memory/x.md"])("blocks the @-reference %s", (target) => {
    expect(isGuardedPath(target, ws)).toBe(true);
  });

  it("blocks an @-prefixed absolute path into the workspace", () => {
    expect(isGuardedPath(`@${join(ws, "MEMORY.md")}`, ws)).toBe(true);
  });

  it("blocks a file:// URL that names a guarded file", () => {
    expect(isGuardedPath(pathToFileURL(join(ws, "MEMORY.md")).href, ws)).toBe(true);
    expect(isGuardedPath(`@${pathToFileURL(join(ws, "memory", "x.md")).href}`, ws)).toBe(true);
  });

  it("blocks a ~/ path that expands into the workspace", () => {
    expect(isGuardedPath("~/ws/MEMORY.md", ws)).toBe(true);
    expect(isGuardedPath("@~/ws/memory/x.md", ws)).toBe(true);
  });

  it("still allows an @-reference to an ordinary file", () => {
    expect(isGuardedPath("@notes.md", ws)).toBe(false);
    expect(isGuardedPath("~/ws/notes.md", ws)).toBe(false);
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "blocks a guarded file reached through a workspace path in a different letter case",
    () => {
      const shouted = join(home.toUpperCase(), "WS", "MEMORY.md");
      expect(isGuardedPath(shouted, ws)).toBe(true);
      expect(isGuardedPath(join(home, "WS", "memory", "x.md"), ws)).toBe(true);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "blocks a different letter case even before the workspace exists on disk",
    () => {
      // The write tool creates missing parents, so a fresh workspace has no real path to canonicalise.
      const fresh = join(home, "fresh");
      expect(isGuardedPath(join(home, "FRESH", "MEMORY.md"), fresh)).toBe(true);
    },
  );
});
