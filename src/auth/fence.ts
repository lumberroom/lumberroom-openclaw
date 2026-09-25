import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// The default import is the module object, so the tests can capture onCompromised through a spy.
import lockfile from "proper-lockfile";
import { FenceTimeout } from "../errors.js";

export const FENCE_TIMEOUT_MS = 30_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_UPDATE_MS = 10_000;

export interface FenceHandle {
  compromised(): boolean;
}

function jitterMs(): number {
  return 100 + Math.floor(Math.random() * 150);
}

function isLocked(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ELOCKED";
}

function lockOptions(lockPath: string, onCompromised: (err: Error) => void): lockfile.LockOptions {
  // retries stays 0: the loops below own the waiting, so the timeout is ours and not the retry
  // module's backoff. The lock path doubles as the key, since the token file may not exist yet.
  return { lockfilePath: lockPath, realpath: false, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS, retries: 0, onCompromised };
}

/** Holds the cross-process lock while fn runs. Throws FenceTimeout. */
export async function withFence<T>(lockPath: string, fn: (fence: FenceHandle) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let compromised = false;
  // proper-lockfile's default onCompromised throws from a timer and takes the process down. A peer
  // took the lock after this process stalled past the stale bound; the holder checks the flag.
  const options = lockOptions(lockPath, () => {
    compromised = true;
  });
  const deadline = Date.now() + (opts?.timeoutMs ?? FENCE_TIMEOUT_MS);
  let release: () => Promise<void>;
  for (;;) {
    try {
      release = await lockfile.lock(lockPath, options);
      break;
    } catch (e) {
      if (!isLocked(e)) throw e;
      const left = deadline - Date.now();
      if (left <= 0) throw new FenceTimeout(lockPath);
      await new Promise((r) => setTimeout(r, Math.min(jitterMs(), left)));
    }
  }
  try {
    return await fn({ compromised: () => compromised });
  } finally {
    try {
      await release();
    } catch {
      // ERELEASED after a compromise: the lock is a peer's now and not ours to remove.
    }
  }
}

/** The blocking form, for a caller with no event loop to spare. Waits up to FENCE_TIMEOUT_MS. */
export function withFenceSync<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const options = lockOptions(lockPath, () => {});
  const deadline = Date.now() + FENCE_TIMEOUT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let release: () => void;
  for (;;) {
    try {
      release = lockfile.lockSync(lockPath, options);
      break;
    } catch (e) {
      if (!isLocked(e)) throw e;
      const left = deadline - Date.now();
      if (left <= 0) throw new FenceTimeout(lockPath);
      Atomics.wait(sleeper, 0, 0, Math.min(jitterMs(), left));
    }
  }
  try {
    return fn();
  } finally {
    try {
      release();
    } catch {
      // ERELEASED after a compromise: the lock is a peer's now and not ours to remove.
    }
  }
}
