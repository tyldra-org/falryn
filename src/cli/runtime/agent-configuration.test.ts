import { expect, test } from "bun:test";
import { agentRegistryFrom, userAgentDefinitionsSchema } from "./agent-configuration.ts";

test("configuration creation, edit and disable register an exact user definition without execution", () => {
  const starter = agentRegistryFrom({}).resolve("builtin/falryn/agents:explorer");
  if (!starter) throw new Error("missing explorer");
  const { identity: _identity, ...definition } = starter.definition;
  const entry = { namespace: "custom", localId: "explorer", enabled: true, definition };
  const settings = { version: 1, entries: [entry] };
  const first = agentRegistryFrom({
    "agents.definitions": JSON.parse(JSON.stringify(settings)),
  }).resolve("user/custom:explorer");
  expect(first).toMatchObject({ provenance: "user", availability: "available" });
  const edited = {
    version: 1,
    entries: [
      { ...entry, enabled: false, definition: { ...definition, label: "My source inspector" } },
    ],
  };
  const second = agentRegistryFrom({
    "agents.definitions": JSON.parse(JSON.stringify(edited)),
  }).resolve("user/custom:explorer");
  expect(second?.id).toBe(first?.id);
  expect(second?.digest).not.toBe(first?.digest);
  expect(second?.availability).toBe("disabled");
  expect(
    userAgentDefinitionsSchema.safeParse({ version: 1, entries: [entry, entry] }).success,
  ).toBe(false);
  expect(
    userAgentDefinitionsSchema.safeParse({
      version: 1,
      entries: [{ ...entry, namespace: "invalid:namespace" }],
    }).success,
  ).toBe(false);
  expect(
    userAgentDefinitionsSchema.safeParse({
      version: 1,
      entries: [{ ...entry, definition: { ...definition, instructions: "x".repeat(64 * 1024) } }],
    }).success,
  ).toBe(false);
});
