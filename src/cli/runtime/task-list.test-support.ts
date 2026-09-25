/**
 * Seeds an existing project task list in a real product session and prepares
 * its workflow through the product port, as #949 and #1112 consumers will.
 */
import { expect } from "bun:test";
import {
  createAgentRegistry,
  starterAgentRegistrations,
} from "../../application/orchestration/agent-registry.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import {
  createProductTaskLists,
  createProductWorkQueueActions,
  createProductWorkQueueAuthority,
  PRODUCT_WORK_ACTOR,
} from "../../application/orchestration/work-queue-authority.ts";
import { createWorkQueueActions } from "../../application/orchestration/work-queues.ts";
import { artifactId } from "../../domain/artifacts/artifact.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import type { WorkflowHandle } from "../../domain/orchestration/workflow-state.ts";
import type { DeterministicProviderScript, ModelRequest } from "../../providers/index.ts";
import type { ProductArtifactSession } from "./product-artifact-session.ts";

export const TASK_LIST_OBJECTIVE = "Report where the owner lives";
const explorerResult = JSON.stringify({
  locations: [],
  flow: [],
  findings: ["located"],
  unknowns: [],
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function seedProjectTaskList(
  session: ProductArtifactSession,
  input: { readonly workspaceId: string; readonly clock: ClockPort },
) {
  const signal = new AbortController().signal;
  const store = await session.workQueues.at("workspace-state");
  if (store === null) throw new Error("workspace-state location unavailable");
  const bytes = new TextEncoder().encode("task list source");
  const ingested = value(
    await session.artifacts.ingest({
      artifactId: artifactId.from("list-source"),
      mediaType: "text/plain",
      encoding: "identity",
      sensitivity: "user-content",
      origin: "user-supplied",
      invocationId: null,
      declaredByteLength: bytes.byteLength,
      content: (async function* () {
        yield bytes;
      })(),
    }),
  );
  const source = { source: "list-source", sourceGeneration: String(ingested.record.digest) };
  const agents = createAgentRegistry(starterAgentRegistrations());
  const authority = (role: "workflow" | "user", owner: ProductArtifactSession = session) =>
    createProductWorkQueueAuthority({
      role,
      sessionId: "task-list-seed",
      workspaceId: input.workspaceId,
      persistentSession: true,
      agents,
      artifacts: owner.artifacts,
      workflows: owner.workflows,
    });
  const resources = createProductResources(input.clock);
  const now = () => Number(input.clock.now());
  // Queue creation belongs to #949's command; it writes to the selected location directly.
  const user = createWorkQueueActions(store, {
    resources: resources.openTask("0"),
    authority: authority("user"),
    now,
  });
  const workflowActions = (owner: ProductArtifactSession) =>
    createProductWorkQueueActions({
      at: owner.workQueues.at,
      resources,
      generation: () => "0",
      authority: authority("workflow", owner),
      now,
    });
  const workflow = workflowActions(session);
  let mutation = 0;
  const send = async (request: object) =>
    value(
      await user.execute(
        JSON.stringify({
          version: 1,
          ...request,
          ...source,
          mutationId: `seed-${mutation++}`,
          reason: "seed",
        }),
        signal,
      ),
    );
  const scope = {
    kind: "project" as const,
    generation: "scope-1",
    configurationGeneration: 0,
    sessionId: null,
    workspaceId: input.workspaceId,
    owner: PRODUCT_WORK_ACTOR,
    members: [],
    locator: "workspace-state",
  };
  const created = (await send({ action: "create", queueId: "queue-1", scope, objective: "Tasks" }))
    .queue;
  const queue = (
    await send({
      action: "mutate",
      queueId: "queue-1",
      scopeGeneration: scope.generation,
      expectedRevision: created?.revision,
      operations: [
        {
          kind: "add",
          itemId: "a",
          fields: {
            subject: "Inspect the owner",
            objective: TASK_LIST_OBJECTIVE,
            description: "",
            activeForm: null,
            agentType: "builtin/falryn/agents:explorer",
            metadata: {},
            criteria: ["The owner is located"],
          },
        },
      ],
    })
  ).queue;
  if (!queue) throw new Error("missing queue");
  const definition = await createProductTaskLists({ actions: workflow, agents }).prepare({
    queue,
    selected: ["a"],
    ...source,
    id: "user/tasks:entrypoint",
    signal,
  });
  async function item(owner: ProductArtifactSession) {
    const actions = workflowActions(owner);
    for (let revision = queue?.revision ?? 0; revision < (queue?.revision ?? 0) + 8; revision++) {
      const shown = await actions.execute(
        JSON.stringify({
          version: 1,
          action: "show",
          queueId: "queue-1",
          scopeGeneration: scope.generation,
          expectedRevision: revision,
          itemId: "a",
        }),
        signal,
      );
      const found = shown.ok ? shown.value.items?.[0] : undefined;
      if (found) return found;
    }
    throw new Error("item unavailable");
  }
  return {
    /** A root turn that executes the prepared task list; the registered Explorer answers its child turn. */
    script(handle: WorkflowHandle) {
      let executed = false;
      return (request: ModelRequest): DeterministicProviderScript => {
        if (!request.tools.some((tool) => tool.name === "workflow"))
          return { kind: "text", text: explorerResult };
        if (executed) return { kind: "text", text: "The task waits for acceptance." };
        executed = true;
        return {
          kind: "tool",
          name: "workflow",
          toolCallId: "task-list-workflow",
          argumentFragments: [
            JSON.stringify({
              operation: "execute",
              handle,
              definitionJson: JSON.stringify(definition),
              argumentsJson: "{}",
            }),
          ],
        };
      };
    },
    /** The claim, evidence and waiting run a host must leave for the user to accept. */
    async expectAwaitingAcceptance(
      owner: ProductArtifactSession,
      handle: WorkflowHandle,
      requests: readonly ModelRequest[],
    ) {
      const record = value(owner.workflows.get(handle));
      expect(record.state).toBe("waiting");
      expect(record.nodes.find((node) => node.state === "waiting")?.reason).toBe(
        "workflow-task-list-acceptance-required",
      );
      // Without an acceptance owner the process task ends; the durable run keeps waiting.
      if (!record.task) throw new Error("Missing workflow task");
      expect(owner.joins.task(record.task)).toMatchObject({
        ok: true,
        value: { state: "terminal" },
      });
      const claimed = await item(owner);
      expect(claimed).toMatchObject({ disposition: "completion-claimed", acceptance: null });
      expect(claimed.claim?.holder).toMatchObject({
        actor: PRODUCT_WORK_ACTOR,
        generation: handle.generation,
      });
      expect(claimed.evidence.length).toBeGreaterThan(0);
      const children = requests.filter(
        (request) => !request.tools.some((tool) => tool.name === "workflow"),
      );
      expect(children).toHaveLength(1);
      expect(JSON.stringify(children[0]?.messages)).toContain(TASK_LIST_OBJECTIVE);
    },
  };
}
