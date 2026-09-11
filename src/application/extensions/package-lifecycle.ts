import { randomUUID } from "node:crypto";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { DependencyCandidate } from "../../domain/extensions/dependencies.ts";
import {
  type InstalledPackage,
  type InstalledVersion,
  type PackageAction,
  type PackageBytes,
  type PackageLifecycleStore,
  type PackageReceipt,
  type PackageRequest,
  packageRequestSchema,
} from "../../domain/extensions/lifecycle.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";
import type { PackageSnapshot, PackageSource } from "../../domain/extensions/package-source.ts";
import { planPackageDataCleanup } from "./package-data-cleanup.ts";
import { packageDeclarations, preparePackageDataPublication } from "./package-data-policy.ts";
import { type InspectionHost, type PreparedPackage, preparePackage } from "./prepare-package.ts";

export type PackageLifecycle = ReturnType<typeof createPackageLifecycle>;

/** Installed state is distinct from activation. This owner accepts no executable binding or grant port. */
export function createPackageLifecycle(
  store: PackageLifecycleStore,
  bytes: PackageBytes,
  host: InspectionHost,
  validateConfiguration?: (document: PackageDataDocument, signal: AbortSignal) => Promise<string>,
) {
  function counted(receipt: PackageReceipt): PackageReceipt {
    const counts = store.counts(receipt.packageId);
    if (!counts.ok)
      return {
        ...receipt,
        status: "uncertain",
        code: "cleanup-state-unavailable",
        recovery: "inspect",
      };
    const pending = counts.value.pending > 0;
    return {
      ...receipt,
      retainedVersions: counts.value.retained,
      pendingCleanup: counts.value.pending,
      ...(pending && receipt.status === "completed"
        ? {
            recovery: "recover" as const,
            ...(["uninstall", "recover"].includes(receipt.action)
              ? { status: "partial" as const, code: "cleanup-pending" }
              : {}),
          }
        : {}),
    };
  }
  async function readVersion(
    version: InstalledVersion,
    signal: AbortSignal,
  ): Promise<PreparedPackage> {
    const snapshot = await bytes.read(version, signal);
    const checked = await preparePackage({ read: async () => snapshot }, host, {
      candidates: version.dependencies,
      signal,
    });
    if (!checked.ok || checked.package.identityDigest !== version.identityDigest)
      throw new ExtensionInputError("cached-package-integrity-failed");
    return checked.package;
  }
  async function candidates(
    prepared: PreparedPackage,
    signal: AbortSignal,
  ): Promise<DependencyCandidate[]> {
    const found = new Map<string, DependencyCandidate>();
    const pending = [...prepared.falryn.dependencies];
    while (pending.length > 0) {
      if (signal.aborted) throw new ExtensionInputError("cancelled");
      const requirement = pending.shift();
      if (requirement === undefined || found.has(requirement.id)) continue;
      if (requirement.id === prepared.identity.packageId)
        throw new ExtensionInputError("dependency-cycle");
      if (found.size >= 256) throw new ExtensionInputError("dependency-limit");
      const current = store.current(requirement.id);
      if (!current.ok) throw new ExtensionInputError(current.error.code);
      const version = current.value.current;
      if (version === null) {
        if (requirement.optional) continue;
        throw new ExtensionInputError("dependency-unavailable");
      }
      const dependency = await readVersion(version, signal);
      if (dependency.identity.packageVersion === null)
        throw new ExtensionInputError("dependency-version-unavailable");
      found.set(requirement.id, {
        id: requirement.id,
        packageVersion: dependency.identity.packageVersion,
        digest: dependency.identityDigest,
        dependencies: dependency.falryn.dependencies,
      });
      pending.push(...dependency.falryn.dependencies);
    }
    return [...found.values()];
  }
  async function cleanup(
    receipt: PackageReceipt,
    signal: AbortSignal,
    throughEpoch: number,
  ): Promise<PackageReceipt> {
    const selected = store.cleanup(receipt.packageId, 64, throughEpoch);
    if (!selected.ok)
      return counted({
        ...receipt,
        status: "partial",
        code: selected.error.code,
        recovery: "recover",
      });
    let failed = false;
    for (const version of selected.value) {
      try {
        await bytes.remove(version.storageId, signal);
        if (!store.removed(version.storageId).ok) failed = true;
      } catch {
        failed = true;
      }
    }
    const result = counted(receipt);
    return failed || result.pendingCleanup > 0
      ? { ...result, status: "partial", code: "cleanup-pending", recovery: "recover" }
      : result;
  }
  return {
    async run(
      action: PackageAction,
      request: PackageRequest,
      signal: AbortSignal,
      source?: PackageSource,
    ): Promise<PackageReceipt> {
      let state: InstalledPackage = { packageId: request.packageId, revision: 0, current: null };
      let receipt: PackageReceipt = {
        action,
        operationId: request.operationId,
        packageId: request.packageId,
        status: "failed",
        code: "not-started",
        priorRevision: 0,
        revision: 0,
        priorDigest: null,
        currentDigest: null,
        activation: "unavailable",
        confirmation: null,
        retainedVersions: 0,
        pendingCleanup: 0,
        recovery: "fresh-preview",
      };
      const fail = (code: string): PackageReceipt =>
        counted({
          ...receipt,
          status: code === "uncertain" ? "uncertain" : "failed",
          code,
          recovery: code === "uncertain" ? "inspect" : "fresh-preview",
        });
      try {
        if (!packageRequestSchema.safeParse(request).success)
          return fail("invalid-package-request");
        if (signal.aborted) return fail("cancelled");
        const intent = { ...request };
        delete intent.confirmation;
        const fingerprint = canonicalDigest({ action, ...intent });
        const prior = store.operation(request.operationId);
        if (!prior.ok) return fail(prior.error.code);
        if (prior.value !== null) {
          if (prior.value.fingerprint !== fingerprint) return fail("operation-id-reused");
          return counted(prior.value.receipt);
        }
        const current = store.current(request.packageId);
        if (!current.ok) return fail(current.error.code);
        state = current.value;
        receipt = {
          ...receipt,
          priorRevision: state.revision,
          revision: state.revision,
          priorDigest: state.current?.identityDigest ?? null,
          currentDigest: state.current?.identityDigest ?? null,
        };
        if (request.nativeActivation || request.nativeRecovery)
          return fail("native-package-owner-required");
        if (action === "inspect") {
          if (state.current !== null) await readVersion(state.current, signal);
          const data = store.data?.(request.packageId);
          if (data && !data.ok) return fail(data.error.code);
          return counted({
            ...receipt,
            status: "completed",
            code: state.current === null ? "not-installed" : "installed-disabled",
            recovery: "none",
            ...(data?.ok && data.value
              ? {
                  data: {
                    version: 1,
                    revision: data.value.revision,
                    configurationRevision: data.value.configurationRevision,
                    configuration: data.value.declarations.configuration.map(
                      ({ id, contribution, scopes, sensitivity, application }) => ({
                        id,
                        contribution,
                        scopes,
                        sensitivity,
                        application,
                      }),
                    ),
                    state: data.value.declarations.state.map(
                      ({
                        id,
                        contribution,
                        schemaVersion,
                        scopes,
                        retention,
                        cleanup,
                        maxBytes,
                        maxRecords,
                      }) => ({
                        id,
                        contribution,
                        schemaVersion,
                        scopes,
                        retention,
                        cleanup,
                        maxBytes,
                        maxRecords,
                      }),
                    ),
                    retainedRecords: data.value.records.filter((record) => !record.tombstone)
                      .length,
                  },
                }
              : {}),
          });
        }
        if (action === "enable") return fail("activation-owner-unavailable");
        if (action === "health") return fail("package-health-owner-required");
        if (request.health !== undefined) return fail("unexpected-package-health-request");
        if (action === "data") return fail("package-data-owner-required");
        if (request.data !== undefined) return fail("unexpected-package-data-request");
        if (request.expectedRevision !== state.revision) return fail("stale-package-revision");
        if (action !== "rollback" && request.versionDigest !== undefined)
          return fail("unexpected-version-digest");
        if (action !== "uninstall" && request.retention !== "retain")
          return fail("unexpected-retention-choice");
        if (action !== "uninstall" && request.dataCleanup !== undefined)
          return fail("unexpected-data-cleanup-choice");
        if (!["install", "update"].includes(action) && source !== undefined)
          return fail("unexpected-package-source");
        if (action === "install" && state.current !== null) return fail("already-installed");
        if (["update", "rollback", "disable"].includes(action) && state.current === null)
          return fail("not-installed");
        let candidate = state.current;
        let dataPublication:
          | { expectedRevision: number; document: PackageDataDocument }
          | undefined;
        const dataBefore = store.data?.(request.packageId);
        if (dataBefore && !dataBefore.ok) return fail(dataBefore.error.code);
        let snapshot: PackageSnapshot | undefined;
        if (action === "install" || action === "update") {
          if (source === undefined) return fail("package-source-required");
          const observedSnapshot = await source.read(signal);
          snapshot = observedSnapshot;
          if (snapshot.diagnostics.length > 0 || snapshot.omittedDiagnostics > 0)
            return fail("incomplete-package-inventory");
          const observed = await preparePackage({ read: async () => observedSnapshot }, host, {
            signal,
          });
          if (!observed.ok) return fail(observed.code);
          const dependencies = await candidates(observed.package, signal);
          const prepared = await preparePackage({ read: async () => observedSnapshot }, host, {
            candidates: dependencies,
            signal,
          });
          if (!prepared.ok) return fail(prepared.code);
          if (prepared.package.identity.packageId !== request.packageId)
            return fail("package-identity-mismatch");
          if (
            prepared.package.compatibility !== "compatible" ||
            prepared.package.contributions.some((c) => c.compatibility !== "compatible")
          )
            return fail("package-incompatible");
          if (!prepared.package.dependencies.ok) return fail(prepared.package.dependencies.code);
          if (prepared.package.diagnostics.length > 0 || prepared.package.omittedDiagnostics > 0)
            return fail("package-validation-failed");
          const declarations = packageDeclarations(prepared.package);
          if (store.data !== undefined)
            dataPublication = {
              expectedRevision: dataBefore?.ok ? (dataBefore.value?.revision ?? 0) : 0,
              document: preparePackageDataPublication(
                dataBefore?.ok ? dataBefore.value : null,
                prepared.package,
                signal,
                state.revision + 1,
              ),
            };
          else if (declarations.configuration.length || declarations.state.length)
            return fail("package-data-owner-unavailable");
          candidate = {
            dataDeclarations: declarations,
            identity: prepared.package.identity,
            identityDigest: prepared.package.identityDigest,
            sourceId: snapshot.sourceId,
            ownership: prepared.package.ownership,
            dependencies: [...prepared.package.dependencies.lock],
            byteLength: snapshot.files.reduce((n, f) => n + f.bytes.length, 0),
            fileCount: snapshot.files.length,
            storageId: randomUUID(),
            state: "staged",
          };
        } else if (action === "rollback") {
          if (request.versionDigest === undefined) return fail("rollback-version-required");
          const retained = store.version(request.packageId, request.versionDigest);
          if (!retained.ok) return fail(retained.error.code);
          if (retained.value === null) return fail("rollback-version-unavailable");
          const checked = await readVersion(retained.value, signal);
          if (checked.compatibility !== "compatible" || !checked.dependencies.ok)
            return fail("rollback-incompatible");
          if (store.data !== undefined)
            dataPublication = {
              expectedRevision: dataBefore?.ok ? (dataBefore.value?.revision ?? 0) : 0,
              document: preparePackageDataPublication(
                dataBefore?.ok ? dataBefore.value : null,
                checked,
                signal,
                state.revision + 1,
              ),
            };
          candidate = retained.value;
        } else if (action === "uninstall") {
          candidate = null;
          if (dataBefore?.ok && dataBefore.value) {
            const cleanup = planPackageDataCleanup(dataBefore.value, request.dataCleanup);
            dataPublication = {
              expectedRevision: dataBefore.value.revision,
              document: cleanup.document,
            };
            receipt = { ...receipt, data: cleanup.summary };
          }
        } else if (action === "disable" && dataBefore?.ok && dataBefore.value) {
          receipt = {
            ...receipt,
            data: {
              version: 1,
              configuration: "retained",
              state: "retained",
              revision: dataBefore.value.revision,
            },
          };
        }
        const configurationSource =
          dataPublication && action !== "uninstall"
            ? await validateConfiguration?.(dataPublication.document, signal)
            : undefined;
        const counts = store.counts(request.packageId);
        if (!counts.ok) return fail(counts.error.code);
        const confirmation = canonicalDigest({
          version: 1,
          fingerprint,
          revision: state.revision,
          prior: state.current?.identityDigest ?? null,
          candidate: candidate?.identityDigest ?? null,
          counts: counts.value,
          dataRevision: dataBefore?.ok ? (dataBefore.value?.revision ?? 0) : 0,
          ...(configurationSource === undefined ? {} : { configurationSource }),
        });
        if (request.confirmation === undefined)
          return counted({
            ...receipt,
            status: "preview",
            code: "confirmation-required",
            confirmation,
            recovery: "none",
          });
        if (request.confirmation !== confirmation) return fail("stale-package-confirmation");
        if (signal.aborted) return fail("cancelled");
        let epoch = counts.value.epoch;
        if (snapshot !== undefined && candidate !== null) {
          const staged = store.stage(candidate);
          if (!staged.ok) return fail(staged.error.code);
          epoch = staged.value;
        }
        const committed: PackageReceipt = {
          ...receipt,
          status: "completed",
          code:
            action === "uninstall"
              ? "uninstalled"
              : action === "recover"
                ? "recovered"
                : "installed-disabled",
          revision: state.revision + 1,
          currentDigest: candidate?.identityDigest ?? null,
          recovery: "none",
        };
        const staging = snapshot;
        const storageId = candidate?.storageId;
        const published = store.publish(
          {
            expected: state,
            candidate,
            ...(dataPublication === undefined ? {} : { dataPublication }),
            remove: action === "uninstall" && request.retention === "remove",
            fingerprint,
            receipt: committed,
            expectedCounts: {
              epoch,
              retained: counts.value.retained,
              pending: counts.value.pending + (snapshot === undefined ? 0 : 1),
            },
            ...(staging !== undefined && storageId !== undefined
              ? { stageBytes: () => bytes.stage(storageId, staging, signal) }
              : {}),
          },
          signal,
        );
        if (!published.ok) return fail(published.error.code);
        if (action === "recover" || (action === "uninstall" && request.retention === "remove"))
          return cleanup(published.value, signal, counts.value.epoch);
        return counted(published.value);
      } catch (error) {
        return fail(error instanceof ExtensionInputError ? error.code : "package-operation-failed");
      }
    },
  };
}
