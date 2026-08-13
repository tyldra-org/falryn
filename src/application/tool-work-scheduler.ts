/**
 * Schedule, execute, cancel, time out, and join authorized tool work (#51).
 *
 * Plans a batch in the domain, then runs it through {@link SchedulerPort} and
 * {@link ToolRunnerPort}. Providers, UI, and agents never execute tools.
 * Typed result envelopes and hooks remain later #47 children (#52–#53).
 */

import {
  assertNever,
  type ClockPort,
  DEFAULT_MAX_CONCURRENT_TOOLS,
  type Deadline,
  effectOfToolOutcome,
  foldToolEffects,
  MAX_CONCURRENT_TOOLS,
  planToolSchedule,
  type ScopeId,
  type ToolInvocationOutcome,
  type ToolInvocationRecord,
  type ToolJoinPolicy,
  type ToolScheduleError,
  type ToolScheduleItem,
  toolRecordFromSchedulingResult,
  type WorkRunner,
} from "../domain/index.ts";
import { createScheduler, type SchedulerOptions } from "./scheduler.ts";
import type { ToolRunnerPort } from "./tool-call-loop.ts";

export type ToolWorkSchedulerLimits = {
  readonly maxConcurrent: number;
};

export const DEFAULT_TOOL_WORK_SCHEDULER_LIMITS: ToolWorkSchedulerLimits = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT_TOOLS,
};

export type ToolWorkSchedulerOptions = {
  readonly clock: ClockPort;
  readonly runner: ToolRunnerPort;
  readonly limits?: Partial<ToolWorkSchedulerLimits>;
  readonly scheduler?: SchedulerOptions;
};

export type RunToolWorkInput = {
  readonly items: readonly ToolScheduleItem[];
  readonly joinPolicy: ToolJoinPolicy;
  readonly signal: AbortSignal;
  readonly abortAs?: "cancel" | "timeout";
  readonly maxQueued?: number;
  readonly deadline?: Deadline | null;
  readonly scopeId?: ScopeId | null;
};

export type ToolWorkBatchOutcome =
  | {
      readonly kind: "completed";
      readonly joinPolicy: ToolJoinPolicy;
      readonly records: readonly ToolInvocationRecord[];
      readonly effect: ReturnType<typeof foldToolEffects>;
    }
  | {
      readonly kind: "rejected";
      readonly error: ToolScheduleError;
      readonly effect: "none";
    };

export type ToolWorkScheduler = {
  run(input: RunToolWorkInput): Promise<ToolWorkBatchOutcome>;
};

function clampConcurrent(requested: number | undefined): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < 1) {
    return DEFAULT_MAX_CONCURRENT_TOOLS;
  }
  return Math.min(requested, MAX_CONCURRENT_TOOLS);
}

function isUnsuccessfulOutcome(outcome: ToolInvocationOutcome): boolean {
  switch (outcome.status) {
    case "completed":
    case "partial":
      return false;
    case "failed":
    case "uncertain":
    case "timed-out":
    case "denied":
    case "malformed":
    case "unavailable":
    case "cancelled":
      return true;
    default:
      return assertNever(outcome, "unhandled tool outcome for join");
  }
}

function abortOutcome(
  abortAs: "cancel" | "timeout",
  effectClass: ToolScheduleItem["authorized"]["classification"]["effectClass"],
  started: boolean,
): ToolInvocationOutcome {
  const effect = started && effectClass !== "observation" ? "uncertain" : "none";
  if (abortAs === "timeout") {
    return { status: "timed-out", effect };
  }
  return { status: "cancelled", effect };
}

function rejectWithOutcome(outcome: ToolInvocationOutcome): never {
  throw new Error(`tool-work:${outcome.status}`);
}

function applyAbortAs(
  records: readonly ToolInvocationRecord[],
  abortAs: "cancel" | "timeout",
): readonly ToolInvocationRecord[] {
  if (abortAs !== "timeout") {
    return records;
  }
  return records.map((record) => {
    if (record.outcome.status !== "cancelled") {
      return record;
    }
    return {
      ...record,
      outcome: { status: "timed-out", effect: record.outcome.effect },
    };
  });
}

