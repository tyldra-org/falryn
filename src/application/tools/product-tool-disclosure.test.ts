import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { configurationGeneration } from "../../domain/foundation/index.ts";
import { isDeferrablePlanCandidate } from "../../domain/orchestration/opportunity-plan.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { resolveExecutionProfile } from "../../domain/sessions/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolManifestDocument,
  type ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createProductCapabilityRegistry } from "../capabilities/product-capability-registry.ts";
import {
  discloseProductTools,
  MAX_DISCLOSED_PRODUCT_TOOLS,
  MODEL_CAPABILITY_FAMILIES,
} from "./product-tool-disclosure.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

function workspaceTools() {
  return composeProductWorkspaceTools({
    generation: configurationGeneration.from(7),
    fileSystem: createInMemoryFileSystem({
      nodes: {
        "/work": { kind: "directory" },
        "/work/a.ts": { kind: "file", text: "export const a = 1;\n" },
      },
    }),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
}

function permissiveEntry(name: string): ToolRegistryEntry {
  const open = z.record(z.string(), z.unknown()) as z.ZodType<Readonly<Record<string, unknown>>>;
  const document: ToolManifestDocument = {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title: name,
    description: "permissive fixture",
    effect: "observation",
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits(),
    concurrency: defaultConcurrencyContract({}),
    resultProjection: defaultProjectionContract({}),
  };
  const entry = createToolRegistryEntry(document, {
    inputSchema: open,
    outputSchema: open,
  });
  if (!entry.ok) throw new Error("permissive fixture");
  return entry.value;
}

describe("discloseProductTools", () => {
  test("publishes a bounded exact-schema subset with an inspectable receipt", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(
        tools.registry.generation,
        tools.registry,
        [],
        (id) => tools.runner.hasBinding?.(id) === true,
      ),
      tools.registry,
    );

    expect(disclosure.modelTools.length).toBeLessThanOrEqual(MAX_DISCLOSED_PRODUCT_TOOLS);
    expect(disclosure.modelTools.map((tool) => tool.name)).toContain("read_file");
    expect(disclosure.promptTools.map((tool) => tool.name)).toEqual(
      disclosure.modelTools.map((tool) => tool.name),
    );
    expect(disclosure.receipt.catalogGeneration).toBe(configurationGeneration.from(7));
    expect(disclosure.receipt.families.map((entry) => entry.family)).toEqual([
      ...MODEL_CAPABILITY_FAMILIES,
    ]);
    expect(disclosure.receipt.discoveryHandle).toBe("capability-catalog:7");
    expect(disclosure.receipt.registryTotal).toBe(tools.registry.entries.length);
    expect(disclosure.receipt.health).toMatchObject({
      consumer: "native-model",
      summary: {
        registered: tools.registry.entries.length,
        disclosed: disclosure.receipt.disclosed.length,
      },
    });
    expect(disclosure.receipt.opportunityPlan).toMatchObject({
      catalogGeneration: configurationGeneration.from(7),
      profileId: "agent",
      modelAssistance: { decision: expect.any(String) },
    });
    expect(disclosure.receipt.schemaBytes).toBeGreaterThan(0);
    expect(disclosure.receipt.schemaTokensEstimated).toBeGreaterThan(0);
    expect(
      disclosure.receipt.disclosed.every((tool) => tool.schemaDigest.startsWith("sha-256:")),
    ).toBe(true);
  });

  test("uses the task-aware deterministic plan before publishing schemas", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(
        tools.registry.generation,
        tools.registry,
        [],
        (id) => tools.runner.hasBinding?.(id) === true,
      ),
      tools.registry,
      { task: "Find every reference to a.ts", intent: "read" },
    );

    expect(disclosure.receipt.opportunityPlan.primaryFamily).toBe("search");
    expect(disclosure.modelTools[0]?.name).toBe("search_text");
    expect(
      disclosure.receipt.opportunityPlan.rejected.find((entry) => entry.name === "search_text"),
    ).toBeUndefined();
    expect(disclosure.receipt.opportunityPlan.selected.map((entry) => entry.name)).toContain(
      "search_text",
    );
    expect(disclosure.receipt.opportunityPlan.taskFingerprint).toMatch(/^[a-f0-9]{24}$/u);
    expect(JSON.stringify(disclosure.receipt.opportunityPlan)).not.toContain("every reference");
  });

  test("clamps disclosure count to the hard model-schema bound", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(
        tools.registry.generation,
        tools.registry,
        [],
        (id) => tools.runner.hasBinding?.(id) === true,
      ),
      tools.registry,
      { maximum: Number.POSITIVE_INFINITY },
    );

    expect(disclosure.modelTools.length).toBeLessThanOrEqual(MAX_DISCLOSED_PRODUCT_TOOLS);
    expect(disclosure.receipt.opportunityPlan.selectionLimit).toBe(MAX_DISCLOSED_PRODUCT_TOOLS);
  });

  test("discloses the strict workspace schemas and omits only a permissive boundary", () => {
    const tools = workspaceTools();
    const permissive = permissiveEntry("open_probe");
    const registry = createToolRegistry(tools.registry.generation, [
      ...tools.registry.entries,
      permissive,
    ]);
    if (!registry.ok) throw new Error("registry fixture");
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(registry.value.generation, registry.value, [], () => true),
      registry.value,
    );

    const names = disclosure.modelTools.map((tool) => tool.name);
    for (const name of [
      "write_files",
      "mutate_paths",
      "discover_files",
      "search_text",
      "preview_patch",
      "apply_patch",
    ]) {
      expect(names).toContain(name);
      expect(disclosure.receipt.disclosed.map((entry) => entry.name)).toContain(name);
      expect(disclosure.receipt.opportunityPlan.selected.map((entry) => entry.name)).toContain(
        name,
      );
    }
    const write = disclosure.modelTools.find((tool) => tool.name === "write_files");
    expect(write?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    expect(names).not.toContain("open_probe");
    expect(disclosure.receipt.omitted).toContainEqual({
      name: "open_probe",
      reason: "permissive model-boundary schema",
    });
    const read = disclosure.modelTools.find((tool) => tool.name === "read_file");
    expect(read?.parameters).toMatchObject({ anyOf: expect.any(Array) });
  });

  test("marks ordered plan fallbacks as deferred definitions beyond the eager bound", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(
        tools.registry.generation,
        tools.registry,
        [],
        (id) => tools.runner.hasBinding?.(id) === true,
      ),
      tools.registry,
      { maximum: 3 },
    );

    const deferred = disclosure.receipt.deferred;
    const disclosed = disclosure.receipt.disclosed;
    expect(disclosed.length).toBeLessThanOrEqual(3);
    expect(deferred.length).toBeGreaterThan(0);

    const deferrableIds = new Set(
      [
        ...disclosure.receipt.opportunityPlan.fallbacks,
        ...disclosure.receipt.opportunityPlan.rejected,
      ]
        .filter(isDeferrablePlanCandidate)
        .map((entry) => entry.capabilityId),
    );
    const disclosedNames = new Set(disclosed.map((tool) => tool.name));
    for (const tool of deferred) {
      expect(deferrableIds.has(tool.capabilityId)).toBe(true);
      expect(disclosedNames.has(tool.name)).toBe(false);
      expect(tool.schemaDigest.startsWith("sha-256:")).toBe(true);
    }

    const deferredNames = deferred.map((tool) => tool.name);
    expect(
      disclosure.modelTools.filter((tool) => tool.deferred === true).map((tool) => tool.name),
    ).toEqual(deferredNames);
    expect(
      disclosure.modelTools.slice(0, disclosed.length).every((tool) => tool.deferred !== true),
    ).toBe(true);
    expect(disclosure.promptTools.map((tool) => tool.name)).toEqual(
      disclosed.map((tool) => tool.name),
    );
    expect(disclosure.receipt.omitted.some((entry) => deferredNames.includes(entry.name))).toBe(
      false,
    );
    expect(disclosure.receipt.deferredSchemaBytes).toBe(
      deferred.reduce((total, tool) => total + tool.schemaBytes, 0),
    );
    expect(disclosure.receipt.deferredSchemaTokensEstimated).toBeGreaterThan(0);
  });

  test("bounds deferred definitions by count, tokens, and policy", () => {
    const tools = workspaceTools();
    const capabilities = createProductCapabilityRegistry(
      tools.registry.generation,
      tools.registry,
      [],
      (id) => tools.runner.hasBinding?.(id) === true,
    );
    const counted = discloseProductTools(capabilities, tools.registry, {
      maximum: 3,
      deferredMaximum: 2,
    });
    expect(counted.receipt.deferred.length).toBe(2);

    const starved = discloseProductTools(capabilities, tools.registry, {
      maximum: 3,
      deferredSchemaTokenBudget: 0,
    });
    expect(starved.receipt.deferred).toEqual([]);
    expect(starved.receipt.deferredSchemaBytes).toBe(0);
    const starvedDeferred = new Set(counted.receipt.deferred.map((tool) => tool.name));
    expect(starved.receipt.omitted.filter((entry) => starvedDeferred.has(entry.name)).length).toBe(
      starvedDeferred.size,
    );

    const ask = discloseProductTools(capabilities, tools.registry, {
      maximum: 3,
      executionPolicy: resolveExecutionProfile("ask", configurationGeneration.from(7)),
    });
    expect(ask.receipt.deferred.length).toBeGreaterThan(0);
    expect(ask.receipt.deferred.every((tool) => tool.effect === "observation")).toBe(true);
    expect(ask.receipt.deferred.map((tool) => tool.name)).not.toContain("apply_patch");
  });

  test("makes profile restrictions inspectable while keeping eligible reads", () => {
    const registry = workspaceTools().registry;
    const capabilities = createProductCapabilityRegistry(
      registry.generation,
      registry,
      [],
      () => true,
    );
    const ask = discloseProductTools(capabilities, registry, {
      executionPolicy: resolveExecutionProfile("ask", configurationGeneration.from(7)),
    });
    const agent = discloseProductTools(capabilities, registry, {
      executionPolicy: resolveExecutionProfile("agent", configurationGeneration.from(7)),
    });

    expect(ask.modelTools.map((tool) => tool.name)).toContain("read_file");
    expect(ask.receipt.disclosed.every((tool) => tool.effect === "observation")).toBe(true);
    expect(ask.receipt.omitted).toContainEqual({
      name: "apply_patch",
      reason: "effect mutation denied by ask profile",
    });
    expect(ask.receipt.families).toContainEqual({
      family: "run",
      available: false,
      reason: "no ask-eligible descriptor available in this catalog generation",
    });
    expect(ask.receipt.schemaTokensEstimated).toBeLessThanOrEqual(
      agent.receipt.schemaTokensEstimated,
    );
  });

  test("does not disclose registered tools when the named consumer runtime is unavailable", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(
      createProductCapabilityRegistry(
        tools.registry.generation,
        tools.registry,
        [],
        (id) => tools.runner.hasBinding?.(id) === true,
      ),
      tools.registry,
      {
        consumer: "native-model",
        healthEvidence: {
          runtime: {
            attemptRunner: "missing",
            provider: "missing",
            workspace: "available",
          },
        },
      },
    );

    expect(disclosure.modelTools).toEqual([]);
    expect(disclosure.receipt.omitted).toContainEqual({
      name: "read_file",
      reason: "missing-attempt-runner: model attempt runner is unavailable",
    });
    expect(disclosure.receipt.health.summary).toMatchObject({
      registered: tools.registry.entries.length,
      disclosed: 0,
      selectable: 0,
    });
  });
});

test("explicit-only capabilities require an exact preferred identity before model disclosure", () => {
  const tools = workspaceTools();
  const target = tools.registry.entries.find((entry) => entry.manifest.name === "read_file");
  if (!target) throw new Error("read fixture");
  const capabilities = createProductCapabilityRegistry(
    tools.registry.generation,
    tools.registry,
    [],
    () => true,
    undefined,
    undefined,
    new Set([target.manifest.capabilityId]),
  );
  expect(
    discloseProductTools(capabilities, tools.registry).modelTools.map((tool) => tool.name),
  ).not.toContain("read_file");
  expect(
    discloseProductTools(capabilities, tools.registry, {
      preferredCapabilityIds: [target.manifest.capabilityId],
    }).modelTools.map((tool) => tool.name),
  ).toContain("read_file");
});
