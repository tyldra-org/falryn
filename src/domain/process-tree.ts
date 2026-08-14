/**
 * Process-tree stop policy.
 *
 * Host adapters spawn an owned tree and escalate against that tree. This
 * module names the stages and cleanup certainty; it never holds a PID or
 * calls kill.
 */

import { assertNever } from "./result.ts";

/** Grace between SIGTERM to the owned group and SIGKILL. */
export const DEFAULT_PROCESS_TREE_GRACE_MS = 500;

/** Longest grace a caller may request. */
export const MAX_PROCESS_TREE_GRACE_MS = 5_000;

export const PROCESS_KILL_STAGES = ["none", "terminate", "kill", "unconfirmed"] as const;
export type ProcessKillStage = (typeof PROCESS_KILL_STAGES)[number];

export const PROCESS_TREE_CERTAINTIES = ["reaped", "uncertain"] as const;
export type ProcessTreeCertainty = (typeof PROCESS_TREE_CERTAINTIES)[number];

export type ProcessTreeCleanup = {
  readonly stage: ProcessKillStage;
  readonly certainty: ProcessTreeCertainty;
};

export function nextProcessTreeKill(stage: ProcessKillStage): Exclude<ProcessKillStage, "none"> {
  switch (stage) {
    case "none":
      return "terminate";
    case "terminate":
      return "kill";
    case "kill":
    case "unconfirmed":
      return "unconfirmed";
    default:
      return assertNever(stage, "unhandled process kill stage");
  }
}

export function processTreeCleanupAfter(
  stage: Exclude<ProcessKillStage, "none">,
  reaped: boolean,
): ProcessTreeCleanup {
  if (reaped) {
    return { stage, certainty: "reaped" };
  }
  if (stage === "kill") {
    return { stage: "unconfirmed", certainty: "uncertain" };
  }
  return { stage, certainty: "uncertain" };
}
