import { afterEach, expect, test } from "bun:test";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import {
  createProductWorkQueueActions,
  createProductWorkQueueAuthority,
  PRODUCT_WORK_ACTOR,
} from "../../application/orchestration/work-queue-authority.ts";
import {
  workAuthority,
  workFields,
  workScope,
  workValue,
} from "../../application/orchestration/work-queues.fixtures.ts";
import { createWorkQueueActions } from "../../application/orchestration/work-queues.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { createWorkQueueLocations } from "../../data/orchestration/work-queue-locations.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import { openBunSqlite } from "../../integrations/storage/bun-sqlite.ts";

afterEach(removeTemporaryRoots);
test("the product router reaches queues by their recorded location across shared storage", async () => {
  const root = await temporaryRoot("falryn-queue-router-");
  const state = await openProductStoreOrThrow(root);
  const clock = createSystemClock();
  const locations = createWorkQueueLocations({
    state,
    stateRoot: root,
    clock,
    open: openBunSqlite,
  });
  const resources = createProductResources(clock);
  const authority = (role: "workflow" | "user", sessionId = "session-1") =>
    createProductWorkQueueAuthority({
      role,
      sessionId,
      workspaceId: "workspace-1",
      persistentSession: true,
      agents: { resolve: () => null },
      artifacts: {
        get: () => ({
          ok: true,
          value: { availability: "available", finalizedAt: 1, digest: "g1" },
        }),
      } as never,
      workflows: { find: () => ({ ok: true, value: null }) },
    });
  let mutation = 0;
  // Queue creation belongs to #949's command; it writes to the selected location directly.
  async function create(locator: string, queueId: string, scope: object, sessionId?: string) {
    const store = await locations.at(locator);
    if (store === null) throw new Error("missing location");
    const actions = createWorkQueueActions(store, {
      authority: authority("user", sessionId),
      resources: resources.openTask("configuration-1"),
    });
    const provenance = () => ({
      mutationId: `edit-${mutation++}`,
      source: "prompt-1",
      sourceGeneration: "g1",
      reason: "record work",
    });
    const queue = workValue(
      await actions.execute(
        JSON.stringify({
          version: 1,
          action: "create",
          queueId,
          objective: "Work",
          scope: { ...workScope, owner: PRODUCT_WORK_ACTOR, locator, ...scope },
          ...provenance(),
        }),
      ),
    ).queue;
    if (!queue) throw new Error("missing queue");
    const added = workValue(
      await actions.execute(
        JSON.stringify({
          version: 1,
          action: "mutate",
          queueId,
          scopeGeneration: queue.scope.generation,
          expectedRevision: queue.revision,
          operations: [{ kind: "add", itemId: "a", fields: workFields }],
          ...provenance(),
        }),
      ),
    ).queue;
    return { queueId, scopeGeneration: queue.scope.generation, expectedRevision: added?.revision };
  }
  try {
    const project = await create("workspace-state", "project-queue", {
      kind: "project",
      sessionId: null,
    });
    const foreignSession = await create(
      "workspace-state",
      "session-queue",
      { kind: "session", sessionId: "session-2" },
      "session-2",
    );
    await create("workspace-state", "duplicate", { kind: "project", sessionId: null });
    await create("memory", "duplicate", { kind: "memory", sessionId: "session-1" });
    const router = createProductWorkQueueActions({
      at: locations.at,
      resources,
      generation: () => "configuration-1",
      authority: authority("workflow"),
      now: () => Date.now(),
    });
    const send = async (value: object) => router.execute(JSON.stringify({ version: 1, ...value }));
    const shown = await send({ action: "show", ...project, itemId: "a" });
    expect(shown.ok && String(shown.value.items?.[0]?.id)).toBe("a");
    expect(await send({ action: "show", ...foreignSession, itemId: "a" })).toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
    expect(
      await send({ action: "show", ...project, queueId: "duplicate", itemId: "a" }),
    ).toMatchObject({ ok: false, error: { code: "conflicting-identity" } });
    expect(
      await send({ action: "show", ...project, queueId: "missing", itemId: "a" }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(
      await send({
        action: "create",
        queueId: "new-queue",
        objective: "Work",
        scope: { ...workScope, kind: "project", sessionId: null, locator: "workspace-state" },
        mutationId: "create-new",
        source: "prompt-1",
        sourceGeneration: "g1",
        reason: "record work",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
  } finally {
    expect(await locations.close()).toBeTrue();
    await state.close();
  }
});

test("registered selection, ephemeral lifetime, resumed locator and shared persistence", async () => {
  const root = await temporaryRoot("falryn-queue-locations-");
  const state = await openProductStoreOrThrow(root);
  const clock = createSystemClock();
  const locations = createWorkQueueLocations({
    state,
    stateRoot: root,
    clock,
    open: openBunSqlite,
  });
  const selection = workValue(
    await locations.select({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      persistentSession: false,
    }),
  );
  expect(selection.scope).toBe("session");
  expect(selection.store.durability).toBe("ephemeral");
  const actions = createWorkQueueActions(selection.store, {
    authority: { ...workAuthority, persistentSession: false },
    resources: createProductResources(clock).openTask("configuration-1"),
  });
  workValue(
    await actions.execute(
      JSON.stringify({
        version: 1,
        action: "create",
        queueId: "ephemeral-queue",
        objective: "Local work",
        scope: { ...workScope, locator: "memory" },
        mutationId: "create-1",
        source: "prompt-1",
        sourceGeneration: "g1",
        reason: "record work",
      }),
    ),
  );
  const persisted = state.read("SELECT COUNT(*) AS count FROM work_queues");
  expect(persisted.ok && persisted.value[0]?.count).toBe(0);
  const resumed = workValue(
    await locations.select({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      persistentSession: true,
    }),
  );
  expect(resumed.existingQueue).toBe("ephemeral-queue");
  expect(resumed.store.durability).toBe("ephemeral");
  const project = workValue(
    await locations.select({
      sessionId: "other-session",
      workspaceId: "workspace-1",
      scope: "project",
      persistentSession: false,
    }),
  );
  expect(project.store.durability).toBe("durable");
  expect(await locations.at("/arbitrary/path")).toBeNull();
  expect(
    (
      await locations.select({
        sessionId: "other",
        workspaceId: "workspace-1",
        persistentSession: true,
        locator: "missing-registered-store",
      })
    ).ok,
  ).toBeFalse();
  expect(await locations.close()).toBeTrue();
  expect(await locations.at("user-state")).toBeNull();
  const reopened = createWorkQueueLocations({ state, stateRoot: root, clock, open: openBunSqlite });
  expect(
    workValue(
      await reopened.select({
        sessionId: "session-1",
        workspaceId: "workspace-1",
        persistentSession: false,
      }),
    ).existingQueue,
  ).toBeNull();
  await reopened.close();
  await state.close();
});

test("the registered memory location runs the same hierarchy actions", async () => {
  const root = await temporaryRoot("falryn-queue-locations-");
  const state = await openProductStoreOrThrow(root);
  const clock = createSystemClock();
  const locations = createWorkQueueLocations({
    state,
    stateRoot: root,
    clock,
    open: openBunSqlite,
  });
  const selected = workValue(
    await locations.select({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      persistentSession: false,
    }),
  );
  expect(selected.store.durability).toBe("ephemeral");
  const actions = createWorkQueueActions(selected.store, {
    authority: { ...workAuthority, persistentSession: false },
    resources: createProductResources(clock).openTask("configuration-1"),
  });
  const send = (value: unknown) => actions.execute(JSON.stringify(value));
  const provenance = (mutationId: string) => ({
    mutationId,
    source: "prompt-1",
    sourceGeneration: "g1",
    reason: "organize",
  });
  workValue(
    await send({
      version: 2,
      action: "create",
      queueId: "memory-queue",
      objective: "Local work",
      scope: { ...workScope, locator: "memory" },
      ...provenance("create"),
    }),
  );
  const organized = workValue(
    await send({
      version: 2,
      action: "mutate",
      queueId: "memory-queue",
      scopeGeneration: workScope.generation,
      expectedRevision: 1,
      ...provenance("organize"),
      operations: [
        {
          kind: "group",
          groupId: "todo",
          subject: "Todo",
          parentId: null,
          position: { at: "end" },
        },
        { kind: "add", itemId: "task-1", fields: workFields },
        { kind: "place", nodeId: "task-1", parentId: "todo", position: { at: "end" } },
      ],
    }),
  );
  expect(organized.receipt?.version).toBe(2);
  const progress = workValue(
    await send({
      version: 2,
      action: "progress",
      queueId: "memory-queue",
      scopeGeneration: workScope.generation,
      expectedRevision: 2,
      groupId: "todo",
    }),
  ).progress;
  expect(progress).toMatchObject({ total: 1, accepted: 0, groups: 0, state: "in-progress" });
  const persisted = state.read("SELECT COUNT(*) AS count FROM work_groups");
  expect(persisted.ok && persisted.value[0]?.count).toBe(0);
  expect(await locations.close()).toBeTrue();
  await state.close();
});
