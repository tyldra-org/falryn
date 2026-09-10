/** Package data is host-owned. These codecs describe data, never execution authority. */
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "./canonical.ts";
import { versionRangeSchema } from "./dependencies.ts";
import { digestSchema, EXTENSION_SCOPES, exactVersionSchema, identityText } from "./identity.ts";
import { packageArtifactReferenceSchema } from "./package-artifacts.ts";

export const PACKAGE_DATA_LIMITS = {
  valueBytes: 65_536,
  receiptBytes: 65_536,
  namespaceBytes: 1_048_576,
  packageBytes: 8_388_608,
  globalBytes: 67_108_864,
  contributionBytes: 2_097_152,
  scopeBytes: 4_194_304,
  records: 1_024,
  page: 64,
  changes: 1_024,
  migrations: 32,
  retainedOperations: 1_024,
  diagnostics: 32,
} as const;
export const packageDataNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/u)
  .refine(
    (name) => !name.split(".").some((p) => ["__proto__", "prototype", "constructor"].includes(p)),
  );
const boundedJsonSchema = z.unknown().superRefine((value, ctx) => {
  try {
    if (Buffer.byteLength(canonicalJson(value)) > PACKAGE_DATA_LIMITS.valueBytes)
      ctx.addIssue({ code: "custom", message: "value-byte-limit" });
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid-bounded-json" });
  }
});
export const packageDataValueSchema = boundedJsonSchema.pipe(z.json());

/** Deliberately small schema vocabulary; unsupported JSON Schema semantics fail closed. */
export type PackageValueSchema = {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null" | "artifact";
  nullable?: boolean | undefined;
  enum?: z.infer<typeof packageDataValueSchema>[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  maxLength?: number | undefined;
  maxItems?: number | undefined;
  properties?: Record<string, PackageValueSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: false | undefined;
  items?: PackageValueSchema | undefined;
};
const recursiveValueSchema: z.ZodType<PackageValueSchema> = z.lazy(() =>
  z
    .strictObject({
      type: z.enum([
        "string",
        "number",
        "integer",
        "boolean",
        "object",
        "array",
        "null",
        "artifact",
      ]),
      enum: z.array(packageDataValueSchema).min(1).max(64).optional(),
      nullable: z.boolean().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      maxLength: z.int().nonnegative().max(65_536).optional(),
      maxItems: z.int().nonnegative().max(1_024).optional(),
      properties: z.record(packageDataNameSchema, recursiveValueSchema).optional(),
      required: z.array(packageDataNameSchema).max(128).optional(),
      additionalProperties: z.literal(false).optional(),
      items: recursiveValueSchema.optional(),
    })
    .refine((schema) => {
      const numeric = schema.type === "number" || schema.type === "integer";
      if (!numeric && (schema.minimum !== undefined || schema.maximum !== undefined)) return false;
      if ((schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)) return false;
      if (schema.type !== "string" && schema.maxLength !== undefined) return false;
      if (schema.type !== "array" && (schema.items !== undefined || schema.maxItems !== undefined))
        return false;
      if (schema.type === "array" && schema.items === undefined) return false;
      if (schema.type !== "object")
        return (
          schema.properties === undefined &&
          schema.required === undefined &&
          schema.additionalProperties === undefined
        );
      const keys = Object.keys(schema.properties ?? {});
      return (
        schema.additionalProperties === false &&
        keys.length <= 128 &&
        new Set(schema.required).size === (schema.required?.length ?? 0) &&
        (schema.required ?? []).every((key) => keys.includes(key))
      );
    }, "invalid-schema-vocabulary"),
);
export const packageValueSchema: z.ZodType<PackageValueSchema> = z
  .unknown()
  .superRefine((value, ctx) => {
    try {
      if (Buffer.byteLength(canonicalJson(value)) > 16_384) throw new Error("schema-byte-limit");
      const inspect = (schema: unknown, depth: number): void => {
        if (depth > 8) throw new Error("schema-depth-limit");
        if (schema === null || typeof schema !== "object") return;
        const object = schema as Record<string, unknown>;
        if (object.items !== undefined) inspect(object.items, depth + 1);
        if (object.properties !== null && typeof object.properties === "object")
          for (const child of Object.values(object.properties)) inspect(child, depth + 1);
      };
      inspect(value, 0);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid-bounded-schema" });
    }
  })
  .pipe(recursiveValueSchema);
export const packageStateMigrationSchema = z
  .strictObject({
    version: z.literal(1),
    from: z.int().positive(),
    to: z.int().positive(),
    steps: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("rename"),
            from: packageDataNameSchema,
            to: packageDataNameSchema,
          }),
          z.strictObject({
            kind: z.literal("default"),
            key: packageDataNameSchema,
            value: packageDataValueSchema,
          }),
          z.strictObject({ kind: z.literal("remove"), key: packageDataNameSchema }),
        ]),
      )
      .max(32),
  })
  .refine((m) => m.from !== m.to);
