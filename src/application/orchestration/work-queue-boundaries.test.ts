import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import {
  actionsFor,
  workAuthority,
  workCode,
  workFields,
  workFixture,
  workScope,
  workValue,
} from "./work-queues.fixtures.ts";

afterEach(removeTemporaryRoots);
test("changed transcript defaults do not strand an existing durable session list", async () => {
  const f = await workFixture();
  workValue(await f.add("retained"));
  const resumed = workValue(
    await actionsFor(f.store, { persistentSession: false }).execute(
      JSON.stringify({ version: 1, action: "resume" }),
    ),
  );
  expect(resumed.queue?.revision).toBe(f.revision());
  await f.store.close();
});
test("unknown and self edges, absent unlink and cyclic diamond updates fail atomically", async () => {
  const f = await workFixture();
  workValue(
    await f.mutate(
      ["a", "b", "c", "d"].map((itemId) => ({ kind: "add", itemId, fields: workFields })),
    ),
  );
  for (const dependency of ["missing", "a"])
    expect(workCode(await f.mutate([{ kind: "link", itemId: "a", dependency }]))).toBe(
      "invalid-dependency",
    );
  expect(workCode(await f.mutate([{ kind: "unlink", itemId: "a", dependency: "b" }]))).toBe(
    "invalid-dependency",
  );
  workValue(
    await f.mutate([
      { kind: "link", itemId: "b", dependency: "a" },
      { kind: "link", itemId: "c", dependency: "a" },
      { kind: "link", itemId: "d", dependency: "b" },
      { kind: "link", itemId: "d", dependency: "c" },
    ]),
  );
  expect(workCode(await f.mutate([{ kind: "link", itemId: "a", dependency: "d" }]))).toBe(
    "invalid-dependency",
  );
  workValue(await f.complete("a"));
  workValue(await f.complete("b"));
  expect(workCode(await f.complete("d"))).toBe("blocked-transition");
  workValue(await f.complete("c"));
  workValue(await f.complete("d"));
  await f.store.close();
});
test("mid-batch cancellation rolls back earlier writes; source remains attributable", async () => {
  const f = await workFixture();
  const abort = new AbortController();
  const actions = actionsFor(f.store, {
    registeredAgent: () => {
      abort.abort();
      return true;
    },
  });
  const result = await actions.execute(
    JSON.stringify(
      f.request([
        { kind: "add", itemId: "first", fields: workFields },
        { kind: "add", itemId: "second", fields: { ...workFields, agentType: "coder" } },
      ]),
    ),
    abort.signal,
  );
  expect(workCode(result)).toBe("cancelled-operation");
  expect(!result.ok && result.error.source).toBe("source-handle");
  expect(workCode(await f.query("show", { itemId: "first" }))).toBe("unavailable");
  await f.store.close();
});
test("shared membership, workspace binding and identical item IDs in separate lists", async () => {
  const f = await workFixture();
  workValue(await f.add("same-id"));
  const create = {
    version: 1,
    action: "create",
    queueId: "shared-queue",
    objective: "Team work",
    scope: { ...workScope, kind: "shared", sessionId: null, members: ["user-2"] },
    mutationId: "shared-create",
    source: "source-handle",
    sourceGeneration: "source-1",
    reason: "explicit list",
  };
  workValue(await f.send(create));
  const request = {
    ...f.request([{ kind: "add", itemId: "same-id", fields: workFields }], 1),
    queueId: "shared-queue",
  };
  workValue(
    await actionsFor(f.store, { actor: "user-2", sessionId: "session-2" }).execute(
      JSON.stringify(request),
    ),
  );
  expect(
    workCode(
      await actionsFor(f.store, { actor: "user-3", sessionId: "session-3" }).execute(
        JSON.stringify({ ...request, expectedRevision: 2 }),
      ),
    ),
  ).toBe("denied");
  expect(
    workCode(
      await actionsFor(f.store, { workspaceId: "different-workspace" }).execute(
        JSON.stringify({ ...request, expectedRevision: 2 }),
      ),
    ),
  ).toBe("denied");
  expect((await f.item("same-id")).revision).toBe(2);
  await f.store.close();
});
test("stale holder cannot complete reassigned work, and cancellation is not reversed by settlement", async () => {
  const f = await workFixture();
  workValue(await f.add("a"));
  const holder = { actor: "user-1", taskId: "task", generation: "generation-1" };
  workValue(await f.mutate([{ kind: "claim", itemId: "a", holder }]));
  workValue(await f.mutate([{ kind: "release", itemId: "a" }]));
  workValue(
    await f.mutate([
      { kind: "claim", itemId: "a", holder: { ...holder, generation: "generation-2" } },
    ]),
  );
  const stale = await f.mutate([
    {
      kind: "submit",
      itemId: "a",
      claimGeneration: 1,
      criteriaRevision: 1,
      evidence: [{ handle: "old-result", generation: "old-generation", source: "old-holder" }],
    },
  ]);
  expect(workCode(stale)).toBe("stale-evidence");
  expect(!stale.ok && stale.error.source).toBe("source-handle");
  expect((await f.item("a")).claim?.generation).toBe(2);
  workValue(await f.mutate([{ kind: "cancel", itemId: "a" }]));
  workValue(await f.mutate([{ kind: "release", itemId: "a" }]));
  expect((await f.item("a")).disposition).toBe("cancelled");
  await f.store.close();
});
test("unknown codecs, missing original sources and meaning changes reject old completion proof", async () => {
  const f = await workFixture();
  expect(workCode(await f.send({ version: 2, action: "resume" }))).toBe("unsupported");
  expect(
    workCode(
      await actionsFor(f.store, { sourceAvailable: () => false }).execute(
        JSON.stringify(f.request([{ kind: "add", itemId: "a", fields: workFields }])),
      ),
    ),
  ).toBe("stale-evidence");
  workValue(await f.add("a"));
  workValue(
    await f.mutate([{ kind: "update", itemId: "a", fields: { objective: "Revised work" } }]),
  );
  expect((await f.item("a")).criteriaRevision).toBe(2);
  const holder = { actor: workAuthority.actor, taskId: "task", generation: "g1" };
  workValue(await f.mutate([{ kind: "claim", itemId: "a", holder }]));
  expect(
    workCode(
      await f.mutate([{ kind: "update", itemId: "a", fields: { objective: "Substituted work" } }]),
    ),
  ).toBe("blocked-transition");
  await f.store.close();
});
