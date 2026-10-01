import { describe, expect, test } from "bun:test";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import type { GitPort } from "../../domain/git/index.ts";
import { resolveExecutionProfile } from "../../domain/sessions/index.ts";
import { lowerProfileProposals } from "../../domain/tools/index.ts";
import { responsesToolSchema } from "../../integrations/providers/openai-responses-sdk-adapter/tool-schema.ts";
import { createProductCapabilityRegistry } from "../capabilities/product-capability-registry.ts";
import { GIT_OPERATION_PROFILES } from "./product-operation-profiles.ts";
import { discloseProductTools, jsonSchemaFor, projectProfiles } from "./product-tool-disclosure.ts";
import { isClosedProductToolSchema, measureProductToolSchema } from "./product-tool-schema.ts";
import { composeProductGitTools } from "./product-tools-git.ts";

const generation = configurationGeneration.from(3);

function gitDisclosure(mode: "debug" | "agent", task?: string) {
  // Disclosure never calls Git; the port only has to exist.
  const tools = composeProductGitTools({
    generation,
    git: {} as GitPort,
    gitExecutable: "/usr/bin/git",
    startPath: "/repo",
  });
  const disclosure = discloseProductTools(
    createProductCapabilityRegistry(
      generation,
      tools.registry,
      [],
      (id) => tools.runner.hasBinding?.(id) === true,
    ),
    tools.registry,
    {
      executionPolicy: resolveExecutionProfile(mode, generation),
      ...(task === undefined ? {} : { task }),
    },
  );
  return { tools, disclosure };
}

describe("Git operation profiles in disclosure (#946)", () => {
  test("the model sees one inspect profile while every member stays disclosed natively", () => {
    const { tools, disclosure } = gitDisclosure("debug");
    const names = disclosure.modelTools.map((tool) => tool.name);
    expect(names).toContain("git_inspect");
    expect(names.some((name) => name.startsWith("git_") && name !== "git_inspect")).toBe(false);
    // Debug denies mutation, so neither mutating profile exists.
    expect(disclosure.receipt.profiles.map((profile) => profile.name)).toEqual(["git_inspect"]);

    const profile = disclosure.receipt.profiles[0];
    if (profile === undefined) throw new Error("expected a profile");
    expect(profile).toMatchObject({ profileId: "git.inspect", version: 1 });
    // Each operation binds its exact native identity, which the gateway set keeps.
    const disclosedNames = disclosure.receipt.disclosed.map((tool) => tool.name);
    for (const operation of profile.operations) {
      const entry = tools.registry.resolveByName(operation.toolName);
      expect(entry?.manifest.capabilityId).toBe(operation.capabilityId);
      expect(entry?.manifest.version).toBe(operation.toolVersion);
      expect(operation.effect).toBe("observation");
      expect(disclosedNames).toContain(operation.toolName);
    }
    // Declared operations not offered are listed with the reason, never hidden.
    const declared = GIT_OPERATION_PROFILES[0]?.members.map((member) => member.operation) ?? [];
    expect(
      [...profile.operations, ...profile.omittedOperations]
        .map((operation) => operation.operation)
        .sort(),
    ).toEqual([...declared].sort());
    for (const omitted of profile.omittedOperations)
      expect(omitted.reason.length).toBeGreaterThan(0);
  });

  test("the profile schema is closed and carries each operation's native schema unchanged", () => {
    const { tools, disclosure } = gitDisclosure("debug");
    const definition = disclosure.modelTools.find((tool) => tool.name === "git_inspect");
    const profile = disclosure.receipt.profiles[0];
    if (definition === undefined || profile === undefined) throw new Error("expected git_inspect");
    expect(isClosedProductToolSchema(definition.parameters)).toBe(true);
    const parameters = definition.parameters as {
      properties: Record<string, unknown> & { operation: { enum: string[] } };
      required: string[];
    };
    expect(parameters.required).toEqual(["operation"]);
    expect(parameters.properties.operation.enum).toEqual(
      profile.operations.map((operation) => operation.operation),
    );
    for (const operation of profile.operations) {
      const entry = tools.registry.resolveByName(operation.toolName);
      if (entry === null) throw new Error(`missing ${operation.toolName}`);
      const { $schema: _header, ...native } = jsonSchemaFor(entry.manifest.inputSchema);
      expect(parameters.properties[operation.operation]).toEqual(native);
    }
    expect(measureProductToolSchema(definition.parameters).digest).toBe(profile.schemaDigest);
  });

  test("records whole-definition cost beside the members' and keeps the native totals", () => {
    const { disclosure } = gitDisclosure("debug");
    const profile = disclosure.receipt.profiles[0];
    if (profile === undefined) throw new Error("expected a profile");
    const definition = disclosure.modelTools.find((tool) => tool.name === "git_inspect");
    expect(profile.definitionBytes).toBe(
      new TextEncoder().encode(JSON.stringify(definition)).byteLength,
    );
    expect(profile.memberDefinitionBytes).toBeGreaterThan(0);
    // `schemaBytes` keeps its meaning (every disclosed native); emitted is what is sent.
    expect(disclosure.receipt.schemaBytes).toBe(
      disclosure.receipt.disclosed.reduce((total, tool) => total + tool.schemaBytes, 0),
    );
    const emitted = disclosure.modelTools
      .filter((tool) => tool.deferred !== true)
      .reduce((total, tool) => total + measureProductToolSchema(tool.parameters).bytes, 0);
    expect(disclosure.receipt.emittedSchemaBytes).toBe(emitted);
  });

  test("a deferred member is reported as deferred, not as unregistered", () => {
    const { disclosure } = gitDisclosure("agent");
    const reasons = disclosure.receipt.profiles.flatMap((profile) =>
      profile.omittedOperations.map((operation) => operation.reason),
    );
    expect(reasons).not.toContain("not registered in this generation");
  });

  test("a profile name a registered tool already uses is never emitted", () => {
    const names = ["git_status", "git_diff"];
    const clear = projectProfiles(names, { resolveByName: () => null });
    expect(clear.map((item) => item.kind)).toEqual(["profile"]);
    const taken = projectProfiles(names, {
      resolveByName: (name) => (name === "git_inspect" ? ({} as never) : null),
    });
    expect(taken).toEqual([
      { kind: "native", name: "git_status" },
      { kind: "native", name: "git_diff" },
    ]);
  });

  test("survives a strict-schema provider dialect and still lowers to the native call", () => {
    // OpenAI Responses strict mode makes every property required and nullable.
    const { disclosure } = gitDisclosure("debug");
    const definition = disclosure.modelTools.find((tool) => tool.name === "git_inspect");
    if (definition === undefined) throw new Error("expected git_inspect");
    const codec = responsesToolSchema(definition.parameters);
    const wire = codec.encode({ operation: "status", status: { maxEntries: 3 } }) as Record<
      string,
      unknown
    >;
    expect(wire.operation).toBe("status");
    expect(Object.values(wire).filter((value) => value === null).length).toBeGreaterThan(0);
    const decoded = codec.decode(wire);
    expect(
      lowerProfileProposals(disclosure.receipt.profiles, [
        { toolCallId: "call-1", name: "git_inspect", arguments: decoded },
      ]),
    ).toEqual({
      ok: true,
      value: [{ toolCallId: "call-1", name: "git_status", arguments: { maxEntries: 3 } }],
    });
  });
});
