/** Shared source identities and bounded projections. Bytes remain in their owning store. */
import { z } from "zod";

export const MAX_RESOURCE_SOURCES = 16;
export const MAX_RESOURCE_OUTPUT_BYTES = 64 * 1024;
export const MAX_RESOURCE_SOURCE_BYTES = 8 * 1024 * 1024;
const identity = z.string().min(1).max(2048);
export const resourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), path: identity, root: identity.optional() }).strict(),
  z
    .object({
      kind: z.literal("scratch"),
      handle: identity,
      revision: z.int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("artifact"), artifactId: identity, manifestId: identity }).strict(),
  z.object({ kind: z.literal("virtual"), uri: identity }).strict(),
  z.object({ kind: z.literal("evidence"), reference: identity }).strict(),
]);
export type ResourceTarget = z.infer<typeof resourceTargetSchema>;
export const resourceProjectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact") }).strict(),
  z
    .object({ kind: z.literal("lines"), start: z.int().positive(), end: z.int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("ranges"),
      ranges: z
        .array(z.object({ offset: z.int().nonnegative(), length: z.int().nonnegative() }).strict())
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal("head-tail"),
      headBytes: z.int().nonnegative().max(MAX_RESOURCE_OUTPUT_BYTES),
      tailBytes: z.int().nonnegative().max(MAX_RESOURCE_OUTPUT_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("search"),
      query: z.string().min(1).max(1024),
      maxHits: z.int().positive().max(64).default(16),
    })
    .strict(),
  z.object({ kind: z.literal("outline") }).strict(),
]);
export type ResourceProjection = z.infer<typeof resourceProjectionSchema>;
export const resourceReadInputSchema = z
  .object({
    resources: z.array(resourceTargetSchema).min(1).max(MAX_RESOURCE_SOURCES),
    projection: resourceProjectionSchema.default({ kind: "exact" }),
    maxBytes: z
      .int()
      .positive()
      .max(MAX_RESOURCE_OUTPUT_BYTES)
      .default(16 * 1024),
  })
  .strict();
const resourceSearch = z
  .object({
    resources: z.array(resourceTargetSchema).min(1).max(MAX_RESOURCE_SOURCES),
    query: z.string().min(1).max(1024),
    maxBytes: z
      .int()
      .positive()
      .max(MAX_RESOURCE_OUTPUT_BYTES)
      .default(16 * 1024),
    maxHits: z.int().positive().max(64).default(16),
  })
  .strict();
export const resourceSearchInputSchema = z.union([
  resourceSearch,
  z
    .object({
      mode: z.enum(["paths", "literal", "regex"]),
      query: z.string().min(1).max(1024),
      path: z.string().min(1).max(2048).default("."),
      maxHits: z.int().positive().max(16).default(16),
      maxBytes: z
        .int()
        .positive()
        .max(MAX_RESOURCE_OUTPUT_BYTES)
        .default(16 * 1024),
    })
    .strict(),
]);

export const resourceEvidenceSchema = z
  .object({
    version: z.literal(1),
    workspaceId: identity,
    sessionId: identity,
    root: identity,
    generation: identity,
    target: resourceTargetSchema,
    sourceIdentity: identity,
    revision: identity,
    digest: z.string().regex(/^sha-256:[0-9a-f]{64}$/),
    artifactId: identity.nullable(),
    byteLength: z.int().nonnegative().max(MAX_RESOURCE_SOURCE_BYTES),
    mediaType: z.string().min(1).max(128),
    sensitivity: z.enum(["public", "user-content", "sensitive", "restricted"]),
    trust: z.enum(["user-confirmed", "adapter-declared"]),
    coverage: z
      .array(z.object({ offset: z.int().nonnegative(), length: z.int().nonnegative() }).strict())
      .max(64),
    fidelity: z.enum(["exact", "structural"]),
  })
  .strict();
export type ResourceEvidence = z.infer<typeof resourceEvidenceSchema>;
export type ResourceFailure = { readonly code: string };
export type ResourceSegment = {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
};
export type ResourceReadItem =
  | {
      readonly status: "unavailable";
      readonly target: ResourceTarget;
      readonly code: string;
      readonly reacquisition: "new-read-required";
    }
  | {
      readonly status: "read";
      readonly target: ResourceTarget;
      readonly source: ResourceEvidence;
      readonly reference: ResourceTarget | null;
      readonly segments: readonly ResourceSegment[];
      readonly complete: boolean;
      readonly omissions: readonly string[];
      readonly currentness: "current" | "historical";
      readonly writable: false;
      readonly continuation: { readonly target: ResourceTarget; readonly offset: number } | null;
    };
export type ResourceReadResult = {
  readonly items: readonly ResourceReadItem[];
  readonly aggregateBytes: number;
  readonly consistency: "per-resource";
  readonly complete: boolean;
};
