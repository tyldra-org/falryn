/** Strict codec for persisted model capability declarations. */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { modelId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "./limits.ts";
import {
  MODEL_AVAILABILITIES,
  MODEL_CAPABILITY_COMPLETENESSES,
  MODEL_CAPABILITY_PROVENANCES,
  MODEL_CAPABILITY_SCHEMA_VERSION,
  MODEL_FEATURE_SUPPORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  MODEL_RESPONSE_DENSITY_CONTROLS,
  type ModelCapability,
  type ModelCapabilityDeclaration,
} from "./model-capability.ts";
import {
  MODEL_BILLING_MODES,
  MODEL_PRICE_TOKEN_UNIT,
  MODEL_PRICING_KINDS,
  unknownModelPricing,
} from "./model-pricing.ts";

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const nullablePriceSchema = z.union([
  z.number().int().nonnegative().max(1_000_000_000_000),
  z.null(),
]);

const modelPricingSchema = z
  .strictObject({
    kind: z.enum(MODEL_PRICING_KINDS),
    billingMode: z.enum(MODEL_BILLING_MODES),
    currency: z.union([z.literal("USD"), z.null()]),
    tokenUnit: z.literal(MODEL_PRICE_TOKEN_UNIT),
    sourceUrl: z.union([z.string().url().max(2048), z.null()]),
    observedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
    tiers: z
      .array(
        z
          .strictObject({
            id: z.string().trim().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
            label: z.string().trim().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
            serviceTier: z.union([
              z.string().trim().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
              z.null(),
            ]),
            inputTokensFrom: z.number().int().nonnegative().max(100_000_000),
            inputTokensThrough: z.union([
              z.number().int().nonnegative().max(100_000_000),
              z.null(),
            ]),
            effectiveFrom: z.union([z.iso.datetime({ offset: true }), z.null()]),
            effectiveUntil: z.union([z.iso.datetime({ offset: true }), z.null()]),
            utcWindows: z
              .array(
                z
                  .strictObject({
                    startMinuteInclusive: z.number().int().min(0).max(1439),
                    endMinuteExclusive: z.number().int().min(1).max(1440),
                  })
                  .refine(
                    (window) => window.startMinuteInclusive < window.endMinuteExclusive,
                    "invalid UTC pricing window",
                  ),
              )
              .max(8),
            usdMicrosPerMillionTokens: z
              .strictObject({
                input: nullablePriceSchema,
                cachedInput: nullablePriceSchema,
                cacheWriteInput: nullablePriceSchema,
                output: nullablePriceSchema,
              })
              .strict(),
          })
          .strict()
          .superRefine((tier, context) => {
            if (
              tier.inputTokensThrough !== null &&
              tier.inputTokensThrough < tier.inputTokensFrom
            ) {
              context.addIssue({
                code: "custom",
                path: ["inputTokensThrough"],
                message: "pricing tier ends before it starts",
              });
            }
            if (
              tier.effectiveFrom !== null &&
              tier.effectiveUntil !== null &&
              Date.parse(tier.effectiveUntil) <= Date.parse(tier.effectiveFrom)
            ) {
              context.addIssue({
                code: "custom",
                path: ["effectiveUntil"],
                message: "pricing interval ends before it starts",
              });
            }
          }),
      )
      .max(32),
  })
  .strict()
  .superRefine((pricing, context) => {
    if (new Set(pricing.tiers.map((tier) => tier.id)).size !== pricing.tiers.length) {
      context.addIssue({ code: "custom", path: ["tiers"], message: "duplicate pricing tier" });
    }
    if (pricing.kind === "unknown" && pricing.tiers.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["tiers"],
        message: "unknown pricing cannot declare rates",
      });
    }
    if (pricing.kind !== "unknown" && pricing.tiers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["tiers"],
        message: "known pricing requires at least one tier",
      });
    }
    if (
      pricing.kind === "unknown" &&
      (pricing.currency !== null || pricing.billingMode !== "unknown")
    ) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "unknown pricing requires unknown billing and currency",
      });
    }
    if (pricing.kind !== "unknown" && (pricing.currency === null || pricing.sourceUrl === null)) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "known pricing requires currency and source",
      });
    }
  });

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
    responseDensityControls: z
      .array(z.enum(MODEL_RESPONSE_DENSITY_CONTROLS))
      .max(MODEL_RESPONSE_DENSITY_CONTROLS.length)
      .default([]),
    contextTokens: z.union([z.number().int().positive().max(100_000_000), z.null()]),
    outputTokens: z.union([z.number().int().positive().max(10_000_000), z.null()]),
    pricing: modelPricingSchema.default(() => ({
      ...unknownModelPricing(),
      tiers: [],
    })),
    completeness: z.enum(MODEL_CAPABILITY_COMPLETENESSES),
  })
  .superRefine((capability, context) => {
    for (const [field, values] of [
      ["inputModalities", capability.inputModalities],
      ["outputModalities", capability.outputModalities],
      ["reasoningControls", capability.reasoningControls],
      ["responseDensityControls", capability.responseDensityControls],
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

export type ModelCapabilityParseError = {
  readonly kind: "model-capability";
  readonly issues: readonly CodecIssue[];
};

/** Parses one effective catalog row without relaxing the declaration codec. */
export function parseModelCapability(
  value: unknown,
): Result<ModelCapability, ModelCapabilityParseError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({
      kind: "model-capability",
      issues: [{ path: "", code: "invalid_type" }],
    });
  }
  const record = value as Record<string, unknown>;
  const { availability, provenance, ...declarationValue } = record;
  const declaration = parseModelCapabilityDeclaration(declarationValue);
  const validAvailability =
    typeof availability === "string" &&
    (MODEL_AVAILABILITIES as readonly string[]).includes(availability);
  const validProvenance =
    Array.isArray(provenance) &&
    provenance.length > 0 &&
    provenance.length <= MODEL_CAPABILITY_PROVENANCES.length &&
    provenance.every(
      (item) =>
        typeof item === "string" &&
        (MODEL_CAPABILITY_PROVENANCES as readonly string[]).includes(item),
    ) &&
    new Set(provenance).size === provenance.length;
  if (!declaration.ok || !validAvailability || !validProvenance) {
    const issues = declaration.ok ? [] : declaration.error.issues;
    return err({
      kind: "model-capability",
      issues: [
        ...issues,
        ...(validAvailability ? [] : [{ path: "availability", code: "invalid_value" }]),
        ...(validProvenance ? [] : [{ path: "provenance", code: "invalid_value" }]),
      ],
    });
  }
  return ok({
    ...declaration.value,
    availability: availability as ModelCapability["availability"],
    provenance: provenance as unknown as ModelCapability["provenance"],
  });
}
