import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { workflowNodeSchema } from "../../domain/orchestration/workflow-definition.ts";
import { taskValue } from "./process-task.fixtures.ts";
import { workAuthority, workFields, workScope } from "./work-queues.fixtures.ts";
import { createWorkQueueActions } from "./work-queues.ts";
import { workflowFixture } from "./workflow-execution.fixtures.ts";
import { bindTaskListWorkflowHost, prepareTaskListWorkflow } from "./workflow-task-list.ts";

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
