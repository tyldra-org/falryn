import { openProductStoreOrThrow, temporaryRoot } from "../../data/fixtures.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import type {
  WorkItem,
  WorkQueueAuthority,
  WorkResult,
} from "../../domain/orchestration/work-queue.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createProductResources } from "./product-resources.ts";
import { createWorkQueueActions, type WorkQueueResponse } from "./work-queues.ts";

export function workValue<T>(result: WorkResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
export const workScope = {
  kind: "session" as const,
  generation: "scope-1",
  configurationGeneration: 1,
  sessionId: "session-1",
  workspaceId: "workspace-1",
  owner: "user-1",
  members: [],
  locator: "user-state",
};
export const workFields = {
  subject: "Implement owner",
  objective: "Deliver intended behavior",
  description: "Keep evidence",
  activeForm: null,
  agentType: null,
  metadata: {},
  criteria: ["Relevant validation passes"],
};
export const workAuthority: WorkQueueAuthority = {
  actor: "user-1",
  sessionId: "session-1",
  workspaceId: "workspace-1",
  persistentSession: true,
  authorize: () => true,
  registeredAgent: (type) => type === "coder",
  sourceAvailable: () => true,
  admitHolder: (h) => h.actor === "user-1",
  observeExecution: () => ({
    id: "execution-1",
    generation: "execution-generation-1",
    state: "settled",
  }),
  validateCompletion: (input) => input.authority === "user",
};
export function actionsFor(
  store: SqliteStorePort,
  override: Partial<WorkQueueAuthority> = {},
  limits: { validationMs?: number; traversalSteps?: number } = {},
) {
  const resources = createProductResources(createSystemClock());
  const task = resources.openTask("configuration-1");
  return createWorkQueueActions(
    createSqliteWorkQueueStore(store, { locator: "user-state", durability: "durable" }),
    {
      authority: { ...workAuthority, ...override },
      resources: task,
      ...limits,
    },
  );
}
export async function workFixture() {
  const root = await temporaryRoot("falryn-work-queue-");
  const store = await openProductStoreOrThrow(root);
  const actions = actionsFor(store);
  let revision = 0,
    mutation = 0;
  const provenance = () => ({
    mutationId: `mutation-${++mutation}`,
    source: "source-handle",
    sourceGeneration: "source-1",
    reason: "authorized work",
  });
  const request = (operations: unknown[], expectedRevision = revision) => ({
    version: 1,
    action: "mutate",
    queueId: "queue-1",
    scopeGeneration: "scope-1",
    expectedRevision,
    ...provenance(),
    operations,
  });
  const send = (request: unknown) => actions.execute(JSON.stringify(request));
  const create = await send({
    version: 1,
    action: "create",
    queueId: "queue-1",
    scope: workScope,
    objective: "Delivery",
    ...provenance(),
  });
  revision = workValue(create).queue?.revision ?? 0;
  const mutate = async (operations: unknown[]) => {
    const result = await send(request(operations));
    if (result.ok) revision = result.value.queue?.revision ?? revision;
    return result;
  };
  const query = (action: string, more: Record<string, unknown> = {}) =>
    send({
      version: 1,
      action,
      queueId: "queue-1",
      scopeGeneration: "scope-1",
      expectedRevision: revision,
      ...more,
    });
  return {
    root,
    store,
    actions,
    send,
    request,
    mutate,
    query,
    revision: () => revision,
    async add(id: string) {
      return mutate([{ kind: "add", itemId: id, fields: workFields }]);
    },
    async item(id: string): Promise<WorkItem> {
      const r = workValue(await query("show", { itemId: id }));
      const item = r.items?.[0];
      if (item === undefined) throw new Error("missing item");
      return item;
    },
    async complete(id: string) {
      const item = await this.item(id);
      const evidence = [
        { handle: "artifact-1", generation: "artifact-generation-1", source: "validator" },
      ];
      const claim = await mutate([
        {
          kind: "submit",
          itemId: id,
          claimGeneration: item.claimGeneration,
          criteriaRevision: item.criteriaRevision,
          evidence,
        },
      ]);
      if (!claim.ok) return claim;
      const submitted = await this.item(id);
      return mutate([
        {
          kind: "validate",
          itemId: id,
          itemRevision: submitted.revision,
          claimGeneration: submitted.claimGeneration,
          criteriaRevision: submitted.criteriaRevision,
          evidence,
          authority: "user",
          verdict: "accept",
          reason: "Verified",
        },
      ]);
    },
  };
}
export function workCode(result: WorkResult<WorkQueueResponse>) {
  return result.ok ? "ok" : result.error.code;
}
