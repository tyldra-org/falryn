import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest } from "../extensions/canonical.ts";
import type { PackageIdentityV1 } from "../extensions/identity.ts";
import {
  CRITERION_CODES,
  type CriterionCode,
  type CurationStatement,
  curationStatus,
  deriveEvaluationDecision,
  EVALUATION_CRITERIA,
  type EvaluationCriterion,
  evaluationRecordSchema,
  evaluationReportDigest,
  type PackageEvaluationReport,
  packageEvaluationReportSchema,
} from "./package-evaluation.ts";

const subject: PackageIdentityV1 = {
  version: 1,
  packageId: "fixture",
  packageVersion: "1.0.0",
  sourceCoordinate: {
    kind: "local",
    rootId: "root",
    path: "fixture",
    sourceDigest: bytesDigest("source"),
  },
  packageDigest: bytesDigest("package"),
  manifestDigest: bytesDigest("manifest"),
};
const other: PackageIdentityV1 = { ...subject, packageDigest: bytesDigest("changed bytes") };

function report(
  codes: Partial<Record<EvaluationCriterion, CriterionCode>> = {},
  extra: Partial<PackageEvaluationReport> = {},
): PackageEvaluationReport {
  const criteria = EVALUATION_CRITERIA.map((criterion) => {
    const code = codes[criterion] ?? "curator-reviewed";
    const rule = CRITERION_CODES[code];
    return { criterion, outcome: rule.outcomes[0], basis: rule.basis, code };
  });
  return {
    type: "falryn.package-evaluation.v1",
    rubric: "falryn.package-rubric.v1",
    subject,
    evaluator: { kind: "curator", falryn: "0.0.0", os: "darwin", arch: "arm64" },
    contributionKinds: ["tool"],
    criteria,
    observations: [],
    omittedObservations: 0,
    behavioralReport: null,
    limitations: [],
    decision: deriveEvaluationDecision(criteria),
    evaluatedAt: 100,
    ...extra,
  };
}
function statement(extra: Partial<CurationStatement> = {}): CurationStatement {
  return {
    type: "falryn.package-curation.v1",
    subject,
    decision: "curated",
    report: report(),
    issuedAt: 200,
    expiresAt: 300,
    ...extra,
  };
}

describe("the rubric decision", () => {
  test("is derived from the results: a failure dominates, then any open criterion", () => {
    expect(deriveEvaluationDecision([{ outcome: "pass" }, { outcome: "not-applicable" }])).toBe(
      "eligible",
    );
    expect(deriveEvaluationDecision([{ outcome: "pass" }, { outcome: "inconclusive" }])).toBe(
      "inconclusive",
    );
    expect(deriveEvaluationDecision([{ outcome: "inconclusive" }, { outcome: "fail" }])).toBe(
      "not-eligible",
    );
  });

  test("a report cannot assert a decision, an outcome or a basis its codes do not support", () => {
    expect(packageEvaluationReportSchema.safeParse(report()).success).toBe(true);
    const invalid: unknown[] = [
      {
        ...report(),
        decision: "eligible",
        criteria: report({ tests: "behavioral-report-unavailable" }).criteria,
      },
      {
        ...report(),
        criteria: report().criteria.map((entry, index) =>
          index === 0 ? { ...entry, code: "signature-invalid" } : entry,
        ),
      },
      { ...report(), criteria: [...report().criteria].reverse() },
      { ...report(), evaluator: { ...report().evaluator, kind: "local" } },
      report({ tests: "behavioral-report-passed" }),
      report({ effects: "signature-verified" }),
      report({}, { omittedObservations: 1 }),
      report({}, { contributionKinds: ["tool", "skill"] }),
      { ...report(), extra: true },
    ];
    for (const value of invalid)
      expect(packageEvaluationReportSchema.safeParse(value).success).toBe(false);
    // A behavioral basis needs the behavioral report it relied on.
    expect(
      packageEvaluationReportSchema.safeParse(
        report({ tests: "behavioral-report-passed" }, { behavioralReport: bytesDigest("suite") }),
      ).success,
    ).toBe(true);
  });

  test("the report digest names its facts, not when they were observed", () => {
    expect(evaluationReportDigest(report({}, { evaluatedAt: 1 }))).toBe(
      evaluationReportDigest(report({}, { evaluatedAt: 2 })),
    );
    expect(evaluationReportDigest(report())).not.toBe(
      evaluationReportDigest(report({ quality: "curator-review-required" })),
    );
  });

  test("a report is bounded in bytes, not only in entries", () => {
    const padded = (prefix: string) => prefix + "x".repeat(256 - prefix.length);
    const observations = Array.from({ length: 64 }, (_, index) => ({
      contribution: bytesDigest(`tool ${index}`),
      mode: "governed" as const,
      state: "failed" as const,
      code: padded(`code-${index}-`),
      enforcement: "strict" as const,
    }));
    const contributionKinds = Array.from({ length: 32 }, (_, index) =>
      padded(`kind-${String(index).padStart(2, "0")}-`),
    );
    expect(packageEvaluationReportSchema.safeParse(report({}, { observations })).success).toBe(
      true,
    );
    expect(
      packageEvaluationReportSchema.safeParse(report({}, { observations, contributionKinds }))
        .success,
    ).toBe(false);
  });

  test("a history record must agree with the report it carries", () => {
    const value = report();
    const record = {
      version: 1,
      packageId: "fixture",
      identityDigest: canonicalDigest(subject),
      reportDigest: evaluationReportDigest(value),
      report: value,
      curation: null,
      recordedAt: 1,
    };
    expect(evaluationRecordSchema.safeParse(record).success).toBe(true);
    expect(
      evaluationRecordSchema.safeParse({ ...record, identityDigest: canonicalDigest(other) })
        .success,
    ).toBe(false);
    expect(evaluationRecordSchema.safeParse({ ...record, packageId: "other" }).success).toBe(false);
  });
});

describe("curation status", () => {
  const identity = canonicalDigest(subject);
  test("only an authentic curated statement over an eligible curator report for these exact bytes verifies", () => {
    expect(curationStatus(statement(), identity, true)).toBe("verified");
    expect(curationStatus(statement(), identity, false)).toBe("invalid");
    expect(curationStatus(statement({ subject: other }), identity, true)).toBe("subject-mismatch");
    expect(
      curationStatus(statement({ report: report({}, { subject: other }) }), identity, true),
    ).toBe("subject-mismatch");
    expect(curationStatus(statement({ decision: "declined" }), identity, true)).toBe("declined");
    expect(
      curationStatus(
        statement({ report: report({ tests: "behavioral-report-unavailable" }) }),
        identity,
        true,
      ),
    ).toBe("ineligible-report");
    expect(
      curationStatus(statement({ report: report({ effects: "native-failed" }) }), identity, true),
    ).toBe("ineligible-report");
    expect(
      curationStatus(statement({ report: report({}, { evaluatedAt: 201 }) }), identity, true),
    ).toBe("ineligible-report");
  });
});
