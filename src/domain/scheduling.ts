/**
 * The scheduler port and its outcomes.
 *
 * Scheduling produces the same exhaustive terminal outcomes as everything else
 * in the runtime, plus the reasons a unit can be refused before it ever runs.
 * A refusal is not a failure of the work — the work never happened — so it
 * carries `effect: "none"` and is distinguishable from a unit that ran and
 * failed.
 */

import type { BudgetDimension } from "./budget.ts";
import type { Deadline } from "./deadline.ts";
import type { TerminalOutcome } from "./outcome.ts";
import type { ConflictKey, PriorityClass, WorkUnit, WorkUnitId } from "./work.ts";

export type SchedulingError =
  /** A dependency edge points at a unit that was never submitted. */
  | {
      readonly code: "unknown-dependency";
      readonly unitId: WorkUnitId;
      readonly dependsOn: WorkUnitId;
    }
  /** The dependency graph contains a cycle. Names the units on it. */
  | { readonly code: "dependency-cycle"; readonly units: readonly WorkUnitId[] }
  /** A dependency did not complete, so this unit never ran. */
  | {
      readonly code: "dependency-failed";
      readonly unitId: WorkUnitId;
      readonly dependsOn: WorkUnitId;
      readonly dependencyOutcome: TerminalOutcome;
    }
  | { readonly code: "duplicate-unit"; readonly unitId: WorkUnitId }
  /** A lock could not be taken before the acquisition deadline. Nothing ran. */
  | {
      readonly code: "lock-acquisition-timeout";
      readonly unitId: WorkUnitId;
      readonly conflictKey: ConflictKey;
      readonly deadline: Deadline;
    }
  | {
      readonly code: "concurrency-limit";
      readonly unitId: WorkUnitId;
      readonly limit: number;
    }
  | {
      readonly code: "budget-exhausted";
      readonly unitId: WorkUnitId;
      readonly dimension: BudgetDimension;
      readonly remaining: number;
    };

/**
 * What a caller can do about a refusal.
 *
 * A limit that reports only "no" leaves the caller guessing; naming the way
 * out is what makes degradation typed rather than opaque.
 */
export const RECOVERY_OPTIONS = [
  "retry-later",
  "raise-limit",
  "reduce-scope",
  "await-competing-work",
  "declare-conflict-keys",
  "resubmit-without-failed-dependency",
] as const;

export type RecoveryOption = (typeof RECOVERY_OPTIONS)[number];

/**
 * What happened to one submitted unit.
 *
 * `refused` means the unit never ran; every other variant means it started, so
 * its effect certainty is the scope's, not an assumption.
 */
export type SchedulingResult<Value> =
  | { readonly kind: "completed"; readonly unitId: WorkUnitId; readonly value: Value }
  | {
      readonly kind: "refused";
      readonly unitId: WorkUnitId;
      readonly error: SchedulingError;
      /** Always `none`: a refused unit did not run, so it changed nothing. */
      readonly outcome: TerminalOutcome;
      readonly recovery: readonly RecoveryOption[];
    }
  | {
      readonly kind: "settled";
      readonly unitId: WorkUnitId;
      readonly outcome: TerminalOutcome;
      /** Partial evidence gathered before the unit stopped, when there is any. */
      readonly partial: Value | null;
    };

export type SchedulerLimits = {
  /** Units running at once across the whole scheduler. */
  readonly maxConcurrent: number;
  /** Units running at once per conflict key. Serialization uses one. */
  readonly maxConcurrentPerKey: number;
  /** How long a unit waits for a contended lock before being refused. */
  readonly lockAcquisitionTimeoutMs: number;
  /**
   * Consecutive higher-priority units admitted before a waiting lower-priority
   * one is promoted. Bounds starvation without inverting priority.
   */
  readonly starvationThreshold: number;
};

export type QueueDepthByPriority = Readonly<Record<PriorityClass, number>>;

export type SchedulerReport = {
  readonly running: number;
  readonly queued: number;
  readonly queuedByPriority: QueueDepthByPriority;
  readonly heldKeys: readonly ConflictKey[];
  readonly completed: number;
  readonly refused: number;
  readonly settledNonCompleted: number;
  /** Times a waiting unit was promoted ahead of its class to prevent starvation. */
  readonly promotions: number;
};

/**
 * Runs one unit of work.
 *
 * `reportPartial` is how evidence survives a stop: a runner that has produced
 * something useful before being cancelled or timed out publishes it, and the
 * scheduler returns it alongside the terminal outcome. Without it a cancelled
 * unit would discard work that was already done.
 */
export type WorkRunner<Value> = (context: {
  readonly unit: WorkUnit;
  readonly signal: AbortSignal;
  reportPartial(value: Value): void;
}) => Promise<Value>;

export type ScheduledWork<Value> = {
  readonly unit: WorkUnit;
  readonly run: WorkRunner<Value>;
};

export type SchedulerPort<Value> = {
  /**
   * Schedules one generation: a set of units whose dependency graph is
   * validated as a whole before any of them runs.
   *
   * Dependencies are within a generation. A cycle or an edge pointing outside
   * the generation is rejected before work starts, because discovering it
   * halfway through would leave part of the graph already executed.
   */
  schedule(
    generation: readonly ScheduledWork<Value>[],
    signal?: AbortSignal,
  ): Promise<readonly SchedulingResult<Value>[]>;

  /** Submits one independent unit. Equivalent to a generation of one. */
  submit(
    unit: WorkUnit,
    run: WorkRunner<Value>,
    signal?: AbortSignal,
  ): Promise<SchedulingResult<Value>>;

  report(): SchedulerReport;
};
