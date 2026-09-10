import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPackageDataImportRepository } from "../../data/extensions/package-data-import-repository.ts";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { resolveInventory, writePackage } from "../../data/lifecycle/export.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { createRecordRepositories } from "../../data/sessions/repositories.ts";
import { importPackage, replaySession } from "../../data/sessions/session-replay.ts";
import { createInMemoryBlobStore } from "../../domain/artifacts/index.ts";
import { createInMemoryPackageWriter } from "../../domain/extensions/index.ts";
import type { PackageDataBundle } from "../../domain/extensions/package-data-transfer.ts";
import { sessionRecord } from "../../domain/fixtures.ts";
import { createManualClock, err, ok, runId, sessionId } from "../../domain/foundation/index.ts";
import { exportName } from "../../domain/sessions/index.ts";
import { createSha256Hasher } from "../../integrations/index.ts";
import { createRuntimeRedactor } from "../diagnostics/redaction.ts";
import { packageDataFixture } from "./package-data.fixtures.ts";
import { importPackageData } from "./package-data-transfer.ts";

afterEach(removeTemporaryRoots);
test("native archive import and replay preserve inert package state with no installed package", async () => {
  const source = await packageDataFixture();
  const destination = await openProductStoreOrThrow(
    await temporaryRoot("falryn-inert-destination-"),
  );
  try {
    const session = sessionRecord({ sessionId: sessionId.from("session-history") });
    const repositories = createRecordRepositories(source.store);
    expect(repositories.sessions.insert(session).ok).toBe(true);
    const run = source.service().run;
    const request = {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 1,
      state: {
        version: 1,
        operation: "put",
        identity: { ...source.identity, scope: "session", owner: session.sessionId },
        expectedRevision: 0,
        value: { color: "historical" },
      },
    };
    const preview = run(request);
    if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
    expect(run({ ...request, confirmation: preview.confirmation })).toMatchObject({
      status: "completed",
    });
    const exported = run({
      version: 1,
      operation: "export",
      operationId: randomUUID(),
      exportId: randomUUID(),
      expectedRevision: 2,
    });
    if (exported.status !== "inspected") throw new Error("export failed");
    const bundle = exported.payload as PackageDataBundle;
    const packages = createInMemoryPackageWriter();
    const common = {
      packages,
      clock: createManualClock(),
      hasher: createSha256Hasher(),
      buildIdentity: "test",
      redactor: createRuntimeRedactor(),
      blobs: createInMemoryBlobStore(),
    };
    const options = {
      ...common,
      store: source.store,
      repositories,
      events: createSqliteEventStore(source.store),
      packageData: [bundle],
    };
    const selection = {
      kind: "sessions" as const,
      sessionIds: [session.sessionId],
      includeSensitive: false,
    };
    const inventory = await resolveInventory(options, selection);
    if (!inventory.ok) throw new Error(JSON.stringify(inventory));
    const name = exportName.from("inert-package-history");
    expect((await writePackage(options, name, selection, inventory.value)).ok).toBe(true);
    destination.write((sql) =>
      sql.run(
        "INSERT INTO runs(run_id,started_at,ended_at,schema_version) VALUES('inert-import','2026-07-31T12:00:00.000Z',NULL,4)",
      ),
    );
    const imports = createPackageDataImportRepository(destination);
    const target = {
      ...common,
      store: destination,
      repositories: createRecordRepositories(destination),
      events: createSqliteEventStore(destination),
      runId: runId.from("inert-import"),
      importPackageData: (bundles: readonly PackageDataBundle[]) => {
        const ids: string[] = [];
        for (const data of bundles) {
          const input = {
            store: imports,
            owner: "test-user",
            packageId: data.packageId,
            operationId: data.exportId,
            raw: data,
          };
          const preview = importPackageData(input);
          if (preview.status !== "preview")
            return err({ kind: "import" as const, code: "cancelled" as const });
          const imported = importPackageData({ ...input, confirmation: preview.confirmation });
          if (imported.status !== "imported")
            return err({ kind: "import" as const, code: "cancelled" as const });
          ids.push(imported.receipt.importId);
        }
        return ok(ids);
      },
    };
    expect((await importPackage(target, name)).ok).toBe(true);
    expect(createPackageLifecycleRepository(destination).current("fixture")).toMatchObject({
      ok: true,
      value: { current: null },
    });
    expect(createPackageDataRepository(destination).read("fixture")).toEqual({
      ok: true,
      value: null,
    });
    const replay = await replaySession(target, session.sessionId);
    expect(replay).toMatchObject({
      ok: true,
      value: {
        packageData: [
          {
            packageId: "fixture",
            records: [{ identity: { scope: "session", owner: session.sessionId }, revision: 1 }],
          },
        ],
      },
    });
    expect(JSON.stringify(replay)).not.toContain("historical");
    expect(createPackageDataRepository(destination).read("fixture")).toEqual({
      ok: true,
      value: null,
    });
  } finally {
    await source.store.close();
    await destination.close();
  }
});
