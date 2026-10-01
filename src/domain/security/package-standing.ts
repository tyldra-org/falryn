/**
 * The standing of an installed package: what it may do now, why not when it may not, and which
 * recovery choices exist. It is derived on every read from facts other owners keep, namely the
 * lifecycle record, the trust projection of each installed identity and the dependency closure. It is
 * stored nowhere, so there is no second grant, quarantine or revocation record to disagree with the
 * shared trust evaluator that the tool gateway and the catalog already consult.
 */
import type { InstalledPackage, InstalledVersion } from "../extensions/lifecycle.ts";
import { type EcosystemTrustReason, ecosystemTrustReason } from "./ecosystem-notice.ts";
import type { TrustProjection } from "./ecosystem-trust.ts";

export const STANDING_STATES = [
  "not-installed",
  "eligible",
  "unapproved",
  "expired",
  "changed",
  "stale",
  "quarantined",
  "revoked",
  "incompatible",
  "dependency-blocked",
] as const;
export type StandingState = (typeof STANDING_STATES)[number];

/** Why a package that is not eligible is not; the trust reasons plus its dependency closure. */
export type StandingReason = EcosystemTrustReason | "dependency-not-eligible";

export const RECOVERY_CHOICES = [
  "inspect",
  "refresh-evidence",
  "approve",
  "release",
  "rollback",
  "update",
  "uninstall",
] as const;
export type RecoveryChoice = (typeof RECOVERY_CHOICES)[number];

/**
 * What a transition that removes eligibility does to work already admitted. The gateway and every
 * admission path stop new work at once; running attempts hold an immutable binding and stop at their
 * next protocol boundary because their generation digest changes; the supervisor then cleans up its
 * own process tree within its bounds. Forensic evidence is never removed by the transition.
 */
export const RUNNING_WORK_POLICY = {
  newAdmission: "denied-immediately",
  runningAttempts: "stopped-at-next-boundary",
  cleanup: "owner-bounded",
  evidence: "retained",
} as const;
export type RunningWorkPolicy = typeof RUNNING_WORK_POLICY;

export const STANDING_LIMITS = { versions: 64, dependencies: 256, recovery: 72 } as const;

export type VersionStanding = {
  readonly identityDigest: string;
  readonly packageVersion: string | null;
  readonly current: boolean;
  readonly state: StandingState;
  readonly reason: StandingReason | null;
  readonly eligible: boolean;
  readonly byteLength: number;
  readonly fileCount: number;
};
export type DependencyStanding = {
  readonly id: string;
  readonly digest: string;
  readonly state: StandingState;
  readonly reason: StandingReason | null;
  readonly eligible: boolean;
};
export type RecoveryOption = {
  readonly choice: RecoveryChoice;
  /** The retained version a `rollback` choice would restore; absent for every other choice. */
  readonly versionDigest?: string;
};
export type PackageStanding = {
  readonly version: 1;
  readonly packageId: string;
  readonly revision: number;
  readonly state: StandingState;
  readonly reason: StandingReason | null;
  readonly identityDigest: string | null;
  readonly packageVersion: string | null;
  readonly decision: TrustProjection["decisionStatus"] | null;
  readonly advisory: TrustProjection["evidence"]["advisory"] | null;
  readonly dependencies: readonly DependencyStanding[];
  readonly versions: readonly VersionStanding[];
  /** The newest retained non-current version whose own approval is still eligible, if any. */
  readonly lastKnownGood: string | null;
  readonly recovery: readonly RecoveryOption[];
  readonly truncated: boolean;
};

export type StandingFacts = {
  readonly installed: InstalledPackage;
  /** Trust projection of the current version; `null` when the facts could not be read. */
  readonly trust: TrustProjection | null;
  readonly retained: readonly {
    readonly version: InstalledVersion;
    readonly trust: TrustProjection | null;
  }[];
  readonly dependencies: readonly {
    readonly id: string;
    readonly digest: string;
    /** `null` when the dependency is not installed, which blocks like any other lost eligibility. */
    readonly trust: TrustProjection | null;
  }[];
};

/** A trust projection maps to one standing state; a missing projection denies like an absent approval. */
export function standingOfTrust(trust: TrustProjection | null): {
  readonly state: Exclude<StandingState, "not-installed" | "dependency-blocked">;
  readonly reason: EcosystemTrustReason | null;
} {
  const reason = ecosystemTrustReason(trust);
  switch (reason) {
    case null:
      return { state: "eligible", reason };
    case "ecosystem-trust-revoked":
      return { state: "revoked", reason };
    case "ecosystem-trust-quarantined":
      return { state: "quarantined", reason };
    case "ecosystem-trust-incompatible":
      return { state: "incompatible", reason };
    case "ecosystem-trust-stale":
      return { state: "stale", reason };
    case "ecosystem-trust-expired":
      return { state: "expired", reason };
    case "ecosystem-trust-changed":
      return { state: "changed", reason };
    default:
      return { state: "unapproved", reason };
  }
}

