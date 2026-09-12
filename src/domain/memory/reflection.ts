/** Derived reflection state has source lineage, never memory or instruction authority. */
import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { MEMORY_KINDS, MEMORY_SCOPE_KINDS, MEMORY_SENSITIVITIES } from "./memory-record.ts";

export const REFLECTION_LIMITS = {
  requestsPerSession: 256,
  generations: 8,
  sourceEvents: 256,
  sourceBytes: 4 * 1024 * 1024,
  candidates: 32,
  contentBytes: 8192,
  provenance: 16,
  projectionBytes: 65536,
  publications: 64,
  invalidations: 32,
  page: 32,
  coverageRanges: 256,
  recordBytes: 512 * 1024,
  leaseMs: 300000,
  validationMs: 30000,
} as const;
export const reflectionReference = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/u);
export const reflectionNumber = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const reflectionDigestSchema = z.string().regex(/^sha-256:[a-f0-9]{64}$/u);
export const reflectionBindingSchema = z.strictObject({
  sessionId: reflectionReference,
  workspaceId: reflectionReference,
  streamId: reflectionReference,
  repository: reflectionReference.nullable(),
  branch: reflectionReference.nullable(),
  worktree: reflectionReference.nullable(),
  sourceGeneration: reflectionReference,
  configurationGeneration: reflectionNumber,
  policyGeneration: reflectionReference,
  authorizationGeneration: reflectionReference,
});
export type ReflectionBinding = z.infer<typeof reflectionBindingSchema>;
export const reflectionRangeSchema = z
  .strictObject({
    first: reflectionNumber.min(1),
    last: reflectionNumber.min(1),
  })
  .refine((range) => range.last >= range.first, { message: "invalid-range" });
