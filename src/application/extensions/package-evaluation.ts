import type {
  InstalledVersion,
  PackageBytes,
  PackageLifecycleStore,
} from "../../domain/extensions/lifecycle.ts";
import type { PackageHealthStore } from "../../domain/extensions/package-health.ts";
import type { TrustProjection } from "../../domain/security/ecosystem-trust.ts";
import {
  CRITERION_CODES,
  type CriterionCode,
  type CriterionResult,
  type CurationStatus,
  deriveEvaluationDecision,
  EVALUATION_CRITERIA,
  EVALUATION_LIMITS,
  type EvaluationCriterion,
  type EvaluationDecision,
  type EvaluationObservation,
  type EvaluationStore,
  evaluationRecordSchema,
  evaluationReportDigest,
  type PackageEvaluationReport,
  packageEvaluationReportSchema,
} from "../../domain/security/package-evaluation.ts";
import type { PackageStanding } from "../../domain/security/package-standing.ts";
import { type InspectionHost, type PreparedPackage, preparePackage } from "./prepare-package.ts";

/** What `package evaluate` reads. Every port is a read except the one history append. */
export type PackageEvaluationOwners = {
  readonly packages: Pick<PackageLifecycleStore, "current">;
  readonly bytes: Pick<PackageBytes, "read">;
  readonly host: InspectionHost;
  /** The shared trust projection of one installed version; `null` when its facts are unreadable. */
  readonly trust: (version: InstalledVersion) => TrustProjection | null;
  readonly standing: (packageId: string) => { ok: true; value: PackageStanding } | { ok: false };
  readonly health: Pick<PackageHealthStore, "latestPerContribution">;
  readonly evaluations: EvaluationStore;
  readonly now: () => number;
};

export type EvaluationHistoryEntry = {
  readonly identityDigest: string;
  readonly packageVersion: string | null;
  readonly reportDigest: string;
  readonly evaluator: "local" | "curator";
  readonly decision: EvaluationDecision;
  readonly curation: CurationStatus | null;
  readonly recordedAt: number;
  /** Evidence about another identity of this package: it says nothing about the current bytes. */
  readonly stale: boolean;
};
export type PackageEvaluationResult =
  | { readonly status: "failed"; readonly code: string }
  | {
      readonly status: "completed";
      readonly report: PackageEvaluationReport;
      readonly reportDigest: string;
      /** False when an identical report for this identity was already retained. */
      readonly recorded: boolean;
      readonly history: readonly EvaluationHistoryEntry[];
    };

const BLOCKING_STANDING = new Set(["quarantined", "revoked"]);
const SETTLED = new Set(["healthy", "completed"]);

function result(criterion: EvaluationCriterion, code: CriterionCode): CriterionResult {
  const rule = CRITERION_CODES[code];
  return { criterion, outcome: rule.outcomes[0], basis: rule.basis, code };
}

/**
 * The effects criterion from what native execution actually did for this exact identity. A failed
 * attempt is preserved, never averaged away; an attempt that completed without strict enforcement
 * proves nothing about undeclared effects.
 */
function effects(
  observations: readonly EvaluationObservation[],
  executable: number,
): CriterionCode {
  if (executable === 0) return "declarative-only";
  if (observations.some((entry) => entry.state === "failed")) return "native-failed";
  if (observations.some((entry) => entry.mode === "full-user")) return "full-user-opaque";
  if (observations.some((entry) => !SETTLED.has(entry.state) && entry.state !== "unobserved"))
    return "native-uncertain";
  if (observations.some((entry) => entry.state === "unobserved")) return "native-unobserved";
  if (observations.some((entry) => entry.enforcement !== "strict"))
    return "enforcement-unavailable";
  return "native-enforced";
}

/**
 * Evaluate the current installed version against the rubric (#168). It reads installed records
 * and retained native attempts only: it never runs package code, downloads, approves, enables or
 * installs. Criteria Falryn cannot observe stay inconclusive, so a local report is never eligible.
 */
