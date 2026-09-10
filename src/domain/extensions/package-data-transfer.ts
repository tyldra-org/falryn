import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { digestSchema, identityText } from "./identity.ts";
import {
  contributionConfigurationBindingSchema,
  packageConfigurationDeclarationSchema,
  packageDataNameSchema,
  packageStateRecordSchema,
} from "./package-data.ts";
import { packageConfigurationLayerSchema } from "./package-data-store.ts";

export const inertPackageConfigurationSchema = z.strictObject({
  id: digestSchema,
  binding: contributionConfigurationBindingSchema,
  layer: packageConfigurationLayerSchema,
  declarations: z.array(packageConfigurationDeclarationSchema).max(128),
  digest: digestSchema,
});
export const packageDataBundleSchema = z.strictObject({
  version: z.literal(1),
  exportId: z.string().uuid(),
  packageId: identityText,
  configuration: z.array(inertPackageConfigurationSchema).max(128),
  state: z.array(z.strictObject({ id: digestSchema, record: packageStateRecordSchema })).max(1024),
  omissions: z
    .array(
      z.strictObject({
        kind: z.enum(["configuration", "state"]),
        key: packageDataNameSchema,
        reason: identityText,
      }),
    )
    .max(1024),
});
export type PackageDataBundle = z.infer<typeof packageDataBundleSchema>;
export type PackageDataReplay = {
  readonly importId: string;
  readonly exportId: string;
  readonly packageId: string;
  readonly records: readonly {
    readonly source: string;
    readonly identity: PackageDataBundle["state"][number]["record"]["identity"];
    readonly binding: PackageDataBundle["state"][number]["record"]["binding"];
    readonly schemaVersion: number;
    readonly revision: number;
    readonly digest: string;
  }[];
  readonly omitted: number;
};
export type PackageDataImportReceipt = {
  readonly importId: string;
  readonly digest: string;
  readonly packageId: string;
  readonly records: number;
};
export interface PackageDataImportStore {
  read(
    importId: string,
    owner: string,
  ): Result<
    { bundle: PackageDataBundle; receipt: PackageDataImportReceipt } | null,
    { code: string }
  >;
  save(
    importId: string,
    owner: string,
    bundle: PackageDataBundle,
    digest: string,
    signal?: AbortSignal,
  ): Result<PackageDataImportReceipt, { code: string }>;
}
export const packageDataAdoptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("state"),
    importId: z.string().uuid(),
    source: digestSchema,
    scope: z.enum(["user", "workspace", "session"]),
    owner: identityText,
    expectedRevision: z.int().nonnegative(),
    collision: z.enum(["retain", "replace"]).default("retain"),
  }),
  z.strictObject({
    kind: z.literal("configuration"),
    importId: z.string().uuid(),
    source: digestSchema,
    scope: z.enum(["user", "project", "profile"]),
    owner: identityText,
    expectedRevision: z.int().nonnegative(),
    collision: z.enum(["retain", "replace"]).default("retain"),
  }),
]);
export type PackageDataAdoption = z.infer<typeof packageDataAdoptionSchema>;
