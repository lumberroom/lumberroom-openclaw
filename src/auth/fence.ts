export const FENCE_TIMEOUT_MS = 30_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_UPDATE_MS = 10_000;

export interface FenceHandle {
  compromised(): boolean;
}

/** Holds the cross-process lock while fn runs. Throws FenceTimeout. */
export function withFence<T>(lockPath: string, fn: (fence: FenceHandle) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  throw new Error("T2");
}

export function withFenceSync<T>(lockPath: string, fn: () => T): T {
  throw new Error("T2");
}
