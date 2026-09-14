/** Immutable, lossless historical output projection. Readers must reauthorize sources. */
import { z } from "zod";
import { MAX_STREAM_READ_LIMIT } from "../foundation/index.ts";
import { HISTORY_LIMITS, historyPayloadSchema } from "../sessions/history.ts";
import { parseWireEvent } from "../sessions/wire.ts";
import { MAX_HISTORY_ITEMS } from "./history-checkpoint.ts";

export const HISTORY_PROJECTION_VERSION = "history-projection.v1";
const digest = z.string().regex(/^sha-256:[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(256);
const tokens = z.int().nonnegative().max(HISTORY_LIMITS.contentBytes);

/** Whole next-request reservation, supplied by the host's current admitted route. */
export const checkpointAuthoritySchema = z
  .strictObject({
    model: identity,
    configurationGeneration: z.int().nonnegative(),
    policyGeneration: z.int().nonnegative(),
    instructionDigest: digest,
    /** Exact protected instructions and request framing captured by the host. */
    protectedRequest: z.string().max(HISTORY_LIMITS.contentBytes),
    contextGeneration: identity,
    contextWindowTokens: tokens.refine((n) => n > 0),
    systemAndSkillsTokens: tokens,
    freshToolsTokens: tokens,
    freshResultsTokens: tokens,
    modalityTokens: tokens,
    reservedOutputTokens: tokens,
    reservedContinuationTokens: tokens,
  })
  .refine(
    (value) =>
      value.systemAndSkillsTokens >=
      Math.ceil(new TextEncoder().encode(value.protectedRequest).byteLength / 4),
    "Protected request text must be fully charged",
  );
export type CheckpointAuthority = z.infer<typeof checkpointAuthoritySchema>;
export const historyProjectionSchema = z
  .strictObject({
    version: z.literal(HISTORY_PROJECTION_VERSION),
    sessionId: identity,
    streamId: identity,
    sourceHead: z.int().positive(),
    sourceDigest: digest,
    authority: checkpointAuthoritySchema,
    parentCheckpointId: identity.nullable(),
    /** Terminal uncertainty and pending effects remain explicit even without a semantic result. */
    lifecycle: z
      .array(
        z.unknown().transform((input, context) => {
          const parsed = parseWireEvent(input);
          if (!parsed.ok || parsed.event.kind === "history.recorded") {
            context.addIssue({ code: "custom", message: "Invalid checkpoint lifecycle fact" });
            return z.NEVER;
          }
          return parsed.event;
        }),
      )
      .max(MAX_STREAM_READ_LIMIT),
    /** All semantic records are protected. We never infer that a result was consumed. */
    records: z
      .array(
        z.strictObject({
          eventId: identity,
          sequence: z.int().positive(),
          payload: historyPayloadSchema,
          content: z
            .int()
            .nonnegative()
            .max(MAX_HISTORY_ITEMS - 1),
        }),
      )
      .min(1)
      .max(MAX_HISTORY_ITEMS),
    /** Exact text is interned once; repeated output records retain independent lineage. */
    contents: z.array(z.string().max(HISTORY_LIMITS.contentBytes)).max(MAX_HISTORY_ITEMS),
    omitted: z.array(z.never()).max(0),
    fidelity: z.enum(["exact", "redacted", "partial"]),
    recovery: z.literal("original-events-under-existing-retention"),
    memory: z.literal("deterministic-no-memory-authority"),
  })
  .superRefine((value, context) => {
    if (
      value.records.some((record) => record.content >= value.contents.length) ||
      new Set(value.records.map((record) => record.eventId)).size !== value.records.length ||
      value.records.some(
        (record) => record.payload.type === "checkpoint" || record.payload.type === "restore-point",
      )
    )
      context.addIssue({ code: "custom", message: "Invalid source projection" });
  });
export type HistoryProjection = z.infer<typeof historyProjectionSchema>;

export function checkpointBudget(authority: CheckpointAuthority, projectionBytes: number) {
  // Same four-character approximation as prompt composition, counted in UTF-8 bytes
  // so non-ASCII content is not charged as one cheap JavaScript code unit.
  // This is an estimate, never provider acceptance; #952 re-admits its actual request.
  const historyTokens = Math.ceil(projectionBytes / 4);
  const total =
    historyTokens +
    authority.systemAndSkillsTokens +
    authority.freshToolsTokens +
    authority.freshResultsTokens +
    authority.modalityTokens +
    authority.reservedOutputTokens +
    authority.reservedContinuationTokens;
  return {
    kind: "utf8-bytes-divided-by-four" as const,
    historyTokens,
    wholeRequestTokens: total,
    limit: authority.contextWindowTokens,
    fits: total <= authority.contextWindowTokens,
  };
}
