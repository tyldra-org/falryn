import { afterEach, describe, expect, test } from "bun:test";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../../data/fixtures.ts";
import {
  actionsFor,
  workCode,
  workFields,
  workFixture,
  workValue,
} from "./work-queues.fixtures.ts";
import type { WorkQueueResponse } from "./work-queues.ts";

afterEach(removeTemporaryRoots);
describe("scoped work-item application actions", () => {
  test("creates, claims completion, accepts current evidence, archives and survives restart", async () => {
    const f = await workFixture();
    workValue(await f.add("item-a"));
    expect((await f.item("item-a")).disposition).toBe("pending");
    workValue(await f.complete("item-a"));
    workValue(await f.mutate([{ kind: "archive", itemId: "item-a" }]));
    const before = await f.item("item-a");
    expect(before.previousDisposition).toBe("completed");
    await f.store.close();
    const reopened = await openProductStoreOrThrow(f.root);
    const actions = actionsFor(reopened);
    const resumed = workValue(
      await actions.execute(JSON.stringify({ version: 1, action: "resume" })),
    );
    expect(resumed.queue?.revision).toBe(f.revision());
    const read = workValue(
      await actions.execute(
        JSON.stringify({
          version: 1,
          action: "show",
          queueId: "queue-1",
          scopeGeneration: "scope-1",
          expectedRevision: f.revision(),
          itemId: "item-a",
        }),
      ),
    );
    expect(read.items?.[0]).toEqual(before);
    await reopened.close();
  });
  test("validates the candidate graph atomically and never treats removed dependencies as success", async () => {
    const f = await workFixture();
    workValue(await f.add("a"));
    workValue(await f.add("b"));
    workValue(await f.mutate([{ kind: "link", itemId: "b", dependency: "a" }]));
    expect(
      workCode(
        await f.mutate([{ kind: "disposition", itemId: "b", value: "ready", reason: "start" }]),
      ),
    ).toBe("blocked-transition");
    expect(
      workCode(
        await f.mutate([
          { kind: "add", itemId: "c", fields: workFields },
          { kind: "link", itemId: "a", dependency: "b" },
        ]),
      ),
    ).toBe("invalid-dependency");
    expect(workCode(await f.query("show", { itemId: "c" }))).toBe("unavailable");
    expect(
      workValue(await f.query("edges", { itemId: "a", direction: "dependents", after: null }))
        .edges,
    ).toEqual(["b"]);
    workValue(await f.mutate([{ kind: "delete", itemId: "a" }]));
    expect((await f.item("b")).unresolvedDependencies).toBeTrue();
    expect(
      workValue(await f.query("edges", { itemId: "b", direction: "dependencies", after: null }))
        .edges,
    ).toEqual([]);
    expect(workCode(await f.add("a"))).toBe("conflicting-identity");
    expect(workCode(await f.complete("b"))).toBe("blocked-transition");
    await f.store.close();
  });
  test("competing writers, exact retries and conflicting mutation identity", async () => {
    const f = await workFixture();
    const second = await openProductStoreOrThrow(f.root);
    const a = f.request([{ kind: "add", itemId: "a", fields: workFields }]);
    const b = {
      ...f.request([{ kind: "add", itemId: "b", fields: workFields }]),
      mutationId: "second-writer",
    };
    const results = await Promise.all([f.send(a), actionsFor(second).execute(JSON.stringify(b))]);
    expect(results.map(workCode).sort()).toEqual(["conflicting-revision", "ok"]);
    const retry = workValue(await f.send(a));
    expect(retry.receipt?.revision).toBe(2);
    expect(workCode(await f.send({ ...a, reason: "changed intent" }))).toBe("conflicting-identity");
    await second.close();
    await f.store.close();
  });
  test("claims are exclusive, release waits for authoritative settlement, and cancel sends no effects", async () => {
    const f = await workFixture();
    workValue(await f.add("a"));
    const holder = { actor: "user-1", taskId: "task-1", generation: "task-generation-1" };
    workValue(await f.mutate([{ kind: "claim", itemId: "a", holder }]));
    expect(workCode(await f.mutate([{ kind: "claim", itemId: "a", holder }]))).toBe(
      "blocked-transition",
    );
    const uncertain = actionsFor(f.store, { observeExecution: () => null });
    const pending = workValue(
      await uncertain.execute(JSON.stringify(f.request([{ kind: "release", itemId: "a" }]))),
    );
    expect(pending.queue?.revision).toBe(4);
    const result = await uncertain.execute(
      JSON.stringify(f.request([{ kind: "delete", itemId: "a" }], 4)),
    );
    expect(workCode(result)).toBe("blocked-transition");
    const read = workValue(
      await uncertain.execute(
        JSON.stringify({
          version: 1,
          action: "show",
          queueId: "queue-1",
          scopeGeneration: "scope-1",
          expectedRevision: 4,
          itemId: "a",
        }),
      ),
    );
    expect(read.items?.[0]?.claim?.releasePending).toBeTrue();
    const cancelled = workValue(
      await uncertain.execute(JSON.stringify(f.request([{ kind: "cancel", itemId: "a" }], 4))),
    );
    expect(cancelled.queue?.revision).toBe(5);
    await f.store.close();
  });
  test("scope, secret, registered-agent and generation boundaries reject before writes", async () => {
    const f = await workFixture();
    for (const fields of [
      { ...workFields, objective: "api_key=super-secret" },
      { ...workFields, metadata: { password: "secret" } },
    ])
      expect(workCode(await f.mutate([{ kind: "add", itemId: "a", fields }]))).toBe("denied");
    expect(
      workCode(
        await f.mutate([
          { kind: "add", itemId: "a", fields: { ...workFields, agentType: "unregistered" } },
        ]),
      ),
    ).toBe("unsupported");
    expect(
      workCode(
        await actionsFor(f.store, { sessionId: "session-other" }).execute(
          JSON.stringify(f.request([{ kind: "add", itemId: "a", fields: workFields }])),
        ),
      ),
    ).toBe("denied");
    expect(
      workCode(
        await f.send({
          ...f.request([{ kind: "add", itemId: "a", fields: workFields }]),
          scopeGeneration: "stale",
        }),
      ),
    ).toBe("denied");
    workValue(await f.add("a"));
    workValue(
      await f.mutate([
        { kind: "update", itemId: "a", fields: { metadata: { note: "first", remove: true } } },
      ]),
    );
    workValue(
      await f.mutate([{ kind: "update", itemId: "a", fields: { metadata: { remove: null } } }]),
    );
    expect((await f.item("a")).metadata).toEqual({ note: "first" });
    await f.store.close();
  });
  test("completion must pass current item/claim/criteria/evidence and host validator", async () => {
    const f = await workFixture();
    workValue(await f.add("a"));
    const evidence = [{ handle: "artifact", generation: "g1", source: "validator" }];
    workValue(
      await f.mutate([
        { kind: "submit", itemId: "a", claimGeneration: 0, criteriaRevision: 1, evidence },
      ]),
    );
    const current = await f.item("a");
    const op = {
      kind: "validate",
      itemId: "a",
      itemRevision: current.revision,
      claimGeneration: 0,
      criteriaRevision: 1,
      evidence,
      authority: "user",
      verdict: "accept",
      reason: "Checked",
    };
    expect(workCode(await f.mutate([{ ...op, criteriaRevision: 2 }]))).toBe("stale-evidence");
    expect(workCode(await f.mutate([{ ...op, authority: "peer-message" }]))).toBe("denied");
    expect((await f.item("a")).disposition).toBe("completion-claimed");
    workValue(await f.mutate([op]));
    await f.store.close();
  });
  test("per-call limits, UTF-8 bytes and validation exhaustion preserve accepted batches", async () => {
    const f = await workFixture();
    workValue(await f.add("a"));
    const before = f.revision();
    expect(
      workCode(
        await f.mutate(
          Array.from({ length: 101 }, (_, i) => ({
            kind: "add",
            itemId: `n${i}`,
            fields: workFields,
          })),
        ),
      ),
    ).toBe("malformed");
    expect(
      workCode(
        await f.mutate([
          { kind: "add", itemId: "b", fields: { ...workFields, description: "😀".repeat(5000) } },
        ]),
      ),
    ).toBe("resource-exhausted");
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      workCode(
        await f.actions.execute(
          JSON.stringify(f.request([{ kind: "add", itemId: "b", fields: workFields }])),
          cancelled.signal,
        ),
      ),
    ).toBe("cancelled-operation");
    expect(
      workCode(
        await actionsFor(f.store, {}, { traversalSteps: 0 }).execute(
          JSON.stringify(f.request([{ kind: "add", itemId: "b", fields: workFields }])),
        ),
      ),
    ).toBe("resource-exhausted");
    expect(f.revision()).toBe(before);
    expect(String((await f.item("a")).id)).toBe("a");
    await f.store.close();
  });
  test("large and growing lists have revision-bound pages and no retained creation quota", async () => {
    const f = await workFixture();
    for (let batch = 0; batch < 12; batch++)
      workValue(
        await f.mutate(
          Array.from({ length: 100 }, (_, i) => ({
            kind: "add",
            itemId: `item-${String(batch * 100 + i).padStart(5, "0")}`,
            fields: workFields,
          })),
        ),
      );
    let after: string | null = null,
      count = 0;
    do {
      const page: WorkQueueResponse = workValue(await f.query("list", { after, limit: 100 }));
      count += page.items?.length ?? 0;
      after = typeof page.next === "string" ? page.next : null;
    } while (after !== null);
    expect(count).toBe(1200);
    const previous = f.revision();
    workValue(await f.add("last"));
    expect(
      workCode(
        await f.send({
          version: 1,
          action: "list",
          queueId: "queue-1",
          scopeGeneration: "scope-1",
          expectedRevision: previous,
          after: null,
          limit: 100,
        }),
      ),
    ).toBe("stale-page");
    await f.store.close();
  });
});
