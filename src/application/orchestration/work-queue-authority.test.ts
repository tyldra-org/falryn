import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { ok } from "../../domain/foundation/result.ts";
import type { WorkItem, WorkQueue } from "../../domain/orchestration/work-queue.ts";
import type { WorkflowValue } from "../../domain/orchestration/workflow-definition.ts";
import type { WorkflowRecord } from "../../domain/orchestration/workflow-state.ts";
import { taskValue } from "./process-task.fixtures.ts";
import { createProductResources } from "./product-resources.ts";
import {
  createProductTaskLists,
  createProductWorkQueueActions,
  createProductWorkQueueAuthority,
  PRODUCT_WORK_ACTOR,
  type ProductWorkQueueAuthorityOptions,
  TaskListAgentRefusal,
  taskListAgentNode,
} from "./work-queue-authority.ts";
import { workFields, workScope } from "./work-queues.fixtures.ts";
import { createWorkQueueActions } from "./work-queues.ts";
import { workflowFixture } from "./workflow-execution.fixtures.ts";
import { bindTaskListWorkflowHost } from "./workflow-task-list.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;

const objective = { type: "string", maxLength: 8192, minLength: 1 };
function agentsWith(
  entries: Record<string, { availability?: string; inputSchema?: unknown }>,
): ProductWorkQueueAuthorityOptions["agents"] {
  return {
    resolve: (id: string) => {
      const entry = entries[id];
      if (entry === undefined) return null;
      return {
        id,
        digest: "digest",
        availability: entry.availability ?? "available",
        definition: {
          label: id,
          inputSchema: entry.inputSchema ?? {
            type: "object",
            properties: { objective },
            required: ["objective"],
            additionalProperties: false,
          },
          resultSchema: { type: "object", properties: {}, additionalProperties: false },
          capabilities: {
            required: ["builtin:workspace/read_file@1"],
            optional: ["builtin:workspace/search@1"],
          },
          effects: ["observation"],
        },
      } as never;
    },
  };
}

const availableSource = {
  get: (id: string) =>
    ok(
      id === "list-source"
        ? ({ availability: "available", finalizedAt: 1, digest: "1" } as never)
        : null,
    ),
};

function runWith(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    handle: { id: "run-1", generation: "generation-1" },
    state: "running",
    task: null,
    definition: { taskList: {} },
    nodes: [{ key: "node-a", invocation: "invoke-a", state: "running", effect: "none" }],
    ...overrides,
  } as never;
}

function authorityWith(
  run: WorkflowRecord | null,
  overrides: Partial<ProductWorkQueueAuthorityOptions> = {},
) {
  return createProductWorkQueueAuthority({
    role: "workflow",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    persistentSession: true,
    agents: agentsWith({ coder: {}, retired: { availability: "unavailable" } }),
    artifacts: availableSource as never,
    workflows: { find: (workspace) => ok(workspace === "workspace-1" ? run : null) },
    ...overrides,
  });
}

function claimed(taskId: string, generation = "generation-1"): WorkItem {
  return {
    claim: {
      generation: 1,
      holder: { taskId, generation, actor: PRODUCT_WORK_ACTOR },
      releasePending: false,
    },
  } as never;
}

test("authorizes host-workspace queues and refuses workflow queue creation", () => {
  const queue = { scope: { workspaceId: "workspace-1" } } as WorkQueue;
  const workflow = authorityWith(null);
  const user = authorityWith(null, { role: "user" });
  expect(workflow.actor).toBe(PRODUCT_WORK_ACTOR);
  expect(workflow.authorize(queue, "read")).toBe(true);
  expect(workflow.authorize(queue, "mutate")).toBe(true);
  expect(workflow.authorize(queue, "create")).toBe(false);
  expect(user.authorize(queue, "create")).toBe(true);
  expect(workflow.authorize({ scope: { workspaceId: "workspace-2" } } as WorkQueue, "read")).toBe(
    false,
  );
});

test("admits only registered agents and available artifact sources", () => {
  const authority = authorityWith(null);
  expect(authority.registeredAgent("coder")).toBe(true);
  expect(authority.registeredAgent("retired")).toBe(false);
  expect(authority.registeredAgent("missing")).toBe(false);
  expect(authority.sourceAvailable("list-source", "1")).toBe(true);
  expect(authority.sourceAvailable("list-source", "2")).toBe(false);
  expect(authority.sourceAvailable("other-source", "1")).toBe(false);
  expect(authority.sourceAvailable("not a valid id!", "1")).toBe(false);
});

test("admits a holder only for a live task-list run of this workspace", () => {
  const holder = { taskId: "invoke-a", generation: "generation-1", actor: PRODUCT_WORK_ACTOR };
  expect(authorityWith(runWith()).admitHolder(holder)).toBe(true);
  expect(authorityWith(runWith()).admitHolder({ ...holder, taskId: "node-a" })).toBe(true);
  expect(authorityWith(runWith()).admitHolder({ ...holder, actor: "someone-else" })).toBe(false);
  expect(authorityWith(runWith()).admitHolder({ ...holder, taskId: "node-z" })).toBe(false);
  expect(authorityWith(runWith({ state: "completed" })).admitHolder(holder)).toBe(false);
  expect(authorityWith(runWith({ definition: {} } as never)).admitHolder(holder)).toBe(false);
  expect(authorityWith(null).admitHolder(holder)).toBe(false);
});

