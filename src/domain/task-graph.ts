/**
 * Represent dependencies, blockers, joins, and completion criteria (#124).
 *
 * The graph is advice over already-bounded task identities. It does not
 * execute work, mark a task complete, recommend validation, or project
 * progress. A declared blocker is an external impediment, not another task.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import { type OutcomeId, outcomeId, type TaskId, taskId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const TASK_GRAPH_VERSION = "task-graph.v1";
export const TASK_GRAPH_SOURCE = "deterministic-structure";
export const MAX_GRAPH_TASKS = 16;
export const MAX_GRAPH_EDGES = 32;
export const MAX_GRAPH_BLOCKERS = 16;
export const MAX_GRAPH_CRITERIA = 16;
export const MAX_GRAPH_TEXT_BYTES = 512;

export const TASK_JOIN_POLICIES = ["all", "any"] as const;
export type TaskJoinPolicy = (typeof TASK_JOIN_POLICIES)[number];

export const TASK_GRAPH_READINESS = ["ready", "waiting", "blocked"] as const;
export type TaskGraphReadiness = (typeof TASK_GRAPH_READINESS)[number];

export type TaskGraphErrorCode =
  | "cancelled"
  | "cycle"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "unsupported";

export type TaskGraphError = {
  readonly kind: "task-graph";
  readonly code: TaskGraphErrorCode;
  readonly field: string | null;
};

export type TaskGraphProvenance = {
  readonly version: typeof TASK_GRAPH_VERSION;
  readonly source: typeof TASK_GRAPH_SOURCE;
  readonly model: null;
};

export type TaskGraphBlocker = {
  readonly taskId: TaskId;
  readonly reason: string;
};

export type TaskCompletionCriterion = {
  readonly taskId: TaskId;
  readonly criterion: string;
};

export type TaskGraphNode = {
  readonly taskId: TaskId;
  readonly dependsOn: readonly TaskId[];
  readonly blockers: readonly string[];
  readonly join: TaskJoinPolicy;
  readonly completionCriteria: readonly string[];
  readonly readiness: TaskGraphReadiness;
};

export type TaskGraph = {
  readonly outcomeId: OutcomeId;
  readonly nodes: readonly TaskGraphNode[];
  readonly provenance: TaskGraphProvenance;
};

export type TaskGraphInput = {
  readonly outcomeId: unknown;
  readonly tasks: unknown;
  readonly dependencies?: unknown;
  readonly blockers?: unknown;
  readonly joins?: unknown;
  readonly criteria?: unknown;
  readonly model?: unknown;
};

const encoder = new TextEncoder();

function graphError(code: TaskGraphErrorCode, field: string | null): TaskGraphError {
  return { kind: "task-graph", code, field };
}

export function isTaskJoinPolicy(value: unknown): value is TaskJoinPolicy {
  return typeof value === "string" && (TASK_JOIN_POLICIES as readonly string[]).includes(value);
}

export function describeTaskGraphError(error: TaskGraphError): string {
  const field = error.field === null ? "graph" : error.field;
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
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-graph error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, TaskGraphError> {
  if (typeof value !== "string") {
    return err(graphError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(graphError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(graphError("empty", field));
  }
  if (byteLength(trimmed) > maxBytes) {
    return err(graphError("oversized", field));
  }
  return ok(trimmed);
}

function parseTaskIds(value: unknown): Result<readonly TaskId[], TaskGraphError> {
  if (!Array.isArray(value)) {
    return err(graphError("malformed", "tasks"));
  }
  if (value.length > MAX_GRAPH_TASKS) {
    return err(graphError("oversized", "tasks"));
  }
  const ids: TaskId[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const parsed = taskId.parse(entry);
    if (!parsed.ok) {
      return err(graphError("malformed", `tasks.${index}`));
    }
    if (seen.has(parsed.value)) {
      return err(graphError("malformed", `tasks.${index}`));
    }
    seen.add(parsed.value);
    ids.push(parsed.value);
  }
  if (ids.length === 0) {
    return err(graphError("empty", "tasks"));
  }
  return ok(ids);
}

const dependencySchema = z
  .object({
    predecessor: brandedString(taskId),
    successor: brandedString(taskId),
  })
  .strict();

const blockerSchema = z
  .object({
    taskId: brandedString(taskId),
    reason: z.string(),
  })
  .strict();

const joinSchema = z
  .object({
    taskId: brandedString(taskId),
    policy: z.enum(TASK_JOIN_POLICIES),
  })
  .strict();

const criterionSchema = z
  .object({
    taskId: brandedString(taskId),
    criterion: z.string(),
  })
  .strict();

function knownTask(
  id: TaskId,
  known: ReadonlySet<string>,
  field: string,
): Result<TaskId, TaskGraphError> {
  return known.has(id) ? ok(id) : err(graphError("malformed", field));
}

function parseDependencies(
  value: unknown,
  known: ReadonlySet<string>,
): Result<readonly { readonly predecessor: TaskId; readonly successor: TaskId }[], TaskGraphError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(graphError("malformed", "dependencies"));
  }
  if (value.length > MAX_GRAPH_EDGES) {
    return err(graphError("oversized", "dependencies"));
  }
  const edges: { readonly predecessor: TaskId; readonly successor: TaskId }[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const parsed = dependencySchema.safeParse(entry);
    if (!parsed.success) {
      return err(graphError("malformed", `dependencies.${index}`));
    }
    if (parsed.data.predecessor === parsed.data.successor) {
      return err(graphError("malformed", `dependencies.${index}`));
    }
    const predecessor = knownTask(
      parsed.data.predecessor,
      known,
      `dependencies.${index}.predecessor`,
    );
    if (!predecessor.ok) {
      return predecessor;
    }
    const successor = knownTask(parsed.data.successor, known, `dependencies.${index}.successor`);
    if (!successor.ok) {
      return successor;
    }
    const key = `${predecessor.value}\0${successor.value}`;
    if (seen.has(key)) {
      return err(graphError("malformed", `dependencies.${index}`));
    }
    seen.add(key);
    edges.push({ predecessor: predecessor.value, successor: successor.value });
  }
  return ok(edges);
}

function parseBlockers(
  value: unknown,
  known: ReadonlySet<string>,
): Result<readonly TaskGraphBlocker[], TaskGraphError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(graphError("malformed", "blockers"));
  }
  if (value.length > MAX_GRAPH_BLOCKERS) {
    return err(graphError("oversized", "blockers"));
  }
  const items: TaskGraphBlocker[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = blockerSchema.safeParse(entry);
    if (!parsed.success) {
      return err(graphError("malformed", `blockers.${index}`));
    }
    const id = knownTask(parsed.data.taskId, known, `blockers.${index}.taskId`);
    if (!id.ok) {
      return id;
    }
    const reason = parseBoundedText(
      parsed.data.reason,
      `blockers.${index}.reason`,
      MAX_GRAPH_TEXT_BYTES,
    );
    if (!reason.ok) {
      return reason;
    }
    items.push({ taskId: id.value, reason: reason.value });
  }
  return ok(items);
}

function parseJoins(
  value: unknown,
  known: ReadonlySet<string>,
): Result<ReadonlyMap<TaskId, TaskJoinPolicy>, TaskGraphError> {
  const policies = new Map<TaskId, TaskJoinPolicy>();
  if (value === undefined) {
    return ok(policies);
  }
  if (!Array.isArray(value)) {
    return err(graphError("malformed", "joins"));
  }
  if (value.length > MAX_GRAPH_TASKS) {
    return err(graphError("oversized", "joins"));
  }
  for (const [index, entry] of value.entries()) {
    const parsed = joinSchema.safeParse(entry);
    if (!parsed.success) {
      return err(graphError("malformed", `joins.${index}`));
    }
    const id = knownTask(parsed.data.taskId, known, `joins.${index}.taskId`);
    if (!id.ok) {
      return id;
    }
    if (policies.has(id.value)) {
      return err(graphError("malformed", `joins.${index}.taskId`));
    }
    policies.set(id.value, parsed.data.policy);
  }
  return ok(policies);
}

function parseCriteria(
  value: unknown,
  known: ReadonlySet<string>,
): Result<readonly TaskCompletionCriterion[], TaskGraphError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(graphError("malformed", "criteria"));
  }
  if (value.length > MAX_GRAPH_CRITERIA) {
    return err(graphError("oversized", "criteria"));
  }
  const items: TaskCompletionCriterion[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = criterionSchema.safeParse(entry);
    if (!parsed.success) {
      return err(graphError("malformed", `criteria.${index}`));
    }
    const id = knownTask(parsed.data.taskId, known, `criteria.${index}.taskId`);
    if (!id.ok) {
      return id;
    }
    const criterion = parseBoundedText(
      parsed.data.criterion,
      `criteria.${index}.criterion`,
      MAX_GRAPH_TEXT_BYTES,
    );
    if (!criterion.ok) {
      return criterion;
    }
    items.push({ taskId: id.value, criterion: criterion.value });
  }
  return ok(items);
}

function findCycle(
  taskIds: readonly TaskId[],
  dependsOn: ReadonlyMap<TaskId, readonly TaskId[]>,
): readonly TaskId[] | null {
  const state = new Map<TaskId, "visiting" | "done">();
  const stack: TaskId[] = [];

  const visit = (id: TaskId): readonly TaskId[] | null => {
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
    for (const predecessor of dependsOn.get(id) ?? []) {
      const found = visit(predecessor);
      if (found !== null) {
        return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of taskIds) {
    const found = visit(id);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function readinessFor(
  dependsOn: readonly TaskId[],
  blockers: readonly string[],
): TaskGraphReadiness {
  if (blockers.length > 0) {
    return "blocked";
  }
  if (dependsOn.length > 0) {
    return "waiting";
  }
  return "ready";
}

/**
 * Builds a static task graph from declared identities and overlays.
 *
 * Dependencies name other tasks in this graph. Blockers name external
 * impediments. Join policy says whether every predecessor or any predecessor
 * is required. Completion criteria are declared statements, not validation
 * recommendations and not observed progress.
 */
