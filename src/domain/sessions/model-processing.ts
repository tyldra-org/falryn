/** Bounded processing facts. Replaying these values never resolves live provider state. */
import { z } from "zod";

export const PROCESSING_MODES = ["provider-default", "standard", "fast"] as const;
export const processingPreferenceSchema = z.strictObject({
  mode: z.enum(PROCESSING_MODES).optional(),
  fallback: z.enum(["stop", "allow-standard"]).optional(),
});
export type ProcessingPreference = z.infer<typeof processingPreferenceSchema>;
export type ResolvedProcessingPreference = {
  readonly mode: (typeof PROCESSING_MODES)[number];
  readonly fallback: "stop" | "allow-standard";
};
export function resolveProcessingPreference(
  layers: readonly (ProcessingPreference | undefined)[],
): ResolvedProcessingPreference {
  return Object.freeze({
    mode: layers.find((layer) => layer?.mode !== undefined)?.mode ?? "provider-default",
    fallback: layers.find((layer) => layer?.fallback !== undefined)?.fallback ?? "stop",
  });
}

const identity = z.string().min(1).max(256);
export const processingNativeTierSchema = z.enum([
  "auto",
  "default",
  "standard",
  "standard_only",
  "priority",
  "fast",
  "flex",
]);
export const processingNativeParametersSchema = z.strictObject({
  serviceTier: processingNativeTierSchema.nullable(),
  speed: z.enum(["standard", "fast"]).nullable(),
});
export const processingObservationSchema = z.strictObject({
  actualMode: z.enum(["standard", "fast", "unknown"]),
  nativeTier: processingNativeTierSchema.nullable(),
  source: z.enum(["provider-start", "provider-final"]),
  observedAt: z.number().int().nonnegative(),
  downgradeReason: z.enum(["capacity", "provider-policy", "unknown"]).nullable(),
  usageAttribution: z.enum(["request", "account", "unknown"]),
});
export type ProcessingObservation = z.infer<typeof processingObservationSchema>;

export const processingPriceSchema = z
  .strictObject({
    sourceUrl: z.string().max(2048).nullable(),
    observedAt: z.string().max(128).nullable(),
    tierIds: z.array(identity).max(64),
    /** Maximum applicable rates, including cache read/write modifiers. */
    inputMicrosPerMillion: z.number().int().nonnegative().nullable(),
    outputMicrosPerMillion: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8192,
    "Processing receipt byte limit exceeded.",
  );
export type ProcessingPrice = z.infer<typeof processingPriceSchema>;
export const processingBindingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    providerId: identity,
    accountId: z.string().min(1).max(4096),
    destinationId: identity,
    modelId: identity,
    operation: identity,
    transportCompatibilityId: identity,
    adapterGeneration: identity.nullable(),
    accountGeneration: identity.nullable(),
    catalogGeneration: z.number().int().nonnegative(),
    configurationGeneration: z.number().int().nonnegative(),
    preference: processingPreferenceSchema.required(),
    resolvedMode: z.enum(PROCESSING_MODES),
    nativeParameters: processingNativeParametersSchema.nullable(),
    price: processingPriceSchema,
    maximumCostMicros: z.number().int().nonnegative().nullable(),
    admission: z.strictObject({ owner: identity, attempt: identity, operation: identity }),
    /** Null preserves the existing prompt-prefix identity. */
    cachePartition: z.enum(PROCESSING_MODES).nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32768,
    "Processing receipt byte limit exceeded.",
  );
export type ProcessingBinding = z.infer<typeof processingBindingSchema>;
export const processingReceiptSchema = z
  .strictObject({
    binding: processingBindingSchema,
    requestId: identity,
    observations: z.array(processingObservationSchema).max(8),
    actualMode: z.enum(["standard", "fast", "unknown"]),
    status: z.enum(["reported", "unrecorded", "conflicting"]),
    /** Conservative usage-based cost; null retains the admission maximum. Not a provider invoice. */
    usageCostMaximumMicros: z.number().int().nonnegative().nullable(),
    settlementPrice: processingPriceSchema.nullable(),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 49152,
    "Processing receipt byte limit exceeded.",
  );
export type ProcessingReceipt = z.infer<typeof processingReceiptSchema>;

export function processingReceipt(
  binding: ProcessingBinding,
  requestId: string,
  observations: readonly ProcessingObservation[],
): ProcessingReceipt {
  const modes = new Set(observations.map((entry) => entry.actualMode));
  const tiers = new Set(
    observations.map((entry) => entry.nativeTier).filter((tier) => tier !== null),
  );
  const conflicting = modes.size > 1 || tiers.size > 1;
  return {
    binding,
    requestId,
    usageCostMaximumMicros: null,
    settlementPrice: null,
    observations: [...observations],
    actualMode: conflicting ? "unknown" : (observations[0]?.actualMode ?? "unknown"),
    status: conflicting ? "conflicting" : observations.length === 0 ? "unrecorded" : "reported",
  };
}
