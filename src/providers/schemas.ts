/**
 * Zod schemas for untrusted provider-boundary JSON.
 *
 * Types are inferred or asserted against the hand-written contracts so the
 * schema cannot silently drift. Rejections report path and code only.
 */

import { z } from "zod";

import { brandedString } from "../domain/branded-schema.ts";
import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import { PROVIDER_FAILURE_KINDS } from "./errors.ts";
import { modelRequestId } from "./identity.ts";
import {
  MAX_FINISH_REASON_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_PROVIDER_METADATA_ENTRIES,
  MAX_PROVIDER_METADATA_ENTRY_LENGTH,
  MAX_REQUEST_MESSAGES,
  MAX_REQUEST_TOOLS,
  MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  PROVIDER_BOUNDARY_MINIMUM_SCHEMA_VERSION,
  PROVIDER_BOUNDARY_SCHEMA_VERSION,
} from "./limits.ts";
import { MESSAGE_ROLES } from "./messages.ts";
import { MODEL_ROLES } from "./roles.ts";

const modelRequestIdSchema = z.string().transform((value, ctx) => {
  const parsed = modelRequestId.parse(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error.code });
    return z.NEVER;
  }
  return parsed.value;
});

const textPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string().max(MAX_MESSAGE_TEXT_LENGTH),
});

const imagePartSchema = z.object({
  kind: z.literal("image"),
  handle: z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
  mediaType: z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
});

const messagePartSchema = z.discriminatedUnion("kind", [textPartSchema, imagePartSchema]);

const modelMessageSchema = z.object({
  role: z.literal(MESSAGE_ROLES),
  parts: z.array(messagePartSchema).min(1).max(32),
  toolCallId: z.string().min(1).max(MAX_TOOL_NAME_LENGTH).optional(),
});

const toolDefinitionSchema = z.object({
  name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
  description: z.string().max(MAX_MESSAGE_TEXT_LENGTH),
  parameters: z.record(z.string(), z.unknown()),
});

const outputContractSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({
    kind: z.literal("json-schema"),
    name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
    schema: z.record(z.string(), z.unknown()),
  }),
]);

const budgetsSchema = z
  .object({
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    wallTimeMs: z.number().int().positive().optional(),
  })
  .strict();

const requestMetadataSchema = z
  .object({
    role: z.literal(MODEL_ROLES),
    workIntent: z.string().min(1).max(MAX_TOOL_NAME_LENGTH).optional(),
    configurationGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();

export const modelRequestSchema = z
  .object({
    schemaVersion: z.literal(PROVIDER_BOUNDARY_SCHEMA_VERSION),
    requestId: modelRequestIdSchema,
    providerId: brandedString(providerId),
    modelId: brandedString(modelId),
    messages: z.array(modelMessageSchema).min(1).max(MAX_REQUEST_MESSAGES),
    tools: z.array(toolDefinitionSchema).max(MAX_REQUEST_TOOLS),
    output: outputContractSchema,
    budgets: budgetsSchema,
    metadata: requestMetadataSchema,
  })
  .strict();

const spineSchema = {
  requestId: modelRequestIdSchema,
  modelAttemptId: brandedString(modelAttemptId),
  sequence: z.number().int().positive(),
};

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    provenance: z.literal(["provider-reported", "estimate", "unknown"]),
  })
  .strict();

const failureSchema = z
  .object({
    kind: z.literal(PROVIDER_FAILURE_KINDS),
    retryable: z.boolean(),
    message: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  })
  .strict();

const metadataEntriesSchema = z
  .record(
    z.string().max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
    z.string().max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
  )
  .refine((entries) => Object.keys(entries).length <= MAX_PROVIDER_METADATA_ENTRIES, {
    message: "too_many_metadata_entries",
  });

export const normalizedProviderEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...spineSchema, kind: z.literal("request-started") }),
  z.object({
    ...spineSchema,
    kind: z.literal("text-delta"),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  }),
  z.object({
    ...spineSchema,
    kind: z.literal("reasoning-delta"),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  }),
  z.object({
    ...spineSchema,
    kind: z.literal("tool-call-delta"),
    toolCallId: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
    name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH).optional(),
    argumentsFragment: z.string().max(MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH),
  }),
  z.object({
    ...spineSchema,
    kind: z.literal("tool-proposal"),
    toolCallId: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
    name: z.string().min(1).max(MAX_TOOL_NAME_LENGTH),
    argumentsJson: z.string().min(2).max(MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH),
  }),
  z.object({ ...spineSchema, kind: z.literal("usage"), usage: usageSchema }),
  z.object({
    ...spineSchema,
    kind: z.literal("provider-metadata"),
    entries: metadataEntriesSchema,
  }),
  z.object({
    ...spineSchema,
    kind: z.literal("finished"),
    finishReason: z.string().min(1).max(MAX_FINISH_REASON_LENGTH),
  }),
  z.object({ ...spineSchema, kind: z.literal("error"), failure: failureSchema }),
]);

export function isSupportedProviderSchemaVersion(version: unknown): boolean {
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= PROVIDER_BOUNDARY_MINIMUM_SCHEMA_VERSION &&
    version <= PROVIDER_BOUNDARY_SCHEMA_VERSION
  );
}
