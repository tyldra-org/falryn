/**
 * Schedule, cancel, time out, and join authorized tool work (#51).
 *
 * Consumes {@link PolicyAuthorizedInvocation} from #50. Validates a batch
 * graph (duplicates, unknown edges, cycles, queue bounds) and maps each item
 * onto a {@link WorkUnit} for the application scheduler. Execution is only
 * through a narrow runner; this module never calls tools. Typed result
 * envelopes and lifecycle hooks remain later #47 children (#52–#53).
 */

import type { Deadline } from "./deadline.ts";
import type { InvocationId, ScopeId } from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { SchedulingError, SchedulingResult } from "./scheduling.ts";
import {
  DEFAULT_MAX_TOOL_CALLS_PER_ITERATION,
  MAX_TOOL_CALLS_PER_ITERATION,
  type ToolInvocationOutcome,
  type ToolInvocationRecord,
} from "./tool-pipeline.ts";
import type { PolicyAuthorizedInvocation } from "./tool-policy.ts";
import { NO_RETRY, type WorkUnit, type WorkUnitId, workUnitId } from "./work.ts";

/** Schema version this build writes for planned tool-schedule batches. */
export const TOOL_SCHEDULE_SCHEMA_VERSION = 1;

export const TOOL_JOIN_POLICIES = ["all", "fail-fast", "partial"] as const;

export type ToolJoinPolicy = (typeof TOOL_JOIN_POLICIES)[number];

export function isToolJoinPolicy(value: unknown): value is ToolJoinPolicy {
  return typeof value === "string" && (TOOL_JOIN_POLICIES as readonly string[]).includes(value);
}

export type ToolScheduleItem = {
  readonly authorized: PolicyAuthorizedInvocation;
  /** Other invocation ids in the same batch that must complete first. */
  readonly dependencies?: readonly InvocationId[];
};

export type ToolScheduleRequest = {
  readonly items: readonly ToolScheduleItem[];
  readonly joinPolicy: ToolJoinPolicy;
  readonly maxQueued?: number;
  readonly deadline?: Deadline | null;
  readonly scopeId?: ScopeId | null;
};

export type ToolScheduleError =
  | { readonly code: "empty-batch" }
  | {
      readonly code: "queue-bound-exceeded";
      readonly maximum: number;
      readonly attempted: number;
    }
  | { readonly code: "invalid-join-policy"; readonly value: string }
  | { readonly code: "duplicate-invocation"; readonly invocationId: InvocationId }
  | {
      readonly code: "unknown-dependency";
      readonly invocationId: InvocationId;
      readonly dependsOn: InvocationId;
    }
  | { readonly code: "dependency-cycle"; readonly invocationIds: readonly InvocationId[] };

export type PlannedToolWork = {
  readonly schemaVersion: typeof TOOL_SCHEDULE_SCHEMA_VERSION;
  readonly authorized: PolicyAuthorizedInvocation;
  readonly unit: WorkUnit;
};

export type ToolSchedulePlan = {
  readonly schemaVersion: typeof TOOL_SCHEDULE_SCHEMA_VERSION;
  readonly joinPolicy: ToolJoinPolicy;
  readonly work: readonly PlannedToolWork[];
};

export function describeToolScheduleError(error: ToolScheduleError): string {
  switch (error.code) {
    case "empty-batch":
      return "empty-batch";
    case "queue-bound-exceeded":
      return "queue-bound-exceeded";
    case "invalid-join-policy":
      return "invalid-join-policy";
    case "duplicate-invocation":
      return "duplicate-invocation";
    case "unknown-dependency":
      return "unknown-dependency";
    case "dependency-cycle":
      return "dependency-cycle";
    default:
      return assertNever(error, "unhandled tool schedule error");
  }
}

export function workUnitIdForInvocation(id: InvocationId): WorkUnitId {
  return workUnitId(id);
}

/**
 * Validate a batch of policy-authorized invocations into scheduler work units.
 *
 * Fail closed before any executor runs. Nested work must appear in the same
 * batch; hidden child effects are rejected as unknown dependencies.
 */
