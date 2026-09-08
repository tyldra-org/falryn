import { expect, test } from "bun:test";
import {
  declaredAuthority,
  executableDeclaration,
  executionResources,
} from "../../application/extensions/package-fixtures.ts";
import { isDeclarationSchema } from "./declaration-schema.ts";
import { contributionDeclarationSchema, falrynManifestSchema } from "./manifest.ts";

test("rejects unknown native fields, kinds, dishonest behavior and unbounded declarations", () => {
  const tool = {
    kind: "tool",
    namespace: "fixture",
    id: "run",
    description: "Run",
    authority: { ...declaredAuthority, effects: ["external"] },
    execution: executableDeclaration,
  };
  expect(contributionDeclarationSchema.safeParse(tool).success).toBe(true);
  for (const value of [
    { ...tool, kind: "future" },
    { ...tool, kind: "skill" },
    { ...tool, family: "capability" },
    { ...tool, authority: { ...tool.authority, grant: true } },
    { ...tool, authority: declaredAuthority },
    { ...tool, execution: { ...executableDeclaration, executable: "../escape" } },
    {
      ...tool,
      execution: {
        ...executableDeclaration,
        resources: { ...executionResources, maxConcurrent: 1_000 },
      },
    },
    { ...tool, inputSchema: { type: "imaginary" } },
    { ...tool, outputSchema: { $ref: "https://remote/schema" } },
    {
      ...tool,
      batching: {
        version: 2,
        nativeBatch: true,
        concurrencyScope: "independent",
        background: true,
      },
    },
    { ...tool, kind: "agent", family: "run" },
    { ...tool, kind: "capability-module" },
  ])
    expect(contributionDeclarationSchema.safeParse(value).success).toBe(false);
  expect(falrynManifestSchema.safeParse({ version: 1, install: "auto" }).success).toBe(false);
  expect(
    falrynManifestSchema.safeParse({
      version: 1,
      contributions: Array.from({ length: 1_025 }, () => tool),
    }).success,
  ).toBe(false);
});

test("validates bounded declaration schemas without remote lookup", () => {
  expect(
    isDeclarationSchema({
      type: "object",
      properties: { input: { $ref: "#/$defs/text" } },
      required: ["input"],
      additionalProperties: false,
      $defs: { text: { type: "string", maxLength: 100 } },
    }),
  ).toBe(true);
  for (const schema of [
    { $ref: "#/missing" },
    { properties: [] },
    { type: [] },
    { required: ["a", "a"] },
    { minimum: "1" },
    { multipleOf: 0 },
    { pattern: "[" },
    { future: true },
  ])
    expect(isDeclarationSchema(schema)).toBe(false);
});
