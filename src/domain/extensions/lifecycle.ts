import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { dependencyCandidateSchema } from "./dependencies.ts";
import { digestSchema, identityText, packageIdentityV1Schema } from "./identity.ts";
import { packageDataRequestSchema } from "./package-data-control.ts";
import { type PackageDataDocument, packageDataDeclarationsSchema } from "./package-data-store.ts";
import { packageHealthRequestSchema } from "./package-health.ts";
import type { PackageSnapshot } from "./package-source.ts";

export const PACKAGE_ACTIONS = [
  "inspect",
  "data",
  "install",
  "update",
  "rollback",
  "disable",
  "uninstall",
  "recover",
  "enable",
  "health",
] as const;
export const packageRequestSchema = z.strictObject({
  packageId: identityText,
  operationId: z.string().uuid(),
  expectedRevision: z.int().nonnegative(),
  sourcePath: z.string().min(1).max(4096).optional(),
  versionDigest: digestSchema.optional(),
  retention: z.enum(["retain", "remove"]).default("retain"),
  dataCleanup: z
    .strictObject({
      configuration: z.enum(["retain", "remove"]),
      state: z.enum(["retain", "declared"]),
    })
    .optional(),
  confirmation: digestSchema.optional(),
  data: packageDataRequestSchema.optional(),
  health: packageHealthRequestSchema.optional(),
});
export type PackageRequest = z.infer<typeof packageRequestSchema>;
export type PackageAction = (typeof PACKAGE_ACTIONS)[number];
export const installedVersionSchema = z.strictObject({
  identity: packageIdentityV1Schema,
  identityDigest: digestSchema,
  sourceId: identityText,
  ownership: z.strictObject({
    sourceOwner: identityText.nullable(),
    publisher: identityText.nullable(),
  }),
  dependencies: z.array(dependencyCandidateSchema).max(256),
  byteLength: z.int().nonnegative().max(67_108_864),
  fileCount: z.int().nonnegative().max(4096),
  storageId: z.string().uuid(),
  state: z.enum(["staged", "retained", "deleting", "deleted"]),
  dataDeclarations: packageDataDeclarationsSchema.optional(),
});
export type InstalledVersion = z.infer<typeof installedVersionSchema>;
export type InstalledPackage = {
  readonly packageId: string;
  readonly revision: number;
  readonly current: InstalledVersion | null;
};
export const packageReceiptSchema = z.strictObject({
  action: z.enum(PACKAGE_ACTIONS),
  operationId: z.string().uuid(),
  packageId: identityText,
  status: z.enum(["preview", "completed", "failed", "partial", "uncertain"]),
  code: identityText,
  priorRevision: z.int().nonnegative(),
  revision: z.int().nonnegative(),
  priorDigest: digestSchema.nullable(),
  currentDigest: digestSchema.nullable(),
  activation: z.literal("unavailable"),
  confirmation: digestSchema.nullable(),
  retainedVersions: z.int().nonnegative(),
  pendingCleanup: z.int().nonnegative(),
  recovery: z.enum(["none", "inspect", "fresh-preview", "recover"]),
  dataEffect: z.enum(["none", "completed"]).optional(),
  data: z.json().optional(),
});
export type PackageReceipt = z.infer<typeof packageReceiptSchema>;
export type LifecycleError = { readonly code: string };
export interface PackageBytes {
  /** Only storage IDs minted and persisted by the lifecycle owner are accepted. */
  stage(id: string, snapshot: PackageSnapshot, signal: AbortSignal): void;
  read(version: InstalledVersion, signal: AbortSignal): Promise<PackageSnapshot>;
  remove(id: string, signal: AbortSignal): Promise<void>;
}
export type PackageOperation = {
  readonly fingerprint: string;
  readonly receipt: PackageReceipt;
};
export interface PackageLifecycleStore {
  data?(packageId: string): Result<PackageDataDocument | null, LifecycleError>;
  current(packageId: string): Result<InstalledPackage, LifecycleError>;
  version(packageId: string, digest: string): Result<InstalledVersion | null, LifecycleError>;
  operation(id: string): Result<PackageOperation | null, LifecycleError>;
  /** Persist ownership before the first byte write; duplicate identities cannot overwrite bytes. */
  stage(version: InstalledVersion): Result<number, LifecycleError>;
  publish(
    input: {
      readonly expected: InstalledPackage;
      readonly candidate: InstalledVersion | null;
      readonly remove: boolean;
      readonly fingerprint: string;
      readonly receipt: PackageReceipt;
      readonly expectedCounts: {
        readonly retained: number;
        readonly pending: number;
        readonly epoch: number;
      };
      /** Bounded byte publication runs while the SQLite writer owns this transaction. */
      readonly stageBytes?: () => void;
      readonly dataPublication?: {
        readonly expectedRevision: number;
        readonly document: PackageDataDocument;
      };
    },
    signal: AbortSignal,
  ): Result<PackageReceipt, LifecycleError>;
  /** Claims only unreferenced owned versions; publication and rollback reject claimed bytes. */
  cleanup(
    packageId: string,
    limit: number,
    throughEpoch: number,
  ): Result<readonly InstalledVersion[], LifecycleError>;
  removed(storageId: string): Result<null, LifecycleError>;
  counts(
    packageId: string,
  ): Result<{ retained: number; pending: number; epoch: number }, LifecycleError>;
}
