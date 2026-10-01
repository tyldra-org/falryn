/** Human projection of package standing and hold receipts: the same facts the JSON receipt carries. */

import { z } from "zod";
import { safe } from "./text.ts";

const recoverySchema = z.array(
  z.looseObject({ choice: z.string(), versionDigest: z.string().optional() }),
);
const standingSchema = z.looseObject({
  state: z.string(),
  reason: z.string().nullable(),
  packageVersion: z.string().nullable(),
  decision: z.string().nullable(),
  advisory: z.string().nullable(),
  lastKnownGood: z.string().nullable(),
  recovery: recoverySchema,
  truncated: z.boolean(),
  dependencies: z.array(
    z.looseObject({ id: z.string(), state: z.string(), reason: z.string().nullable() }),
  ),
  versions: z.array(
    z.looseObject({
      identityDigest: z.string(),
      packageVersion: z.string().nullable(),
      current: z.boolean(),
      state: z.string(),
    }),
  ),
});
const receiptDataSchema = z.looseObject({
  standing: standingSchema,
  before: z.string().optional(),
  runningWork: z
    .looseObject({
      newAdmission: z.string(),
      runningAttempts: z.string(),
      cleanup: z.string(),
      evidence: z.string(),
    })
    .optional(),
  affectedContributions: z.number().optional(),
});

/** Lines for a `package standing`, `quarantine`, `release` or `revoke` receipt, or null if it is not one. */
export function packageStandingLines(data: unknown): readonly string[] | null {
  const parsed = receiptDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const { standing, before, runningWork, affectedContributions } = parsed.data;
  const lines = [
    `standing: ${safe(standing.state)}${standing.reason === null ? "" : ` (${safe(standing.reason)})`}${
      before !== undefined && before !== standing.state ? `; was ${safe(before)}` : ""
    }`,
    `version: ${safe(standing.packageVersion ?? "none")}; decision ${safe(standing.decision ?? "none")}; advisory ${safe(standing.advisory ?? "none")}`,
  ];
  for (const entry of standing.dependencies)
    lines.push(
      `dependency ${safe(entry.id)}: ${safe(entry.state)}${entry.reason === null ? "" : ` (${safe(entry.reason)})`}`,
    );
  for (const entry of standing.versions)
    lines.push(
      `${entry.current ? "current" : "retained"} ${safe(entry.packageVersion ?? "unknown")}: ${safe(entry.state)} ${safe(entry.identityDigest)}`,
    );
  lines.push(`last known good: ${safe(standing.lastKnownGood ?? "none")}`);
  lines.push(
    `recovery choices: ${
      standing.recovery
        .map((entry) =>
          entry.versionDigest === undefined
            ? safe(entry.choice)
            : `${safe(entry.choice)} ${safe(entry.versionDigest)}`,
        )
        .join(", ") || "none"
    }`,
  );
  if (standing.truncated) lines.push("lists were cut at their limits");
  if (runningWork !== undefined)
    lines.push(
      `running work: new admission ${safe(runningWork.newAdmission)}; running attempts ${safe(runningWork.runningAttempts)}; cleanup ${safe(runningWork.cleanup)}; evidence ${safe(runningWork.evidence)}`,
    );
  if (affectedContributions !== undefined)
    lines.push(`affected contributions: ${affectedContributions}`);
  return lines;
}
