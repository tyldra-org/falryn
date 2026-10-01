import type { InstalledVersion, PackageLifecycleStore } from "../../domain/extensions/lifecycle.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import type {
  HoldReason,
  TrustDecisionStore,
  TrustObservation,
  TrustProjection,
} from "../../domain/security/ecosystem-trust.ts";
import type {
  PackageProvenanceStore,
  SignatureVerifier,
} from "../../domain/security/package-provenance.ts";
import {
  derivePackageStanding,
  type PackageStanding,
  RUNNING_WORK_POLICY,
  type RunningWorkPolicy,
  STANDING_LIMITS,
  type StandingFacts,
  type StandingReason,
  type StandingState,
  standingOfTrust,
} from "../../domain/security/package-standing.ts";
import { inspectProvenanceTrust } from "./package-provenance.ts";
import { TRUST_POLICY_GENERATION } from "./package-trust.ts";

export type StandingOwners = {
  readonly packages: Pick<PackageLifecycleStore, "current" | "versions">;
  readonly decisions: TrustDecisionStore;
  readonly provenance: PackageProvenanceStore;
  readonly verifier: SignatureVerifier;
};

/**
 * The one observation of an installed version. It needs only the installed record, never the source
 * directory, so a package can be held back or judged while its source is gone and the network is down.
 */
export function installedTrustObservation(
  version: InstalledVersion,
  actor: string,
  now: number,
): TrustObservation {
  return {
    subject: { identity: version.identity, ownership: version.ownership },
    evidence: {
      integrity: "computed",
      signature: "unavailable",
      curation: "unavailable",
      advisory: "unavailable",
      observedAt: now,
      expiresAt: null,
      reference: version.identity.packageDigest,
    },
    policyGeneration: TRUST_POLICY_GENERATION,
    actor,
    scope: { kind: "user", authority: actor },
    now,
    compatibility: "compatible",
    health: "unknown",
    availability: "unavailable",
    online: false,
  };
}

/** The shared trust projection of one installed version, or `null` when the facts cannot be read. */
export function projectInstalledTrust(
  owners: Pick<StandingOwners, "decisions" | "provenance" | "verifier">,
  version: InstalledVersion,
  actor: string,
  now: number,
): TrustProjection | null {
  const result = inspectProvenanceTrust(owners, installedTrustObservation(version, actor, now), []);
  return result.status === "failed" ? null : result.trust;
}

export type StandingSummary = {
  readonly state: StandingState;
  readonly reason: StandingReason | null;
  readonly eligible: boolean;
};

export const ENFORCEMENT_ACTIONS = ["quarantine", "release", "revoke"] as const;
export type EnforcementAction = (typeof ENFORCEMENT_ACTIONS)[number];
export type EnforcementRequest = {
  readonly action: EnforcementAction;
  readonly packageId: string;
  readonly expectedRevision: number;
  readonly reason?: HoldReason;
  readonly confirmation?: string;
};
export type EnforcementResult =
  | { readonly status: "failed"; readonly code: string }
  | {
      readonly status: "preview" | "applied";
      readonly confirmation: string | null;
      readonly before: StandingState;
      readonly standing: PackageStanding;
      readonly runningWork: RunningWorkPolicy;
      readonly affectedContributions: number;
    };

/**
 * The single owner of what an installed package may do. It decides nothing itself: it reads the
 * shared trust evaluator for every installed version and the dependency closure, and it applies a
 * hold (`quarantine`, `release`, `revoke`) through the one trust-decision store, so the tool gateway,
 * the catalog and every launch check see the change at once. The lifecycle owner keeps install,
 * update, rollback and removal; neither grants activation.
 */
