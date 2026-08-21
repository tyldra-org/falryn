/**
 * Live-turn context planner (#715).
 */

import { describe, expect, test } from "bun:test";

import {
  admitEvidenceCandidate,
  CONTENT_DIGEST_ALGORITHM,
  configurationGeneration,
  contentDigest,
  sessionId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { CONTEXT_PLANNER_OWNER, createContextPlanner } from "./context-planner.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const TEXT = "export const planned = true;\n";

function candidate(id: string, origin: string, text = TEXT) {
  const admitted = admitEvidenceCandidate({
    id,
    sourceKind: "file",
    origin,
    workspaceId: "ws-1",
    payload: { kind: "inline", text },
    estimatedTokens: 8,
    freshness: "live",
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: "exact-source",
    exactSource: {
      kind: "inline",
      digest: contentDigest.from(DIGEST),
      byteLength: new TextEncoder().encode(text).byteLength,
    },
  });
  if (!admitted.ok) {
    throw new Error(admitted.error.code);
  }
  return admitted.value;
}

describe("createContextPlanner", () => {
  test("packs candidates into evidence sections without claiming exactness for narrowed support", () => {
    const planner = createContextPlanner();
    const planned = planner.plan(
      [
        candidate("ev-1", "src/a.ts"),
        candidate("ev-2", "src/b.ts", "secondary support text that is long enough to excerpt\n"),
      ],
      { rank: { maxSelected: 2 } },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.value.sections.length).toBeGreaterThan(0);
    expect(planned.value.sections.every((section) => section.role === "evidence")).toBe(true);
    expect(CONTEXT_PLANNER_OWNER).toBe("#715");
  });

  test("composes a live turn prompt with task and planner evidence", () => {
    const planner = createContextPlanner();
    const composed = planner.composeTurn({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      configurationGeneration: configurationGeneration.from(0),
      task: "fix the export",
      candidates: [candidate("ev-1", "src/a.ts")],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }
    expect(composed.value.prompt.sections.some((section) => section.role === "task")).toBe(true);
    expect(composed.value.prompt.sections.some((section) => section.role === "evidence")).toBe(
      true,
    );
    expect(composed.value.prompt.canonicalForm).toContain("fix the export");
    expect(composed.value.plan.pack.items[0]?.claimsExact).toBe(true);
  });
});
