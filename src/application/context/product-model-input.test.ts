import { describe, expect, test } from "bun:test";

import type { ComposedPromptRequest } from "../../domain/context/index.ts";
import {
  capabilityId,
  configurationGeneration,
  sessionId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { resolveExecutionProfile } from "../../domain/sessions/index.ts";
import type { ProductToolDisclosure } from "../tools/product-tool-disclosure.ts";
import { attemptModelInputFromPrompt } from "./product-model-input.ts";

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
  const id = capabilityId.from("workspace.read_file");
  const lifecycle = {
    registered: true,
    available: true,
    disclosed: true,
    executable: true,
    projected: false,
    availability: "available",
    health: "healthy",
    reasons: [],
  } as const;
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
      capabilityCards: [
        {
          trust: null,
          capabilityId: id,
          title: "Read file",
          summary: "Read a file",
          kind: "tool",
          family: "read",
          effect: "observation",
          source: "builtin",
          sourceId: "builtin:workspace",
          version: 1,
          costClass: "unknown",
          latencyClass: "unknown",
          lifecycle,
        },
      ],
      health: {
        consumer: "native-model",
        observedAt: null,
        summary: {
          registered: 1,
          available: 1,
          disclosed: 1,
          executable: 1,
          projected: 0,
          selected: 1,
          active: 0,
          selectable: 1,
          byHealth: {
            healthy: 1,
            degraded: 0,
            unavailable: 0,
            incompatible: 0,
            denied: 0,
            quarantined: 0,
            unknown: 0,
          },
        },
        entries: [
          {
            trust: null,
            capabilityId: id,
            title: "Read file",
            summary: "Read a file",
            kind: "tool",
            family: "read",
            source: "builtin",
            sourceId: "builtin:workspace",
            version: 1,
            generation,
            consumer: "native-model",
            effect: "observation",
            availability: "available",
            health: "healthy",
            registered: true,
            available: true,
            disclosed: true,
            executable: true,
            projected: false,
            selected: true,
            active: false,
            selectable: true,
            diagnostics: [],
          },
        ],
      },
      opportunityPlan: {
        schemaVersion: 1,
        planId: "capability-plan:3:0123456789abcdef01234567",
        taskFingerprint: "0123456789abcdef01234567",
        catalogGeneration: generation,
        policyGeneration: generation,
        profileId: "agent",
        signalledFamilies: ["read", "capability"],
        requiredFamilies: ["read", "capability"],
        primaryFamily: "read",
        fallbackFamilies: ["capability"],
        selected: [
          {
            capabilityId: id,
            name: "read_file",
            kind: "tool",
            family: "read",
            source: "builtin",
            effect: "observation",
            health: "healthy",
            decision: "selected",
            score: 100,
            schemaTokensEstimated: 12,
            reasons: ["task-family", "healthy"],
            diagnosticCodes: [],
            recoveryHandles: [],
          },
        ],
        fallbacks: [],
        rejected: [],
        omittedRejected: 0,
        opportunities: [],
        modelAssistance: {
          decision: "not-needed",
          candidateIds: [],
          reason: "deterministic-winner",
        },
        degradation: {
          schemaVersion: 1,
          catalogGeneration: generation,
          strategy: "explicit-model-continuation",
          maxRuntimeTransitions: 4,
          transitions: [],
          terminalOutcomes: [
            {
              capabilityId: id,
              outcome: "unavailable",
              reason: "no-declared-fallback",
              recoveryHandles: [],
            },
          ],
        },
        schemaTokensEstimated: 12,
        selectionLimit: 24,
        schemaTokenBudget: 12_000,
        discoveryHandle: "capability-catalog:3",
      },
      registryTotal: 1,
      registryCounts: { tool: 1 },
      disclosed: [
        {
          name: "read_file",
          capabilityId: id,
          version: 1,
          effect: "observation",
          capabilityKind: "filesystem",
          schemaDigest: `sha-256:${"c".repeat(64)}`,
          schemaBytes: 48,
          schemaTokensEstimated: 12,
          lifecycle,
        },
      ],
      deferred: [],
      omitted: [],
      schemaBytes: 48,
      schemaTokensEstimated: 12,
      deferredSchemaBytes: 0,
      deferredSchemaTokensEstimated: 0,
      discoveryHandle: "capability-catalog:3",
    },
  };
}

