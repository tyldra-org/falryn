import { afterEach, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { decodeWorkflowDefinition } from "../../domain/orchestration/workflow-definition.ts";
import type { WorkflowRecord } from "../../domain/orchestration/workflow-state.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createWorkflowStore } from "./workflow-store.ts";

afterEach(removeTemporaryRoots);
function workflowRecordFixture(): WorkflowRecord {
  const graph = decodeWorkflowDefinition(simpleWorkflow());
  if (!graph.ok) throw new Error("invalid fixture");
  return {
    version: 1,
    handle: { id: "run-1", generation: "generation-1" },
    revision: 1,
    intent: canonicalDigest("intent"),
    definition: graph.definition,
    definitionDigest: graph.digest,
    arguments: {},
    owner: {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      invocationId: "invoke-1",
      attemptId: "attempt-1",
      configurationGeneration: 1,
      resourceTaskId: "root-1",
    },
    authority: canonicalDigest("authority"),
    sourceGeneration: "source-1",
    routes: {},
    createdAt: 1,
    deadline: 30001,
    updatedAt: 1,
    state: "admitted",
    executor: null,
    task: null,
    nodes: [],
    expanded: [],
    limits: { operations: 512 },
    spent: {},
    output: null,
    reusedFrom: null,
  };
}
test("checkpoint, event and revision commit together; stale writes and corrupt replay fail closed", async () => {
  const root = await temporaryRoot("falryn-workflow-store-");
  const db = await openProductStoreOrThrow(root);
  const store = createWorkflowStore(db);
  const record = workflowRecordFixture();
  expect(store.create(record)).toEqual(ok(record));
  expect(store.create({ ...record, intent: canonicalDigest("different") })).toMatchObject({
    ok: false,
    error: { code: "conflicting-identity" },
  });
  expect(
    store.change(record.handle, 1, (current) => ok({ ...current, revision: 2, state: "paused" })),
  ).toMatchObject({ ok: true });
  expect(store.change(record.handle, 1, (current) => ok(current))).toMatchObject({
    ok: false,
    error: { code: "stale-revision", currentRevision: 2 },
  });
  expect(store.get(record.handle, 1)).toEqual(ok(record));
  expect(
    store.change(record.handle, 2, (current) =>
      ok({ ...current, revision: 3, authority: canonicalDigest("changed") }),
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid-transition" } });
  await db.close();
  const restarted = await openProductStoreOrThrow(root);
  const recovered = createWorkflowStore(restarted);
  expect(recovered.get(record.handle)).toMatchObject({
    ok: true,
    value: { revision: 2, state: "paused" },
  });
  expect(recovered.page("foreign", "session-1")).toEqual(ok([]));
  restarted.write((sql) =>
    sql.run("DELETE FROM events WHERE kind='workflow.changed' AND sequence=2"),
  );
  expect(recovered.get(record.handle)).toMatchObject({ ok: false, error: { code: "corrupt" } });
  await restarted.close();
});
