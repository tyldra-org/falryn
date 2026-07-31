/**
 * The runtime's scheduling engine.
 *
 * It runs declared work units under declared limits. It knows nothing about
 * tools, providers, or jobs — only what a unit contends for, what it depends
 * on, and how urgent it is.
 *
 * Four rules shape the implementation:
 *
 * - **Independence is declared, never inferred.** A unit runs concurrently only
 *   when it holds no conflict key; a mutation that declared none is serialized
 *   globally rather than guessed to be safe.
 * - **The graph is validated whole.** Cycles and dangling edges are rejected
 *   before anything runs, because finding one halfway through would leave part
 *   of the graph already executed and unrewindable.
 * - **Priority orders, it never exempts.** A maintenance unit and an
 *   interactive one contending for the same key still run one at a time, and a
 *   waiting unit is promoted once it has been passed over enough times.
 * - **Locks release on every terminal path.** Completed, failed, cancelled,
 *   timed-out, refused — all of them free the keys, or the next unit waits
 *   forever on work that already ended.
 */

import {
  addDuration,
  type BudgetId,
  type ClockPort,
  type ConflictKey,
  type Deadline,
  deadlineAt,
  duration,
  effectiveConflictKeys,
  instant,
  type PriorityClass,
  priorityRank,
  type RecoveryOption,
  type ReservationId,
  type ScheduledWork,
  type SchedulerLimits,
  type SchedulerPort,
  type SchedulerReport,
  type SchedulingError,
  type SchedulingResult,
  type TerminalOutcome,
  type WorkRunner,
  type WorkUnit,
  type WorkUnitId,
} from "../domain/index.ts";
import type { BudgetLedger } from "./budget-ledger.ts";

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  maxConcurrent: 8,
  maxConcurrentPerKey: 1,
  lockAcquisitionTimeoutMs: 30_000,
  starvationThreshold: 8,
};

export type SchedulerBudget = {
  readonly ledger: BudgetLedger;
  readonly budgetId: BudgetId;
};

export type SchedulerOptions = {
  readonly clock: ClockPort;
  readonly limits?: Partial<SchedulerLimits>;
  /** When present, every unit reserves against it before it is admitted. */
  readonly budget?: SchedulerBudget;
};

type EntryState = "blocked" | "ready" | "running" | "settled";

type Entry<Value> = {
  readonly unit: WorkUnit;
  readonly run: WorkRunner<Value>;
  readonly index: number;
  readonly keys: readonly ConflictKey[];
  state: EntryState;
  /** When the unit first became dependency-ready, for the lock timeout. */
  readySince: number | null;
  /** How many times a higher-priority unit was admitted ahead of this one. */
  passedOver: number;
  result: SchedulingResult<Value> | null;
  partial: Value | null;
  controller: AbortController | null;
  reservation: ReservationId | null;
};

const NO_EFFECT: TerminalOutcome = { kind: "cancelled", effect: "none" };

function refusedOutcome(): TerminalOutcome {
  // A refused unit never ran, so nothing outside Falryn changed.
  return { kind: "failed", effect: "none" };
}

function recoveryFor(error: SchedulingError): readonly RecoveryOption[] {
  switch (error.code) {
    case "budget-exhausted":
      return ["raise-limit", "reduce-scope", "retry-later"];
    case "lock-acquisition-timeout":
      return ["await-competing-work", "retry-later"];
    case "concurrency-limit":
      return ["retry-later", "raise-limit"];
    case "dependency-failed":
      return ["resubmit-without-failed-dependency", "retry-later"];
    case "dependency-cycle":
    case "unknown-dependency":
      return ["reduce-scope"];
    case "duplicate-unit":
      return ["reduce-scope"];
  }
}

/**
 * Detects a cycle and names the units on it.
 *
 * Reports the cycle rather than just its existence: "there is a cycle" is not
 * actionable in a graph of any size.
 */