function recoveryFor(
  state: StandingState,
  trust: TrustProjection | null,
  rollbackTargets: readonly string[],
): RecoveryOption[] {
  const rollback = rollbackTargets.map((versionDigest) => ({
    choice: "rollback" as const,
    versionDigest,
  }));
  const common: RecoveryOption[] = [{ choice: "inspect" }];
  switch (state) {
    case "not-installed":
      return common;
    case "eligible":
      return common;
    case "unapproved":
    case "changed":
      return [...common, { choice: "approve" }, { choice: "uninstall" }];
    case "expired":
    case "stale":
      return [
        ...common,
        { choice: "refresh-evidence" },
        { choice: "approve" },
        { choice: "uninstall" },
      ];
    case "quarantined":
      return [
        ...common,
        // A decision-made quarantine is released by a decision; evidence-made one needs new evidence.
        trust?.decisionStatus === "quarantined"
          ? { choice: "release" }
          : { choice: "refresh-evidence" },
        ...rollback,
        { choice: "uninstall" },
      ];
    case "revoked":
      return [
        ...common,
        // An advisory revocation is lifted only by newer evidence; a user's own can be re-approved.
        trust?.evidence.advisory === "revoked"
          ? { choice: "refresh-evidence" }
          : { choice: "approve" },
        { choice: "update" },
        ...rollback,
        { choice: "uninstall" },
      ];
    case "incompatible":
      return [...common, { choice: "update" }, ...rollback, { choice: "uninstall" }];
    case "dependency-blocked":
      return [...common, { choice: "update" }, ...rollback, { choice: "uninstall" }];
  }
}

/**
 * Derive the standing from observed facts. Nothing here chooses for the user: a rollback target is
 * offered, never taken, and a target that is itself not eligible is listed with its own state so
 * restoring it is never mistaken for restoring trust.
 */
export function derivePackageStanding(facts: StandingFacts): PackageStanding {
  const { installed } = facts;
  const current = installed.current;
  const versions = facts.retained.slice(0, STANDING_LIMITS.versions).map(({ version, trust }) => {
    const standing = standingOfTrust(trust);
    return {
      identityDigest: version.identityDigest,
      packageVersion: version.identity.packageVersion,
      current: current?.identityDigest === version.identityDigest,
      state: standing.state,
      reason: standing.reason,
      eligible: standing.state === "eligible",
      byteLength: version.byteLength,
      fileCount: version.fileCount,
    } satisfies VersionStanding;
  });
  const dependencies = facts.dependencies.slice(0, STANDING_LIMITS.dependencies).map((entry) => {
    const standing = standingOfTrust(entry.trust);
    return {
      id: entry.id,
      digest: entry.digest,
      state: standing.state,
      reason: standing.reason,
      eligible: standing.state === "eligible",
    } satisfies DependencyStanding;
  });
  const truncated =
    facts.retained.length > STANDING_LIMITS.versions ||
    facts.dependencies.length > STANDING_LIMITS.dependencies;
  const base = {
    version: 1 as const,
    packageId: installed.packageId,
    revision: installed.revision,
    identityDigest: current?.identityDigest ?? null,
    packageVersion: current?.identity.packageVersion ?? null,
    decision: facts.trust?.decisionStatus ?? null,
    advisory: facts.trust?.evidence.advisory ?? null,
    dependencies,
    versions,
    truncated,
  };
  if (current === null)
    return {
      ...base,
      state: "not-installed",
      reason: null,
      lastKnownGood: null,
      recovery: recoveryFor("not-installed", null, []),
    };
  const own = standingOfTrust(facts.trust);
  const blocked = dependencies.find((entry) => !entry.eligible);
  const state: StandingState =
    own.state === "eligible" && blocked !== undefined ? "dependency-blocked" : own.state;
  const reason: StandingReason | null =
    state === "dependency-blocked" ? "dependency-not-eligible" : own.reason;
  const targets = versions.filter((entry) => !entry.current);
  const good = targets.find((entry) => entry.eligible)?.identityDigest ?? null;
  return {
    ...base,
    state,
    reason,
    lastKnownGood: good,
    recovery: recoveryFor(
      state,
      facts.trust,
      targets.map((entry) => entry.identityDigest),
    ).slice(0, STANDING_LIMITS.recovery),
  };
}
