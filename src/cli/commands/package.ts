import { join } from "node:path";
import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { createPackageLifecycle } from "../../application/extensions/package-lifecycle.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createPackageDataImportRepository } from "../../data/extensions/package-data-import-repository.ts";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { createRecordRepositories } from "../../data/sessions/repositories.ts";
import type {
  PackageAction,
  PackageLifecycleStore,
  PackageReceipt,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { createHostPackageSource } from "../../integrations/extensions/host-package-inspection.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { CommandResultOf } from "../output/result.ts";
import { validatePackageConfigurationCandidate } from "../runtime/package-configuration-candidate.ts";
import { inspectPackageConfiguration } from "../runtime/package-configuration-inspection.ts";
import { runPackageDataControl, runPackageDataImport } from "../runtime/package-data.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export type PackageArguments = { readonly action: PackageAction; readonly request: PackageRequest };
const absent: PackageLifecycleStore = {
  data: () => ok(null),
  current: (packageId) => ok({ packageId, revision: 0, current: null }),
  version: () => ok(null),
  operation: () => ok(null),
  counts: () => ok({ retained: 0, pending: 0, epoch: 0 }),
  stage: () => err({ code: "store-absent" }),
  publish: () => err({ code: "store-absent" }),
  cleanup: () => err({ code: "store-absent" }),
  removed: () => err({ code: "store-absent" }),
};

export async function runPackage(
  services: ServiceProvider,
  args: PackageArguments,
  signal = new AbortController().signal,
): Promise<CommandResultOf<"package", PackageReceipt>> {
  const { action, request } = args;
  const failure = (code: string): PackageReceipt => ({
    action,
    operationId: request.operationId,
    packageId: request.packageId,
    status: "failed",
    code,
    priorRevision: request.expectedRevision,
    revision: request.expectedRevision,
    priorDigest: null,
    currentDigest: null,
    activation: "unavailable",
    confirmation: null,
    retainedVersions: 0,
    pendingCleanup: 0,
    recovery: "inspect",
  });
  const task = processProductResources.openTask("package-lifecycle-v1");
  let receipt: PackageReceipt;
  try {
    const execution = await task.execute({
      operation: request.operationId,
      attempt: "1",
      generation: task.generation,
      inputBytes: JSON.stringify(request).length,
      amounts: { operations: 1, concurrency: 1, memoryBytes: 201_326_592 },
      signal,
      unit: {
        id: workUnitId(request.operationId),
        effect: request.confirmation === undefined ? "observation" : "mutation",
        priority: "interactive",
        conflictKeys: [conflictKey("package", request.packageId)],
        dependencies: [],
        deadline: null,
        expectedOutputBytes: 16_384,
        retry: NO_RETRY,
        scopeId: null,
      },
      async run(admittedSignal) {
        return { value: await execute(admittedSignal), terminated: true };
      },
    });
    receipt = execution.kind === "completed" ? execution.value : failure(execution.receipt.state);
  } catch {
    receipt = failure("package-store-unavailable");
  } finally {
    task.close();
  }
  const observed =
    receipt.status === "uncertain"
      ? "uncertain"
      : receipt.status === "partial"
        ? "partial"
        : receipt.dataEffect === "completed" || receipt.revision > receipt.priorRevision
          ? "completed"
          : "none";
  const errors =
    receipt.status === "failed" || receipt.status === "partial" || receipt.status === "uncertain"
      ? [
          adoptForeignError(
            {
              code: receipt.code,
              category: "configuration",
              message:
                "Package operation needs attention. Inspect the lifecycle receipt before retrying.",
            },
            { operation: "package lifecycle" },
          ),
        ]
      : [];
  return resultFor(
    "package",
    receipt,
    errors.map((error) => ({ ...error, effect: observed, recovery: recoveryForEffect(observed) })),
    receipt.status === "uncertain"
      ? { kind: "uncertain", effect: "uncertain" }
      : errors.length > 0
        ? { kind: "failed", effect: observed }
        : undefined,
    { intent: request.confirmation === undefined ? "none" : "mutate", observed },
  );

  async function execute(operationSignal: AbortSignal): Promise<PackageReceipt> {
    const resolved = services();
    const stateRoot = rootChild(resolved.localData.layout, "state");
    if (stateRoot === null) return failure("package-root-unavailable");
    const databasePath = sqliteDatabasePath(stateRoot);
    if (databasePath === null) return failure("package-root-unavailable");
    let opened = await openSessionStore(services, operationSignal);
    if (!opened.ok) return failure("package-store-unavailable");
    if (
      opened.kind === "absent" &&
      request.confirmation !== undefined &&
      action !== "inspect" &&
      action !== "enable"
    ) {
      const roots = await resolved.localData.prepareRoots(["state"], operationSignal);
      if (!roots.every(isRootUsable)) return failure("package-root-unavailable");
      const created = await openSqliteStore(
        {
          open: openBunSqlite,
          clock: resolved.clock,
          databasePath,
          backupDirectory: stateRoot,
          migrations: PRODUCTION_MIGRATIONS,
          create: true,
        },
        operationSignal,
      );
      if (!created.ok) return failure("package-store-unavailable");
      opened = { ok: true, kind: "open", store: created.value };
    }
    let result: PackageReceipt;
    try {
      const lifecycle = createPackageLifecycle(
        opened.kind === "absent" ? absent : createPackageLifecycleRepository(opened.store),
        createHostPackageCache(join(stateRoot, "packages")),
        { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
        (document, signal) => validatePackageConfigurationCandidate(resolved, document, signal),
      );
      if (action === "data") {
        if (opened.kind !== "open") {
          const preview = runPackageDataImport(
            { read: () => ok(null), save: () => err({ code: "package-store-absent" }) },
            request,
            operationSignal,
          );
          result =
            preview.status === "preview"
              ? {
                  ...failure("package-data-preview"),
                  status: "preview",
                  confirmation: preview.confirmation,
                  data: z.json().parse(preview),
                }
              : failure(preview.status === "failed" ? preview.code : "package-data-unavailable");
        } else {
          const installed = createPackageLifecycleRepository(opened.store).current(
            request.packageId,
          );
          if (!installed.ok) throw new Error(installed.error.code);
          const data = await runPackageDataControl(
            resolved,
            {
              packages: createPackageLifecycleRepository(opened.store),
              data: createPackageDataRepository(opened.store),
              imports: createPackageDataImportRepository(opened.store),
              sessions: createRecordRepositories(opened.store).sessions,
            },
            request,
            operationSignal,
          );
          result = {
            ...failure(
              data.status === "failed" || data.status === "uncertain"
                ? data.code
                : `package-data-${data.status}`,
            ),
            status:
              data.status === "inspected" || data.status === "imported" ? "completed" : data.status,
            confirmation: data.status === "preview" ? data.confirmation : null,
            priorRevision: installed.value.revision,
            revision: installed.value.revision,
            priorDigest: installed.value.current?.identityDigest ?? null,
            currentDigest: installed.value.current?.identityDigest ?? null,
            dataEffect:
              data.status === "imported" ||
              (data.status === "completed" &&
                data.receipt.afterRevision > data.receipt.beforeRevision)
                ? "completed"
                : "none",
            recovery: data.status === "uncertain" ? "inspect" : "none",
            data: z.json().parse(JSON.parse(JSON.stringify(data))),
          };
        }
      } else
        result = await lifecycle.run(
          action,
          request,
          operationSignal,
          request.sourcePath === undefined
            ? undefined
            : createHostPackageSource(request.sourcePath),
        );
      if (action === "inspect" && result.status === "completed" && result.currentDigest !== null) {
        const effectiveConfiguration = await inspectPackageConfiguration(
          resolved,
          request.packageId,
          null,
          operationSignal,
        );
        result = {
          ...result,
          data: z.json().parse({
            ...(result.data !== null &&
            typeof result.data === "object" &&
            !Array.isArray(result.data)
              ? result.data
              : {}),
            effectiveConfiguration,
          }),
        };
      }
    } catch {
      result = failure("package-operation-failed");
    }
    if (opened.kind === "open" && !isCleanClose(await opened.store.close()))
      return {
        ...result,
        status: "uncertain",
        code: "package-store-close-failed",
        recovery: "inspect",
      };
    return result;
  }
}
