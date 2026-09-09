import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { decodeAgentDefinition, validateAgentValue } from "./agent-definition.ts";
import { createAgentRegistry, starterAgentRegistrations } from "./agent-registry.ts";

test("six inert starter definitions have stable identities, distinct contracts, and independent presets", () => {
  const registry = createAgentRegistry(starterAgentRegistrations());
  expect(registry.page().entries.map((entry) => entry.definition.label)).toEqual([
    "Explorer",
    "General",
    "Implementer",
    "Planner",
    "Researcher",
    "Reviewer",
  ]);
  expect(registry.models().map((entry) => "preset" in entry && entry.preset)).toEqual([
    "medium",
    "small",
    "medium",
    "big",
    "medium",
    "big",
  ]);
  for (const entry of registry.page().entries) {
    expect(entry.definition.context).toBe("selected-evidence");
    expect(entry.definition.modelRole).toBe("subagents");
    expect(
      validateAgentValue(entry.definition.inputSchema, { objective: "bounded work" }, 65536),
    ).toBe(true);
    expect(validateAgentValue(entry.definition.resultSchema, { success: true }, 65536)).toBe(false);
    if (!["General", "Implementer"].includes(entry.definition.label)) {
      expect(entry.definition.effects).toEqual(["observation"]);
      expect(entry.definition.nestedDelegation).toBe(false);
    }
  }
});

test("definition edits verify canonical identity and compare the exact previous revision", () => {
  const initial = starterAgentRegistrations()[0];
  if (!initial) throw new Error("missing starter");
  const registry = createAgentRegistry([initial]);
  const previous = registry.page().entries[0];
  if (!previous) throw new Error("missing registration");
  const { identity, ...descriptor } = previous.definition;
  const revised = { ...descriptor, label: "General revised" };
  const registration = {
    ...initial,
    definition: {
      ...revised,
      identity: { ...identity, descriptorDigest: canonicalDigest(revised) },
    },
  };
  expect(registry.register(registration, null)).toMatchObject({
    ok: false,
    code: "stale-agent-definition",
  });
  expect(registry.register(registration, previous.digest).ok).toBe(true);
  expect(registry.resolve(previous.id)?.definition.label).toBe("General revised");
  expect(decodeAgentDefinition({ ...previous.definition, instructions: "tampered" }).ok).toBe(
    false,
  );
  expect(
    registry.register(
      { ...registration, owner: {} },
      registry.resolve(previous.id)?.digest ?? null,
    ),
  ).toMatchObject({ ok: false, code: "agent-owner-mismatch" });
});

test("admitted extension definitions use the same validator and cannot shadow a built-in label", () => {
  const registry = createAgentRegistry(starterAgentRegistrations());
  const builtin = registry.resolve("builtin/falryn/agents:explorer");
  if (!builtin) throw new Error("missing explorer");
  const { identity: _identity, ...descriptor } = builtin.definition;
  const digest = canonicalDigest(descriptor);
  const owner = {
    version: 1,
    packageId: "example",
    packageVersion: null,
    sourceCoordinate: {
      kind: "local",
      rootId: "trusted-fixture",
      path: "example",
      sourceDigest: digest,
    },
    packageDigest: digest,
    manifestDigest: digest,
  };
  const result = registry.register(
    {
      owner,
      provenance: "extension",
      availability: "available",
      reason: null,
      definition: {
        ...descriptor,
        identity: {
          version: 1,
          owner: { kind: "package", digest: canonicalDigest(owner) },
          nativeKind: "subagent",
          namespace: "agents",
          localId: "explorer",
          descriptorDigest: digest,
        },
      },
    },
    null,
  );
  expect(result.ok).toBe(true);
  expect(registry.page("Explorer").entries).toHaveLength(2);
  expect(registry.resolve(builtin.id)).toBe(builtin);
  expect(result.ok && result.value.id).toBe("package/example/agents:explorer");
});
