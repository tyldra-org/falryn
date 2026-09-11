/** #949 adapter: immutable selection, #890 claims/evidence, and the existing workflow scheduler. */
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type WorkItem,
  type WorkQueue,
  workFieldsSchema,
} from "../../domain/orchestration/work-queue.ts";
import type {
  WorkMutation,
  WorkQueueRequest,
} from "../../domain/orchestration/work-queue-requests.ts";
import {
  decodeWorkflowDefinition,
  type WorkflowNode,
  type WorkflowValue,
  workflowNodeSchema,
} from "../../domain/orchestration/workflow-definition.ts";
import type {
  WorkflowNodeRecord,
  WorkflowRecord,
} from "../../domain/orchestration/workflow-state.ts";
import {
  type TaskListSelection,
  taskListSelectionSchema,
} from "../../domain/orchestration/workflow-task-list.ts";
import type { createWorkQueueActions, WorkQueueResponse } from "./work-queues.ts";
import type { WorkflowHost, WorkflowNodeOutcome } from "./workflow-host.ts";

type Actions = ReturnType<typeof createWorkQueueActions>;
const key = (id: string) => `item-${canonicalDigest(id).slice(7, 39)}`;
const empty = { type: "object", properties: {}, additionalProperties: false };
const receiptSchema = {
  type: "object",
  properties: {
    queueId: { type: "string" },
    itemId: { type: "string" },
    criteriaRevision: { type: "integer" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          handle: { type: "string" },
          generation: { type: "string" },
          source: { type: "string" },
        },
        required: ["handle", "generation", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["queueId", "itemId", "criteriaRevision", "evidence"],
  additionalProperties: false,
};
async function send(
  actions: Actions,
  request: WorkQueueRequest,
  signal: AbortSignal,
): Promise<WorkQueueResponse> {
  const result = await actions.execute(JSON.stringify(request), signal);
  if (!result.ok) throw new Error(`workflow-task-list-${result.error.code}`);
  return result.value;
}
const accepted = (item: WorkItem) =>
  item.disposition === "completed" &&
  item.acceptance?.criteriaRevision === item.criteriaRevision &&
  item.evidence.length > 0;

/** Configuration alone cannot call this function: the task consumer must explicitly admit its selection. */
export async function prepareTaskListWorkflow(options: {
  readonly actions: Actions;
  readonly queue: WorkQueue;
  readonly selected: readonly string[];
  readonly autoCascade?: boolean;
  readonly source: string;
  readonly sourceGeneration: string;
  readonly id: string;
  readonly signal: AbortSignal;
  /** The registered agent owner supplies input/effect ceilings, including normal prerequisite context inputs. */
  agent(
    item: WorkItem,
    prerequisites: WorkflowValue | null,
  ): Extract<WorkflowNode, { kind: "agent" }>;
}) {
  const { queue, actions, signal } = options;
  if (
    options.selected.length === 0 ||
    options.selected.length > 256 ||
    new Set(options.selected).size !== options.selected.length
  )
    throw new Error("workflow-task-list-selection-invalid");
  const selection = {
    queueId: queue.id,
    scopeGeneration: queue.scope.generation,
    expectedRevision: queue.revision,
  };
  const loaded: { item: WorkItem; dependencies: WorkItem["id"][] }[] = [];
  for (const id of options.selected) {
    const itemId = taskListSelectionSchema.shape.items.element.shape.id.parse(id);
    const shown = await send(actions, { version: 1, action: "show", ...selection, itemId }, signal);
    const item = shown.items?.[0];
    if (!item || item.deleted || item.blockers.length > 0 || item.claim || !item.agentType)
      throw new Error("workflow-task-list-item-unavailable");
    const edges = await send(
      actions,
      { version: 1, action: "edges", ...selection, itemId, direction: "dependencies", after: null },
      signal,
    );
    if (edges.next !== null) throw new Error("workflow-task-list-dependency-limit");
    const dependencies = taskListSelectionSchema.shape.items.element.shape.dependencies.parse(
      edges.edges ?? [],
    );
    loaded.push({ item, dependencies });
  }
  const candidates = new Set(
    loaded.filter(({ item }) => !accepted(item)).map(({ item }) => item.id),
  );
  const included = new Set<string>();
  for (const { item, dependencies } of loaded) {
    if (accepted(item)) continue;
    let waiting = false;
    for (const itemId of dependencies) {
      if (options.autoCascade === true && candidates.has(itemId)) continue;
      const dependency = (
        await send(actions, { version: 1, action: "show", ...selection, itemId }, signal)
      ).items?.[0];
      if (!dependency || !accepted(dependency)) waiting = true;
    }
    if (!waiting) included.add(item.id);
    else if (options.autoCascade) throw new Error("workflow-task-list-external-prerequisite");
  }
  const nodes: WorkflowNode[] = [];
  for (const { item, dependencies } of loaded) {
    if (!included.has(item.id)) continue;
    const upstream = dependencies.filter((id) => included.has(id)).map(key);
    const join = `${key(item.id)}-inputs`;
    if (upstream.length)
      nodes.push(
        workflowNodeSchema.parse({
          key: join,
          kind: "join",
          dependencies: upstream,
          resultSchema: {
            type: "object",
            properties: {
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    state: { type: "string" },
                    result: {
                      type: "object",
                      properties: {
                        artifactId: { type: "string" },
                        digest: { type: "string" },
                        byteLength: { type: "integer" },
                      },
                      required: ["artifactId", "digest", "byteLength"],
                      additionalProperties: false,
                    },
                  },
                  required: ["key", "state", "result"],
                  additionalProperties: false,
                },
              },
            },
            required: ["nodes"],
            additionalProperties: false,
          },
        }),
      );
    // Prerequisite receipts carry bounded native evidence handles, never copied payloads.
    const agent = options.agent(
      item,
      upstream.length ? { from: "node", node: join, path: [] } : null,
    );
    nodes.push({
      ...agent,
      key: key(item.id),
      dependencies: upstream.length ? [join] : [],
      retries: 0,
      resultSchema: receiptSchema,
      resultPath: [],
      onFailure: "continue",
    });
  }
  const taskList = taskListSelectionSchema.parse({
    queue,
    autoCascade: options.autoCascade ?? false,
    source: options.source,
    sourceGeneration: options.sourceGeneration,
    items: loaded.map(({ item, dependencies }) => ({
      ...workFieldsSchema.strip().parse(item),
      id: item.id,
      criteriaRevision: item.criteriaRevision,
      dependencies,
      node: included.has(item.id) ? key(item.id) : null,
    })),
  });
  const decoded = decodeWorkflowDefinition({
    version: 1,
    id: options.id,
    label: queue.objective.slice(0, 256),
    argumentsSchema: empty,
    nodes,
    outputs: {},
    taskList,
  });
  if (!decoded.ok) throw new Error("workflow-task-list-graph-invalid");
  return decoded.definition;
}

