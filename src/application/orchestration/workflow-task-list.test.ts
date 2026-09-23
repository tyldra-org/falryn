import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { workflowNodeSchema } from "../../domain/orchestration/workflow-definition.ts";
import { taskValue } from "./process-task.fixtures.ts";
import { workAuthority, workFields, workScope } from "./work-queues.fixtures.ts";
import { createWorkQueueActions } from "./work-queues.ts";
import { workflowFixture } from "./workflow-execution.fixtures.ts";
import {
  bindTaskListWorkflowHost,
  prepareTaskListWorkflow,
  TaskListSelectionRefusal,
} from "./workflow-task-list.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
test("diamond cascades require accepted native evidence and duplicate resumes never launch again", async () => {
  const launched: string[] = [];
  const f = await workflowFixture(async (node, input) => {
    launched.push(String(input.item));
    if (input.item === "d")
      expect(input.prerequisites).toMatchObject({
        nodes: [
          expect.objectContaining({ state: "completed" }),
          expect.objectContaining({ state: "completed" }),
        ],
      });
    return {
      state: "completed",
      effect: "none",
      value: {},
      evidence: [{ handle: node.key, generation: "1", source: "agent-result" }],
    };
  });
  const authority = {
    ...workAuthority,
    workspaceId: f.host.owner.workspaceId,
    sessionId: f.host.owner.sessionId,
  };
  const scope = {
    ...workScope,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
  };
  const actions = createWorkQueueActions(
    createSqliteWorkQueueStore(f.database, { locator: scope.locator, durability: "durable" }),
    { resources: f.host.resources, authority, now: () => Number(f.clock.now()) },
  );
  const send = async (value: unknown) =>
    taskValue(await actions.execute(JSON.stringify(value), signal));
  let sequence = 0;
  const provenance = () => ({
    source: "list-source",
    sourceGeneration: "1",
    mutationId: `edit-${sequence++}`,
    reason: "test",
  });
  const read = async () => {
    const value = (await send({ version: 1, action: "resume" })).queue;
    if (!value) throw new Error("missing queue");
    return value;
  };
  async function mutate(operations: unknown[]) {
    const queue = await read();
    return send({
      version: 1,
      action: "mutate",
      queueId: queue.id,
      scopeGeneration: scope.generation,
      expectedRevision: queue.revision,
      ...provenance(),
      operations,
    });
  }
  async function accept(itemId: string) {
    const queue = await read();
    const item = (
      await send({
        version: 1,
        action: "show",
        queueId: queue.id,
        scopeGeneration: scope.generation,
        expectedRevision: queue.revision,
        itemId,
      })
    ).items?.[0];
    if (!item) throw new Error("missing item");
    await mutate([
      {
        kind: "validate",
        itemId,
        itemRevision: item.revision,
        criteriaRevision: item.criteriaRevision,
        claimGeneration: item.claimGeneration,
        evidence: item.evidence,
        authority: "user",
        verdict: "accept",
        reason: "Criteria verified",
      },
    ]);
  }
  try {
    await send({
      version: 1,
      action: "create",
      queueId: "queue-1",
      scope,
      objective: "Diamond",
      ...provenance(),
    });
    await mutate([
      ...["a", "b", "c", "d"].map((itemId) => ({
        kind: "add",
        itemId,
        fields: { ...workFields, agentType: "coder" },
      })),
      { kind: "link", itemId: "b", dependency: "a" },
      { kind: "link", itemId: "c", dependency: "a" },
      { kind: "link", itemId: "d", dependency: "b" },
      { kind: "link", itemId: "d", dependency: "c" },
    ]);
    const options = {
      actions,
      queue: await read(),
      selected: ["a", "b", "c", "d"],
      source: "list-source",
      sourceGeneration: "1",
      id: "user/tasks:diamond",
      signal,
      agent: (
        item: import("../../domain/orchestration/work-queue.ts").WorkItem,
        prerequisites:
          | import("../../domain/orchestration/workflow-definition.ts").WorkflowValue
          | null,
      ) => {
        const node = workflowNodeSchema.parse({
          key: item.id,
          kind: "agent",
          agentId: "coder",
          capabilities: [],
          effects: [],
          resultSchema: { type: "object", properties: {}, additionalProperties: false },
          input: {
            item: { from: "literal", value: item.id },
            ...(prerequisites ? { prerequisites } : {}),
          },
        });
        if (node.kind !== "agent") throw new Error("wrong node");
        return node;
      },
    };
    expect((await prepareTaskListWorkflow(options)).nodes).toHaveLength(1);
    const graph = await prepareTaskListWorkflow({ ...options, autoCascade: true });
    expect(launched).toEqual([]);
    const host = bindTaskListWorkflowHost(f.host, { actions, actor: authority.actor });
    const handle = { id: "cascade", generation: "1" };
    taskValue(await f.execution.admit({ handle, definition: graph, arguments: {} }, host, signal));
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched).toEqual(["a"]);
    await accept("a");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched.toSorted()).toEqual(["a", "b", "c"]);
    await accept("b");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched).toHaveLength(3);
    await accept("c");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched).toHaveLength(4);
    await accept("d");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("completed");
    taskValue(await f.execution.drive(handle, host, signal));
    expect(launched).toHaveLength(4);
  } finally {
    await f.close();
  }
});

