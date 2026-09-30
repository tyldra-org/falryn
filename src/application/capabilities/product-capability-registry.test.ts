import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type CapabilityRegistryDocument,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  inspectCapabilityHealth,
} from "../../domain/capabilities/index.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import {
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createCapabilityTrust } from "../extensions/capability-trust.ts";
import { memoryTrustStore, trustFixture } from "../extensions/trust-fixtures.ts";
import { discloseProductTools } from "../tools/product-tool-disclosure.ts";
import { mergeProductToolBundles } from "../tools/product-tools-merge.ts";
import { composeProductWorkspaceTools } from "../tools/product-tools-workspace.ts";
import { capabilityEntryFromTool, capabilityFamilyForTool } from "./product-capability-registry.ts";

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

  describe("ecosystem trust", () => {
    function pluginTool() {
      const entry = createToolRegistryEntry(
        {
          namespace: "extension",
          name: "inspect_fixture",
          version: 1,
          source: "plugin",
          title: "Inspect",
          description: "Read a fixture",
          effect: "observation",
          capabilityKind: "plugin",
          platforms: [],
          limits: defaultToolLimits(),
          concurrency: defaultConcurrencyContract(),
          resultProjection: defaultProjectionContract(),
        },
        {
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({ result: z.string() }).strict(),
        },
      );
      if (!entry.ok) throw new Error(entry.error.code);
      return entry.value;
    }
    function publish(observation: TrustObservation) {
      const trust = createCapabilityTrust(memoryTrustStore(), () => observation);
      const entry = capabilityEntryFromTool(pluginTool(), true, trust);
      const registry = createCapabilityRegistry(configurationGeneration.from(12), [entry]);
      if (!registry.ok) throw new Error(registry.error.code);
      const health = inspectCapabilityHealth(registry.value, "native-model").entries[0];
      if (health === undefined) throw new Error("health");
      return { entry, health };
    }

    test.each([
      ["absent approval", (o: TrustObservation) => o, "ecosystem-trust-required", "denied"],
      [
        "an incompatible host",
        (o: TrustObservation): TrustObservation => ({ ...o, compatibility: "incompatible" }),
        "ecosystem-trust-incompatible",
        "incompatible",
      ],
      [
        "stale evidence",
        (o: TrustObservation): TrustObservation => ({
          ...o,
          evidence: { ...o.evidence, expiresAt: o.now - 1 },
        }),
        "ecosystem-trust-stale",
        "denied",
      ],
      [
        "a revoking advisory",
        (o: TrustObservation): TrustObservation => ({
          ...o,
          evidence: { ...o.evidence, advisory: "revoked" },
        }),
        "ecosystem-trust-revoked",
        "quarantined",
      ],
      [
        "a quarantining advisory",
        (o: TrustObservation): TrustObservation => ({
          ...o,
          evidence: { ...o.evidence, advisory: "quarantined" },
        }),
        "ecosystem-trust-quarantined",
        "quarantined",
      ],
    ] as const)(
      "%s publishes one reason as a distinct, non-selectable health state",
      async (_name, change, reason, state) => {
        const { observation } = await trustFixture();
        const { entry, health } = publish(change(observation));
        expect(entry.state.executable).toBe(false);
        expect(entry.state.availabilityReason).toBe(reason);
        expect(entry.state.executionReason).toBe(reason);
        expect(health.health).toBe(state);
        expect(health.selectable).toBe(false);
        expect(health.diagnostics.map((diagnostic) => diagnostic.message)).toContain(reason);
        expect(health.diagnostics.filter((diagnostic) => diagnostic.message !== reason)).toEqual(
          [],
        );
      },
    );
  });
});
