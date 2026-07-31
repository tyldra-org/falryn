/**
 * Shutdown phase and participant contracts.
 *
 * The phase order is the contract. It runs outside-in — stop taking work, then
 * stop doing work, then make durable what was done, then release the host —
 * because every later phase depends on an earlier one having stopped producing
 * new state. Reordering it would let a component persist an outcome that a
 * still-running component immediately invalidates.
 *
 * This module declares the registry and the phase contract. It registers no
 * real participants: scheduling drain, persistence, artifacts, child-process
 * termination, and terminal restoration each register themselves from their
 * own owner.
 */

import type { ClockPort, Instant } from "./clock.ts";
import type { Deadline } from "./deadline.ts";
import type { TerminalOutcome } from "./outcome.ts";

export const SHUTDOWN_PHASES = [
  "stop-accepting-work",
  "cancel-root-scope",
  "stop-scheduling",
  "drain-events",
  "terminate-children",
  "finalize-artifacts",
  "persist-outcomes",
  "checkpoint-projections",
  "close-storage",
  "restore-terminal",
] as const;

export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];

export function isShutdownPhase(value: unknown): value is ShutdownPhase {
  return typeof value === "string" && (SHUTDOWN_PHASES as readonly string[]).includes(value);
}

/**
 * How hard the runtime is trying to stop.
 *
 * The level only ever increases, and it shortens grace, never skips a phase.
 * Skipping a phase is what produces the failure this whole module guards
 * against: an unknown result reported as a clean exit.
 */
export const SHUTDOWN_LEVELS = ["graceful", "escalated", "forced"] as const;

export type ShutdownLevel = (typeof SHUTDOWN_LEVELS)[number];

export type ShutdownPhaseContext = {
  readonly phase: ShutdownPhase;
  /** Aborts when the phase deadline expires or the level escalates. */
  readonly signal: AbortSignal;
  readonly deadline: Deadline;
  readonly clock: ClockPort;
  readonly level: ShutdownLevel;
};

export type ShutdownParticipant = {
  /** Stable within a phase; used to report what did not finish. */
  readonly name: string;
  readonly phase: ShutdownPhase;
  run(context: ShutdownPhaseContext): Promise<void>;
};

export type ParticipantStatus = "completed" | "failed" | "timed-out";

export type ParticipantReport = {
  readonly name: string;
  readonly status: ParticipantStatus;
  /**
   * A safe description of a failure.
   *
   * Carries the error's message only, never the error object, so a participant
   * cannot leak a stack, a file path, or a credential into a shutdown report
   * that is meant to be loggable.
   */
  readonly failure: string | null;
};

export type PhaseReport = {
  readonly phase: ShutdownPhase;
  readonly status: "completed" | "timed-out";
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly participants: readonly ParticipantReport[];
};

export type ShutdownReport = {
  readonly level: ShutdownLevel;
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly phases: readonly PhaseReport[];
  /** Participants that did not reach a terminal state before their phase ended. */
  readonly unfinished: readonly string[];
  /** Every participant failure, aggregated. A later failure never hides an earlier one. */
  readonly failures: readonly ParticipantReport[];
  /**
   * `completed` only when every participant finished. Anything left unfinished
   * makes the shutdown `uncertain`, because what it was doing was not observed.
   */
  readonly outcome: TerminalOutcome;
};

export type ShutdownError =
  /** Registration after shutdown began; the phase may already have run. */
  | { readonly code: "shutdown-already-started"; readonly participant: string }
  | {
      readonly code: "duplicate-participant";
      readonly participant: string;
      readonly phase: ShutdownPhase;
    }
  | { readonly code: "participant-limit-exceeded"; readonly maximumParticipants: number };

/** Registered participants allowed at once. A registry this size is already a defect. */
export const MAX_SHUTDOWN_PARTICIPANTS = 256;

/** Default grace for one phase when a caller names none. */
export const DEFAULT_PHASE_GRACE_MS = 5_000;

/** Grace applied once the level escalates. Shorter, never zero: cleanup still runs. */
export const ESCALATED_PHASE_GRACE_MS = 500;

/** Grace applied under force. Non-zero so a participant can still record what it knows. */
export const FORCED_PHASE_GRACE_MS = 50;

export function graceForLevel(level: ShutdownLevel): number {
  switch (level) {
    case "graceful":
      return DEFAULT_PHASE_GRACE_MS;
    case "escalated":
      return ESCALATED_PHASE_GRACE_MS;
    case "forced":
      return FORCED_PHASE_GRACE_MS;
  }
}
