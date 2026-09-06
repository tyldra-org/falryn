/** Shared measurement and closed-schema checks for model-bound tools. */

import { createHash } from "node:crypto";

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
