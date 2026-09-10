import { afterEach, expect, test } from "bun:test";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import {
  workAuthority,
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
