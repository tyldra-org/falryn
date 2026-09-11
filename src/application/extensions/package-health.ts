import { randomUUID } from "node:crypto";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { DependencyCandidate } from "../../domain/extensions/dependencies.ts";
import type {
  InstalledPackage,
  PackageBytes,
  PackageLifecycleStore,
  PackageReceipt,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import {
  type ContributionDeclaration,
  contributionDeclarationSchema,
} from "../../domain/extensions/manifest.ts";
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
import { type InspectionHost, preparePackage } from "./prepare-package.ts";

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

class HealthAdmissionError extends ExtensionInputError {
  constructor(
    code: string,
    readonly packageId: string,
    readonly contribution: string | null,
  ) {
    super(code);
  }
}

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
  async function capture(request: PackageRequest, signal: AbortSignal) {
    let subject = request.packageId;
    let contribution: string | null = request.health?.contribution ?? null;
    try {
      const health = request.health;
      if (!health) throw new ExtensionInputError("health-contribution-required");
      const records = new Map<string, InstalledPackage>();
      const snapshots = new Map<string, PackageSnapshot>();
      const authorities: { id: string; authority: PackageHealthAuthority }[] = [];
      const candidates: DependencyCandidate[] = [];
      const locked = new Map<string, string>();
      let inventoryBytes = 0;
      const pending = [{ id: request.packageId, optional: false }];
      while (pending.length > 0) {
        if (signal.aborted) throw new ExtensionInputError("cancelled");
        const next = pending.shift();
        if (!next || records.has(next.id)) continue;
        subject = next.id;
        contribution = next.id === request.packageId ? health.contribution : null;
        if (records.size >= 256) throw new ExtensionInputError("dependency-limit");
        const installed = options.packages.current(next.id);
        if (!installed.ok) throw new ExtensionInputError(installed.error.code);
        if (!installed.value.current) {
          if (next.optional) continue;
          throw new ExtensionInputError("dependency-unavailable");
        }
        const version = installed.value.current;
        if (next.id === request.packageId)
          for (const dependency of version.dependencies)
            locked.set(dependency.id, dependency.digest);
        if (next.id === request.packageId && installed.value.revision !== request.expectedRevision)
          throw new ExtensionInputError("stale-package-revision");
        const authority = await options.authority(
          installed.value,
          next.id === request.packageId ? health.contribution : null,
          signal,
        );
        if (!authority.trusted || !authority.enabled) {
          if (next.optional) continue;
          throw new ExtensionInputError(
            !authority.trusted ? "package-trust-required" : "dependency-disabled",
          );
        }
        if (!authority.strict) throw new ExtensionInputError("strict-sandbox-policy-required");
        const snapshot = await options.bytes.read(version, signal);
        inventoryBytes += version.byteLength;
        if (inventoryBytes > 67_108_864)
          throw new ExtensionInputError("health-inventory-exhausted");
        const prepared = await preparePackage({ read: async () => snapshot }, options.host, {
          candidates: version.dependencies,
          locked: version.dependencies.map(({ id, digest }) => ({ id, digest })),
          signal,
        });
        if (!prepared.ok) throw new ExtensionInputError(prepared.code);
        if (
          prepared.package.identityDigest !== version.identityDigest ||
          prepared.package.compatibility !== "compatible" ||
          !prepared.package.dependencies.ok
        )
          throw new ExtensionInputError("installed-package-incompatible");
        records.set(next.id, installed.value);
        if (next.id === request.packageId) snapshots.set(next.id, snapshot);
        authorities.push({ id: next.id, authority });
        if (next.id !== request.packageId) {
          if (version.identity.packageVersion === null)
            throw new ExtensionInputError("dependency-version-unavailable");
          candidates.push({
            id: next.id,
            packageVersion: version.identity.packageVersion,
            digest: version.identityDigest,
            dependencies: prepared.package.falryn.dependencies,
          });
        }
        pending.push(
          ...prepared.package.falryn.dependencies.filter(
            (dependency) => !dependency.optional || locked.has(dependency.id),
          ),
        );
      }
      const installed = records.get(request.packageId);
      const rootAuthority = authorities[0]?.authority;
      subject = request.packageId;
      contribution = health.contribution;
      const snapshot = snapshots.get(request.packageId);
      if (!installed?.current || !snapshot || !rootAuthority)
        throw new ExtensionInputError("not-installed");
      const prepared = await preparePackage({ read: async () => snapshot }, options.host, {
        candidates,
        locked: installed.current.dependencies.map(({ id, digest }) => ({ id, digest })),
        signal,
      });
      if (!prepared.ok) throw new ExtensionInputError(prepared.code);
      if (!prepared.package.dependencies.ok)
        throw new ExtensionInputError(prepared.package.dependencies.code);
      if (
        prepared.package.dependencies.lock.length !== locked.size ||
        prepared.package.dependencies.lock.some(
          (dependency) => locked.get(dependency.id) !== dependency.digest,
        )
      )
        throw new ExtensionInputError("dependency-lock-changed");
      const selected = prepared.package.contributions.find(
        (entry) => entry.identityDigest === health.contribution,
      );
      if (!selected) throw new ExtensionInputError("contribution-unavailable");
      const declaration = contributionDeclarationSchema.parse(selected.declaration);
      const local = new Map(
        prepared.package.contributions.map((entry) => [
          `${entry.identity.nativeKind}/${entry.identity.namespace}/${entry.identity.localId}`,
          entry,
        ]),
      );
      const checked = new Set<string>();
      const required = [
        ...declaration.dependencies.map((id) =>
          id.split("/").length === 3
            ? id
            : `${declaration.kind}/${id.includes("/") ? id : `${declaration.namespace}/${id}`}`,
        ),
      ];
      while (required.length) {
        const key = required.shift();
        if (!key || checked.has(key)) continue;
        checked.add(key);
        const dependency = local.get(key);
        contribution = dependency?.identityDigest ?? key;
        if (!dependency) throw new ExtensionInputError("contribution-dependency-unavailable");
        const authority = await options.authority(installed, dependency.identityDigest, signal);
        if (!authority.trusted || !authority.enabled || dependency.compatibility !== "compatible")
          throw new ExtensionInputError("contribution-dependency-disabled");
        if (dependency.mode !== "declarative")
          throw new ExtensionInputError("dependency-runtime-unavailable");
        authorities.push({ id: dependency.identityDigest, authority });
        const child = contributionDeclarationSchema.parse(dependency.declaration);
        required.push(
          ...child.dependencies.map((id) =>
            id.split("/").length === 3
              ? id
              : `${child.kind}/${id.includes("/") ? id : `${child.namespace}/${id}`}`,
          ),
        );
      }
      contribution = health.contribution;
      if (selected.compatibility !== "compatible")
        throw new ExtensionInputError("contribution-incompatible");
      if (selected.mode !== "governed" || !declaration.execution)
        throw new ExtensionInputError("governed-execution-required");
      if (declaration.execution.loader !== "native")
        throw new ExtensionInputError("health-loader-unavailable");
      if (declaration.execution.protocolVersion !== PACKAGE_HEALTH_PROTOCOL)
        throw new ExtensionInputError("health-protocol-unavailable");
      const authority = declaration.authority;
      if (
        authority.effects.some((effect) => effect !== "observation") ||
        authority.permissions.length ||
        authority.roots.length ||
        authority.destinations.length ||
        authority.secretReferences.length ||
        authority.localData.length ||
        declaration.execution.expectedChildren.length ||
        declaration.execution.hostIntegrations.length ||
        declaration.module !== undefined
      )
        throw new ExtensionInputError("health-authority-unavailable");
      if (health.requiredControls.length)
        throw new ExtensionInputError(`health-${health.requiredControls[0]}-control-unavailable`);
      return {
        installed,
        snapshot,
        declaration,
        catalogGeneration: rootAuthority.catalogGeneration,
        generation: canonicalDigest({
          records: [...records.values()],
          authorities,
          host: options.host,
        }),
      };
    } catch (error) {
      throw new HealthAdmissionError(
        error instanceof ExtensionInputError ? error.code : "health-admission-failed",
        subject,
        contribution,
      );
    }
  }
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
        data: {
          ...result,
          sandbox:
            result.sandbox === null
              ? null
              : {
                  ...result.sandbox,
                  readRoots: result.sandbox.readRoots.map(() => "package-root"),
                  writeRoots: [],
                  credentialHandles: [],
                },
        },
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
          ...(error instanceof HealthAdmissionError
            ? { data: { packageId: error.packageId, contribution: error.contribution } }
            : {}),
        };
      }
    },
  };
}
