import { afterEach, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { inspectHookHealth } from "../../domain/tools/hook-health.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createHookHealthRepository } from "./hook-health-repository.ts";

afterEach(removeTemporaryRoots);
test("consecutive failures survive reopen, stay quarantined after late success and isolate generations", async () => {
  const root = await temporaryRoot("hook-health-");
  const generation = canonicalDigest("activation-1");
  let db = await openProductStoreOrThrow(root);
  let health = createHookHealthRepository(db)("package/hook", generation);
  expect(health.settle("failure")).toMatchObject({ ok: true, value: { failures: 1 } });
  expect(health.settle("success")).toMatchObject({ ok: true, value: { failures: 0 } });
  for (let i = 0; i < 3; i++) expect(health.settle("failure").ok).toBe(true);
  expect(health.settle("success")).toMatchObject({ ok: true, value: { failures: 3 } });
  await db.close();
  db = await openProductStoreOrThrow(root);
  try {
    const owner = createHookHealthRepository(db);
    health = owner("package/hook", generation);
    expect(inspectHookHealth(health)).toMatchObject({ status: "quarantined", failures: 3 });
    const replacement = owner("package/hook", canonicalDigest("activation-2"));
    expect(inspectHookHealth(replacement).status).toBe("healthy");
    health.settle("uncertain");
    expect(inspectHookHealth(health).status).toBe("cleanup-uncertain");
    expect(inspectHookHealth(replacement).status).toBe("healthy");
    expect(inspectHookHealth(owner("other/hook", generation)).status).toBe("healthy");
  } finally {
    await db.close();
  }
  expect(inspectHookHealth(health).status).toBe("unavailable");
});