/** Bind only to a host with current work-queue authority. Serialized graph data supplies no validator. */
export function bindTaskListWorkflowHost(
  host: WorkflowHost,
  options: {
    readonly actions: Actions;
    readonly actor: string;
    /** Existing native work validation owns acceptance; absence keeps the workflow waiting. */
    readonly changed?: (selection: TaskListSelection, signal: AbortSignal) => Promise<void>;
  },
): WorkflowHost {
  async function current(record: WorkflowRecord, node: WorkflowNodeRecord, signal: AbortSignal) {
    const selected = record.definition.taskList;
    const snapshot = selected?.items.find((item) => item.node === node.template);
    if (
      !selected ||
      !snapshot ||
      selected.queue.scope.workspaceId !== record.owner.workspaceId ||
      (selected.queue.scope.sessionId !== null &&
        selected.queue.scope.sessionId !== record.owner.sessionId)
    )
      throw new Error("workflow-task-list-scope-mismatch");
    let revision = selected.queue.revision;
    // A bounded read repair handles unrelated committed list updates; it never retries a launch.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await options.actions.execute(
        JSON.stringify({
          version: 1,
          action: "show",
          queueId: selected.queue.id,
          scopeGeneration: selected.queue.scope.generation,
          expectedRevision: revision,
          itemId: snapshot.id,
        }),
        signal,
      );
      if (!result.ok) {
        if (
          result.error.code === "conflicting-revision" &&
          result.error.currentRevision !== undefined
        ) {
          revision = result.error.currentRevision;
          continue;
        }
        throw new Error("workflow-task-list-current-unavailable");
      }
      const item = result.value.items?.[0];
      if (
        !item ||
        item.deleted ||
        item.criteriaRevision !== snapshot.criteriaRevision ||
        canonicalDigest(workFieldsSchema.strip().parse(item)) !==
          canonicalDigest(workFieldsSchema.strip().parse(snapshot))
      )
        throw new Error("workflow-task-list-snapshot-changed");
      const edgeResult = await options.actions.execute(
        JSON.stringify({
          version: 1,
          action: "edges",
          queueId: selected.queue.id,
          scopeGeneration: selected.queue.scope.generation,
          expectedRevision: revision,
          itemId: item.id,
          direction: "dependencies",
          after: null,
        }),
        signal,
      );
      if (!edgeResult.ok) {
        if (edgeResult.error.currentRevision !== undefined) {
          revision = edgeResult.error.currentRevision;
          continue;
        }
        throw new Error("workflow-task-list-current-unavailable");
      }
      const edges = edgeResult.value;
      if (
        edges.next !== null ||
        canonicalDigest(edges.edges ?? []) !== canonicalDigest(snapshot.dependencies)
      )
        throw new Error("workflow-task-list-graph-changed");
      return { selected, item, revision };
    }
    throw new Error("workflow-task-list-current-unavailable");
  }
  async function mutate(
    record: WorkflowRecord,
    node: WorkflowNodeRecord,
    phase: string,
    operations: (item: WorkItem) => WorkMutation[],
    signal: AbortSignal,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = await current(record, node, signal);
      const result = await options.actions.execute(
        JSON.stringify({
          version: 1,
          action: "mutate",
          queueId: value.selected.queue.id,
          scopeGeneration: value.selected.queue.scope.generation,
          expectedRevision: value.revision,
          mutationId: `workflow-${canonicalDigest([record.handle, node.key, phase]).slice(7, 55)}`,
          source: value.selected.source,
          sourceGeneration: value.selected.sourceGeneration,
          reason: `workflow-${phase}`,
          operations: operations(value.item),
        }),
        signal,
      );
      if (result.ok) return result.value;
      if (result.error.code !== "conflicting-revision")
        throw new Error(`workflow-task-list-${result.error.code}`);
    }
    throw new Error("workflow-task-list-contention");
  }

  async function settled(
    record: WorkflowRecord,
    node: WorkflowNodeRecord,
    signal: AbortSignal,
  ): Promise<WorkflowNodeOutcome> {
    const { selected, item } = await current(record, node, signal);
    if (accepted(item))
      return {
        state: "completed",
        effect: node.effect,
        value: {
          queueId: selected.queue.id,
          itemId: item.id,
          criteriaRevision: item.criteriaRevision,
          evidence: item.evidence,
        },
      };
    if (["cancelled", "archived"].includes(item.disposition))
      return { state: "failed", effect: node.effect, reason: "workflow-task-list-item-stopped" };
    return {
      state: "waiting",
      effect: node.effect,
      reason: "workflow-task-list-acceptance-required",
    };
  }
  return {
    ...host,
    validate: (definition) => [
      ...host.validate(definition),
      ...(definition.taskList?.items.some(
        (item) =>
          item.node !== null &&
          !definition.nodes.some(
            (node) =>
              node.key === item.node && node.kind === "agent" && node.agentId === item.agentType,
          ),
      )
        ? [{ path: "taskList", code: "workflow-task-list-agent-mismatch" }]
        : []),
    ],
    async execute(node, input, record, instance, resources, signal) {
      if (!record.definition.taskList)
        return host.execute(node, input, record, instance, resources, signal);
      await mutate(
        record,
        instance,
        "claim",
        () => [
          {
            kind: "claim",
            itemId: taskListSelectionSchema.shape.items.element.shape.id.parse(
              record.definition.taskList?.items.find((item) => item.node === node.key)?.id,
            ),
            holder: {
              taskId: instance.invocation ?? instance.key,
              generation: record.handle.generation,
              actor: options.actor,
            },
          },
        ],
        signal,
      );
      const result = await host.execute(node, input, record, instance, resources, signal);
      if (result.state !== "completed") return result;
      if (!result.evidence?.length)
        return { ...result, state: "failed", reason: "workflow-task-list-evidence-unavailable" };
      await mutate(
        record,
        instance,
        "submit",
        (item) => [
          {
            kind: "submit",
            itemId: item.id,
            claimGeneration: item.claimGeneration,
            criteriaRevision: item.criteriaRevision,
            evidence: [...(result.evidence ?? [])],
          },
        ],
        signal,
      );
      return {
        ...(await settled(record, { ...instance, effect: result.effect }, signal)),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
    question: (node, record, signal) =>
      record.definition.taskList
        ? settled(record, node, signal)
        : host.question(node, record, signal),
    ...(options.changed
      ? {
          wait: (record: WorkflowRecord, signal: AbortSignal) =>
            record.definition.taskList
              ? (options.changed?.(record.definition.taskList, signal) ?? Promise.resolve())
              : (host.wait?.(record, signal) ?? Promise.resolve()),
        }
      : {}),
    reusable: (node, prior, record, signal) =>
      record.definition.taskList
        ? Promise.resolve(false)
        : host.reusable(node, prior, record, signal),
  };
}
