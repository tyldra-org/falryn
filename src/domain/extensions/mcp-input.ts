/**
 * MCP form input requests (#1154).
 *
 * A current-protocol server that needs user input during tools/call answers with an
 * input_required result. This owner admits one such round, maps each form elicitation onto
 * a structured question, and turns the user's answer back into form content validated
 * against the requested schema. Defaults are shown to the user and never applied for them;
 * anything outside the supported form subset is refused rather than approximated.
 */
import { z } from "zod";
import type { QuestionAnswer, QuestionInput } from "../orchestration/question.ts";
import { canonicalDigest } from "./canonical.ts";

export const MCP_INPUT_LIMITS = Object.freeze({
  /** Input requests one round may carry. */
  requestsPerRound: 4,
  messageBytes: 8192,
  properties: 8,
  /** Answered rounds before another input_required ends the call. */
  rounds: 4,
  /** Times one elicitation is asked, including re-asks after an invalid answer. */
  attempts: 3,
  questionWaitMs: 15 * 60_000,
  /** mcp_call_tool's ceiling, so a question can wait its default time. */
  callCeilingMs: 16 * 60_000,
});
const PROMPT_CHARS = 8192;
const QUESTION_OPTIONS = 32;
const TEXT_BYTES = 16_384;
const DEFAULT_TEXT_BYTES = 4096;
const NUMBER_TEXT_BYTES = 64;

type Scalar = string | number | boolean;
export type McpFormOption = { readonly value: Scalar; readonly label: string };
type FieldBase = {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
};
export type McpFormField =
  | (FieldBase & {
      readonly kind: "choice";
      readonly options: readonly McpFormOption[];
      readonly default: Scalar | null;
    })
  | (FieldBase & {
      readonly kind: "choices";
      readonly options: readonly McpFormOption[];
      readonly minimum: number;
      readonly maximum: number;
      readonly default: readonly Scalar[] | null;
    })
  | (FieldBase & {
      readonly kind: "text";
      readonly type: "string" | "number" | "integer";
      readonly minLength: number | null;
      readonly maxLength: number | null;
      readonly format: "email" | "uri" | "date" | "date-time" | null;
      readonly minimum: number | null;
      readonly maximum: number | null;
      readonly default: Scalar | null;
    });
export type McpFormRequest = {
  /** The server's key for this request within the round. */
  readonly key: string;
  readonly message: string;
  readonly fields: readonly McpFormField[];
  readonly schemaDigest: string;
};
export type McpInputRound =
  | { readonly kind: "complete" }
  | {
      readonly kind: "input";
      readonly requests: readonly McpFormRequest[];
      /** Echoed verbatim on the retry. */
      readonly requestState: string | null;
    }
  | { readonly kind: "unsupported"; readonly code: McpInputRefusal };
export type McpInputRefusal = "mcp-input-request-unsupported" | "mcp-input-result-malformed";
/** The form response sent back for one request. */
export type McpInputResponse =
  | { readonly action: "accept"; readonly content: Readonly<Record<string, unknown>> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };
/** What happened to one request; receipts carry this, never the answer. */
export type McpInputDisposition = "accept" | "decline" | "cancel" | "timeout";