export async function evaluateInstalledPackage(
  owners: PackageEvaluationOwners,
  packageId: string,
  signal: AbortSignal,
): Promise<PackageEvaluationResult> {
  if (signal.aborted) return { status: "failed", code: "cancelled" };
  const installed = owners.packages.current(packageId);
  if (!installed.ok) return { status: "failed", code: "package-store-unavailable" };
  const version = installed.value.current;
  if (version === null) return { status: "failed", code: "not-installed" };

  let prepared: PreparedPackage | null = null;
  try {
    const snapshot = await owners.bytes.read(version, signal);
    const preparation = await preparePackage({ read: async () => snapshot }, owners.host, {
      candidates: version.dependencies,
      signal,
    });
    if (preparation.ok && preparation.package.identityDigest === version.identityDigest)
      prepared = preparation.package;
  } catch {
    // Unreadable or changed bytes are the integrity finding itself, unless the caller cancelled.
  }
  if (signal.aborted) return { status: "failed", code: "cancelled" };

  const trust = owners.trust(version);
  if (trust === null) return { status: "failed", code: "trust-unavailable" };
  const standing = owners.standing(packageId);
  if (!standing.ok) return { status: "failed", code: "trust-unavailable" };
  const attempts = owners.health.latestPerContribution(packageId, version.identityDigest);
  if (!attempts.ok) return { status: "failed", code: "health-store-unavailable" };

  const executable = (prepared?.contributions ?? [])
    .filter((entry) => entry.mode !== "declarative")
    .sort((a, b) => (a.identityDigest < b.identityDigest ? -1 : 1));
  const allObservations: EvaluationObservation[] = executable.map((contribution) => {
    const attempt = attempts.value.find(
      (record) => record.result.binding.contribution === contribution.identityDigest,
    );
    const mode = contribution.mode === "full-user" ? "full-user" : "governed";
    if (attempt === undefined)
      return {
        contribution: contribution.identityDigest,
        mode,
        state: "unobserved",
        code: null,
        enforcement: "unavailable",
      };
    const sandbox = attempt.result.sandbox;
    return {
      contribution: contribution.identityDigest,
      mode,
      state: attempt.result.state,
      code: attempt.result.code,
      enforcement:
        sandbox?.effectiveMode === "strict"
          ? "strict"
          : sandbox?.effectiveMode === "off"
            ? "off"
            : "unavailable",
    };
  });
  const observations = allObservations.slice(0, EVALUATION_LIMITS.observations);
  const omittedObservations = allObservations.length - observations.length;

  const evidence = trust.evidence;
  const signature: CriterionCode =
    evidence.signature === "verified"
      ? "signature-verified"
      : evidence.signature === "invalid" || evidence.signature === "conflicting"
        ? "signature-invalid"
        : "signature-unavailable";
  const blocked =
    BLOCKING_STANDING.has(standing.value.state) ||
    evidence.advisory === "revoked" ||
    evidence.advisory === "quarantined";
  const codes: Record<EvaluationCriterion, CriterionCode> = {
    provenance: signature,
    ownership:
      evidence.signature === "verified" && trust.subject.ownership.publisher !== null
        ? "publisher-verified"
        : "publisher-unverified",
    integrity: prepared === null ? "bytes-unverifiable" : "bytes-match",
    effects: prepared === null ? "native-unobserved" : effects(allObservations, executable.length),
    privacy: "curator-review-required",
    security: blocked
      ? "standing-blocked"
      : evidence.advisory === "clear"
        ? "advisory-clear"
        : "advisory-unavailable",
    compatibility:
      prepared === null
        ? "host-compatibility-unknown"
        : prepared.compatibility === "compatible" && standing.value.state !== "incompatible"
          ? "host-compatible"
          : "host-incompatible",
    maintenance: "curator-review-required",
    documentation: "curator-review-required",
    tests: "behavioral-report-unavailable",
    accessibility: "curator-review-required",
    resources: "resource-measurement-unavailable",
    quality: "curator-review-required",
  };
  const criteria = EVALUATION_CRITERIA.map((criterion) => result(criterion, codes[criterion]));
  const limitations = new Set<PackageEvaluationReport["limitations"][number]>([
    "behavioral-report-unavailable",
    "curator-review-required",
    "resource-measurement-unavailable",
  ]);
  if (executable.some((entry) => entry.mode === "full-user"))
    limitations.add("full-user-effects-opaque");
  if (omittedObservations > 0) limitations.add("observations-truncated");
  if (observations.some((entry) => entry.state !== "unobserved" && entry.enforcement !== "strict"))
    limitations.add("sandbox-unavailable");
  const parsed = packageEvaluationReportSchema.safeParse({
    type: "falryn.package-evaluation.v1",
    rubric: "falryn.package-rubric.v1",
    subject: version.identity,
    evaluator: {
      kind: "local",
      falryn: owners.host.falryn,
      os: owners.host.os,
      arch: owners.host.arch,
    },
    contributionKinds: [
      ...new Set((prepared?.contributions ?? []).map((entry) => entry.identity.nativeKind)),
    ]
      .sort()
      .slice(0, EVALUATION_LIMITS.contributionKinds),
    criteria,
    observations,
    omittedObservations,
    behavioralReport: null,
    limitations: [...limitations].sort(),
    decision: deriveEvaluationDecision(criteria),
    evaluatedAt: owners.now(),
  });
  if (!parsed.success) return { status: "failed", code: "evaluation-report-invalid" };
  const report = parsed.data;
  const reportDigest = evaluationReportDigest(report);
  const record = evaluationRecordSchema.safeParse({
    version: 1,
    packageId,
    identityDigest: version.identityDigest,
    reportDigest,
    report,
    curation: null,
    recordedAt: report.evaluatedAt,
  });
  if (!record.success) return { status: "failed", code: "evaluation-report-invalid" };
  // Nothing is written once the caller has given up.
  if (signal.aborted) return { status: "failed", code: "cancelled" };
  const appended = owners.evaluations.append(record.data, signal);
  if (!appended.ok)
    return {
      status: "failed",
      code:
        appended.error.code === "malformed" ? "evaluation-store-malformed" : appended.error.code,
    };
  const history = owners.evaluations.history(packageId, EVALUATION_LIMITS.historySummaries);
  if (!history.ok)
    return {
      status: "failed",
      code:
        history.error.code === "malformed"
          ? "evaluation-store-malformed"
          : "package-store-unavailable",
    };
  return {
    status: "completed",
    report,
    reportDigest,
    recorded: appended.value.added,
    history: history.value.map((entry) => ({
      identityDigest: entry.identityDigest,
      packageVersion: entry.report.subject.packageVersion,
      reportDigest: entry.reportDigest,
      evaluator: entry.report.evaluator.kind,
      decision: entry.report.decision,
      curation: entry.curation?.status ?? null,
      recordedAt: entry.recordedAt,
      stale: entry.identityDigest !== version.identityDigest,
    })),
  };
}
