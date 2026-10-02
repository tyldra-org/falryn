import { expect, test } from "bun:test";
import { packageEvaluationLines } from "./package-evaluation.ts";

test("evaluation lines state every criterion, preserved attempts and stale history as data", () => {
  const lines = packageEvaluationLines({
    evaluation: {
      reportDigest: "sha256:report",
      recorded: false,
      report: {
        rubric: "falryn.package-rubric.v1",
        decision: "not-eligible",
        evaluator: { kind: "local" },
        criteria: [{ criterion: "effects", outcome: "fail", code: "native-failed" }],
        observations: [
          {
            contribution: "sha256:tool",
            mode: "governed",
            state: "failed",
            code: "health-child-crashed",
            enforcement: "strict",
          },
        ],
        omittedObservations: 0,
        limitations: ["curator-review-required"],
      },
      history: [
        {
          identityDigest: "sha256:old\u001b[31m",
          packageVersion: "1.0.0",
          evaluator: "curator",
          decision: "eligible",
          curation: "verified",
          stale: true,
        },
      ],
    },
  });
  expect(lines).toContain("evaluation: not-eligible (local, falryn.package-rubric.v1)");
  expect(lines).toContain("report: sha256:report; unchanged, already retained");
  expect(lines).toContain("effects: fail (native-failed)");
  expect(lines).toContain(
    "attempt sha256:tool: governed failed (health-child-crashed); enforcement strict",
  );
  expect(lines?.join("\n")).toContain("never approves, enables, installs or curates");
  const history = lines?.at(-1) ?? "";
  expect(history).toContain("curation verified; stale (other bytes)");
  expect(history).not.toContain("\u001b");
  expect(packageEvaluationLines({ standing: {} })).toBeNull();
});
