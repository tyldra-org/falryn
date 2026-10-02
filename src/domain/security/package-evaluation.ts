/**
 * Package evaluation evidence (#168). A report records what an evaluator observed against one
 * versioned rubric; a curator statement signs one report. Neither is an approval, a grant, an
 * installation or an execution permission: trust eligibility stays with the user's own decision.
 */
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "../extensions/canonical.ts";
import { digestSchema, identityText, packageIdentityV1Schema } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";

export const PACKAGE_RUBRIC = "falryn.package-rubric.v1";
export const PACKAGE_EVALUATION_REPORT = "falryn.package-evaluation.v1";
export const PACKAGE_CURATION_STATEMENT = "falryn.package-curation.v1";

/** Rubric order is part of the contract: a report lists every criterion exactly once, in this order. */
export const EVALUATION_CRITERIA = [
  "provenance",
  "ownership",
  "integrity",
  "effects",
  "privacy",
  "security",
  "compatibility",
  "maintenance",
  "documentation",
  "tests",
  "accessibility",
  "resources",
  "quality",
] as const;
export type EvaluationCriterion = (typeof EVALUATION_CRITERIA)[number];
export const CRITERION_OUTCOMES = ["pass", "fail", "inconclusive", "not-applicable"] as const;
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];
export const CRITERION_BASES = ["observed", "curator", "behavioral-report"] as const;
export type CriterionBasis = (typeof CRITERION_BASES)[number];

type CodeRule = {
  readonly basis: CriterionBasis;
  readonly outcomes: readonly CriterionOutcome[];
  /** Observed codes belong to one criterion; review codes apply to any. */
  readonly criteria: readonly EvaluationCriterion[] | "any";
};
/**
 * Every code names one basis and the outcomes it can carry, so a report cannot say
 * "signature-invalid" and "pass" together or claim an observation it could not have made.
 */
export const CRITERION_CODES = {
  "signature-verified": { basis: "observed", outcomes: ["pass"], criteria: ["provenance"] },
  "signature-unavailable": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["provenance"],
  },
  "signature-invalid": { basis: "observed", outcomes: ["fail"], criteria: ["provenance"] },
  "publisher-verified": { basis: "observed", outcomes: ["pass"], criteria: ["ownership"] },
  "publisher-unverified": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["ownership"],
  },
  "bytes-match": { basis: "observed", outcomes: ["pass"], criteria: ["integrity"] },
  "bytes-unverifiable": { basis: "observed", outcomes: ["fail"], criteria: ["integrity"] },
  "native-enforced": { basis: "observed", outcomes: ["pass"], criteria: ["effects"] },
  "native-failed": { basis: "observed", outcomes: ["fail"], criteria: ["effects"] },
  "native-uncertain": { basis: "observed", outcomes: ["inconclusive"], criteria: ["effects"] },
  "native-unobserved": { basis: "observed", outcomes: ["inconclusive"], criteria: ["effects"] },
  "enforcement-unavailable": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["effects"],
  },
  "full-user-opaque": { basis: "observed", outcomes: ["inconclusive"], criteria: ["effects"] },
  "declarative-only": { basis: "observed", outcomes: ["not-applicable"], criteria: ["effects"] },
  "advisory-clear": { basis: "observed", outcomes: ["pass"], criteria: ["security"] },
  "advisory-unavailable": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["security"],
  },
  "standing-blocked": { basis: "observed", outcomes: ["fail"], criteria: ["security"] },
  "host-compatible": { basis: "observed", outcomes: ["pass"], criteria: ["compatibility"] },
  "host-incompatible": { basis: "observed", outcomes: ["fail"], criteria: ["compatibility"] },
  "host-compatibility-unknown": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["compatibility"],
  },
  "curator-review-required": { basis: "observed", outcomes: ["inconclusive"], criteria: "any" },
  "behavioral-report-unavailable": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["tests"],
  },
  "resource-measurement-unavailable": {
    basis: "observed",
    outcomes: ["inconclusive"],
    criteria: ["resources"],
  },
  "curator-reviewed": {
    basis: "curator",
    outcomes: ["pass", "fail", "inconclusive", "not-applicable"],
    criteria: "any",
  },
  "behavioral-report-passed": { basis: "behavioral-report", outcomes: ["pass"], criteria: "any" },
  "behavioral-report-failed": { basis: "behavioral-report", outcomes: ["fail"], criteria: "any" },
  "behavioral-report-inconclusive": {
    basis: "behavioral-report",
    outcomes: ["inconclusive"],
    criteria: "any",
  },
} as const satisfies Record<string, CodeRule>;
export type CriterionCode = keyof typeof CRITERION_CODES;
const CODES = Object.keys(CRITERION_CODES) as [CriterionCode, ...CriterionCode[]];