test("observes the claimed node through the workflow store", () => {
  const node = (state: string, effect = "none") =>
    runWith({ nodes: [{ key: "node-a", invocation: "invoke-a", state, effect }] } as never);
  const observed = (run: WorkflowRecord | null, fenced = false) =>
    authorityWith(run, { fenced: () => fenced }).observeExecution(claimed("invoke-a"))?.state ??
    null;
  expect(observed(node("running"))).toBe("active");
  expect(observed(node("waiting"))).toBe("active");
  expect(
    observed(
      runWith({
        nodes: [
          {
            key: "node-a",
            invocation: "invoke-a",
            state: "waiting",
            effect: "none",
            reason: "workflow-task-list-acceptance-required",
          },
        ],
      } as never),
    ),
  ).toBe("settled");
  expect(observed(node("completed", "completed"))).toBe("settled");
  expect(observed(node("failed", "none"))).toBe("settled");
  expect(observed(node("uncertain", "uncertain"))).toBe("uncertain");
  expect(observed(node("completed", "uncertain"))).toBe("uncertain");
  expect(
    observed(
      runWith({
        state: "cancelled",
        nodes: [{ key: "node-a", invocation: null, state: "pending", effect: "none" }],
      } as never),
    ),
  ).toBe(null);
  expect(
    authorityWith(
      runWith({
        state: "cancelled",
        nodes: [{ key: "node-a", invocation: null, state: "pending", effect: "none" }],
      } as never),
    ).observeExecution(claimed("node-a"))?.state,
  ).toBe("settled");
  expect(observed({ ...node("running"), task: { id: "task-1" } } as never, true)).toBe("fenced");
  expect(observed(null)).toBe(null);
  expect(authorityWith(runWith()).observeExecution({ claim: null } as never)).toBe(null);
  expect(authorityWith(runWith()).observeExecution(claimed("invoke-a"))).toEqual({
    id: "run-1",
    generation: "generation-1",
    state: "active",
  });
});

test("only the user role validates, and only with user authority", () => {
  const input = { authority: "user", verdict: "accept", reason: "ok" } as never;
  expect(authorityWith(null).validateCompletion(input)).toBe(false);
  expect(authorityWith(null, { role: "user" }).validateCompletion(input)).toBe(true);
  expect(
    authorityWith(null, { role: "user" }).validateCompletion({
      ...(input as object),
      authority: "model",
    } as never),
  ).toBe(false);
});

