/**
 * The product owner of work-queue authority for live hosts (#1135).
 *
 * Work records describe intent and evidence; this module decides, from host
 * facts only, who may read or change them, which holder may claim, how a claim
 * maps to the workflow run executing it, and who may accept completion.
 */
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/artifact.ts";
import { err } from "../../domain/foundation/result.ts";
import type { ProcessTaskHandle } from "../../domain/orchestration/process-task.ts";
import type {
  WorkItem,
  WorkQueue,
  WorkQueueAuthority,
  WorkQueueStore,
  WorkResult,
} from "../../domain/orchestration/work-queue.ts";
import {
  type WorkflowNode,
  type WorkflowValue,
  workflowNodeSchema,
} from "../../domain/orchestration/workflow-definition.ts";
import type {
  WorkflowNodeRecord,
  WorkflowRecord,
  WorkflowStore,
} from "../../domain/orchestration/workflow-state.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { ProductResources } from "./product-resources.ts";
import { createWorkQueueActions, type WorkQueueResponse } from "./work-queues.ts";
import { prepareTaskListWorkflow } from "./workflow-task-list.ts";

/** The local user the product already names for workflow questions. */
export const PRODUCT_WORK_ACTOR = "local-user";

/**
 * `workflow` authority serves workflow and scheduled runs: it reads, claims and
 * submits evidence, and never creates queues or accepts completion. `user`
 * authority is the user's own validator; #949 owns the command that exposes it.
 */
export type ProductWorkRole = "workflow" | "user";

const LIVE_RUN_STATES = new Set<WorkflowRecord["state"]>(["admitted", "running", "waiting"]);
const TERMINAL_RUN_STATES = new Set<WorkflowRecord["state"]>([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "uncertain",
]);
const ACTIVE_NODE_STATES = new Set<WorkflowNodeRecord["state"]>(["pending", "running", "waiting"]);
/** The task-list host's reason for a node whose execution settled and awaits the user. */
const ACCEPTANCE_WAIT = "workflow-task-list-acceptance-required";

export type ProductWorkQueueAuthorityOptions = {
  readonly role: ProductWorkRole;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly persistentSession: boolean;
  readonly agents: Pick<AgentRegistry, "resolve">;
  readonly artifacts: Pick<ArtifactStorePort, "get">;
  readonly workflows: Pick<WorkflowStore, "find">;
  /** True when the run's process task ended without its supervisor, so its node cannot still run. */
  readonly fenced?: (task: ProcessTaskHandle) => boolean;
};

export function createProductWorkQueueAuthority(
  options: ProductWorkQueueAuthorityOptions,
): WorkQueueAuthority {
  /** The claimed node and its run, or null when the holder names no run of this workspace. */
  function claimed(holder: { taskId: string; generation: string }) {
    const found = options.workflows.find(options.workspaceId, holder.generation);
    const run = found.ok ? found.value : null;
    if (run === null) return null;
    const node = run.nodes.find(
      (entry) => entry.key === holder.taskId || entry.invocation === holder.taskId,
    );
    return node === undefined ? null : { run, node };
  }
  return {
    actor: PRODUCT_WORK_ACTOR,
    sessionId: options.sessionId,
    workspaceId: options.workspaceId,
    persistentSession: options.persistentSession,
    authorize(queue: WorkQueue, operation: "read" | "create" | "mutate") {
      // Scope, workspace, session and membership rules are enforced by the actions owner.
      return (
        queue.scope.workspaceId === options.workspaceId &&
        (operation !== "create" || options.role === "user")
      );
    },
    registeredAgent(type: string) {
      return options.agents.resolve(type)?.availability === "available";
    },
    sourceAvailable(handle: string, generation: string) {
      const id = artifactId.parse(handle);
      if (!id.ok) return false;
      const record = options.artifacts.get(id.value);
      return (
        record.ok &&
        record.value !== null &&
        record.value.availability === "available" &&
        record.value.finalizedAt !== null &&
        String(record.value.digest) === generation
      );
    },
    admitHolder(holder) {
      if (holder.actor !== PRODUCT_WORK_ACTOR) return false;
      const found = claimed(holder);
      return (
        found !== null &&
        found.run.definition.taskList !== undefined &&
        LIVE_RUN_STATES.has(found.run.state)
      );
    },
    observeExecution(item: WorkItem) {
      const holder = item.claim?.holder;
      if (holder === undefined) return null;
      const found = claimed(holder);
      if (found === null) return null;
      const { run, node } = found;
      const execution = { id: run.handle.id, generation: holder.generation };
      if (node.state === "uncertain" || node.effect === "uncertain")
        return { ...execution, state: "uncertain" as const };
      // The task-list host waits here only after its agent settled and evidence was submitted.
      if (node.state === "waiting" && node.reason === ACCEPTANCE_WAIT)
        return { ...execution, state: "settled" as const };
      if (ACTIVE_NODE_STATES.has(node.state)) {
        if (run.task !== null && node.state !== "pending" && options.fenced?.(run.task) === true)
          return { ...execution, state: "fenced" as const };
        return TERMINAL_RUN_STATES.has(run.state) && node.state === "pending"
          ? { ...execution, state: "settled" as const }
          : { ...execution, state: "active" as const };
      }
      return { ...execution, state: "settled" as const };
    },
    validateCompletion(input) {
      return options.role === "user" && input.authority === "user";
    },
  };
}

