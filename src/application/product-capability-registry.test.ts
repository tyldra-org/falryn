import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  configurationGeneration,
  createCapabilityRegistryEntry,
  createInMemoryFileSystem,
  createStubCommandRunner,
  defaultCapabilityOperationalState,
  localPath,
} from "../domain/index.ts";
import { capabilityEntryFromTool, capabilityFamilyForTool } from "./product-capability-registry.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { mergeProductToolBundles } from "./product-tools-merge.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

function workspaceTools() {
  return composeProductWorkspaceTools({
    generation: configurationGeneration.from(12),
    fileSystem: createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
}

function skillContribution() {
  const document: CapabilityRegistryDocument = {
    namespace: "review",
    name: "change_review",
    version: 2,
    source: "skill",
    kind: "skill",
    title: "Change review",
    summary: "Review a change for correctness and blast radius",
    family: "capability",
    effect: "observation",
    provenance: { sourceId: "skill:change-review", sourceVersion: "2" },
    compatibility: { os: [], arch: [], dependencies: [] },
    limits: {
      maxInputBytes: null,
      maxOutputBytes: null,
      defaultTimeoutMs: null,
      maxConcurrency: null,
    },
    routing: { costClass: "low", latencyClass: "interactive" },
    state: {
      availability: "available",
      availabilityReason: null,
      health: "healthy",
      healthReason: null,
      executable: false,
      executionReason: "instructions load through the skill host",
      operational: defaultCapabilityOperationalState(),
    },
    schemas: { inputDigest: null, outputDigest: null },
  };
  const created = createCapabilityRegistryEntry(document);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe("product capability registry", () => {
  test("adopts stable tool identities and maps them to the permanent families", () => {
    const tools = workspaceTools();
    const readTool = tools.registry.resolveByName("read_file");
    const applyTool = tools.registry.resolveByName("apply_patch");
    expect(readTool).not.toBeNull();
    expect(applyTool).not.toBeNull();
    if (readTool === null || applyTool === null) return;

    const read = capabilityEntryFromTool(readTool);
    const apply = capabilityEntryFromTool(applyTool);
    expect(read.capabilityId).toBe(readTool.manifest.capabilityId);
    expect(read.family).toBe("read");
    expect(apply.family).toBe("edit");
    expect(read.routing).toEqual({ costClass: "unknown", latencyClass: "unknown" });
    expect(read.schemas.inputDigest).toMatch(/^sha-256:[0-9a-f]{64}$/u);
    expect(capabilityFamilyForTool("lsp", "lsp_rename")).toBe("edit");
    expect(capabilityFamilyForTool("computer-use", "click")).toBe("computer");
  });

  test("merges standalone contributions without making them executable tools", () => {
    const tools = workspaceTools();
    const bundle = mergeProductToolBundles(tools.registry.generation, [tools], {
      capabilityEntries: [skillContribution()],
    });
    const skill = bundle.capabilityRegistry.resolveByKey("skill:review/change_review");

    expect(skill?.kind).toBe("skill");
    expect(skill?.state.executable).toBe(false);
    expect(bundle.registry.resolveByName("change_review")).toBeNull();
    expect(bundle.capabilityRegistry.entries).toHaveLength(bundle.registry.entries.length + 1);
  });

  test("discloses one generation-bound compact card without a fake tool schema", () => {
    const tools = workspaceTools();
    const bundle = mergeProductToolBundles(tools.registry.generation, [tools], {
      capabilityEntries: [skillContribution()],
    });
    const disclosure = discloseProductTools(bundle.capabilityRegistry, bundle.registry, {
      task: "Review this change for correctness and blast radius",
      intent: "independentCritique",
    });

    expect(disclosure.receipt.catalogGeneration).toBe(bundle.registry.generation);
    expect(disclosure.receipt.discoveryHandle).toBe("capability-catalog:12");
    expect(disclosure.receipt.capabilityCards).toContainEqual(
      expect.objectContaining({ kind: "skill", title: "Change review" }),
    );
    expect(disclosure.modelTools.map((tool) => tool.name)).not.toContain("change_review");
    expect(disclosure.receipt.registryCounts.skill).toBe(1);
  });
});
