import { describe, expect, test } from "bun:test";

import {
  type ComposedPromptRequest,
  capabilityId,
  configurationGeneration,
  resolveExecutionProfile,
  sessionId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { attemptModelInputFromPrompt } from "./product-model-input.ts";
import type { ProductToolDisclosure } from "./product-tool-disclosure.ts";

const generation = configurationGeneration.from(3);

function prompt(brief: string, project = "Project rules"): ComposedPromptRequest {
  return {
    schemaVersion: 1,
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    configurationGeneration: generation,
    sections: [
      {
        id: "product",
        role: "product-invariant",
        source: "falryn",
        content: "Product rules",
        estimatedTokens: 3,
        order: 0,
      },
      {
        id: "project",
        role: "project-instruction",
        source: "AGENTS.md",
        content: project,
        estimatedTokens: 3,
        order: 1,
      },
      {
        id: "task",
        role: "task",
        source: "user",
        content: "Implement it",
        estimatedTokens: 3,
        order: 2,
      },
      {
        id: "brief",
        role: "brief",
        source: "brief:auto",
        content: brief,
        estimatedTokens: 3,
        order: 3,
      },
    ],
    tools: [],
    exclusions: [],
    totalEstimatedTokens: 12,
    canonicalForm: "fixture",
  };
}

function disclosure(): ProductToolDisclosure {
  const modelTool = {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", additionalProperties: false },
  } as const;
  return {
    promptTools: [{ ...modelTool, required: false, available: true }],
    modelTools: [modelTool],
    receipt: {
      schemaVersion: 1,
      catalogGeneration: generation,
      families: [{ family: "read", available: true, reason: null }],
      disclosed: [
        {
          name: "read_file",
          capabilityId: capabilityId.from("workspace.read_file"),
          version: 1,
          effect: "observation",
          capabilityKind: "filesystem",
          schemaDigest: `sha-256:${"c".repeat(64)}`,
          schemaBytes: 48,
          schemaTokensEstimated: 12,
        },
      ],
      omitted: [],
      schemaBytes: 48,
      schemaTokensEstimated: 12,
      discoveryHandle: "tool-catalog:3",
    },
  };
}

describe("attemptModelInputFromPrompt", () => {
  test("keeps dynamic Brief guidance outside the stable cache prefix", () => {
    const first = attemptModelInputFromPrompt(
      prompt("Be concise"),
      disclosure(),
      resolveExecutionProfile("agent", generation),
    );
    const second = attemptModelInputFromPrompt(
      prompt("Explain in detail"),
      disclosure(),
      resolveExecutionProfile("agent", generation),
    );
    const changedProject = attemptModelInputFromPrompt(
      prompt("Be concise", "Different project rules"),
      disclosure(),
      resolveExecutionProfile("agent", generation),
    );

    expect(first.promptCache?.stableMessageCount).toBe(2);
    expect(first.promptCache?.toolCatalogGeneration).toBe(3);
    expect(first.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(first.messages[2]?.parts[0]).toMatchObject({
      text: "[brief source=brief:auto]\nBe concise",
    });
    expect(first.promptCache?.stablePrefixDigest).toBe(second.promptCache?.stablePrefixDigest);
    expect(first.promptCache?.stablePrefixDigest).not.toBe(
      changedProject.promptCache?.stablePrefixDigest,
    );
  });
});