export function planToolSchedule(
  request: ToolScheduleRequest,
): Result<ToolSchedulePlan, ToolScheduleError> {
  if (!isToolJoinPolicy(request.joinPolicy)) {
    return err({ code: "invalid-join-policy", value: String(request.joinPolicy) });
  }

  const items = request.items;
  if (items.length === 0) {
    return err({ code: "empty-batch" });
  }

  const maxQueued = clampQueue(request.maxQueued);
  if (items.length > maxQueued) {
    return err({
      code: "queue-bound-exceeded",
      maximum: maxQueued,
      attempted: items.length,
    });
  }

  const byInvocation = new Map<InvocationId, ToolScheduleItem>();
  for (const item of items) {
    const invocationId = item.authorized.invocation.invocationId;
    if (byInvocation.has(invocationId)) {
      return err({ code: "duplicate-invocation", invocationId });
    }
    byInvocation.set(invocationId, item);
  }

  for (const item of items) {
    const invocationId = item.authorized.invocation.invocationId;
    for (const dependsOn of item.dependencies ?? []) {
      if (!byInvocation.has(dependsOn)) {
        return err({ code: "unknown-dependency", invocationId, dependsOn });
      }
    }
  }

  const cycle = findInvocationCycle(items);
  if (cycle !== null) {
    return err({ code: "dependency-cycle", invocationIds: cycle });
  }

  const deadline = request.deadline ?? null;
  const scopeId = request.scopeId ?? null;
  const work: PlannedToolWork[] = items.map((item) => ({
    schemaVersion: TOOL_SCHEDULE_SCHEMA_VERSION,
    authorized: item.authorized,
    unit: workUnitForAuthorized(item, deadline, scopeId),
  }));

  return ok({
    schemaVersion: TOOL_SCHEDULE_SCHEMA_VERSION,
    joinPolicy: request.joinPolicy,
    work,
  });
}

export function workUnitForAuthorized(
  item: ToolScheduleItem,
  deadline: Deadline | null,
  scopeId: ScopeId | null,
): WorkUnit {
  const invocation = item.authorized.invocation;
  return {
    id: workUnitIdForInvocation(invocation.invocationId),
    effect: item.authorized.classification.effectClass,
    priority: "active-turn",
    conflictKeys: invocation.conflictKeys,
    dependencies: (item.dependencies ?? []).map(workUnitIdForInvocation),
    deadline,
    expectedOutputBytes: invocation.entry.manifest.limits.maxOutputBytes,
    retry: NO_RETRY,
    scopeId,
  };
}

export function toolRecordFromSchedulingResult(
  planned: PlannedToolWork,
  result: SchedulingResult<ToolInvocationOutcome>,
): ToolInvocationRecord {
  const invocation = planned.authorized.invocation;
  const base = {
    invocationId: invocation.invocationId,
    toolCallId: invocation.proposal.toolCallId,
    toolName: invocation.proposal.name,
    capabilityId: invocation.entry.descriptor.id,
    effectClass: planned.authorized.classification.effectClass,
  };

  switch (result.kind) {
    case "completed":
      return { ...base, outcome: result.value };
    case "refused":
      return { ...base, outcome: outcomeFromRefusal(result.error) };
    case "settled":
      return {
        ...base,
        outcome: outcomeFromSettled(result.outcome, result.partial),
      };
    default:
      return assertNever(result, "unhandled scheduling result");
  }
}

function outcomeFromRefusal(error: SchedulingError): ToolInvocationOutcome {
  switch (error.code) {
    case "dependency-cycle":
      return { status: "malformed", reason: "dependency-cycle", effect: "none" };
    case "unknown-dependency":
    case "duplicate-unit":
      return { status: "malformed", reason: error.code, effect: "none" };
    case "dependency-failed":
      return { status: "unavailable", reason: "dependency-failed", effect: "none" };
    case "lock-acquisition-timeout":
      return { status: "timed-out", effect: "none" };
    case "concurrency-limit":
    case "budget-exhausted":
      return { status: "unavailable", reason: error.code, effect: "none" };
    default:
      return assertNever(error, "unhandled scheduling refusal");
  }
}

function outcomeFromSettled(
  outcome: TerminalOutcome,
  partial: ToolInvocationOutcome | null,
): ToolInvocationOutcome {
  if (partial !== null) {
    return partial;
  }
  switch (outcome.kind) {
    case "completed":
      return { status: "completed", output: {}, effect: "completed" };
    case "failed":
      return { status: "failed", reason: "settled-failed", effect: outcome.effect };
    case "cancelled":
      return { status: "cancelled", effect: outcome.effect };
    case "timed-out":
      return { status: "timed-out", effect: outcome.effect };
    case "uncertain":
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "inspect-before-retry",
      };
    default:
      return assertNever(outcome, "unhandled settled terminal outcome");
  }
}

function clampQueue(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_MAX_TOOL_CALLS_PER_ITERATION;
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return DEFAULT_MAX_TOOL_CALLS_PER_ITERATION;
  }
  return Math.min(requested, MAX_TOOL_CALLS_PER_ITERATION);
}

function findInvocationCycle(items: readonly ToolScheduleItem[]): readonly InvocationId[] | null {
  const byId = new Map(
    items.map((item) => [item.authorized.invocation.invocationId, item] as const),
  );
  const state = new Map<InvocationId, "visiting" | "done">();
  const stack: InvocationId[] = [];

  const visit = (id: InvocationId): readonly InvocationId[] | null => {
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
    const item = byId.get(id);
    for (const dependsOn of item?.dependencies ?? []) {
      const found = visit(dependsOn);
      if (found !== null) {
        return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const item of items) {
    const found = visit(item.authorized.invocation.invocationId);
    if (found !== null) {
      return found;
    }
  }
  return null;
}
