import { expect, test } from "bun:test";
import { MARKING_REDACTOR } from "../../config/fixtures.ts";
import { createConfigurationRegistry } from "../../config/index.ts";
import { createProductSandbox, SANDBOX_CONFIGURATION_KEYS } from "./sandbox-configuration.ts";

test("only the trusted user layer can select sandbox authority", () => {
  const registry = createConfigurationRegistry({
    declarations: SANDBOX_CONFIGURATION_KEYS,
    redactor: MARKING_REDACTOR,
  });
  const document = {
    schemaVersion: 1,
    tools: { sandbox: { version: 1, mode: "off", readRoots: [], writeRoots: [] } },
  };
  expect(registry.validateLayer(document, { scope: "user", sourceKind: "user-file" }).ok).toBe(
    true,
  );
  for (const context of [
    { scope: "project", sourceKind: "project-file" },
    { scope: "profile", sourceKind: "profile" },
    { scope: "environment", sourceKind: "environment" },
    { scope: "cli", sourceKind: "cli-override" },
  ] as const) {
    const result = registry.validateLayer(document, context);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "scope-unavailable")).toBe(true);
  }
});

test("missing accepted configuration refuses executable access instead of choosing off", () => {
  const sandbox = createProductSandbox({
    values: () => ({}),
    configuration: () => null,
    generation: () => 0,
    now: Date.now,
    workspaceRoot: null,
  });
  const result = sandbox.prepare({
    executable: process.execPath,
    argv: [],
    environment: {},
    channel: "command",
  });
  expect(result.kind === "refused" && result.receipt.reason).toBe("sandbox-invalid-policy");
  expect(result.kind === "refused" && result.receipt.pid).toBeNull();
});
