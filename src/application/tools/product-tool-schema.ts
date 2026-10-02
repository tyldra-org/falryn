/** Shared measurement, closed-schema and policy checks for model-bound tools. */

import { createHash } from "node:crypto";
import { z } from "zod";

import type { EffectiveExecutionPolicy } from "../../domain/sessions/index.ts";
import type { ToolRegistry } from "../../domain/tools/index.ts";

/** Process escapes whose open argument shapes are bounded by their own runners. */
export const RAW_PROTOCOL_ESCAPES: ReadonlySet<string> = new Set(["run_process", "run_shell"]);

/** The provider-facing JSON schema of a native tool's input. */
export function jsonSchemaFor(
  schema: z.ZodType<Readonly<Record<string, unknown>>>,
): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema) as Readonly<Record<string, unknown>>;
}

/** Why the execution profile withholds a registered tool, or null when it does not. */
export function policyOmissionReason(
  entry: ToolRegistry["entries"][number],
  policy: EffectiveExecutionPolicy | undefined,
): string | null {
  if (policy === undefined) {
    return null;
  }
  if (policy.deniedToolNames.includes(entry.manifest.name)) {
    return `denied by ${policy.profileId} profile tool policy`;
  }
  if (policy.deniedEffects.includes(entry.manifest.effect)) {
    return `effect ${entry.manifest.effect} denied by ${policy.profileId} profile`;
  }
  return null;
}

export function measureProductToolSchema(schema: Readonly<Record<string, unknown>>) {
  const encoded = JSON.stringify(schema);
  const bytes = new TextEncoder().encode(encoded).byteLength;
  return {
    digest: `sha-256:${createHash("sha256").update(encoded).digest("hex")}`,
    bytes,
    tokensEstimated: Math.ceil(bytes / 4),
  };
}

export function isClosedProductToolSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every(isClosedProductToolSchema);
  const schema = value as Readonly<Record<string, unknown>>;
  for (const union of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(union) && !union.every(isClosedProductToolSchema)) return false;
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) return false;
    if (typeof schema.properties === "object" && schema.properties !== null) {
      for (const property of Object.values(schema.properties)) {
        if (!isClosedProductToolSchema(property)) return false;
      }
    }
  }
  if (
    schema.type === "array" &&
    schema.items !== undefined &&
    !isClosedProductToolSchema(schema.items)
  ) {
    return false;
  }
  if (typeof schema.$defs === "object" && schema.$defs !== null) {
    for (const definition of Object.values(schema.$defs)) {
      if (!isClosedProductToolSchema(definition)) return false;
    }
  }
  return true;
}
