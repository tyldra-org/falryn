import { z } from "zod";
import { CONFIGURATION_SCOPES } from "../configuration/configuration.ts";
import type { Result } from "../foundation/result.ts";
import { bytesDigest, ExtensionInputError } from "./canonical.ts";
import { digestSchema, identityText } from "./identity.ts";
import {
  type ContributionConfigurationBinding,
  contributionConfigurationBindingSchema,
  PACKAGE_DATA_LIMITS,
  packageConfigurationDeclarationSchema,
  packageDataNameSchema,
  packageDataValueSchema,
  packageStateDeclarationSchema,
  packageStateRecordSchema,
} from "./package-data.ts";

export const packageConfigurationLayerSchema = z.strictObject({
  scope: z.enum(CONFIGURATION_SCOPES),
  owner: identityText,
  revision: z.int().nonnegative(),
  values: z.record(packageDataNameSchema, packageDataValueSchema),
});
export const packageDataDeclarationsSchema = z.strictObject({
  configuration: z.array(packageConfigurationDeclarationSchema).max(128),
  state: z.array(packageStateDeclarationSchema).max(128),
});
export type PackageDataDeclarations = z.infer<typeof packageDataDeclarationsSchema>;
export const packageDataDocumentSchema = z.strictObject({
  version: z.literal(1),
  packageId: identityText,
  revision: z.int().nonnegative(),
  configurationRevision: z.int().positive(),
  packageDigest: digestSchema,
  declarations: packageDataDeclarationsSchema,
  layers: z.array(packageConfigurationLayerSchema).max(128),
  records: z.array(packageStateRecordSchema).max(1024),
});
export type PackageDataDocument = z.infer<typeof packageDataDocumentSchema>;
const adoptionPlanSchema = z.strictObject({
  importId: z.string().uuid(),
  source: digestSchema,
  sourceDigest: digestSchema,
  kind: z.enum(["configuration", "state"]),
  scope: z.enum(["user", "project", "profile", "workspace", "session"]),
  owner: identityText,
  expectedRevision: z.int().nonnegative(),
  omissions: z.int().nonnegative(),
  migrations: z
    .array(z.strictObject({ key: identityText, from: z.int().positive(), to: z.int().positive() }))
    .max(128),
});
export const packageDataReceiptSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().uuid(),
  packageId: identityText,
  fingerprint: digestSchema,
  beforeRevision: z.int().nonnegative(),
  afterRevision: z.int().nonnegative(),
  beforeDigest: digestSchema,
  afterDigest: digestSchema,
  status: z.enum(["completed", "retained", "unchanged"]),
  changes: z
    .array(
      z.strictObject({
        key: identityText,
        outcome: z.enum(["created", "replaced", "retained", "deleted", "unchanged"]),
        application: packageConfigurationDeclarationSchema.shape.application.optional(),
      }),
    )
    .max(PACKAGE_DATA_LIMITS.changes),
  binding: contributionConfigurationBindingSchema,
  adoption: adoptionPlanSchema.optional(),
});
export type PackageDataReceipt = z.infer<typeof packageDataReceiptSchema>;
export type PackageDataError = { readonly code: string };
export interface PackageDataStore {
  checkArtifacts?(
    document: PackageDataDocument,
    allowClaim: boolean,
  ): Result<null, PackageDataError>;
  read(packageId: string): Result<PackageDataDocument | null, PackageDataError>;
  receipt(operationId: string): Result<PackageDataReceipt | null, PackageDataError>;
  commit(
    input: {
      readonly binding: ContributionConfigurationBinding;
      readonly before: PackageDataDocument;
      readonly after: PackageDataDocument;
      readonly receipt: PackageDataReceipt;
      /** Recheck host authority while the writer owns the transaction. */
      readonly authorize: () => boolean;
      readonly allowArtifactClaim?: boolean;
    },
    signal?: AbortSignal,
  ): Result<PackageDataReceipt, PackageDataError>;
  recovery(operationId: string): Result<PackageDataDocument | null, PackageDataError>;
}

export function encodePackageData(document: PackageDataDocument): string {
  const text = JSON.stringify(packageDataDocumentSchema.parse(document));
  if (Buffer.byteLength(text) > PACKAGE_DATA_LIMITS.packageBytes)
    throw new ExtensionInputError("package-quota-exceeded");
  return text;
}
export function packageDocumentDigest(document: PackageDataDocument): string {
  return bytesDigest(encodePackageData(document));
}
