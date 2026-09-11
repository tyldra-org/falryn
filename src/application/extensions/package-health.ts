import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type {
  InstalledPackage,
  PackageBytes,
  PackageLifecycleStore,
  PackageReceipt,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import type { ContributionDeclaration } from "../../domain/extensions/manifest.ts";
import {
  initialHealthResult,
  PACKAGE_HEALTH_LIMITS,
  PACKAGE_HEALTH_PROTOCOL,
  type PackageHealthRecord,
  type PackageHealthResult,
  type PackageHealthStore,
} from "../../domain/extensions/package-health.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { capacityScope } from "../orchestration/product-resources.ts";
import {
  createPackageExecutionAdmission,
  PackageAdmissionError,
} from "./package-execution-admission.ts";
import { projectPackageProcessResult } from "./package-process-projection.ts";
import type { InspectionHost } from "./prepare-package.ts";

export interface PackageHealthHost {
  run(input: {
    record: PackageHealthRecord;
    snapshot: PackageSnapshot;
    declaration: ContributionDeclaration;
    signal: AbortSignal;
    resourceTaskId: string;
    expiresAt: number;
    catalogGeneration: number;
    confirmation: string;
    /** Native tool invocations reuse process ownership, isolation and recovery. */
    invocation?: {
      input: Readonly<Record<string, unknown>>;
      validateOutput(value: unknown): boolean;
    };
    current(): Promise<boolean>;
    save(record: PackageHealthRecord): void;
  }): Promise<PackageHealthRecord>;
  recover(record: PackageHealthRecord, signal: AbortSignal): Promise<PackageHealthRecord>;
}
export type PackageHealthAuthority = {
  trusted: boolean;
  enabled: boolean;
  inputs: string;
  strict: boolean;
  catalogGeneration: number;
};

/** Exact installed graph admission. No download, source-path execution, grants or native publication. */
export function createPackageHealth(options: {
  packages: Pick<PackageLifecycleStore, "current">;
  bytes: Pick<PackageBytes, "read">;
  store: PackageHealthStore;
  host: InspectionHost;
  execution: PackageHealthHost;
  resources: ProductTaskResources;
  authority(
    installed: InstalledPackage,
    contribution: string | null,
    signal: AbortSignal,
  ): Promise<PackageHealthAuthority>;
}) {
  const admit = createPackageExecutionAdmission({ ...options, protocol: PACKAGE_HEALTH_PROTOCOL });
  const capture = (request: PackageRequest, signal: AbortSignal) => {
    if (!request.health) throw new ExtensionInputError("health-contribution-required");
    return admit(
      {
        packageId: request.packageId,
        expectedRevision: request.expectedRevision,
        ...request.health,
      },
      signal,
    );
  };

  return {
    async run(request: PackageRequest, signal: AbortSignal): Promise<PackageReceipt> {
      const expiresAt = Math.min(
        options.resources.expiresAt,
        Date.now() + PACKAGE_HEALTH_LIMITS.wallTimeMs,
      );
      signal = AbortSignal.any([signal, AbortSignal.timeout(PACKAGE_HEALTH_LIMITS.wallTimeMs)]);
      const receipt: PackageReceipt = {
        action: "health",
        operationId: request.operationId,
        packageId: request.packageId,
        status: "failed",
        code: "health-not-started",
        priorRevision: request.expectedRevision,
        revision: request.expectedRevision,
        priorDigest: null,
        currentDigest: null,
        activation: "unavailable",
        confirmation: null,
        retainedVersions: 0,
        pendingCleanup: 0,
        recovery: "inspect",
      };
      const project = (result: PackageHealthResult): PackageReceipt => ({
        ...receipt,
        status:
          result.state === "uncertain"
            ? "uncertain"
            : result.state === "healthy" || result.state === "recovered"
              ? "completed"
              : result.terminated
                ? "failed"
                : "uncertain",
        code: result.code,
        data: z.json().parse(projectPackageProcessResult(result)),
        recovery:
          result.terminated && result.cleanup === "removed" && result.state !== "uncertain"
            ? "none"
            : "recover",
      });
      let observedRecord: PackageHealthRecord | null = null;
      try {
        if (
          !request.health ||
          request.sourcePath ||
          request.data ||
          request.dataCleanup ||
          request.versionDigest ||
          request.retention !== "retain"
        )
          throw new ExtensionInputError("invalid-health-request");
        const intent = { ...request, health: { ...request.health, recover: false } };
        delete intent.confirmation;
        const fingerprint = canonicalDigest(intent);
        const previous = options.store.get(request.operationId);
        if (!previous.ok) throw new ExtensionInputError(previous.error.code);
        if (previous.value) {
          const prior = previous.value;
          if (prior.fingerprint !== fingerprint)
            throw new ExtensionInputError("operation-id-reused");
          observedRecord = prior;
          if (
            !request.health.recover ||
            (prior.result.terminated && prior.result.cleanup === "removed")
          )
            return project(prior.result);
          const confirmation = canonicalDigest({ recovery: prior });
          if (!request.confirmation)
            return {
              ...project(prior.result),
              status: "preview",
              code: "health-recovery-confirmation-required",
              confirmation,
            };
          if (request.confirmation !== confirmation)
            throw new ExtensionInputError("stale-health-confirmation");
          const recovered = await options.execution.recover(prior, signal);
          const saved = options.store.save(recovered, prior.revision);
          if (!saved.ok) throw new ExtensionInputError(saved.error.code);
          return project(recovered.result);
        }
        if (request.health.recover) throw new ExtensionInputError("health-attempt-not-found");
        const captured = await capture(request, signal);
        const blocked = options.store.pending(request.health.contribution);
        if (!blocked.ok) throw new ExtensionInputError(blocked.error.code);
        if (blocked.value) throw new ExtensionInputError("unresolved-health-attempt");
        const failures = options.store.failures(request.health.contribution, captured.generation);
        if (!failures.ok) throw new ExtensionInputError(failures.error.code);
        if (failures.value >= PACKAGE_HEALTH_LIMITS.crashes)
          throw new ExtensionInputError("health-quarantined");
        const confirmation = canonicalDigest({ fingerprint, generation: captured.generation });
        if (!request.confirmation)
          return {
            ...receipt,
            status: "preview",
            code: "health-confirmation-required",
            confirmation,
            currentDigest: captured.installed.current?.identityDigest ?? null,
          };
        if (request.confirmation !== confirmation)
          throw new ExtensionInputError("stale-health-confirmation");
        const initial: PackageHealthRecord = {
          operation: request.operationId,
          packageId: request.packageId,
          fingerprint,
          revision: 1,
          result: initialHealthResult({
            protocol: PACKAGE_HEALTH_PROTOCOL,
            attempt: randomUUID(),
            package: captured.installed.current?.identityDigest ?? "",
            contribution: request.health.contribution,
            generation: captured.generation,
          }),
          birth: null,
          directory: null,
        };
        let record = initial;
        const current = async () => {
          try {
            return (await capture(request, signal)).generation === captured.generation;
          } catch {
            return false;
          }
        };
        const save = (next: PackageHealthRecord) => {
          const saved = options.store.save(next, next.revision === 1 ? 0 : record.revision);
          if (!saved.ok) throw new ExtensionInputError(saved.error.code);
          record = next;
          observedRecord = next;
        };
        const task = options.resources;
        const active: { execution?: Promise<PackageHealthRecord> } = {};
        const result = await task.execute({
          operation: request.operationId,
          attempt: initial.result.binding.attempt,
          generation: task.generation,
          inputBytes: Buffer.byteLength(JSON.stringify(intent)),
          amounts: {
            processes: 1,
            requests: 4,
            attempts: 1,
            concurrency: 1,
            bufferedBytes: 131_072,
            diskBytes: captured.installed.current?.byteLength ?? 0,
          },
          unknownDimensions: ["cpuMs", "memoryBytes"],
          signal,
          scopes: [
            {
              scope: capacityScope("process", "falryn", "package-health", "processes", "occupancy"),
              amount: 1,
              limit: PACKAGE_HEALTH_LIMITS.processes,
            },
            {
              scope: capacityScope(
                "package",
                request.packageId,
                "health",
                "processes",
                "occupancy",
              ),
              amount: 1,
              limit: PACKAGE_HEALTH_LIMITS.packageProcesses,
            },
          ],
          unit: {
            id: workUnitId(request.operationId),
            effect: "external",
            priority: "interactive",
            conflictKeys: [conflictKey("package", request.packageId)],
            dependencies: [],
            deadline: null,
            expectedOutputBytes: 131_072,
            retry: NO_RETRY,
            scopeId: null,
          },
          async run(admitted) {
            if (!(await current())) throw new ExtensionInputError("stale-health-authority");
            save(initial);
            active.execution = options.execution.run({
              record,
              snapshot: captured.snapshot,
              declaration: captured.declaration,
              signal: admitted,
              resourceTaskId: task.id,
              expiresAt,
              catalogGeneration: captured.catalogGeneration,
              confirmation,
              current,
              save,
            });
            const completed = await active.execution;
            return {
              value: completed.result,
              terminated: completed.result.terminated,
              observedEffect: completed.result.terminated ? "completed" : "uncertain",
            };
          },
        });
        // Scheduler cancellation can return before the admitted adapter settles.
        // Keep its database and ownership alive until bounded stop/persistence finish.
        if (active.execution) return project((await active.execution).result);
        return result.kind === "completed"
          ? project(result.value)
          : {
              ...receipt,
              code: result.receipt.state,
              status:
                record.result.pid !== null || result.receipt.uncertain ? "uncertain" : "failed",
            };
      } catch (error) {
        if (observedRecord && !observedRecord.result.terminated)
          return {
            ...project(observedRecord.result),
            status: "uncertain",
            code: error instanceof ExtensionInputError ? error.code : "health-execution-uncertain",
            recovery: "recover",
          };
        return {
          ...receipt,
          code: error instanceof ExtensionInputError ? error.code : "health-admission-failed",
          ...(error instanceof PackageAdmissionError
            ? { data: { packageId: error.packageId, contribution: error.contribution } }
            : {}),
        };
      }
    },
  };
}
