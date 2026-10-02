/** Human projection of a `package evaluate` receipt: the same facts the JSON receipt carries. */

import { z } from "zod";
import { safe } from "./text.ts";

const dataSchema = z.looseObject({
  evaluation: z.looseObject({
    reportDigest: z.string(),
    recorded: z.boolean(),
    report: z.looseObject({
      rubric: z.string(),
      decision: z.string(),
      evaluator: z.looseObject({ kind: z.string() }),
      criteria: z.array(
        z.looseObject({ criterion: z.string(), outcome: z.string(), code: z.string() }),
      ),
      observations: z.array(
        z.looseObject({
          contribution: z.string(),
          mode: z.string(),
          state: z.string(),
          code: z.string().nullable(),
          enforcement: z.string(),
        }),
      ),
      omittedObservations: z.number(),
      limitations: z.array(z.string()),
    }),
    history: z.array(
      z.looseObject({
        identityDigest: z.string(),
        packageVersion: z.string().nullable(),
        evaluator: z.string(),
        decision: z.string(),
        curation: z.string().nullable(),
        stale: z.boolean(),
      }),
    ),
  }),
});

/** Lines for a `package evaluate` receipt, or null if it is not one. */
export function packageEvaluationLines(data: unknown): readonly string[] | null {
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) return null;
  const { report, reportDigest, recorded, history } = parsed.data.evaluation;
  const lines = [
    `evaluation: ${safe(report.decision)} (${safe(report.evaluator.kind)}, ${safe(report.rubric)})`,
    `report: ${safe(reportDigest)}; ${recorded ? "recorded" : "unchanged, already retained"}`,
    ...report.criteria.map(
      (entry) => `${safe(entry.criterion)}: ${safe(entry.outcome)} (${safe(entry.code)})`,
    ),
    ...report.observations.map(
      (entry) =>
        `attempt ${safe(entry.contribution)}: ${safe(entry.mode)} ${safe(entry.state)}${entry.code === null ? "" : ` (${safe(entry.code)})`}; enforcement ${safe(entry.enforcement)}`,
    ),
    ...(report.omittedObservations === 0
      ? []
      : [`attempts not shown: ${report.omittedObservations}`]),
    `limitations: ${report.limitations.map(safe).join(", ") || "none"}`,
    "An evaluation is evidence only: it never approves, enables, installs or curates a package.",
  ];
  for (const entry of history)
    lines.push(
      `history ${safe(entry.packageVersion ?? "unversioned")} ${safe(entry.identityDigest)}: ${safe(entry.decision)} by ${safe(entry.evaluator)}${entry.curation === null ? "" : `; curation ${safe(entry.curation)}`}${entry.stale ? "; stale (other bytes)" : ""}`,
    );
  return lines;
}
