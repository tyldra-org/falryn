import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  curatedVerification,
  curatorReport,
} from "../../application/extensions/evaluation-fixtures.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { packageIdentityV1Schema } from "../../domain/extensions/identity.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { packageHealthResultSchema } from "../../domain/extensions/package-health.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import { packageEvaluationReportSchema } from "../../domain/security/package-evaluation.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { preparePackageCliFixture } from "./package-health-fixtures.ts";

afterEach(removeTemporaryRoots);

const evaluationSchema = z.object({
  evaluation: z.object({
    report: packageEvaluationReportSchema,
    recorded: z.boolean(),
    history: z.array(
      z.object({ evaluator: z.string(), curation: z.string().nullable(), stale: z.boolean() }),
    ),
  }),
});
const trustSchema = z.object({
  trust: z.object({
    status: z.string(),
    confirmation: z.string().nullable(),
    trust: z.object({
      state: z.string(),
      eligible: z.boolean(),
      subject: z.object({ identity: packageIdentityV1Schema }),
      evidence: z.object({ curation: z.string() }),
    }),
    provenance: z.object({ curationStatus: z.string().optional() }).nullable().optional(),
  }),
});

test.skipIf(createHostSandbox().probe().status !== "available")(
  "a deceptive package's denied undeclared effect is preserved by evaluation and blocks curation",
  async () => {
    const root = await temporaryRoot("falryn-evaluation-cli-");
    const { invoke, contribution, source } = await preparePackageCliFixture(
      "in-process",
      root,
      "deceptive",
    );
    const request = {
      packageId: "fixture",
      operationId: randomUUID(),
      expectedRevision: 1,
      health: { contribution },
    };
    const preview = await invoke(["package", "health"], request, packageReceiptSchema);
    const health = await invoke(
      ["package", "health"],
      { ...request, confirmation: preview.confirmation },
      packageReceiptSchema,
    );
    const attempt = packageHealthResultSchema.parse(health.data);
    expect(attempt).toMatchObject({ state: "failed", terminated: true });
    expect(attempt.sandbox?.effectiveMode).toBe("strict");
    // The runtime denied the write: the file outside the package is untouched.
    expect(await readFile(join(root, "outside-secret"), "utf8")).toBe("PRIVATE-CONTENT");

    const evaluate = () =>
      invoke(
        ["package", "evaluate"],
        { packageId: "fixture", operationId: randomUUID(), expectedRevision: 1 },
        packageReceiptSchema,
      );
    const evaluated = await evaluate();
    expect(evaluated).toMatchObject({
      status: "completed",
      code: "evaluated-not-eligible",
      activation: "unavailable",
    });
    const { report, recorded } = evaluationSchema.parse(evaluated.data).evaluation;
    expect(recorded).toBe(true);
    expect(report.criteria.find((entry) => entry.criterion === "effects")).toMatchObject({
      outcome: "fail",
      code: "native-failed",
    });
    expect(report.observations).toEqual([
      {
        contribution,
        mode: "governed",
        state: "failed",
        code: attempt.code,
        enforcement: "strict",
      },
    ]);
    expect(evaluationSchema.parse((await evaluate()).data).evaluation.recorded).toBe(false);

    // A curator cannot turn the observed failure into curation, even with a valid signature.
    // The verification only needs the exact identity and a clock; the report names the identity.
    const observation = {
      subject: { identity: report.subject },
      now: Date.now(),
    } as unknown as TrustObservation;
    const refresh = async (statement: Parameters<typeof curatedVerification>[1]) => {
      const input = {
        action: "refresh",
        expiresAt: null,
        verification: curatedVerification(observation, statement),
      };
      const shown = await invoke(["extension", "trust", source], input, trustSchema);
      return invoke(
        ["extension", "trust", source],
        { ...input, confirmation: shown.trust.confirmation },
        trustSchema,
      );
    };
    const identity = observation.subject.identity;
    const failing = await refresh({
      statement: {
        report: curatorReport(identity, { effects: "native-failed" }, observation.now - 1),
      },
    });
    expect(failing.trust).toMatchObject({
      status: "applied",
      trust: { evidence: { curation: "unavailable" } },
      provenance: { curationStatus: "ineligible-report" },
    });
    const curated = await refresh({
      statement: { report: curatorReport(identity, {}, observation.now - 1) },
    });
    // Curation is recorded, but the earlier approval no longer matches the changed evidence: nothing is granted.
    expect(curated.trust).toMatchObject({
      status: "applied",
      trust: { evidence: { curation: "verified" }, eligible: false },
      provenance: { curationStatus: "verified" },
    });
    const standing = await invoke(
      ["package", "standing"],
      { packageId: "fixture", operationId: randomUUID(), expectedRevision: 1 },
      packageReceiptSchema,
    );
    expect(standing.data).toMatchObject({
      standing: { state: expect.not.stringMatching(/^eligible$/u) },
    });
    const history = evaluationSchema.parse((await evaluate()).data).evaluation.history;
    expect(history.map((entry) => [entry.evaluator, entry.curation])).toEqual(
      expect.arrayContaining([
        ["local", null],
        ["curator", "ineligible-report"],
        ["curator", "verified"],
      ]),
    );
  },
  // Several CLI commands and one governed child; hosted macOS runs them several times slower.
  90_000,
);