const meta = {
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).max(1024).optional(),
};
const titled = z.array(z.strictObject({ const: z.string().max(256), title: z.string().max(256) }));
const fieldSchema = z.union([
  z.strictObject({
    type: z.literal("string"),
    ...meta,
    enum: z.array(z.string().max(256)).min(1),
    enumNames: z.array(z.string().max(256)).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("string"),
    ...meta,
    oneOf: titled.min(1),
    default: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("string"),
    ...meta,
    minLength: z.int().min(0).max(TEXT_BYTES).optional(),
    maxLength: z.int().min(1).max(TEXT_BYTES).optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: z.string().max(TEXT_BYTES).optional(),
  }),
  z.strictObject({
    type: z.enum(["number", "integer"]),
    ...meta,
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({ type: z.literal("boolean"), ...meta, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal("array"),
    ...meta,
    items: z.union([
      z.strictObject({ type: z.literal("string"), enum: z.array(z.string().max(256)).min(1) }),
      z.strictObject({ anyOf: titled.min(1) }),
    ]),
    minItems: z.int().min(0).optional(),
    maxItems: z.int().min(1).optional(),
    default: z.array(z.string()).optional(),
  }),
]);
const formSchema = z.strictObject({
  $schema: z.string().optional(),
  type: z.literal("object"),
  properties: z.record(z.string().min(1).max(128), z.unknown()),
  required: z.array(z.string()).optional(),
});
const elicitationSchema = z.object({
  method: z.literal("elicitation/create"),
  params: z.object({
    mode: z.literal("form").optional(),
    message: z.string().min(1),
    requestedSchema: z.unknown(),
  }),
});
const roundSchema = z.object({
  resultType: z.literal("input_required"),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
  requestState: z.string().max(65_536).optional(),
});
const requestKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u);
const encoder = new TextEncoder();

function optionsOf(schema: z.infer<typeof fieldSchema>): McpFormOption[] | null {
  if ("enum" in schema)
    return schema.enum.map((value, index) => ({
      value,
      label: schema.enumNames?.[index] || value || "(empty)",
    }));
  if ("oneOf" in schema)
    return schema.oneOf.map((option) => ({
      value: option.const,
      label: option.title || option.const || "(empty)",
    }));
  if (schema.type === "boolean")
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ];
  if (schema.type === "array")
    return "enum" in schema.items
      ? schema.items.enum.map((value) => ({ value, label: value || "(empty)" }))
      : schema.items.anyOf.map((option) => ({
          value: option.const,
          label: option.title || option.const || "(empty)",
        }));
  return null;
}

function fieldOf(name: string, raw: unknown, required: boolean): McpFormField | null {
  const parsed = fieldSchema.safeParse(raw);
  if (!parsed.success) return null;
  const schema = parsed.data;
  const base = {
    name,
    label: schema.title ?? name,
    description: schema.description ?? null,
    required,
  };
  const options = optionsOf(schema);
  if (schema.type === "array") {
    if (!options) return null;
    const minimum = schema.minItems ?? 0;
    const maximum = schema.maxItems ?? options.length;
    if (options.length > QUESTION_OPTIONS || minimum > maximum || maximum > options.length)
      return null;
    return { ...base, kind: "choices", options, minimum, maximum, default: schema.default ?? null };
  }
  if (options) {
    // An optional choice needs room for its skip option.
    if (options.length + (required ? 0 : 1) > QUESTION_OPTIONS) return null;
    return { ...base, kind: "choice", options, default: schema.default ?? null };
  }
  if (schema.type === "string" && !("enum" in schema) && !("oneOf" in schema)) {
    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.minLength > schema.maxLength
    )
      return null;
    return {
      ...base,
      kind: "text",
      type: "string",
      minLength: schema.minLength ?? null,
      maxLength: schema.maxLength ?? null,
      format: schema.format ?? null,
      minimum: null,
      maximum: null,
      default: schema.default ?? null,
    };
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.minimum > schema.maximum
    )
      return null;
    return {
      ...base,
      kind: "text",
      type: schema.type,
      minLength: null,
      maxLength: null,
      format: null,
      minimum: schema.minimum ?? null,
      maximum: schema.maximum ?? null,
      default: schema.default ?? null,
    };
  }
  return null;
}

