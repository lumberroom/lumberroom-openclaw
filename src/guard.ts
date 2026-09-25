export const GUARDED_TOOLS = ["write", "edit", "apply_patch"] as const;
export const GUARD_REASON =
  "MEMORY.md, USER.md and memory/ are read-only while lumberroom owns memory. Record durable facts with memory_write.";

export function guardTargets(toolName: string, params: Record<string, unknown>, derivedPaths?: readonly string[]): string[] {
  throw new Error("T3");
}

export function isGuardedPath(target: string, workspaceDir: string): boolean {
  throw new Error("T3");
}
