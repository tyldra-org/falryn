/**
 * Typed version-1 prompt-template variables (#1169).
 *
 * A package manifest's prompt entry may declare named variables. This module owns
 * that declaration, the parsing of one raw text value into its declared type, the
 * value check and the one deterministic text form a value renders as. Values are
 * literal data: nothing here evaluates, interpolates or resolves them, and no error
 * message ever repeats a value, so a sensitive value cannot leak through a failure.
 *
 * Pure; no I/O.
 */
import { z } from "zod";

const KIB = 1024;
/** Hard ceilings for declarations and values. */
export const PROMPT_VARIABLE_LIMITS = {
  variables: 32,
  descriptionBytes: 512,
  enumValues: 64,
  enumValueBytes: 256,
  stringScalars: 4 * KIB,
  items: 64,
  properties: 32,
  /** Type nesting: a scalar is depth 1; each array or object level adds one. */
  depth: 4,
  /** Undeclared JSON nesting admitted inside an object that allows extras. */
  valueDepth: 8,
  /** Raw text for one value, matching the per-argument ceiling. */
  valueBytes: 4 * KIB,
} as const;

/** Variable and property names; ARGUMENTS stays the compatibility placeholder. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
export function isPromptVariableName(value: string): boolean {
  return NAME.test(value) && value !== "ARGUMENTS";
}

export type PromptVariableType =
  | {
      readonly kind: "string";
      readonly minLength?: number | undefined;
      readonly maxLength?: number | undefined;
    }
  | {
      readonly kind: "number";
      readonly integer?: boolean | undefined;
      readonly minimum?: number | undefined;
      readonly maximum?: number | undefined;
    }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | {
      readonly kind: "array";
      readonly items: PromptVariableType;
      readonly minItems?: number | undefined;
      readonly maxItems: number;
    }
  | {
      readonly kind: "object";
      readonly properties: readonly PromptVariableProperty[];
      /** Whether undeclared keys are kept rather than rejected. */
      readonly additional: boolean;
    };
export type PromptVariableProperty = {
  readonly name: string;
  readonly type: PromptVariableType;
  readonly required: boolean;
};
export type PromptVariable = {
  readonly name: string;
  readonly type: PromptVariableType;
  readonly required: boolean;
  /** A literal JSON value of the declared type; never allowed with required or sensitive. */
  readonly default?: unknown;
  /** Sensitive values are entered by the user only and never recorded outside the draft. */
  readonly sensitive: boolean;
  readonly description: string;
};
export type PromptVariables = {
  readonly version: 1;
  /** Whether undeclared name=value arguments stay positional rather than failing. */
  readonly additional: boolean;
  readonly entries: readonly PromptVariable[];
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const name = z.string().refine(isPromptVariableName);
const count = (max: number) => z.int().min(0).max(max);
const typeSchema: z.ZodType<PromptVariableType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("string"),
      minLength: count(PROMPT_VARIABLE_LIMITS.stringScalars).optional(),
      maxLength: count(PROMPT_VARIABLE_LIMITS.stringScalars).optional(),
    }),
    z.strictObject({
      kind: z.literal("number"),
      integer: z.boolean().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({ kind: z.literal("boolean") }),
    z.strictObject({
      kind: z.literal("enum"),
      values: z
        .array(
          z
            .string()
            .min(1)
            .refine((value) => utf8Bytes(value) <= PROMPT_VARIABLE_LIMITS.enumValueBytes),
        )
        .min(1)
        .max(PROMPT_VARIABLE_LIMITS.enumValues),
    }),
    z.strictObject({
      kind: z.literal("array"),
      items: typeSchema,
      minItems: count(PROMPT_VARIABLE_LIMITS.items).optional(),
      maxItems: z.int().min(1).max(PROMPT_VARIABLE_LIMITS.items),
    }),
    z.strictObject({
      kind: z.literal("object"),
      properties: z
        .array(z.strictObject({ name, type: typeSchema, required: z.boolean().default(false) }))
        .max(PROMPT_VARIABLE_LIMITS.properties),
      additional: z.boolean().default(false),
    }),
  ]),
);

