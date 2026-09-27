import { expect, test } from "bun:test";
import { ExtensionInputError } from "./canonical.ts";
import { hookFixtureEnvelope, mcpHookDeclaration } from "./hook-fixtures.ts";
import { hookRegistrationSchema } from "./hook-handlers.ts";
import { mcpHookArguments, mcpHookContract, mcpHookDecisionCandidate } from "./hook-mcp.ts";
import { hookDecisionBinding } from "./hook-protocol.ts";
import { contributionDeclarationSchema } from "./manifest.ts";

const DIGEST = "d".repeat(64);
const declaration = mcpHookDeclaration("allow", DIGEST);
const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ExtensionInputError ? error.code : String(error);
  }
};

test("an MCP hook starts no package code and names no credential of its own", () => {
  expect(mcpHookContract(declaration).handler).toMatchObject({
    kind: "mcp-tool-v1",
    serverId: "decisions",
    toolId: "allow",
    schemaDigest: DIGEST,
    outputField: "decision",
  });
  for (const authority of [
    { secretReferences: ["token"] },
    { destinations: ["https://example.test/"] },
    { effects: ["observation"] },
    { effects: ["external", "mutation"] },
    { roots: ["workspace"] },
  ])
    expect(
      code(() =>
        mcpHookContract(
          contributionDeclarationSchema.parse({
            ...declaration,
            authority: { ...declaration.authority, ...authority },
          }),
        ),
      ),
    ).not.toBeNull();
});

test("arguments come only from the named envelope fields at the hook's point", () => {
  const envelope = hookFixtureEnvelope();
  expect(mcpHookArguments(mcpHookContract(declaration), envelope)).toEqual({
    binding: hookDecisionBinding(envelope),
    capability: "builtin:workspace/read_file@1",
  });
  const registration = declaration.hook;
  if (registration === undefined) throw new Error("missing hook");
  const withArguments = (args: unknown) =>
    hookRegistrationSchema.safeParse({
      ...registration,
      handler: { ...registration.handler, arguments: args },
    });
  expect(withArguments([{ name: "subject", from: "subjectId" }]).success).toBe(true);
  // Unknown fields, fields of another point and duplicate names are refused.
  for (const args of [
    [{ name: "input", from: "payload.input" }],
    [{ name: "terminal", from: "payload.terminal" }],
    [
      { name: "same", from: "factId" },
      { name: "same", from: "subjectId" },
    ],
  ])
    expect(withArguments(args).success).toBe(false);
});

test("the decision is read only from the declared field of an object result", () => {
  expect(mcpHookDecisionCandidate({ decision: { kind: "observe" } }, "decision")).toEqual({
    kind: "observe",
  });
  for (const structured of [null, "decision", [{ decision: 1 }], { other: 1 }])
    expect(mcpHookDecisionCandidate(structured, "decision")).toBeUndefined();
  expect(mcpHookDecisionCandidate(Object.create({ decision: 1 }), "decision")).toBeUndefined();
});