export type PackageStateMigration = z.infer<typeof packageStateMigrationSchema>;
export const packageConfigurationDeclarationSchema = z.strictObject({
  version: z.literal(1),
  id: packageDataNameSchema,
  contribution: identityText.nullable().default(null),
  schemaVersion: z.int().positive(),
  schema: packageValueSchema,
  default: packageDataValueSchema,
  scopes: z
    .array(z.enum(["user", "project", "profile", "environment", "cli"]))
    .min(1)
    .max(5),
  sensitivity: z.enum(["public", "sensitive", "credential-reference"]),
  merge: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("replace") }),
    z.strictObject({ kind: z.literal("merge-map") }),
    z.strictObject({ kind: z.literal("merge-by-identity"), identityField: packageDataNameSchema }),
  ]),
  application: z.enum([
    "live",
    "next-operation",
    "next-turn",
    "contribution-restart",
    "host-restart",
  ]),
  compatibility: versionRangeSchema,
  deprecation: z
    .strictObject({
      replacement: packageDataNameSchema.nullable(),
      removedInSchemaVersion: z.int().positive(),
    })
    .nullable()
    .default(null),
  migrations: z.array(packageStateMigrationSchema).max(PACKAGE_DATA_LIMITS.migrations).default([]),
  dependencies: z.array(packageDataNameSchema).max(32).default([]),
});
export type PackageConfigurationDeclaration = z.infer<typeof packageConfigurationDeclarationSchema>;
export const packageStateDeclarationSchema = z.strictObject({
  version: z.literal(1),
  id: packageDataNameSchema,
  contribution: identityText.nullable().default(null),
  schemaVersion: z.int().positive(),
  schema: packageValueSchema,
  scopes: z.array(z.enum(EXTENSION_SCOPES)).min(1).max(5),
  sensitivity: z.enum(["public", "sensitive", "restricted"]),
  retention: z.enum(["session", "until-uninstall", "preserve"]),
  cleanup: z.enum(["remove", "preserve", "confirm"]),
  maxBytes: z.int().positive().max(PACKAGE_DATA_LIMITS.valueBytes),
  maxRecords: z.int().positive().max(PACKAGE_DATA_LIMITS.records),
  fork: z.enum(["omit", "copy"]),
  export: z.enum(["omit", "inert"]),
  migrations: z.array(packageStateMigrationSchema).max(PACKAGE_DATA_LIMITS.migrations).default([]),
});
export type PackageStateDeclaration = z.infer<typeof packageStateDeclarationSchema>;
export const packageStateKeySchema = z.strictObject({
  version: z.literal(1),
  packageId: identityText,
  contribution: identityText.nullable(),
  family: packageDataNameSchema,
  key: packageDataNameSchema,
  scope: z.enum(EXTENSION_SCOPES),
  owner: identityText,
});
export type PackageStateKey = z.infer<typeof packageStateKeySchema>;
export const packageStateRevisionSchema = z.int().nonnegative();
export const contributionConfigurationBindingSchema = z.strictObject({
  version: z.literal(1),
  packageId: identityText,
  packageDigest: digestSchema,
  packageVersion: exactVersionSchema,
  contribution: identityText.nullable(),
  packageRevision: packageStateRevisionSchema,
  configurationGeneration: packageStateRevisionSchema,
  catalogGeneration: identityText,
  workspaceGeneration: identityText.nullable(),
  sessionGeneration: identityText.nullable(),
  protocolGeneration: identityText,
  authority: digestSchema,
});
export type ContributionConfigurationBinding = z.infer<
  typeof contributionConfigurationBindingSchema
