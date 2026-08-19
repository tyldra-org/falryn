/**
 * Project progress, partial completion, recovery, and next actions (#127).
 *
 * Composes the #124 task graph. Observed completion cannot skip unsatisfied
 * joins or declared blockers. The result is advice: this module does not
 * execute work or mark a task complete.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import { type OutcomeId, type TaskId, taskId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  planTaskGraph,
  type TaskGraphError,
  type TaskGraphInput,
  type TaskGraphNode,
} from "./task-graph.ts";

export const TASK_PROGRESS_VERSION = "task-progress.v1";
export const TASK_PROGRESS_SOURCE = "deterministic-observations";
export const MAX_PROGRESS_OBSERVATIONS = 16;
export const MAX_PROGRESS_NOTE_BYTES = 512;

export const TASK_OBSERVATION_STATUSES = [
  "not-started",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskObservationStatus = (typeof TASK_OBSERVATION_STATUSES)[number];

export const TASK_PROGRESS_STATES = [
  "pending",
  "in-progress",
  "complete",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type TaskProgressState = (typeof TASK_PROGRESS_STATES)[number];

export const TASK_PROGRESS_OVERALL = [
  "pending",
  "in-progress",
  "partial",
  "complete",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type TaskProgressOverall = (typeof TASK_PROGRESS_OVERALL)[number];

export const TASK_PROGRESS_ACTION_KINDS = ["resolve-blocker", "resume", "retry", "start"] as const;
export type TaskProgressActionKind = (typeof TASK_PROGRESS_ACTION_KINDS)[number];

export type TaskProgressErrorCode =
  | "cancelled"
  | "cycle"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "stale"
  | "unsupported";

export type TaskProgressError = {
  readonly kind: "task-progress";
  readonly code: TaskProgressErrorCode;
  readonly field: string | null;
};

export type TaskProgressProvenance = {
  readonly version: typeof TASK_PROGRESS_VERSION;
  readonly source: typeof TASK_PROGRESS_SOURCE;
  readonly model: null;
};

export type TaskObservation = {
  readonly taskId: TaskId;
  readonly status: TaskObservationStatus;
  readonly note: string | null;
};

export type TaskProgressNode = {
  readonly taskId: TaskId;
  readonly state: TaskProgressState;
  readonly joinSatisfied: boolean;
};

export type TaskProgressAction = {
  readonly kind: TaskProgressActionKind;
  readonly taskId: TaskId;
  readonly statement: string;
};

export type TaskProgressProjection = {
  readonly outcomeId: OutcomeId;
  readonly overall: TaskProgressOverall;
  readonly nodes: readonly TaskProgressNode[];
  readonly nextActions: readonly TaskProgressAction[];
  readonly omittedTasks: readonly TaskId[];
  readonly provenance: TaskProgressProvenance;
};

export type TaskProgressInput = TaskGraphInput & {
  readonly observations?: unknown;
};

const encoder = new TextEncoder();

function progressError(code: TaskProgressErrorCode, field: string | null): TaskProgressError {
  return { kind: "task-progress", code, field };
}

export function describeTaskProgressError(error: TaskProgressError): string {
  const field = error.field === null ? "progress" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "cycle":
      return `cycle ${field}`;
    case "empty":
      return `empty ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return `secret ${field}`;
    case "stale":
      return `stale ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-progress error");
  }
}

function fromGraph(error: TaskGraphError): TaskProgressError {
  switch (error.code) {
    case "cancelled":
    case "cycle":
    case "empty":
    case "malformed":
    case "oversized":
    case "secret":
    case "unsupported":
      return progressError(error.code, error.field);
    default:
      return assertNever(error.code, "unhandled task-graph error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

const observationSchema = z
  .object({
    taskId: brandedString(taskId),
    status: z.enum(TASK_OBSERVATION_STATUSES),
    note: z.string().optional(),
  })
  .strict();

function parseNote(
  value: string | undefined,
  field: string,
): Result<string | null, TaskProgressError> {
  if (value === undefined) {
    return ok(null);
  }
  if (value.includes("\0")) {
    return err(progressError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(progressError("empty", field));
  }
  if (byteLength(trimmed) > MAX_PROGRESS_NOTE_BYTES) {
    return err(progressError("oversized", field));
  }
  return ok(trimmed);
}

function joinSatisfied(node: TaskGraphNode, completed: ReadonlySet<string>): boolean {
  if (node.dependsOn.length === 0) {
    return true;
  }
  switch (node.join) {
    case "all":
      return node.dependsOn.every((id) => completed.has(id));
    case "any":
      return node.dependsOn.some((id) => completed.has(id));
    default:
      return assertNever(node.join, "unhandled join policy");
  }
}

function parseObservations(
  value: unknown,
  known: ReadonlySet<string>,
): Result<ReadonlyMap<TaskId, TaskObservation>, TaskProgressError> {
  const observations = new Map<TaskId, TaskObservation>();
  if (value === undefined) {
    return ok(observations);
  }
  if (!Array.isArray(value)) {
    return err(progressError("malformed", "observations"));
  }
  if (value.length > MAX_PROGRESS_OBSERVATIONS) {
    return err(progressError("oversized", "observations"));
  }
  for (const [index, entry] of value.entries()) {
    const parsed = observationSchema.safeParse(entry);
    if (!parsed.success) {
      return err(progressError("malformed", `observations.${index}`));
    }
    if (!known.has(parsed.data.taskId)) {
      return err(progressError("malformed", `observations.${index}.taskId`));
    }
    if (observations.has(parsed.data.taskId)) {
      return err(progressError("malformed", `observations.${index}.taskId`));
    }
    const note = parseNote(parsed.data.note, `observations.${index}.note`);
    if (!note.ok) {
      return note;
    }
    observations.set(parsed.data.taskId, {
      taskId: parsed.data.taskId,
      status: parsed.data.status,
      note: note.value,
    });
  }
  return ok(observations);
}

function statementFor(kind: TaskProgressActionKind, node: TaskGraphNode): string {
  switch (kind) {
    case "resolve-blocker":
      return `Resolve blocker: ${node.blockers[0] ?? node.taskId}`;
    case "resume":
      return `Resume task ${node.taskId}`;
    case "retry":
      return `Retry task ${node.taskId}`;
    case "start":
      return `Start task ${node.taskId}`;
    default:
      return assertNever(kind, "unhandled task-progress action");
  }
}

function overallFor(states: readonly TaskProgressState[]): TaskProgressOverall {
  const complete = states.filter((state) => state === "complete").length;
  if (complete === states.length) {
    return "complete";
  }
  if (complete > 0) {
    return "partial";
  }
  if (states.some((state) => state === "in-progress")) {
    return "in-progress";
  }
  if (states.some((state) => state === "failed")) {
    return "failed";
  }
  if (states.some((state) => state === "cancelled")) {
    return "cancelled";
  }
  if (states.some((state) => state === "blocked")) {
    return "blocked";
  }
  return "pending";
}

/**
 * Projects observed task facts onto a static graph. Completion that skips an
 * unsatisfied join or a declared blocker is stale, not done.
 */