export const EVALUATION_LIMITATIONS = [
  "behavioral-report-unavailable",
  "curator-review-required",
  "full-user-effects-opaque",
  "observations-truncated",
  "resource-measurement-unavailable",
  "sandbox-unavailable",
] as const;
export const EVALUATION_DECISIONS = ["eligible", "not-eligible", "inconclusive"] as const;
export type EvaluationDecision = (typeof EVALUATION_DECISIONS)[number];
export const EVALUATION_LIMITS = {
  observations: 64,
  contributionKinds: 32,
  reportBytes: 32_768,
  historyPerIdentity: 32,
  historyTotal: 1_024,
  historySummaries: 8,
  curationLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

const time = z.int().nonnegative();
export const criterionResultSchema = z.strictObject({
  criterion: z.enum(EVALUATION_CRITERIA),
  outcome: z.enum(CRITERION_OUTCOMES),
  basis: z.enum(CRITERION_BASES),
  code: z.enum(CODES),
});
export type CriterionResult = z.infer<typeof criterionResultSchema>;
/** One native attempt as observed for the exact identity. Paths, input and output never appear. */
export const evaluationObservationSchema = z.strictObject({
  contribution: digestSchema,
  mode: z.enum(["governed", "full-user"]),
  state: z.enum([
    "unobserved",
    "starting",
    "running",
    "healthy",
    "completed",
    "failed",
    "uncertain",
    "recovered",
  ]),
  code: identityText.nullable(),
  enforcement: z.enum(["strict", "off", "unavailable"]),
});
export type EvaluationObservation = z.infer<typeof evaluationObservationSchema>;

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

/** The decision a set of criterion results supports. Nothing else may decide it. */
export function deriveEvaluationDecision(
  criteria: readonly Pick<CriterionResult, "outcome">[],
): EvaluationDecision {
  if (criteria.some((entry) => entry.outcome === "fail")) return "not-eligible";
  if (criteria.some((entry) => entry.outcome === "inconclusive")) return "inconclusive";
  return "eligible";
}

export const packageEvaluationReportSchema = z
  .strictObject({
    type: z.literal(PACKAGE_EVALUATION_REPORT),
    rubric: z.literal(PACKAGE_RUBRIC),
    subject: packageIdentityV1Schema,
    evaluator: z.strictObject({
      kind: z.enum(["local", "curator"]),
      falryn: identityText,
      os: identityText,
      arch: identityText,
    }),
    contributionKinds: z.array(identityText).max(EVALUATION_LIMITS.contributionKinds),
    criteria: z.array(criterionResultSchema).length(EVALUATION_CRITERIA.length),
    observations: z.array(evaluationObservationSchema).max(EVALUATION_LIMITS.observations),
    omittedObservations: z.int().nonnegative(),
    /** A #1092 behavioral report this evaluation relied on, by digest; null when none exists. */
    behavioralReport: digestSchema.nullable(),
    limitations: z.array(z.enum(EVALUATION_LIMITATIONS)).max(EVALUATION_LIMITATIONS.length),
    decision: z.enum(EVALUATION_DECISIONS),
    evaluatedAt: time,
  })
  .superRefine((report, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    report.criteria.forEach((entry, index) => {
      if (entry.criterion !== EVALUATION_CRITERIA[index]) fail("criteria-out-of-rubric-order");
      const rule: CodeRule = CRITERION_CODES[entry.code];
      if (rule.basis !== entry.basis) fail("criterion-basis-mismatch");
      if (!rule.outcomes.includes(entry.outcome)) fail("criterion-outcome-mismatch");
      if (rule.criteria !== "any" && !rule.criteria.includes(entry.criterion))
        fail("criterion-code-mismatch");
      if (entry.basis === "curator" && report.evaluator.kind !== "curator")
        fail("curator-basis-without-curator");
      if (entry.basis === "behavioral-report" && report.behavioralReport === null)
        fail("behavioral-basis-without-report");
    });
    if (!sortedUnique(report.contributionKinds)) fail("contribution-kinds-not-canonical");
    if (!sortedUnique(report.limitations)) fail("limitations-not-canonical");
    if (report.decision !== deriveEvaluationDecision(report.criteria)) fail("decision-mismatch");
    if (report.omittedObservations > 0 && !report.limitations.includes("observations-truncated"))
      fail("truncation-not-disclosed");
    if (new TextEncoder().encode(canonicalJson(report)).length > EVALUATION_LIMITS.reportBytes)
      fail("report-too-large");
  });
export type PackageEvaluationReport = z.infer<typeof packageEvaluationReportSchema>;

/** Identifies the facts of a report. The evaluation time is excluded so an unchanged repeat is one record. */
export function evaluationReportDigest(report: PackageEvaluationReport): string {
  return canonicalDigest({ ...report, evaluatedAt: 0 });
}

export const curationStatementSchema = z.strictObject({
  type: z.literal(PACKAGE_CURATION_STATEMENT),
  subject: packageIdentityV1Schema,
  decision: z.enum(["curated", "declined"]),
  report: packageEvaluationReportSchema,
  issuedAt: time,
  expiresAt: time,
});
export type CurationStatement = z.infer<typeof curationStatementSchema>;

/** Why curation evidence is or is not verified; recorded with provenance, never a trust state. */
export const CURATION_STATUSES = [
  "verified",
  "declined",
  "ineligible-report",
  "subject-mismatch",
  "invalid",
] as const;
export type CurationStatus = (typeof CURATION_STATUSES)[number];

/**
 * The curation status of a statement whose signature, key role and lifetime were already checked
 * by the caller (`signed`). Only `verified` lets trust evidence say curation is verified.
 */
export function curationStatus(
  statement: CurationStatement,
  identityDigest: string,
  signed: boolean,
): CurationStatus {
  if (!signed) return "invalid";
  if (
    canonicalDigest(statement.subject) !== identityDigest ||
    canonicalDigest(statement.report.subject) !== identityDigest
  )
    return "subject-mismatch";
  if (statement.decision === "declined") return "declined";
  if (
    statement.report.evaluator.kind !== "curator" ||
    statement.report.decision !== "eligible" ||
    statement.report.evaluatedAt > statement.issuedAt
  )
    return "ineligible-report";
  return "verified";
}

export const evaluationRecordSchema = z
  .strictObject({
    version: z.literal(1),
    packageId: identityText,
    identityDigest: digestSchema,
    reportDigest: digestSchema,
    report: packageEvaluationReportSchema,
    /** Present when a curator statement carried this report through a trust refresh. */
    curation: z
      .strictObject({
        keyId: digestSchema,
        statementDigest: digestSchema,
        decision: z.enum(["curated", "declined"]),
        status: z.enum(CURATION_STATUSES),
        issuedAt: time,
        expiresAt: time,
      })
      .nullable(),
    recordedAt: time,
  })
  .refine(
    (record) =>
      record.packageId === record.report.subject.packageId &&
      record.identityDigest === canonicalDigest(record.report.subject) &&
      record.reportDigest === evaluationReportDigest(record.report),
  );
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;

export type EvaluationStoreError = {
  readonly code: "malformed" | "unavailable" | "cancelled" | "uncertain";
};
export interface EvaluationStore {
  /**
   * Retain one record. An identical identity and report digest keeps the existing record; the
   * oldest records beyond the per-identity and total limits are dropped in the same transaction.
   */
  append(
    record: EvaluationRecord,
    signal?: AbortSignal,
  ): Result<{ readonly added: boolean }, EvaluationStoreError>;
  /** Newest first, at most `limit`, for every identity this package ID has had. */
  history(
    packageId: string,
    limit: number,
  ): Result<readonly EvaluationRecord[], EvaluationStoreError>;
}
