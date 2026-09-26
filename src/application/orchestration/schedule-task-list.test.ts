import { expect, test } from "bun:test";
import { err, ok } from "../../domain/foundation/result.ts";
import type { ScheduleTaskListTarget } from "../../domain/orchestration/schedule-state.ts";
import { scheduleTaskListTargetSchema } from "../../domain/orchestration/schedule-state.ts";
import type { WorkflowRecord } from "../../domain/orchestration/workflow-state.ts";
import {
  awaitingTaskAcceptance,
  prepareScheduledTaskList,
  readScheduledSelection,
} from "./schedule-task-list.ts";
import { type ProductTaskLists, TaskListAgentRefusal } from "./work-queue-authority.ts";
import { TASK_LIST_ACCEPTANCE_WAIT, TaskListSelectionRefusal } from "./workflow-task-list.ts";

const signal = new AbortController().signal;
const target: ScheduleTaskListTarget = scheduleTaskListTargetSchema.parse({
  kind: "task-list",
  queueId: "todo",
  scopeGeneration: "scope-1",
  groups: ["outer"],
});
const queue = (kind = "project") => ({
  id: "todo",
  revision: 4,
  scope: { kind, generation: "scope-1" },
});
const manifest = (status = "admissible") => ({
  revision: 4,
  groups: ["outer"],
  tasks: [{ id: "a", status }],
});
function lists(
  responses: unknown[],
  prepare: ProductTaskLists["prepare"] = async () => {
    throw new Error("unexpected");
  },
): ProductTaskLists & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    actions: {
      async execute(json) {
        seen.push(JSON.parse(json));
        return responses.shift() as never;
      },
    },
    prepare,
  };
}
const stored = {
  async ingest(request: { artifactId: unknown; declaredByteLength: number }) {
    return ok({ record: request }) as never;
  },
};

test("selector schema requires unique stable IDs and defaults to no cascade", () => {
  expect(target.autoCascade).toBe(false);
  expect(target.tasks).toEqual([]);
  for (const invalid of [
    { groups: [], tasks: [] },
    { tasks: ["a", "a"] },
    { tasks: Array.from({ length: 257 }, (_, index) => `t${index}`) },
  ])
    expect(
      scheduleTaskListTargetSchema.safeParse({
        kind: "task-list",
        queueId: "todo",
        scopeGeneration: "scope-1",
        ...invalid,
      }).success,
    ).toBe(false);
});

test("reads repair bounded revision races and refuse session-bound or unavailable queues", async () => {
  const stale = (currentRevision: number) => err({ code: "stale-page", currentRevision });
  const repaired = lists([stale(4), ok({ queue: queue(), manifest: manifest() })]);
  expect(await readScheduledSelection(repaired.actions, target, signal)).toMatchObject({
    ok: true,
  });
  expect(
    repaired.seen.map((request) => (request as { expectedRevision: number }).expectedRevision),
  ).toEqual([0, 4]);
  expect(
    await readScheduledSelection(lists([stale(1), stale(2), stale(3)]).actions, target, signal),
  ).toEqual(err({ code: "task-list-selection-stale" }));
  expect(
    await readScheduledSelection(
      lists([ok({ queue: queue("session"), manifest: manifest() })]).actions,
      target,
      signal,
    ),
  ).toEqual(err({ code: "task-list-scope-unsupported" }));
  expect(
    await readScheduledSelection(lists([err({ code: "denied" })]).actions, target, signal),
  ).toEqual(err({ code: "task-list-denied" }));
});

test("occurrences freeze the manifest and settle refusals with no effect", async () => {
  const occurrence = (status: string, prepare?: ProductTaskLists["prepare"]) =>
    prepareScheduledTaskList({
      taskLists: lists([ok({ queue: queue(), manifest: manifest(status) })], prepare),
      artifacts: stored,
      target,
      attempt: "attempt-1",
      signal,
    });
  expect(await occurrence("accepted")).toMatchObject({
    kind: "settled",
    terminal: {
      status: "succeeded",
      effect: "none",
      reason: "task-list-no-work",
      result: { artifactId: "schedule-task-list-attempt-1" },
    },
  });
  const handle = { queueId: "todo", revision: 4, groups: [], tasks: [] };
  for (const [error, reason, status] of [
    [
      new TaskListSelectionRefusal("selection-empty", null, handle),
      "task-list-no-work",
      "succeeded",
    ],
    [
      new TaskListSelectionRefusal("graph-limit", null, handle),
      "task-list-graph-limit",
      "unavailable",
    ],
    [
      new TaskListAgentRefusal("workflow-task-list-agent-unavailable", "a"),
      "workflow-task-list-agent-unavailable",
      "unavailable",
    ],
    [new Error("workflow-task-list-stale-page"), "task-list-selection-stale", "unavailable"],
    [new Error("Not a reason"), "task-list-preparation-failed", "unavailable"],
  ] as const)
    expect(
      await occurrence("admissible", async () => {
        throw error;
      }),
    ).toMatchObject({ kind: "settled", terminal: { status, effect: "none", reason } });
  let prepared: unknown;
  const ready = await occurrence("admissible", async (selection) => {
    prepared = selection;
    return { id: "user/schedules:task-list" } as never;
  });
  expect(ready.kind).toBe("prepared");
  // The frozen manifest is the evidence source every claim and submission names.
  expect(prepared).toMatchObject({
    groups: ["outer"],
    selected: [],
    autoCascade: false,
    source: "schedule-task-list-attempt-1",
  });
});

test("a task-list run settles for its occurrence only when nothing executes and all waits are acceptance", () => {
  const run = (nodes: { state: string; reason?: string | null }[], state = "waiting") =>
    ({
      state,
      definition: { taskList: {} },
      nodes: nodes.map((node) => ({ reason: null, ...node })),
    }) as unknown as WorkflowRecord;
  const accepted = { state: "waiting", reason: TASK_LIST_ACCEPTANCE_WAIT };
  expect(awaitingTaskAcceptance(run([accepted, { state: "failed" }, { state: "pending" }]))).toBe(
    true,
  );
  expect(awaitingTaskAcceptance(run([accepted, { state: "running" }]))).toBe(false);
  expect(awaitingTaskAcceptance(run([accepted, { state: "waiting", reason: "question" }]))).toBe(
    false,
  );
  expect(awaitingTaskAcceptance(run([accepted], "running"))).toBe(false);
  expect(
    awaitingTaskAcceptance({ ...run([accepted]), definition: {} } as unknown as WorkflowRecord),
  ).toBe(false);
});