test("group selection expands once at one revision and drives accepted native completion", async () => {
  const launched: string[] = [];
  const f = await workflowFixture(async (node, input) => {
    launched.push(String(input.item));
    return {
      state: "completed",
      effect: "none",
      value: {},
      evidence: [{ handle: node.key, generation: "1", source: "agent-result" }],
    };
  });
  const authority = {
    ...workAuthority,
    workspaceId: f.host.owner.workspaceId,
    sessionId: f.host.owner.sessionId,
  };
  const scope = {
    ...workScope,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
  };
  const actions = createWorkQueueActions(
    createSqliteWorkQueueStore(f.database, { locator: scope.locator, durability: "durable" }),
    { resources: f.host.resources, authority, now: () => Number(f.clock.now()) },
  );
  const send = async (value: unknown) =>
    taskValue(await actions.execute(JSON.stringify(value), signal));
  let sequence = 0;
  const read = async () => {
    const value = (await send({ version: 1, action: "resume" })).queue;
    if (!value) throw new Error("missing queue");
    return value;
  };
  const selection = async () => {
    const queue = await read();
    return {
      queueId: queue.id,
      scopeGeneration: scope.generation,
      expectedRevision: queue.revision,
    };
  };
  const mutate = async (operations: unknown[]) =>
    send({
      version: 2,
      action: "mutate",
      ...(await selection()),
      source: "list-source",
      sourceGeneration: "1",
      mutationId: `groups-${sequence++}`,
      reason: "test",
      operations,
    });
  const show = async (itemId: string) => {
    const item = (await send({ version: 1, action: "show", ...(await selection()), itemId }))
      .items?.[0];
    if (!item) throw new Error("missing item");
    return item;
  };
  const accept = async (itemId: string) => {
    const item = await show(itemId);
    await mutate([
      {
        kind: "validate",
        itemId,
        itemRevision: item.revision,
        criteriaRevision: item.criteriaRevision,
        claimGeneration: item.claimGeneration,
        evidence: item.evidence,
        authority: "user",
        verdict: "accept",
        reason: "Criteria verified",
      },
    ]);
  };
  const progress = async (groupId: string) =>
    (await send({ version: 2, action: "progress", ...(await selection()), groupId })).progress;
  const agent = (
    item: import("../../domain/orchestration/work-queue.ts").WorkItem,
    prerequisites: import("../../domain/orchestration/workflow-definition.ts").WorkflowValue | null,
  ) => {
    const node = workflowNodeSchema.parse({
      key: item.id,
      kind: "agent",
      agentId: "coder",
      capabilities: [],
      effects: [],
      resultSchema: { type: "object", properties: {}, additionalProperties: false },
      input: {
        item: { from: "literal", value: item.id },
        ...(prerequisites ? { prerequisites } : {}),
      },
    });
    if (node.kind !== "agent") throw new Error("wrong node");
    return node;
  };
  const task = (itemId: string) => ({
    kind: "add",
    itemId,
    fields: { ...workFields, agentType: "coder" },
  });
  const under = (nodeId: string, parentId: string) => ({
    kind: "place",
    nodeId,
    parentId,
    position: { at: "end" },
  });
  try {
    await send({
      version: 1,
      action: "create",
      queueId: "queue-1",
      scope,
      objective: "Groups",
      source: "list-source",
      sourceGeneration: "1",
      mutationId: "create",
      reason: "test",
    });
    await mutate([
      {
        kind: "group",
        groupId: "impl",
        subject: "Implementation",
        parentId: null,
        position: { at: "end" },
      },
      {
        kind: "group",
        groupId: "verify",
        subject: "Verification",
        parentId: null,
        position: { at: "end" },
      },
      ...["a", "b", "c", "d", "e"].map(task),
      under("a", "impl"),
      under("b", "impl"),
      under("c", "verify"),
      under("d", "verify"),
      under("e", "verify"),
      { kind: "link", itemId: "c", dependency: "a" },
      { kind: "cancel", itemId: "e" },
    ]);
    // d is already accepted and must never be relaunched.
    await mutate([
      {
        kind: "submit",
        itemId: "d",
        claimGeneration: 0,
        criteriaRevision: 1,
        evidence: [{ handle: "prior", generation: "1", source: "validator" }],
      },
    ]);
    await accept("d");

    const base = {
      actions,
      source: "list-source",
      sourceGeneration: "1",
      signal,
      agent,
      autoCascade: true,
    };
    const stale = await read();
    await mutate([{ kind: "rename", groupId: "impl", subject: "Build" }]);
    // A concurrent change is stale, never a smaller or adaptively re-expanded manifest.
    await expect(
      prepareTaskListWorkflow({
        ...base,
        queue: stale,
        groups: ["impl"],
        selected: [],
        id: "user/tasks:stale",
      }),
    ).rejects.toThrow("workflow-task-list-stale-page");

    const queue = await read();
    const graph = await prepareTaskListWorkflow({
      ...base,
      queue,
      // Overlapping selections expand each task once.
      groups: ["impl", "verify"],
      selected: ["a"],
      id: "user/tasks:groups",
    });
    expect(graph.taskList?.items.map((item) => String(item.id)).toSorted()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(JSON.parse(JSON.stringify(graph.taskList?.hierarchy)) as unknown).toEqual({
      revision: queue.revision,
      groups: ["impl", "verify"],
      excluded: { accepted: 1, archived: 0, cancelled: 1, blocked: [], unavailable: [] },
    });
    expect(graph.nodes.some((node) => node.kind === "join")).toBeTrue();

    // Later membership changes do not alter the frozen selection.
    await mutate([task("late"), under("late", "impl")]);
    const host = bindTaskListWorkflowHost(f.host, { actions, actor: authority.actor });
    const handle = { id: "groups", generation: "1" };
    taskValue(await f.execution.admit({ handle, definition: graph, arguments: {} }, host, signal));
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched.toSorted()).toEqual(["a", "b"]);
    expect((await show("a")).disposition).toBe("completion-claimed");
    await accept("a");
    await accept("b");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched.toSorted()).toEqual(["a", "b", "c"]);
    await accept("c");
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("completed");
    taskValue(await f.execution.drive(handle, host, signal));
    expect(launched).toHaveLength(3);
    expect(launched).not.toContain("d");
    expect(launched).not.toContain("late");
    expect(await progress("impl")).toMatchObject({ accepted: 2, total: 3 });
    expect(await progress("verify")).toMatchObject({ accepted: 2, total: 3, state: "in-progress" });

    // Nothing admissible, or more than the adapter admits, is refused before any launch.
    const done = await read();
    const empty = prepareTaskListWorkflow({
      ...base,
      queue: done,
      groups: ["verify"],
      selected: [],
      id: "user/tasks:empty",
    });
    await expect(empty).rejects.toBeInstanceOf(TaskListSelectionRefusal);
    await expect(empty).rejects.toThrow("workflow-task-list-selection-empty");
    await mutate([
      { kind: "group", groupId: "bulk", subject: "Bulk", parentId: null, position: { at: "end" } },
    ]);
    for (let start = 0; start < 260; start += 50)
      await mutate(
        Array.from(
          { length: Math.min(50, 260 - start) },
          (_, index) => `bulk-${start + index}`,
        ).flatMap((id) => [task(id), under(id, "bulk")]),
      );
    const bulkQueue = await read();
    const refused = await prepareTaskListWorkflow({
      ...base,
      queue: bulkQueue,
      groups: ["bulk"],
      selected: [],
      id: "user/tasks:bulk",
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TaskListSelectionRefusal);
    if (!(refused instanceof TaskListSelectionRefusal)) throw new Error("expected a refusal");
    expect(refused.code).toBe("selection-limit");
    expect(refused.manifest?.tasks).toHaveLength(260);
    expect(refused.handle).toEqual({
      queueId: "queue-1",
      revision: bulkQueue.revision,
      groups: ["bulk"],
      tasks: [],
    });
    expect(launched).toHaveLength(3);
  } finally {
    await f.close();
  }
});
