import { join } from "node:path";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { createPackageLifecycle } from "../../application/extensions/package-lifecycle.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
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
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export type PackageArguments = { readonly action: PackageAction; readonly request: PackageRequest };
const absent: PackageLifecycleStore = {
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
        : receipt.revision > receipt.priorRevision
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
      );
      result = await lifecycle.run(
        action,
        request,
        operationSignal,
        request.sourcePath === undefined ? undefined : createHostPackageSource(request.sourcePath),
      );
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
