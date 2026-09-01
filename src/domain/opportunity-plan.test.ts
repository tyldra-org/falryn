import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  configurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  inspectCapabilityHealth,
  planCapabilityOpportunities,
  resolveExecutionProfile,
} from "./index.ts";

function document(
  name: string,
  overrides: Partial<CapabilityRegistryDocument> = {},
): CapabilityRegistryDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    kind: "tool",
    title: name,
    summary: `Use ${name}`,
    family: "read",
    effect: "observation",
    provenance: { sourceId: "builtin:workspace", sourceVersion: "1" },
    compatibility: { os: [], arch: [], dependencies: [] },
    limits: {
      maxInputBytes: 1_024,
      maxOutputBytes: 4_096,
      defaultTimeoutMs: null,
      maxConcurrency: null,
    },
    routing: { costClass: "low", latencyClass: "instant" },
    state: {
      availability: "available",
      availabilityReason: null,
      health: "healthy",
      healthReason: null,
      executable: true,
      executionReason: null,
      operational: defaultCapabilityOperationalState(),
    },
    schemas: { inputDigest: null, outputDigest: null },
    ...overrides,
  };
}

function fixture(...documents: readonly CapabilityRegistryDocument[]) {
  const entries = documents.map((value) => {
    const created = createCapabilityRegistryEntry(value);
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  });
  const created = createCapabilityRegistry(configurationGeneration.from(18), entries);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function plan(
  task: string,
  documents: readonly CapabilityRegistryDocument[],
  options: {
    readonly intentFamilies?: readonly (
      | "search"
      | "read"
      | "edit"
      | "run"
      | "browser"
      | "computer"
      | "delegate"
      | "capability"
    )[];
    readonly schemaTokenBudget?: number;
    readonly preferredCapabilityIds?: readonly string[];
  } = {},
) {
  const registry = fixture(...documents);
  const health = inspectCapabilityHealth(registry, "native-model", {
    runtime: { attemptRunner: "available", provider: "available", workspace: "available" },
  });
  return planCapabilityOpportunities({
    task,
    taskFingerprint: "0123456789abcdef01234567",
    policy: resolveExecutionProfile("agent", registry.generation),
    health,
    candidates: registry.entries.map((entry, order) => ({
      capabilityId: entry.capabilityId,
      name: entry.name,
      title: entry.title,
      summary: entry.summary,
      kind: entry.kind,
      family: entry.family,
      source: entry.source,
      effect: entry.effect,
      costClass: entry.routing.costClass,
      latencyClass: entry.routing.latencyClass,
      schemaTokensEstimated: 100,
      modelSchemaEligible: true,
      order,
    })),
    intentFamilies: options.intentFamilies ?? [],
    ...(options.preferredCapabilityIds === undefined
      ? {}
      : {
          preferredCapabilityIds: options.preferredCapabilityIds.map(
            (value) =>
              registry.entries.find((entry) => entry.name === value)?.capabilityId ??
              (() => {
                throw new Error(`missing preferred capability fixture: ${value}`);
              })(),
          ),
        }),
    ...(options.schemaTokenBudget === undefined
      ? {}
      : { schemaTokenBudget: options.schemaTokenBudget }),
  });
}

describe("deterministic opportunity planning", () => {
  test("honours an explicit shell override while keeping typed search available", () => {
    const result = plan("Run this shell command: rg composeTurn src", [
      document("search_text", { family: "search" }),
      document("run_process", { family: "run", effect: "external" }),
      document("run_shell", { family: "run", effect: "external" }),
      document("read_file"),
    ]);

    expect(result.selected[0]?.name).toBe("run_shell");
    expect(result.selected[0]?.reasons).toContain("explicit-shell-override");
    expect(result.selected.map((entry) => entry.name)).toContain("search_text");
    expect(JSON.stringify(result)).toBe(
      JSON.stringify(
        plan("Run this shell command: rg composeTurn src", [
          document("search_text", { family: "search" }),
          document("run_process", { family: "run", effect: "external" }),
          document("run_shell", { family: "run", effect: "external" }),
          document("read_file"),
        ]),
      ),
    );
  });

  test("prefers structured browser access and leaves visual computer use as fallback", () => {
    const result = plan("Open https://example.test and click the sign-in button", [
      document("browser_dom", { family: "browser", source: "integration" }),
      document("computer_click", { family: "computer", source: "integration" }),
    ]);

    expect(result.primaryFamily).toBe("browser");
    expect(result.selected[0]?.name).toBe("browser_dom");
    expect(result.opportunities.find((item) => item.kind === "browser")?.decision).toBe("selected");
    expect(result.opportunities.find((item) => item.kind === "computer")?.decision).toBe(
      "deferred",
    );
    expect(result.degradation.transitions).toContainEqual(
      expect.objectContaining({
        fromCapabilityId: result.selected.find((entry) => entry.name === "browser_dom")
          ?.capabilityId,
        toCapabilityId: result.selected.find((entry) => entry.name === "computer_click")
          ?.capabilityId,
        strategy: "model-continuation",
        informationChange: "different-contract",
        effectChange: "same",
      }),
    );
  });

  test("selects matching skills, workflows, and MCP contributions without executing them", () => {
    const result = plan("Implement this TypeScript change and run the deliver workflow", [
      document("typescript_best_practices", {
        kind: "skill",
        source: "skill",
        family: "capability",
        title: "TypeScript best practices",
        summary: "Required guidance for TypeScript implementation",
      }),
      document("deliver", {
        kind: "workflow",
        source: "workflow",
        family: "capability",
        title: "Deliver workflow",
      }),
      document("github_issue", {
        kind: "mcp-tool",
        source: "mcp",
        family: "capability",
        title: "GitHub issue",
      }),
      document("apply_patch", { family: "edit", effect: "mutation" }),
    ]);

    expect(result.opportunities.find((item) => item.kind === "skill")?.decision).toBe("selected");
    expect(result.opportunities.find((item) => item.kind === "workflow")?.decision).toBe(
      "selected",
    );
    expect(result.selected.map((entry) => entry.name)).not.toContain("github_issue");
  });

  test("reports unavailable delegation and bounds schema selection with fallbacks", () => {
    const result = plan(
      "Implement these independent changes in parallel and keep the test watcher running",
      [
        document("read_file"),
        document("apply_patch", { family: "edit", effect: "mutation" }),
        document("run_process", { family: "run", effect: "external" }),
      ],
      { intentFamilies: ["edit", "run"], schemaTokenBudget: 150 },
    );

    expect(result.selected).toHaveLength(1);
    expect(result.fallbacks.some((entry) => entry.reasons.includes("schema-budget"))).toBe(true);
    expect(result.opportunities.find((item) => item.kind === "delegation")?.decision).toBe(
      "unavailable",
    );
    expect(result.opportunities.find((item) => item.kind === "background")?.decision).toBe(
      "deferred",
    );
  });

  test("keeps denied preferred capabilities visible as unavailable", () => {
    const denied = document("run_shell", {
      family: "run",
      effect: "external",
      state: {
        availability: "available",
        availabilityReason: null,
        health: "healthy",
        healthReason: null,
        executable: true,
        executionReason: null,
        operational: defaultCapabilityOperationalState({ allowed: false, denied: true }),
      },
    });
    const result = plan("Run the test command", [denied, document("read_file")], {
      preferredCapabilityIds: ["run_shell"],
    });
    const rejected = result.rejected.find((entry) => entry.name === "run_shell");
    if (rejected === undefined) throw new Error("missing denied fallback fixture");
    expect(rejected).toMatchObject({
      decision: "unavailable",
      health: "denied",
    });
    expect(rejected?.reasons).toContain("policy-denied");
    expect(rejected?.reasons).toContain("task-family");
    expect(rejected?.reasons).toContain("user-preference");
    expect(result.degradation.terminalOutcomes).toContainEqual({
      capabilityId: rejected.capabilityId,
      outcome: "unavailable",
      reason: "policy-denied",
      recoveryHandles: [`capability:allow:${rejected.capabilityId}`],
    });
  });

  test("returns a bounded no-candidate plan and rejects stale or malformed identity", () => {
    const empty = plan("Explain the architecture", []);
    expect(empty.selected).toEqual([]);
    expect(empty.rejected).toEqual([]);
    expect(empty.opportunities.every((entry) => entry.decision === "not-needed")).toBe(true);

    const registry = fixture(document("read_file"));
    const health = inspectCapabilityHealth(registry, "native-model");
    const candidate = registry.entries[0];
    if (candidate === undefined) throw new Error("missing candidate fixture");
    const input = {
      task: "Read the file",
      taskFingerprint: "0123456789abcdef01234567",
      policy: resolveExecutionProfile("agent", configurationGeneration.from(19)),
      health,
      candidates: [
        {
          capabilityId: candidate.capabilityId,
          name: candidate.name,
          title: candidate.title,
          summary: candidate.summary,
          kind: candidate.kind,
          family: candidate.family,
          source: candidate.source,
          effect: candidate.effect,
          costClass: candidate.routing.costClass,
          latencyClass: candidate.routing.latencyClass,
          schemaTokensEstimated: 100,
          modelSchemaEligible: true,
          order: 0,
        },
      ],
    } as const;
    expect(() => planCapabilityOpportunities(input)).toThrow(
      "opportunity planning generations do not match",
    );
    expect(() =>
      planCapabilityOpportunities({
        ...input,
        policy: resolveExecutionProfile("agent", registry.generation),
        taskFingerprint: "not-a-fingerprint",
      }),
    ).toThrow("opportunity planning task fingerprint is invalid");
  });
});
