import { z } from "zod";
import { canonicalJson } from "../extensions/canonical.ts";

/** The bounded JSON Schema subset accepted by definitions; executable expressions are excluded. */
export const definitionValueSchema = z
  .record(z.string(), z.json())
  .superRefine((value, context) => {
    let nodes = 0;
    const visit = (schema: unknown, depth: number): boolean => {
      if (
        ++nodes > 256 ||
        depth > 16 ||
        schema === null ||
        typeof schema !== "object" ||
        Array.isArray(schema)
      )
        return false;
      const item = schema as Record<string, unknown>;
      const keys = new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "enum",
        "description",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
      ]);
      if (Object.keys(item).some((key) => !keys.has(key))) return false;
      if (
        !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
          String(item.type),
        )
      )
        return false;
      if (item.type === "object") {
        if (
          item.additionalProperties !== false ||
          item.properties === null ||
          typeof item.properties !== "object" ||
          Array.isArray(item.properties)
        )
          return false;
        if (!Object.values(item.properties).every((child) => visit(child, depth + 1))) return false;
      }
      return item.type !== "array" || visit(item.items, depth + 1);
    };
    try {
      if (Buffer.byteLength(canonicalJson(value)) > 65_536 || !visit(value, 0))
        throw new Error("invalid");
      z.fromJSONSchema(value);
    } catch {
      context.addIssue({ code: "custom", message: "unsupported-or-unbounded-definition-schema" });
    }
  });

export function validateDefinitionValue(
  schema: Record<string, unknown>,
  value: unknown,
  maximum: number,
): boolean {
  try {
    return (
      Buffer.byteLength(canonicalJson(value)) <= maximum &&
      z.fromJSONSchema(schema).safeParse(value).success
    );
  } catch {
    return false;
  }
}
