/**
 * Bounded review, advisor, and simplify modes from declared evidence.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { adviseTask, TASK_ADVISOR_SOURCE, TASK_ADVISOR_VERSION } from "./task-advisor.ts";

describe("adviseTask", () => {
  test("reviews declared evidence without mutating it", () => {
    const result = adviseTask({
      mode: "review",
      question: "Does restore refuse collisions?",
      evidence: [
        { id: "e1", location: "src/git.ts:10", excerpt: "restore-ambiguous on collision" },
        { id: "e2" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.mode).toBe("review");
    expect(result.value.omittedEvidence).toEqual(["e2"]);
    expect(result.value.proposals).toEqual([]);
    expect(result.value.provenance).toEqual({
      version: TASK_ADVISOR_VERSION,
      source: TASK_ADVISOR_SOURCE,
      model: null,
    });
  });

  test("advises missing rubric evidence without broadening the question", () => {
    const result = adviseTask({
      mode: "advisor",
      question: "What remains unproven?",
      evidence: [{ id: "e1", excerpt: "restore-ambiguous on collision" }],
      rubric: ["restore-ambiguous on collision", "hook bypass never used"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.findings).toEqual([
      {
        findingId: "finding-1",
        mode: "advisor",
        location: null,
        statement: "Missing evidence for rubric: hook bypass never used",
        suggestedVerification: "Collect evidence that addresses: hook bypass never used",
      },
    ]);
  });

  test("returns simplify proposals as unapplied advice", () => {
    const result = adviseTask({
      mode: "simplify",
      question: "Can this helper shrink?",
      proposed: [{ path: "src/git.ts", summary: "inline unused alias" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.proposals).toEqual([
      { path: "src/git.ts", summary: "inline unused alias", applied: false },
    ]);
    expect(result.value.findings).toEqual([]);
  });

  test("refuses a mutation field on proposed simplify work", () => {
    const result = adviseTask({
      mode: "simplify",
      question: "Can this helper shrink?",
      proposed: [{ path: "src/git.ts", summary: "inline unused alias", execute: true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a model-assisted pass", () => {
    const result = adviseTask({
      mode: "review",
      question: "Does restore refuse collisions?",
      evidence: [{ id: "e1", excerpt: "restore-ambiguous" }],
      model: "advisor",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported");
    }
  });

  test("treats cancellation as cancelled, not as completed advice", () => {
    const result = adviseTask(
      {
        mode: "review",
        question: "Does restore refuse collisions?",
        evidence: [{ id: "e1", excerpt: "restore-ambiguous" }],
      },
      AbortSignal.abort(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./task-advisor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit)\b/,
    );
  });
});
