import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import type { PackageDataBundle } from "../../domain/extensions/package-data-transfer.ts";
import { packageDataFixture } from "./package-data.fixtures.ts";
import type { PackageDataResult } from "./package-data.ts";
import { importPackageData } from "./package-data-transfer.ts";

afterEach(removeTemporaryRoots);
function confirm(run: (request: unknown) => PackageDataResult, request: object) {
  const result = run(request);
  if (result.status !== "preview") throw new Error(JSON.stringify(result));
  return run({ ...request, confirmation: result.confirmation });
}
test("import is inert; adoption retains collisions, replaces only by revision, and reconciles committed retries", async () => {
  const fixture = await packageDataFixture();
  try {
    const run = fixture.service().run;
    const base = {
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
    expect(confirm(run, base)).toMatchObject({ status: "completed" });
    const exported = run({
      version: 1,
      operation: "export",
      operationId: randomUUID(),
      exportId: randomUUID(),
      expectedRevision: 2,
    });
    if (exported.status !== "inspected") throw new Error("export failed");
    const bundle = exported.payload as PackageDataBundle;
    const importId = randomUUID();
    const input = {
      store: fixture.imports,
      owner: "test-user",
      packageId: "fixture",
      operationId: importId,
      raw: bundle,
    };
    const preview = importPackageData(input);
    if (preview.status !== "preview") throw new Error("import preview failed");
    expect(importPackageData({ ...input, confirmation: preview.confirmation })).toMatchObject({
      status: "imported",
    });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 2, records: [{ value: { color: "blue" } }] },
    });
    expect(
      importPackageData({
        ...input,
        raw: {
          ...bundle,
          state: bundle.state.map((entry) => ({
            ...entry,
            record: { ...entry.record, value: { color: "tampered" } },
          })),
        },
      }),
    ).toMatchObject({ status: "failed", code: "invalid-inert-state" });
    const source = bundle.state[0]?.id;
    const adoption = {
      version: 1,
      operation: "adopt",
      operationId: randomUUID(),
      expectedRevision: 2,
      adoption: {
        kind: "state",
        importId,
        source,
        scope: "user",
        owner: "test-user",
        expectedRevision: 1,
        collision: "retain",
      },
    };
    expect(confirm(run, adoption)).toMatchObject({
      status: "completed",
      receipt: { status: "unchanged", afterRevision: 2, changes: [{ outcome: "unchanged" }] },
    });
    expect(
      confirm(run, {
        ...base,
        operationId: randomUUID(),
        expectedRevision: 2,
        state: { ...base.state, expectedRevision: 1, value: { color: "red" } },
      }),
    ).toMatchObject({ status: "completed" });
    const retained = {
      ...adoption,
      operationId: randomUUID(),
      expectedRevision: 3,
      adoption: { ...adoption.adoption, expectedRevision: 2 },
    };
    expect(confirm(run, retained)).toMatchObject({
      status: "completed",
      receipt: { status: "unchanged", afterRevision: 3, changes: [{ outcome: "retained" }] },
    });
    const replace = {
      ...retained,
      operationId: randomUUID(),
      adoption: { ...retained.adoption, collision: "replace" },
    };
    expect(confirm(run, replace)).toMatchObject({
      status: "completed",
      receipt: { afterRevision: 4 },
    });
    expect(run(replace)).toMatchObject({ status: "completed", receipt: { afterRevision: 4 } });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 4, records: [{ value: { color: "blue" }, revision: 3 }] },
    });
    expect(
      confirm(run, {
        version: 1,
        operation: "rollback",
        operationId: randomUUID(),
        expectedRevision: 4,
        receiptId: replace.operationId,
      }),
    ).toMatchObject({ status: "completed" });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { records: [{ value: { color: "red" } }] },
    });
    expect(
      run({
        version: 1,
        operation: "rollback",
        operationId: randomUUID(),
        expectedRevision: 5,
        receiptId: replace.operationId,
      }),
    ).toMatchObject({ status: "failed", code: "rollback-stale" });
  } finally {
    await fixture.store.close();
  }
});

for (const scope of ["user", "project", "profile"] as const) {
  test(`configuration adoption into ${scope} guards collisions, retries and rollback revisions`, async () => {
    const fixture = await packageDataFixture();
    try {
      const run = fixture.service().run;
      const current = () => {
        const result = fixture.data.read("fixture");
        if (!result.ok || !result.value) throw new Error("missing data");
        return result.value;
      };
      const set = (value: string) =>
        confirm(run, {
          version: 1,
          operation: "configuration",
          operationId: randomUUID(),
          expectedRevision: current().revision,
          layer: {
            scope,
            owner: "test-user",
            revision: current().layers.find((layer) => layer.scope === scope)?.revision ?? 0,
            values: { "display.label": value },
          },
        });
      expect(set("source")).toMatchObject({ status: "completed" });
      const exported = run({
        version: 1,
        operation: "export",
        operationId: randomUUID(),
        exportId: randomUUID(),
        expectedRevision: current().revision,
      });
      if (exported.status !== "inspected") throw new Error("export failed");
      const bundle = exported.payload as PackageDataBundle;
      const importId = randomUUID();
      const input = {
        store: fixture.imports,
        owner: "test-user",
        packageId: "fixture",
        operationId: importId,
        raw: bundle,
      };
      const preview = importPackageData(input);
      if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
      expect(importPackageData({ ...input, confirmation: preview.confirmation })).toMatchObject({
        status: "imported",
      });
      const adopt = (collision: "retain" | "replace" = "retain") => ({
        version: 1,
        operation: "adopt",
        operationId: randomUUID(),
        expectedRevision: current().revision,
        adoption: {
          kind: "configuration",
          importId,
          source: bundle.configuration[0]?.id,
          scope,
          owner: "test-user",
          expectedRevision: current().layers.find((layer) => layer.scope === scope)?.revision ?? 0,
          collision,
        },
      });
      expect(confirm(run, adopt())).toMatchObject({
        status: "completed",
        receipt: { status: "unchanged", changes: [{ outcome: "unchanged" }] },
      });
      expect(set("local")).toMatchObject({ status: "completed" });
      expect(confirm(run, adopt())).toMatchObject({
        status: "completed",
        receipt: { changes: [{ outcome: "retained" }] },
      });
      const replace = adopt("replace");
      const replaced = confirm(run, replace);
      expect(replaced).toMatchObject({
        status: "completed",
        receipt: { changes: [{ outcome: "replaced", application: "next-turn" }] },
      });
      const revision = current().revision;
      expect(run(replace)).toEqual(replaced);
      expect(current().revision).toBe(revision);
      expect(run({ ...replace, operationId: randomUUID() })).toMatchObject({
        status: "failed",
        code: "stale-data-revision",
      });
      const beforeRollback = current().layers[0]?.revision ?? 0;
      const rollback = {
        version: 1,
        operation: "rollback",
        operationId: randomUUID(),
        expectedRevision: revision,
        receiptId: replace.operationId,
      };
      expect(confirm(run, rollback)).toMatchObject({ status: "completed" });
      expect(current().layers[0]).toMatchObject({
        revision: beforeRollback + 1,
        values: { "display.label": "local" },
      });
      expect(set("later")).toMatchObject({ status: "completed" });
      expect(
        run({ ...rollback, operationId: randomUUID(), expectedRevision: current().revision }),
      ).toMatchObject({ status: "failed", code: "rollback-stale" });
    } finally {
      await fixture.store.close();
    }
  });
}