/** Admit one tools/call result: complete, one input round, or refused. */
export function admitMcpInputRound(value: unknown): McpInputRound {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { resultType?: unknown }).resultType !== "input_required"
  )
    return { kind: "complete" };
  const round = roundSchema.safeParse(value);
  if (!round.success) return { kind: "unsupported", code: "mcp-input-result-malformed" };
  const entries = Object.entries(round.data.inputRequests ?? {});
  if (entries.length === 0 && round.data.requestState === undefined)
    return { kind: "unsupported", code: "mcp-input-result-malformed" };
  const unsupported = { kind: "unsupported", code: "mcp-input-request-unsupported" } as const;
  if (entries.length > MCP_INPUT_LIMITS.requestsPerRound) return unsupported;
  const requests: McpFormRequest[] = [];
  for (const [key, raw] of entries) {
    const elicitation = elicitationSchema.safeParse(raw);
    const form = formSchema.safeParse(elicitation.data?.params.requestedSchema);
    if (!requestKey.safeParse(key).success || !elicitation.success || !form.success)
      return unsupported;
    const message = elicitation.data.params.message;
    const properties = Object.entries(form.data.properties);
    const required = form.data.required ?? [];
    if (
      encoder.encode(message).length > MCP_INPUT_LIMITS.messageBytes ||
      properties.length > MCP_INPUT_LIMITS.properties ||
      required.some((name) => !Object.hasOwn(form.data.properties, name))
    )
      return unsupported;
    const fields: McpFormField[] = [];
    for (const [name, schema] of properties) {
      const field = fieldOf(name, schema, required.includes(name));
      if (!field) return unsupported;
      fields.push(field);
    }
    const request = { key, message, fields, schemaDigest: canonicalDigest(form.data) };
    // Every prompt must fit whole; nothing is shortened to make it fit.
    if (mcpFormItems(request, null).some((item) => item.prompt.length > PROMPT_CHARS))
      return unsupported;
    requests.push(request);
  }
  return { kind: "input", requests, requestState: round.data.requestState ?? null };
}

function display(field: McpFormField, value: Scalar): string {
  if (field.kind === "text") return String(value);
  return field.options.find((option) => option.value === value)?.label ?? String(value);
}

function fieldPrompt(field: McpFormField): string {
  const lines = [`${field.label}${field.required ? "" : " (optional)"}`];
  if (field.description) lines.push(field.description);
  if (field.kind === "text" && field.type === "string") {
    const bounds = [
      field.minLength === null ? null : `at least ${field.minLength} characters`,
      field.maxLength === null ? null : `at most ${field.maxLength} characters`,
      field.format === null ? null : `format ${field.format}`,
    ].filter((line) => line !== null);
    if (bounds.length > 0) lines.push(`Expected: ${bounds.join(", ")}.`);
  }
  if (field.kind === "text" && field.type !== "string") {
    const bounds = [
      field.type === "integer" ? "a whole number" : "a number",
      field.minimum === null ? null : `at least ${field.minimum}`,
      field.maximum === null ? null : `at most ${field.maximum}`,
    ].filter((line) => line !== null);
    lines.push(`Expected: ${bounds.join(", ")}.`);
  }
  if (field.default !== null) {
    const suggested = Array.isArray(field.default)
      ? field.default.map((value) => display(field, value)).join(", ")
      : display(field, field.default as Scalar);
    lines.push(`Server suggestion (not applied): ${suggested}`);
  }
  return lines.join("\n");
}

