import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  const real = existsSync(current) ? realpathSync(current) : current;
  return missingSuffix.length ? resolve(real, ...missingSuffix) : real;
}

export function isGuardedPath(target: string, workspaceDir: string): boolean {
  const absoluteTarget = isAbsolute(target) ? target : resolve(workspaceDir, target);
  const resolvedTarget = resolveRealPath(absoluteTarget);
  const resolvedWorkspace = resolveRealPath(resolve(workspaceDir));
  const rel = relative(resolvedWorkspace, resolvedTarget);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const lower = rel.toLowerCase();
  if (lower === "memory.md" || lower === "user.md") return true;
  return lower === "memory" || lower.startsWith(`memory${sep}`);
}
