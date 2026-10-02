import { join } from "node:path";
import { z } from "zod";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { createCuratedCatalogs } from "../../application/extensions/curated-catalogs.ts";
import { acquireListedPackage } from "../../application/extensions/package-acquisition.ts";
import type { PackageDownload } from "../../application/extensions/package-download-port.ts";
import { createPackageLifecycle } from "../../application/extensions/package-lifecycle.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createCatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { createCuratedCatalogRepository } from "../../data/extensions/curated-catalog-repository.ts";
import { createNativeActivationRepository } from "../../data/extensions/native-activation-repository.ts";
import { createPackageDataImportRepository } from "../../data/extensions/package-data-import-repository.ts";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import { createRecordRepositories } from "../../data/sessions/repositories.ts";
import type { CuratedCatalogStore } from "../../domain/extensions/curated-catalog.ts";
import type {
  PackageAction,
  PackageLifecycleStore,
  PackageReceipt,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import type { MarketplaceSource } from "../../domain/extensions/marketplace.ts";
import { PACKAGE_DOWNLOAD_LIMITS } from "../../domain/extensions/package-acquisition.ts";
import { packageHealthResultSchema } from "../../domain/extensions/package-health.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { createHostPackageDownload } from "../../integrations/extensions/host-package-download.ts";
import { createHostPackageSource } from "../../integrations/extensions/host-package-inspection.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandResultOf } from "../output/result.ts";
import { marketplaceSources } from "../runtime/marketplace-configuration.ts";
import { composeNativePackages } from "../runtime/native-packages.ts";
import { validatePackageConfigurationCandidate } from "../runtime/package-configuration-candidate.ts";
import { inspectPackageConfiguration } from "../runtime/package-configuration-inspection.ts";
import { runPackageDataControl, runPackageDataImport } from "../runtime/package-data.ts";
import { runPackageEvaluation } from "../runtime/package-evaluation.ts";
import { runPackageHealth } from "../runtime/package-health.ts";
import {
  absentPackageStanding,
  composePackageStanding,
  type PackageStandingAction,
  runPackageStanding,
} from "../runtime/package-standing.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import { composeHostProductCredentials } from "../runtime/product-credentials.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export type PackageArguments = { readonly action: PackageAction; readonly request: PackageRequest };
/** Configuration defaults when a caller supplies no global options. */
const DEFAULT_PACKAGE_GLOBALS: GlobalOptions = {
  format: "human",
  color: "never",
  quiet: false,
  verbose: false,
  nonInteractive: true,
  profile: null,
  timeoutMs: null,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};
const HOLD_ACTIONS: ReadonlySet<PackageAction> = new Set(["quarantine", "release", "revoke"]);
const PACKAGE_STANDING_ACTIONS: ReadonlySet<PackageAction> = new Set(["standing", ...HOLD_ACTIONS]);
const absent: PackageLifecycleStore = {
  data: () => ok(null),
  current: (packageId) => ok({ packageId, revision: 0, current: null }),
  version: () => ok(null),
  versions: () => ok([]),
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
  globals?: GlobalOptions,
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
    if (request.nativeActivation && action !== "enable")
      receipt = failure("invalid-native-activation-action");
    else if (request.nativeRecovery && action !== "recover")
      receipt = failure("invalid-native-recovery-action");
    else if (action === "health") receipt = await execute(signal);
    else {
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
    }
  } catch {
    receipt = failure("package-store-unavailable");
  } finally {
    task.close();
  }
  const healthResult =
    action === "health" ? packageHealthResultSchema.safeParse(receipt.data) : null;
  const observed =
    receipt.status === "uncertain"
      ? "uncertain"
      : receipt.status === "partial"
        ? "partial"
        : receipt.dataEffect === "completed" ||
            // A hold changes the trust owner's record, not the lifecycle revision.
            (HOLD_ACTIONS.has(action) && receipt.status === "completed") ||
            receipt.revision > receipt.priorRevision ||
            (healthResult?.success && healthResult.data.pid !== null)
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
      action !== "health" &&
      action !== "standing" &&
      !PACKAGE_STANDING_ACTIONS.has(action) &&
      action !== "enable" &&
      action !== "evaluate"
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
      const standing =
        opened.kind === "absent" ? null : composePackageStanding(resolved, stateRoot, opened.store);
      const lifecycle = createPackageLifecycle(
        opened.kind === "absent" ? absent : createPackageLifecycleRepository(opened.store),
        createHostPackageCache(join(stateRoot, "packages")),
        { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
        (document, signal) => validatePackageConfigurationCandidate(resolved, document, signal),
        standing === null ? undefined : (version) => standing.summarize(version),
      );
      if (
        (action === "enable" && request.nativeActivation) ||
        (action === "recover" && request.nativeRecovery)
      ) {
        await resolved.loader.load({
          configurationRoot: resolved.configurationRoot,
          legacyConfigurationRoot: resolved.legacyConfigurationRoot,
          workspaceRoot: null,
          profile: null,
          overrides: {},
        });
        const native =
          opened.kind === "open"
            ? composeNativePackages({
                services: resolved,
                records: createCatalogRepositories(opened.store),
                activations: createNativeActivationRepository(opened.store),
                processes: createPackageHealthRepository(opened.store),
              })
            : null;
        result =
          native === null
            ? failure("package-store-absent")
            : await (action === "enable" ? native.activate : native.recover)(
                request,
                operationSignal,
              );
      } else if (action === "evaluate") {
        result = await runPackageEvaluation(
          resolved,
          stateRoot,
          opened.kind === "open" ? opened.store : null,
          request,
          failure("not-started"),
          operationSignal,
        );
      } else if (PACKAGE_STANDING_ACTIONS.has(action)) {
        result =
          standing === null
            ? action === "standing"
              ? absentPackageStanding(request, failure("not-started"))
              : failure("not-installed")
            : await runPackageStanding(
                standing,
                action as PackageStandingAction,
                request,
                failure("not-started"),
                operationSignal,
              );
      } else if (action === "health") {
        result =
          opened.kind === "open"
            ? await runPackageHealth(
                resolved,
                {
                  catalog: createCatalogRepositories(opened.store),
                  health: createPackageHealthRepository(opened.store),
                },
                task,
                request,
                operationSignal,
              )
            : failure("package-store-absent");
      } else if (action === "data") {
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
        result =
          request.listing === undefined
            ? await lifecycle.run(
                action,
                request,
                operationSignal,
                request.sourcePath === undefined
                  ? undefined
                  : createHostPackageSource(request.sourcePath),
              )
            : await runListedPackage(
                lifecycle,
                opened.kind === "open" ? createCuratedCatalogRepository(opened.store) : null,
                operationSignal,
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

  /**
   * Install or update the exact version a marketplace listing names (#1210). The listing
   * is gated like inspection, its archive downloaded under product resource admission,
   * and the lifecycle refuses any prepared identity but the listed one.
   */
  async function runListedPackage(
    lifecycle: ReturnType<typeof createPackageLifecycle>,
    listings: CuratedCatalogStore | null,
    operationSignal: AbortSignal,
  ): Promise<PackageReceipt> {
    const listing = request.listing;
    if (listing === undefined) return failure("package-source-required");
    if (action !== "install" && action !== "update") return failure("unexpected-package-listing");
    if (listings === null) return failure("listing-not-found");
    const resolved = services();
    let sources: readonly MarketplaceSource[] | null = null;
    try {
      const loaded = await loadProductConfiguration(
        resolved,
        productConfigurationLoadRequest(globals ?? DEFAULT_PACKAGE_GLOBALS),
        operationSignal,
      );
      if (loaded.outcome.kind === "published" || loaded.outcome.kind === "unchanged")
        sources = marketplaceSources(loaded.values, resolved.loader.current());
    } catch {
      sources = null;
    }
    const catalogs = createCuratedCatalogs({
      store: listings,
      now: () => Number(resolved.clock.now()),
      host: { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
      marketplaces: () => sources,
    });
    const http = createHostPackageDownload({
      credentials: composeHostProductCredentials({
        clock: resolved.clock,
        environment: resolved.environment,
      }).resolver,
      ...(resolved.egress === undefined ? {} : { egress: resolved.egress }),
    });
    const downloads = processProductResources.openTask("package-download-v1");
    try {
      const acquired = await acquireListedPackage(
        {
          catalogs,
          marketplaces: () => sources,
          download: {
            async download(input, downloadSignal) {
              const identity = crypto.randomUUID();
              const admitted = await downloads.execute<PackageDownload>({
                operation: identity,
                attempt: identity,
                generation: downloads.generation,
                inputBytes: input.url.length,
                amounts: {
                  operations: 1,
                  requests: PACKAGE_DOWNLOAD_LIMITS.redirects + 1,
                  bufferedBytes: PACKAGE_DOWNLOAD_LIMITS.compressedBytes,
                },
                signal: downloadSignal,
                unit: {
                  id: workUnitId(identity),
                  effect: "external",
                  priority: "interactive",
                  conflictKeys: [],
                  dependencies: [],
                  deadline: null,
                  expectedOutputBytes: PACKAGE_DOWNLOAD_LIMITS.compressedBytes,
                  retry: NO_RETRY,
                  scopeId: null,
                },
                async run(admittedSignal) {
                  const value = await http.download(input, admittedSignal);
                  // A GET changes nothing remotely; staging happens after admission ends.
                  return { value, terminated: true, observedEffect: "none" };
                },
              });
              if (admitted.kind === "completed") return admitted.value;
              return {
                kind: "failed",
                code: downloadSignal.aborted
                  ? "package-download-cancelled"
                  : "package-download-admission-denied",
              };
            },
          },
        },
        listing,
        operationSignal,
      );
      if (!acquired.ok) return failure(acquired.code);
      const receipt = await lifecycle.run(
        action,
        request,
        operationSignal,
        acquired.source,
        acquired.expectedIdentityDigest,
      );
      return { ...receipt, acquisition: acquired.facts };
    } finally {
      downloads.close();
    }
  }
}