export function planTaskGraph(
  input: TaskGraphInput,
  signal?: AbortSignal,
): Result<TaskGraph, TaskGraphError> {
  if (signal?.aborted) {
    return err(graphError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(graphError("unsupported", "model"));
  }
  const id = outcomeId.parse(input.outcomeId);
  if (!id.ok) {
    return err(graphError("malformed", "outcomeId"));
  }
  const tasks = parseTaskIds(input.tasks);
  if (!tasks.ok) {
    return tasks;
  }
  const known = new Set<string>(tasks.value);
  const dependencies = parseDependencies(input.dependencies, known);
  if (!dependencies.ok) {
    return dependencies;
  }
  const blockers = parseBlockers(input.blockers, known);
  if (!blockers.ok) {
    return blockers;
  }
  const joins = parseJoins(input.joins, known);
  if (!joins.ok) {
    return joins;
  }
  const criteria = parseCriteria(input.criteria, known);
  if (!criteria.ok) {
    return criteria;
  }

  const dependsOn = new Map<TaskId, TaskId[]>();
  for (const task of tasks.value) {
    dependsOn.set(task, []);
  }
  for (const edge of dependencies.value) {
    const list = dependsOn.get(edge.successor);
    if (list === undefined) {
      return err(graphError("malformed", "dependencies"));
    }
    if (!list.includes(edge.predecessor)) {
      list.push(edge.predecessor);
    }
  }
  const cycle = findCycle(tasks.value, dependsOn);
  if (cycle !== null) {
    return err(graphError("cycle", "dependencies"));
  }

  const blockersByTask = new Map<TaskId, string[]>();
  const criteriaByTask = new Map<TaskId, string[]>();
  for (const task of tasks.value) {
    blockersByTask.set(task, []);
    criteriaByTask.set(task, []);
  }
  for (const blocker of blockers.value) {
    blockersByTask.get(blocker.taskId)?.push(blocker.reason);
  }
  for (const item of criteria.value) {
    criteriaByTask.get(item.taskId)?.push(item.criterion);
  }

  const nodes: TaskGraphNode[] = tasks.value.map((task) => {
    const predecessors = dependsOn.get(task) ?? [];
    const taskBlockers = blockersByTask.get(task) ?? [];
    return {
      taskId: task,
      dependsOn: predecessors,
      blockers: taskBlockers,
      join: joins.value.get(task) ?? "all",
      completionCriteria: criteriaByTask.get(task) ?? [],
      readiness: readinessFor(predecessors, taskBlockers),
    };
  });

  return ok({
    outcomeId: id.value,
    nodes,
    provenance: {
      version: TASK_GRAPH_VERSION,
      source: TASK_GRAPH_SOURCE,
      model: null,
    },
  });
}
