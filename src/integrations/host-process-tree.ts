/**
 * Owned process-tree spawn and kill escalation.
 *
 * POSIX children start in their own session (`detached`) so the child's PID is
 * the process-group ID. Escalation signals that group, then the leader, then
 * SIGKILL. Windows has no process-group primitive here: only the leader is
 * signalled, and host tree tests stay skipped.
 *
 * Never signal PID 1 or Falryn itself. Errors from kill are swallowed when the
 * target is already gone; they never include argv, cwd, or environment.
 */

import {
  DEFAULT_PROCESS_TREE_GRACE_MS,
  MAX_PROCESS_TREE_GRACE_MS,
  type ProcessTreeCleanup,
  processTreeCleanupAfter,
} from "../domain/index.ts";

const POSIX = process.platform !== "win32";

export function ownedTreeSpawnOptions(): { readonly detached: boolean } {
  return { detached: POSIX };
}

export function signalOwnedTree(pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
  if (!isSignalablePid(pid)) {
    return;
  }
  if (POSIX) {
    try {
      process.kill(-pid, signal);
    } catch {
      // No such group, or it already exited.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Leader already exited.
  }
}

export async function escalateOwnedTree(options: {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  readonly graceMs?: number;
}): Promise<ProcessTreeCleanup> {
  const graceMs = boundedGraceMs(options.graceMs);
  signalOwnedTree(options.pid, "SIGTERM");
  const terminated = await settledWithin(options.exited, graceMs);
  // Always SIGKILL the owned group. Leader exit is not proof that a grandchild
  // which ignored SIGHUP or SIGTERM is gone.
  signalOwnedTree(options.pid, "SIGKILL");
  if (terminated) {
    return processTreeCleanupAfter("terminate", true);
  }
  if (await settledWithin(options.exited, graceMs)) {
    return processTreeCleanupAfter("kill", true);
  }
  return processTreeCleanupAfter("kill", false);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedGraceMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return DEFAULT_PROCESS_TREE_GRACE_MS;
  }
  return Math.min(requested, MAX_PROCESS_TREE_GRACE_MS);
}

function isSignalablePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return (await Promise.race([promise.then(() => true as const), timeout])) === true;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