/** One structured question per request: the server's message leads the first item. */
export function mcpFormItems(
  request: McpFormRequest,
  problem: string | null,
): QuestionInput["items"] {
  const head = problem === null ? request.message : `${problem}\n\n${request.message}`;
  if (request.fields.length === 0) return [{ id: "message", kind: "review", prompt: head }];
  return request.fields.map((field, index) => {
    const prompt = index === 0 ? `${head}\n\n${fieldPrompt(field)}` : fieldPrompt(field);
    const id = `f${index}`;
    const options =
      field.kind === "text"
        ? []
        : field.options.map((option, at) => ({ id: `o${at}`, label: option.label }));
    if (field.kind === "choice")
      return {
        id,
        kind: "single-select" as const,
        prompt,
        options: field.required ? options : [...options, { id: "skip", label: "Skip" }],
      };
    if (field.kind === "choices")
      return {
        id,
        kind: "multi-select" as const,
        prompt,
        options,
        // An optional list may be left empty; the bounds apply once anything is chosen.
        minimum: field.required ? field.minimum : 0,
        maximum: field.maximum,
      };
    const maxBytes =
      field.type === "string"
        ? Math.min(TEXT_BYTES, field.maxLength === null ? DEFAULT_TEXT_BYTES : field.maxLength * 4)
        : NUMBER_TEXT_BYTES;
    return { id, kind: "free-text" as const, prompt, maxBytes };
  });
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function formatProblem(
  format: NonNullable<Extract<McpFormField, { kind: "text" }>["format"]>,
  value: string,
) {
  if (format === "email")
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? null : "an email address";
  if (format === "uri") {
    try {
      return new URL(value).protocol.length > 1 ? null : "a URI";
    } catch {
      return "a URI";
    }
  }
  if (format === "date")
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      ? null
      : "a date like 2026-01-31";
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? null
    : "a date and time like 2026-01-31T09:30:00Z";
}

function textValue(
  field: Extract<McpFormField, { kind: "text" }>,
  text: string,
): { value: Scalar | undefined } | { problem: string } {
  if (text === "") return field.required ? { problem: "is required" } : { value: undefined };
  if (field.type === "string") {
    const length = [...text].length;
    if (field.minLength !== null && length < field.minLength)
      return { problem: `needs at least ${field.minLength} characters` };
    if (field.maxLength !== null && length > field.maxLength)
      return { problem: `allows at most ${field.maxLength} characters` };
    const wrong = field.format === null ? null : formatProblem(field.format, text);
    return wrong === null ? { value: text } : { problem: `must be ${wrong}` };
  }
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!NUMBER.test(trimmed) || !Number.isFinite(value)) return { problem: "must be a number" };
  if (field.type === "integer" && !Number.isInteger(value))
    return { problem: "must be a whole number" };
  if (field.minimum !== null && value < field.minimum)
    return { problem: `must be at least ${field.minimum}` };
  if (field.maximum !== null && value > field.maximum)
    return { problem: `must be at most ${field.maximum}` };
  return { value };
}

type FieldOutcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "omit" }
  | { readonly kind: "problem"; readonly problem: string };

function fieldValue(field: McpFormField, entry: QuestionAnswer[number] | undefined): FieldOutcome {
  const problem = (text: string): FieldOutcome => ({
    kind: "problem",
    problem: `${field.label} ${text}`,
  });
  if (field.kind === "text") {
    if (entry?.kind !== "text") return problem("is missing");
    const result = textValue(field, entry.text);
    if ("problem" in result) return problem(result.problem);
    return result.value === undefined ? { kind: "omit" } : { kind: "value", value: result.value };
  }
  if (entry?.kind !== "selection") return problem("is missing");
  const optionAt = (id: string) =>
    /^o\d+$/.test(id) ? field.options[Number(id.slice(1))] : undefined;
  if (field.kind === "choice") {
    const [id] = entry.optionIds;
    if (id === "skip" && !field.required && entry.optionIds.length === 1) return { kind: "omit" };
    const option = id === undefined ? undefined : optionAt(id);
    return option && entry.optionIds.length === 1
      ? { kind: "value", value: option.value }
      : problem("needs one choice");
  }
  const chosen = entry.optionIds.map(optionAt);
  if (chosen.some((option) => option === undefined)) return problem("has an unknown choice");
  if (chosen.length === 0 && !field.required) return { kind: "omit" };
  if (chosen.length < field.minimum || chosen.length > field.maximum)
    return problem(
      field.minimum === field.maximum
        ? `needs ${field.minimum} choices`
        : `needs ${field.minimum} to ${field.maximum} choices`,
    );
  // Keep the server's option order, whatever order the user picked in.
  return {
    kind: "value",
    value: field.options.filter((option) => chosen.includes(option)).map((option) => option.value),
  };
}

/**
 * Turn an answered question into form content. An answer that does not satisfy the
 * requested schema is never sent; the problem is returned so the question can be asked again.
 */
export function mcpFormContent(
  request: McpFormRequest,
  answer: QuestionAnswer,
):
  | { readonly ok: true; readonly content: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problem: string } {
  const content: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [index, field] of request.fields.entries()) {
    const outcome = fieldValue(
      field,
      answer.find((item) => item.itemId === `f${index}`),
    );
    if (outcome.kind === "problem") problems.push(outcome.problem);
    if (outcome.kind === "value") content[field.name] = outcome.value;
  }
  if (problems.length > 0) return { ok: false, problem: `Not sent: ${problems.join("; ")}.` };
  return { ok: true, content };
}