export function createToolWorkScheduler(options: ToolWorkSchedulerOptions): ToolWorkScheduler {
  const maxConcurrent = clampConcurrent(options.limits?.maxConcurrent);
  const scheduler = createScheduler<ToolInvocationOutcome>({
    clock: options.clock,
    limits: {
      maxConcurrent,
      ...(options.scheduler?.limits ?? {}),
    },
    ...(options.scheduler?.budget === undefined ? {} : { budget: options.scheduler.budget }),
    ...(options.scheduler?.scopeTree === undefined
      ? {}
      : { scopeTree: options.scheduler.scopeTree }),
    ...(options.scheduler?.diagnostics === undefined
      ? {}
      : { diagnostics: options.scheduler.diagnostics }),
  });

  return {
    async run(input) {
      const planned = planToolSchedule({
        items: input.items,
        joinPolicy: input.joinPolicy,
        ...(input.maxQueued === undefined ? {} : { maxQueued: input.maxQueued }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      });
      if (!planned.ok) {
        return { kind: "rejected", error: planned.error, effect: "none" };
      }

      const generation = new AbortController();
      const onOuterAbort = (): void => {
        generation.abort();
      };
      input.signal.addEventListener("abort", onOuterAbort, { once: true });
      if (input.signal.aborted) {
        generation.abort();
      }

      const abortAs = input.abortAs ?? "cancel";
      const byUnitId = new Map(planned.value.work.map((item) => [item.unit.id, item] as const));

      try {
        const scheduled = planned.value.work.map((item) => ({
          unit: item.unit,
          run: async (context: Parameters<WorkRunner<ToolInvocationOutcome>>[0]) => {
            const authorized = item.authorized.invocation;
            const unsuccessful = (outcome: ToolInvocationOutcome): never => {
              context.reportPartial(outcome);
              if (planned.value.joinPolicy === "fail-fast") {
                queueMicrotask(() => generation.abort());
              }
              return rejectWithOutcome(outcome);
            };

            if (context.signal.aborted || generation.signal.aborted) {
              return unsuccessful(
                abortOutcome(abortAs, item.authorized.classification.effectClass, false),
              );
            }

            const child = new AbortController();
            const onAbort = (): void => {
              child.abort();
            };
            context.signal.addEventListener("abort", onAbort, { once: true });
            generation.signal.addEventListener("abort", onAbort, { once: true });
            if (context.signal.aborted || generation.signal.aborted) {
              child.abort();
            }

            try {
              const outcome = await options.runner.execute({
                invocationId: authorized.invocationId,
                toolCallId: authorized.proposal.toolCallId,
                toolName: authorized.proposal.name,
                capabilityId: authorized.entry.descriptor.id,
                version: authorized.entry.descriptor.version,
                effect: item.authorized.classification.effectClass,
                input: authorized.input,
                signal: child.signal,
              });
              if (child.signal.aborted && outcome.status === "completed") {
                return unsuccessful(
                  abortOutcome(abortAs, item.authorized.classification.effectClass, true),
                );
              }
              if (isUnsuccessfulOutcome(outcome)) {
                return unsuccessful(outcome);
              }
              return outcome;
            } catch (error) {
              if (error instanceof Error && error.message.startsWith("tool-work:")) {
                throw error;
              }
              const failed: ToolInvocationOutcome = {
                status: "failed",
                reason: "runner-error",
                effect:
                  item.authorized.classification.effectClass === "observation"
                    ? "none"
                    : "uncertain",
              };
              return unsuccessful(failed);
            } finally {
              context.signal.removeEventListener("abort", onAbort);
              generation.signal.removeEventListener("abort", onAbort);
            }
          },
        }));

        const results = await scheduler.schedule(scheduled, generation.signal);
        const records = applyAbortAs(
          results.map((result) => {
            const plannedWork = byUnitId.get(result.unitId);
            if (plannedWork === undefined) {
              throw new Error("scheduler returned an unknown work unit");
            }
            return toolRecordFromSchedulingResult(plannedWork, result);
          }),
          abortAs,
        );

        return {
          kind: "completed",
          joinPolicy: planned.value.joinPolicy,
          records,
          effect: foldToolEffects(records.map((record) => effectOfToolOutcome(record.outcome))),
        };
      } finally {
        input.signal.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}