function findCycle(units: readonly WorkUnit[]): readonly WorkUnitId[] | null {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const state = new Map<WorkUnitId, "visiting" | "done">();
  const stack: WorkUnitId[] = [];

  const visit = (id: WorkUnitId): readonly WorkUnitId[] | null => {
    const current = state.get(id);
    if (current === "done") {
      return null;
    }
    if (current === "visiting") {
      const start = stack.indexOf(id);
      return stack.slice(start >= 0 ? start : 0);
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) {
        continue;
      }
      const cycle = visit(dependency);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const unit of units) {
    const cycle = visit(unit.id);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

export function createScheduler<Value>(options: SchedulerOptions): SchedulerPort<Value> {
  const { clock, budget } = options;
  const limits: SchedulerLimits = { ...DEFAULT_SCHEDULER_LIMITS, ...options.limits };

  /** Held keys and how many holders each has, shared across generations. */
  const held = new Map<ConflictKey, number>();
  let running = 0;
  let queued = 0;
  let queuedByPriority: Record<PriorityClass, number> = {
    interactive: 0,
    "active-turn": 0,
    "user-visible-background": 0,
    maintenance: 0,
  };
  const counters = { completed: 0, refused: 0, settledNonCompleted: 0, promotions: 0 };

  const keysAvailable = (keys: readonly ConflictKey[]): boolean =>
    keys.every((key) => (held.get(key) ?? 0) < limits.maxConcurrentPerKey);

  const acquire = (keys: readonly ConflictKey[]): void => {
    for (const key of keys) {
      held.set(key, (held.get(key) ?? 0) + 1);
    }
  };

  const release = (keys: readonly ConflictKey[]): void => {
    for (const key of keys) {
      const count = (held.get(key) ?? 0) - 1;
      if (count <= 0) {
        held.delete(key);
      } else {
        held.set(key, count);
      }
    }
  };

  const refuse = <V>(entry: Entry<V>, error: SchedulingError): void => {
    entry.state = "settled";
    entry.result = {
      kind: "refused",
      unitId: entry.unit.id,
      error,
      outcome: refusedOutcome(),
      recovery: recoveryFor(error),
    };
    counters.refused += 1;
  };

  const settle = <V>(entry: Entry<V>, outcome: TerminalOutcome): void => {
    entry.state = "settled";
    entry.result = {
      kind: "settled",
      unitId: entry.unit.id,
      outcome,
      partial: entry.partial,
    };
    counters.settledNonCompleted += 1;
  };

  async function runGeneration(
    work: readonly ScheduledWork<Value>[],
    signal?: AbortSignal,
  ): Promise<readonly SchedulingResult<Value>[]> {
    const entries: Entry<Value>[] = work.map((item, index) => ({
      unit: item.unit,
      run: item.run,
      index,
      keys: effectiveConflictKeys(item.unit),
      state: "blocked",
      readySince: null,
      passedOver: 0,
      result: null,
      partial: null,
      controller: null,
      reservation: null,
    }));
    const byId = new Map(entries.map((entry) => [entry.unit.id, entry]));

    // --- validate the whole graph before anything runs ---
    if (byId.size !== entries.length) {
      const seen = new Set<WorkUnitId>();
      for (const entry of entries) {
        if (seen.has(entry.unit.id)) {
          return entries.map((candidate) => ({
            kind: "refused" as const,
            unitId: candidate.unit.id,
            error: { code: "duplicate-unit" as const, unitId: entry.unit.id },
            outcome: refusedOutcome(),
            recovery: recoveryFor({ code: "duplicate-unit", unitId: entry.unit.id }),
          }));
        }
        seen.add(entry.unit.id);
      }
    }

    for (const entry of entries) {
      for (const dependency of entry.unit.dependencies) {
        if (!byId.has(dependency)) {
          const error: SchedulingError = {
            code: "unknown-dependency",
            unitId: entry.unit.id,
            dependsOn: dependency,
          };
          counters.refused += entries.length;
          return entries.map((candidate) => ({
            kind: "refused" as const,
            unitId: candidate.unit.id,
            error,
            outcome: refusedOutcome(),
            recovery: recoveryFor(error),
          }));
        }
      }
    }

    const cycle = findCycle(entries.map((entry) => entry.unit));
    if (cycle !== null) {
      const error: SchedulingError = { code: "dependency-cycle", units: cycle };
      counters.refused += entries.length;
      return entries.map((candidate) => ({
        kind: "refused" as const,
        unitId: candidate.unit.id,
        error,
        outcome: refusedOutcome(),
        recovery: recoveryFor(error),
      }));
    }

    // --- run ---
    const inflight = new Map<WorkUnitId, Promise<void>>();

    const dependenciesSettled = (entry: Entry<Value>): boolean =>
      entry.unit.dependencies.every((id) => byId.get(id)?.state === "settled");

    const failedDependencyOf = (entry: Entry<Value>): Entry<Value> | null => {
      for (const id of entry.unit.dependencies) {
        const dependency = byId.get(id);
        if (dependency?.result?.kind !== "completed") {
          return dependency ?? null;
        }
      }
      return null;
    };

    const start = (entry: Entry<Value>): void => {
      if (budget !== undefined) {
        const reservationId = `${entry.unit.id}:reservation` as ReservationId;
        const reserved = budget.ledger.reserve(budget.budgetId, reservationId, {
          operations: 1,
          bytes: entry.unit.expectedOutputBytes,
        });
        if (!reserved.ok) {
          const error: SchedulingError =
            reserved.error.code === "budget-exhausted"
              ? {
                  code: "budget-exhausted",
                  unitId: entry.unit.id,
                  dimension: reserved.error.dimension,
                  remaining: reserved.error.remaining,
                }
              : { code: "concurrency-limit", unitId: entry.unit.id, limit: limits.maxConcurrent };
          refuse(entry, error);
          return;
        }
        entry.reservation = reservationId;
      }

      acquire(entry.keys);
      entry.state = "running";
      running += 1;

      const controller = new AbortController();
      entry.controller = controller;
      const onOuterAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      const deadline: Deadline | null = entry.unit.deadline;
      const finish = (outcome: TerminalOutcome | "completed", value: Value | null): void => {
        release(entry.keys);
        running -= 1;
        signal?.removeEventListener("abort", onOuterAbort);
        if (budget !== undefined && entry.reservation !== null) {
          if (outcome === "completed") {
            budget.ledger.consume(entry.reservation, {
              operations: 1,
              bytes: entry.unit.expectedOutputBytes,
            });
          } else {
            budget.ledger.release(entry.reservation);
          }
        }
        if (outcome === "completed" && value !== null) {
          entry.state = "settled";
          entry.result = { kind: "completed", unitId: entry.unit.id, value };
          counters.completed += 1;
          return;
        }
        settle(entry, outcome === "completed" ? { kind: "completed" } : outcome);
      };

      const execution = (async (): Promise<void> => {
        const runPromise = entry
          .run({
            unit: entry.unit,
            signal: controller.signal,
            reportPartial: (value: Value) => {
              entry.partial = value;
            },
          })
          .then(
            (value) => ({ kind: "value" as const, value }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );

        // A runner that ignores its abort signal must not hold the scheduler.
        // The unit is settled as cancelled and the runner is abandoned, exactly
        // as a shutdown phase abandons a participant that will not stop.
        const abandoned = new Promise<{ readonly kind: "aborted" }>((resolve) => {
          if (controller.signal.aborted) {
            resolve({ kind: "aborted" });
            return;
          }
          controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
            once: true,
          });
        });

        const raced = await Promise.race([
          runPromise,
          abandoned,
          ...(deadline === null
            ? []
            : [
                clock
                  .waitUntil(deadline.expiresAt, controller.signal)
                  .then((waited) =>
                    waited === "reached"
                      ? ({ kind: "expired" } as const)
                      : ({ kind: "aborted" } as const),
                  ),
              ]),
        ]);

        if (raced.kind === "value") {
          finish("completed", raced.value);
          return;
        }
        if (raced.kind === "error") {
          finish(
            { kind: "failed", effect: entry.unit.effect === "observation" ? "none" : "uncertain" },
            null,
          );
          return;
        }
        if (raced.kind === "expired") {
          controller.abort();
          finish(
            {
              kind: "timed-out",
              effect: entry.unit.effect === "observation" ? "none" : "uncertain",
            },
            null,
          );
          return;
        }
        // The generation was cancelled while this unit was running.
        finish(
          {
            kind: "cancelled",
            effect: entry.unit.effect === "observation" ? "none" : "uncertain",
          },
          null,
        );
      })().finally(() => {
        inflight.delete(entry.unit.id);
      });

      inflight.set(entry.unit.id, execution);
    };

    const now = (): number => clock.now();

    /**
     * A unit's priority after aging.
     *
     * Never better than `interactive`, so aging bounds starvation without
     * letting a maintenance task outrank live interactive work indefinitely.
     */
    const effectiveRank = (entry: Entry<Value>): number =>
      Math.max(
        0,
        priorityRank(entry.unit.priority) -
          Math.floor(entry.passedOver / Math.max(1, limits.starvationThreshold)),
      );

    while (entries.some((entry) => entry.state !== "settled")) {
      if (signal?.aborted === true) {
        for (const entry of entries) {
          if (entry.state === "blocked" || entry.state === "ready") {
            settle(entry, NO_EFFECT);
          }
        }
        if (inflight.size > 0) {
          await Promise.race([...inflight.values()]);
          continue;
        }
        break;
      }

      // Promote blocked units whose dependencies have settled, and refuse the
      // ones whose dependency did not complete.
      for (const entry of entries) {
        if (entry.state !== "blocked" || !dependenciesSettled(entry)) {
          continue;
        }
        const failed = failedDependencyOf(entry);
        if (failed !== null) {
          refuse(entry, {
            code: "dependency-failed",
            unitId: entry.unit.id,
            dependsOn: failed.unit.id,
            dependencyOutcome:
              failed.result?.kind === "refused" || failed.result?.kind === "settled"
                ? failed.result.outcome
                : { kind: "failed", effect: "none" },
          });
          continue;
        }
        entry.state = "ready";
        entry.readySince = now();
      }

      const ready = entries.filter((entry) => entry.state === "ready");
      queued = ready.length;
      queuedByPriority = {
        interactive: 0,
        "active-turn": 0,
        "user-visible-background": 0,
        maintenance: 0,
      };
      for (const entry of ready) {
        queuedByPriority[entry.unit.priority] += 1;
      }

      // Order by effective priority: a waiting unit's class improves by one step
      // for every full starvation threshold it has been passed over.
      //
      // A flat "promoted" flag would not work — once every waiting unit has been
      // passed over enough times they are all flagged, the flag cancels out, and
      // the original priority order reasserts itself. Aging is relative, so a
      // unit that has waited longer genuinely overtakes one that has not.
      const ordered = [...ready].sort((left, right) => {
        const byEffective = effectiveRank(left) - effectiveRank(right);
        return byEffective !== 0 ? byEffective : left.index - right.index;
      });

      let admitted = 0;
      const skipped: Entry<Value>[] = [];
      for (const entry of ordered) {
        if (running >= limits.maxConcurrent || !keysAvailable(entry.keys)) {
          skipped.push(entry);
          continue;
        }
        if (effectiveRank(entry) < priorityRank(entry.unit.priority)) {
          counters.promotions += 1;
        }
        start(entry);
        admitted += 1;
      }
      for (const entry of skipped) {
        if (admitted > 0) {
          entry.passedOver += 1;
        }
      }

      // Refuse anything that waited past its lock acquisition deadline.
      const lockDeadlines = skipped
        .filter((entry) => entry.state === "ready" && entry.readySince !== null)
        .map((entry) => ({
          entry,
          expiresAt: (entry.readySince ?? 0) + limits.lockAcquisitionTimeoutMs,
        }));

      let timedOutAny = false;
      for (const candidate of lockDeadlines) {
        if (now() >= candidate.expiresAt) {
          const contended =
            candidate.entry.keys.find((key) => (held.get(key) ?? 0) > 0) ?? candidate.entry.keys[0];
          if (contended !== undefined) {
            refuse(candidate.entry, {
              code: "lock-acquisition-timeout",
              unitId: candidate.entry.unit.id,
              conflictKey: contended,
              deadline: deadlineAt(addDuration(clock.now(), duration(0))),
            });
          } else {
            refuse(candidate.entry, {
              code: "concurrency-limit",
              unitId: candidate.entry.unit.id,
              limit: limits.maxConcurrent,
            });
          }
          timedOutAny = true;
        }
      }
      if (timedOutAny) {
        continue;
      }

      if (inflight.size === 0) {
        if (admitted === 0) {
          // Nothing running and nothing admissible: the remaining units can
          // only be waiting on a lock nobody holds, which cannot happen. Refuse
          // rather than spin.
          for (const entry of entries) {
            if (entry.state !== "settled") {
              refuse(entry, {
                code: "concurrency-limit",
                unitId: entry.unit.id,
                limit: limits.maxConcurrent,
              });
            }
          }
        }
        continue;
      }

      const nextLockDeadline = lockDeadlines.reduce<number | null>(
        (earliest, candidate) =>
          earliest === null || candidate.expiresAt < earliest ? candidate.expiresAt : earliest,
        null,
      );

      if (nextLockDeadline === null) {
        await Promise.race([...inflight.values()]);
        continue;
      }

      // The lock-deadline wait is abandoned as soon as anything else settles,
      // or it would outlive the loop iteration and hold a timer for a deadline
      // that no longer matters.
      const lockWait = new AbortController();
      try {
        await Promise.race([
          ...inflight.values(),
          clock.waitUntil(instant(nextLockDeadline), lockWait.signal).then(() => undefined),
        ]);
      } finally {
        lockWait.abort();
      }
    }

    return entries.map(
      (entry) =>
        entry.result ?? {
          kind: "settled",
          unitId: entry.unit.id,
          outcome: NO_EFFECT,
          partial: entry.partial,
        },
    );
  }

  return {
    schedule(
      generation: readonly ScheduledWork<Value>[],
      signal?: AbortSignal,
    ): Promise<readonly SchedulingResult<Value>[]> {
      return runGeneration(generation, signal);
    },

    async submit(
      unit: WorkUnit,
      run: WorkRunner<Value>,
      signal?: AbortSignal,
    ): Promise<SchedulingResult<Value>> {
      const [result] = await runGeneration([{ unit, run }], signal);
      if (result === undefined) {
        throw new Error("scheduler returned no result for a submitted unit");
      }
      return result;
    },

    report(): SchedulerReport {
      return {
        running,
        queued,
        queuedByPriority,
        heldKeys: [...held.keys()],
        ...counters,
      };
    },
  };
}