export function projectTaskProgress(
  input: TaskProgressInput,
  signal?: AbortSignal,
): Result<TaskProgressProjection, TaskProgressError> {
  if (signal?.aborted) {
    return err(progressError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(progressError("unsupported", "model"));
  }
  const graph = planTaskGraph(input, signal);
  if (!graph.ok) {
    return err(fromGraph(graph.error));
  }
  const known = new Set(graph.value.nodes.map((node) => node.taskId));
  const observations = parseObservations(input.observations, known);
  if (!observations.ok) {
    return observations;
  }
  const completed = new Set<string>();
  for (const observation of observations.value.values()) {
    if (observation.status === "completed") {
      completed.add(observation.taskId);
    }
  }
  const nodes: TaskProgressNode[] = [];
  const nextActions: TaskProgressAction[] = [];
  const omittedTasks: TaskId[] = [];

  for (const node of graph.value.nodes) {
    const satisfied = joinSatisfied(node, completed);
    const observation = observations.value.get(node.taskId);
    if (observation === undefined) {
      omittedTasks.push(node.taskId);
    }
    let state: TaskProgressState = "pending";
    if (observation?.status === "completed") {
      if (!satisfied || node.readiness === "blocked") {
        return err(progressError("stale", `observations.${node.taskId}`));
      }
      state = "complete";
    } else if (observation?.status === "failed") {
      state = "failed";
    } else if (observation?.status === "cancelled") {
      state = "cancelled";
    } else if (observation?.status === "in-progress") {
      if (!satisfied || node.readiness === "blocked") {
        return err(progressError("stale", `observations.${node.taskId}`));
      }
      state = "in-progress";
    } else if (node.readiness === "blocked") {
      state = "blocked";
    } else {
      state = "pending";
    }
    nodes.push({ taskId: node.taskId, state, joinSatisfied: satisfied });
    if (state === "blocked") {
      nextActions.push({
        kind: "resolve-blocker",
        taskId: node.taskId,
        statement: statementFor("resolve-blocker", node),
      });
    } else if (state === "cancelled") {
      nextActions.push({
        kind: "resume",
        taskId: node.taskId,
        statement: statementFor("resume", node),
      });
    } else if (state === "failed") {
      nextActions.push({
        kind: "retry",
        taskId: node.taskId,
        statement: statementFor("retry", node),
      });
    } else if (state === "pending" && satisfied && node.readiness !== "blocked") {
      nextActions.push({
        kind: "start",
        taskId: node.taskId,
        statement: statementFor("start", node),
      });
    }
  }

  nextActions.sort((left, right) => {
    const rank = (kind: TaskProgressActionKind): number => {
      switch (kind) {
        case "resolve-blocker":
          return 0;
        case "resume":
          return 1;
        case "retry":
          return 2;
        case "start":
          return 3;
        default:
          return assertNever(kind, "unhandled task-progress action rank");
      }
    };
    const delta = rank(left.kind) - rank(right.kind);
    return delta !== 0 ? delta : left.taskId.localeCompare(right.taskId);
  });

  return ok({
    outcomeId: graph.value.outcomeId,
    overall: overallFor(nodes.map((node) => node.state)),
    nodes,
    nextActions,
    omittedTasks,
    provenance: {
      version: TASK_PROGRESS_VERSION,
      source: TASK_PROGRESS_SOURCE,
      model: null,
    },
  });
}
