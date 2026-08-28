/** Strict codec for persisted model capability declarations. */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { modelId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "./limits.ts";
import {
  MODEL_CAPABILITY_COMPLETENESSES,
  MODEL_CAPABILITY_SCHEMA_VERSION,
  MODEL_FEATURE_SUPPORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  type ModelCapabilityDeclaration,
} from "./model-capability.ts";

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const modelCapabilityDeclarationSchema = z
  .strictObject({
    schemaVersion: z.literal(MODEL_CAPABILITY_SCHEMA_VERSION),
    modelId: brandedString(modelId),
    displayName: z
      .union([z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH), z.null()])
      .default(null),
    inputModalities: z.array(z.enum(MODEL_INPUT_MODALITIES)).max(MODEL_INPUT_MODALITIES.length),
    outputModalities: z.array(z.enum(MODEL_OUTPUT_MODALITIES)).max(MODEL_OUTPUT_MODALITIES.length),
    tools: z.enum(MODEL_FEATURE_SUPPORTS),
    structuredOutput: z.enum(MODEL_FEATURE_SUPPORTS),
    streaming: z.enum(MODEL_FEATURE_SUPPORTS),
    reasoning: z.enum(MODEL_FEATURE_SUPPORTS),
    reasoningControls: z
      .array(z.string().trim().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH))
      .max(16),
    contextTokens: z.union([z.number().int().positive().max(100_000_000), z.null()]),
    outputTokens: z.union([z.number().int().positive().max(10_000_000), z.null()]),
    completeness: z.enum(MODEL_CAPABILITY_COMPLETENESSES),
  })
  .superRefine((capability, context) => {
    for (const [field, values] of [
      ["inputModalities", capability.inputModalities],
      ["outputModalities", capability.outputModalities],
      ["reasoningControls", capability.reasoningControls],
    ] as const) {
      if (!unique(values)) {
        context.addIssue({ code: "custom", path: [field], message: "duplicate capability value" });
      }
    }
    if (capability.reasoning !== "supported" && capability.reasoningControls.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["reasoningControls"],
        message: "reasoning controls require supported reasoning",
      });
    }
    if (
      capability.contextTokens !== null &&
      capability.outputTokens !== null &&
      capability.outputTokens > capability.contextTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputTokens"],
        message: "output limit exceeds context limit",
      });
    }
  });

export type ModelCapabilityDeclarationParseError = {
  readonly kind: "model-capability-declaration";
  readonly issues: readonly CodecIssue[];
};

export function parseModelCapabilityDeclaration(
  value: unknown,
): Result<ModelCapabilityDeclaration, ModelCapabilityDeclarationParseError> {
  const parsed = modelCapabilityDeclarationSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "model-capability-declaration", issues: toCodecIssues(parsed.error) });
}
