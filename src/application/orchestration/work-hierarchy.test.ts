/**
 * Groups, placement, progress and removal through the real application boundary
 * and SQLite store, including legacy flat queues and restart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  openProductStore,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "../../data/fixtures.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { PRODUCTION_MIGRATIONS } from "../../data/sqlite/sqlite-migrations.ts";
import { MIGRATION_TABLE } from "../../data/sqlite/sqlite-store.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import type { WorkProgress } from "../../domain/orchestration/work-hierarchy.ts";
import type { WorkItem, WorkResult } from "../../domain/orchestration/work-queue.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createProductResources } from "./product-resources.ts";
import {
  actionsFor,
  workAuthority,
  workCode,
  workFields,
  workFixture,
  workScope,
  workValue,
} from "./work-queues.fixtures.ts";
import {
  createWorkQueueActions,
  type WorkQueueResponse,
  type WorkTaskFact,
} from "./work-queues.ts";

afterEach(removeTemporaryRoots);

type Actions = ReturnType<typeof actionsFor>;
const end = { at: "end" as const };
const group = (groupId: string, subject: string, parentId: string | null = null) => ({
  kind: "group",
  groupId,
  subject,
  parentId,
  position: end,
});
const place = (nodeId: string, parentId: string | null, position: unknown = end) => ({
  kind: "place",
  nodeId,
  parentId,
  position,
});
const add = (itemId: string) => ({ kind: "add", itemId, fields: workFields });

function client(actions: Actions, queueId = "queue-1") {
  let sequence = 0;
  const send = (value: unknown) => actions.execute(JSON.stringify(value));
  /** A pinned read at revision 0 either succeeds or reports the current revision. */
  const revision = async () => {
    const probe = await send({
      version: 2,
      action: "children",
      queueId,
      scopeGeneration: "scope-1",
      expectedRevision: 0,
      parentId: null,
      after: null,
      limit: 1,
    });
    if (probe.ok) return probe.value.queue?.revision ?? 0;
    if (probe.error.currentRevision === undefined) throw new Error(probe.error.code);
    return probe.error.currentRevision;
  };
  const selection = async () => ({
    queueId,
    scopeGeneration: "scope-1",
    expectedRevision: await revision(),
  });
  const mutate = async (operations: unknown[], mutationId = `organize-${++sequence}`) =>
    send({
      version: 2,
      action: "mutate",
      ...(await selection()),
      mutationId,
      source: "source-handle",
      sourceGeneration: "source-1",
      reason: "organize work",
      operations,
    });
  const query = async (action: string, more: Record<string, unknown> = {}) =>
    send({ version: 2, action, ...(await selection()), ...more });
  return {
    send,
    mutate,
    query,
    revision,
    async item(itemId: string): Promise<WorkItem> {
      const node = workValue(await query("node", { nodeId: itemId })).nodes?.[0];
      if (node?.kind !== "task") throw new Error("expected a task");
      return node.item;
    },
    async progress(groupId: string | null) {
      const progress = workValue(await query("progress", { groupId })).progress;
      if (!progress) throw new Error("missing progress");
      return progress;
    },
    async accept(itemId: string) {
      const evidence = [{ handle: "artifact-1", generation: "a-1", source: "validator" }];
      const item = await this.item(itemId);
      workValue(
        await mutate([
          {
            kind: "submit",
            itemId,
            claimGeneration: item.claimGeneration,
            criteriaRevision: item.criteriaRevision,
            evidence,
          },
        ]),
      );
      const submitted = await this.item(itemId);
      return mutate([
        {
          kind: "validate",
          itemId,
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
    ids(response: WorkResult<WorkQueueResponse>): string[] {
      return (workValue(response).nodes ?? []).map((node) =>
        String(node.kind === "task" ? node.item.id : node.group.id),
      );
    },
  };
}
/** Compares wire values without their branded or literal types. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const fraction = (p: { accepted: number; total: number }) => `${p.accepted}/${p.total}`;

async function organized() {
  const f = await workFixture();
  const c = client(f.actions);
  const created = workValue(
    await c.mutate([
      group("admission", "Admission"),
      group("implementation", "Implementation"),
      group("verification", "Verification"),
      group("delivery", "Delivery"),
      group("backlog", "Backlog"),
      ...["t-admit", "t-build", "t-check", "t-ship", "t-notes"].map(add),
      place("t-admit", "admission"),
      place("t-build", "implementation"),
      place("t-check", "verification"),
      place("t-ship", "delivery"),
      place("t-notes", "delivery"),
    ]),
  );
  return { f, c, created };
}

describe("todo groups and derived progress", () => {
  test("atomically organizes four named groups and five tasks and derives exact progress", async () => {
    const { f, c, created } = await organized();
    expect(created.receipt?.version).toBe(2);
    expect(created.receipt?.previousRevision).toBe(1);
    const groups = ["admission", "implementation", "verification", "delivery"];
    const before = await Promise.all(groups.map((id) => c.progress(id)));
    expect(before.map(fraction)).toEqual(["0/1", "0/1", "0/1", "0/2"]);
    expect(fraction(await c.progress(null))).toBe("0/5");

    const accepted = workValue(await c.accept("t-ship"));
    expect(accepted.receipt?.version).toBe(1);
    const after = await Promise.all(groups.map((id) => c.progress(id)));
    expect(after.map(fraction)).toEqual(["0/1", "0/1", "0/1", "1/2"]);
    expect(fraction(await c.progress(null))).toBe("1/5");

    workValue(await c.mutate([{ kind: "archive", itemId: "t-ship" }]));
    const archived = await c.progress("delivery");
    expect(fraction(archived)).toBe("1/2");
    expect(archived.archived).toBe(1);
    expect(archived.dispositions.completed).toBe(1);

    workValue(await c.mutate([{ kind: "cancel", itemId: "t-notes" }]));
    const cancelled = await c.progress("delivery");
    expect(fraction(cancelled)).toBe("1/2");
    expect(cancelled.dispositions).toMatchObject({ completed: 1, cancelled: 1 });
    expect(cancelled.state).toBe("in-progress");
    expect(fraction(await c.progress(null))).toBe("1/5");

    const empty = await c.progress("backlog");
    expect(empty).toMatchObject({ total: 0, accepted: 0, state: "empty" });
    expect(fraction(await c.progress("verification"))).toBe("0/1");
    await f.store.close();
  });

  test("a group shows all completed only when every counted task is accepted", async () => {
    const { f, c } = await organized();
    workValue(await c.accept("t-check"));
    expect((await c.progress("verification")).state).toBe("all-completed");
    // Nested groups count each descendant task once; groups never count.
    workValue(await c.mutate([place("verification", "delivery")]));
    const delivery = await c.progress("delivery");
    expect(fraction(delivery)).toBe("1/3");
    expect(delivery.groups).toBe(1);
    await f.store.close();
  });

  test("hierarchy queries page at one revision and refuse stale cursors", async () => {
    const { f, c } = await organized();
    const roots = await c.query("children", { parentId: null, after: null, limit: 3 });
    expect(c.ids(roots)).toEqual(["admission", "implementation", "verification"]);
    const cursor = workValue(roots).next;
    expect(cursor).toBe("verification");
    expect(c.ids(await c.query("children", { parentId: null, after: cursor, limit: 10 }))).toEqual([
      "delivery",
      "backlog",
    ]);
    workValue(await c.mutate([place("t-ship", "delivery", { at: "before", sibling: "t-notes" })]));
    expect(
      c.ids(await c.query("children", { parentId: "delivery", after: null, limit: 10 })),
    ).toEqual(["t-ship", "t-notes"]);
    workValue(await c.mutate([place("t-ship", "delivery", { at: "after", sibling: "t-notes" })]));
    expect(
      c.ids(await c.query("children", { parentId: "delivery", after: null, limit: 10 })),
    ).toEqual(["t-notes", "t-ship"]);
    const stale = await c.send({
      version: 2,
      action: "children",
      queueId: "queue-1",
      scopeGeneration: "scope-1",
      expectedRevision: 2,
      parentId: null,
      after: null,
      limit: 10,
    });
    expect(workCode(stale)).toBe("stale-page");

    workValue(await c.mutate([group("inner", "Inner", "delivery"), place("t-notes", "inner")]));
    expect(
      c.ids(await c.query("subtree", { groupId: "delivery", after: null, limit: 10 })),
    ).toEqual(["t-ship", "inner", "t-notes"]);
    const page = await c.query("subtree", { groupId: "delivery", after: null, limit: 2 });
    expect(workValue(page).next).toBe("inner");
    expect(
      c.ids(await c.query("subtree", { groupId: "delivery", after: "inner", limit: 2 })),
    ).toEqual(["t-notes"]);
    expect(c.ids(await c.query("ancestors", { nodeId: "t-notes" }))).toEqual(["delivery", "inner"]);
    const node = workValue(await c.query("node", { nodeId: "t-notes" })).nodes?.[0];
    expect(node).toMatchObject({ kind: "task", parentId: "inner" });
    await f.store.close();
  });

  test("duplicate titles are allowed and the same IDs stay independent across queues", async () => {
    const { f, c } = await organized();
    workValue(await c.mutate([group("second-delivery", "Delivery")]));
    workValue(
      await c.send({
        version: 2,
        action: "create",
        queueId: "queue-2",
        scope: workScope,
        objective: "Other list",
        mutationId: "create-queue-2",
        source: "source-handle",
        sourceGeneration: "source-1",
        reason: "second list",
      }),
    );
    const other = client(f.actions, "queue-2");
    workValue(
      await other.mutate([
        group("delivery", "Delivery"),
        add("t-ship"),
        place("t-ship", "delivery"),
      ]),
    );
    expect(fraction(await other.progress("delivery"))).toBe("0/1");
    expect(fraction(await c.progress("delivery"))).toBe("0/2");
    await f.store.close();
  });
});

describe("selection expansion", () => {
  test("overlapping nested groups expand each task once at one revision, or refuse as stale", async () => {
    const { f, c } = await organized();
    workValue(
      await c.mutate([
        group("inner", "Inner", "delivery"),
        place("t-notes", "inner"),
        { kind: "cancel", itemId: "t-build" },
      ]),
    );
    const revision = await c.revision();
    const expand = (expectedRevision: number) =>
      c.send({
        version: 2,
        action: "expand",
        queueId: "queue-1",
        scopeGeneration: "scope-1",
        expectedRevision,
        groups: ["delivery", "inner", "implementation"],
        tasks: ["t-notes", "t-admit"],
      });
    const manifest = workValue(await expand(revision)).manifest;
    expect(plain(manifest)).toEqual({
      revision,
      groups: ["delivery", "inner", "implementation"],
      tasks: [
        { id: "t-ship", status: "admissible" },
        { id: "t-notes", status: "admissible" },
        { id: "t-build", status: "cancelled" },
        { id: "t-admit", status: "admissible" },
      ],
    });
    workValue(await c.mutate([add("t-new"), place("t-new", "inner")]));
    expect(workCode(await expand(revision))).toBe("stale-page");
    expect(workCode(await c.query("expand", { groups: ["t-ship"], tasks: [] }))).toBe(
      "invalid-hierarchy",
    );
    await f.store.close();
  });
});

describe("hierarchy invariants", () => {
  test("concurrent opposite moves cannot form a cycle", async () => {
    const f = await workFixture();
    const c = client(f.actions);
    workValue(await c.mutate([group("a", "A"), group("b", "B")]));
    const revision = await c.revision();
    const move = (nodeId: string, parentId: string, mutationId: string) =>
      c.send({
        version: 2,
        action: "mutate",
        queueId: "queue-1",
        scopeGeneration: "scope-1",
        expectedRevision: revision,
        mutationId,
        source: "source-handle",
        sourceGeneration: "source-1",
        reason: "move",
        operations: [place(nodeId, parentId)],
      });
    const results = await Promise.all([move("a", "b", "move-a"), move("b", "a", "move-b")]);
    expect(results.map(workCode).toSorted()).toEqual(["conflicting-revision", "ok"]);
    const loser = results[0]?.ok ? ["b", "a"] : ["a", "b"];
    expect(workCode(await c.mutate([place(loser[0] ?? "", loser[1] ?? "")]))).toBe(
      "invalid-hierarchy",
    );
    expect(workCode(await c.mutate([place("a", "a")]))).toBe("invalid-hierarchy");
    await f.store.close();
  });

  test("depth 32 is accepted and depth 33 refused for groups, tasks and moved subtrees", async () => {
    const f = await workFixture();
    const c = client(f.actions);
    const chain = Array.from({ length: 32 }, (_, index) => `g${index + 1}`);
    workValue(
      await c.mutate(
        chain.map((id, index) => group(id, id, index === 0 ? null : chain[index - 1])),
      ),
    );
    expect(c.ids(await c.query("ancestors", { nodeId: "g32" }))).toHaveLength(31);
    expect(workCode(await c.mutate([group("g33", "g33", "g32")]))).toBe("invalid-hierarchy");
    expect(workCode(await c.mutate([add("deep"), place("deep", "g32")]))).toBe("invalid-hierarchy");
    workValue(await c.mutate([add("deep"), place("deep", "g31")]));
    workValue(await c.mutate([group("top", "Top"), group("top-inner", "Top inner", "top")]));
    // g2's subtree reaches depth 32 below a depth-1 parent; below a depth-2 one it would reach 33.
    expect(workCode(await c.mutate([place("g2", "top-inner")]))).toBe("invalid-hierarchy");
    workValue(await c.mutate([place("g3", "top-inner")]));
    expect(c.ids(await c.query("ancestors", { nodeId: "g32" }))).toHaveLength(31);
    await f.store.close();
  });

  test("groups are never task endpoints and legacy clients see tasks only", async () => {
    const { f, c } = await organized();
    expect(
      workCode(await c.mutate([{ kind: "link", itemId: "t-ship", dependency: "delivery" }])),
    ).toBe("invalid-dependency");
    expect(
      workCode(
        await c.mutate([
          {
            kind: "claim",
            itemId: "delivery",
            holder: { taskId: "t", generation: "1", actor: "user-1" },
          },
        ]),
      ),
    ).toBe("invalid-hierarchy");
    expect(workCode(await c.mutate([place("t-build", "t-ship")]))).toBe("invalid-hierarchy");
    expect(workCode(await c.mutate([place("t-build", "missing-group")]))).toBe("unavailable");
    expect(workCode(await c.mutate([add("delivery")]))).toBe("conflicting-identity");
    expect(workCode(await c.mutate([group("t-ship", "Clash")]))).toBe("conflicting-identity");
    expect(workCode(await f.query("show", { itemId: "delivery" }))).not.toBe("ok");
    const listed = await f.actions.execute(
      JSON.stringify({
        version: 1,
        action: "list",
        queueId: "queue-1",
        scopeGeneration: "scope-1",
        expectedRevision: await c.revision(),
        after: null,
        limit: 100,
      }),
    );
    expect(plain(workValue(listed).items?.map((item) => item.id))).toEqual([
      "t-admit",
      "t-build",
      "t-check",
      "t-notes",
      "t-ship",
    ]);
    // A version 1 client cannot express a group operation at all.
    expect(
      workCode(
        await f.actions.execute(
          JSON.stringify({
            version: 1,
            action: "mutate",
            queueId: "queue-1",
            scopeGeneration: "scope-1",
            expectedRevision: await c.revision(),
            mutationId: "legacy-group",
            source: "source-handle",
            sourceGeneration: "source-1",
            reason: "legacy",
            operations: [group("legacy", "Legacy")],
          }),
        ),
      ),
    ).toBe("malformed");
    await f.store.close();
  });

  test("an active task moves without changing its claim and cannot be deleted", async () => {
    const { f, c } = await organized();
    const holder = { taskId: "task-1", generation: "g1", actor: "user-1" };
    workValue(await c.mutate([{ kind: "claim", itemId: "t-build", holder }]));
    const claimed = await c.item("t-build");
    workValue(await c.mutate([place("t-build", "delivery")]));
    const moved = await c.item("t-build");
    expect(moved).toEqual(claimed);
    expect(workValue(await c.query("node", { nodeId: "t-build" })).nodes?.[0]).toMatchObject({
      parentId: "delivery",
    });
    expect(workCode(await c.mutate([{ kind: "delete", itemId: "t-build" }]))).toBe(
      "blocked-transition",
    );
    await f.store.close();
  });

  test("a missing parent is a recovery condition, never silently reparented", async () => {
    const { f, c } = await organized();
    const written = f.store.write((sql) => {
      sql.run("UPDATE work_placements SET parent_id='ghost' WHERE node_id='t-ship'");
    });
    expect(written.ok).toBeTrue();
    expect(workCode(await c.query("ancestors", { nodeId: "t-ship" }))).toBe("corrupt");
    await f.store.close();
  });
});

describe("receipt bounds", () => {
  test("a full batch of maximum-length identifiers still commits one receipt", async () => {
    const f = await workFixture();
    const c = client(f.actions);
    const long = (prefix: string, index: number) =>
      `${prefix}${String(index).padStart(3, "0")}`.padEnd(128, "x");
    const groups = Array.from({ length: 50 }, (_, index) => long("g", index));
    workValue(
      await c.mutate(groups.map((id, index) => group(id, id, index === 0 ? null : groups[0]))),
    );
    const tasks = Array.from({ length: 50 }, (_, index) => long("t", index));
    const committed = workValue(
      await c.mutate(tasks.flatMap((id, index) => [add(id), place(id, groups[index] ?? null)])),
    );
    expect(committed.receipt?.version).toBe(2);
    expect(committed.receipt?.version === 2 && committed.receipt.affected).toMatchObject({
      complete: true,
    });
    expect(Buffer.byteLength(JSON.stringify(committed.receipt))).toBeLessThan(65_536);
    await f.store.close();
  });
});

describe("group removal", () => {
  test("refuses a nonempty group unless the same batch moves its children", async () => {
    const { f, c } = await organized();
    expect(workCode(await c.mutate([{ kind: "remove-group", groupId: "delivery" }]))).toBe(
      "blocked-transition",
    );
    const removed = workValue(
      await c.mutate([
        place("t-ship", null),
        place("t-notes", "admission"),
        { kind: "remove-group", groupId: "delivery" },
      ]),
    );
    expect(removed.receipt?.version).toBe(2);
    expect(fraction(await c.progress("admission"))).toBe("0/2");
    expect(fraction(await c.progress(null))).toBe("0/5");
    expect(workCode(await c.query("progress", { groupId: "delivery" }))).toBe("unavailable");
    await f.store.close();
  });

  test("subtree removal deletes the exact reviewed set with dependency safeguards", async () => {
    const { f, c } = await organized();
    workValue(
      await c.mutate([
        group("inner", "Inner", "delivery"),
        place("t-notes", "inner"),
        add("outside"),
        { kind: "link", itemId: "outside", dependency: "t-ship" },
      ]),
    );
    expect(
      workCode(
        await c.mutate([
          {
            kind: "remove-subtree",
            groupId: "delivery",
            reviewed: ["t-ship", "inner", "delivery"],
          },
        ]),
      ),
    ).toBe("stale-evidence");
    const plan = workValue(await c.query("removal-plan", { groupId: "delivery" })).plan;
    expect(plain(plan?.batches)).toEqual([
      [
        { kind: "delete", itemId: "t-ship" },
        { kind: "delete", itemId: "t-notes" },
        { kind: "remove-group", groupId: "inner" },
        { kind: "remove-group", groupId: "delivery" },
      ],
    ]);
    workValue(
      await c.mutate([
        {
          kind: "remove-subtree",
          groupId: "delivery",
          reviewed: ["t-ship", "t-notes", "inner", "delivery"],
        },
      ]),
    );
    expect((await c.item("t-ship")).deleted).toBeTrue();
    expect(await c.item("outside")).toMatchObject({
      disposition: "blocked",
      reason: "dependency-deleted",
      unresolvedDependencies: true,
    });
    expect(fraction(await c.progress(null))).toBe("0/4");
    await f.store.close();
  });

  test("a subtree larger than one transaction is removed through explicit batches", async () => {
    const f = await workFixture();
    const c = client(f.actions);
    workValue(await c.mutate([group("big", "Big")]));
    const ids = Array.from({ length: 150 }, (_, index) => `task-${String(index).padStart(3, "0")}`);
    for (let start = 0; start < ids.length; start += 50)
      workValue(
        await c.mutate(ids.slice(start, start + 50).flatMap((id) => [add(id), place(id, "big")])),
      );
    const refused = await c.mutate([
      { kind: "remove-subtree", groupId: "big", reviewed: ids.slice(0, 100) },
    ]);
    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "resource-exhausted",
      incomplete: true,
    });
    const plan = workValue(await c.query("removal-plan", { groupId: "big" })).plan;
    expect(plan?.batches.map((batch) => batch.length)).toEqual([100, 51]);
    workValue(await c.mutate(plan?.batches[0] ?? []));
    // Interrupted here: the first batch stays committed and the rest is re-planned.
    expect(fraction(await c.progress("big"))).toBe("0/50");
    const rest = workValue(await c.query("removal-plan", { groupId: "big" })).plan;
    expect(rest?.batches.map((batch) => batch.length)).toEqual([51]);
    workValue(await c.mutate(rest?.batches[0] ?? []));
    expect(workCode(await c.query("progress", { groupId: "big" }))).toBe("unavailable");
    const history = workValue(await c.query("history", { afterRevision: 0, limit: 100 })).history;
    expect(history?.at(-1)?.revision).toBe(await c.revision());
    await f.store.close();
  });

  test("bounded progress pages are partial, pinned to one revision and sum exactly", async () => {
    const { f, c } = await organized();
    const exact = await c.progress(null);
    const bounded = client(actionsFor(f.store, {}, { traversalSteps: 24 }));
    const revision = await c.revision();
    const page = async (after: string | null, expectedRevision = revision) =>
      bounded.send({
        version: 2,
        action: "progress",
        queueId: "queue-1",
        scopeGeneration: "scope-1",
        expectedRevision,
        groupId: null,
        after,
      });
    let after: string | null = null;
    let total = 0;
    let accepted = 0;
    let groups = 0;
    let pages = 0;
    for (;;) {
      const progress: WorkProgress | undefined = workValue(await page(after)).progress;
      if (!progress) throw new Error("missing progress");
      pages += 1;
      // A page that covers part of the queue never claims empty or all-completed.
      expect(progress.state).toBe("partial");
      total += progress.total;
      accepted += progress.accepted;
      groups += progress.groups;
      if (progress.coverage.complete) break;
      after = progress.coverage.next;
      expect(after).not.toBeNull();
    }
    expect(pages).toBeGreaterThan(1);
    expect({ total, accepted, groups }).toEqual({
      total: exact.total,
      accepted: exact.accepted,
      groups: exact.groups,
    });
    workValue(await c.mutate([add("late")]));
    expect(workCode(await page("admission"))).toBe("stale-page");
    // A bound too small to count even one node refuses rather than returning an empty page.
    const starved = actionsFor(f.store, {}, { traversalSteps: 1 });
    const refused = await starved.execute(
      JSON.stringify({
        version: 2,
        action: "progress",
        queueId: "queue-1",
        scopeGeneration: "scope-1",
        expectedRevision: await c.revision(),
        groupId: null,
      }),
    );
    expect(refused.ok ? null : refused.error).toMatchObject({
      code: "resource-exhausted",
      incomplete: true,
    });
    await f.store.close();
  });
});

describe("committed task facts", () => {
  test("report creation and acceptance once, outside the transaction, and never on replay", async () => {
    const f = await workFixture();
    const observed: WorkTaskFact[][] = [];
    let fail = false;
    const actions = createWorkQueueActions(
      createSqliteWorkQueueStore(f.store, { locator: "user-state", durability: "durable" }),
      {
        authority: workAuthority,
        resources: createProductResources(createSystemClock()).openTask("configuration-1"),
        observe(facts) {
          observed.push([...facts]);
          if (fail) throw new Error("observer down");
        },
      },
    );
    const c = client(actions);
    const created = workValue(await c.mutate([group("g", "G"), add("a"), place("a", "g")]));
    expect(plain(created.facts?.map((fact) => [fact.kind, fact.id, fact.revision]))).toEqual([
      ["task-created", "a", created.queue?.revision],
    ]);
    fail = true;
    const accepted = workValue(await c.accept("a"));
    expect(accepted.observer).toBe("failed");
    expect(accepted.facts?.map((fact) => fact.kind)).toEqual(["task-accepted"]);
    expect((await c.item("a")).disposition).toBe("completed");
    const calls = observed.length;
    const replayRequest = {
      version: 2,
      action: "mutate",
      queueId: "queue-1",
      scopeGeneration: "scope-1",
      expectedRevision: created.receipt?.previousRevision,
      mutationId: "organize-1",
      source: "source-handle",
      sourceGeneration: "source-1",
      reason: "organize work",
      operations: [group("g", "G"), add("a"), place("a", "g")],
    };
    const replayed = workValue(await actions.execute(JSON.stringify(replayRequest)));
    expect(replayed.receipt).toEqual(created.receipt);
    expect(replayed.facts).toBeUndefined();
    expect(observed).toHaveLength(calls);
    await f.store.close();
  });
});

describe("compatibility", () => {
  async function rollBackToSchema30(store: SqliteStorePort) {
    const written = store.write((sql) => {
      for (const table of [
        "work_placement_versions",
        "work_placements",
        "work_group_versions",
        "work_groups",
      ])
        sql.run(`DROP TABLE ${table}`);
      sql.run(`DELETE FROM ${MIGRATION_TABLE} WHERE version = 31`);
    });
    expect(written.ok).toBeTrue();
  }

  test("migrates a real flat v1 queue, keeps its receipts and IDs, and refuses an older build", async () => {
    const f = await workFixture();
    for (const id of ["charlie", "alpha", "bravo"]) workValue(await f.add(id));
    workValue(await f.complete("alpha"));
    const v1History = workValue(await f.query("history", { afterRevision: 0, limit: 100 })).history;
    expect(v1History?.every((receipt) => receipt.version === 1)).toBeTrue();
    const before = await f.item("alpha");
    await rollBackToSchema30(f.store);
    await f.store.close();

    const migrated = await openProductStoreOrThrow(f.root);
    expect(migrated.report.appliedThisRun).toEqual([31]);
    const c = client(actionsFor(migrated));
    expect(c.ids(await c.query("children", { parentId: null, after: null, limit: 10 }))).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(await c.item("alpha")).toEqual(before);
    expect(workValue(await c.query("history", { afterRevision: 0, limit: 100 })).history).toEqual(
      v1History,
    );
    expect(fraction(await c.progress(null))).toBe("1/3");
    workValue(await c.mutate([group("done", "Done"), place("alpha", "done")]));
    expect(fraction(await c.progress("done"))).toBe("1/1");
    await migrated.close();

    const older = await openProductStore(f.root, {
      migrations: PRODUCTION_MIGRATIONS.slice(0, 30),
    });
    expect(older.ok ? null : older.error).toMatchObject({ code: "schema-too-new" });

    const reopened = await openProductStoreOrThrow(f.root);
    const again = client(actionsFor(reopened));
    expect(fraction(await again.progress("done"))).toBe("1/1");
    expect(
      plain(
        (
          workValue(await again.query("history", { afterRevision: 0, limit: 100 })).history ?? []
        ).map((receipt) => receipt.version),
      ),
    ).toEqual([...(v1History ?? []).map(() => 1), 2]);
    await reopened.close();
  });
});
