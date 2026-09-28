/**
 * Package MCP tool hook handlers (#1174). A package names one tool on a server the user
 * configured, the input schema digest its mapping was written against, the explicit
 * envelope fields sent as arguments and the structured result field holding the decision.
 * The call itself goes through the session's ordinary gateway; nothing here dispatches.
 */
import { ExtensionInputError } from "./canonical.ts";
import type { HookRegistration } from "./hook-handlers.ts";
import type { HookEnvelope } from "./hook-points.ts";
import { hookMappedValues } from "./hook-protocol.ts";
import { isRemoteHookDeclaration } from "./hook-remote.ts";
import type { ContributionDeclaration } from "./manifest.ts";

export type McpHookRegistration = HookRegistration & {
  readonly handler: Extract<HookRegistration["handler"], { kind: "mcp-tool-v1" }>;
};

/** An MCP hook sends no credential of its own: the configured server owns authentication. */
export function mcpHookContract(declaration: ContributionDeclaration): McpHookRegistration {
  const registration = declaration.hook;
  const handler = registration?.handler;
  if (
    registration === undefined ||
    handler?.kind !== "mcp-tool-v1" ||
    !isRemoteHookDeclaration(declaration, [])
  )
    throw new ExtensionInputError("hook-mcp-declaration-invalid");
  return { ...registration, handler };
}

/**
 * The tool arguments, each read from exactly the envelope field its mapping names. An
 * absent optional field is omitted; the tool schema decides whether that is allowed.
 */
export function mcpHookArguments(
  registration: McpHookRegistration,
  envelope: HookEnvelope,
): Record<string, unknown> {
  return hookMappedValues(registration.handler.arguments, envelope);
}

/**
 * The decision candidate: only the declared field of an object structured result. Text,
 * images, annotations and every other field are untrusted data and never read.
 */
export function mcpHookDecisionCandidate(structured: unknown, field: string): unknown {
  if (structured === null || typeof structured !== "object" || Array.isArray(structured))
    return undefined;
  return Object.hasOwn(structured, field)
    ? (structured as Readonly<Record<string, unknown>>)[field]
    : undefined;
}
