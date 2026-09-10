import { z } from "zod";
import { digestSchema, identityText } from "./identity.ts";
import { packageDataNameSchema, packageStateOperationSchema } from "./package-data.ts";
import { packageConfigurationLayerSchema } from "./package-data-store.ts";
import { packageDataAdoptionSchema, packageDataBundleSchema } from "./package-data-transfer.ts";

const requestBase = {
  version: z.literal(1),
  operationId: z.string().uuid(),
  expectedRevision: z.int().nonnegative(),
  context: z
    .strictObject({
      profile: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
        .nullable(),
      session: identityText.nullable(),
    })
    .optional(),
  confirmation: digestSchema.optional(),
};
export const packageDataRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...requestBase, operation: z.literal("inspect") }),
  z.strictObject({ ...requestBase, operation: z.literal("export"), exportId: z.string().uuid() }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("import"),
    bundle: packageDataBundleSchema,
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("adopt"),
    adoption: packageDataAdoptionSchema,
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("configuration"),
    layer: packageConfigurationLayerSchema,
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("state"),
    state: packageStateOperationSchema,
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("reset"),
    contribution: identityText.nullable(),
    key: packageDataNameSchema.nullable(),
    target: z.enum(["configuration", "state"]),
    scope: z.string(),
    owner: identityText,
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("rollback"),
    receiptId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    operation: z.literal("fork"),
    from: identityText,
    to: identityText,
    generation: identityText,
  }),
]);
export type PackageDataRequest = z.infer<typeof packageDataRequestSchema>;
