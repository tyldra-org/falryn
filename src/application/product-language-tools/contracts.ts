/** Shared contracts for strict model-facing LSP and DAP tools (#805). */

import { z } from "zod";

import type {
  EffectClass,
  ToolInvocationOutcome,
  ToolManifestDocument,
} from "../../domain/index.ts";
import {
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/index.ts";
import type { ToolRunnerRequest } from "../tool-call-loop.ts";

export const serviceIdSchema = z.string().min(1).max(256);
export const generationSchema = z.number().int().nonnegative();
export const uriSchema = z.string().min(1).max(4_096);
export const pathSchema = z.string().min(1).max(4_096);
export const boundedTextSchema = z.string().max(4 * 1_024 * 1_024);

const MAX_PROTOCOL_JSON_DEPTH = 8;
const MAX_PROTOCOL_JSON_ITEMS = 256;
const MAX_PROTOCOL_JSON_BYTES = 256 * 1_024;
const protocolStringSchema = z.string().max(64 * 1_024);
const encoder = new TextEncoder();

function encodedJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function boundedProtocolJsonSchema(depth: number): z.ZodType<unknown> {
  const primitive = z.union([protocolStringSchema, z.number().finite(), z.boolean(), z.null()]);
  if (depth === 0) return primitive;
  const child = z.lazy(() => boundedProtocolJsonSchema(depth - 1));
  const array = z.array(child).max(MAX_PROTOCOL_JSON_ITEMS);
  const object = z
    .record(z.string().min(1).max(256), child)
    .superRefine((value, context) => {
      if (Object.keys(value).length > MAX_PROTOCOL_JSON_ITEMS) {
        context.addIssue({ code: "custom", message: "too many protocol object keys" });
      }
    })
    .meta({ maxProperties: MAX_PROTOCOL_JSON_ITEMS });
  return z.union([primitive, array, object]);
}

export const boundedProtocolObjectSchema = z
  .record(z.string().min(1).max(256), boundedProtocolJsonSchema(MAX_PROTOCOL_JSON_DEPTH))
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_PROTOCOL_JSON_ITEMS) {
      context.addIssue({ code: "custom", message: "too many protocol object keys" });
      return;
    }
    if (encodedJsonBytes(value) > MAX_PROTOCOL_JSON_BYTES) {
      context.addIssue({ code: "custom", message: "protocol object is too large" });
    }
  })
  .meta({ maxProperties: MAX_PROTOCOL_JSON_ITEMS });

export const boundedStringMapSchema = z
  .record(z.string().min(1).max(256), z.string().max(64 * 1_024))
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_PROTOCOL_JSON_ITEMS) {
      context.addIssue({ code: "custom", message: "too many map keys" });
      return;
    }
    if (encodedJsonBytes(value) > MAX_PROTOCOL_JSON_BYTES) {
      context.addIssue({ code: "custom", message: "map is too large" });
    }
  })
  .meta({ maxProperties: MAX_PROTOCOL_JSON_ITEMS });

export const sessionSchema = {
  serviceId: serviceIdSchema,
  generation: generationSchema,
} as const;

export const positionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();

export const rangeSchema = z
  .object({
    start: positionSchema,
    end: positionSchema,
  })
  .strict();

export const sessionInputSchema = z.object(sessionSchema).strict();
export const positionInputSchema = z
  .object({
    ...sessionSchema,
    uri: uriSchema,
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();

export const resultOutputSchema = z
  .object({
    result: z.json(),
    workspaceIndex: z.json().optional(),
    languageDiagnostics: z.json().optional(),
  })
  .strict();

export type StrictRecordSchema = z.ZodType<Readonly<Record<string, unknown>>>;

export type ProductLanguageToolDefinition = {
  readonly document: ToolManifestDocument;
  readonly inputSchema: StrictRecordSchema;
  readonly outputSchema: StrictRecordSchema;
  readonly effectFor?: (input: Readonly<Record<string, unknown>>) => EffectClass;
  readonly execute: (request: ToolRunnerRequest) => Promise<ToolInvocationOutcome>;
};

export function toolDocument(options: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effect: EffectClass;
  readonly capabilityKind: "lsp" | "dap";
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): ToolManifestDocument {
  return {
    namespace: "workspace",
    name: options.name,
    version: 1,
    source: "builtin",
    title: options.title,
    description: options.description,
    effect: options.effect,
    capabilityKind: options.capabilityKind,
    platforms: [],
    limits: defaultToolLimits({
      defaultTimeoutMs: options.timeoutMs ?? 60_000,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 2 }),
    resultProjection: defaultProjectionContract(),
  };
}

export function completed(value: unknown): ToolInvocationOutcome {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return failed("unserializable-result");
  }
  if (serialized === undefined) {
    return failed("unserializable-result");
  }
  const result: unknown = JSON.parse(serialized);
  return {
    status: "completed",
    output: { result },
    effect: "completed",
  };
}

export function failed(code: string): ToolInvocationOutcome {
  return { status: "failed", reason: code, effect: "none" };
}

export function unavailable(code: string): ToolInvocationOutcome {
  return { status: "unavailable", reason: code, effect: "none" };
}

export function errorCode(error: { readonly code?: string; readonly kind?: string }): string {
  return typeof error.code === "string"
    ? error.code
    : typeof error.kind === "string"
      ? error.kind
      : "failed";
}

export function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  request: ToolRunnerRequest,
): z.infer<T> | null {
  const parsed = schema.safeParse(request.input);
  return parsed.success ? parsed.data : null;
}