function disclosureWithDeferred(): ProductToolDisclosure {
  const base = disclosure();
  const firstDisclosed = base.receipt.disclosed[0];
  if (firstDisclosed === undefined) {
    throw new Error("missing disclosed descriptor");
  }
  const deferredId = capabilityId.from("workspace.search_text");
  const deferredTool = {
    name: "search_text",
    capabilityId: deferredId,
    version: 1,
    effect: "observation" as const,
    capabilityKind: "filesystem" as const,
    schemaDigest: `sha-256:${"d".repeat(64)}`,
    schemaBytes: 64,
    schemaTokensEstimated: 16,
    lifecycle: firstDisclosed.lifecycle,
  };
  const plan = base.receipt.opportunityPlan;
  return {
    ...base,
    modelTools: [
      ...base.modelTools,
      {
        name: "search_text",
        description: "Search text",
        parameters: { type: "object", additionalProperties: false },
        deferred: true,
      },
    ],
    receipt: {
      ...base.receipt,
      deferred: [deferredTool],
      deferredSchemaBytes: 64,
      deferredSchemaTokensEstimated: 16,
      opportunityPlan: {
        ...plan,
        fallbacks: [
          {
            capabilityId: deferredId,
            name: "search_text",
            kind: "tool" as const,
            family: "search" as const,
            source: "builtin" as const,
            effect: "observation" as const,
            health: "healthy" as const,
            decision: "fallback" as const,
            score: 80,
            schemaTokensEstimated: 16,
            reasons: ["task-family" as const, "selection-limit" as const],
            diagnosticCodes: [],
            recoveryHandles: [],
          },
        ],
      },
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

    expect(first.disclosure.capabilityCatalog?.cards[0]).toMatchObject({
      health: "healthy",
      selected: true,
      projected: false,
      diagnosticCodes: [],
    });
    expect(first.disclosure.opportunityPlan).toMatchObject({
      primaryFamily: "read",
      selected: [{ name: "read_file" }],
    });

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
    const capabilityPart = first.messages[1]?.parts[0];
    expect(capabilityPart?.kind).toBe("text");
    if (capabilityPart?.kind === "text") {
      expect(capabilityPart.text).toContain("Deterministically selected: read_file");
      expect(capabilityPart.text).toContain("Schema budget: 12/12000 estimated tokens");
    }
    expect(first.disclosure.capabilityCatalog).toMatchObject({
      total: 1,
      counts: { tool: 1 },
      cards: [
        {
          capabilityId: capabilityId.from("workspace.read_file"),
          kind: "tool",
          family: "read",
          available: true,
          executable: true,
          disclosed: true,
        },
      ],
    });
  });

  test("binds deferred definitions into the attempt disclosure and cache prefix", () => {
    const input = attemptModelInputFromPrompt(
      prompt("Be concise"),
      disclosureWithDeferred(),
      resolveExecutionProfile("agent", generation),
    );
    const eagerOnly = attemptModelInputFromPrompt(
      prompt("Be concise"),
      disclosure(),
      resolveExecutionProfile("agent", generation),
    );

    expect(input.tools.map((tool) => tool.name)).toEqual(["read_file", "search_text"]);
    expect(input.tools[1]?.deferred).toBe(true);
    expect(input.disclosure.toolNames).toEqual(["read_file", "search_text"]);
    expect(input.disclosure.deferred).toEqual([
      expect.objectContaining({
        name: "search_text",
        capabilityId: capabilityId.from("workspace.search_text"),
        schemaDigest: `sha-256:${"d".repeat(64)}`,
      }),
    ]);
    const capabilityPart = input.messages[1]?.parts[0];
    if (capabilityPart?.kind !== "text") throw new Error("missing capability brief");
    expect(capabilityPart.text).toContain(
      "Deferred tool definitions (loadable through the provider's tool search where supported): search_text",
    );
    expect(input.promptCache?.stablePrefixDigest).not.toBe(
      eagerOnly.promptCache?.stablePrefixDigest,
    );
  });
});
