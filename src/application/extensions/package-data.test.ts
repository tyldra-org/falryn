import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { composePackageConfiguration } from "../../config/resolution/package-configuration.ts";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../../data/fixtures.ts";
import type { PackageDataRequest } from "../../domain/extensions/package-data-control.ts";
import { createRuntimeRedactor } from "../diagnostics/redaction.ts";
import { dataManifest, packageDataFixture, setting, stateFamily } from "./package-data.fixtures.ts";
import type { PackageDataResult } from "./package-data.ts";
import { packageSource } from "./package-fixtures.ts";

afterEach(removeTemporaryRoots);
function confirm(run: (request: unknown) => PackageDataResult, request: unknown) {
  const preview = run(request);
  expect(preview.status).toBe("preview");
  if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
  return run({ ...(request as object), confirmation: preview.confirmation });
}
test("configuration preview, confirmed write, restart, CAS and isolated state use the real SQLite owner", async () => {
  const fixture = await packageDataFixture();
  try {
    const service = fixture.service();
    const configuration: PackageDataRequest = {
      version: 1,
      operation: "configuration",
      operationId: randomUUID(),
      expectedRevision: 1,
      layer: {
        scope: "user",
        owner: "test-user",
        revision: 0,
        values: { "display.label": "configured" },
      },
    };
    expect(confirm(service.run, configuration)).toMatchObject({
      status: "completed",
      receipt: { afterRevision: 2 },
    });
    const put: PackageDataRequest = {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 2,
      state: {
        version: 1,
        operation: "put",
        identity: fixture.identity,
        expectedRevision: 0,
        value: { color: "blue" },
      },
    };
    expect(confirm(service.run, put)).toMatchObject({
      status: "completed",
      receipt: { afterRevision: 3 },
    });
    expect(service.run(put)).toMatchObject({ status: "completed" });
    expect(service.run({ ...put, operationId: randomUUID() })).toMatchObject({
      status: "failed",
      code: "stale-data-revision",
    });
    expect(
      service.run({
        ...put,
        operationId: randomUUID(),
        expectedRevision: 3,
        state: { ...put.state, identity: { ...fixture.identity, packageId: "other" } },
      }),
    ).toMatchObject({ status: "failed", code: "state-scope-denied" });
    const reopened = await openProductStoreOrThrow(fixture.root);
    try {
      const restored = createPackageDataRepository(reopened).read("fixture");
      expect(restored).toMatchObject({
        ok: true,
        value: {
          revision: 3,
          layers: [{ values: { "display.label": "configured" } }],
          records: [{ value: { color: "blue" } }],
        },
      });
    } finally {
      await reopened.close();
    }
    fixture.revoke();
    expect(service.run({ ...put, operationId: randomUUID(), expectedRevision: 3 })).toEqual({
      status: "failed",
      code: "revoked-package-data",
    });
  } finally {
    await fixture.store.close();
  }
});

test("schema and secret rejection leaves both configuration and package publication unchanged", async () => {
  const f = await packageDataFixture();
  try {
    const run = f.service().run;
    const request = {
      version: 1,
      operation: "configuration",
      operationId: randomUUID(),
      expectedRevision: 1,
      layer: {
        scope: "user",
        owner: "test-user",
        revision: 0,
        values: { "display.label": "sk-live-secretvalue123456" },
      },
    };
    expect(run(request)).toMatchObject({ status: "failed", code: "invalid-package-configuration" });
    expect(f.data.read("fixture")).toMatchObject({ ok: true, value: { revision: 1, layers: [] } });
    const bad = { ...stateFamily, schemaVersion: 2 };
    expect(
      confirm(run, {
        version: 1,
        operation: "state",
        operationId: randomUUID(),
        expectedRevision: 1,
        state: {
          version: 1,
          operation: "put",
          identity: f.identity,
          expectedRevision: 0,
          value: { color: "red" },
        },
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await f.lifecycle.run(
        "update",
        f.request(1),
        new AbortController().signal,
        packageSource(dataManifest("2.0.0", bad)),
      ),
    ).toMatchObject({ status: "failed", code: "state-migration-unavailable" });
    expect(f.packages.current("fixture")).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(f.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 2, records: [{ value: { color: "red" }, schemaVersion: 1 }] },
    });
  } finally {
    await f.store.close();
  }
});