export type ReflectionRange = z.infer<typeof reflectionRangeSchema>;
export const reflectionSourceSchema = z.strictObject({
  eventId: reflectionReference,
  sequence: reflectionNumber.min(1),
  digest: reflectionDigestSchema,
});
export type ReflectionSource = z.infer<typeof reflectionSourceSchema>;
export const reflectionArtifactSchema = z.strictObject({
  artifactId: reflectionReference,
  digest: reflectionDigestSchema,
});
export const reflectionCandidateInputSchema = z.strictObject({
  subject: z.string().min(1).max(256),
  content: z.string().min(1).max(REFLECTION_LIMITS.contentBytes),
  sources: z.array(reflectionReference).min(1).max(REFLECTION_LIMITS.provenance),
  artifacts: z.array(reflectionArtifactSchema).max(REFLECTION_LIMITS.provenance),
  method: z.enum(["deterministic", "model", "manual"]),
  proposedScope: z.enum(MEMORY_SCOPE_KINDS),
  kind: z.enum(MEMORY_KINDS),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(MEMORY_SENSITIVITIES),
  contradiction: z.enum(["none", "possible", "confirmed"]),
  supersedes: z.array(reflectionDigestSchema).max(16),
});
export const reflectionCandidateSchema = reflectionCandidateInputSchema.extend({
  id: reflectionDigestSchema,
  decision: z.literal("pending"),
  authority: z.literal("derived"),
});
export type ReflectionCandidate = z.infer<typeof reflectionCandidateSchema>;
export const reflectionPreparedSchema = z.strictObject({
  version: z.literal(1),
  authority: z.literal("derived"),
  parentCheckpoint: reflectionReference.nullable(),
  fidelity: z.enum(["exact-source-references", "lossy", "unknown"]),
  represented: z.array(reflectionReference).max(REFLECTION_LIMITS.sourceEvents),
  protectedSources: z.array(reflectionReference).max(REFLECTION_LIMITS.sourceEvents),
  omissions: z
    .array(
      z.strictObject({
        source: reflectionReference,
        reason: z.enum(["pending", "budget", "restricted", "expired", "unavailable"]),
      }),
    )
    .max(REFLECTION_LIMITS.sourceEvents),
  recovery: z.enum(["available", "partial", "unavailable"]),
  summary: z.string().max(REFLECTION_LIMITS.projectionBytes),
});
export const REFLECTION_STATES = [
  "due",
  "leased",
  "empty",
  "completed",
  "partial",
  "unavailable",
  "failed",
  "cancelled",
  "stale",
  "uncertain",
] as const;
export const reflectionLeaseSchema = z.strictObject({
  token: z.string().uuid(),
  epoch: reflectionNumber.min(1),
  expiresAt: reflectionNumber,
  process: z
    .strictObject({ pid: reflectionNumber.min(1), birth: reflectionReference.nullable() })
    .nullable(),
});
export const reflectionFenceSchema = reflectionLeaseSchema.pick({ token: true, epoch: true });
export type ReflectionFence = z.infer<typeof reflectionFenceSchema>;
export const reflectionPublicationSchema = z.strictObject({
  id: reflectionReference,
  digest: reflectionDigestSchema,
  generation: reflectionNumber.min(1),
  range: reflectionRangeSchema,
  disposition: z.enum(["processed", "empty", "unavailable"]),
  candidates: z.array(reflectionDigestSchema).max(REFLECTION_LIMITS.candidates),
  prepared: reflectionPreparedSchema.nullable(),
});
export const reflectionInvalidationSchema = z.strictObject({
  generation: reflectionNumber.min(1),
  reason: z.enum([
    "source",
    "policy",
    "authorization",
    "scope",
    "retention",
    "sensitivity",
    "transform",
  ]),
  at: reflectionNumber,
});
export const reflectionRecordSchema = z.strictObject({
  version: z.literal(1),
  id: reflectionDigestSchema,
  lineage: reflectionDigestSchema,
  binding: reflectionBindingSchema,
  transform: reflectionReference,
  range: reflectionRangeSchema,
  sourceDigest: reflectionDigestSchema,
  sources: z.array(reflectionSourceSchema).min(1).max(REFLECTION_LIMITS.sourceEvents),
  reason: z.enum(["turn-end", "recovery", "explicit", "checkpoint"]),
  createdAt: reflectionNumber,
  revision: reflectionNumber.min(1),
  state: z.enum(REFLECTION_STATES),
  epoch: reflectionNumber,
  lease: reflectionLeaseSchema.nullable(),
  candidates: z.array(reflectionCandidateSchema).max(REFLECTION_LIMITS.candidates),
  publications: z.array(reflectionPublicationSchema).max(REFLECTION_LIMITS.publications),
  invalidations: z.array(reflectionInvalidationSchema).max(REFLECTION_LIMITS.invalidations),
  uncertainty: z.enum(["none", "local-commit", "provider-outcome"]),
});
export type ReflectionRecord = z.infer<typeof reflectionRecordSchema>;
export const reflectionCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    binding: reflectionBindingSchema,
    transform: reflectionReference,
    range: reflectionRangeSchema,
    reason: reflectionRecordSchema.shape.reason,
  }),
  z.strictObject({
    action: z.literal("lease"),
    id: reflectionDigestSchema,
    durationMs: reflectionNumber.min(1).max(REFLECTION_LIMITS.leaseMs),
    process: reflectionLeaseSchema.shape.process,
  }),
  z.strictObject({
    action: z.literal("heartbeat"),
    id: reflectionDigestSchema,
    fence: reflectionFenceSchema,
    durationMs: reflectionNumber.min(1).max(REFLECTION_LIMITS.leaseMs),
  }),
  z.strictObject({
    action: z.literal("publish"),
    id: reflectionDigestSchema,
    fence: reflectionFenceSchema,
    publicationId: reflectionReference,
    range: reflectionRangeSchema,
    disposition: reflectionPublicationSchema.shape.disposition,
    candidates: z.array(reflectionCandidateInputSchema).max(REFLECTION_LIMITS.candidates),
    prepared: reflectionPreparedSchema.nullable(),
  }),
  z.strictObject({
    action: z.literal("settle"),
    id: reflectionDigestSchema,
    fence: reflectionFenceSchema,
    state: z.enum(["failed", "cancelled", "uncertain", "unavailable"]),
    uncertainty: reflectionRecordSchema.shape.uncertainty,
  }),
  z.strictObject({
    action: z.literal("invalidate"),
    id: reflectionDigestSchema,
    expectedRevision: reflectionNumber,
    reason: reflectionInvalidationSchema.shape.reason,
  }),
  z.strictObject({ action: z.literal("inspect"), id: reflectionDigestSchema }),
  z.strictObject({
    action: z.literal("export"),
    id: reflectionDigestSchema,
    expectedRevision: reflectionNumber,
  }),
  z.strictObject({
    action: z.literal("list"),
    after: reflectionDigestSchema.nullable(),
    limit: reflectionNumber.min(1).max(REFLECTION_LIMITS.page),
  }),
  z.strictObject({
    action: z.literal("reconcile"),
    after: reflectionDigestSchema.nullable(),
    limit: reflectionNumber.min(1).max(REFLECTION_LIMITS.page),
  }),
  z.strictObject({
    action: z.literal("coverage"),
    transform: reflectionReference,
    committedThrough: reflectionNumber.min(1),
  }),
]);
export type ReflectionCommand = z.infer<typeof reflectionCommandSchema>;
export type ReflectionErrorCode =
  | "malformed"
  | "denied"
  | "unavailable"
  | "source-unavailable"
  | "source-too-large"
  | "source-overlap"
  | "stale"
  | "stale-lease"
  | "conflict"
  | "resource-exhausted"
  | "corrupt"
  | "cancelled"
  | "uncertain";
export type ReflectionError = { readonly kind: "reflection"; readonly code: ReflectionErrorCode };
export class ReflectionRefusal extends Error {
  constructor(readonly code: ReflectionErrorCode) {
    super(code);
  }
}
export function refuseReflection(code: ReflectionErrorCode): never {
  throw new ReflectionRefusal(code);
}
export type ReflectionResult<T> = Result<T, ReflectionError>;
export type ReflectionTransaction = {
  get(id: string): ReflectionRecord | null;
  list(sessionId: string, after: string | null, limit: number): readonly ReflectionRecord[];
  save(record: ReflectionRecord, expectedRevision: number | null): void;
  source(binding: ReflectionBinding, range: ReflectionRange): readonly ReflectionSource[];
  artifact(id: string, digest: string): boolean;
  committedThrough(binding: ReflectionBinding): number;
};
export type ReflectionRepository = {
  transaction<T>(work: (tx: ReflectionTransaction) => T, signal?: AbortSignal): ReflectionResult<T>;
};
/** Only trusted composition supplies these live checks; command fields supply no authority. */
export type ReflectionAuthority = {
  current(): ReflectionBinding | null;
  sourceAllowed(source: ReflectionSource): boolean;
  artifactAllowed(artifact: z.infer<typeof reflectionArtifactSchema>): boolean;
  preparedAllowed(prepared: z.infer<typeof reflectionPreparedSchema>): boolean;
  candidateAllowed(candidate: z.infer<typeof reflectionCandidateInputSchema>): boolean;
};
