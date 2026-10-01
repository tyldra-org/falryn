import { expect, test } from "bun:test";
import type { InstalledPackage, InstalledVersion } from "../extensions/lifecycle.ts";
import {
  evaluateTrust,
  type TrustDecision,
  type TrustObservation,
  type TrustProjection,
} from "./ecosystem-trust.ts";
import { derivePackageStanding, STANDING_LIMITS, standingOfTrust } from "./package-standing.ts";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
function version(n: number, packageVersion = `1.${n}.0`): InstalledVersion {
  return {
    identity: {
      packageId: "fixture",
      packageVersion,
      packageDigest: digest(n),
    } as unknown as InstalledVersion["identity"],
    identityDigest: digest(n),
    sourceId: "source",
    ownership: { sourceOwner: null, publisher: null },
    dependencies: [],
    byteLength: 100 + n,
    fileCount: n,
    storageId: "00000000-0000-4000-8000-000000000000",
    state: "retained",
  };
}
function observation(overrides: Partial<TrustObservation> = {}): TrustObservation {
  return {
    subject: { identity: version(1).identity, ownership: { sourceOwner: null, publisher: null } },
    evidence: {
      integrity: "computed",
      signature: "unavailable",
      curation: "unavailable",
      advisory: "unavailable",
      observedAt: 0,
      expiresAt: null,
      reference: digest(1),
    },
    policyGeneration: 1,
    scope: { kind: "user", authority: digest(9) },
    actor: digest(9),
    now: 1_000,
    compatibility: "compatible",
    health: "unknown",
    availability: "unavailable",
    online: false,
    ...overrides,
  };
}
function projection(
  action: TrustDecision["action"] | null,
  overrides: Partial<TrustObservation> = {},
): TrustProjection {
  const seen = observation(overrides);
  const decision =
    action === null
      ? null
      : ({
          version: 1,
          subject: seen.subject,
          evidence: seen.evidence,
          policyGeneration: seen.policyGeneration,
          actor: seen.actor,
          scope: seen.scope,
          contributions: [],
          revision: 1,
          action,
          decidedAt: 500,
          expiresAt: action === "approve" ? 5_000 : null,
        } satisfies TrustDecision);
  return evaluateTrust(seen, decision);
}
const installed = (current: InstalledVersion | null): InstalledPackage => ({
  packageId: "fixture",
  revision: 3,
  current,
});

test("each trust projection maps to one standing and its shared reason", () => {
  expect(standingOfTrust(projection("approve"))).toEqual({ state: "eligible", reason: null });
  expect(standingOfTrust(projection(null))).toEqual({
    state: "unapproved",
    reason: "ecosystem-trust-required",
  });
  expect(standingOfTrust(projection("revoke")).state).toBe("revoked");
  expect(standingOfTrust(projection("quarantine")).state).toBe("quarantined");
  expect(standingOfTrust(projection("release")).state).toBe("unapproved");
  expect(standingOfTrust(projection("approve", { now: 6_000 })).state).toBe("expired");
  expect(standingOfTrust(projection(null, { compatibility: "incompatible" })).state).toBe(
    "incompatible",
  );
  expect(standingOfTrust(null).state).toBe("unapproved");
});

test("a package that is not installed offers only inspection", () => {
  expect(
    derivePackageStanding({
      installed: installed(null),
      trust: null,
      retained: [],
      dependencies: [],
    }),
  ).toMatchObject({
    state: "not-installed",
    recovery: [{ choice: "inspect" }],
    lastKnownGood: null,
  });
});

test("a decision-made quarantine is released by decision and an advisory one by new evidence", () => {
  const decided = derivePackageStanding({
    installed: installed(version(2)),
    trust: projection("quarantine"),
    retained: [],
    dependencies: [],
  });
  expect(decided.recovery.map((entry) => entry.choice)).toContain("release");
  const advisory = derivePackageStanding({
    installed: installed(version(2)),
    trust: projection(null, {
      evidence: { ...observation().evidence, advisory: "quarantined" },
    }),
    retained: [],
    dependencies: [],
  });
  expect(advisory.state).toBe("quarantined");
  expect(advisory.recovery.map((entry) => entry.choice)).toContain("refresh-evidence");
  expect(advisory.recovery.map((entry) => entry.choice)).not.toContain("release");
});

test("an advisory revocation is lifted only by evidence and a user's own can be reapproved", () => {
  const advisory = derivePackageStanding({
    installed: installed(version(2)),
    trust: projection(null, { evidence: { ...observation().evidence, advisory: "revoked" } }),
    retained: [],
    dependencies: [],
  });
  expect(advisory.recovery.map((entry) => entry.choice)).toEqual([
    "inspect",
    "refresh-evidence",
    "update",
    "uninstall",
  ]);
  const own = derivePackageStanding({
    installed: installed(version(2)),
    trust: projection("revoke"),
    retained: [],
    dependencies: [],
  });
  expect(own.recovery.map((entry) => entry.choice)).toContain("approve");
});

test("the last known good is the newest retained non-current version that is itself eligible", () => {
  const standing = derivePackageStanding({
    installed: installed(version(3)),
    trust: projection("revoke"),
    retained: [
      { version: version(3), trust: projection("revoke") },
      { version: version(2), trust: projection("revoke") },
      { version: version(1), trust: projection("approve") },
    ],
    dependencies: [],
  });
  expect(standing.lastKnownGood).toBe(digest(1));
  expect(
    standing.versions.map((entry) => [entry.packageVersion, entry.current, entry.state]),
  ).toEqual([
    ["1.3.0", true, "revoked"],
    ["1.2.0", false, "revoked"],
    ["1.1.0", false, "eligible"],
  ]);
  // Both retained non-current versions are offered; the revoked one is listed with its own state.
  expect(standing.recovery.filter((entry) => entry.choice === "rollback")).toEqual([
    { choice: "rollback", versionDigest: digest(2) },
    { choice: "rollback", versionDigest: digest(1) },
  ]);
});

test("an ineligible, missing or changed dependency blocks an otherwise eligible package", () => {
  const eligible = projection("approve");
  const blocked = (dependency: TrustProjection | null) =>
    derivePackageStanding({
      installed: installed(version(2)),
      trust: eligible,
      retained: [],
      dependencies: [{ id: "base", digest: digest(7), trust: dependency }],
    });
  expect(blocked(eligible)).toMatchObject({ state: "eligible", reason: null });
  for (const dependency of [null, projection("revoke"), projection("quarantine")])
    expect(blocked(dependency)).toMatchObject({
      state: "dependency-blocked",
      reason: "dependency-not-eligible",
    });
  // A package that is itself revoked reports that, not its dependency.
  expect(
    derivePackageStanding({
      installed: installed(version(2)),
      trust: projection("revoke"),
      retained: [],
      dependencies: [{ id: "base", digest: digest(7), trust: null }],
    }).state,
  ).toBe("revoked");
});

test("lists are bounded and say when they were cut", () => {
  const many = Array.from({ length: STANDING_LIMITS.versions + 5 }, (_, n) => ({
    version: version(n + 10),
    trust: projection("approve"),
  }));
  const standing = derivePackageStanding({
    installed: installed(version(10)),
    trust: projection("approve"),
    retained: many,
    dependencies: [],
  });
  expect(standing.versions).toHaveLength(STANDING_LIMITS.versions);
  expect(standing.truncated).toBe(true);
});
