/**
 * The whole path through the public surface: resolve, prepare, register,
 * measure, reconcile, plan, confirm, execute.
 */

import { describe, expect, test } from "bun:test";

import { DIAGNOSTICS_OWNERSHIP } from "../application/index.ts";
import { CONFIGURATION_OWNERSHIP } from "../config/index.ts";
import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import { createLocalDataService, type LocalDataServiceOptions } from "./local-data-service.ts";
import { CREDENTIAL_REFERENCE_OWNERSHIP, TEMPORARY_INGEST_OWNERSHIP } from "./ownership.ts";

const OVERRIDES = {
  FALRYN_CONFIG_DIR: "/d/config",
  FALRYN_STATE_DIR: "/d/state",
  FALRYN_CACHE_DIR: "/d/cache",
  FALRYN_LOG_DIR: "/d/logs",
  FALRYN_TEMP_DIR: "/d/tmp",
  FALRYN_ARTIFACT_DIR: "/d/artifacts",
  FALRYN_EXPORT_DIR: "/d/exports",
};

function serviceFor(nodes: Readonly<Record<string, InMemoryNode>> = {}) {
  const fileSystem = createInMemoryFileSystem({ nodes: { "/d": { kind: "directory" }, ...nodes } });
  const options: LocalDataServiceOptions = {
    fileSystem,
    environment: createStaticEnvironment(OVERRIDES),
    platform: "darwin",
    home: localPath("/Users/example"),
  };
  return { service: createLocalDataService(options), fileSystem };
}

function registerV01(service: ReturnType<typeof serviceFor>["service"]): void {
  for (const registration of [
    CONFIGURATION_OWNERSHIP,
    CREDENTIAL_REFERENCE_OWNERSHIP,
    DIAGNOSTICS_OWNERSHIP,
    TEMPORARY_INGEST_OWNERSHIP,
  ]) {
    service.register(registration);
  }
}

describe("a first run", () => {
  test("creates only the roots it was asked for and reports them", async () => {
    const { service, fileSystem } = serviceFor();

    const statuses = await service.prepareRoots(["configuration", "logs"]);

    expect(statuses.map((status) => status.code)).toEqual(["created", "created"]);
    expect(fileSystem.paths()).toContain(localPath("/d/config"));
    expect(fileSystem.paths()).toContain(localPath("/d/logs"));
    expect(fileSystem.paths()).not.toContain(localPath("/d/artifacts"));
  });

  test("reports which overrides could not be used", () => {
    const fileSystem = createInMemoryFileSystem();
    const service = createLocalDataService({
      fileSystem,
      environment: createStaticEnvironment({ FALRYN_LOG_DIR: "not-absolute" }),
      platform: "darwin",
      home: localPath("/Users/example"),
    });

    expect(service.resolutionIssues).toHaveLength(1);
    expect(service.resolutionIssues[0]).toMatchObject({
      root: "logs",
      variable: "FALRYN_LOG_DIR",
    });
  });

  test("finds nothing to reconcile in temporary ingest", async () => {
    const { service } = serviceFor();
    await service.prepareRoots(["temporaryIngest"]);

    const report = await service.reconcileTemporaryIngest();
    expect(report.effect).toBe("none");
  });
});

describe("a run that was interrupted", () => {
  test("records uncertainty about leftover ingest and removes nothing", async () => {
    const { service, fileSystem } = serviceFor({
      "/d/tmp": { kind: "directory" },
      "/d/tmp/ingest.part": { kind: "file", byteLength: 128 },
    });

    const report = await service.reconcileTemporaryIngest();

    expect(report.effect).toBe("uncertain");
    expect(report.entries).toHaveLength(1);
    expect(fileSystem.paths()).toContain(localPath("/d/tmp/ingest.part"));
  });
});

describe("registration and measurement", () => {
  test("measures only classes an owner registered", async () => {
    const { service } = serviceFor({
      "/d/logs": { kind: "directory" },
      "/d/logs/run.log": { kind: "file", byteLength: 250 },
      "/d/artifacts": { kind: "directory" },
      "/d/artifacts/blob.bin": { kind: "file", byteLength: 9_000 },
    });
    registerV01(service);

    const report = await service.reportRetention();

    expect(report.classes.map((usage) => usage.ownershipClass).sort()).toEqual([
      "configuration",
      "credentials",
      "logs",
      "temporaryIngest",
    ]);
    // The artifact bytes are on disk but no owner claimed them, so they are not
    // counted and the gap is named instead.
    expect(report.totalBytes).toBe(250);
    expect(report.unregistered).toContain("artifacts");
  });

  test("refuses a second owner for a class already registered", () => {
    const { service } = serviceFor();
    registerV01(service);

    const second = service.register({ ...DIAGNOSTICS_OWNERSHIP, owner: "impostor" });
    expect(second.ok).toBe(false);
    expect(service.registrations()).toHaveLength(4);
  });
});

describe("reset through the public surface", () => {
  test("plans, confirms, and removes exactly the selected class", async () => {
    const { service, fileSystem } = serviceFor({
      "/d/config": { kind: "directory" },
      "/d/config/settings.jsonc": { kind: "file", byteLength: 100 },
      "/d/logs": { kind: "directory" },
      "/d/logs/run.log": { kind: "file", byteLength: 250 },
    });
    registerV01(service);

    const plan = await service.planReset({ classes: ["logs"] });
    expect(plan.totalItems).toBe(1);

    const outcome = await service.executeRemoval(plan, { planId: plan.planId });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.effect).toBe("completed");
    }
    expect(fileSystem.paths()).not.toContain(localPath("/d/logs/run.log"));
    expect(fileSystem.paths()).toContain(localPath("/d/config/settings.jsonc"));
  });

  test("an unconfirmed plan removes nothing", async () => {
    const { service, fileSystem } = serviceFor({
      "/d/logs": { kind: "directory" },
      "/d/logs/run.log": { kind: "file", byteLength: 250 },
    });
    registerV01(service);

    const plan = await service.planReset({ classes: ["logs"] });
    const outcome = await service.executeRemoval(plan, {
      planId: "plan-reset-00000000-0" as typeof plan.planId,
    });

    expect(outcome.ok).toBe(false);
    expect(fileSystem.paths()).toContain(localPath("/d/logs/run.log"));
  });

  test("a reset can be re-run after a first run recreated its roots", async () => {
    const { service, fileSystem } = serviceFor({
      "/d/logs": { kind: "directory" },
      "/d/logs/run.log": { kind: "file", byteLength: 250 },
    });
    registerV01(service);

    const plan = await service.planReset({ classes: ["logs"] });
    await service.executeRemoval(plan, { planId: plan.planId });
    await service.prepareRoots(["logs"]);

    expect(fileSystem.paths()).toContain(localPath("/d/logs"));
    expect(fileSystem.paths()).not.toContain(localPath("/d/logs/run.log"));
  });
});