type WorkQueueActions = ReturnType<typeof createWorkQueueActions>;

/** Registered locations a consumer's queue may live in; `memory` only serves its own session. */
export const WORK_QUEUE_ROUTED_LOCATORS = ["workspace-state", "user-state", "memory"] as const;

/**
 * One action owner over the host's registered locations. Locations may share
 * storage, so a request reaches the location its queue record names. Queue
 * creation is never routed, and records that name different locations for one
 * queue id are refused rather than guessed.
 */
export function createWorkQueueRouter(input: {
  readonly at: (locator: string) => Promise<WorkQueueStore | null>;
  readonly actions: (store: WorkQueueStore) => WorkQueueActions;
}): WorkQueueActions {
  return {
    async execute(
      json: string,
      signal = new AbortController().signal,
    ): Promise<WorkResult<WorkQueueResponse>> {
      if (signal.aborted) return err({ code: "cancelled-operation" });
      let request: unknown;
      try {
        request = JSON.parse(json);
      } catch {
        return err({ code: "malformed" });
      }
      const record =
        typeof request === "object" && request !== null
          ? (request as { action?: unknown; queueId?: unknown })
          : {};
      if (record.action === "create" || record.action === "resume")
        return err({ code: "unsupported" });
      if (typeof record.queueId !== "string") return err({ code: "malformed" });
      const queueId = record.queueId as WorkQueue["id"];
      let recorded: string | null = null;
      for (const locator of WORK_QUEUE_ROUTED_LOCATORS) {
        const store = await input.at(locator);
        if (store === null) continue;
        const found = store.transaction((tx) => tx.queue(queueId)?.scope.locator ?? null, signal);
        if (!found.ok) return found;
        if (found.value === null) continue;
        if (recorded !== null && recorded !== found.value)
          return err({ code: "conflicting-identity" });
        recorded = found.value;
      }
      const store = recorded === null ? null : await input.at(recorded);
      if (store === null) return err({ code: "unavailable" });
      return input.actions(store).execute(json, signal);
    },
  };
}

/**
 * The product action owner over registered locations. Every request runs in its
 * own bounded resource task, so no lease outlives the request that needed it.
 */
export function createProductWorkQueueActions(input: {
  readonly at: (locator: string) => Promise<WorkQueueStore | null>;
  readonly resources: Pick<ProductResources, "openTask">;
  readonly generation: () => string;
  readonly authority: WorkQueueAuthority;
  readonly now: () => number;
}): WorkQueueActions {
  return createWorkQueueRouter({
    at: input.at,
    actions: (store) => ({
      async execute(json, signal = new AbortController().signal) {
        const task = input.resources.openTask(input.generation());
        try {
          return await createWorkQueueActions(store, {
            resources: task,
            authority: input.authority,
            now: input.now,
          }).execute(json, signal);
        } finally {
          task.close();
        }
      },
    }),
  });
}

