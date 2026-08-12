import { describe, expect, test } from "bun:test";

import {
  CONTENT_DIGEST_ALGORITHM,
  configurationGeneration,
  sessionId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createSha256Hasher } from "../integrations/content-digest.ts";
import { createPromptComposer } from "./prompt-composer.ts";

const generation = configurationGeneration.from(0);

describe("prompt composer", () => {
  test("digests the canonical form with sha-256", () => {
    const composer = createPromptComposer({ hasher: createSha256Hasher() });
    const result = composer.compose({
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
      ],
      tools: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected digested compose");
    }
    expect(result.value.compositionDigest.startsWith(`${CONTENT_DIGEST_ALGORITHM}:`)).toBe(true);
    expect(result.value.compositionDigest.length).toBe(`${CONTENT_DIGEST_ALGORITHM}:`.length + 64);

    const again = composer.compose({
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
      ],
      tools: [],
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.compositionDigest).toBe(result.value.compositionDigest);
    }
  });

  test("composeForTurn rejects a mismatched turn identity", () => {
    const composer = createPromptComposer({ hasher: createSha256Hasher() });
    const result = composer.composeForTurn(turnId.from("turn-expected"), {
      turnId: turnId.from("turn-other"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      configurationGeneration: generation,
      sections: [
        {
          id: "product",
          role: "product-invariant",
          source: "falryn",
          content: "Stay safe.",
          required: true,
          available: true,
        },
        {
          id: "task-1",
          role: "task",
          source: "user",
          content: "Go",
          required: true,
          available: true,
        },
      ],
      tools: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "turn-mismatch",
        expected: turnId.from("turn-expected"),
        actual: turnId.from("turn-other"),
      });
    }
  });
});
