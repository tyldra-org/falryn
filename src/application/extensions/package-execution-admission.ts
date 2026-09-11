import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { DependencyCandidate } from "../../domain/extensions/dependencies.ts";
import type {
  InstalledPackage,
  PackageBytes,
  PackageLifecycleStore,
} from "../../domain/extensions/lifecycle.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import { type InspectionHost, preparePackage } from "./prepare-package.ts";

export type PackageExecutionAuthority = {
  trusted: boolean;
  enabled: boolean;
  inputs: string;
  strict: boolean;
  catalogGeneration: number;
};
export type InstalledContributionRequest = {
  packageId: string;
  expectedRevision: number;
  contribution: string;
  requiredControls: readonly ("cpu" | "memory")[];
};
export type PackageAdmissionOptions = {
  packages: Pick<PackageLifecycleStore, "current">;
  bytes: Pick<PackageBytes, "read">;
  host: InspectionHost;
  protocol: string;
  authority(
    installed: InstalledPackage,
    contribution: string | null,
    signal: AbortSignal,
  ): Promise<PackageExecutionAuthority>;
};

export class PackageAdmissionError extends ExtensionInputError {
  constructor(
    code: string,
    readonly packageId: string,
    readonly contribution: string | null,
  ) {
    super(code);
  }
}

/** Admit exact installed bytes and their locked dependency closure without starting code. */
export function createPackageExecutionAdmission(options: PackageAdmissionOptions) {
  return async function capture(request: InstalledContributionRequest, signal: AbortSignal) {
    let subject = request.packageId;
    let contribution: string | null = request.contribution;
    try {
      const health = request;
      const records = new Map<string, InstalledPackage>();
      const snapshots = new Map<string, PackageSnapshot>();
      const authorities: { id: string; authority: PackageExecutionAuthority }[] = [];
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
      if (declaration.execution.protocolVersion !== options.protocol)
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
      throw new PackageAdmissionError(
        error instanceof ExtensionInputError ? error.code : "health-admission-failed",
        subject,
        contribution,
      );
    }
  };
}
