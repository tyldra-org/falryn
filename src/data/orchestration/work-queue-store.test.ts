import { afterEach, expect, test } from "bun:test";
import {
  actionsFor,
  workCode,
  workFields,
  workFixture,
  workValue,
} from "../../application/orchestration/work-queues.fixtures.ts";
import { removeTemporaryRoots } from "../fixtures.ts";

afterEach(removeTemporaryRoots);
test("cancellation observed after commit returns the committed receipt", async () => {
  const f = await workFixture();
  const abort = new AbortController();
  const actions = actionsFor({
    ...f.store,
    write(work, signal) {
      const result = f.store.write(work, signal);
      if (result.ok) abort.abort();
      return result;
    },
  });
  const result = workValue(
    await actions.execute(
      JSON.stringify(f.request([{ kind: "add", itemId: "committed", fields: workFields }])),
      abort.signal,
    ),
  );
  expect(result.receipt?.revision).toBe(2);
  await f.store.close();
});
test("replay preserves historical records and dependencies across deletion", async () => {
  const f = await workFixture();
  workValue(await f.add("a"));
  workValue(await f.add("b"));
  workValue(await f.mutate([{ kind: "link", itemId: "b", dependency: "a" }]));
  const revision = f.revision();
  workValue(await f.mutate([{ kind: "delete", itemId: "a" }]));
  const replay = workValue(
    await f.query("replay", { atRevision: revision, after: null, limit: 100 }),
  );
  expect(replay.queue?.revision).toBe(revision);
  expect(replay.items?.every((item) => !item.deleted)).toBeTrue();
  expect(
    workValue(
      await f.query("edges", {
        itemId: "b",
        direction: "dependencies",
        after: null,
        atRevision: revision,
      }),
    ).edges,
  ).toEqual(["a"]);
  expect((await f.item("a")).deleted).toBeTrue();
  expect(
    workValue(await f.query("history", { afterRevision: 0, limit: 100 })).history?.length,
  ).toBe(f.revision());
  await f.store.close();
});
test("corrupt item or missing receipt is not an empty successful queue", async () => {
  const f = await workFixture();
  workValue(await f.add("a"));
  f.store.write((sql) => sql.run("UPDATE work_items SET record='{}' WHERE item_id='a'"));
  expect(workCode(await f.query("show", { itemId: "a" }))).toBe("corrupt");
  f.store.write((sql) => sql.run("DELETE FROM work_mutations WHERE revision=2"));
  expect(workCode(await f.query("list", { after: null, limit: 100 }))).toBe("recovery-required");
  await f.store.close();
});
test("real SQLite storage exhaustion rolls back the whole candidate", async () => {
  const f = await workFixture();
  workValue(await f.add("accepted"));
  const set = f.store.write((sql) => {
    const count = sql.all("PRAGMA page_count")[0]?.page_count;
    if (typeof count !== "number") throw new Error("page count unavailable");
    sql.run(`PRAGMA max_page_count=${count}`);
  });
  expect(set.ok).toBeTrue();
  const result = await f.mutate(
    Array.from({ length: 80 }, (_, i) => ({
      kind: "add",
      itemId: `new-${i}`,
      fields: { ...workFields, description: "data".repeat(2000) },
    })),
  );
  expect(workCode(result)).toBe("resource-exhausted");
  expect(String((await f.item("accepted")).id)).toBe("accepted");
  expect(workCode(await f.query("show", { itemId: "new-0" }))).toBe("unavailable");
  await f.store.close();
});
test("uncertain commit is reconciled by the durable mutation identity", async () => {
  const f = await workFixture();
  const request = f.request([{ kind: "add", itemId: "once", fields: workFields }]);
  const uncertain = actionsFor({
    ...f.store,
    write(work, signal) {
      const result = f.store.write(work, signal);
      return result.ok
        ? {
            ok: false,
            error: {
              kind: "sqlite-store",
              code: "unavailable",
              operation: "transaction",
              effect: "uncertain",
              cause: {
                kind: "sqlite",
                code: "io-failure",
                operation: "transaction",
                driverCode: null,
                detail: null,
              },
            },
          }
        : result;
    },
  });
  expect(workCode(await uncertain.execute(JSON.stringify(request)))).toBe("recovery-required");
  const retried = workValue(await f.send(request));
  expect(retried.receipt?.revision).toBe(2);
  const count = f.store.read("SELECT COUNT(*) AS count FROM work_items");
  expect(count.ok && count.value[0]?.count).toBe(1);
  await f.store.close();
});