>;
export const packageConfigurationSnapshotSchema = z.strictObject({
  version: z.literal(1),
  binding: contributionConfigurationBindingSchema,
  digest: digestSchema,
  values: z.record(packageDataNameSchema, packageDataValueSchema),
  diagnostics: z
    .array(z.strictObject({ code: identityText, key: packageDataNameSchema }))
    .max(PACKAGE_DATA_LIMITS.diagnostics),
});
export type PackageConfigurationSnapshot = z.infer<typeof packageConfigurationSnapshotSchema>;
export const packageStateRecordSchema = z.strictObject({
  version: z.literal(1),
  identity: packageStateKeySchema,
  binding: contributionConfigurationBindingSchema,
  schemaVersion: z.int().positive(),
  revision: packageStateRevisionSchema,
  value: packageDataValueSchema,
  digest: digestSchema,
  bytes: z.int().nonnegative(),
  sensitivity: z.enum(["public", "sensitive", "restricted"]),
  retention: z.enum(["session", "until-uninstall", "preserve"]),
  tombstone: z.boolean(),
  createdAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
});
export type PackageStateRecord = z.infer<typeof packageStateRecordSchema>;
export const packageConfigurationDiagnosticSchema = z.strictObject({
  version: z.literal(1),
  code: identityText,
  key: packageDataNameSchema.nullable(),
});
export type PackageConfigurationDiagnostic = z.infer<typeof packageConfigurationDiagnosticSchema>;
export const packageConfigurationChangeSchema = z.strictObject({
  version: z.literal(1),
  key: packageDataNameSchema,
  before: digestSchema.nullable(),
  after: digestSchema.nullable(),
  application: packageConfigurationDeclarationSchema.shape.application,
});
export const packageStateOperationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    version: z.literal(1),
    operation: z.literal("get"),
    identity: packageStateKeySchema,
  }),
  z.strictObject({
    version: z.literal(1),
    operation: z.literal("list-metadata"),
    identity: packageStateKeySchema,
    after: packageDataNameSchema.nullable().default(null),
    limit: z.int().positive().max(64).default(32),
  }),
  z.strictObject({
    version: z.literal(1),
    operation: z.enum(["put", "compare-and-set"]),
    identity: packageStateKeySchema,
    expectedRevision: packageStateRevisionSchema,
    value: packageDataValueSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    operation: z.literal("delete"),
    identity: packageStateKeySchema,
    expectedRevision: packageStateRevisionSchema,
  }),
]);
export type PackageStateOperation = z.infer<typeof packageStateOperationSchema>;
export const packageStateOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ version: z.literal(1), status: z.literal("failed"), code: identityText }),
  z.strictObject({
    version: z.literal(1),
    status: z.literal("completed"),
    revision: packageStateRevisionSchema,
    digest: digestSchema.nullable(),
    value: packageDataValueSchema.optional(),
  }),
]);
export type PackageStateOutcome = z.infer<typeof packageStateOutcomeSchema>;

export function packageDataIdentity(key: PackageStateKey): string {
  return canonicalDigest(key);
}
export function matchesPackageSchema(schema: PackageValueSchema, value: unknown): boolean {
  try {
    const encoded = canonicalJson(schema);
    if (Buffer.byteLength(encoded) > 16_384) return false;
    const checked = packageValueSchema.parse(JSON.parse(encoded));
    const validate = (s: PackageValueSchema, v: unknown, depth: number): boolean => {
      if (depth > 8) return false;
      if (v === null && s.nullable === true) return true;
      if (s.enum && !s.enum.some((item) => canonicalJson(item) === canonicalJson(v))) return false;
      switch (s.type) {
        case "artifact":
          return packageArtifactReferenceSchema.safeParse(v).success;
        case "null":
          return v === null;
        case "boolean":
          return typeof v === "boolean";
        case "string":
          return typeof v === "string" && v.length <= (s.maxLength ?? 4096);
        case "integer":
        case "number":
          return (
            typeof v === "number" &&
            Number.isFinite(v) &&
            (s.type !== "integer" || Number.isSafeInteger(v)) &&
            v >= (s.minimum ?? -Number.MAX_SAFE_INTEGER) &&
            v <= (s.maximum ?? Number.MAX_SAFE_INTEGER)
          );
        case "array":
          return (
            Array.isArray(v) &&
            v.length <= (s.maxItems ?? 128) &&
            s.items !== undefined &&
            v.every((item) => validate(s.items as PackageValueSchema, item, depth + 1))
          );
        case "object": {
          if (
            v === null ||
            typeof v !== "object" ||
            Array.isArray(v) ||
            s.additionalProperties !== false
          )
            return false;
          const entries = Object.entries(v);
          return (
            entries.length <= 128 &&
            (s.required ?? []).every((key) => Object.hasOwn(v, key)) &&
            entries.every(([key, item]) => {
              const property = Object.hasOwn(s.properties ?? {}, key)
                ? s.properties?.[key]
                : undefined;
              return property !== undefined && validate(property, item, depth + 1);
            })
          );
        }
      }
    };
    return validate(checked, value, 0);
  } catch {
    return false;
  }
}