type TaskListPreparation = Omit<Parameters<typeof prepareTaskListWorkflow>[0], "actions" | "agent">;

/**
 * The runtime port task consumers call to turn an existing queue selection into
 * a task-list workflow definition. Admission stays with the workflow actions.
 */
export type ProductTaskLists = {
  readonly actions: WorkQueueActions;
  prepare(selection: TaskListPreparation): ReturnType<typeof prepareTaskListWorkflow>;
};

export function createProductTaskLists(input: {
  readonly actions: WorkQueueActions;
  readonly agents: Pick<AgentRegistry, "resolve">;
}): ProductTaskLists {
  return {
    actions: input.actions,
    prepare: (selection) =>
      prepareTaskListWorkflow({
        ...selection,
        actions: input.actions,
        agent: (item, prerequisites) => taskListAgentNode(input.agents, item, prerequisites),
      }),
  };
}

type AgentNode = Extract<WorkflowNode, { kind: "agent" }>;

/** Refusal from the task-list agent factory; nothing was prepared or launched. */
export class TaskListAgentRefusal extends Error {
  constructor(
    readonly code:
      | "workflow-task-list-agent-required"
      | "workflow-task-list-agent-unavailable"
      | "workflow-task-list-agent-input-unsupported"
      | "workflow-task-list-agent-input-limit",
    readonly itemId: string,
  ) {
    super(code);
  }
}

function objectiveText(item: WorkItem): string {
  return [
    item.subject,
    `Objective: ${item.objective}`,
    ...(item.description.length > 0 ? [item.description] : []),
    "Completion criteria:",
    ...item.criteria.map((criterion) => `- ${criterion}`),
  ].join("\n\n");
}

/**
 * The agent node for one selected task, built from its registered `agentType`.
 * Capabilities and effects are the registered definition's own ceilings; the
 * native host further narrows them to the initiating delegation. The task is
 * rendered into the definition's `objective` input, and prerequisite receipts
 * are passed only to agents whose input schema declares `prerequisites`.
 */
export function taskListAgentNode(
  agents: Pick<AgentRegistry, "resolve">,
  item: WorkItem,
  prerequisites: WorkflowValue | null,
): AgentNode {
  if (item.agentType === null)
    throw new TaskListAgentRefusal("workflow-task-list-agent-required", item.id);
  const agent = agents.resolve(item.agentType);
  if (agent === null || agent.availability !== "available")
    throw new TaskListAgentRefusal("workflow-task-list-agent-unavailable", item.id);
  const schema = agent.definition.inputSchema as {
    properties?: Record<string, { type?: unknown; maxLength?: unknown }>;
  };
  const objective = schema.properties?.objective;
  if (objective?.type !== "string")
    throw new TaskListAgentRefusal("workflow-task-list-agent-input-unsupported", item.id);
  const text = objectiveText(item);
  if (typeof objective.maxLength === "number" && text.length > objective.maxLength)
    throw new TaskListAgentRefusal("workflow-task-list-agent-input-limit", item.id);
  const capabilities = [
    ...agent.definition.capabilities.required,
    ...agent.definition.capabilities.optional,
  ];
  const node = workflowNodeSchema.parse({
    kind: "agent",
    key: item.id,
    agentId: item.agentType,
    capabilities: [...new Set(capabilities)],
    effects: [...agent.definition.effects],
    input: {
      objective: { from: "literal", value: text },
      ...(prerequisites !== null && schema.properties?.prerequisites !== undefined
        ? { prerequisites }
        : {}),
    },
    resultSchema: agent.definition.resultSchema,
  });
  if (node.kind !== "agent")
    throw new TaskListAgentRefusal("workflow-task-list-agent-unavailable", item.id);
  return node;
}
