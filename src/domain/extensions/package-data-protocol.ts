import { z } from "zod";
import { identityText } from "./identity.ts";
import {
  contributionConfigurationBindingSchema,
  packageConfigurationSnapshotSchema,
  packageDataValueSchema,
  packageStateOperationSchema,
} from "./package-data.ts";
import { packageDataReceiptSchema } from "./package-data-store.ts";

/** This contract grants no authority. The supervisor supplies a separately admitted binding. */
export const packageDataProtocolRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    version: z.literal(1),
    operation: z.literal("configuration"),
    binding: contributionConfigurationBindingSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    operation: z.literal("state"),
    binding: contributionConfigurationBindingSchema,
    operationId: z.string().uuid(),
    expectedRevision: z.int().nonnegative(),
    state: packageStateOperationSchema,
  }),
]);
export const packageDataProtocolResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("failed"), code: identityText }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("configuration"),
    snapshot: packageConfigurationSnapshotSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("read"),
    value: z.array(packageDataValueSchema).max(64).or(packageDataValueSchema),
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("completed"),
    receipt: packageDataReceiptSchema,
  }),
]);
export type PackageDataProtocolResponse = z.infer<typeof packageDataProtocolResponseSchema>;
