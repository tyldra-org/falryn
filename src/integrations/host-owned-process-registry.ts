/**
 * Registry of owned child process trees and the shutdown participant that
 * terminates them.
 *
 * Host adapters adopt every subprocess they spawn. On shutdown the participant
 * escalates each still-tracked tree through `escalateOwnedTree`, then reports
 * unfinished when a tree will not stop before its phase ends.
 */

import {
  addDuration,
  duration,
  type ShutdownParticipant,
  type ShutdownPhaseContext,
} from "../domain/index.ts";
import { escalateOwnedTree, processIsAlive } from "./host-process-tree.ts";

/** Stable across builds: shutdown reports name unfinished participants by it. */
export const OWNED_PROCESS_SHUTDOWN_PARTICIPANT = "owned-process-termination";

const TERMINATE_POLL_MS = 10;

export type OwnedProcessRegistry = {
  /** Track an owned child until its `exited` promise settles. */
  adopt(pid: number, exited: Promise<unknown>): void;
};

export type OwnedProcessRegistryBundle = {
  readonly registry: OwnedProcessRegistry;
  readonly shutdownParticipant: ShutdownParticipant;
};

type TrackedProcess = {
  readonly pid: number;
  readonly exited: Promise<unknown>;
};

export function createOwnedProcessRegistry(): OwnedProcessRegistryBundle {
  const tracked = new Map<number, TrackedProcess>();

  const registry: OwnedProcessRegistry = {
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
    run: (context) => terminateTracked(tracked, context),
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
