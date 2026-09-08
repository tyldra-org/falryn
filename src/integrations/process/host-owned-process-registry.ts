/**
 * Registry of owned child process trees and the shutdown participant that
 * terminates them.
 *
 * Host adapters adopt every subprocess they spawn. On shutdown the participant
 * escalates each still-tracked tree through `escalateOwnedTree`, then reports
 * unfinished when a tree will not stop before its phase ends.
 */

import { addDuration, duration } from "../../domain/foundation/index.ts";
import type {
  ShutdownParticipant,
  ShutdownPhaseContext,
} from "../../domain/orchestration/index.ts";
import { escalateOwnedTree, processIsAlive } from "./host-process-tree.ts";

/** Stable across builds: shutdown reports name unfinished participants by it. */
export const OWNED_PROCESS_SHUTDOWN_PARTICIPANT = "owned-process-termination";

const TERMINATE_POLL_MS = 10;

export type OwnedProcessRegistry = {
  /** Track an owned child until its `exited` promise settles. */
  adopt(pid: number, exited: Promise<unknown>): void;
  /** Transfer durable capture/store lifetime; normal dispatch drains after projecting its response. */
  retain(lifetime: OwnedProcessLifetime): boolean;
  drain(): Promise<boolean>;
};

export type OwnedProcessRegistryBundle = {
  readonly registry: OwnedProcessRegistry;
  readonly shutdownParticipant: ShutdownParticipant;
};

export type OwnedProcessLifetime = {
  interrupt(): void;
  drain(): Promise<boolean>;
};

type TrackedProcess = {
  readonly pid: number;
  readonly exited: Promise<unknown>;
};

export function createOwnedProcessRegistry(): OwnedProcessRegistryBundle {
  const tracked = new Map<number, TrackedProcess>();
  const lifetimes = new Set<OwnedProcessLifetime>();
  let draining: Promise<boolean> | null = null;
  let interrupted = false;

  const registry: OwnedProcessRegistry = {
    retain(lifetime) {
      if (draining !== null || lifetimes.size >= 64) return false;
      lifetimes.add(lifetime);
      if (interrupted) lifetime.interrupt();
      return true;
    },
    drain() {
      draining ??= Promise.all(
        [...lifetimes].map(async (lifetime) => {
          try {
            return await lifetime.drain();
          } catch {
            return false;
          } finally {
            lifetimes.delete(lifetime);
          }
        }),
      ).then((results) => results.every(Boolean));
      return draining;
    },
    adopt(pid, exited) {
      if (!isOwnedPid(pid)) {
        return;
      }
      tracked.set(pid, { pid, exited });
      void exited.finally(() => {
        tracked.delete(pid);
      });
    },
  };

  const shutdownParticipant: ShutdownParticipant = {
    name: OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
    phase: "terminate-children",
    async run(context) {
      interrupted = true;
      for (const lifetime of lifetimes) lifetime.interrupt();
      const [closed] = await Promise.all([registry.drain(), terminateTracked(tracked, context)]);
      if (!closed) return new Promise<void>(() => {});
    },
  };

  return { registry, shutdownParticipant };
}

async function terminateTracked(
  tracked: Map<number, TrackedProcess>,
  context: ShutdownPhaseContext,
): Promise<void> {
  while (tracked.size > 0) {
    const entries = [...tracked.entries()];
    const cleanups = await Promise.all(
      entries.map(([pid, { exited }]) => escalateOwnedTree({ pid, exited })),
    );

    for (const [pid] of entries) {
      if (!processIsAlive(pid)) {
        tracked.delete(pid);
      }
    }

    if (tracked.size === 0) {
      return;
    }

    const uncertain = cleanups.some((cleanup) => cleanup.certainty === "uncertain");
    if (context.signal.aborted || uncertain) {
      // Never resolve: the coordinator records this participant as unfinished
      // rather than claiming trees stopped when they were not observed stopping.
      return new Promise<void>(() => {});
    }

    await context.clock.waitUntil(
      addDuration(context.clock.now(), duration(TERMINATE_POLL_MS)),
      context.signal,
    );
  }
}

function isOwnedPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}
