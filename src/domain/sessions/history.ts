/** Semantic content and causal evidence in the existing runtime event stream. */
import { z } from "zod";

export const HISTORY_VERSION = 1;
export const HISTORY_LIMITS = Object.freeze({
  contentBytes: 4 * 1024 * 1024,
  inlineBytes: 2048,
  page: 64,
  readBytes: 65536,
  relations: 32,
});
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@/-]+$/u);
const digest = z.string().regex(/^sha-256:[a-f0-9]{64}$/u);
export const historyEvidenceSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("inline"),
      text: z.string().max(HISTORY_LIMITS.inlineBytes),
      digest,
      byteLength: z.int().min(0).max(HISTORY_LIMITS.inlineBytes),
      sensitivity: z.literal("user-content"),
      fidelity: z.enum(["exact", "redacted"]),
    })
    .strict()
    .refine((v) => new TextEncoder().encode(v.text).byteLength === v.byteLength),
  z
    .object({
      availability: z.literal("retained"),
      artifactId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
      digest,
      byteLength: z.int().min(0).max(HISTORY_LIMITS.contentBytes),
      sensitivity: z.enum(["public", "user-content", "sensitive", "restricted"]),
      fidelity: z.enum(["exact", "redacted", "partial"]),
      mediaType: z.enum(["text/plain", "application/json"]),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      reason: z.enum([
        "not-recorded",
        "oversized",
        "redacted",
        "storage-failed",
        "cancelled",
        "interrupted",
        "missing",
        "expired",
        "corrupt",
      ]),
      fidelity: z.literal("unknown"),
      reference: z
        .object({
          artifactId: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
          digest,
          byteLength: z.int().nonnegative().max(HISTORY_LIMITS.contentBytes),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const historyReferenceSchema = z.discriminatedUnion("availability", [
  historyEvidenceSchema.options[1],
  historyEvidenceSchema.options[2],
]);
export type HistoryReference = z.infer<typeof historyReferenceSchema>;
export type HistoryEvidence = z.infer<typeof historyEvidenceSchema>;
const base = {
  version: z.literal(HISTORY_VERSION),
  id: identity,
  generation: z.int().nonnegative(),
  evidence: historyEvidenceSchema,
  references: z.array(historyReferenceSchema).max(HISTORY_LIMITS.relations).optional(),
};
const relation = z
  .object({
    type: z.enum([
      "source",
      "reply",
      "supersedes",
      "preimage",
      "successor",
      "projection",
      "verification",
      "task",
      "group",
    ]),
    id: identity,
    generation: z.int().nonnegative(),
  })
  .strict();
export const historyPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("gate"),
      invocationId: identity,
      proposalId: identity,
      stage: z.enum(["validation", "policy", "confirmation", "pre-hook", "post-hook", "schedule"]),
      decision: z.string().min(1).max(128),
      declaredEffect: z.enum(["observation", "mutation", "external", "interactive"]),
      cancelled: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("source"),
      sourceId: identity,
      relations: z.array(relation).max(HISTORY_LIMITS.relations),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("message"),
      messageId: identity,
      part: z.int().nonnegative(),
      role: z.enum(["user", "assistant"]),
      attemptId: identity.nullable(),
      completion: z.enum(["complete", "partial", "interrupted"]),
      relations: z.array(relation).max(HISTORY_LIMITS.relations),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("proposal"),
      stage: z.enum(["fragment", "assembled", "bound"]),
      inputDigest: digest,
      attemptId: identity,
      proposalId: identity,
      invocationId: identity.nullable(),
      name: identity,
      catalogGeneration: z.int().nonnegative(),
      policyGeneration: z.int().nonnegative(),
      disclosureDigest: digest,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("result"),
      proposalId: identity.nullable(),
      invocationId: identity.nullable(),
      capabilityId: identity.nullable(),
      status: z.enum([
        "completed",
        "failed",
        "cancelled",
        "timed-out",
        "uncertain",
        "denied",
        "unavailable",
        "malformed",
        "partial",
        "reused",
      ]),
      effect: z.enum(["none", "completed", "partial", "uncertain"]),
      reason: z.string().max(256),
      relations: z.array(relation).max(HISTORY_LIMITS.relations),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("checkpoint"),
      checkpointId: identity,
      parentCheckpointId: identity.nullable(),
      transform: identity,
      firstSequence: z.int().positive(),
      lastSequence: z.int().positive(),
      covered: z.array(identity).max(HISTORY_LIMITS.relations),
      omitted: z
        .array(z.object({ id: identity, reason: z.string().max(128) }).strict())
        .max(HISTORY_LIMITS.relations),
    })
    .strict()
    .refine((v) => v.lastSequence >= v.firstSequence),
  z
    .object({
      ...base,
      type: z.literal("restore-point"),
      restorePointId: identity,
      restorePointVersion: z.literal(1),
      attemptId: identity.nullable(),
      scope: z
        .object({
          kind: z.enum(["paths", "workspace"]),
          pathDigests: z.array(digest).max(HISTORY_LIMITS.relations),
        })
        .strict(),
      capture: z
        .object({
          fidelity: z.enum(["exact", "partial", "unavailable"]),
          pathCount: z.int().nonnegative(),
          artifactCount: z.int().nonnegative(),
          omissions: z
            .array(z.object({ reason: z.string().max(128), count: z.int().nonnegative() }).strict())
            .max(HISTORY_LIMITS.relations),
        })
        .strict(),
      operationId: identity,
      rootId: identity,
      stage: z.enum(["prepared", "running", "settled", "expired", "deleted"]),
      effect: z.enum(["none", "completed", "partial", "uncertain"]),
      relations: z.array(relation).max(HISTORY_LIMITS.relations),
    })
    .strict(),
]);
export type HistoryPayload = z.infer<typeof historyPayloadSchema>;
export type HistoryMetadata = HistoryPayload extends infer P
  ? P extends HistoryPayload
    ? Omit<P, "evidence">
    : never
  : never;
export function historyReferences(payload: HistoryPayload) {
  return [payload.evidence, ...(payload.references ?? [])].filter(
    (evidence): evidence is Extract<HistoryEvidence, { availability: "retained" }> =>
      evidence.availability === "retained",
  );
}
