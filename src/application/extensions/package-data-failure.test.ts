import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { packageValueSchema } from "../../domain/extensions/package-data.ts";
import { type SqliteStorePort, SqliteWorkError } from "../../domain/storage/index.ts";
import { packageDataFixture } from "./package-data.fixtures.ts";

afterEach(removeTemporaryRoots);
test("a failure after state and receipt SQL rolls the entire publication back; a safe retry commits once", async () => {
  const fixture = await packageDataFixture();
  try {
    const interrupted: SqliteStorePort = {
      ...fixture.store,
      write: (work, signal) =>
        fixture.store.write((sql) => {
          work(sql);
          throw new SqliteWorkError({
            kind: "sqlite",
            code: "disk-full",
            operation: "run",
            driverCode: "SQLITE_FULL",
            detail: "injected after staged writes",
          });
        }, signal),
    };
    const broken = fixture.service(createPackageDataRepository(interrupted));
    const request = {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 1,
      state: {
        version: 1,
        operation: "put",
        identity: fixture.identity,
        expectedRevision: 0,
        value: { color: "blue" },
      },
    };
    const preview = broken.run(request);
    if (preview.status !== "preview") throw new Error("preview failed");
    expect(broken.run({ ...request, confirmation: preview.confirmation })).toMatchObject({
      status: "failed",
      code: "disk-full",
    });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 1, records: [] },
    });
    expect(fixture.data.receipt(request.operationId)).toEqual({ ok: true, value: null });
    expect(fixture.service().run({ ...request, confirmation: preview.confirmation })).toMatchObject(
      { status: "completed", receipt: { afterRevision: 2 } },
    );
    expect(fixture.service().run(request)).toMatchObject({
      status: "completed",
      receipt: { afterRevision: 2 },
    });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      fixture
        .service()
        .run({ ...request, operationId: randomUUID(), expectedRevision: 2 }, cancelled.signal),
    ).toMatchObject({ status: "failed", code: "cancelled" });
    fixture.store.write((sql) =>
      sql.run(
        "UPDATE package_data SET metadata=json_set(metadata,'$.records[0].value.color','tampered') WHERE package_id='fixture'",
      ),
    );
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: false,
      error: { code: "corrupt-package-state" },
    });
  } finally {
    await fixture.store.close();
  }
});

test("bounded schemas reject unsupported vocabulary, cycles, and excess depth before recursive validation", () => {
  expect(packageValueSchema.safeParse({ type: "string", items: { type: "string" } }).success).toBe(
    false,
  );
  expect(
    packageValueSchema.safeParse({
      type: "object",
      additionalProperties: false,
      properties: {},
      required: ["absent"],
    }).success,
  ).toBe(false);
  let nested: unknown = { type: "string" };
  for (let i = 0; i < 10; i++) nested = { type: "array", items: nested };
  expect(packageValueSchema.safeParse(nested).success).toBe(false);
  const cyclic: { type: string; items?: unknown } = { type: "array" };
  cyclic.items = cyclic;
  expect(packageValueSchema.safeParse(cyclic).success).toBe(false);
});

test("a corrupted recovery document cannot be restored even when it remains valid JSON", async () => {
  const fixture = await packageDataFixture();
  try {
    const request = {
      version: 1,
      operation: "configuration",
      operationId: randomUUID(),
      expectedRevision: 1,
      layer: {
        scope: "user",
        owner: "test-user",
        revision: 0,
        values: { "display.label": "saved" },
      },
    };
    const run = fixture.service().run;
    const preview = run(request);
    if (preview.status !== "preview") throw new Error("preview failed");
    expect(run({ ...request, confirmation: preview.confirmation })).toMatchObject({
      status: "completed",
    });
    fixture.store.write((sql) =>
      sql.run(
        "UPDATE package_data_operations SET recovery=json_set(recovery,'$.declarations.configuration[0].default','corrupted') WHERE operation_id=$id",
        { id: request.operationId },
      ),
    );
    expect(fixture.data.recovery(request.operationId)).toMatchObject({
      ok: false,
      error: { code: "corrupt-package-recovery" },
    });
    expect(
      run({
        version: 1,
        operation: "rollback",
        operationId: randomUUID(),
        expectedRevision: 2,
        receiptId: request.operationId,
      }),
    ).toMatchObject({ status: "failed", code: "recovery-unavailable" });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 2, layers: [{ values: { "display.label": "saved" } }] },
    });
  } finally {
    await fixture.store.close();
  }
});
