/** Bounded JSON Schema vocabulary for inert contracts. No remote schema resolution. */
const annotations = new Set(["title", "description", "$comment", "format", "$id", "$anchor"]);
const numbers = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const counts = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
]);
const maps = new Set(["properties", "$defs", "patternProperties", "dependentSchemas"]);
const singles = new Set([
  "items",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
]);
const lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

export function isDeclarationSchema(root: unknown): boolean {
  let nodes = 0;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 4_096 || depth > 32) return false;
    if (typeof value === "boolean") return true;
    if (!object(value)) return false;
    for (const [key, entry] of Object.entries(value)) {
      if (annotations.has(key)) {
        if (typeof entry !== "string") return false;
      } else if (numbers.has(key)) {
        if (
          typeof entry !== "number" ||
          !Number.isFinite(entry) ||
          (key === "multipleOf" && entry <= 0)
        )
          return false;
      } else if (counts.has(key)) {
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) return false;
      } else if (maps.has(key)) {
        if (!object(entry) || !Object.values(entry).every((child) => visit(child, depth + 1)))
          return false;
      } else if (singles.has(key)) {
        if (!visit(entry, depth + 1)) return false;
      } else if (lists.has(key)) {
        if (
          !Array.isArray(entry) ||
          entry.length === 0 ||
          !entry.every((child) => visit(child, depth + 1))
        )
          return false;
      } else if (key === "type") {
        if (
          !(typeof entry === "string"
            ? types.has(entry)
            : strings(entry) && entry.length > 0 && entry.every((item) => types.has(item)))
        )
          return false;
      } else if (key === "required") {
        if (!strings(entry)) return false;
      } else if (key === "dependentRequired") {
        if (!object(entry) || !Object.values(entry).every(strings)) return false;
      } else if (key === "enum") {
        if (!Array.isArray(entry) || entry.length === 0) return false;
      } else if (["uniqueItems", "readOnly", "writeOnly", "deprecated"].includes(key)) {
        if (typeof entry !== "boolean") return false;
      } else if (key === "examples") {
        if (!Array.isArray(entry)) return false;
      } else if (key === "pattern") {
        if (typeof entry !== "string" || entry.length > 1_024) return false;
        try {
          new RegExp(entry, "u");
        } catch {
          return false;
        }
      } else if (key === "$schema") {
        if (entry !== "https://json-schema.org/draft/2020-12/schema") return false;
      } else if (key === "$ref") {
        if (typeof entry !== "string" || (entry !== "#" && !entry.startsWith("#/"))) return false;
        let target: unknown = root;
        for (const part of entry.slice(2).split("/")) {
          if (entry === "#") break;
          const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!object(target) || !Object.hasOwn(target, decoded)) return false;
          target = target[decoded];
        }
        if (!object(target) && typeof target !== "boolean") return false;
      } else if (key !== "default" && key !== "const") return false;
    }
    return true;
  };
  return visit(root, 0);
}
