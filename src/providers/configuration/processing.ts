/** Exact destination qualification; SDK family alone never grants a processing capability. */
import { z } from "zod";
import {
  processingNativeParametersSchema,
  processingNativeTierSchema,
} from "../../domain/sessions/model-processing.ts";

const identity = z.string().min(1).max(256);
const modeSchema = z.strictObject({
  support: z.enum(["supported", "unsupported", "unknown"]),
  nativeParameters: processingNativeParametersSchema.nullable(),
  /** Every possible charge tier, including automatic downgrades, or null if unknown. */
  priceTierIds: z.array(identity).min(1).max(64).nullable(),
});
export const processingQualificationSchema = z.strictObject({
  providerId: identity,
  destinationId: identity,
  modelId: identity,
  operation: identity,
  transportVersion: identity,
  evidenceUrl: z
    .url()
    .max(2048)
    .refine((url) => {
      const parsed = new URL(url);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    }),
  checkedAt: z.iso.date(),
  modes: z.strictObject({ "provider-default": modeSchema, standard: modeSchema, fast: modeSchema }),
  actualTiers: z
    .array(
      z.strictObject({
        nativeTier: processingNativeTierSchema,
        mode: z.enum(["standard", "fast"]),
      }),
    )
    .max(7),
  cachePartitionByMode: z.boolean(),
});
export type ProcessingQualification = z.infer<typeof processingQualificationSchema>;
/** Live local authority, separate from provider support and catalog evidence. No I/O. */
export type ProcessingAuthority = {
  readonly accountGeneration: string;
  readonly adapterGeneration: string;
  readonly authorized: boolean;
  readonly capacity: "available" | "unavailable" | "unknown";
};

export const processingQualificationsSchema = z
  .array(processingQualificationSchema)
  .max(128)
  .refine(
    (entries) =>
      new Set(
        entries.map((entry) =>
          JSON.stringify([entry.providerId, entry.destinationId, entry.modelId, entry.operation]),
        ),
      ).size === entries.length,
    "Duplicate processing qualification.",
  );
