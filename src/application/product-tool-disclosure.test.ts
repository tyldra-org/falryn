import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createInMemoryFileSystem,
  createStubCommandRunner,
  localPath,
  resolveExecutionProfile,
} from "../domain/index.ts";
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

describe("discloseProductTools", () => {
  test("publishes a bounded exact-schema subset with an inspectable receipt", () => {
    const tools = workspaceTools();
    const disclosure = discloseProductTools(tools.registry);

    expect(disclosure.modelTools.length).toBeLessThanOrEqual(MAX_DISCLOSED_PRODUCT_TOOLS);
    expect(disclosure.modelTools.map((tool) => tool.name)).toContain("read_file");
    expect(disclosure.promptTools.map((tool) => tool.name)).toEqual(
      disclosure.modelTools.map((tool) => tool.name),
    );
    expect(disclosure.receipt.catalogGeneration).toBe(configurationGeneration.from(7));
    expect(disclosure.receipt.families.map((entry) => entry.family)).toEqual([
      ...MODEL_CAPABILITY_FAMILIES,
    ]);
    expect(disclosure.receipt.discoveryHandle).toBe("tool-catalog:7");
    expect(disclosure.receipt.schemaBytes).toBeGreaterThan(0);
    expect(disclosure.receipt.schemaTokensEstimated).toBeGreaterThan(0);
    expect(
      disclosure.receipt.disclosed.every((tool) => tool.schemaDigest.startsWith("sha-256:")),
    ).toBe(true);
  });

  test("omits permissive schemas instead of exposing a catch-all boundary", () => {
    const disclosure = discloseProductTools(workspaceTools().registry);

    expect(disclosure.modelTools.map((tool) => tool.name)).not.toContain("write_files");
    expect(disclosure.receipt.omitted).toContainEqual({
      name: "write_files",
      reason: "permissive model-boundary schema",
    });
    const read = disclosure.modelTools.find((tool) => tool.name === "read_file");
    expect(read?.parameters).toMatchObject({ anyOf: expect.any(Array) });
  });

  test("makes profile restrictions inspectable while keeping eligible reads", () => {
    const registry = workspaceTools().registry;
    const ask = discloseProductTools(registry, {
      executionPolicy: resolveExecutionProfile("ask", configurationGeneration.from(7)),
    });
    const agent = discloseProductTools(registry, {
      executionPolicy: resolveExecutionProfile("agent", configurationGeneration.from(7)),
    });

    expect(ask.modelTools.map((tool) => tool.name)).toContain("read_file");
    expect(ask.receipt.disclosed.every((tool) => tool.effect === "observation")).toBe(true);
    expect(ask.receipt.omitted).toContainEqual({
      name: "apply_patch",
      reason: "effect mutation denied by ask profile",
    });
    expect(ask.receipt.schemaTokensEstimated).toBeLessThanOrEqual(
      agent.receipt.schemaTokensEstimated,
    );
  });
});
