import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARDED_TOOLS = ["write", "edit", "apply_patch"] as const;
export const GUARD_REASON =
  "MEMORY.md, USER.md and memory/ are read-only while lumberroom owns memory. Record durable facts with memory_write.";

const APPLY_PATCH_MARKERS = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];

export function guardTargets(toolName: string, params: Record<string, unknown>, derivedPaths?: readonly string[]): string[] {
  if (derivedPaths && derivedPaths.length) return [...derivedPaths];
  if (toolName === "apply_patch") {
    const input = typeof params.input === "string" ? params.input : "";
    const targets: string[] = [];
    for (const line of input.split("\n")) {
      for (const marker of APPLY_PATCH_MARKERS) {
        if (line.startsWith(marker)) targets.push(line.slice(marker.length).trim());
      }
    }
    return targets;
  }
  const targets: string[] = [];
  if (typeof params.path === "string") targets.push(params.path);
  if (typeof params.file_path === "string") targets.push(params.file_path);
  return targets;
}

/** Resolves through the real path of the deepest existing ancestor, which defeats ".." and a symlink. */
function resolveRealPath(absolutePath: string): string {
  let current = absolutePath;
  const missingSuffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missingSuffix.unshift(basename(current));
    current = parent;
  }
  // The native call returns on-disk case and expands Windows 8.3 short names; the JS one echoes
  // the caller's spelling. The case fold below covers darwin on its own; win32 needs both.
  const real = existsSync(current) ? realpathSync.native(current) : current;
  return missingSuffix.length ? resolve(real, ...missingSuffix) : real;
}

function osHome(): string | undefined {
  const raw = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  return raw ? resolve(raw) : undefined;
}

function expandHome(target: string): string {
  const home = osHome();
  if (!home) return target;
  if (target === "~") return home;
  if (target.startsWith("~/") || (process.platform === "win32" && target.startsWith("~\\"))) {
    return home + target.slice(1);
  }
  return target;
}

function expandFileUrl(target: string): string {
  if (!/^file:\/\//i.test(target)) return target;
  try {
    return fileURLToPath(target);
  } catch {
    return target;
  }
}

/**
 * Every path OpenClaw's write and edit tools could open for this target. The tools strip one
 * leading @ unless a literal "@name" exists, so the guard checks both readings and blocks if either
 * lands on a guarded file (OC src/agents/sessions/tools/path-utils.ts).
 */
function candidateTargets(target: string): string[] {
  const readings = [target];
  if (target.startsWith("@")) {
    const stripped = target.slice(1);
    readings.push(stripped.startsWith("@") ? `./${stripped}` : stripped);
  }
  return readings.map((reading) => expandHome(expandFileUrl(reading)));
}

// APFS and NTFS default to case-insensitive, so /x/WS/MEMORY.md opens /x/ws/MEMORY.md.
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function isGuardedResolved(target: string, workspaceDir: string): boolean {
  const absoluteTarget = isAbsolute(target) ? target : resolve(workspaceDir, target);
  let resolvedTarget = resolveRealPath(absoluteTarget);
  let resolvedWorkspace = resolveRealPath(resolve(workspaceDir));
  if (CASE_INSENSITIVE_FS) {
    resolvedTarget = resolvedTarget.toLowerCase();
    resolvedWorkspace = resolvedWorkspace.toLowerCase();
  }
  const rel = relative(resolvedWorkspace, resolvedTarget);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const lower = rel.toLowerCase();
  if (lower === "memory.md" || lower === "user.md") return true;
  return lower === "memory" || lower.startsWith(`memory${sep}`);
}

export function isGuardedPath(target: string, workspaceDir: string): boolean {
  return candidateTargets(target).some((candidate) => isGuardedResolved(candidate, workspaceDir));
}