/** The manifest's prompt-entry variables field, version 1. */
export const promptVariablesSchema = z
  .strictObject({
    version: z.literal(1),
    additional: z.boolean().default(false),
    entries: z
      .array(
        z.strictObject({
          name,
          type: typeSchema,
          required: z.boolean().default(false),
          default: z.json().optional(),
          sensitive: z.boolean().default(false),
          description: z
            .string()
            .refine((value) => utf8Bytes(value) <= PROMPT_VARIABLE_LIMITS.descriptionBytes)
            .default(""),
        }),
      )
      .min(1)
      .max(PROMPT_VARIABLE_LIMITS.variables),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(value.entries.map((entry) => entry.name)).size !== value.entries.length)
      reject("duplicate-prompt-variable");
    for (const entry of value.entries) {
      const problem = typeProblem(entry.type, 1);
      if (problem !== null) reject(problem);
      if (entry.default === undefined) continue;
      if (entry.required) reject("required-prompt-variable-default");
      if (entry.sensitive) reject("sensitive-prompt-variable-default");
      if (problem === null && checkPromptVariableValue(entry.type, entry.default, entry.name))
        reject("invalid-prompt-variable-default");
    }
  });

function typeProblem(type: PromptVariableType, depth: number): string | null {
  if (depth > PROMPT_VARIABLE_LIMITS.depth) return "prompt-variable-depth";
  switch (type.kind) {
    case "string":
      return (type.minLength ?? 0) > (type.maxLength ?? PROMPT_VARIABLE_LIMITS.stringScalars)
        ? "prompt-variable-bounds"
        : null;
    case "number":
      return type.minimum !== undefined && type.maximum !== undefined && type.minimum > type.maximum
        ? "prompt-variable-bounds"
        : null;
    case "boolean":
      return null;
    case "enum":
      return new Set(type.values).size === type.values.length ? null : "duplicate-enum-value";
    case "array":
      return (type.minItems ?? 0) > type.maxItems
        ? "prompt-variable-bounds"
        : typeProblem(type.items, depth + 1);
    case "object": {
      if (new Set(type.properties.map((property) => property.name)).size !== type.properties.length)
        return "duplicate-prompt-variable-property";
      for (const property of type.properties) {
        const problem = typeProblem(property.type, depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

const MESSAGES = {
  "variable-missing": "is required",
  "variable-unknown": "is not a declared variable",
  "variable-duplicate": "was given more than once",
  "variable-malformed": "is not readable as its declared type",
  "variable-type": "has the wrong type",
  "variable-constraint": "is outside its declared bounds",
  "variable-limit": "exceeds its size or nesting limit",
} as const;
export type PromptVariableErrorCode = keyof typeof MESSAGES;
/** Names the variable path, never its value. */
export type PromptVariableError = {
  readonly code: PromptVariableErrorCode;
  readonly message: string;
  readonly variable: string;
};

export function promptVariableError(
  code: PromptVariableErrorCode,
  path: string,
): PromptVariableError {
  return { code, message: "variable " + path + " " + MESSAGES[code], variable: path };
}

/** JSON number text only: no hex, no leading plus, no Infinity or NaN. */
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;

/**
 * Read one raw text value (an argument or an entered answer) as its declared type.
 * Strings, enums, numbers and booleans are plain text; arrays and objects are JSON.
 */
export function parsePromptVariableText(
  variable: PromptVariable,
  text: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: PromptVariableError } {
  const fail = (code: PromptVariableErrorCode) => ({
    ok: false as const,
    error: promptVariableError(code, variable.name),
  });
  if (utf8Bytes(text) > PROMPT_VARIABLE_LIMITS.valueBytes) return fail("variable-limit");
  let value: unknown = text;
  switch (variable.type.kind) {
    case "number":
      if (!NUMBER.test(text)) return fail("variable-malformed");
      value = Number(text);
      break;
    case "boolean":
      if (text !== "true" && text !== "false") return fail("variable-malformed");
      value = text === "true";
      break;
    case "array":
    case "object":
      try {
        value = JSON.parse(text);
      } catch {
        return fail("variable-malformed");
      }
      break;
    default:
      break;
  }
  const error = checkPromptVariableValue(variable.type, value, variable.name);
  return error === null ? { ok: true, value } : { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  if (isRecord(value)) return 1 + Math.max(0, ...Object.values(value).map(jsonDepth));
  return 0;
}

/** Check a JSON value against its declared type; null when it conforms. */
export function checkPromptVariableValue(
  type: PromptVariableType,
  value: unknown,
  path: string,
): PromptVariableError | null {
  const fail = (code: PromptVariableErrorCode, at = path) => promptVariableError(code, at);
  switch (type.kind) {
    case "string": {
      if (typeof value !== "string") return fail("variable-type");
      if (utf8Bytes(value) > PROMPT_VARIABLE_LIMITS.valueBytes) return fail("variable-limit");
      const scalars = Array.from(value).length;
      return scalars < (type.minLength ?? 0) ||
        scalars > (type.maxLength ?? PROMPT_VARIABLE_LIMITS.stringScalars)
        ? fail("variable-constraint")
        : null;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("variable-type");
      return (type.integer === true && !Number.isInteger(value)) ||
        (type.minimum !== undefined && value < type.minimum) ||
        (type.maximum !== undefined && value > type.maximum)
        ? fail("variable-constraint")
        : null;
    case "boolean":
      return typeof value === "boolean" ? null : fail("variable-type");
    case "enum":
      if (typeof value !== "string") return fail("variable-type");
      return type.values.includes(value) ? null : fail("variable-constraint");
    case "array": {
      if (!Array.isArray(value)) return fail("variable-type");
      if (value.length > PROMPT_VARIABLE_LIMITS.items) return fail("variable-limit");
      if (value.length < (type.minItems ?? 0) || value.length > type.maxItems)
        return fail("variable-constraint");
      for (const [index, item] of value.entries()) {
        const problem = checkPromptVariableValue(type.items, item, path + "[" + index + "]");
        if (problem !== null) return problem;
      }
      return null;
    }
    case "object": {
      if (!isRecord(value)) return fail("variable-type");
      const declared = new Set(type.properties.map((property) => property.name));
      for (const key of Object.keys(value)) {
        if (declared.has(key)) continue;
        if (!type.additional) return fail("variable-unknown", path + "." + key);
        if (jsonDepth(value[key]) > PROMPT_VARIABLE_LIMITS.valueDepth)
          return fail("variable-limit", path + "." + key);
      }
      for (const property of type.properties) {
        const at = path + "." + property.name;
        if (!Object.hasOwn(value, property.name)) {
          if (property.required) return fail("variable-missing", at);
          continue;
        }
        const problem = checkPromptVariableValue(property.type, value[property.name], at);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isRecord(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/**
 * The one text form of a checked value: strings and enums verbatim, numbers and
 * booleans in JSON form, arrays and objects as JSON with sorted object keys.
 */
export function renderPromptVariableValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

/** What a user is asked to enter, in plain words. */
export function describePromptVariableType(type: PromptVariableType): string {
  switch (type.kind) {
    case "string":
      return type.maxLength === undefined
        ? "text"
        : "text of at most " + type.maxLength + " characters";
    case "number": {
      const noun = type.integer === true ? "a whole number" : "a number";
      if (type.minimum !== undefined && type.maximum !== undefined)
        return noun + " from " + type.minimum + " to " + type.maximum;
      if (type.minimum !== undefined) return noun + " of at least " + type.minimum;
      if (type.maximum !== undefined) return noun + " of at most " + type.maximum;
      return noun;
    }
    case "boolean":
      return "true or false";
    case "enum":
      return "one of " + type.values.join(", ");
    case "array":
      return "a JSON array of up to " + type.maxItems + " items";
    case "object":
      return "a JSON object";
  }
}
