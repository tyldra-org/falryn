import { describe, expect, test } from "bun:test";

import {
  composePromptRequest,
  configurationGeneration,
  DEFAULT_BRIEF_NEED,
  sessionId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createBriefComposer } from "./brief.ts";

const generation = configurationGeneration.from(0);

describe("brief composer", () => {
  test("maps a projection onto the prompt brief section last before inference", () => {
    const composer = createBriefComposer();
    const briefed = composer.project({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      configurationGeneration: generation,
      need: { ...DEFAULT_BRIEF_NEED, failures: true, citations: true },
      policy: { verbosity: "compact", source: "user", guidance: "Prefer short lists." },
    });
    expect(briefed.ok).toBe(true);
    if (!briefed.ok) {
      return;
    }
    expect(briefed.value.section.role).toBe("brief");
    expect(briefed.value.section.required).toBe(true);
    expect(briefed.value.section.content).toContain("failed effect");
    expect(briefed.value.section.content).toContain("Prefer short lists.");

    const composed = composePromptRequest({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      configurationGeneration: generation,
      sections: [
        {
          id: "product",
          role: "product-invariant",
          source: "falryn",
          content: "Stay within the workspace.",
          required: true,
          available: true,
        },
        {
          id: "task-1",
          role: "task",
          source: "user",
          content: "List the open issues.",
          required: true,
          available: true,
        },
        briefed.value.section,
      ],
      tools: [],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }
    expect(composed.value.sections.map((section) => section.role)).toEqual([
      "product-invariant",
      "task",
      "brief",
    ]);
    expect(composed.value.sections.at(-1)?.content).toBe(briefed.value.section.content);
  });

  test("redacts secret-shaped style notes before projection", () => {
    const composer = createBriefComposer();
    const result = composer.project({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      configurationGeneration: generation,
      need: DEFAULT_BRIEF_NEED,
      policy: {
        verbosity: "balanced",
        source: "user",
        guidance: "Never echo apiKey=hunter2 in the reply.",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.projection.guidance).not.toContain("hunter2");
    expect(result.value.projection.guidance).toContain("[redacted]");
  });

  test("refuses a mismatched turn identity", () => {
    const composer = createBriefComposer();
    const result = composer.projectForTurn(turnId.from("turn-2"), {
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      configurationGeneration: generation,
      need: DEFAULT_BRIEF_NEED,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "brief", code: "turn-mismatch", field: "turnId" });
    }
  });
});
