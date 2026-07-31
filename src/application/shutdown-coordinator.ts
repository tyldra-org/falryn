/**
 * The shutdown coordinator.
 *
 * It runs the canonical phase order, gives every phase a deadline, and reports
 * what did not finish. Three rules shape the implementation:
 *
 * - **A phase always ends.** A participant that hangs cannot hold the process,
 *   so the phase's deadline wins and the participant is recorded as unfinished.
 * - **A failure never hides another.** Participant failures are aggregated, and
 *   a failing participant does not stop its phase or the phases after it.
 * - **Force shortens, it does not skip.** Escalation reduces the remaining
 *   grace; every phase still runs, because skipping cleanup is how an
 *   unobserved result gets reported as a clean exit.
 *
 * The final outcome is `uncertain` whenever anything was left unfinished. That
 * is the whole point: the coordinator reports what it observed, not what it
 * expected.
 */

import {
  addDuration,
  type ClockPort,
  type Deadline,
  deadlineAt,
  duration,
  err,
  graceForLevel,
  type Instant,
  MAX_SHUTDOWN_PARTICIPANTS,
  ok,
  type ParticipantReport,
  type PhaseReport,
  type Result,
  SHUTDOWN_PHASES,
  type ShutdownError,
  type ShutdownLevel,
  type ShutdownParticipant,
  type ShutdownPhase,
  type ShutdownPhaseContext,
  type ShutdownReport,
  type TerminalOutcome,
} from "../domain/index.ts";
import type { ScopeTree } from "./scope-tree.ts";

/** Longest a failure message may be before it is truncated into the report. */
const MAX_FAILURE_MESSAGE_LENGTH = 200;

export type ShutdownOptions = {
  /** Starting urgency. Escalation may raise it, never lower it. */
  readonly level?: ShutdownLevel;
};

export type ShutdownCoordinator = {
  /**
   * Registers a participant for a phase.
   *
   * Rejected once shutdown has begun: its phase may already have run, and
   * silently never calling it would be worse than refusing.
   */
  register(participant: ShutdownParticipant): Result<void, ShutdownError>;

  /**
   * Runs the shutdown sequence.
   *
   * Idempotent. A second call returns the same in-flight or finished report
   * rather than starting a second sequence over half-torn-down state.
   */
  shutdown(options?: ShutdownOptions): Promise<ShutdownReport>;

  /** Raises urgency, shortening the grace remaining in the current and later phases. */
  escalate(level: ShutdownLevel): void;

  isShuttingDown(): boolean;
  level(): ShutdownLevel;
  registeredParticipants(): readonly { name: string; phase: ShutdownPhase }[];
};

export type ShutdownCoordinatorOptions = {
  readonly clock: ClockPort;
  /**
   * Cancelled during `cancel-root-scope`, and swept for anything still
   * non-terminal once every phase has run.
   */
  readonly scopeTree?: ScopeTree;
};

const LEVEL_RANK: Readonly<Record<ShutdownLevel, number>> = {
  graceful: 0,
  escalated: 1,
  forced: 2,
};

function safeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "non-error value thrown";
  return raw.length > MAX_FAILURE_MESSAGE_LENGTH
    ? `${raw.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}…`
    : raw;
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions,
): ShutdownCoordinator {
  const { clock, scopeTree } = options;
  const participants: ShutdownParticipant[] = [];

  let currentLevel: ShutdownLevel = "graceful";
  let started = false;
  let running: Promise<ShutdownReport> | null = null;
  /** Aborted whenever the level rises, so an in-flight phase can re-arm its wait. */
  let escalation = new AbortController();

  const raiseLevel = (level: ShutdownLevel): void => {
    if (LEVEL_RANK[level] <= LEVEL_RANK[currentLevel]) {
      return;
    }
    currentLevel = level;
    const previous = escalation;
    escalation = new AbortController();
    previous.abort();
  };

  const runPhase = async (phase: ShutdownPhase): Promise<PhaseReport> => {
    const startedAt = clock.now();
    const phaseParticipants = participants.filter((participant) => participant.phase === phase);

    const phaseController = new AbortController();
    let deadline: Deadline = deadlineAt(
      addDuration(startedAt, duration(graceForLevel(currentLevel))),
    );

    const reports = new Map<string, ParticipantReport>();
    const context: ShutdownPhaseContext = {
      phase,
      signal: phaseController.signal,
      deadline,
      clock,
      level: currentLevel,
    };

    // Built-in phase work runs before registered participants, so a participant
    // in `cancel-root-scope` observes an already-cancelled tree.
    if (phase === "cancel-root-scope" && scopeTree !== undefined) {
      scopeTree.cancel(scopeTree.root().scopeId, { kind: "shutdown" });
    }

    let outstanding = phaseParticipants.length;
    const settled = phaseParticipants.map((participant) =>
      participant.run(context).then(
        () => {
          reports.set(participant.name, {
            name: participant.name,
            status: "completed",
            failure: null,
          });
          outstanding -= 1;
        },
        (error: unknown) => {
          reports.set(participant.name, {
            name: participant.name,
            status: "failed",
            failure: safeFailureMessage(error),
          });
          outstanding -= 1;
        },
      ),
    );

    const allSettled = Promise.all(settled).then(() => "settled" as const);

    // Re-arm the wait whenever the level rises: escalation shortens the window
    // that is left rather than aborting work already in flight.
    let timedOut = false;
    while (outstanding > 0) {
      const shortened = deadlineAt(addDuration(clock.now(), duration(graceForLevel(currentLevel))));
      if (shortened.expiresAt < deadline.expiresAt) {
        deadline = shortened;
      }
      const waited = await Promise.race([
        allSettled,
        clock
          .waitUntil(deadline.expiresAt, escalation.signal)
          .then((outcome) => (outcome === "reached" ? ("expired" as const) : ("rearm" as const))),
      ]);
      if (waited === "settled") {
        break;
      }
      if (waited === "expired") {
        timedOut = true;
        break;
      }
    }

    phaseController.abort();

    const participantReports: ParticipantReport[] = phaseParticipants.map(
      (participant) =>
        reports.get(participant.name) ?? {
          name: participant.name,
          status: "timed-out",
          failure: null,
        },
    );

    const unfinished = participantReports.some((report) => report.status === "timed-out");
    return {
      phase,
      status: timedOut || unfinished ? "timed-out" : "completed",
      startedAt,
      endedAt: clock.now(),
      participants: participantReports,
    };
  };

  const run = async (startLevel: ShutdownLevel): Promise<ShutdownReport> => {
    raiseLevel(startLevel);
    const startedAt = clock.now();
    const phases: PhaseReport[] = [];

    for (const phase of SHUTDOWN_PHASES) {
      phases.push(await runPhase(phase));
    }

    // Nothing may be left non-terminal. Anything that never acknowledged is
    // uncertain: it was asked to stop and was not observed stopping.
    scopeTree?.forceSettleUnacknowledged();

    const participantReports = phases.flatMap((phase) => [...phase.participants]);
    const unfinished = participantReports
      .filter((report) => report.status === "timed-out")
      .map((report) => report.name);
    const failures = participantReports.filter((report) => report.status === "failed");

    const outcome: TerminalOutcome =
      unfinished.length > 0
        ? { kind: "uncertain", effect: "uncertain" }
        : failures.length > 0
          ? { kind: "failed", effect: "partial" }
          : { kind: "completed" };

    return {
      level: currentLevel,
      startedAt,
      endedAt: clock.now(),
      phases,
      unfinished,
      failures,
      outcome,
    };
  };

  return {
    register(participant: ShutdownParticipant): Result<void, ShutdownError> {
      if (started) {
        return err({ code: "shutdown-already-started", participant: participant.name });
      }
      if (participants.length >= MAX_SHUTDOWN_PARTICIPANTS) {
        return err({
          code: "participant-limit-exceeded",
          maximumParticipants: MAX_SHUTDOWN_PARTICIPANTS,
        });
      }
      const clash = participants.some(
        (existing) => existing.phase === participant.phase && existing.name === participant.name,
      );
      if (clash) {
        return err({
          code: "duplicate-participant",
          participant: participant.name,
          phase: participant.phase,
        });
      }
      participants.push(participant);
      return ok(undefined);
    },

    shutdown(shutdownOptions: ShutdownOptions = {}): Promise<ShutdownReport> {
      if (running !== null) {
        return running;
      }
      started = true;
      running = run(shutdownOptions.level ?? "graceful");
      return running;
    },

    escalate(level: ShutdownLevel): void {
      raiseLevel(level);
    },

    isShuttingDown(): boolean {
      return started;
    },

    level(): ShutdownLevel {
      return currentLevel;
    },

    registeredParticipants(): readonly { name: string; phase: ShutdownPhase }[] {
      return participants.map(({ name, phase }) => ({ name, phase }));
    },
  };
}

/** The instant a phase started under a given level, for callers reporting progress. */
export function phaseDeadlineFor(clock: ClockPort, level: ShutdownLevel): Instant {
  return addDuration(clock.now(), duration(graceForLevel(level)));
}