test("builds agent nodes within the registered definition and refuses unusable agents", () => {
  const agents = agentsWith({
    coder: {},
    retired: { availability: "unavailable" },
    structured: { inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    tiny: {
      inputSchema: { type: "object", properties: { objective: { type: "string", maxLength: 10 } } },
    },
    chained: {
      inputSchema: { type: "object", properties: { objective, prerequisites: { type: "object" } } },
    },
  });
  const item = (agentType: string | null) => ({ ...workFields, id: "task-1", agentType }) as never;
  const prerequisites: WorkflowValue = { from: "node", node: "join", path: [] };
  const node = taskListAgentNode(agents, item("coder"), prerequisites);
  expect(node).toMatchObject({
    kind: "agent",
    agentId: "coder",
    capabilities: ["builtin:workspace/read_file@1", "builtin:workspace/search@1"],
    effects: ["observation"],
  });
  expect(Object.keys(node.input)).toEqual(["objective"]);
  expect(JSON.stringify(node.input)).toContain("Relevant validation passes");
  expect(Object.keys(taskListAgentNode(agents, item("chained"), prerequisites).input)).toEqual([
    "objective",
    "prerequisites",
  ]);
  const refusal = (agentType: string | null) => {
    try {
      taskListAgentNode(agents, item(agentType), null);
      return null;
    } catch (error) {
      return error instanceof TaskListAgentRefusal ? error.code : String(error);
    }
  };
  expect(refusal(null)).toBe("workflow-task-list-agent-required");
  expect(refusal("missing")).toBe("workflow-task-list-agent-unavailable");
  expect(refusal("retired")).toBe("workflow-task-list-agent-unavailable");
  expect(refusal("structured")).toBe("workflow-task-list-agent-input-unsupported");
  expect(refusal("tiny")).toBe("workflow-task-list-agent-input-limit");
});

test("a product task-list workflow claims, submits, waits for the user and never relaunches", async () => {
  const launched: string[] = [];
  const f = await workflowFixture(async (node, input) => {
    launched.push(String(input.objective).split("\n")[0] ?? "");
    return {
      state: "completed",
      effect: "none",
      value: {},
      evidence: [{ handle: node.key, generation: "1", source: "agent-result" }],
    };
  });
  const base = {
    sessionId: f.host.owner.sessionId,
    workspaceId: f.host.owner.workspaceId,
    persistentSession: true,
    agents: agentsWith({ coder: {} }),
    artifacts: availableSource as never,
    workflows: f.store,
  };
  const store = createSqliteWorkQueueStore(f.database, {
    locator: "workspace-state",
    durability: "durable",
  });
  const workflow = createProductWorkQueueActions({
    at: async (locator) => (locator === "workspace-state" ? store : null),
    resources: createProductResources(f.clock),
    generation: () => "configuration-1",
    authority: createProductWorkQueueAuthority({ ...base, role: "workflow" }),
    now: () => Number(f.clock.now()),
  });
  // Queue creation and the acceptance command belong to #949; the user role acts on the store directly.
  const user = createWorkQueueActions(store, {
    resources: f.host.resources,
    authority: createProductWorkQueueAuthority({ ...base, role: "user" }),
    now: () => Number(f.clock.now()),
  });
  const taskLists = createProductTaskLists({ actions: workflow, agents: base.agents });
  const scope = {
    ...workScope,
    kind: "project" as const,
    locator: "workspace-state",
    workspaceId: base.workspaceId,
    sessionId: null,
    owner: PRODUCT_WORK_ACTOR,
  };
  let sequence = 0;
  const provenance = () => ({
    source: "list-source",
    sourceGeneration: "1",
    mutationId: `edit-${sequence++}`,
    reason: "test",
  });
  const send = async (actions: typeof user, value: unknown) =>
    actions.execute(JSON.stringify(value), signal);
  try {
    expect(
      await send(workflow, {
        version: 1,
        action: "create",
        queueId: "queue-1",
        scope,
        objective: "Tasks",
        ...provenance(),
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    let queue: WorkQueue | null | undefined = taskValue(
      await send(user, {
        version: 1,
        action: "create",
        queueId: "queue-1",
        scope,
        objective: "Tasks",
        ...provenance(),
      }),
    ).queue;
    if (!queue) throw new Error("missing queue");
    queue = taskValue(
      await send(user, {
        version: 1,
        action: "mutate",
        queueId: "queue-1",
        scopeGeneration: scope.generation,
        expectedRevision: queue.revision,
        ...provenance(),
        operations: [
          {
            kind: "add",
            itemId: "a",
            fields: { ...workFields, subject: "Task A", agentType: "coder" },
          },
        ],
      }),
    ).queue;
    if (!queue) throw new Error("missing queue");
    const graph = await taskLists.prepare({
      queue,
      selected: ["a"],
      source: "list-source",
      sourceGeneration: "1",
      id: "user/tasks:product",
      signal,
    });
    const host = bindTaskListWorkflowHost(f.host, { actions: workflow, actor: PRODUCT_WORK_ACTOR });
    const handle = { id: "product-run", generation: "product-generation-1" };
    taskValue(await f.execution.admit({ handle, definition: graph, arguments: {} }, host, signal));
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("waiting");
    expect(launched).toEqual(["Task A"]);

    const item = async () => {
      let revision = queue?.revision ?? 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        const shown = await send(user, {
          version: 1,
          action: "show",
          queueId: "queue-1",
          scopeGeneration: scope.generation,
          expectedRevision: revision,
          itemId: "a",
        });
        if (shown.ok) {
          const found = shown.value.items?.[0];
          if (!found) throw new Error("missing item");
          return { item: found, revision };
        }
        revision = shown.error.currentRevision ?? revision;
      }
      throw new Error("item unavailable");
    };
    const submitted = await item();
    expect(submitted.item).toMatchObject({ disposition: "completion-claimed", acceptance: null });
    expect(submitted.item.claim?.holder).toMatchObject({
      actor: PRODUCT_WORK_ACTOR,
      generation: handle.generation,
    });
    const validate = {
      version: 1,
      action: "mutate",
      queueId: "queue-1",
      scopeGeneration: scope.generation,
      expectedRevision: submitted.revision,
      operations: [
        {
          kind: "validate",
          itemId: "a",
          itemRevision: submitted.item.revision,
          criteriaRevision: submitted.item.criteriaRevision,
          claimGeneration: submitted.item.claimGeneration,
          evidence: submitted.item.evidence,
          authority: "user",
          verdict: "accept",
          reason: "Criteria verified",
        },
      ],
    };
    expect(await send(workflow, { ...validate, ...provenance() })).toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
    taskValue(await send(user, { ...validate, ...provenance() }));
    expect(taskValue(await f.execution.drive(handle, host, signal)).state).toBe("completed");
    expect((await item()).item).toMatchObject({
      disposition: "completed",
      acceptance: { actor: PRODUCT_WORK_ACTOR, authority: "user" },
    });

    // A later run's authority observes the persisted claim; it never relaunches work.
    const restarted = createProductWorkQueueAuthority({
      ...base,
      role: "workflow",
      workflows: f.store,
    });
    expect(restarted.observeExecution(submitted.item)).toMatchObject({
      id: handle.id,
      generation: handle.generation,
      state: "settled",
    });
    expect(restarted.admitHolder(submitted.item.claim?.holder ?? ({} as never))).toBe(false);
    expect(launched).toEqual(["Task A"]);
  } finally {
    await f.database.close();
  }
});