test("forward migration commits with package bytes; incompatible rollback retains current state", async () => {
  const f = await packageDataFixture();
  try {
    const old = f.packages.current("fixture");
    if (!old.ok || !old.value.current) throw new Error("missing");
    confirm(f.service().run, {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 1,
      state: {
        version: 1,
        operation: "put",
        identity: f.identity,
        expectedRevision: 0,
        value: { color: "red" },
      },
    });
    const migrated = {
      ...stateFamily,
      schemaVersion: 2,
      schema: {
        type: "object" as const,
        properties: { theme: { type: "string" as const } },
        required: ["theme"],
        additionalProperties: false as const,
      },
      migrations: [
        {
          version: 1 as const,
          from: 1,
          to: 2,
          steps: [{ kind: "rename" as const, from: "color", to: "theme" }],
        },
      ],
    };
    expect(await f.apply("update", f.request(1), dataManifest("2.0.0", migrated))).toMatchObject({
      status: "completed",
      revision: 2,
    });
    expect(f.data.read("fixture")).toMatchObject({
      ok: true,
      value: { records: [{ schemaVersion: 2, value: { theme: "red" } }] },
    });
    expect(
      await f.lifecycle.run(
        "rollback",
        f.request(2, { versionDigest: old.value.current.identityDigest }),
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "failed", code: "state-migration-unavailable" });
    expect(f.packages.current("fixture")).toMatchObject({ ok: true, value: { revision: 2 } });
  } finally {
    await f.store.close();
  }
});

test("one configuration fold uses Falryn precedence, keeps overridden provenance and honors scope restrictions", () => {
  const layers = (["cli", "project", "user", "environment", "profile"] as const).map((scope) => ({
    scope,
    owner: "test-user",
    revision: 1,
    values: { "display.label": scope },
  }));
  const input = {
    packageId: "fixture",
    declarations: [setting],
    layers,
    allowedScopes: ["user", "project", "profile", "environment", "cli"] as const,
    redactor: createRuntimeRedactor(),
    validateSensitive: () => true,
  };
  const result = composePackageConfiguration(input);
  expect(result.values).toEqual({ "display.label": "cli" });
  expect(result.overridden.map((p) => p.source)).toEqual([
    "user-file",
    "project-file",
    "profile",
    "environment",
  ]);
  expect(() => composePackageConfiguration({ ...input, allowedScopes: ["user"] })).toThrow(
    "configuration-scope-denied",
  );
});

test("declared reverse migration restores compatible state; cancellation leaves the prior publication intact", async () => {
  const f = await packageDataFixture();
  try {
    const reversible = {
      ...stateFamily,
      migrations: [
        {
          version: 1 as const,
          from: 2,
          to: 1,
          steps: [{ kind: "rename" as const, from: "theme", to: "color" }],
        },
      ],
    };
    const first = await f.apply("update", f.request(1), dataManifest("1.1.0", reversible));
    expect(first.status).toBe("completed");
    confirm(f.service().run, {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 2,
      state: {
        version: 1,
        operation: "put",
        identity: f.identity,
        expectedRevision: 0,
        value: { color: "blue" },
      },
    });
    const next = dataManifest("2.0.0", {
      ...stateFamily,
      schemaVersion: 2,
      schema: {
        type: "object",
        properties: { theme: { type: "string" } },
        required: ["theme"],
        additionalProperties: false,
      },
      migrations: [
        { version: 1, from: 1, to: 2, steps: [{ kind: "rename", from: "color", to: "theme" }] },
      ],
    });
    const request = f.request(2);
    const preview = await f.lifecycle.run(
      "update",
      request,
      new AbortController().signal,
      packageSource(next),
    );
    if (preview.status !== "preview" || !preview.confirmation)
      throw new Error(JSON.stringify(preview));
    const cancel = new AbortController();
    cancel.abort();
    expect(
      await f.lifecycle.run(
        "update",
        { ...request, confirmation: preview.confirmation },
        cancel.signal,
        packageSource(next),
      ),
    ).toMatchObject({ status: "failed", code: "cancelled" });
    expect(f.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 3, records: [{ schemaVersion: 1, value: { color: "blue" } }] },
    });
    expect(
      await f.lifecycle.run(
        "update",
        { ...request, confirmation: preview.confirmation },
        new AbortController().signal,
        packageSource(next),
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      await f.apply("rollback", f.request(3, { versionDigest: first.currentDigest ?? undefined })),
    ).toMatchObject({ status: "completed", revision: 4 });
    expect(f.data.read("fixture")).toMatchObject({
      ok: true,
      value: { records: [{ schemaVersion: 1, value: { color: "blue" } }] },
    });
  } finally {
    await f.store.close();
  }
});