export function createPackageStanding(options: {
  readonly owners: StandingOwners;
  readonly actor: string;
  readonly now: () => number;
  /** Contribution identities saved with a decision; may fail when the cached bytes are damaged. */
  readonly contributions?: (version: InstalledVersion, signal: AbortSignal) => Promise<string[]>;
}) {
  const { owners, actor } = options;

  function closure(rootVersion: InstalledVersion, now: number): StandingFacts["dependencies"] {
    const found: {
      id: string;
      digest: string;
      trust: TrustProjection | null;
    }[] = [];
    const seen = new Set<string>();
    const pending = rootVersion.dependencies.map(({ id, digest }) => ({ id, digest }));
    while (pending.length > 0 && found.length < STANDING_LIMITS.dependencies) {
      const next = pending.shift();
      if (next === undefined || seen.has(next.id)) continue;
      seen.add(next.id);
      const installed = owners.packages.current(next.id);
      const version = installed.ok ? installed.value.current : null;
      // A missing dependency, or one whose installed bytes are not the locked ones, is not eligible.
      const trust =
        version !== null && version.identityDigest === next.digest
          ? projectInstalledTrust(owners, version, actor, now)
          : null;
      found.push({ id: next.id, digest: next.digest, trust });
      if (version !== null)
        pending.push(...version.dependencies.map(({ id, digest }) => ({ id, digest })));
    }
    return found;
  }

  function standing(
    packageId: string,
    include: { readonly versions: boolean } = { versions: true },
  ): Result<PackageStanding, { readonly code: string }> {
    const installed = owners.packages.current(packageId);
    if (!installed.ok) return err({ code: "package-store-unavailable" });
    const current = installed.value.current;
    const now = options.now();
    if (current === null)
      return ok(
        derivePackageStanding({
          installed: installed.value,
          trust: null,
          retained: [],
          dependencies: [],
        }),
      );
    const listed = include.versions ? owners.packages.versions(packageId) : ok([]);
    if (!listed.ok) return err({ code: "package-store-unavailable" });
    const trust = projectInstalledTrust(owners, current, actor, now);
    // Without the current version's trust facts nothing can be asserted, so refuse rather than guess.
    if (trust === null) return err({ code: "trust-unavailable" });
    return ok(
      derivePackageStanding({
        installed: installed.value,
        trust,
        retained: listed.value.map((version) => ({
          version,
          trust: projectInstalledTrust(owners, version, actor, now),
        })),
        dependencies: closure(current, now),
      }),
    );
  }

  /** What one exact version stands at, for lifecycle previews; `null` when unreadable. */
  function summarize(version: InstalledVersion): StandingSummary | null {
    const trust = projectInstalledTrust(owners, version, actor, options.now());
    if (trust === null) return null;
    const result = standingOfTrust(trust);
    return { ...result, eligible: result.state === "eligible" };
  }

  async function enforce(
    request: EnforcementRequest,
    signal: AbortSignal,
  ): Promise<EnforcementResult> {
    if (signal.aborted) return { status: "failed", code: "cancelled" };
    if (request.reason !== undefined && request.action === "release")
      return { status: "failed", code: "unexpected-hold-reason" };
    const installed = owners.packages.current(request.packageId);
    if (!installed.ok) return { status: "failed", code: "package-store-unavailable" };
    const current = installed.value.current;
    if (current === null) return { status: "failed", code: "not-installed" };
    if (request.expectedRevision !== installed.value.revision)
      return { status: "failed", code: "stale-package-revision" };
    const before = standing(request.packageId);
    if (!before.ok) return { status: "failed", code: before.error.code };
    const now = options.now();
    // Damaged cached bytes are a reason to hold a package, so they never prevent holding it.
    const contributions = await (
      options.contributions?.(current, signal) ?? Promise.resolve([])
    ).catch(() => []);
    const result = inspectProvenanceTrust(
      owners,
      installedTrustObservation(current, actor, now),
      contributions,
      {
        action: request.action,
        expiresAt: null,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
      },
      signal,
    );
    if (result.status === "failed") return { status: "failed", code: result.code };
    const after = result.status === "applied" ? standing(request.packageId) : before;
    if (!after.ok) return { status: "failed", code: after.error.code };
    return {
      status: result.status === "applied" ? "applied" : "preview",
      confirmation: result.confirmation,
      before: before.value.state,
      standing: after.value,
      runningWork: RUNNING_WORK_POLICY,
      affectedContributions: result.affectedContributions.length,
    };
  }

  return {
    standing,
    summarize,
    enforce,
    dependencies: (version: InstalledVersion) => closure(version, options.now()),
  };
}
export type PackageStandingOwner = ReturnType<typeof createPackageStanding>;
