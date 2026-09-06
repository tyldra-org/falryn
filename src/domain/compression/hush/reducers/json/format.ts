/** Complete JSON key/type projection with values intentionally removed. */

type JsonShape =
  | { readonly kind: "null" | "boolean" | "integer" | "number" | "string" }
  | { readonly kind: "object"; readonly fields: readonly JsonField[] }
  | { readonly kind: "array"; readonly length: number; readonly elements: readonly JsonElement[] };

type JsonField = Readonly<{ key: string; shape: JsonShape }>;
type JsonElement = Readonly<{ count: number; shape: JsonShape }>;

export function formatJsonStructure(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return renderShape(shapeOf(value), 0);
}

function shapeOf(value: unknown): JsonShape {
  if (value === null) {
    return { kind: "null" };
  }
  switch (typeof value) {
    case "boolean":
      return { kind: "boolean" };
    case "number":
      return { kind: Number.isInteger(value) ? "integer" : "number" };
    case "string":
      return { kind: "string" };
    case "object":
      if (Array.isArray(value)) {
        return arrayShape(value);
      }
      return {
        kind: "object",
        fields: Object.entries(value as Readonly<Record<string, unknown>>)
          .sort(([left], [right]) => compareKeys(left, right))
          .map(([key, entry]) => ({ key, shape: shapeOf(entry) })),
      };
    default:
      throw new Error("JSON.parse returned a non-JSON value");
  }
}

function arrayShape(values: readonly unknown[]): JsonShape {
  const elements = new Map<string, { count: number; shape: JsonShape }>();
  for (const value of values) {
    const shape = shapeOf(value);
    const signature = shapeSignature(shape);
    const existing = elements.get(signature);
    elements.set(signature, {
      count: (existing?.count ?? 0) + 1,
      shape: existing?.shape ?? shape,
    });
  }
  return { kind: "array", length: values.length, elements: [...elements.values()] };
}

function shapeSignature(shape: JsonShape): string {
  switch (shape.kind) {
    case "null":
    case "boolean":
    case "integer":
    case "number":
    case "string":
      return shape.kind;
    case "object":
      return `{${shape.fields
        .map((field) => `${JSON.stringify(field.key)}:${shapeSignature(field.shape)}`)
        .join(",")}}`;
    case "array":
      return `[${shape.length}:${shape.elements
        .map((element) => `${element.count}*${shapeSignature(element.shape)}`)
        .join("|")}]`;
  }
}

function renderShape(shape: JsonShape, depth: number): string {
  const indent = "  ".repeat(depth);
  switch (shape.kind) {
    case "null":
    case "boolean":
    case "integer":
    case "number":
    case "string":
      return `${indent}${shape.kind}`;
    case "object": {
      if (shape.fields.length === 0) {
        return `${indent}{}`;
      }
      const fields = shape.fields.flatMap((field) => renderField(field, depth));
      return fields.join("\n");
    }
    case "array":
      return renderArray(shape, depth);
  }
}

function renderField(field: JsonField, depth: number): readonly string[] {
  const indent = "  ".repeat(depth);
  const key = renderKey(field.key);
  if (isPrimitive(field.shape)) {
    return [`${indent}${key} ${field.shape.kind}`];
  }
  if (field.shape.kind === "array") {
    if (isInlineArray(field.shape)) {
      return [`${indent}${key} ${renderArrayTypes(field.shape)}[${field.shape.length}]`];
    }
    return [
      `${indent}${key}[${field.shape.length}]:`,
      ...renderArrayElements(field.shape, depth + 1),
    ];
  }
  return [`${indent}${key}:`, renderShape(field.shape, depth + 1)];
}

function renderArray(shape: Extract<JsonShape, { kind: "array" }>, depth: number): string {
  const indent = "  ".repeat(depth);
  if (shape.length === 0) {
    return `${indent}[]`;
  }
  if (isInlineArray(shape)) {
    return `${indent}${renderArrayTypes(shape)}[${shape.length}]`;
  }
  return [`${indent}array[${shape.length}]:`, ...renderArrayElements(shape, depth + 1)].join("\n");
}

function renderArrayElements(
  shape: Extract<JsonShape, { kind: "array" }>,
  depth: number,
): readonly string[] {
  if (shape.elements.length === 1) {
    const element = shape.elements[0];
    return element === undefined ? [] : [renderShape(element.shape, depth)];
  }
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const element of shape.elements) {
    lines.push(`${indent}shape×${element.count}:`);
    lines.push(renderShape(element.shape, depth + 1));
  }
  return lines;
}

function renderArrayTypes(shape: Extract<JsonShape, { kind: "array" }>): string {
  return shape.elements.map((element) => element.shape.kind).join("|");
}

function isPrimitive(shape: JsonShape): boolean {
  return !["array", "object"].includes(shape.kind);
}

function isInlineArray(shape: JsonShape): boolean {
  return (
    shape.kind === "array" &&
    shape.elements.length > 0 &&
    shape.elements.every((element) => isPrimitive(element.shape))
  );
}

function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(key) ? key : JSON.stringify(key);
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
